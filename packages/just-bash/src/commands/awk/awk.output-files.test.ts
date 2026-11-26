import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import type {
  BufferEncoding,
  FileContent,
  ReadFileOptions,
  WriteFileOptions,
} from "../../fs/interface.js";
import { MountableFs } from "../../fs/mountable-fs/index.js";
import { _setTimeout } from "../../timers.js";

/** Counts reads and appends per path; can fail reads or appends. */
class RecordingFs extends InMemoryFs {
  readonly reads = new Map<string, number>();
  readonly appends = new Map<string, number>();
  failReadsOf?: string;
  appendError?: Error;

  override async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    if (path === this.failReadsOf) throw new Error(`EIO: read '${path}'`);
    return super.readFile(path, options);
  }

  override async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.appends.set(path, (this.appends.get(path) ?? 0) + 1);
    if (this.appendError) throw this.appendError;
    return super.appendFile(path, content, options);
  }
}

function setup(files: Record<string, string> = {}) {
  const fs = new RecordingFs(files);
  const bash = new Bash({ fs, cwd: "/" });
  const run = async (script: string) => {
    const { stdout, stderr, exitCode } = await bash.exec(script);
    return { stdout, stderr, exitCode };
  };
  return { fs, run };
}

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

describe("awk output files", () => {
  it("appends pending output once instead of re-reading the file per print", async () => {
    const { fs, run } = setup({ "/log.txt": "old\n" });

    expect(
      await run(
        `printf '1\\n2\\n3\\n' | awk '{ print > "/out.txt"; print >> "/log.txt" }'`,
      ),
    ).toEqual(ok());
    expect([...fs.reads]).toEqual([]);
    expect([...fs.appends]).toEqual([
      ["/log.txt", 1],
      ["/out.txt", 1],
    ]);
    expect(await fs.readFile("/out.txt")).toBe("1\n2\n3\n");
    expect(await fs.readFile("/log.txt")).toBe("old\n1\n2\n3\n");
  });

  it("keeps print >> f; close(f) per record to one append", async () => {
    const { fs, run } = setup();

    expect(
      await run(
        `seq 1 100 | awk '{ print >> "/rows.txt"; close("/rows.txt") }'`,
      ),
    ).toEqual(ok());
    expect([...fs.reads]).toEqual([]);
    expect([...fs.appends]).toEqual([["/rows.txt", 1]]);
    expect(await fs.readFile("/rows.txt")).toBe(
      Array.from({ length: 100 }, (_, i) => `${i + 1}\n`).join(""),
    );
  });

  it("truncates again on the first > after close()", async () => {
    const { fs, run } = setup();

    expect(
      await run(
        `awk 'BEGIN { print 1 >> "/r"; close("/r"); print 2 > "/r"; print 3 >> "/r"; print "a" > "/t"; close("/t"); print "b" > "/t" }'`,
      ),
    ).toEqual(ok());
    expect(await fs.readFile("/r")).toBe("2\n3\n");
    expect(await fs.readFile("/t")).toBe("b\n");
  });

  it.each([
    [
      "getline < file",
      `awk 'BEGIN { print "a" > "/f"; print "b" > "/f"; while ((getline l < "/f") > 0) print "read " l }'`,
      "read a\nread b\n",
    ],
    [
      "cmd | getline",
      `awk 'BEGIN { print "a" >> "/f"; print "b" >> "/f"; while (("cat /f" | getline l) > 0) print "cmd " l }'`,
      "cmd a\ncmd b\n",
    ],
    [
      "each input file",
      `awk 'BEGIN { print "a" > "/f"; print "b" > "/f" } { print "in " $0 }' /f`,
      "in a\nin b\n",
    ],
  ])("writes pending output before %s reads it", async (_reader, script, stdout) => {
    const { run } = setup();

    expect(await run(script)).toEqual(ok(stdout));
  });

  it("writes pending output when awk fails", async () => {
    const { fs, run } = setup();

    expect(
      await run(
        `awk 'BEGIN { print "e1" > "/e"; print "e2" > "/e"; system("ls") }'`,
      ),
    ).toEqual({
      stdout: "",
      stderr:
        "awk: system() is not supported - shell execution not allowed in sandboxed environment\n",
      exitCode: 2,
    });
    expect(await fs.readFile("/e")).toBe("e1\ne2\n");
  });

  it("writes every pending file when one write fails, then exits 2", async () => {
    const { fs, run } = setup();
    await fs.mkdir("/d");

    expect(
      await run(
        `awk 'BEGIN { print "x" >> "/d"; print "a" > "/ok"; print "b" > "/ok"; print "done" }'`,
      ),
    ).toEqual({
      stdout: "done\n",
      stderr: "awk: EISDIR: illegal operation on a directory, write '/d'\n",
      exitCode: 2,
    });
    expect(await fs.readFile("/ok")).toBe("a\nb\n");
  });

  it("appends without reading the file, so a failed read cannot replace it", async () => {
    const { fs, run } = setup({ "/out.txt": "keep\n" });
    fs.failReadsOf = "/out.txt";

    expect(await run(`awk 'BEGIN { print "new" >> "/out.txt" }'`)).toEqual(
      ok(),
    );
    fs.failReadsOf = undefined;
    expect(await fs.readFile("/out.txt")).toBe("keep\nnew\n");
  });

  it("writes after 65,536 pending prints", async () => {
    const { fs, run } = setup();

    expect(
      await run(`awk 'BEGIN { for (i = 0; i < 65537; i++) print i >> "/n" }'`),
    ).toEqual(ok());
    expect([...fs.appends]).toEqual([["/n", 2]]);
    expect(await fs.readFile("/n")).toBe(
      Array.from({ length: 65537 }, (_, i) => `${i}\n`).join(""),
    );
  });

  it("writes after 8 MiB of pending characters, counting file names", async () => {
    // Each new file adds its 8,198-character path and "1\n": the 1,024th
    // reaches 8,396,800 >= 8,388,608 characters and its flush fails.
    const { fs, run } = setup();
    fs.appendError = new Error("ENOSPC: no space left on device");

    expect(
      await run(
        `awk 'BEGIN { n = "n"; for (k = 0; k < 13; k++) n = n n; for (i = 10000; i < 11100; i++) { print 1 >> ("/" n i); print i } }'`,
      ),
    ).toEqual({
      stdout: Array.from({ length: 1023 }, (_, i) => `${10000 + i}\n`).join(""),
      stderr: "awk: ENOSPC: no space left on device\n",
      exitCode: 2,
    });
  });

  it("does not count text a first > discarded toward the next barrier", async () => {
    // /a reaches 65,535 prints and 6,553,502 characters. Counted on, the
    // 2,097,153-character print to /b would cross both thresholds and
    // flush /b before its second print.
    const { fs, run } = setup();

    expect(
      await run(
        `awk 'BEGIN { for (i = 0; i < 65535; i++) printf "%099d\\n", i >> "/a"; close("/a"); print "x" > "/a"; s = "y"; for (k = 0; k < 21; k++) s = s s; print s >> "/b"; print 2 >> "/b" }'`,
      ),
    ).toEqual(ok());
    expect(fs.appends.get("/b")).toBe(1);
    expect(await fs.readFile("/a")).toBe("x\n");
  });

  it("keeps appends through two paths to one file", async () => {
    // Reads the file, then writes it back on a later macrotask, so two
    // appends in flight at once would keep only the later one.
    class ReadModifyWriteFs extends InMemoryFs {
      override async appendFile(path: string, content: FileContent) {
        const existing = (await this.exists(path))
          ? await this.readFile(path)
          : "";
        await new Promise((resolve) => _setTimeout(resolve, 0));
        await this.writeFile(path, existing + String(content));
      }
    }
    const shared = new ReadModifyWriteFs();
    const fs = new MountableFs({
      mounts: [
        { mountPoint: "/m1", filesystem: shared },
        { mountPoint: "/m2", filesystem: shared },
      ],
    });
    const bash = new Bash({ fs });

    expect(
      await bash.exec(
        `awk 'BEGIN { print "a" >> "/m1/f"; print "b" >> "/m2/f" }'`,
      ),
    ).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await shared.readFile("/f")).toBe("a\nb\n");
  });

  it("starts every pending write before a cancelled shell revokes the filesystem", async () => {
    // Each append completes on a later macrotask, after the overdue shell
    // deadline has revoked awk's filesystem.
    class SlowAppendFs extends InMemoryFs {
      override async appendFile(
        ...args: Parameters<InMemoryFs["appendFile"]>
      ): Promise<void> {
        await new Promise((resolve) => _setTimeout(resolve, 0));
        await super.appendFile(...args);
      }
    }
    const fs = new SlowAppendFs();
    // Far more iterations than fit in the deadline, but finite, so the loop
    // also ends where nothing checks the deadline inside it.
    const bash = new Bash({
      fs,
      executionLimits: { maxExecutionTimeMs: 200, maxAwkIterations: 2_000_000 },
    });

    const result = await bash.exec(
      `awk 'BEGIN { print "a" >> "/f1"; print "b" >> "/f2"; print "c" >> "/f3"; while (1) n++ }'`,
    );

    expect(result.exitCode).toBe(124);
    expect([
      await fs.readFile("/f1"),
      await fs.readFile("/f2"),
      await fs.readFile("/f3"),
    ]).toEqual(["a\n", "b\n", "c\n"]);
  });
});
