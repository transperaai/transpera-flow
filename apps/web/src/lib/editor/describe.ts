// Field values as words, for conflict prompts and draft changes.

import { workspacePurposes, type ProcessBundle } from "@transpera-flow/db";
import { formatHours } from "@/lib/format";
import { KIND_LABELS, OUTCOME_LABELS } from "./commands";
import { FIELD_LABELS } from "./labels";
import type { Value } from "./ops";

/** Names of steps, roles and people by id, for describing `*_id` fields. */
export function namesOf(...bundles: (Pick<ProcessBundle, "steps" | "roles" | "people"> & Partial<Pick<ProcessBundle, "workspace">>)[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const b of bundles) {
    // Purpose categories by key (a key is never a uuid), so a purpose reads as its category's name.
    for (const c of workspacePurposes(b.workspace?.settings)) if (!names.has(c.key)) names.set(c.key, c.name);
    for (const r of b.roles) names.set(r.id, r.name);
    for (const p of b.people) names.set(p.id, p.name);
    for (const s of b.steps) if (!names.has(s.id)) names.set(s.id, s.name);
  }
  return names;
}

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

export function describeValue(field: string, v: Value, names: Map<string, string>): string {
  if (field === "purpose") return v === null || v === "" ? "Automatic" : (names.get(String(v)) ?? "a removed category");
  if (v === null || v === "") return field === "rework_to_step_id" ? "the step itself" : "blank";
  if (typeof v === "object") return v.source;
  if (field === "probability" || field === "rework_rate" || field === "lost_per_day_waiting" || field === "dropoff_benchmark") return `${Math.round(Number(v) * 1000) / 10}%`;
  if (field.endsWith("_id")) return names.get(String(v)) ?? "a removed item";
  if (field === "kind") return KIND_LABELS[v as keyof typeof KIND_LABELS] ?? String(v);
  if (field === "outcome") return OUTCOME_LABELS[v as keyof typeof OUTCOME_LABELS] ?? String(v);
  if (field === "assumption") return v ? "estimate" : "confirmed";
  if (field === "conflict") return v ? "sources disagree" : "settled";
  if (/_hours$|_params\.(min|mode|max)$/.test(field)) return formatHours(Number(v));
  return String(v);
}
