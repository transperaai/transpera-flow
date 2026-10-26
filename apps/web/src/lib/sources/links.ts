// Linking sources (issue #118, A53): the labels, pickers and checks behind the Add / Link source dialog, the chips on the
// Sources page and the Server Actions. Pure: no I/O and no clock, so the dialog's rules are unit-tested. The dialog itself
// (components/sources/source-dialog.tsx) is reusable: the step detail, the Editor, the insight pop-up, the issue, solution
// and process pages open it with a target filled in (`preset`), and it comes back with a source and its links.

import {
  SOURCE_LINK_KINDS,
  linkColumns,
  linkTarget,
  sameTarget,
  type LinkTargets,
  type SourceKind,
  type SourceLinkKind,
  type SourceLinkRow,
  type SourceLinkTarget,
} from "@transpera-flow/db";
import { MAX_TITLE, SOURCE_KINDS, cleanSourceField, isId, parseSourceInput, type Parsed, type SourceInput } from "./validate";

export { SOURCE_LINK_KINDS };

/** What each kind is called on the "Link it to" chips (the prototype's words). */
export const LINK_KIND_LABELS: Record<SourceLinkKind, string> = {
  process: "A process",
  step: "A step",
  insight: "An insight",
  issue: "An issue",
  solution: "A solution",
};

/** The heading of a link's chip: "Step: Check fit". */
const CHIP_PREFIX: Record<SourceLinkKind, string> = { process: "Process", step: "Step", insight: "Insight", issue: "Issue", solution: "Solution" };

const MAX_CHIP = 34;
export const trunc = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/** What a chip says for a link, named from the pickers' lists: "Step: Check fit", "Issue #12", "Insight: Strategist is a bottleneck". */
export function linkLabel(link: Pick<SourceLinkRow, "kind" | "process_id" | "step_id" | "insight_key" | "issue_id" | "solution_id">, targets: LinkTargets): string {
  const t = linkTarget(link);
  if (!t) return `${CHIP_PREFIX[link.kind]}: unknown`;
  switch (t.kind) {
    case "process":
      return `Process: ${targets.processes.find((p) => p.id === t.processId)?.name ?? "a process that was removed"}`;
    case "step":
    {
      const now = targets.steps.find((s) => s.id === t.stepId)?.name;
      const before = targets.olderSteps?.find((s) => s.id === t.stepId)?.name;
      return `Step: ${now ?? (before ? `${before} (in an earlier version)` : "a step that was removed")}`;
    }
    case "insight":
      return `Insight: ${trunc(targets.insights.find((i) => i.key === t.insightKey)?.title ?? "a finding the analysis made", MAX_CHIP)}`;
    case "issue": {
      const issue = targets.issues.find((i) => i.id === t.issueId);
      return issue ? (issue.number ? `Issue #${issue.number}` : `Issue: ${trunc(issue.title, MAX_CHIP)}`) : "Issue: one that was removed";
    }
    case "solution":
      return `Solution: ${trunc(targets.solutions.find((s) => s.id === t.solutionId)?.name ?? "one that was removed", MAX_CHIP)}`;
  }
}

/** The longer text for a chip's tooltip and a screen reader: the full name, not the shortened one. */
export function linkTitle(link: Parameters<typeof linkLabel>[0], targets: LinkTargets): string {
  const t = linkTarget(link);
  if (t?.kind === "insight") return `Insight: ${targets.insights.find((i) => i.key === t.insightKey)?.title ?? "a finding the analysis made"}`;
  if (t?.kind === "issue") {
    const issue = targets.issues.find((i) => i.id === t.issueId);
    if (issue) return `Issue${issue.number ? ` #${issue.number}` : ""}: ${issue.title}`;
  }
  if (t?.kind === "solution") return `Solution: ${targets.solutions.find((s) => s.id === t.solutionId)?.name ?? "one that was removed"}`;
  return linkLabel(link, targets);
}

/** One entry of the target picker: the value the select holds and what it reads as. */
export interface TargetOption {
  value: string;
  label: string;
}

/** The things of a kind a source can be linked to, as the picker lists them. */
export function targetOptions(kind: SourceLinkKind, targets: LinkTargets): TargetOption[] {
  const processName = (id: string) => targets.processes.find((p) => p.id === id)?.name;
  switch (kind) {
    case "process":
      return targets.processes.map((p) => ({ value: p.id, label: p.name }));
    case "step":
      // A step is named with its process when there is more than one, so two "Review" steps can be told apart.
      return targets.steps.map((s) => ({ value: s.id, label: targets.processes.length > 1 && processName(s.processId) ? `${s.name} (${processName(s.processId)})` : s.name }));
    case "insight":
      return targets.insights.map((i) => ({ value: i.key, label: trunc(i.title, 60) }));
    case "issue":
      return targets.issues.map((i) => ({ value: i.id, label: i.number ? `#${i.number} ${i.title}` : i.title }));
    case "solution":
      return targets.solutions.map((s) => ({ value: s.id, label: s.name }));
  }
}

