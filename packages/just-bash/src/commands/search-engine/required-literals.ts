/**
 * Required literals of a search pattern: substrings every match contains, so
 * a line or file without them can be skipped before the regex engine runs.
 *
 * The analysis is conservative. A construct it does not model either requires
 * nothing or disables the filter for the whole pattern, so a skipped line is
 * never one the regex would match; the filter may only keep lines the regex
 * then rejects.
 */

export interface PreFilter {
  /**
   * Text can match only if it contains every needle of at least one group:
   * the pattern's alternatives, each with the literals it requires.
   */
  groups: string[][];
  /** Needles are lowercase ASCII, and text is case-folded before the check. */
  ignoreCase: boolean;
}

/** Groups a requirement keeps: past it a concatenation keeps one side, and an alternation other than a plain literal list requires nothing. */
// @banned-pattern-ignore: bounds the prefilter analysis; past it the filter requires less and output is unchanged
const MAX_GROUPS = 64;
/** Needles kept per group, the longest first. */
// @banned-pattern-ignore: bounds the prefilter analysis; past it the filter requires less and output is unchanged
const MAX_NEEDLES = 8;
/** Needle prefix kept: a substring scan can cost the text times the needle length. */
// @banned-pattern-ignore: bounds the prefilter's scans; a prefix of a required literal is required too, so output is unchanged
const MAX_NEEDLE_CHARS = 64;
// @banned-pattern-ignore: bounds the prefilter analysis; past it the pattern is scanned without a filter
const MAX_DEPTH = 64;
/** Pattern length analysed; deduplicating long needles costs about its square. */
// @banned-pattern-ignore: bounds the prefilter analysis; past it the pattern is scanned without a filter
const MAX_PATTERN_CHARS = 4096;
/** Group pairs combined per pattern, so the analysis stays within milliseconds. */
// @banned-pattern-ignore: bounds the prefilter analysis; past it the filter requires less and output is unchanged
const MAX_COMBINATIONS = 4096;

/** What part of a pattern requires: alternatives of needle sets. `[[]]` requires nothing. */
type Requirement = string[][];

const NOTHING: Requirement = [[]];

const CONTROL_ESCAPES = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["f", "\f"],
  ["v", "\v"],
]);

/** Escapes of a character class or an assertion: they match no fixed text. */
const CLASS_ESCAPES = "dDwWsSbB";

class UnsupportedPattern extends Error {}

function requiresNothing(requirement: Requirement): boolean {
  return requirement.some((group) => group.length === 0);
}

function capped(group: string[]): string[] {
  const unique = [
    ...new Set(group.map((needle) => needle.slice(0, MAX_NEEDLE_CHARS))),
  ].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const needle of unique) {
    if (kept.length === MAX_NEEDLES) break;
    if (!kept.some((longer) => longer.includes(needle))) kept.push(needle);
  }
  return kept;
}

