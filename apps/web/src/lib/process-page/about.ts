// "About this process" (issue #174): plain attributes of a process, worked out from what the page already has. Pure.

import type { EdgeRow, ProcessBundle, ProvenanceMap, StepRow } from "@transpera-flow/db";
import type { FirstPrinciples } from "@transpera-flow/engine";
import { formatPublished } from "@/lib/history/versions";
import { processSteps } from "@/lib/process-steps";
import { namedForViewer, viewerOf } from "@/lib/viewer";

export interface About {
  type: "Pipeline" | "Servicing";
  /** Who owns the first-principles requirements (the one named most, both when tied, "Shared" when more tie); null when none is named. */
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
  /** Step numbers with a source cited or measured data behind them, out of every step number (see `citedNumbers`). */
  cited: { cited: number; of: number } | null;
  /** When the live version was last published and by whom, or null when unknown. */
  lastChange: { at: string; by: string } | null;
}

const isWorking = (k: string) => k === "task" || k === "wait" || k === "decision" || k === "subprocess";

/** The numbers a step carries that the simulation uses and a source can back: its hands-on time, its wait and its rework rate. */
const STEP_NUMBERS = ["work_hours", "wait_hours", "rework_rate"] as const;

const isCited = (p: ProvenanceMap[string]) => !!p && ((p.evidence?.length ?? 0) > 0 || p.source === "measured");

/**
 * Step numbers cited, out of all of them. Every working step counts its hands-on time, wait and rework rate, and a step with
 * two or more ways out counts its branch odds once, whether or not anything records where those numbers came from. A number
 * is cited when a source is cited for it or it was measured from data. Null when there are no steps to count.
 */
export function citedNumbers(steps: readonly Pick<StepRow, "id" | "kind" | "child_process_id" | "provenance">[], edges: readonly Pick<EdgeRow, "from_step_id">[]): { cited: number; of: number } | null {
  const working = steps.filter((s) => isWorking(s.kind) && !s.child_process_id);
  const fanOut = new Map<string, number>();
  for (const e of edges) fanOut.set(e.from_step_id, (fanOut.get(e.from_step_id) ?? 0) + 1);
  let of = 0;
  let cited = 0;
  for (const s of working) {
    for (const col of STEP_NUMBERS) {
      of++;
      if (isCited(s.provenance?.[col])) cited++;
    }
    if ((fanOut.get(s.id) ?? 0) >= 2) {
      of++;
      if (isCited(s.provenance?.branch_odds)) cited++;
    }
  }
  return of === 0 ? null : { cited, of };
}

/** The named owner of most first-principles requirements: both when two tie, "Shared" when more. A person in People, else the name typed. */
export function ownerOf(doc: FirstPrinciples | null, personName: (id: string) => string | null): string | null {
  const count = new Map<string, number>();
  for (const r of doc?.requirements ?? []) {
    const name = r.owner_person_id ? personName(r.owner_person_id) : r.owner_text.trim() || null;
    if (name) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return null;
  const tied = ranked.filter(([, n]) => n === ranked[0]![1]).map(([name]) => name);
  return tied.length === 1 ? tied[0]! : tied.length === 2 ? `${tied[0]} and ${tied[1]}` : "Shared";
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
  const names = new Map(namedForViewer(viewerOf(input.bundle), input.bundle.people).map((p) => [p.id, p.name]));
  const lc = input.lastChange;
  const edges = [...input.bundle.edges, ...(input.bundle.otherProcesses ?? []).flatMap((o) => o.edges)];
  return {
    type: input.bundle.process.kind === "servicing" ? "Servicing" : "Pipeline",
    owner: ownerOf(input.doc, (id) => names.get(id) ?? null),
    steps: steps.length,
    roles: new Set(steps.flatMap((s) => (s.role_id ? [s.role_id] : []))).size,
    trail: [...input.trail],
    version: input.liveVersion > 0 ? input.liveVersion : null,
    draft: input.hasDraft,
    sources: input.sources,
    cited: citedNumbers(all, edges),
    lastChange: lc && lc.at ? { at: lc.at, by: lc.by } : null,
  };
}

/** The attributes as label and value pairs in the order the page shows them, in plain words. */
export function aboutLine(a: About): { label: string; value: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const out: { label: string; value: string }[] = [
    { label: "Type", value: a.type },
    { label: "Requirements owner", value: a.owner ?? "Not named yet" },
    { label: "Size", value: `${plural(a.steps, "step", "steps")}, ${plural(a.roles, "role", "roles")}` },
    { label: "On the company map", value: a.trail.length ? `Inside ${a.trail.join(" › ")}` : "Top level" },
    { label: "Version", value: `${a.version === null ? "Not published yet" : `Live is version ${a.version}`}${a.draft ? ", draft open" : ""}` },
  ];
  if (a.sources !== null) {
    out.push({
      label: "Sources",
      value: `${a.sources === 0 ? "None linked" : plural(a.sources, "source", "sources")}${a.cited ? `, ${a.cited.cited} of ${a.cited.of} step numbers cited` : ""}`,
    });
  }
  out.push({
    label: "Last published",
    value: a.version === null ? "Not published yet" : a.lastChange ? `${formatPublished(a.lastChange.at)} by ${a.lastChange.by}` : "Not recorded",
  });
  return out;
}
