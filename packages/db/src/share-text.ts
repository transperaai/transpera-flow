// Finding and replacing what a share link hides in text (issue #32, B3): emails, money, and people's and clients' names. Pure.
//
// Text is matched on a NORMALISED VIEW of it, never as written:
//   1. best-effort percent-decoding (`priya%20shah` is "priya shah"),
//   2. Unicode NFKC (a no-break space or a full-width letter becomes its plain form),
//   3. every default-ignorable code point (zero-width space and joiners, soft hyphen, combining grapheme joiner, variation
//      selectors, Hangul fillers), every combining mark and every format character removed,
//   4. curly quotes and the hyphen variants straightened, casefolded,
//   5. every run of white space (and a JSON `\n`, `\t` or ` ` escape written as text) one space.
// Names are matched as TOKENS of that view: its runs of letters (`\p{L}+`). A token that equals any part (3+ characters) of any
// person's or client's name is replaced, and the whole original span with it, separators included; a run of tokens of one
// name joined by a few non-letters ("priya-shah", "priya (shah") is one span. A name token can't survive next to a label,
// whatever sat between the words. A match is mapped back to the span of the ORIGINAL text, so nothing of it is left behind.
// The database applies the same rules in `private.share_snapshot_problem` (migration 20261218000000).

/** The normalised text, and for each of its characters the span of the original text it stands for. */
export interface View {
  n: string;
  starts: number[];
  ends: number[];
}

const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{M}\p{Cf}]/u;
const SPACE = /\s/u;
const QUOTES: Record<string, string> = { "’": "'", "‘": "'", "ʼ": "'", "′": "'", "`": "'", "´": "'", "“": '"', "”": '"' };
const HYPHENS = /[‐‑‒–—−]/u;
const ESCAPE = /^\\(?:[nrtbf]|u[0-9a-fA-F]{4})/;
const PERCENT_RUN = /^(?:%[0-9a-fA-F]{2})+/;

/** One character of the text with the span of the original it came from (after percent-decoding, a decoded run shares one span). */
interface Piece {
  ch: string;
  start: number;
  end: number;
}

function pieces(s: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < s.length) {
    const run = s[i] === "%" ? PERCENT_RUN.exec(s.slice(i, i + 3 * 64)) : null;
    if (run) {
      const bytes = run[0].split("%").slice(1).map((h) => parseInt(h, 16));
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        text = null;
      }
      if (text !== null) {
        for (const ch of text) out.push({ ch, start: i, end: i + run[0].length });
        i += run[0].length;
        continue;
      }
      // Not valid UTF-8 as a whole: a lone `%20` or `%40` still decodes, anything else stays as written.
      const one = parseInt(run[0].slice(1, 3), 16);
      if (one < 0x80) {
        out.push({ ch: String.fromCharCode(one), start: i, end: i + 3 });
        i += 3;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push({ ch, start: i, end: i + ch.length });
    i += ch.length;
  }
  return out;
}

export function normaliseView(s: string): View {
  const n: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const space = (from: number, to: number) => {
    // A run of white space is one space, standing for the whole run.
    if (n.length && n[n.length - 1] === " ") ends[ends.length - 1] = to;
    else {
      n.push(" ");
      starts.push(from);
      ends.push(to);
    }
  };
  const all = pieces(s);
  for (let k = 0; k < all.length; k++) {
    const p = all[k]!;
    // A JSON escape written out as text (a backslash and a letter) is a separator, not part of the next word.
    if (p.ch === "\\") {
      const tail = all.slice(k, k + 6).map((x) => x.ch).join("");
      const esc = ESCAPE.exec(tail);
      if (esc) {
        const last = all[k + esc[0].length - 1]!;
        space(p.start, last.end);
        k += esc[0].length - 1;
        continue;
      }
    }
    for (const c of p.ch.normalize("NFKC")) {
      if (IGNORABLE.test(c)) continue;
      if (SPACE.test(c)) {
        space(p.start, p.end);
        continue;
      }
      for (const lower of (QUOTES[c] ?? (HYPHENS.test(c) ? "-" : c)).toLowerCase()) {
        n.push(lower);
        starts.push(p.start);
        ends.push(p.end);
      }
    }
  }
  return { n: n.join(""), starts, ends };
}

/** The letter tokens of a view: where each starts and ends in `view.n`. */
export interface Token {
  text: string;
  from: number;
  to: number;
}
export function tokens(view: View): Token[] {
  return [...view.n.matchAll(/\p{L}+/gu)].map((m) => ({ text: m[0], from: m.index, to: m.index + m[0].length }));
}