/** The target a picker's choice stands for, or null when nothing is chosen or it isn't one of the options. */
export function toTarget(kind: SourceLinkKind, value: string, targets: LinkTargets): SourceLinkTarget | null {
  if (!value || !targetOptions(kind, targets).some((o) => o.value === value)) return null;
  switch (kind) {
    case "process":
      return { kind, processId: value };
    case "step": {
      const step = targets.steps.find((s) => s.id === value);
      return step ? { kind, processId: step.processId, stepId: step.id } : null;
    }
    case "insight":
      return { kind, insightKey: value };
    case "issue":
      return { kind, issueId: value };
    case "solution":
      return { kind, solutionId: value };
  }
}

/** The picker's value for a target (the inverse of `toTarget`), for a dialog opened with one filled in. */
export function targetValue(target: SourceLinkTarget): string {
  switch (target.kind) {
    case "process":
      return target.processId;
    case "step":
      return target.stepId;
    case "insight":
      return target.insightKey;
    case "issue":
      return target.issueId;
    case "solution":
      return target.solutionId;
  }
}

/**
 * The sources the issue's Edit dialog starts with. Where the page loads source links, those (they change under "+ Link" and the x,
 * which the issue's copy from the page load doesn't see: starting from it would put back what was just removed and drop what was just
 * linked); otherwise the issue's own list.
 */
export const editSourceIds = (issueSourceIds: readonly string[], linked: readonly string[] | null): string[] => [...(linked ?? issueSourceIds)];

/**
 * The sources a save takes off an issue's list: on it before, not in what was saved. Only their links go: a link made elsewhere
 * meanwhile (another tab, the MCP `link_source`) is on no list the save knew of, and stays.
 */
export const sourcesRemovedBySave = (listedBefore: readonly string[], saved: readonly string[]): string[] => {
  const kept = new Set(saved);
  return listedBefore.filter((id) => !kept.has(id));
};

/** The plain message under the "Link it to (required)" picker when nothing is chosen (the prototype's words). */
export const NEEDS_A_LINK = "Pick what this source is evidence for.";
export const NEEDS_A_TITLE = "Give the source a title.";
/** What the link to the original must be. */
export const BAD_LINK = "The link must start with http:// or https://.";
export const NEEDS_A_SOURCE = "Pick a source.";

/** What the dialog holds while it is open. */
export interface SourceDraft {
  title: string;
  kind: SourceKind;
  /** YYYY-MM-DD, or blank. */
  date: string;
  quote: string;
  /** The link to the original (a Google Drive, Notion or any other http(s) link), or blank. */
  fileUrl: string;
  linkKind: SourceLinkKind;
  /** The picker's choice (a target's id or key), or blank. */
  linkValue: string;
}

export interface SourceDraftErrors {
  title?: string;
  date?: string;
  quote?: string;
  /** The link to the original is not an http(s) link. */
  fileUrl?: string;
  link?: string;
}

