// Finding and replacing what a share link hides in text (issue #32, B3): emails, client names, people's names, money. Pure.
//
// Text is matched on a NORMALISED VIEW of it, never as written: Unicode NFKC (a no-break space or a ligature becomes its plain
// form), invisible format characters removed (zero-width space, soft hyphen, bidi marks), curly quotes and apostrophes and the
// hyphen variants straightened, every run of white space (and a JSON `\n`, `\t` or ` ` escape written as text) one space.
// Names are normalised the same way, so a name in any of those forms is found. A match is mapped back to the span of the
// ORIGINAL text it came from, and the whole span is replaced, so no half of a name is left behind. The database applies the same
// rules in `private.share_snapshot_problem` (migration 20261218000000).

/** The normalised text, and for each of its characters the span of the original text it stands for. */
export interface View {
  n: string;
  starts: number[];
  ends: number[];
}

const FORMAT = /[\p{Cf}­]/u;
const SPACE = /\s/u;
const QUOTES: Record<string, string> = { "’": "'", "‘": "'", "ʼ": "'", "′": "'", "`": "'", "´": "'", "“": '"', "”": '"' };
const HYPHENS = /[‐‑‒–—−]/u;
const ESCAPE = /^\\(?:[nrtbf]|u[0-9a-fA-F]{4})/;

export function normaliseView(s: string): View {
  const n: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  const space = (from: number, to: number) => {
    // A run of white space is one space, standing for the whole run.
    if (n.length && n[n.length - 1] === " ") ends[ends.length - 1] = to;
    else {
      n.push(" ");
      starts.push(from);
      ends.push(to);
    }
  };
  while (i < s.length) {
    const esc = s[i] === "\\" ? ESCAPE.exec(s.slice(i, i + 6)) : null;
    if (esc) {
      space(i, i + esc[0].length);
      i += esc[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    for (const c of ch.normalize("NFKC")) {
      if (FORMAT.test(c)) continue;
      if (SPACE.test(c)) space(i, i + len);
      else {
        n.push(QUOTES[c] ?? (HYPHENS.test(c) ? "-" : c));
        starts.push(i);
        ends.push(i + len);
      }
    }
    i += len;
  }
  return { n: n.join(""), starts, ends };
}

/** A name as words in the normalised view (lower case is left to the regex's `i` flag). */
export const wordsOf = (name: string): string[] => normaliseView(name).n.trim().split(" ").filter(Boolean);

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BEFORE = "(?<![\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";

/**
 * The words as a whole-word pattern: one space between them, or none (a zero-width space between two words is removed from
 * the view and leaves them joined; matching "PriyaShah" too only ever hides more).
 */
export const wholeWords = (words: readonly string[], flags: string): RegExp => new RegExp(`${BEFORE}${words.map(escapeRe).join(" ?")}${AFTER}`, flags);

/** An email address: the part before the @ ends in a letter, digit or one of _ % + - (so `roles.@busiest`, a scenario selector, is not one). */
export const EMAIL = /[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}/giu;

export interface Span {
  start: number;
  end: number;
  label: string;
}

/** The spans of `view` matched by `res`, each mapped to its span in the original text. */
export function spansOf(view: View, items: readonly { re: RegExp; label: string }[]): Span[] {
  const out: Span[] = [];
  for (const { re, label } of items) {
    re.lastIndex = 0;
    for (const m of view.n.matchAll(re)) {
      if (!m[0]) continue;
      out.push({ start: view.starts[m.index]!, end: view.ends[m.index + m[0].length - 1]!, label });
    }
  }
  return out;
}

/** Non-overlapping spans: the earliest first, and the longest of those that start together. */
export function pickSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Span[] = [];
  let last = -1;
  for (const s of sorted) {
    if (s.start >= last) {
      out.push(s);
      last = s.end;
    }
  }
  return out;
}

/** `text` with each span replaced by its label. */
export function replaceSpans(text: string, spans: readonly Span[]): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + s.label;
    at = s.end;
  }
  return out + text.slice(at);
}
