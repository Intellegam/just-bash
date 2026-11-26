import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import * as encoding from "../../encoding.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const MTIME = new Date(2020, 0, 1, 12, 0);

// "é" is two UTF-8 bytes but one UTF-16 unit, so a limit counted in string
// length rather than bytes lets these listings through one byte too late.
function multibyteBash(maxOutputSize: number): Bash {
  return new Bash({
    files: {
      "/d/é1": { content: "", mtime: MTIME },
      "/d/é2": { content: "", mtime: MTIME },
      "/e/sub/é3": { content: "", mtime: MTIME },
    },
    cwd: "/",
    executionLimits: { maxOutputSize },
  });
}

const LISTINGS: [string, string][] = [
  ["ls /d", "é1\né2\n"],
  [
    "ls -l /d",
    "total 2\n" +
      "-rw-r--r-- 1 user user     0 Jan  1  2020 é1\n" +
      "-rw-r--r-- 1 user user     0 Jan  1  2020 é2\n",
  ],
  ["ls -d /d/é1 /d/é2", "/d/é1\n/d/é2\n"],
  ["ls /d/é1 /d/é2", "/d/é1\n/d/é2\n"],
  ["ls /d /e", "/d:\né1\né2\n\n/e:\nsub\n"],
  ["ls -R /e", "/e:\nsub\n\n/e/sub:\né3\n"],
];

const MISSING = "ls /é /ü";
const MISSING_STDERR =
  "ls: /é: No such file or directory\nls: /ü: No such file or directory\n";

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("ls output size limit", () => {
  it.each(
    LISTINGS,
  )("allows exactly the UTF-8 size of `%s`", async (command, expected) => {
    const result = await multibyteBash(utf8Size(expected)).exec(command);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it.each(
    LISTINGS,
  )("rejects `%s` one byte under its UTF-8 size", async (command, expected) => {
    const limit = utf8Size(expected) - 1;
    const result = await multibyteBash(limit).exec(command);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `bash: ls: output size limit exceeded (${limit} bytes)\n`,
    );
    expect(result.exitCode).toBe(126);
  });

  it.each(
    LISTINGS,
  )("lists `%s` when the output size is unlimited", async (command, expected) => {
    const result = await multibyteBash(Number.POSITIVE_INFINITY).exec(command);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("allows exactly the UTF-8 size of the missing-operand errors", async () => {
    const result = await multibyteBash(utf8Size(MISSING_STDERR)).exec(MISSING);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(MISSING_STDERR);
    expect(result.exitCode).toBe(2);
  });

  it("rejects the missing-operand errors one byte under their UTF-8 size", async () => {
    const limit = utf8Size(MISSING_STDERR) - 1;
    const result = await multibyteBash(limit).exec(MISSING);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `bash: ls: output size limit exceeded (${limit} bytes)\n`,
    );
    expect(result.exitCode).toBe(126);
  });
});

function name(index: number): string {
  return String(index).padStart(5, "0");
}

function listingOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => name(i));
}

const ACCOUNTED = {
  "ls -l /d": {
    files: (i: number) => `/d/f${name(i)}`,
    stdout: (count: number) =>
      `total ${count}\n${listingOf(count)
        .map((n) => `-rw-r--r-- 1 user user     0 Jan  1  2020 f${n}\n`)
        .join("")}`,
  },
  "ls -d /d/*": {
    files: (i: number) => `/d/f${name(i)}`,
    stdout: (count: number) =>
      listingOf(count)
        .map((n) => `/d/f${n}\n`)
        .join(""),
  },
  "ls /d/*": {
    files: (i: number) => `/d/f${name(i)}`,
    stdout: (count: number) =>
      listingOf(count)
        .map((n) => `/d/f${n}\n`)
        .join(""),
  },
  "ls -R /d": {
    files: (i: number) => `/d/s${name(i)}/f`,
    stdout: (count: number) =>
      `/d:\n${listingOf(count)
        .map((n) => `s${n}\n`)
        .join("")}${listingOf(count)
        .map((n) => `\n/d/s${n}:\nf\n`)
        .join("")}`,
  },
};

/** UTF-16 code units passed to `utf8ByteLength` while `command` lists `count` entries. */
async function codeUnitsMeasured(
  command: keyof typeof ACCOUNTED,
  count: number,
): Promise<number> {
  const { files: path, stdout } = ACCOUNTED[command];
  const files: Record<string, { content: string; mtime: Date }> =
    Object.create(null);
  for (let i = 0; i < count; i++)
    files[path(i)] = { content: "", mtime: MTIME };
  const bash = new Bash({ files, cwd: "/" });
  const spy = vi.spyOn(encoding, "utf8ByteLength");
  const result = await bash.exec(command);
  const measured = spy.mock.calls.reduce(
    (total, [value]) => total + value.length,
    0,
  );
  spy.mockRestore();
  expect(result.stdout).toBe(stdout(count));
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return measured;
}

describe("ls output size accounting", () => {
  it.each([
    ["ls -l /d", 1000],
    ["ls -d /d/*", 1000],
    ["ls /d/*", 1000],
    ["ls -R /d", 250],
  ] as const)("keeps the UTF-16 code units passed to utf8ByteLength linear for `%s`", async (command, count) => {
    const single = await codeUnitsMeasured(command, count);
    const double = await codeUnitsMeasured(command, count * 2);
    // Doubling the entries doubles the output. Measuring each appended chunk
    // doubles the work too; re-measuring everything appended so far on every
    // append quadruples it.
    expect(double).toBeLessThan(3 * single);
  });
});
