import {
  type ContinuationCodec,
  createSignedContinuationCodec,
  RunProtocolError,
} from "run";
import { describe, expect, it } from "vitest";
import type {
  InvokeToolCall,
  JavaScriptInterruption,
  JavaScriptPauseConfig,
} from "../../Bash.js";
import { Bash } from "../../Bash.js";
import { defineCommand } from "../../custom-commands.js";
import type { ExecutionLimits } from "../../limits.js";

const codec = createSignedContinuationCodec({
  secret: "test-continuation-secret-32-bytes!",
  maxAgeMs: 60_000,
});
const HOST_GROUP =
  "Object.getOwnPropertyNames(globalThis).find((k) => /^__jbHost_[0-9a-z]+$/.test(k))";
const INVALID = "js-exec: Continuation is invalid.\n";
const STORAGE_FAILED = "js-exec: Continuation could not be stored or read.\n";

interface Handoff {
  interruptions: JavaScriptInterruption[];
  continuation: string;
}

const gatedTool = async (
  path: string,
  _argsJson: string,
  _signal: AbortSignal,
  call: InvokeToolCall,
) => {
  if (call.resume === undefined) call.interrupt({ ask: path });
  return JSON.stringify({ ok: path });
};

function pausingBash(
  pause: Partial<JavaScriptPauseConfig> = {},
  bootstrap?: string,
  executionLimits?: ExecutionLimits,
) {
  const state: { handoff?: Handoff } = {};
  const bash = new Bash({
    executionLimits,
    javascript: {
      bootstrap,
      invokeTool: gatedTool,
      pause: {
        continuationCodec: codec,
        onInterrupted: (info) => {
          state.handoff = info;
        },
        ...pause,
      },
    },
  });
  return { bash, state };
}

/** The test codec, counting the continuations it is asked to decode. */
function countingCodec() {
  const counted = { decodes: 0 };
  const counting: ContinuationCodec<string> = {
    encode: (state, context) => codec.encode(state, context),
    decode: (token, context) => {
      counted.decodes += 1;
      return codec.decode(token, context);
    },
  };
  return { counted, counting };
}

const approve = (handoff: Handoff | undefined) => ({
  continuation: handoff?.continuation ?? "",
  resolutions: (handoff?.interruptions ?? []).map(({ id }) => ({
    interruptionId: id,
    value: "approved",
  })),
});

async function pauseOnce(script: string, bootstrap?: string) {
  const { bash, state } = pausingBash({}, bootstrap);
  const result = await bash.exec(`js-exec -c '${script}'`);
  expect(result.exitCode).toBe(75);
  return state.handoff;
}

