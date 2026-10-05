// Small helpers the `transpera-process` checkers share (process-file.ts for /1 and /2, process-file-2.ts for what /2 adds).
// Pure; no I/O.

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A name or id in quotes, cut when it is absurdly long so a message stays readable. */
export const q = (s: string) => `'${s.length > 60 ? `${s.slice(0, 57)}...` : s}'`;

/** A name as compared: lower case, "&" as "and", no punctuation, single spaces. */
export const norm = (s: string) => s.trim().toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const round = (n: number) => Math.round(n * 1000) / 1000;

/** The Levenshtein distance between two strings (for "did you mean"). */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length]!;
}

/** Typo suggestions are a courtesy: only the first few unknown references get one, so a hostile file can't make the checker slow. */
export const MAX_SUGGESTIONS = 20;
/** Step ids are short labels ("review"); anything longer is a mistake, and checking it for typos would cost time. */
export const MAX_ID = 64;

/**
 * The id closest to `ref`, when it is near enough to be a typo. Bounded: ids and references longer than MAX_ID get none, ids
 * whose length can't be close enough are skipped without comparing, and `budget` limits how many suggestions a file can ask for.
 */
export function suggest(ref: string, ids: readonly string[], budget: { left: number }): string | null {
  if (ref.length > MAX_ID || budget.left <= 0) return null;
  budget.left--;
  const limit = Math.max(1, Math.floor(ref.length / 3));
  let best: { id: string; d: number } | null = null;
  for (const id of ids) {
    if (id.length > MAX_ID || Math.abs(id.length - ref.length) > limit) continue;
    const d = distance(ref.toLowerCase(), id.toLowerCase());
    if (!best || d < best.d) best = { id, d };
  }
  return best && best.d <= limit ? best.id : null;
}
