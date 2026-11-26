import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import * as encoding from "../../encoding.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";

/**
 * AWK Execution Limits Tests
 *
 * These tests verify that awk commands cannot cause runaway compute.
 * AWK programs should complete in bounded time regardless of input.
 *
 * IMPORTANT: All tests should complete quickly (<1s each).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AWK Execution Limits", () => {
  describe("infinite loop protection", () => {
    it("should protect against while(1) infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { while(1) print "x" }'`,
      );

      // Should not hang - awk should have iteration limits
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against for loop with always-true condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; 1; i++) print "x" }'`,
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against for(;;) infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(;;) print "x" }'`,
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });

    it("should protect against do-while infinite loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { do { print "x" } while(1) }'`,
      );

      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("recursion protection", () => {
    it("should protect against recursive function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'function f() { f() } BEGIN { f() }'`,
      );

      // Must hit our internal limit, not JS stack overflow
      expect(result.stderr).toContain("recursion depth exceeded");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should protect against mutual recursion", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'function a() { b() } function b() { a() } BEGIN { a() }'`,
      );

      // Must hit our internal limit, not JS stack overflow
      expect(result.stderr).toContain("recursion depth exceeded");
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });
  });

  describe("output size limits", () => {
    it("should limit output from print in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; i<1000000; i++) print "x" }'`,
      );

      // Should hit iteration or output size limit before completing 1M iterations
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("exceeded");
    });

    it("should limit string concatenation growth", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { s="x"; for(i=0; i<30; i++) s=s s; print length(s) }'`,
      );

      // Doubling 30 times would be 2^30 = 1GB, must hit string length limit
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
      expect(result.stderr).toContain("exceeded");
    });

    // awk's output limit is min(maxStringLength, maxOutputSize). Binding it
    // through maxStringLength keeps the shell's total-output check, which
    // also counts the error message, out of the way. "é" is two UTF-8 bytes.
    const printfOnly = `awk 'BEGIN { for (i = 0; i < 50; i++) printf "%s", "é" }'`;
    const printThenPrintf = `awk 'BEGIN { for (i = 0; i < 32; i++) print "é"; printf "%s", "é" }'`;
    // substr() splits "😀" into two lone surrogates, 3 bytes each alone and 4
    // once joined, with an empty write between them. Each half is charged on
    // its own before it is appended, so the last low half needs 3 bytes of
    // room: 39 * 4 + 3 + 3 = 162.
    const splitPairs = `awk 'BEGIN { s = "😀"; for (i = 0; i < 40; i++) { printf "%s", substr(s, 1, 1); printf ""; printf "%s", substr(s, 2, 1) } }'`;
    const overLimit = "awk: formatted string size limit exceeded (1 bytes)\n";
    it.each([
      ["printf at", printfOnly, 100, "é".repeat(50), "", 0],
      ["printf one byte under", printfOnly, 99, "é".repeat(49), overLimit, 126],
      [
        "print then printf at",
        printThenPrintf,
        98,
        `${"é\n".repeat(32)}é`,
        "",
        0,
      ],
      [
        "print then printf one byte under",
        printThenPrintf,
        97,
        "é\n".repeat(32),
        overLimit,
        126,
      ],
      ["split surrogate pairs at", splitPairs, 162, "😀".repeat(40), "", 0],
    ])("counts %s the byte limit in UTF-8 bytes", async (_case, script, limit, stdout, stderr, exitCode) => {
      const env = new Bash({ executionLimits: { maxStringLength: limit } });
      const result = await env.exec(script);
      expect(result.stdout).toBe(stdout);
      expect(result.stderr).toBe(stderr);
      expect(result.exitCode).toBe(exitCode);
    });

    it("keeps the UTF-16 code units passed to utf8ByteLength linear in printf calls", async () => {
      const codeUnitsMeasured = async (count: number): Promise<number> => {
        const env = new Bash();
        const spy = vi.spyOn(encoding, "utf8ByteLength");
        const result = await env.exec(
          `awk 'BEGIN { for (i = 0; i < ${count}; i++) printf "%d\\n", i }'`,
        );
        const measured = spy.mock.calls.reduce(
          (total, [value]) => total + value.length,
          0,
        );
        spy.mockRestore();
        const expected = Array.from({ length: count }, (_, i) => `${i}\n`);
        expect(result.stdout).toBe(expected.join(""));
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        return measured;
      };
      const single = await codeUnitsMeasured(1000);
      const double = await codeUnitsMeasured(2000);
      // Twice the printf calls is about twice the output, so measuring each
      // call's text about doubles the work and re-measuring all earlier
      // output per call about quadruples it.
      expect(double).toBeLessThan(3 * single);
    });
  });

  describe("array limits", () => {
    it("should handle large array creation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { for(i=0; i<100000; i++) a[i]=i; print length(a) }'`,
      );

      // Should complete without hanging
      expect(result.exitCode).toBeDefined();
    });
  });

  describe("getline limits", () => {
    it("should not hang on getline in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '{ while((getline line < "/dev/zero") > 0) print line }'`,
      );

      // Should either error or be handled safely
      expect(result.exitCode).toBeDefined();
    });
  });
});