/** A blank draft for the Add source dialog, with a target filled in when the dialog was opened from a screen's "+ Link". */
export function emptyDraft(preset?: SourceLinkTarget | null, today = ""): SourceDraft {
  return { title: "", kind: "transcript", date: today, quote: "", fileUrl: "", linkKind: preset?.kind ?? "step", linkValue: preset ? targetValue(preset) : "" };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_QUOTE = 5_000;

/**
 * What is wrong with the dialog, in plain words, or nothing. `existing` is the source being linked (Link source mode): its
 * own fields are not on the form, so only the link is checked.
 */
export function validateDraft(draft: SourceDraft, targets: LinkTargets, existing = false): SourceDraftErrors {
  const errors: SourceDraftErrors = {};
  if (!existing) {
    if (!draft.title.trim()) errors.title = NEEDS_A_TITLE;
    else if (draft.title.trim().length > MAX_TITLE) errors.title = `Keep the title to ${MAX_TITLE} characters.`;
    if (draft.date && (!DATE.test(draft.date) || Number.isNaN(Date.parse(draft.date)))) errors.date = "Enter the date as day, month and year.";
    if (draft.fileUrl.trim() && !cleanSourceField("file_url", draft.fileUrl)) errors.fileUrl = BAD_LINK;
    if (draft.quote.length > MAX_QUOTE) errors.quote = `Keep the quote to ${MAX_QUOTE.toLocaleString("en-GB")} characters. The full text can be added on the source afterwards.`;
  }
  if (!toTarget(draft.linkKind, draft.linkValue, targets)) errors.link = NEEDS_A_LINK;
  return errors;
}

export const hasErrors = (e: SourceDraftErrors) => Object.keys(e).length > 0;

/** The source and link a valid draft stands for, or its errors. */
export function draftToSubmission(draft: SourceDraft, targets: LinkTargets): { ok: true; input: SourceInput; link: SourceLinkTarget } | { ok: false; errors: SourceDraftErrors } {
  const errors = validateDraft(draft, targets);
  const link = toTarget(draft.linkKind, draft.linkValue, targets);
  if (hasErrors(errors) || !link) return { ok: false, errors };
  return {
    ok: true,
    link,
    input: {
      kind: draft.kind,
      title: draft.title.trim(),
      speakers: [],
      recorded_at: draft.date || null,
      body: draft.quote.trim() || null,
      file_url: draft.fileUrl.trim() || null,
    },
  };
}

/** The type picker's options, in the order the prototype lists them. */
export const KIND_CHOICES: readonly SourceKind[] = SOURCE_KINDS;

// --- What a Server Action takes ---------------------------------------------------------------------------------

const KEY = /^[a-z_]+:[a-z_]+:[^\s]{1,200}$/;

/** A link target from untrusted input: the kind and the id or key it needs. */
export function parseTarget(input: unknown): Parsed<SourceLinkTarget> {
  const parsed = parseTargetAsGiven(input);
  // The database spells a uuid in lower case: so do we, so "the same thing" compares equal.
  return parsed.ok ? { ok: true, value: lowerIds(parsed.value) } : parsed;
}

const lowerIds = (t: SourceLinkTarget): SourceLinkTarget => {
  switch (t.kind) {
    case "process":
      return { kind: "process", processId: t.processId.toLowerCase() };
    case "step":
      return { kind: "step", processId: t.processId.toLowerCase(), stepId: t.stepId.toLowerCase() };
    case "insight":
      return t;
    case "issue":
      return { kind: "issue", issueId: t.issueId.toLowerCase() };
    case "solution":
      return { kind: "solution", solutionId: t.solutionId.toLowerCase() };
  }
};

function parseTargetAsGiven(input: unknown): Parsed<SourceLinkTarget> {
  const bad = { ok: false, error: "That isn't something a source can be linked to." } as const;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad;
  const o = input as Record<string, unknown>;
  switch (o.kind) {
    case "process":
      return isId(o.processId) ? { ok: true, value: { kind: "process", processId: o.processId } } : bad;
    case "step":
      return isId(o.processId) && isId(o.stepId) ? { ok: true, value: { kind: "step", processId: o.processId, stepId: o.stepId } } : bad;
    case "insight":
      return typeof o.insightKey === "string" && KEY.test(o.insightKey) ? { ok: true, value: { kind: "insight", insightKey: o.insightKey } } : bad;
    case "issue":
      return isId(o.issueId) ? { ok: true, value: { kind: "issue", issueId: o.issueId } } : bad;
    case "solution":
      return isId(o.solutionId) ? { ok: true, value: { kind: "solution", solutionId: o.solutionId } } : bad;
    default:
      return bad;
  }
}

export const MAX_NEW_LINKS = 50;

/** A new source and the links it must have, from untrusted input. At least one link is required. */
export function parseNewSource(input: unknown, links: unknown): Parsed<{ input: SourceInput; links: SourceLinkTarget[] }> {
  const source = parseSourceInput(input);
  if (!source.ok) return source;
  if (!Array.isArray(links) || links.length === 0) return { ok: false, error: NEEDS_A_LINK };
  if (links.length > MAX_NEW_LINKS) return { ok: false, error: `A source can be linked to at most ${MAX_NEW_LINKS} things when it is added.` };
  const out: SourceLinkTarget[] = [];
  for (const l of links) {
    const t = parseTarget(l);
    if (!t.ok) return t;
    // The same thing named twice is one link.
    if (!out.some((o) => sameTarget(o, t.value))) out.push(t.value);
  }
  return { ok: true, value: { input: source.value, links: out } };
}

/** The JSON `add_source` takes for a link. */
export const linkJson = (t: SourceLinkTarget) => {
  const c = linkColumns(t);
  return { kind: c.kind, process_id: c.process_id, step_id: c.step_id, insight_key: c.insight_key, issue_id: c.issue_id, solution_id: c.solution_id };
};
