import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binPath = resolve(__dirname, "../../dist/bin/just-bash.js");

async function runBin(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [binPath, ...args]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

describe("just-bash bundled binary", () => {
  it("should show version", async () => {
    const result = await runBin(["--version"]);
    expect(result.stdout).toContain("just-bash");
    expect(result.exitCode).toBe(0);
  });

  it("should show help", async () => {
    const result = await runBin(["--help"]);
    expect(result.stdout).toContain("Usage:");
    expect(result.exitCode).toBe(0);
  });

  it("should execute echo command", async () => {
    const result = await runBin(["-c", "echo hello world"]);
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should execute pipes", async () => {
    const result = await runBin(["-c", 'echo "line1\nline2\nline3" | wc -l']);
    expect(result.stdout.trim()).toBe("3");
    expect(result.exitCode).toBe(0);
  });

  it("should handle file operations with --allow-write", async () => {
    const result = await runBin([
      "-c",
      'echo "test" > /tmp/test.txt && cat /tmp/test.txt',
      "--allow-write",
    ]);
    expect(result.stdout).toBe("test\n");
    expect(result.exitCode).toBe(0);
  });

  it("should support JSON output", async () => {
    const result = await runBin(["-c", "echo hello", "--json"]);
    const json = JSON.parse(result.stdout);
    expect(json.stdout).toBe("hello\n");
    expect(json.stderr).toBe("");
    expect(json.exitCode).toBe(0);
  });

  it("should lazy-load commands (grep)", async () => {
    const result = await runBin([
      "-c",
      'echo -e "foo\\nbar\\nbaz" | grep ba',
      "--allow-write",
    ]);
    expect(result.stdout).toContain("bar");
    expect(result.stdout).toContain("baz");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (sed)", async () => {
    const result = await runBin(["-c", "echo hello | sed 's/hello/world/'"]);
    expect(result.stdout).toBe("world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (awk)", async () => {
    const result = await runBin(["-c", "echo 'a b c' | awk '{print $2}'"]);
    expect(result.stdout).toBe("b\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle errexit mode", async () => {
    const result = await runBin(["-e", "-c", "false; echo should not print"]);
    expect(result.stdout).not.toContain("should not print");
    expect(result.exitCode).toBe(1);
  });

  // Regression test for https://github.com/vercel-labs/just-bash/issues/211:
  // file-type → debug → supports-color does runtime require("tty")/require("os"),
  // which the esbuild dynamic-require shim throws for under ESM Node unless the
  // build banner provides createRequire.
  it("should run file (regression: dynamic require under ESM Node)", async () => {
    const result = await runBin([
      "-c",
      "echo content > /tmp/x.txt && file /tmp/x.txt",
      "--allow-write",
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("/tmp/x.txt: ASCII text\n");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (sqlite3 with external sql.js)", async () => {
    const result = await runBin([
      "-c",
      'sqlite3 :memory: "SELECT 1 + 2 AS result"',
    ]);
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (python3 with CPython Emscripten)", async () => {
    const result = await runBin([
      "--python",
      "-c",
      'python3 -c "print(1 + 2)"',
    ]);
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 60000); // 60s timeout for first WASM load

  it("should lazy-load commands (js-exec with run)", async () => {
    const result = await runBin([
      "--javascript",
      "-c",
      `js-exec -c "console.log(1 + 2)"`,
    ]);
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(0);
  }, 30000);
});

describe("just-bash CJS bundle", () => {
  it("should be requireable and execute basic commands", async () => {
    const cjsBundlePath = resolve(__dirname, "../../dist/bundle/index.cjs");
    const require = createRequire(import.meta.url);
    const mod = require(cjsBundlePath);
    expect(mod.Bash).toBeDefined();
    const bash = new mod.Bash();
    const result = await bash.exec("echo hello from cjs");
    expect(result.stdout).toBe("hello from cjs\n");
    expect(result.exitCode).toBe(0);
  });

  it("should run sqlite3 and stop a runaway query at the shell deadline", async () => {
    const cjsBundlePath = resolve(__dirname, "../../dist/bundle/index.cjs");
    const require = createRequire(import.meta.url);
    const mod = require(cjsBundlePath);
    const bash = new mod.Bash({
      executionLimits: {
        maxExecutionTimeMs: 2_000,
        maxSqliteTimeoutMs: 30_000,
      },
    });

    const query = await bash.exec('sqlite3 :memory: "SELECT 1 + 2"');
    const started = Date.now();
    const runaway = await bash.exec(
      'sqlite3 :memory: "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT sum(x) FROM t"',
    );

    expect(query).toMatchObject({ stdout: "3\n", stderr: "", exitCode: 0 });
    expect(runaway.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

// Regression test for https://github.com/vercel-labs/just-bash/issues/211.
// The ESM Node bundle (what consumers import via `import { Bash } from "just-bash"`)
// has its own dynamic-require shim — file-type → debug → supports-color does
// runtime require("tty")/require("os") that the shim throws for unless the
// build banner provides createRequire.
describe("just-bash ESM bundle", () => {
  it("should be importable and run file command", async () => {
    const esmBundlePath = resolve(__dirname, "../../dist/bundle/index.js");
    const mod = await import(esmBundlePath);
    expect(mod.Bash).toBeDefined();
    const fs = new mod.InMemoryFs();
    await fs.writeFile("/x.txt", "hello\n");
    const bash = new mod.Bash({ fs, cwd: "/" });
    const result = await bash.exec("file /x.txt");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("/x.txt: ASCII text\n");
    expect(result.exitCode).toBe(0);
  });
});

let bunAvailable = false;
try {
  execFileSync("bun", ["--version"], { stdio: "ignore" });
  bunAvailable = true;
} catch {
  bunAvailable = false;
}

// Bun cannot reliably terminate a worker busy inside WebAssembly, which the
// Node processes above cannot show; the subprocess must also exit by itself,
// so no worker thread outlives Bash.exec().
describe.skipIf(!bunAvailable)("sqlite3 cancellation under Bun", () => {
  for (const entry of ["index.js", "index.cjs"]) {
    it(`stops a runaway query through ${entry}`, () => {
      const bundle = resolve(__dirname, "../../dist/bundle", entry);
      const script = `
        const mod = ${entry.endsWith(".cjs") ? "require" : "await import"}(${JSON.stringify(bundle)});
        const bash = new mod.Bash({
          executionLimits: { maxExecutionTimeMs: 700, maxSqliteTimeoutMs: 30000 },
        });
        const started = performance.now();
        const runaway = await bash.exec(
          'sqlite3 :memory: "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT sum(x) FROM t"',
        );
        const elapsedMs = performance.now() - started;
        const follow = await bash.exec('sqlite3 :memory: "SELECT 42"');
        console.log(JSON.stringify({
          runaway: { exitCode: runaway.exitCode, stderr: runaway.stderr },
          elapsedMs,
          follow: follow.stdout,
        }));
      `;
      const output = execFileSync("bun", ["-e", script], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const result = JSON.parse(output.trim().split("\n").at(-1) ?? "");

      expect(result.runaway.exitCode).toBe(124);
      expect(result.runaway.stderr).not.toContain("did not exit");
      expect(result.elapsedMs).toBeLessThan(4_000);
      expect(result.follow).toBe("42\n");
    }, 30_000);
  }
});
