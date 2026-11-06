// "What it changes" on the Solution page (Q12, D44): plain lines from the step diff between the live map (the version the solution was
// copied from) and the solution's copy: steps added, removed, merged or changed, and routes whose odds were changed. Pure.

import { isGroup, type ProcessBundle } from "@transpera-flow/db";
import { describeValue, fieldLabel, namesOf } from "@/lib/editor/describe";
import type { DraftDiff, StepChange } from "@/lib/drafts/diff";

export type ChangeLineKind = "added" | "removed" | "merged" | "replaced" | "changed" | "rerouted";

export interface ChangeLine {
  kind: ChangeLineKind;
  text: string;
}

const pct = (p: unknown) => `${Math.round(Number(p) * 100)}%`;
const quoted = (name: string) => `“${name}”`;

/** The lines, in the order a person reads them: what was merged, added, removed, changed, then the routes. Empty when nothing differs. */
export function changeLines(c: { base: ProcessBundle; solved: ProcessBundle; diff: DraftDiff }): ChangeLine[] {
  const { base, solved, diff } = c;
  const names = namesOf(base, solved);
  const nameOf = (id: string) => names.get(id) ?? "a step";
  const kindWord = (s: StepChange) => (isGroup((s.draft ?? s.live)!) ? "group" : "step");
  const steps = [...diff.steps.values()];
  const added = steps.filter((s) => s.kind === "added");
  const removed = steps.filter((s) => s.kind === "removed");
  const lines: ChangeLine[] = [];

  // Two or more steps taken out and one put in is a merge: say so once, not as three separate lines.
  const workAdded = added.filter((s) => kindWord(s) === "step");
  const workRemoved = removed.filter((s) => kindWord(s) === "step");
  const merged = workRemoved.length >= 2 && workAdded.length === 1;
  if (merged) {
    const into = workAdded[0]!.draft!.name;
    const from = workRemoved.map((s) => quoted(s.live!.name));
    lines.push({ kind: "merged", text: `Merged ${from.slice(0, -1).join(", ")} and ${from[from.length - 1]} into ${quoted(into)}` });
  }
  // A step turned into a group (a block put in its place) is one line naming the steps that now do its work, not a changed step and a line per new step.
  const replaced = steps.filter((x) => x.kind === "changed" && x.live && x.draft && isGroup(x.draft) && !isGroup(x.live));
  const inside = new Set<string>();
  for (const g of replaced) {
    const kids = added.filter((x) => x.draft!.parent_step_id === g.id);
    for (const k of kids) inside.add(k.id);
    lines.push({
      kind: "replaced",
      text: `Replaced ${quoted(g.live!.name)} with the group ${quoted(g.draft!.name)}${kids.length ? `: ${kids.map((k) => k.draft!.name).join(", ")}` : ""}`,
    });
  }
  for (const s of added) {
    if (merged && s === workAdded[0]) continue;
    if (inside.has(s.id)) continue;
    lines.push({ kind: "added", text: `Added ${kindWord(s)} ${quoted(s.draft!.name)}` });
  }
  for (const s of removed) {
    if (merged && workRemoved.includes(s)) continue;
    lines.push({ kind: "removed", text: `Removed ${kindWord(s)} ${quoted(s.live!.name)}` });
  }
  for (const s of steps.filter((x) => x.kind === "changed" && !replaced.includes(x))) {
    const fields = s.fields.filter((f) => f.field !== "outcome" || !s.fields.some((g) => g.field === "kind"));
    if (!fields.length) continue;
    const what = fields.map((f) => `${fieldLabel(f.field).toLowerCase()} ${describeValue(f.field, f.live, names)} → ${describeValue(f.field, f.draft, names)}`);
    lines.push({ kind: "changed", text: `Changed ${quoted(s.draft!.name)}: ${what.join("; ")}` });
  }

  // Routes between steps that are in both maps: a new, removed or re-weighted route is a reroute. A route to or from a step that was
  // itself added or removed is already said by that step's line.
  const inBoth = (id: string) => diff.steps.get(id)?.kind !== "added" && diff.steps.get(id)?.kind !== "removed";
  for (const e of diff.edges.values()) {
    const edge = (e.draft ?? e.live)!;
    if (!inBoth(edge.from_step_id) || !inBoth(edge.to_step_id)) continue;
    const from = quoted(nameOf(edge.from_step_id));
    const to = quoted(nameOf(edge.to_step_id));
    if (e.kind === "added") lines.push({ kind: "rerouted", text: `New route from ${from} to ${to}, taking ${pct(e.draft!.probability)} of the work` });
    else if (e.kind === "removed") lines.push({ kind: "rerouted", text: `Removed the route from ${from} to ${to}` });
    else if (e.fields.some((f) => f.field === "probability")) lines.push({ kind: "rerouted", text: `Rerouted ${from} to ${to}: its share of the work goes from ${pct(e.live!.probability)} to ${pct(e.draft!.probability)}` });
  }
  return lines;
}
