// "About this process" (issue #174): plain attributes of a process, worked out from what the page already has. Pure.

import type { ProcessBundle, ProvenanceMap } from "@transpera-flow/db";
import type { FirstPrinciples } from "@transpera-flow/engine";
import { formatPublished } from "@/lib/history/versions";
import { processSteps } from "@/lib/process-steps";

export interface About {
  type: "Pipeline" | "Servicing";
  /** The person who owns most of the first-principles requirements (or the name typed there); null when none is named. */
  owner: string | null;
  steps: number;
  roles: number;
  /** The processes this one sits inside, outermost first (empty: it is at the top of the company map). */
  trail: string[];
  /** The live version, or null when it was never published. */
  version: number | null;
  /** A draft is open beside the live version. */
  draft: boolean;
  /** Sources linked to this process or its steps, or null when the page does not load them. */
  sources: number | null;
  /** Numbers that have a source cited, out of the numbers with a recorded origin. */
  cited: { cited: number; of: number } | null;
  /** When it was last changed and by whom, or null when unknown. */
  lastChange: { at: string; by: string } | null;
}

const isWorking = (k: string) => k === "task" || k === "wait" || k === "decision" || k === "subprocess";

/** Provenance entries cited by a source or measured from data, out of every entry that records an origin. */
export function citedNumbers(maps: readonly (ProvenanceMap | undefined)[]): { cited: number; of: number } | null {
  let of = 0;
  let cited = 0;
  for (const m of maps) {
    for (const p of Object.values(m ?? {})) {
      if (!p || !p.source) continue;
      of++;
      if ((p.evidence?.length ?? 0) > 0 || p.source === "measured") cited++;
    }
  }
  return of === 0 ? null : { cited, of };
}

/** The most common named owner among the requirements, by person (then by typed name). */
export function ownerOf(doc: FirstPrinciples | null, personName: (id: string) => string | null): string | null {
  const count = new Map<string, number>();
  for (const r of doc?.requirements ?? []) {
    const name = r.owner_person_id ? personName(r.owner_person_id) : r.owner_text.trim() || null;
    if (name) count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function aboutProcess(input: {
  bundle: ProcessBundle;
  doc: FirstPrinciples | null;
  trail: readonly string[];
  liveVersion: number;
  hasDraft: boolean;
  sources: number | null;
  lastChange: { at: string | null; by: string } | null;
}): About {
  const all = processSteps(input.bundle);
  const steps = all.filter((s) => isWorking(s.kind) && !s.child_process_id);
  const names = new Map(input.bundle.people.map((p) => [p.id, p.name]));
  const lc = input.lastChange;
  return {
    type: input.bundle.process.kind === "servicing" ? "Servicing" : "Pipeline",
    owner: ownerOf(input.doc, (id) => names.get(id) ?? null),
    steps: steps.length,
    roles: new Set(steps.flatMap((s) => (s.role_id ? [s.role_id] : []))).size,
    trail: [...input.trail],
    version: input.liveVersion > 0 ? input.liveVersion : null,
    draft: input.hasDraft,
    sources: input.sources,
    cited: citedNumbers(all.map((s) => s.provenance)),
    lastChange: lc && lc.at ? { at: lc.at, by: lc.by } : null,
  };
}

/** The attributes as label and value pairs in the order the page shows them, in plain words. */
export function aboutLine(a: About): { label: string; value: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const out: { label: string; value: string }[] = [
    { label: "Type", value: a.type },
    { label: "Owner", value: a.owner ?? "Not named yet" },
    { label: "Size", value: `${plural(a.steps, "step", "steps")}, ${plural(a.roles, "role", "roles")}` },
    { label: "On the company map", value: a.trail.length ? `Inside ${a.trail.join(" › ")}` : "Top level" },
    { label: "Version", value: `${a.version === null ? "Not published yet" : `Live is version ${a.version}`}${a.draft ? ", draft open" : ""}` },
  ];
  if (a.sources !== null) {
    out.push({
      label: "Sources",
      value: a.sources === 0 ? "None linked" : `${plural(a.sources, "source", "sources")}${a.cited ? `, ${Math.round((a.cited.cited / a.cited.of) * 100)}% of numbers cited` : ""}`,
    });
  }
  out.push({ label: "Last changed", value: a.lastChange ? `${formatPublished(a.lastChange.at)} by ${a.lastChange.by}` : "No changes recorded" });
  return out;
}
