import { getHostFunctionContext } from "run";
import { beforeAll, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";

// The guest must reach its gated call before this deadline; beforeAll loads
// the runtime so the first case does not spend it on startup.
const DEADLINE_MS = 400;

/** Holds writes and copies until the test opens the gate. */
class GatedFs extends InMemoryFs {
  openGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });
  private markDeadline!: () => void;
  /** Resolves when the js-exec run holding a gated call is aborted. */
  readonly deadlinePassed = new Promise<void>((resolve) => {
    this.markDeadline = resolve;
  });

  override async writeFile(
    ...args: Parameters<InMemoryFs["writeFile"]>
  ): Promise<void> {
    await this.hold();
    await super.writeFile(...args);
  }

  override async cp(...args: Parameters<InMemoryFs["cp"]>): Promise<void> {
    await this.hold();
    await super.cp(...args);
  }

  private async hold(): Promise<void> {
    const { abortSignal } = getHostFunctionContext();
    if (abortSignal.aborted) this.markDeadline();
    abortSignal.addEventListener("abort", () => this.markDeadline(), {
      once: true,
    });
    await this.gate;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("js-exec filesystem settlement", () => {
  beforeAll(async () => {
    await new Bash({ javascript: true }).exec(`js-exec -c "1"`);
  });

  it.each([
    ["writeFileSync", "fs.writeFileSync('/out.txt', 'new')"],
    ["copyFileSync", "fs.copyFileSync('/src.txt', '/out.txt')"],
  ])("finishes a %s that outlasts the deadline before the next command", async (_name, call) => {
    const fs = new GatedFs({ "/out.txt": "old", "/src.txt": "new" });
    const bash = new Bash({
      fs,
      javascript: true,
      executionLimits: { maxJsTimeoutMs: DEADLINE_MS },
    });

    const run = bash.exec(
      `js-exec -c "const fs = require('fs'); ${call}"; echo "exit $?"; cat /out.txt`,
    );
    await fs.deadlinePassed;
    // Without settlement, js-exec returns and cat runs in this window.
    await sleep(200);
    fs.openGate();

    expect(await run).toMatchObject({
      exitCode: 0,
      stderr: `js-exec: Execution timeout: exceeded ${DEADLINE_MS}ms limit\n`,
      stdout: "exit 124\nnew",
    });
  });

  it("finishes a module read that outlasts the deadline before returning", async () => {
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let readFinished = false;
    class GatedModuleFs extends InMemoryFs {
      override async readFile(
        ...args: Parameters<InMemoryFs["readFile"]>
      ): ReturnType<InMemoryFs["readFile"]> {
        if (args[0] !== "/mod.mjs") return await super.readFile(...args);
        entered();
        await gate;
        const source = await super.readFile(...args);
        readFinished = true;
        return source;
      }
    }
    const bash = new Bash({
      fs: new GatedModuleFs({
        "/main.mjs": "import '/mod.mjs';",
        "/mod.mjs": "export {};",
      }),
      javascript: true,
      executionLimits: { maxJsTimeoutMs: DEADLINE_MS },
    });

    const run = bash.exec("js-exec /main.mjs").then((result) => ({
      exitCode: result.exitCode,
      readFinished,
    }));
    await readStarted;
    await sleep(DEADLINE_MS + 200);
    openGate();

    expect(await run).toEqual({ exitCode: 124, readFinished: true });
  });
});
