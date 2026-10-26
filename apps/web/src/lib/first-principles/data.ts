import "server-only";
import { firstPrinciplesDiffer, loadFirstPrinciplesFor, type ResolvedFirstPrinciples } from "@transpera-flow/db";
import type { FirstPrinciples } from "@transpera-flow/engine";
import { getDb } from "@/lib/auth/session";

/**
 * The first principles of some revisions of a process (RLS: every member reads), each its own row or the nearest
 * earlier one. If they can't be read (say the table isn't there yet) every revision reads as "not started" rather
 * than breaking the page.
 */
export async function loadProcessFirstPrinciples(processId: string, revisionIds: readonly string[]): Promise<Record<string, ResolvedFirstPrinciples>> {
  try {
    return await loadFirstPrinciplesFor(await getDb(), processId, revisionIds);
  } catch (err) {
    console.error("Couldn't load the first principles; showing none.", err instanceof Error ? err.message : err);
    return Object.fromEntries(revisionIds.map((id) => [id, { doc: null, version: null, inheritedFrom: null }]));
  }
}

/** The live version's first principles, which rule 11 (goals met) reads on every page that rates a run; null when there are none. */
export async function loadLiveFirstPrinciples(processId: string, liveRevisionId: string): Promise<FirstPrinciples | null> {
  return (await loadProcessFirstPrinciples(processId, [liveRevisionId]))[liveRevisionId]!.doc;
}

/**
 * Whether the draft's first principles differ from live's (own or inherited): a change to publish, which the Editor
 * counts beside the steps and edges, so answers saved only to first principles can still be published.
 */
export async function firstPrinciplesDraftChanged(processId: string, liveRevisionId: string, draftRevisionId: string | null): Promise<boolean> {
  if (!draftRevisionId) return false;
  const both = await loadProcessFirstPrinciples(processId, [liveRevisionId, draftRevisionId]);
  return firstPrinciplesDiffer(both[liveRevisionId]!, both[draftRevisionId]!);
}
