import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { ExecutionAbortedError } from "../interpreter/errors.js";

const ABORTED = "bash: test cancelled the filesystem call\n";

/** A filesystem whose calls on /abort fail as a cancelled shell's would. */
class AbortingFs extends InMemoryFs {
  override async readFile(
    ...args: Parameters<InMemoryFs["readFile"]>
  ): ReturnType<InMemoryFs["readFile"]> {
    if (args[0] === "/abort") throw new ExecutionAbortedError("", ABORTED);
    return await super.readFile(...args);
  }

  override async writeFile(
    ...args: Parameters<InMemoryFs["writeFile"]>
  ): Promise<void> {
    if (args[0] === "/abort") throw new ExecutionAbortedError("", ABORTED);
    await super.writeFile(...args);
  }
}

describe("cancellation inside awk and sed file I/O", () => {
  it.each([
    ["awk input file", `awk '{ print }' /abort`],
    [
      "awk getline < file",
      `awk 'BEGIN { getline x < "/abort"; print "after" }'`,
    ],
    ["sed -f script file", "sed -f /abort /in.txt"],
    ["sed r", "sed 'r /abort' /in.txt"],
    ["sed R", "sed 'R /abort' /in.txt"],
    ["sed w", "sed 'w /abort' /in.txt"],
  ])("stops %s instead of treating the cancellation as a missing file", async (_name, script) => {
    const bash = new Bash({
      fs: new AbortingFs({ "/in.txt": "a\n", "/abort": "x\n" }),
    });

    expect(await bash.exec(script)).toMatchObject({
      exitCode: 124,
      stderr: ABORTED,
      stdout: "",
    });
  });
});
