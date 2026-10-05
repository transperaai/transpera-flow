// The run's facts as a short digest (issue #175, B17), the second half of an analysis's `model_hash`. Pure and free of
// Node, because the pages compute it in the browser from the facts they show, and the server from the facts it gave AI.
//
// Only what AI analysis is given counts: the rule facts. Perception gaps and broken scenarios (the process page's own) and
// the forecast's "too busy, and when" (the Overview's own) are left out, so a page and the server digest the same list.
// Each fact counts by its key and rating: a fact appearing, going or changing rating changes the digest; its wording and
// cost (which a page may fill in later, once the shadow-price run is in) don't.

type FactLike = { key: string; rating: string; type: string };

/** Whether a page's fact is one AI analysis is given. */
export const isAnalysedFact = (f: FactLike): boolean => f.type !== "perception_gap" && f.type !== "broken_scenario" && !f.key.startsWith("forecast:");

/** 32-bit FNV-1a of `text` from `seed`, as 8 hex digits. */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The digest of the facts AI analysis is given, in any order: 32 hex digits. */
export function factsDigest(facts: readonly FactLike[]): string {
  const text = facts
    .filter(isAnalysedFact)
    .map((f) => `${f.key}|${f.rating}`)
    .sort()
    .join("\n");
  return [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => fnv(text, seed)).join("");
}

/** What an analysis stores as `model_hash`: what it read, then the facts. */
export const joinAnalysisHash = (base: string, facts: string): string => `${base}.${facts}`;

/** Whether the run's facts differ from those a stored analysis read (false until the facts are in, or with no hash). */
export function factsChanged(modelHash: string | null | undefined, facts: readonly FactLike[] | null): boolean {
  const stored = modelHash?.split(".")[1];
  return Boolean(stored && facts && factsDigest(facts) !== stored);
}

/**
 * Whether a stored analysis is out of date (B17). With a hash: what it read differs from what the page has now (the base,
 * worked out on the server), or the facts do (once the page's run is in; until then only the base counts). Without one
 * (an analysis from before B17), a process's analysis is out of date once it is of another version.
 */
export function isStale(
  view: { modelHash?: string | null; revisionId: string } | null,
  now: { base: string | null; facts?: string | null; revisionId: string | null },
): boolean {
  if (!view) return false;
  const [base, facts] = (view.modelHash ?? "").split(".");
  if (base && now.base) return base !== now.base || Boolean(facts && now.facts && facts !== now.facts);
  return now.revisionId !== null && view.revisionId !== now.revisionId;
}
