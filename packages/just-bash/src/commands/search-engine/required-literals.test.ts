import { describe, expect, it } from "vitest";
import {
  lineMayMatch,
  type PreFilter,
  preFilterMatches,
  requiredLiterals,
} from "./required-literals.js";

const groups = (pattern: string, ignoreCase = false) =>
  requiredLiterals(pattern, ignoreCase)?.groups ?? null;

describe("requiredLiterals", () => {
  it("requires every literal of a concatenation broken by .*", () => {
    expect(groups("product.*update")).toEqual([["product", "update"]]);
  });

  it("keeps the literals adjacent to a repeated one", () => {
    // ab+c matches abc, abbc, ...: each contains "ab" and "bc".
    expect(groups("ab+c")).toEqual([["ab", "bc"]]);
    expect(groups("abc{2,3}def")).toEqual([["cdef", "abc"]]);
  });

  it("requires nothing of an optional part", () => {
    expect(groups("(foo)?barbaz")).toEqual([["barbaz"]]);
    expect(groups("x{0}y")).toEqual([["y"]]);
    expect(groups("(?:abc)*defgh")).toEqual([["defgh"]]);
  });

  it("distributes nested alternatives over what follows them", () => {
    expect(groups("((a|b)c|d)e")).toEqual([
      ["a", "c", "e"],
      ["b", "c", "e"],
      ["d", "e"],
    ]);
  });

  it("keeps one side of a product that would pass the group limit", () => {
    // 2^7 = 128 alternatives exceed the limit; the last factor alone still holds.
    expect(groups("(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)")).toEqual([
      ["m"],
      ["n"],
    ]);
  });

  it("keeps every alternative of a long alternation", () => {
    const many = Array.from({ length: 65 }, (_, i) => `word${i}`);
    expect(groups(many.map((word) => `${word}.x`).join("|"))).toEqual(
      many.map((word) => [word, "x"]),
    );
    expect(groups(many.map((word) => `^${word}`).join("|"))).toEqual(
      many.map((word) => [word]),
    );
    expect(groups(`${many.join("|")}|.+`)).toBeNull();
  });

  it("keeps every literal of a plain literal list past the group limit", () => {
    const words = Array.from({ length: 65 }, (_, i) => `word${i}`);
    expect(groups(words.join("|"))).toEqual(words.map((word) => [word]));
    // Inside the wrappers -w and -x add, and inside a group.
    for (const wrapped of [
      `\\b(?:${words.join("|")})\\b`,
      `^(?:${words.join("|")})$`,
      `(${words.join("|")})`,
    ]) {
      expect(groups(wrapped)).toEqual(words.map((word) => [word]));
    }
    expect(groups(`${words.join("|")}|`)).toBeNull();
  });

  it("keeps one side once the analysis has combined its share of groups", () => {
    const alternatives = Array.from({ length: 64 }, (_, i) => `z${i}`);
    const pattern = `a.b.(?:${alternatives.join("|")})${".x".repeat(1850)}`;
    expect(groups(pattern)).toEqual([["x"]]);
  });

  it("decodes escaped symbols, named groups and surrogate pairs", () => {
    expect(groups("a\\|b")).toEqual([["a|b"]]);
    expect(groups("(?<name>foo)\\.bar")).toEqual([["foo.bar"]]);
    expect(groups("😀x")).toEqual([["😀x"]]);
  });

  it("gives up on constructs whose meaning it does not model", () => {
    for (const pattern of [
      "(?i)foo",
      "foo(?=bar)",
      "foo(?<!bar)",
      "a{x}",
      "a{,3}b",
      "ab{01}cd",
      "ab{1,02}cd",
      "[[:^digit:]x]foo",
      "[a[b]cd",
      "[]a]bc",
      "[^]a]bc",
      "\\x41bc",
      "\\p{L}bc",
      "(foo)\\1",
      "foo)",
      "(foo",
      "[abc",
    ]) {
      expect(requiredLiterals(pattern, false), pattern).toBeNull();
    }
  });

  it("keeps alternatives apart that differ only in where a NUL splits them", () => {
    expect(groups("foo\0bar|foo.*bar")).toEqual([["foo\0bar"], ["foo", "bar"]]);
  });

  it("leaves a pattern too long to analyse cheaply unfiltered", () => {
    expect(groups("a".repeat(1 << 16))).toEqual([["a".repeat(64)]]);
    expect(groups("a".repeat((1 << 16) + 1))).toBeNull();
  });

  it("gives up on deep nesting instead of recursing without bound", () => {
    expect(groups(`${"(".repeat(64)}ab${")".repeat(64)}`)).toEqual([["ab"]]);
    expect(groups(`${"(".repeat(65)}ab${")".repeat(65)}`)).toBeNull();
  });

  it("keeps the ASCII runs of needles under ignoreCase", () => {
    expect(requiredLiterals("Über|FOO", true)).toEqual({
      groups: [["ber"], ["foo"]],
      ignoreCase: true,
    });
    expect(requiredLiterals("σίγμα", true)).toBeNull();
  });

  it("keeps non-ASCII needles when case matters", () => {
    expect(groups("straße")).toEqual([["straße"]]);
  });
});

