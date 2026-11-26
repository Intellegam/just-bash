/**
 * Buffered awk output files.
 *
 * `print > file` and `print >> file` keep their text pending per open file and
 * append it with one write at each barrier, so a redirected file is never
 * re-read per print. A barrier is a full buffer, the first read of a file or
 * command by getline, the start of each input file, and the end of the
 * command.
 *
 * Text is grouped by the resolved path string, not by the file it names, so
 * writes through two paths to one file (a symlink alias) can land out of
 * print order. If the shell deadline passes while a barrier's append is in
 * flight, the files later in that barrier are not written: the shell revokes
 * the command's filesystem access at its deadline.
 */

import { awaitWithDefenseContext } from "../../../security/defense-context.js";
import { SecurityViolationError } from "../../../security/defense-in-depth-box.js";
import type { AwkRuntimeContext } from "./context.js";

// Pending file names count toward the character threshold, so many
// distinct outputs with long names also trigger a flush.
const FLUSH_PENDING_CHARS = 8 * 1024 * 1024;
const FLUSH_PENDING_WRITES = 65_536;

/** Drop a file's pending text, as the truncating first `>` does. */
export function discardPendingOutput(
  ctx: AwkRuntimeContext,
  filePath: string,
): void {
  const chunks = ctx.pendingOutput.get(filePath);
  if (!chunks) return;
  ctx.pendingOutput.delete(filePath);
  ctx.pendingOutputChars -= filePath.length;
  for (const chunk of chunks) ctx.pendingOutputChars -= chunk.length;
  ctx.pendingOutputWrites -= chunks.length;
}

export async function queueFileOutput(
  ctx: AwkRuntimeContext,
  filePath: string,
  text: string,
): Promise<void> {
  let chunks = ctx.pendingOutput.get(filePath);
  if (!chunks) {
    chunks = [];
    ctx.pendingOutput.set(filePath, chunks);
    ctx.pendingOutputChars += filePath.length;
  }
  chunks.push(text);
  ctx.pendingOutputChars += text.length;
  ctx.pendingOutputWrites++;
  if (
    ctx.pendingOutputChars >= FLUSH_PENDING_CHARS ||
    ctx.pendingOutputWrites >= FLUSH_PENDING_WRITES
  ) {
    await awaitWithDefenseContext(
      ctx.requireDefenseContext,
      "awk",
      "redirection buffer flush",
      () => flushOutputFiles(ctx),
    );
  }
}

function takePendingOutput(ctx: AwkRuntimeContext): [string, string][] {
  ctx.pendingOutputChars = 0;
  ctx.pendingOutputWrites = 0;
  const pending = [...ctx.pendingOutput].map(
    ([filePath, chunks]): [string, string] => [filePath, chunks.join("")],
  );
  ctx.pendingOutput.clear();
  return pending;
}

/**
 * Append every pending file, one after another. A failed write does not stop
 * the others; the first failure is thrown once all files were attempted.
 */
export async function flushOutputFiles(ctx: AwkRuntimeContext): Promise<void> {
  const fs = ctx.fs;
  if (!fs) return;
  let failure: { error: unknown } | undefined;
  for (const [filePath, text] of takePendingOutput(ctx)) {
    try {
      await awaitWithDefenseContext(
        ctx.requireDefenseContext,
        "awk",
        "redirection flush write",
        () => fs.appendFile(filePath, text),
      );
    } catch (e) {
      if (e instanceof SecurityViolationError) throw e;
      failure ??= { error: e };
    }
  }
  if (failure) throw failure.error;
}

/**
 * Like `flushOutputFiles`, but every append starts before the first await: a
 * cancelled shell revokes the filesystem while one is in flight, and appends
 * started after that would be lost. Concurrent appends through two paths to
 * one file can lose one of them, so ordinary barriers stay sequential.
 */
export async function flushOutputFilesAfterFailure(
  ctx: AwkRuntimeContext,
): Promise<void> {
  const fs = ctx.fs;
  if (!fs) return;
  const results = await Promise.allSettled(
    takePendingOutput(ctx).map(([filePath, text]) =>
      awaitWithDefenseContext(
        ctx.requireDefenseContext,
        "awk",
        "redirection flush write",
        () => fs.appendFile(filePath, text),
      ),
    ),
  );
  let failure: { error: unknown } | undefined;
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    if (result.reason instanceof SecurityViolationError) throw result.reason;
    failure ??= { error: result.reason };
  }
  if (failure) throw failure.error;
}
