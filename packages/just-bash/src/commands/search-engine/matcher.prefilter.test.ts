import { describe, expect, it } from "vitest";
import { searchContent } from "./matcher.js";
import { buildRegex, type PreFilter } from "./regex.js";

describe("required-literal prefilter", () => {
  // Lines RE2 matches that an unsound requirement would skip. Each is also
  // searched alone, so another line cannot pass the whole-input check for it.
  const lines = [
    "afoo",
    "ab{01}cd",
    "ab{1,02}cd",
    "fooxbar",
    "foo\0bar",
    "ſnow white",
    "GROẞ UMSTADT",
    "Rücksendepflicht",
    "update the product",
    "é\\/x",
    "é\\x01",
  ];

  it.each([
    ["[[:^digit:]x]foo", "extended", false],
    ["ab{01}cd", "extended", false],
    ["ab{1,02}cd", "extended", false],
    ["foo\0bar|foo.*bar", "extended", false],
    ["snow.?white", "extended", true],
    ["groß.?umstadt", "extended", true],
    ["rücksend|garantie", "extended", true],
    ["product.*update|update.*product", "extended", false],
    ["ab\\{1,02\\}cd", "basic", false],
    ["é\\/x", "extended", false],
    ["(é\\\\cA)", "extended", false],
    [
      `${Array.from({ length: 70 }, (_, i) => `zq${i}`).join("|")}|groẞ`,
      "extended",
      true,
    ],
  ] as const)("prints what RE2 alone prints for %s", (pattern, mode, ignoreCase) => {
    const { regex, preFilter } = buildRegex(pattern, { mode, ignoreCase });
    for (const content of [...lines, lines.join("\n")]) {
      const unfiltered = searchContent(content, regex, {});
      expect(searchContent(content, regex, { preFilter }), content).toEqual(
        unfiltered,
      );
    }
    expect(searchContent(lines.join("\n"), regex, {}).matched).toBe(true);
  });
});

describe("whole-input prefilter deadline", () => {
  it.each([
    false,
    true,
  ])("checks the deadline before each whole-input scan (multiline: %s)", (multiline) => {
    const { regex } = buildRegex("zq", { mode: "basic" });
    const preFilter: PreFilter = {
      groups: [["zq"], ["zr"], ["zs"]],
      ignoreCase: false,
    };
    const calls: (boolean | undefined)[] = [];
    searchContent("a\nb\n", regex, {
      multiline,
      preFilter,
      checkpoint: (force) => calls.push(force),
    });

    // One up front, then one per needle.
    expect(calls).toEqual([true, true, true, true]);
  });

  it("checks the deadline before each needle scan of a long line", () => {
    const { regex } = buildRegex("zq", { mode: "basic" });
    const preFilter: PreFilter = {
      groups: [["zq"], ["zr"]],
      ignoreCase: false,
    };
    const calls: (boolean | undefined)[] = [];
    searchContent(`${"a".repeat(1 << 16)}zr\nb\n`, regex, {
      preFilter,
      checkpoint: (force) => calls.push(force),
    });

    // Three passes over the whole input, then three over the long line.
    expect(calls.filter(Boolean)).toHaveLength(6);
  });

  it("checks the deadline between the case-folding passes", () => {
    const { regex } = buildRegex("zq", { mode: "basic", ignoreCase: true });
    const preFilter: PreFilter = { groups: [["zq"]], ignoreCase: true };
    const calls: (boolean | undefined)[] = [];
    searchContent("aſ\nb\n", regex, {
      preFilter,
      checkpoint: (force) => calls.push(force),
    });

    // Before lowercasing, the long-s search, the replacement and the needle.
    expect(calls).toEqual([true, true, true, true]);
  });
});