/** The tokens of a name (any case, any separators), as they would be found in text. */
export const nameParts = (name: string): string[] => tokens(normaliseView(name)).map((t) => t.text);

/** The words of the labels a share link writes ("Team member 3", "a client", "[email hidden]"): never a name token. */
const LABEL_WORDS = new Set(["team", "member", "client", "hidden", "email", "amount"]);
/** Words that are no part of anyone's identity ("The Smith Group Ltd"). */
const STOP_WORDS = new Set(["the", "and", "for", "ltd", "inc", "llc", "plc"]);
export const MIN_TOKEN = 3;

/** What a name token stands for: who owns it (their labels), and whether it came from people or clients. */
export interface NameToken {
  /** The labels of everyone whose name holds the token. */
  labels: ReadonlySet<string>;
  people: boolean;
  clients: boolean;
  /** A part of a name under 3 characters ("o" in "Ann O'Neil"): never matched alone, but carried along in a run with the rest. */
  glue: boolean;
}

/**
 * Every token of every name (3+ characters) with the labels of its owners. The joined form of a name's words and of any run of
 * them ("priyashah": what is left when a zero-width space or a Hangul filler sat between them) counts too. Parts under 3
 * characters are glue.
 */
export function nameTokenIndex(groups: readonly { kind: "person" | "client"; entries: readonly { name: string; label: string }[] }[]): Map<string, NameToken> {
  const out = new Map<string, { labels: Set<string>; people: boolean; clients: boolean; glue: boolean }>();
  const add = (tok: string, label: string, kind: "person" | "client") => {
    if (LABEL_WORDS.has(tok) || STOP_WORDS.has(tok)) return;
    const glue = tok.length < MIN_TOKEN;
    const o = out.get(tok) ?? { labels: new Set<string>(), people: false, clients: false, glue };
    o.labels.add(label);
    if (kind === "person") o.people = true;
    else o.clients = true;
    o.glue = o.glue && glue;
    out.set(tok, o);
  };
  for (const g of groups) {
    for (const e of g.entries) {
      const parts = nameParts(e.name).filter((p) => !STOP_WORDS.has(p));
      // A name of one short word ("Li") is no name: nothing to match.
      if (parts.join("").length < MIN_TOKEN) continue;
      for (let a = 0; a < parts.length; a++) {
        for (let b = a; b < parts.length; b++) add(parts.slice(a, b + 1).join(""), e.label, g.kind);
      }
    }
  }
  return out;
}

export interface Span {
  start: number;
  end: number;
  label: string;
}

/**
 * The spans of the original text that hold a name token, a run of tokens that share an owner (at most three non-letters
 * between: "priya-shah", "priya.shah", "priya (shah", "O'Neil") as one span. The label is the one owner's, or "a team member"
 * (people) or "a client" when the run fits several. `use` says which tokens count (clients always, people when People is off).
 */
export function nameSpans(view: View, index: ReadonlyMap<string, NameToken>, use: (t: NameToken) => boolean): Span[] {
  const hits = tokens(view)
    .map((t) => ({ t, name: index.get(t.text) }))
    .filter((h): h is { t: Token; name: NameToken } => !!h.name && use(h.name));
  const runs: { first: Token; last: Token; labels: Set<string>; people: boolean; solid: boolean }[] = [];
  for (const h of hits) {
    const run = runs[runs.length - 1];
    const shared = run ? [...run.labels].filter((l) => h.name.labels.has(l)) : [];
    if (run && shared.length && h.t.from - run.last.to <= 3 && !/\p{L}/u.test(view.n.slice(run.last.to, h.t.from))) {
      run.last = h.t;
      run.labels = new Set(shared);
      run.solid = run.solid || !h.name.glue;
    } else runs.push({ first: h.t, last: h.t, labels: new Set(h.name.labels), people: h.name.people, solid: !h.name.glue });
  }
  return runs
    .filter((r) => r.solid)
    .map((r) => ({ start: view.starts[r.first.from]!, end: view.ends[r.last.to - 1]!, label: r.labels.size === 1 ? [...r.labels][0]! : r.people ? "a team member" : "a client" }));
}

/** An email address: the part before the @ ends in a letter, digit or one of _ % + - (so `roles.@busiest`, a scenario selector, is not one). */
export const EMAIL = /[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}/giu;

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
