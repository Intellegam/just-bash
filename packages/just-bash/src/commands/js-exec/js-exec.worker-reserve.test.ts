import { Worker } from "node:worker_threads";
import {
  type ContinuationCodec,
  createSignedContinuationCodec,
  RunConcurrencyError,
  type RunResolution,
  setMaxWorkers,
} from "run";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Bash,
  type InvokeToolCall,
  type JavaScriptPauseConfig,
} from "../../Bash.js";
import type { ExecutionLimits } from "../../limits.js";
import { _setTimeout } from "../../timers.js";

const REFUSED =
  "js-exec: no JavaScript worker is free; the script did not run\n";
const HELD = `js-exec -c "console.log(tools.held({}).ok)"`;
const PLAIN = `js-exec -c "console.log('plain')"`;
// Lanes above the worker cap, so admission is decided by run's workers.
const LANES: ExecutionLimits = { maxJsLanes: 3 };

/** Tools whose calls reply only when released (or after 5 s). */
function heldTools() {
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const firstArrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const invokeTool = async (
    _path: string,
    _argsJson: string,
    signal: AbortSignal,
  ): Promise<string> => {
    signals.push(signal);
    arrived();
    await Promise.race([
      released,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    return '{"ok":true}';
  };
  return { signals, release, firstArrival, invokeTool };
}

function codeMode(
  invokeTool: ReturnType<typeof heldTools>["invokeTool"],
  executionLimits: ExecutionLimits = {},
) {
  let refusals = 0;
  const bash = new Bash({
    javascript: {
      invokeTool,
      onWorkerRefused: () => {
        refusals += 1;
      },
    },
    executionLimits: { ...LANES, ...executionLimits },
  });
  return { bash, refusals: () => refusals };
}

/** Delays every worker termination, as a slow thread exit would. */
function slowWorkerExit(ms: number): () => void {
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function (this: Worker) {
    return new Promise<number>((resolve, reject) => {
      _setTimeout(() => terminate.call(this).then(resolve, reject), ms);
    });
  };
  return () => {
    Worker.prototype.terminate = terminate;
  };
}

const abortOf = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal === undefined || signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

const WORKER_EXIT_MS = 1_500;
// Long enough for the held tool call to arrive before the shell deadline.
const SHELL_DEADLINE: ExecutionLimits = { maxExecutionTimeMs: 1_000 };

describe("js-exec worker reserve", { timeout: 20_000 }, () => {
  beforeAll(async () => {
    setMaxWorkers(2);
    await new Bash({ javascript: true }).exec(PLAIN);
  });
  afterAll(() => setMaxWorkers(undefined));

  it("refuses a second tool-using script but still runs a script without tools", async () => {
    const tools = heldTools();
    const holder = codeMode(tools.invokeTool).bash.exec(HELD);
    await tools.firstArrival;
    const second = codeMode(tools.invokeTool);
    const [secondResult, plainResult] = await Promise.all([
      second.bash.exec(HELD),
      new Bash({ javascript: true, executionLimits: LANES }).exec(PLAIN),
    ]);
    tools.release();

    expect(secondResult).toMatchObject({
      exitCode: 1,
      stderr: REFUSED,
      stdout: "",
    });
    expect(second.refusals()).toBe(1);
    expect(plainResult).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "plain\n",
    });
    expect(await holder).toMatchObject({ exitCode: 0, stdout: "true\n" });
  });

  describe("a resume", () => {
    const signed = createSignedContinuationCodec({
      secret: "test-continuation-secret-32-bytes!",
      maxAgeMs: 60_000,
    });
    const script = `js-exec -c "console.log((await tools.write({})).ok)"`;
    let decodes = 0;
    const counting: ContinuationCodec<string> = {
      encode: (state, context) => signed.encode(state, context),
      decode: (token, context) => {
        decodes += 1;
        return signed.decode(token, context);
      },
    };
    const pausing = (resume?: JavaScriptPauseConfig["resume"]) => {
      const handoffs: Parameters<JavaScriptPauseConfig["onInterrupted"]>[0][] =
        [];
      const bash = new Bash({
        executionLimits: LANES,
        javascript: {
          invokeTool: async (path, _args, _signal, call: InvokeToolCall) => {
            if (call.resume === undefined) call.interrupt({});
            return JSON.stringify({ ok: path });
          },
          pause: {
            continuationCodec: counting,
            onInterrupted: (info) => {
              handoffs.push(info);
            },
            resume,
          },
        },
      });
      return { bash, handoffs };
    };
    const pauseOnce = async () => {
      const first = pausing();
      expect((await first.bash.exec(script)).exitCode).toBe(75);
      decodes = 0;
      return first.handoffs[0];
    };

    it("stays usable when no worker was free for it", async () => {
      const paused = await pauseOnce();
      const resumed = pausing({
        continuation: paused?.continuation ?? "",
        resolutions: (paused?.interruptions ?? []).map(({ id }) => ({
          interruptionId: id,
          value: "approved",
        })),
      });
      const tools = heldTools();
      const holder = codeMode(tools.invokeTool).bash.exec(HELD);
      await tools.firstArrival;

      expect(await resumed.bash.exec(script)).toMatchObject({
        exitCode: 1,
        stderr: REFUSED,
      });
      tools.release();
      await holder;
      expect(await resumed.bash.exec(script)).toMatchObject({
        exitCode: 0,
        stdout: "write\n",
      });
      expect(decodes).toBe(1);
    });

    it("is used up once its continuation was decoded, whatever the error", async () => {
      const paused = await pauseOnce();
      const resolutions = (paused?.interruptions ?? []).map(
        ({ id }): RunResolution =>
          Object.defineProperty({ interruptionId: id }, "value", {
            enumerable: true,
            get: () => {
              throw new RunConcurrencyError(2, 1);
            },
          }) as RunResolution,
      );
      const resumed = pausing({
        continuation: paused?.continuation ?? "",
        resolutions,
      });

      expect((await resumed.bash.exec(script)).exitCode).toBe(1);
      expect(decodes).toBe(1);
      expect(await resumed.bash.exec(script)).toMatchObject({
        exitCode: 1,
        stderr: "js-exec: Continuation was already used.\n",
      });
      expect(decodes).toBe(1);
    });
  });

  it("keeps a worker free while a timed-out tool-using script's worker exits", async () => {
    const restore = slowWorkerExit(WORKER_EXIT_MS);
    const tools = heldTools();
    try {
      const timedOut = codeMode(tools.invokeTool, SHELL_DEADLINE).bash.exec(
        HELD,
      );
      await tools.firstArrival;
      await abortOf(tools.signals[0]);
      const second = codeMode(tools.invokeTool);
      const [secondResult, plainResult] = await Promise.all([
        second.bash.exec(HELD),
        new Bash({ javascript: true, executionLimits: LANES }).exec(PLAIN),
      ]);
      tools.release();

      expect(secondResult).toMatchObject({
        exitCode: 1,
        stderr: REFUSED,
        stdout: "",
      });
      expect(plainResult).toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: "plain\n",
      });
      expect((await timedOut).exitCode).toBe(124);
    } finally {
      tools.release();
      restore();
    }
  });

  it("returns from a timed-out tool-using script only once its worker is free", async () => {
    const restore = slowWorkerExit(WORKER_EXIT_MS);
    const tools = heldTools();
    try {
      const timedOut = await codeMode(
        tools.invokeTool,
        SHELL_DEADLINE,
      ).bash.exec(HELD);
      const next = await codeMode(tools.invokeTool).bash.exec(
        `js-exec -c "console.log('next')"`,
      );

      expect(timedOut.exitCode).toBe(124);
      expect(next).toMatchObject({ exitCode: 0, stderr: "", stdout: "next\n" });
    } finally {
      tools.release();
      restore();
    }
  });
});