describe("preFilterMatches", () => {
  it("needs every needle of one group", () => {
    const preFilter = { groups: [["product", "update"]], ignoreCase: false };
    expect(preFilterMatches(preFilter, "update the product")).toBe(true);
    expect(preFilterMatches(preFilter, "product only")).toBe(false);
  });

  it("matches when any group is complete", () => {
    const preFilter = {
      groups: [["alpha"], ["beta", "gamma"]],
      ignoreCase: false,
    };
    expect(preFilterMatches(preFilter, "gamma beta")).toBe(true);
    expect(preFilterMatches(preFilter, "beta delta")).toBe(false);
  });

  it("folds case as RE2 does, including the long s and the Kelvin sign", () => {
    // RE2 matches /sap/i in "ſap" and /kelvin/i in "Kelvin" (U+212A).
    const preFilter = { groups: [["sap"], ["kelvin"]], ignoreCase: true };
    expect(preFilterMatches(preFilter, "ſAP")).toBe(true);
    expect(preFilterMatches(preFilter, "Kelvin")).toBe(true);
    expect(preFilterMatches(preFilter, "SA P")).toBe(false);
  });
});

describe("lineMayMatch", () => {
  const checks = (preFilter: PreFilter, line: string) => {
    const calls: (boolean | undefined)[] = [];
    lineMayMatch(preFilter, line, (force) => calls.push(force));
    return calls;
  };

  it("checks the deadline once the needle scans of a line add up to 64 Ki characters", () => {
    const many: PreFilter = {
      groups: Array.from({ length: 100 }, (_, i) => [`zq${i}`]),
      ignoreCase: false,
    };
    // 101 passes over 1,000 characters: one check.
    expect(checks(many, "a".repeat(1000))).toEqual([true]);
    expect(checks(many, "a".repeat(100))).toEqual([]);
    // A short line still counts one probe per needle.
    const huge: PreFilter = {
      groups: Array.from({ length: 1 << 15 }, (_, i) => [`q${i}`]),
      ignoreCase: false,
    };
    expect(checks(huge, "aa")).toEqual([true]);
  });

  it("rejects a line shorter than every group without scanning it", () => {
    const filter: PreFilter = {
      groups: [["abcd", "x"], ["zz"]],
      ignoreCase: false,
    };
    expect(lineMayMatch(filter, "z")).toBe(false);
    expect(lineMayMatch(filter, "zz")).toBe(true);
    // 32,768 needles of two or more characters: no probe of a one-character line.
    const huge: PreFilter = {
      groups: Array.from({ length: 1 << 15 }, (_, i) => [`q${i}`]),
      ignoreCase: false,
    };
    expect(checks(huge, "a")).toEqual([]);
  });

  it("checks the deadline before every scan of a 64 Ki line", () => {
    const two: PreFilter = { groups: [["zq"], ["zr"]], ignoreCase: false };
    expect(checks(two, "a".repeat(1 << 16))).toEqual([true, true, true]);
  });
});
