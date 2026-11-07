// What the Block library list shows for each block (capacity Q15): its steps, who does them, the time one run takes and how much of
// that time could be automated. Pure (no "use client"), so the server page and the browser tests can both call it.

import { isGroup, type BlockRow, type SolutionRow } from "@transpera-flow/db";
import { blockOfStep, blockStepCount, readBlock } from "./blocks";

/** One block as the list shows it. */
export interface BlockListRow {
  id: string;
  name: string;
  /** The first line of the description (the list truncates it with CSS). */
  line: string;
  steps: number;
  /** Role ids the steps use, distinct, in first-use order. */
  roleIds: string[];
  /** The sum of the steps' most likely hands-on hours; 0 when no step has any. */
  hours: number;
  /** 0 to 1: the share of that time in the automatable part of each step's split; null when no step has a split. */
  automatable: number | null;
  /** The solutions whose map holds this block. */
  usedIn: { id: string; name: string }[];
  updatedAt: string;
}

/** A step's most likely hands-on hours: the mode of its range when it has one, else its mean. */
export function likelyHours(step: { work_hours?: number | string | null; work_params?: { mode?: number | null } | null }): number {
  const mode = step.work_params?.mode;
  const v = mode !== null && mode !== undefined && Number.isFinite(Number(mode)) ? Number(mode) : Number(step.work_hours ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** The first line of a description, trimmed. */
export const firstLine = (text: string | null | undefined): string => (text ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

/** "30 min" under an hour, "1.5 h" from an hour up, "–" for nothing. */
export function formatBlockTime(hours: number): string {
  if (!(hours > 0)) return "–";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const tenths = Math.round(hours * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} h`;
}

/** The solutions that use each block, by block id, in the order given. A solution counts once per block. */
export function blockUsers(solutions: readonly Pick<SolutionRow, "id" | "name" | "steps">[]): Record<string, { id: string; name: string }[]> {
  const out: Record<string, { id: string; name: string }[]> = {};
  for (const s of solutions) {
    const steps = Array.isArray(s.steps?.steps) ? s.steps.steps : [];
    const used = new Set<string>();
    for (const step of steps) {
      const id = step && typeof step === "object" ? blockOfStep(step) : null;
      if (id) used.add(id);
    }
    for (const id of used) (out[id] ??= []).push({ id: s.id, name: s.name });
  }
  return out;
}

/** One list row for a block. */
export function blockListRow(block: BlockRow, users: Record<string, { id: string; name: string }[]> = {}): BlockListRow {
  const bundle = readBlock(block.steps);
  const work = bundle.steps.filter((s) => !isGroup(s));
  const roleIds: string[] = [];
  let hours = 0;
  let auto = 0;
  let anySplit = false;
  for (const s of work) {
    if (s.role_id && !roleIds.includes(s.role_id)) roleIds.push(s.role_id);
    const h = likelyHours(s);
    hours += h;
    if (s.split) {
      anySplit = true;
      const total = s.split.automatable + s.split.augmentable + s.split.manual || 1;
      auto += h * (s.split.automatable / total);
    }
  }
  return {
    id: block.id,
    name: block.name,
    line: firstLine(block.description),
    steps: blockStepCount(bundle),
    roleIds,
    hours,
    automatable: anySplit && hours > 0 ? auto / hours : null,
    usedIn: users[block.id] ?? [],
    updatedAt: block.updated_at,
  };
}

/** "today", "yesterday", "3 days ago", "2 months ago". */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 60) return "a month ago";
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return days < 730 ? "a year ago" : `${Math.floor(days / 365)} years ago`;
}

/** The rows that match a search (the name or the description's first line) and, when any roles are ticked, use one of them. */
export function filterBlockRows(rows: readonly BlockListRow[], search: string, roleIds: readonly string[]): BlockListRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => (!q || `${r.name} ${r.line}`.toLowerCase().includes(q)) && (!roleIds.length || r.roleIds.some((id) => roleIds.includes(id))));
}

/** The sentence that refuses a delete: "Used in 2 solutions: “A” and “B”." */
export function usedInSentence(users: readonly { name: string }[]): string {
  const names = users.map((u) => `“${u.name}”`);
  const list = names.length <= 3 ? names.join(", ").replace(/, ([^,]*)$/, " and $1") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `Used in ${users.length} ${users.length === 1 ? "solution" : "solutions"}: ${list}.`;
}
