import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { _internals } from "./sqlite3.js";

// The test double's delay runs inside the command's defense-in-depth context,
// which blocks global timer and clock lookups; bind them before it activates.
const hostSetTimeout = globalThis.setTimeout;
const hostNow = performance.now.bind(performance);

const RUNAWAY_SQL =
  "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT sum(x) FROM t";

interface ObservedWorker {
  exitedAt?: number;
  messages: unknown[];
}

function observeWorkers(terminateDelayMs = 0): ObservedWorker[] {
  const observed: ObservedWorker[] = [];
  const createWorker = _internals.createWorker;
  vi.spyOn(_internals, "createWorker").mockImplementation((path, input) => {
    const worker: Worker = createWorker(path, input);
    const record: ObservedWorker = { messages: [] };
    observed.push(record);
    worker.once("exit", () => {
      record.exitedAt = hostNow();
    });
    worker.on("message", (message: unknown) => record.messages.push(message));
    if (terminateDelayMs > 0) {
      const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => {
        await new Promise((resolve) =>
          hostSetTimeout(resolve, terminateDelayMs),
        );
        return terminate();
      };
    }
    return worker;
  });
  return observed;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sqlite3 worker settlement", () => {
  it("stops a runaway query at the shell deadline when the caller passed no signal", async () => {
    const observed = observeWorkers();
    const bash = new Bash({
      executionLimits: { maxExecutionTimeMs: 400, maxSqliteTimeoutMs: 30_000 },
    });
    const started = hostNow();

    const result = await bash.exec(`sqlite3 :memory: "${RUNAWAY_SQL}"`);
    const returnedAt = hostNow();

    expect(result.exitCode).toBe(124);
    expect(returnedAt - started).toBeLessThan(5_000);
    expect(observed).toHaveLength(1);
    expect(observed[0].exitedAt).toBeDefined();
    expect(observed[0].exitedAt).toBeLessThanOrEqual(returnedAt);
  }, 40_000);

  it("returns from an aborted exec only after a slow worker termination", async () => {
    const observed = observeWorkers(300);
    const bash = new Bash({
      executionLimits: {
        maxExtensionCleanupTimeMs: 20,
        maxSqliteTimeoutMs: 30_000,
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    await bash
      .exec(`sqlite3 :memory: "${RUNAWAY_SQL}"`, { signal: controller.signal })
      .catch(() => undefined);
    const returnedAt = hostNow();

    expect(observed).toHaveLength(1);
    expect(observed[0].exitedAt).toBeDefined();
    expect(observed[0].exitedAt).toBeLessThanOrEqual(returnedAt);
  }, 40_000);

  it("waits for a nested shell's worker to exit at the outer deadline", async () => {
    const observed = observeWorkers(300);
    const bash = new Bash({
      executionLimits: {
        maxExecutionTimeMs: 400,
        maxExtensionCleanupTimeMs: 20,
        maxSqliteTimeoutMs: 30_000,
      },
    });

    const result = await bash.exec(
      `bash -c 'sqlite3 :memory: "${RUNAWAY_SQL}"'`,
    );
    const returnedAt = hostNow();

    expect(result.exitCode).toBe(124);
    expect(observed).toHaveLength(1);
    expect(observed[0].exitedAt).toBeDefined();
    expect(observed[0].exitedAt).toBeLessThanOrEqual(returnedAt);
  }, 40_000);

  it("stops waiting for a worker whose termination fails", async () => {
    const realTerminations: Array<() => Promise<number>> = [];
    const createWorker = _internals.createWorker;
    vi.spyOn(_internals, "createWorker").mockImplementation((path, input) => {
      const worker: Worker = createWorker(path, input);
      realTerminations.push(worker.terminate.bind(worker));
      worker.terminate = async () => {
        throw new Error("termination refused");
      };
      return worker;
    });
    const bash = new Bash({
      executionLimits: { maxExecutionTimeMs: 400, maxSqliteTimeoutMs: 30_000 },
    });

    try {
      const started = hostNow();
      const result = await bash.exec(`sqlite3 :memory: "${RUNAWAY_SQL}"`);

      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("did not exit after cancellation");
      expect(hostNow() - started).toBeLessThan(10_000);
    } finally {
      await Promise.all(realTerminations.map((terminate) => terminate()));
    }
  }, 30_000);

  it("releases a file database's lock when its query is cancelled", async () => {
    const fs = new InMemoryFs();
    const limits = { maxExecutionTimeMs: 400, maxSqliteTimeoutMs: 30_000 };
    await new Bash({ fs }).exec('sqlite3 /d.db "CREATE TABLE t(x INT)"');
    await new Bash({ fs, executionLimits: limits }).exec(
      `sqlite3 /d.db "${RUNAWAY_SQL}"`,
    );

    const result = await new Bash({ fs, executionLimits: limits }).exec(
      'sqlite3 /d.db "SELECT count(*) FROM t"',
    );

    expect(result).toMatchObject({ stdout: "0\n", stderr: "", exitCode: 0 });
  }, 30_000);
});

describe("sqlite3 -readonly", () => {
  it("rejects writes, also after the SQL turns query_only off", async () => {
    const bash = new Bash();
    await bash.exec(
      'sqlite3 /ro.db "CREATE TABLE t(x INT); INSERT INTO t VALUES(1)"',
    );

    const direct = await bash.exec('sqlite3 -readonly /ro.db "DELETE FROM t"');
    const reenabled = await bash.exec(
      'sqlite3 -readonly /ro.db "PRAGMA query_only = OFF; DELETE FROM t; SELECT count(*) FROM t"',
    );

    expect(direct.exitCode).toBe(1);
    expect(direct.stderr).toContain("readonly");
    expect(reenabled.exitCode).toBe(1);
    expect(reenabled.stderr).toContain("readonly");
    expect(reenabled.stdout).toBe("1\n");
  });

  it("does not send the database back from the worker", async () => {
    const bash = new Bash();
    await bash.exec('sqlite3 /ro.db "CREATE TABLE t(x INT)"');
    const observed = observeWorkers();

    const result = await bash.exec(
      'sqlite3 -readonly /ro.db "PRAGMA user_version"',
    );

    expect(result).toMatchObject({ stdout: "0\n", exitCode: 0 });
    expect(observed).toHaveLength(1);
    expect(observed[0].messages).toHaveLength(1);
    expect(observed[0].messages[0]).toMatchObject({
      success: true,
      dbBuffer: null,
    });
  });
});
