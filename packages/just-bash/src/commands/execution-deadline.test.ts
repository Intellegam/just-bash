import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";

// Real time never reaches this deadline during a test; the mocked clocks
// below are the only way past it, so results do not depend on machine speed.
const DEADLINE_MS = 60_000;

const stopped = (command: string, deadlineMs = DEADLINE_MS) => ({
  stdout: "",
  stderr: `bash: ${command} exceeded execution deadline (${deadlineMs}ms)\n`,
  exitCode: 124,
});

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");

class ClockJumpFs extends InMemoryFs {
  private readonly trigger: string;
  private readonly jump: () => void;

  constructor(
    files: Record<string, string>,
    trigger: string,
    jump: () => void,
  ) {
    super(files);
    this.trigger = trigger;
    this.jump = jump;
  }

  override async readFileBuffer(path: string): Promise<Uint8Array> {
    const buffer = await super.readFileBuffer(path);
    if (path === this.trigger) this.jump();
    return buffer;
  }
}

function createRun(fs: InMemoryFs, deadlineMs: number) {
  const bash = new Bash({
    fs,
    executionLimits: { maxExecutionTimeMs: deadlineMs },
  });
  return async (script: string, stdin?: string) => {
    const { stdout, stderr, exitCode } = await bash.exec(script, { stdin });
    return { stdout, stderr, exitCode };
  };
}

/** The clock passes the deadline once the command has read `trigger`. */
function jumpAfterReading(trigger: string, files: Record<string, string>) {
  const realNow = Date.now;
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const fs = new ClockJumpFs(files, trigger, () => {
    offset = 2 * DEADLINE_MS;
  });
  return { fs, run: createRun(fs, DEADLINE_MS) };
}

/** The clock advances 1 ms each time it is read. */
function tickPerRead(files: Record<string, string>, deadlineMs: number) {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  return createRun(new InMemoryFs(files), deadlineMs);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("execution deadline inside one command", () => {
  it.each([
    ["each input record", "{ n++ } END { print n }", "/in.txt"],
    [
      "each getline inside one action",
      'NR == 1 { getline t < "/tick"; while ((getline line) > 0) n++ } END { print n }',
      "/tick",
    ],
    [
      "each for iteration",
      'BEGIN { getline t < "/tick"; for (i = 0; i < 1000; i++) n++; print n }',
      "/tick",
    ],
    [
      "each do-while iteration",
      'BEGIN { getline t < "/tick"; do { n++ } while (n < 1000); print n }',
      "/tick",
    ],
    [
      "each for-in iteration",
      'BEGIN { for (i = 0; i < 1000; i++) a[i] = 1; getline t < "/tick"; for (k in a) n++; print n }',
      "/tick",
    ],
    [
      "each getline outside any loop",
      'BEGIN { getline t < "/tick"; getline a < "/in.txt"; print a > "/late" }',
      "/tick",
    ],
    [
      "each user function call",
      'function f(d) { if (d > 0) { f(d - 1); f(d - 1) } } BEGIN { getline t < "/tick"; f(10); print "done" }',
      "/tick",
    ],
  ])("awk stops at %s", async (_site, program, trigger) => {
    const { run } = jumpAfterReading(trigger, {
      "/in.txt": lines(200),
      "/tick": "",
    });

    expect(await run(`awk '${program}' /in.txt`)).toEqual(stopped("awk"));
  });

  it("awk writes its pending file output when the deadline stops it", async () => {
    const { fs, run } = jumpAfterReading("/tick", { "/tick": "" });

    expect(
      await run(
        `awk 'BEGIN { getline t < "/tick"; print "kept" >> "/out"; for (i = 0; i < 1000; i++) n++ }'`,
      ),
    ).toEqual(stopped("awk"));
    expect(await fs.readFile("/out")).toBe("kept\n");
  });

  it("sed stops at each input line of a script without commands", async () => {
    const { run } = jumpAfterReading("/in.txt", { "/in.txt": lines(200) });

    expect(await run("sed '' /in.txt")).toEqual(stopped("sed"));
  });

  it("sed stops at each command of a branch loop on one line", async () => {
    // r reads /tick after the first cycle; the second line then runs
    // :a;s;ta 300 times within one cycle.
    const { run } = jumpAfterReading("/tick", { "/tick": "" });

    expect(
      await run(
        "sed -e '1r /tick' -e ':a;s/a/c/;ta'",
        `x\n${"a".repeat(300)}\n`,
      ),
    ).toEqual(stopped("sed"));
  });

  it("sed -i stops and leaves the file unchanged", async () => {
    const { fs, run } = jumpAfterReading("/in.txt", { "/in.txt": lines(200) });

    expect(await run("sed -i 's/line/row/' /in.txt")).toEqual(stopped("sed"));
    expect(await fs.readFile("/in.txt")).toBe(lines(200));
  });

  it("grep stops in the matching loop", async () => {
    const { run } = jumpAfterReading("/patterns", { "/patterns": "line\n" });

    expect(await run("grep -c -f /patterns", lines(200))).toEqual(
      stopped("grep"),
    );
  });

  it("grep stops between the needles of the whole-file literal prefilter", async () => {
    // Each needle scans the whole file, so each reads the clock. grep reads
    // it about 16 times outside its loops, so 100 absent needles pass a 40 ms
    // deadline only inside this loop.
    const needles = Array.from({ length: 100 }, (_, i) => `zq${i}`);
    const run = tickPerRead({ "/in.txt": lines(200) }, 40);

    expect(await run(`grep -c -E '${needles.join("|")}' /in.txt`)).toEqual(
      stopped("grep", 40),
    );
  });

  it("grep stops before the whole-file literal prefilter", async () => {
    const { run } = jumpAfterReading("/in.txt", { "/in.txt": lines(200) });

    expect(await run("grep -c absent /in.txt")).toEqual(stopped("grep"));
  });

  // rg charges its input budget, which checks the deadline, right after each
  // read, so a clock jump on a read stops it before the search starts. With a
  // clock that ticks per read, 500 ticks pass only inside a loop that checks
  // the deadline: rg reads the clock about 20 times outside its loops. rg
  // matches through grep's search engine, which reports as grep.
  it.each([
    ["a file", "rg -c line /in.txt", undefined],
    ["stdin", "rg -c line", lines(90_000)],
    ["a file in multiline mode", "rg -U -c line /in.txt", undefined],
  ])("rg stops in the matching loop of %s", async (_input, script, stdin) => {
    const run = tickPerRead({ "/in.txt": lines(90_000) }, 500);

    expect(await run(script, stdin)).toEqual(stopped("grep", 500));
  });

  it("rg stops in the JSON output loop", async () => {
    // Searching 60,000 lines reads the clock about 970 times and the JSON
    // pass about 940 more, so a 1,400 ms deadline falls in the JSON pass.
    const run = tickPerRead({ "/in.txt": lines(60_000) }, 1400);

    expect(await run("rg --json line /in.txt")).toEqual(stopped("rg", 1400));
  });
});
