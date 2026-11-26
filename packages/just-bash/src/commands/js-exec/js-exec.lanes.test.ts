import { setMaxWorkers } from "run";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import type { ExecutionLimits } from "../../limits.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tool double whose `held` calls reply only when released (or after 5 s). */
function heldTools() {
  const calls: { path: string; signal: AbortSignal; replied: boolean }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const firstArrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const invokeTool = async (
    path: string,
    argsJson: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const call = { path, signal, replied: false };
    calls.push(call);
    arrived();
    await (path === "held"
      ? Promise.race([released, sleep(5_000)])
      : sleep(path === "wait" ? JSON.parse(argsJson).ms : 0));
    call.replied = true;
    return '{"ok":true}';
  };
  return { calls, release, firstArrival, invokeTool };
}

const bash = (
  invokeTool: ReturnType<typeof heldTools>["invokeTool"],
  executionLimits: ExecutionLimits = {},
) => new Bash({ javascript: { invokeTool }, executionLimits });

const HELD = `js-exec -c "console.log(tools.held({}).ok)"`;

describe("js-exec lanes and guest-only budget", () => {
  // run admits at most its memory-based worker cap, which can be 1.
  beforeAll(() => setMaxWorkers(4));
  afterAll(() => setMaxWorkers(undefined));

  it("runs up to maxJsLanes scripts at once across Bash instances", async () => {
    const tools = heldTools();
    const runs = [1, 2].map(() =>
      bash(tools.invokeTool, { maxJsLanes: 2 }).exec(HELD),
    );
    for (let i = 0; i < 100 && tools.calls.length < 2; i++) await sleep(50);
    const concurrentCalls = tools.calls.length;
    tools.release();

    expect(concurrentCalls).toBe(2);
    for (const result of await Promise.all(runs)) {
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: "true\n",
      });
    }
  });

  it("keeps one lane by default", async () => {
    const tools = heldTools();
    const runs = [1, 2].map(() => bash(tools.invokeTool).exec(HELD));
    await tools.firstArrival;
    await sleep(500);
    const callsWhileHeld = tools.calls.length;
    tools.release();

    expect(callsWhileHeld).toBe(1);
    for (const result of await Promise.all(runs)) {
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: "true\n",
      });
    }
    expect(tools.calls).toHaveLength(2);
  });

  it("does not count time waiting on a tool against maxJsTimeoutMs", async () => {
    const tools = heldTools();
    const result = await bash(tools.invokeTool, {
      maxJsTimeoutMs: 300,
    }).exec(
      `js-exec -c "for (let i = 0; i < 3; i++) tools.wait({ ms: 200 }); console.log('done')"`,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "done\n" });
  });

  it("stops guest code that exceeds maxJsTimeoutMs after a tool call", async () => {
    const tools = heldTools();
    const result = await bash(tools.invokeTool, {
      maxJsTimeoutMs: 300,
    }).exec(`js-exec -c "tools.wait({ ms: 200 }); for (;;) {}"`);

    expect(result).toMatchObject({
      exitCode: 124,
      stderr: "js-exec: Execution timeout: exceeded 300ms limit\n",
      stdout: "",
    });
  });

  it("releases the lane of a run aborted during a tool call before the tool replies", async () => {
    const tools = heldTools();
    const controller = new AbortController();
    const aborted = bash(tools.invokeTool).exec(HELD, {
      signal: controller.signal,
    });
    await tools.firstArrival;
    controller.abort();
    const abortedResult = await aborted;
    const successor = await bash(tools.invokeTool).exec(
      `js-exec -c "console.log('plain')"`,
    );
    const heldReplied = tools.calls[0]?.replied;
    tools.release();

    expect(abortedResult.exitCode).toBe(124);
    expect(tools.calls[0]?.signal.aborted).toBe(true);
    expect(successor).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "plain\n",
    });
    expect(heldReplied).toBe(false);
  });

  it.each([
    0,
    33,
    1.5,
    Number.POSITIVE_INFINITY,
  ])("rejects maxJsLanes %s", (maxJsLanes) => {
    expect(() => new Bash({ executionLimits: { maxJsLanes } })).toThrow(
      new RangeError("maxJsLanes must be an integer from 1 to 32"),
    );
  });

  it("frees the lane of a script without tools at the shell deadline", async () => {
    const started = performance.now();
    const stuck = new Bash({
      javascript: true,
      executionLimits: { maxJsTimeoutMs: 20_000, maxExecutionTimeMs: 500 },
    }).exec(`js-exec -c "for (;;) {}"`);
    await sleep(50);
    const next = await new Bash({ javascript: true }).exec(
      `js-exec -c "console.log('next')"`,
    );
    const nextMs = performance.now() - started;

    expect((await stuck).exitCode).toBe(124);
    expect(next).toMatchObject({ exitCode: 0, stdout: "next\n" });
    // Without the cap it waits for the 20 s guest budget.
    expect(nextMs).toBeLessThan(5_000);
  });
});
