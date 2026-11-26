import { createSignedContinuationCodec } from "run";
import { describe, expect, it } from "vitest";
import type {
  InvokeToolCall,
  JavaScriptInterruption,
  JavaScriptPauseConfig,
} from "../../Bash.js";
import { Bash } from "../../Bash.js";

const codec = createSignedContinuationCodec({
  secret: "test-continuation-secret-32-bytes!",
  maxAgeMs: 60_000,
});
const SCRIPT = [
  "const read = await tools.read({ q: 1 });",
  "const written = await tools.write({ path: process.env.TARGET });",
  "console.log(read.ok, written.ok);",
].join("\n");
const PAUSED = "js-exec: paused for approval of 1 tool call(s)\n";

interface Handoff {
  interruptions: JavaScriptInterruption[];
  continuation: string;
}

/** Each phase is a fresh Bash, as a resume in a later request would be. */
function harness() {
  const calls: { path: string; requestIndex: number; signal: AbortSignal }[] =
    [];
  const effects: string[] = [];
  const invokeTool = async (
    path: string,
    _argsJson: string,
    signal: AbortSignal,
    call: InvokeToolCall,
  ) => {
    calls.push({ path, requestIndex: call.requestIndex, signal });
    if (path === "write") {
      if (call.resume === undefined) call.interrupt({ ask: path });
      if (call.resume.resolution !== "approved") throw new Error("denied");
    }
    effects.push(path);
    return JSON.stringify({ ok: path });
  };
  const phase = async (
    options: {
      resume?: JavaScriptPauseConfig["resume"];
      context?: unknown;
      env?: Record<string, string>;
      onInterrupted?: JavaScriptPauseConfig["onInterrupted"];
    } = {},
  ) => {
    let handoff: Handoff | undefined;
    const bash = new Bash({
      // A module script loads env through the bootstrap module, which run
      // replays from its record unless js-exec binds it to the continuation.
      files: { "/script.mjs": SCRIPT },
      env: options.env ?? { TARGET: "/work" },
      javascript: {
        invokeTool,
        pause: {
          continuationCodec: codec,
          continuationContext: options.context ?? { user: "u1" },
          resume: options.resume,
          onInterrupted:
            options.onInterrupted ??
            ((info) => {
              handoff = info;
            }),
        },
      },
    });
    const result = await bash.exec("js-exec /script.mjs");
    return { result, handoff };
  };
  const approve = (handoff: Handoff | undefined) => ({
    continuation: handoff?.continuation ?? "",
    resolutions: (handoff?.interruptions ?? []).map(({ id }) => ({
      interruptionId: id,
      value: "approved",
    })),
  });
  return { calls, effects, phase, approve };
}

describe("js-exec pause and resume", () => {
  it("pauses at an interrupted tool call and runs it once on resume", async () => {
    const { calls, effects, phase, approve } = harness();
    const paused = await phase();
    const resumed = await phase({ resume: approve(paused.handoff) });

    expect(paused.result).toMatchObject({
      exitCode: 75,
      stderr: PAUSED,
      stdout: "",
    });
    expect(paused.handoff?.interruptions).toEqual([
      {
        id: expect.any(String),
        tool: "write",
        argsJson: '{"path":"/work"}',
        payload: { ask: "write" },
        requestIndex: calls[1]?.requestIndex,
      },
    ]);
    expect(resumed.result).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "read write\n",
    });
    expect(effects).toEqual(["read", "write"]);
    expect(calls.map(({ path }) => path)).toEqual(["read", "write", "write"]);
    expect(calls[2]?.requestIndex).toBe(calls[1]?.requestIndex);
    // run aborts with the interrupted result; tools see a fixed reason.
    expect(calls[1]?.signal.reason).toEqual(new Error("js-exec run ended"));
    const token = JSON.parse(paused.handoff?.continuation ?? "{}").token;
    expect(paused.result.stdout + paused.result.stderr).not.toContain(
      token.slice(0, 48),
    );
  });

  it("fails a tool's interrupt closed when pause is not configured", async () => {
    const bash = new Bash({
      javascript: {
        invokeTool: async (_path, _argsJson, _signal, call) =>
          call.interrupt({ ask: "write" }),
      },
    });

    expect(
      await bash.exec(
        `js-exec -c "try { tools.write({}) } catch (error) { console.log(error.message) }"`,
      ),
    ).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout:
        "This script cannot pause for approval: javascript.pause is not configured.\n",
    });
  });

  it.each([
    ["not JSON", { continuation: "not json", resolutions: [] }],
    [
      "an unknown host group",
      {
        continuation: JSON.stringify({
          v: 1,
          hostName: "globalThis",
          bootstrapId: "just-bash:bootstrap:x",
          token: "t",
        }),
        resolutions: [],
      },
    ],
  ])("rejects a continuation that is %s", async (_name, resume) => {
    const { effects, phase } = harness();

    expect((await phase({ resume })).result).toMatchObject({
      exitCode: 1,
      stderr: "js-exec: Continuation is invalid.\n",
      stdout: "",
    });
    expect(effects).toEqual([]);
  });

  it.each([
    ["another caller context", { context: { user: "u2" } }],
    ["a changed environment", { env: { TARGET: "/elsewhere" } }],
  ])("refuses to resume with %s", async (_name, change) => {
    const { effects, phase, approve } = harness();
    const paused = await phase();
    const refused = await phase({ ...change, resume: approve(paused.handoff) });

    expect(refused.result).toMatchObject({
      exitCode: 1,
      stderr:
        "js-exec: Continuation does not match the supplied source, scope, or runtime version.\n",
      stdout: "",
    });
    expect(effects).toEqual(["read"]);
  });

  it("hands off after releasing the lane and fails with a fixed message when the handoff throws", async () => {
    const { phase } = harness();
    let laneFree: unknown;
    const result = await phase({
      async onInterrupted(info) {
        laneFree = await new Bash({ javascript: true }).exec(
          `js-exec -c "console.log('free')"`,
        );
        throw new Error(`cannot store ${info.continuation}`);
      },
    });

    expect(laneFree).toMatchObject({ exitCode: 0, stdout: "free\n" });
    expect(result.result).toMatchObject({
      exitCode: 1,
      stderr: "js-exec: Could not hand off the paused script.\n",
      stdout: "",
    });
  });
});