function distinct(groups: Requirement): Requirement {
  const seen = new Set<string>();
  return groups.filter((group) => {
    // A needle can hold any character, NUL included, so no separator is safe.
    const key = JSON.stringify(group);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function either(left: Requirement, right: Requirement): Requirement {
  if (requiresNothing(left) || requiresNothing(right)) return NOTHING;
  const groups = distinct([...left, ...right]);
  return groups.length > MAX_GROUPS ? NOTHING : groups;
}

type Atom = { literal: string } | { requirement: Requirement };

/** A parsed part of a pattern; `exact` is the one literal it matches, when it matches only that. */
interface Parsed {
  exact: string | null;
  requirement: Requirement;
}

class RequirementParser {
  private position = 0;
  private combinations = 0;

  constructor(private readonly pattern: string) {}

  parse(): Requirement {
    const { requirement } = this.alternation(0);
    // A stray ")" is a syntax error the engine reports; nothing to filter.
    if (this.position < this.pattern.length) throw new UnsupportedPattern();
    return requirement;
  }

  private both(left: Requirement, right: Requirement): Requirement {
    if (requiresNothing(left)) return right;
    if (requiresNothing(right)) return left;
    const product = left.length * right.length;
    this.combinations += product;
    // Each side alone is still required; keep the one with fewer alternatives.
    if (product > MAX_GROUPS || this.combinations > MAX_COMBINATIONS) {
      return left.length <= right.length ? left : right;
    }
    const groups: Requirement = [];
    for (const a of left) {
      for (const b of right) groups.push(capped([...a, ...b]));
    }
    return distinct(groups);
  }

  private alternation(depth: number): Parsed {
    if (depth > MAX_DEPTH) throw new UnsupportedPattern();
    const alternatives = [this.concatenation(depth)];
    while (this.pattern[this.position] === "|") {
      this.position++;
      alternatives.push(this.concatenation(depth));
    }
    if (alternatives.length === 1) return alternatives[0];
    // A list of plain literals requires one of them past the group limit too;
    // the pattern length cap bounds how many.
    if (alternatives.every(({ exact }) => exact)) {
      return {
        exact: null,
        requirement: distinct(alternatives.map(({ exact }) => [exact ?? ""])),
      };
    }
    let requirement = alternatives[0].requirement;
    for (let i = 1; i < alternatives.length; i++) {
      requirement = either(requirement, alternatives[i].requirement);
    }
    return { exact: null, requirement };
  }

  private concatenation(depth: number): Parsed {
    let requirement = NOTHING;
    let exact: string | null = "";
    let run = "";
    const flush = (): void => {
      if (run !== "") requirement = this.both(requirement, [[run]]);
      run = "";
    };
    while (this.position < this.pattern.length) {
      const char = this.pattern[this.position];
      if (char === "|" || char === ")") break;
      const atom = this.atom(depth);
      const minimum = this.quantifier();
      if ("literal" in atom && minimum === null) {
        run += atom.literal;
        if (exact !== null) exact += atom.literal;
        continue;
      }
      exact = null;
      if ("literal" in atom) {
        if (minimum === 0) {
          flush();
        } else {
          // The first repetition follows the run and the last precedes what comes next.
          run += atom.literal;
          flush();
          run = atom.literal;
        }
        continue;
      }
      flush();
      if (minimum === null || minimum > 0) {
        requirement = this.both(requirement, atom.requirement);
      }
    }
    flush();
    return { exact, requirement };
  }

  private atom(depth: number): Atom {
    const char = this.pattern[this.position];
    switch (char) {
      case "(": {
        const group = this.group(depth);
        // A group of one literal joins the literals around it.
        return group.exact === null
          ? { requirement: group.requirement }
          : { literal: group.exact };
      }
      case "[":
        this.characterClass();
        return { requirement: NOTHING };
      case "\\":
        return this.escape();
      case "{":
        // A brace that is not a quantifier reads differently across engines.
        throw new UnsupportedPattern();
      case ".":
      case "^":
      case "$":
      case "]":
      case "}":
      case "*":
      case "+":
      case "?":
        this.position++;
        return { requirement: NOTHING };
      default: {
        // One code point, so a surrogate pair stays whole.
        const literal = String.fromCodePoint(
          this.pattern.codePointAt(this.position) ?? 0,
        );
        this.position += literal.length;
        return { literal };
      }
    }
  }

  private group(depth: number): Parsed {
    this.position++;
    if (this.pattern[this.position] === "?") {
      if (this.pattern[this.position + 1] === ":") {
        this.position += 2;
      } else {
        const name = this.groupName();
        // Inline flags and lookaround change what the group matches.
        if (name === 0) throw new UnsupportedPattern();
        this.position += name;
      }
    }
    const parsed = this.alternation(depth + 1);
    if (this.pattern[this.position] !== ")") throw new UnsupportedPattern();
    this.position++;
    return parsed;
  }

  /** The length of a `?<name>` or `?P<name>` group prefix at the position, or 0. */
  private groupName(): number {
    let index = this.position + 1;
    if (this.pattern[index] === "P") index++;
    if (this.pattern[index] !== "<") return 0;
    index++;
    const start = index;
    while (index < this.pattern.length && isWordChar(this.pattern[index])) {
      index++;
    }
    const first = this.pattern[start];
    if (
      index === start ||
      (first >= "0" && first <= "9") ||
      this.pattern[index] !== ">"
    ) {
      return 0;
    }
    return index + 1 - this.position;
  }

  private characterClass(): void {
    this.position++;
    if (this.pattern[this.position] === "^") this.position++;
    // Engines disagree on whether a leading "]" is a member or closes the class.
    if (this.pattern[this.position] === "]") throw new UnsupportedPattern();
    while (
      this.position < this.pattern.length &&
      this.pattern[this.position] !== "]"
    ) {
      // A nested "[" ([:^digit:], [=a=], [.a.]) can hold the "]" that seems to close the class.
      if (this.pattern[this.position] === "[") throw new UnsupportedPattern();
      this.position += this.pattern[this.position] === "\\" ? 2 : 1;
    }
    if (this.position >= this.pattern.length) throw new UnsupportedPattern();
    this.position++;
  }

  private escape(): Atom {
    const next = this.pattern[this.position + 1];
    if (next === undefined) throw new UnsupportedPattern();
    this.position += 2;
    const control = CONTROL_ESCAPES.get(next);
    if (control !== undefined) return { literal: control };
    if (CLASS_ESCAPES.includes(next)) return { requirement: NOTHING };
    // \x, \u, \p, \c, \0, back-references and the like are not modelled.
    if (isWordChar(next)) throw new UnsupportedPattern();
    return { literal: next };
  }

  /** The minimum count of the quantifier at the position, consumed, or null when none follows. */
  private quantifier(): number | null {
    const char = this.pattern[this.position];
    let minimum: number;
    if (char === "*" || char === "?") {
      this.position++;
      minimum = 0;
    } else if (char === "+") {
      this.position++;
      minimum = 1;
    } else if (char === "{") {
      minimum = this.braces();
    } else {
      return null;
    }
    if (this.pattern[this.position] === "?") this.position++;
    // A doubled or possessive quantifier is not modelled.
    const after = this.pattern[this.position];
    if (after === "*" || after === "+" || after === "?" || after === "{") {
      throw new UnsupportedPattern();
    }
    return minimum;
  }

  /** The minimum of a `{n}`, `{n,}` or `{n,m}` quantifier at the position, consumed. */
  private braces(): number {
    let index = this.position + 1;
    const start = index;
    while (isDigit(this.pattern[index])) index++;
    if (index === start) throw new UnsupportedPattern();
    const minimum = Number(this.pattern.slice(start, index));
    let end = index;
    if (this.pattern[index] === ",") {
      index++;
      end = index;
      while (isDigit(this.pattern[end])) end++;
    }
    // RE2JS reads a count with a leading zero ({01}, {1,02}) as literal text.
    const counts = this.pattern.slice(start, end).split(",");
    if (counts.some((count) => count.length > 1 && count[0] === "0")) {
      throw new UnsupportedPattern();
    }
    index = end;
    if (this.pattern[index] !== "}") throw new UnsupportedPattern();
    this.position = index + 1;
    return minimum;
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isWordChar(char: string): boolean {
  return (
    isDigit(char) ||
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    char === "_"
  );
}

/** The lowercased ASCII runs of a needle. */
function foldedAsciiRuns(needle: string): string[] {
  const runs: string[] = [];
  let run = "";
  for (let index = 0; index < needle.length; index++) {
    const code = needle.charCodeAt(index);
    if (code > 0x7f) {
      if (run !== "") runs.push(run);
      run = "";
    } else {
      run +=
        code >= 0x41 && code <= 0x5a
          ? String.fromCharCode(code + 32)
          : needle[index];
    }
  }
  if (run !== "") runs.push(run);
  return runs;
}

/**
 * The literals a JavaScript-syntax pattern requires, or null when it requires
 * none the analysis can prove.
 *
 * Under ignoreCase only the ASCII runs of needles are kept: RE2 folds some
 * non-ASCII letters (such as ς and σ) that lowercasing does not equate.
 */
export function requiredLiterals(
  pattern: string,
  ignoreCase: boolean,
): PreFilter | null {
  if (pattern.length > MAX_PATTERN_CHARS) return null;
  let requirement: Requirement;
  try {
    requirement = new RequirementParser(pattern).parse();
  } catch (error) {
    if (error instanceof UnsupportedPattern) return null;
    throw error;
  }
  const groups: string[][] = [];
  for (const group of requirement) {
    const needles = ignoreCase ? group.flatMap(foldedAsciiRuns) : group;
    if (needles.length === 0) return null;
    groups.push(capped(needles));
  }
  return groups.length === 0 ? null : { groups: distinct(groups), ignoreCase };
}

/**
 * Case-folds text for ASCII needles as RE2 does: of the non-ASCII letters RE2
 * folds into ASCII, U+212A lowercases to k, but U+017F (ſ) lowercases to
 * itself, so it becomes s.
 */
function foldCase(
  text: string,
  checkpoint?: (force?: boolean) => void,
): string {
  const lower = text.toLowerCase();
  checkpoint?.(true);
  if (!lower.includes("ſ")) return lower;
  checkpoint?.(true);
  return lower.replaceAll("ſ", "s");
}

/**
 * The deadline is checked before a pass over the text once the passes since
 * the last check have scanned `checkEveryChars` characters.
 */
function mayMatch(
  preFilter: PreFilter,
  text: string,
  checkpoint: ((force?: boolean) => void) | undefined,
  checkEveryChars: number,
): boolean {
  let scanned = 0;
  const beforePass = (): void => {
    scanned += text.length;
    if (scanned < checkEveryChars) return;
    checkpoint?.(true);
    scanned = 0;
  };
  beforePass();
  const haystack = preFilter.ignoreCase ? foldCase(text, beforePass) : text;
  const groups = preFilter.groups;
  for (let g = 0; g < groups.length; g++) {
    const needles = groups[g];
    let found = true;
    for (let n = 0; n < needles.length; n++) {
      beforePass();
      if (!haystack.includes(needles[n])) {
        found = false;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}

/** Whether a whole input may match; each pass over it checks the deadline. */
export function preFilterMatches(
  preFilter: PreFilter,
  text: string,
  checkpoint?: (force?: boolean) => void,
): boolean {
  return mayMatch(preFilter, text, checkpoint, 0);
}

/** Whether a line may match; the deadline is checked per 64 Ki characters scanned. */
export function lineMayMatch(
  preFilter: PreFilter,
  line: string,
  checkpoint?: (force?: boolean) => void,
): boolean {
  return mayMatch(preFilter, line, checkpoint, 1 << 16);
}