describe("js-exec pause hardening", () => {
  it("ends the bootstrap phase on resume", async () => {
    // A guest call to bootstrapError after the bootstrap must not turn a
    // later failure into a bootstrap error.
    const script = `await tools.write({}); try { globalThis[${HOST_GROUP}].bootstrapError("spoof") } catch {} throw new Error("after")`;
    const bootstrap = "globalThis.booted = true;";
    const handoff = await pauseOnce(script, bootstrap);
    const { bash } = pausingBash({ resume: approve(handoff) }, bootstrap);

    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 1,
      stderr: "at <eval> (-c:1:175): after\n",
      stdout: "",
    });
  });

  it("runs a continuation at most once per Bash instance", async () => {
    const script = `console.log((await tools.write({})).ok)`;
    const handoff = await pauseOnce(script);
    const { bash } = pausingBash({ resume: approve(handoff) });

    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 0,
      stdout: "write\n",
    });
    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 1,
      stderr: "js-exec: Continuation was already used.\n",
      stdout: "",
    });
  });

  it("keeps a resume usable when it was cancelled while queued for a lane", async () => {
    const script = `console.log((await tools.write({})).ok)`;
    const handoff = await pauseOnce(script);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const holding = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const holder = new Bash({
      javascript: {
        invokeTool: async () => {
          arrived();
          await released;
          return "{}";
        },
      },
    });
    const held = holder.exec(`js-exec -c "tools.hold({})"`);
    await holding;
    const { counted, counting } = countingCodec();
    const { bash } = pausingBash(
      { continuationCodec: counting, resume: approve(handoff) },
      undefined,
      { maxExecutionTimeMs: 300 },
    );

    expect((await bash.exec(`js-exec -c '${script}'`)).exitCode).toBe(124);
    release();
    await held;
    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 0,
      stdout: "write\n",
    });
    expect(counted.decodes).toBe(1);
  });

  it.each([
    ["an extra field", (e: object) => ({ ...e, extra: 1 })],
    ["an empty token", (e: object) => ({ ...e, token: "" })],
  ])("rejects an envelope with %s", async (_name, change) => {
    const handoff = await pauseOnce(`await tools.write({})`);
    const envelope = change(JSON.parse(handoff?.continuation ?? "{}"));
    const { bash } = pausingBash({
      resume: { ...approve(handoff), continuation: JSON.stringify(envelope) },
    });

    expect(await bash.exec(`js-exec -c "1"`)).toMatchObject({
      exitCode: 1,
      stderr: INVALID,
    });
  });

  it("rejects an oversized envelope before parsing it", async () => {
    // Valid JSON once parsed: only the size check refuses it.
    const script = `await tools.write({})`;
    const handoff = await pauseOnce(script);
    const continuation = `${handoff?.continuation}${" ".repeat(48 * 1024 * 1024)}`;
    const { bash } = pausingBash({
      resume: { ...approve(handoff), continuation },
    });

    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 1,
      stderr: INVALID,
    });
  });

  it("reports a failing codec or transaction without its error text", async () => {
    const leakyEncode: ContinuationCodec<string> = {
      encode: () => {
        throw new Error("SECRET state");
      },
      decode: (token, context) => codec.decode(token, context),
    };
    const { bash } = pausingBash({ continuationCodec: leakyEncode });
    expect(await bash.exec(`js-exec -c "await tools.write({})"`)).toMatchObject(
      { exitCode: 1, stderr: STORAGE_FAILED },
    );

    const handoff = await pauseOnce(`await tools.write({})`);
    const leakyCommit: ContinuationCodec<string> = {
      encode: (state, context) => codec.encode(state, context),
      decode: (token, context) => codec.decode(token, context),
      decodeTransaction: async (token, context) => ({
        state: await codec.decode(token, context),
        commit: () => {
          throw new Error(`SECRET ${token}`);
        },
        rollback: () => {},
      }),
    };
    const resumed = pausingBash({
      continuationCodec: leakyCommit,
      resume: approve(handoff),
    });
    expect(
      await resumed.bash.exec(`js-exec -c "await tools.write({})"`),
    ).toMatchObject({ exitCode: 1, stderr: STORAGE_FAILED });
  });

  it("reports a codec's typed run error without its text", async () => {
    const throwsRunError: ContinuationCodec<string> = {
      encode: () => {
        throw new RunProtocolError("SECRET state");
      },
      decode: (token, context) => codec.decode(token, context),
    };
    const { bash } = pausingBash({ continuationCodec: throwsRunError });

    expect(await bash.exec(`js-exec -c "await tools.write({})"`)).toMatchObject(
      { exitCode: 1, stderr: STORAGE_FAILED, stdout: "" },
    );
  });

  it("shows run's own codec failure", async () => {
    const script = `await tools.write({})`;
    const handoff = await pauseOnce(script);
    const envelope = JSON.parse(handoff?.continuation ?? "{}");
    const { bash } = pausingBash({
      resume: {
        ...approve(handoff),
        continuation: JSON.stringify({
          ...envelope,
          token: `${envelope.token}x`,
        }),
      },
    });

    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 1,
      stderr: "js-exec: Continuation signature is invalid.\n",
    });
  });

  it("shows a codec error's text as it read it once", async () => {
    const error = new RunProtocolError("");
    const reads = ["Continuation signature is invalid.", "SECRET state"];
    Object.defineProperty(error, "message", { get: () => reads.shift() });
    const { bash } = pausingBash({
      continuationCodec: {
        encode: () => {
          throw error;
        },
        decode: (token, context) => codec.decode(token, context),
      },
    });

    expect(await bash.exec(`js-exec -c "await tools.write({})"`)).toMatchObject(
      { exitCode: 1, stderr: "js-exec: Continuation signature is invalid.\n" },
    );
  });

  it.each([
    ["the signed codec's default size limit", 33_554_432, true],
    ["another size limit", 12_345, false],
  ])("shows a token size failure only for %s", async (_name, limit, shown) => {
    const text = `Continuation token exceeds the ${limit} byte size limit.`;
    const { bash } = pausingBash({
      continuationCodec: {
        encode: () => {
          throw new RunProtocolError(text);
        },
        decode: (token, context) => codec.decode(token, context),
      },
    });

    expect((await bash.exec(`js-exec -c "await tools.write({})"`)).stderr).toBe(
      shown ? `js-exec: ${text}\n` : STORAGE_FAILED,
    );
  });

  it("reads codec properties only inside its failure guard", async () => {
    const getterCodec = {
      encode: (state, context) => codec.encode(state, context),
      decode: (token, context) => codec.decode(token, context),
      get decodeTransaction(): never {
        throw new Error("SECRET getter");
      },
    } satisfies ContinuationCodec<string>;
    const script = `console.log((await tools.write({})).ok)`;
    const paused = pausingBash({ continuationCodec: getterCodec });
    expect(await paused.bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 75,
    });
    const { bash } = pausingBash({
      continuationCodec: getterCodec,
      resume: approve(paused.state.handoff),
    });

    expect(await bash.exec(`js-exec -c '${script}'`)).toMatchObject({
      exitCode: 1,
      stderr: STORAGE_FAILED,
      stdout: "",
    });
  });

  it.each([
    ["an empty token", ""],
    // Within run's limits, but over the envelope cap once JSON escapes it.
    ["a token over the envelope cap", "\u0001".repeat(9 * 1024 * 1024)],
  ])("does not hand off a continuation with %s", async (_name, token) => {
    const { bash, state } = pausingBash({
      continuationCodec: { encode: () => token, decode: codec.decode },
    });

    expect(await bash.exec(`js-exec -c "await tools.write({})"`)).toMatchObject(
      { exitCode: 1, stderr: STORAGE_FAILED, stdout: "" },
    );
    expect(state.handoff).toBeUndefined();
  });

  it("does not hand the pause configuration to other commands", async () => {
    const peek = defineCommand("peek", async (_args, ctx) => ({
      exitCode: 0,
      stderr: "",
      stdout: `${"jsPause" in ctx} ${"jsExecHost" in ctx}\n`,
    }));
    const bash = new Bash({
      customCommands: [peek],
      javascript: {
        invokeTool: gatedTool,
        pause: { continuationCodec: codec, onInterrupted: () => {} },
      },
    });

    expect((await bash.exec("peek")).stdout).toBe("false false\n");
  });

  it("checks the synchronous tool binding's arguments", async () => {
    const paths: unknown[] = [];
    const bash = new Bash({
      javascript: {
        invokeTool: async (path) => {
          paths.push(path);
          return "";
        },
      },
    });

    expect(
      await bash.exec(
        `js-exec -c 'console.log(JSON.stringify(globalThis[${HOST_GROUP}].invokeTool(1, {})))'`,
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout:
        '{"error":"Tool path and arguments must be strings","ok":false}\n',
    });
    expect(paths).toEqual([]);
  });
});
