import { createSignedContinuationCodec } from "run";
import { describe, expect, it } from "vitest";
import { Bash, type InvokeTool, type JavaScriptConfig } from "../../Bash.js";

const NOT_PAUSABLE =
  "This script cannot pause for approval: javascript.pause is not configured.";
const codec = createSignedContinuationCodec({
  secret: "test-continuation-secret-32-bytes!",
  maxAgeMs: 60_000,
});

const asyncToolsBash = (
  invokeTool: InvokeTool,
  javascript: Partial<JavaScriptConfig> = {},
  maxExecutionTimeMs?: number,
) =>
  new Bash({
    executionLimits: { maxExecutionTimeMs },
    javascript: { invokeTool, asyncTools: true, ...javascript },
  });

/** A tool that settles only when its signal aborts, recording the signal. */
function pendingTool() {
  const signals: AbortSignal[] = [];
  let aborted!: () => void;
  const abortedOnce = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const invokeTool: InvokeTool = (_path, _argsJson, signal) => {
    signals.push(signal);
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted();
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  return { signals, abortedOnce, invokeTool };
}

describe("js-exec asyncTools", () => {
  it("returns Promises from tools.*", async () => {
    const bash = asyncToolsBash(async (_path, argsJson) =>
      JSON.stringify({ sum: JSON.parse(argsJson).a + 1 }),
    );

    expect(
      await bash.exec(
        `js-exec -c "const p = tools.math.add({ a: 1 }); console.log(p instanceof Promise, (await p).sum)"`,
      ),
    ).toMatchObject({ exitCode: 0, stdout: "true 2\n", stderr: "" });
  });

  it("makes interrupt throw instead of pausing", async () => {
    const thrown: string[] = [];
    const bash = asyncToolsBash(async (_path, _argsJson, _signal, call) => {
      try {
        call.interrupt({ ask: true });
      } catch (error) {
        thrown.push((error as Error).message);
        throw error;
      }
      return "";
    });

    expect(
      await bash.exec(
        `js-exec -c "console.log(await tools.gated({}).then(() => 'resolved', () => 'rejected'))"`,
      ),
    ).toMatchObject({ exitCode: 0, stdout: "rejected\n" });
    expect(thrown).toEqual([NOT_PAUSABLE]);
  });

  it("keeps no continuation ledger", async () => {
    // Ten 4 MiB replies: over run's 32 MiB continuation state limit, which a
    // pausable run records every bridge reply against.
    const big = JSON.stringify("x".repeat(4 * 1024 * 1024));
    const script = `js-exec -c "if (!(tools.big({}) instanceof Promise)) throw new Error('sync'); let n = 0; for (let i = 0; i < 9; i++) n += (await tools.big({})).length; console.log(n)"`;
    const invokeTool: InvokeTool = async () => big;

    expect(await asyncToolsBash(invokeTool).exec(script)).toMatchObject({
      exitCode: 0,
      stdout: "37748736\n",
      stderr: "",
    });
    const pausable = new Bash({
      javascript: {
        invokeTool,
        pause: { continuationCodec: codec, onInterrupted: () => {} },
      },
    });
    expect(await pausable.exec(script)).toMatchObject({
      exitCode: 1,
      stderr:
        "js-exec: Continuation state exceeds the 33554432 byte size limit.\n",
    });
  });

  it("aborts a pending call with a fixed reason, not the guest's error", async () => {
    const tool = pendingTool();
    const bash = asyncToolsBash(tool.invokeTool);

    const result = await bash.exec(
      `js-exec -c "tools.slow({}); throw new Error('SECRET')"`,
    );
    await tool.abortedOnce;

    expect(result.exitCode).toBe(1);
    expect(tool.signals).toHaveLength(1);
    expect((tool.signals[0]?.reason as Error).message).toBe(
      "js-exec run ended",
    );
  });

  it("cancels a pending call at the shell deadline", async () => {
    const tool = pendingTool();
    const bash = asyncToolsBash(tool.invokeTool, {}, 300);

    expect(
      (await bash.exec(`js-exec -c "await tools.slow({})"`)).exitCode,
    ).toBe(124);
    await tool.abortedOnce;
    expect(tool.signals[0]?.aborted).toBe(true);
  });

  it("gives no tools without invokeTool", async () => {
    const bash = new Bash({ javascript: { asyncTools: true } });

    expect(
      await bash.exec(`js-exec -c "console.log(typeof tools, 1 + 1)"`),
    ).toMatchObject({ exitCode: 0, stdout: "undefined 2\n", stderr: "" });
  });

  it("lets pause win when both are set", async () => {
    const handoffs: unknown[] = [];
    const bash = asyncToolsBash(
      async (_path, _argsJson, _signal, call) => {
        call.interrupt({ ask: true });
        return "";
      },
      {
        pause: {
          continuationCodec: codec,
          onInterrupted: (info) => {
            handoffs.push(info);
          },
        },
      },
    );

    expect(
      (await bash.exec(`js-exec -c "await tools.gated({})"`)).exitCode,
    ).toBe(75);
    expect(handoffs).toHaveLength(1);
  });
});
