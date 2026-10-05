// What a `transpera-process/2` file carries beyond its steps (issue #167, B14), turned into the rows `import_process_bundle`
// writes: sources (with ids chosen here), pending suggestions for company facts, pending proposals, and first principles for the
// draft. It reuses the paths the MCP tools use (suggesting.ts, proposing.ts, first-principles.ts), so an uploaded fact reads in
// the review queue exactly like one Claude suggested. Nothing here writes: the preview calls it to show what would happen, the
// import calls it and hands the rows to the database.

import {
  describeSuggestion,
  firstPrinciplesToColumns,
  isVisibleIssue,
  loadCompanyModel,
  loadIssues,
  type CompanyModel,
  type EvidenceCitation,
  type FileCitation,
  type FileSource,
  type IssueLinkRef,
  type Json,
  type ProcessFile,
  type SuggestionRow,
} from "@transpera-flow/db";
import { emptyFirstPrinciples, storedOfRating } from "@transpera-flow/engine";
import { matchNamed } from "./analysis";
import { normalizeName } from "./building";
import type { WorkspaceRef } from "./context";
import { mergeFirstPrinciples, type FpInput } from "./first-principles";
import { buildIssueProposal, buildSolutionIdeaProposal, matchIssue, type ProposalInsert } from "./proposing";
import { ToolError } from "./result";
import {
  buildClientSuggestion,
  buildDemandSuggestions,
  buildPersonSuggestion,
  buildRoleSuggestion,
  buildServiceSuggestion,
  type Built,
  type Proposal,
  type Provenanced,
} from "./suggesting";
import type { ToolContext } from "./context";

/** Ids the caller chose, so rows that point at each other can be built before anything is written. */
export interface FileIds {
  processId: string;
  /** File source id → the id the source gets. */
  sources: ReadonlyMap<string, string>;
  /** File step id → the id the step gets. */
  steps: ReadonlyMap<string, string>;
}

export interface SuggestionView {
  subject: string;
  headline: string;
  isNew: boolean;
  changes: { label: string; before: string | null; after: string; unchanged: boolean; overridesFact: boolean }[];
}

export interface ExtrasPlan {
  sources: { id: string; kind: string; title: string; speakers: string[]; recorded_at: string | null; body: string | null }[];
  suggestions: { target_table: string; target_id: string | null; patch: Json; evidence: Json; note: string | null }[];
  proposals: { kind: string; title: string; detail: string | null; payload: Json; evidence: Json; note: string | null; issue_id: string | null }[];
  /** The first principles' columns, or null when the file has none. */
  firstPrinciples: Record<string, Json> | null;
  /** For the preview. */
  suggestionViews: SuggestionView[];
  proposalViews: { kind: "issue" | "solution_idea"; title: string; forIssue: string | null }[];
  firstPrinciplesParts: number;
  /** Things the upload left out or changed, in plain words. */
  notes: string[];
  /** Where the file disagrees with what the company has, or the sources disagree. */
  conflicts: string[];
}

const evidenceOf = (cites: readonly FileCitation[], ids: FileIds): EvidenceCitation[] =>
  cites.map((c) => ({
    source_id: ids.sources.get(c.source)!,
    speaker: c.speaker ?? null,
    quote: c.quote,
    timestamp: c.time ?? null,
    ...(c.value !== undefined ? { value: c.value } : {}),
  }));

/** "Quote" (speaker, source, time): evidence as one line of text, for fields that hold text. */
function quoteLine(c: FileCitation, titles: ReadonlyMap<string, string>): string {
  const who = [c.speaker, titles.get(c.source), c.time].filter(Boolean).join(", ");
  return `“${c.quote}”${who ? ` (${who})` : ""}`;
}

const notePart = (assumed: string | undefined) => (assumed ? `Assumed: ${assumed}` : undefined);

export const sourceRows = (sources: readonly FileSource[], ids: ReadonlyMap<string, string>): ExtrasPlan["sources"] =>
  sources.map((s) => ({ id: ids.get(s.id)!, kind: s.kind, title: s.title, speakers: s.speakers, recorded_at: s.date ?? null, body: s.body ?? null }));

/**
 * Plan everything a /2 file carries beyond the process. `ids` are the ids the rows will have; for a preview they can be made up.
 * Never throws for a problem with one item: it is left out and said in `notes` (or `conflicts`), and the rest goes ahead.
 */
export async function planFileExtras(ctx: ToolContext, ws: WorkspaceRef, file: ProcessFile, ids: FileIds): Promise<ExtrasPlan> {
  const plan: ExtrasPlan = {
    sources: sourceRows(file.sources ?? [], ids.sources),
    suggestions: [],
    proposals: [],
    firstPrinciples: null,
    suggestionViews: [],
    proposalViews: [],
    firstPrinciplesParts: 0,
    notes: [],
    conflicts: [],
  };
  const titles = new Map((file.sources ?? []).map((s) => [s.id, s.title]));
  const needsModel = !!file.company || !!file.first_principles;
  const model = needsModel ? await loadCompanyModel(ctx.db, ws) : null;

  if (file.company && model) planCompany(file.company, model, ids, plan);
  if (file.proposals?.length) await planProposals(ctx, ws, file, ids, plan);
  if (file.first_principles && model) planFirstPrinciples(file, model, ids, titles, plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Company → suggestions
// ---------------------------------------------------------------------------

function planCompany(company: NonNullable<ProcessFile["company"]>, model: CompanyModel, ids: FileIds, plan: ExtrasPlan): void {
  const fileRoles = new Set(company.roles.map((r) => normalizeName(r.name)));
  const fileServices = new Set(company.services.map((s) => normalizeName(s.name)));
  const prov = (item: { evidence: readonly FileCitation[]; assumed?: string }): Provenanced => ({
    evidence: evidenceOf(item.evidence, ids),
    ...(item.assumed ? { note: notePart(item.assumed)! } : {}),
  });
  /** The names that resolve to something the company has now; the rest are said and left off. */
  const known = (names: readonly string[] | undefined, rows: readonly { id: string; name: string }[], kind: string, who: string, inFile: ReadonlySet<string>): string[] | undefined => {
    if (!names) return undefined;
    const keep: string[] = [];
    for (const n of names) {
      try {
        matchNamed(rows, n, kind);
        keep.push(n);
      } catch {
        plan.notes.push(`${who}: the ${kind} '${n}' isn't one of yours yet${inFile.has(normalizeName(n)) ? " (the file suggests it, so accept that first and add it afterwards)" : ""}, so it was left off.`);
      }
    }
    return keep.length ? keep : undefined;
  };
  const run = (what: string, build: () => Built) => {
    try {
      const built = build();
      for (const u of built.unchanged) plan.notes.push(`${u}.`);
      for (const p of built.proposals) add(p);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      const near = Array.isArray(e.candidates) && e.candidates.length ? ` It is close to ${(e.candidates as { name: string }[]).map((c) => `'${c.name}'`).join(", ")}.` : "";
      plan.conflicts.push(`${what} was left out: ${e.message.replace(/\.$/, "")}.${near} Use the exact name to change an existing one.`);
    }
  };
  const add = (p: Proposal) => {
    plan.suggestions.push({ target_table: p.target_table, target_id: p.target_id, patch: p.patch as unknown as Json, evidence: p.evidence as unknown as Json, note: p.note });
    const row = { id: "preview", workspace_id: "", status: "pending", target_table: p.target_table, target_id: p.target_id, patch: p.patch, evidence: p.evidence, note: p.note } as unknown as SuggestionRow;
    const v = describeSuggestion(row, model, "The file");
    plan.suggestionViews.push({ subject: v.subject, headline: v.headline, isNew: !p.target_id && p.target_table !== "workspaces" && p.target_table !== "demand_settings" && p.target_table !== "seasonality", changes: v.changes.map((c) => ({ label: c.label, before: c.before, after: c.after, unchanged: c.unchanged, overridesFact: c.overridesFact })) });
    for (const c of v.changes) {
      if (!c.unchanged && c.before !== null && c.before !== "" && c.before !== c.after) {
        plan.conflicts.push(`${v.subject}: ${c.label.toLowerCase()} is ${c.before} in your company, ${c.after} in the file${c.overridesFact ? " (someone entered the current value)" : ""}. It is only a suggestion: nothing changes until you accept it.`);
      }
    }
  };
  const sink: string[] = [];

  for (const r of company.roles) run(`Role '${r.name}'`, () => buildRoleSuggestion(model, { name: r.name, ...prov(r) }, sink));
  for (const s of company.services) {
    run(`Service '${s.name}'`, () =>
      buildServiceSuggestion(model, { name: s.name, pricing_model: s.pricing_model, price: s.price, margin: s.margin, tenure_months: s.tenure_months, churn_monthly_base: s.monthly_churn, mix_share: s.mix_share, ...prov(s) }, sink),
    );
  }
  for (const p of company.people) {
    const roles = known(p.roles, model.roles, "role", `Person '${p.name}'`, fileRoles);
    run(`Person '${p.name}'`, () =>
      buildPersonSuggestion(model, { name: p.name, ...(roles ? { roles } : {}), fte: p.fte, capacity_hours_week: p.hours_per_week, cost_rate: p.cost_rate, email: p.email, start_date: p.start_date, ...(p.leave ? { leave: p.leave } : {}), ...prov(p) }, sink),
    );
  }
  for (const c of company.clients) {
    const services = known(c.services, model.services, "service", `Client '${c.name}'`, fileServices);
    // An assignment names a role and a person the company already has; one that doesn't resolve is said and left off.
    const assignments: Record<string, string> = {};
    for (const [role, person] of Object.entries(c.assignments ?? {})) {
      try {
        matchNamed(model.roles, role, "role");
        matchNamed(model.people, person, "person");
        assignments[role] = person;
      } catch {
        plan.notes.push(`Client '${c.name}': ${role} ${person} was left off: the role or the person isn't one of yours yet.`);
      }
    }
    run(`Client '${c.name}'`, () =>
      buildClientSuggestion(
        model,
        { name: c.name, ...(services ? { services } : {}), mrr: c.mrr, start_date: c.start_date, health: c.health, notes: c.notes, ...(c.active !== undefined ? { active: c.active } : {}), ...(Object.keys(assignments).length ? { assignments } : {}), ...prov(c) },
        sink,
      ),
    );
  }
  const d = company.demand;
  if (d) {
    run("Demand", () =>
      buildDemandSuggestions(
        model,
        {
          lead_sources: d.lead_sources.map((l) => ({ name: l.name, volume_week: l.volume_per_week, conversion_to_qualified: l.conversion_to_qualified, ...prov(l) })),
          ...(d.seasonality ? { seasonality: d.seasonality } : {}),
          ...(d.growth_monthly !== undefined ? { growth_monthly: d.growth_monthly } : {}),
          ...prov(d),
        },
        sink,
      ),
    );
  }
  // A suggestion needs a reason someone can read: leave the builders' defaults notes out, they are about the app, not the file.
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

async function planProposals(ctx: ToolContext, ws: WorkspaceRef, file: ProcessFile, ids: FileIds, plan: ExtrasPlan): Promise<void> {
  const issues = file.proposals!.some((p) => p.type === "solution_idea") ? (await loadIssues(ctx.db, ws.id)).filter(isVisibleIssue) : [];
  for (const p of file.proposals!) {
    const evidence = evidenceOf(p.evidence, ids);
    const note = notePart(p.assumed);
    let built: ProposalInsert;
    try {
      if (p.type === "issue") {
        const links: IssueLinkRef[] = p.steps?.length ? p.steps.map((s) => ({ process_id: ids.processId, step_id: ids.steps.get(s)! })) : [{ process_id: ids.processId, step_id: null }];
        built = buildIssueProposal({ title: p.title, detail: p.detail, severity: storedOfRating(p.rating ?? "good"), type: p.issue_type, links, target_measure: p.target_measure, target_now: p.target_now, target_goal: p.target_goal, evidence, note });
      } else {
        const issue = matchIssue(issues, p.for_issue!);
        built = buildSolutionIdeaProposal({ issue_id: issue.id, title: p.title, detail: p.detail, steps: p.proposed_steps ?? [], expect: p.expect, evidence, note });
      }
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      plan.notes.push(`Proposal '${p.title}' was left out: ${e.message.replace(/\.$/, "")}.`);
      continue;
    }
    plan.proposals.push({ kind: built.kind, title: built.title, detail: built.detail, payload: built.payload as unknown as Json, evidence: built.evidence as unknown as Json, note: built.note, issue_id: built.issue_id });
    plan.proposalViews.push({ kind: built.kind, title: built.title, forIssue: p.type === "solution_idea" ? p.for_issue! : null });
  }
}

// ---------------------------------------------------------------------------
// First principles
// ---------------------------------------------------------------------------

function planFirstPrinciples(file: ProcessFile, model: CompanyModel, ids: FileIds, titles: ReadonlyMap<string, string>, plan: ExtrasPlan): void {
  const fp = file.first_principles!;
  const line = (cites: readonly FileCitation[], assumed?: string) => [...cites.map((c) => quoteLine(c, titles)), ...(assumed ? [`Assumed: ${assumed}`] : [])].join(" · ");
  // Evidence for something with no text field of its own (the job, the measures, the root cause) is kept as a truth that quotes it.
  const extraTruths: NonNullable<FpInput["statements"]> = [];
  const quoted = (label: string, cites: readonly FileCitation[], assumed?: string) => {
    if (cites.length || assumed) extraTruths.push({ text: label, kind: cites.length ? "truth" : "assumption", source: line(cites, assumed) });
  };
  quoted("The job, as said", fp.job?.evidence ?? [], fp.job?.assumed);
  quoted("The biggest problem and its root cause, as said", fp.why?.evidence ?? [], fp.why?.assumed);
  for (const m of fp.measures) quoted(`Success measure “${m.text}”`, m.evidence, m.assumed);
  const input: FpInput = {
    ...(fp.job ? { job: { who: fp.job.who, progress: fp.job.progress, situation: fp.job.situation, done: fp.job.done } } : {}),
    statements: [...fp.truths.map((t) => ({ text: t.text, kind: t.kind ?? (t.evidence.length ? "truth" as const : "assumption" as const), source: line(t.evidence, t.assumed), ...(t.test ? { test: t.test } : {}) })), ...extraTruths],
    requirements: fp.requirements.map((r) => ({
      text: r.text,
      ...(r.owner ? { owner: r.owner } : {}),
      why: [r.why, line(r.evidence, r.assumed)].filter(Boolean).join(" — "),
      ...(r.verdict ? { verdict: r.verdict } : {}),
      ...(r.step ? { step: ids.steps.get(r.step) } : {}),
    })),
    measures: fp.measures.map((m) => ({ text: m.text, ...(m.kpi ? { kpi: m.kpi } : {}), ...(m.comparator ? { comparator: m.comparator } : {}), ...(m.target !== undefined ? { target: m.target } : {}), ...(m.horizon ? { horizon: m.horizon } : {}) })),
    ...(fp.why ? { why: { ...(fp.why.problem ? { problem: fp.why.problem } : {}), ...(fp.why.chain ? { chain: fp.why.chain } : {}), ...(fp.why.root ? { root: fp.why.root } : {}) } } : {}),
  };
  const merged = mergeFirstPrinciples(
    emptyFirstPrinciples(),
    input,
    { steps: file.steps.map((s) => ({ id: ids.steps.get(s.id)!, name: s.name })), people: model.people.map((p) => ({ id: p.id, name: p.name })) },
    "replace",
  );
  plan.notes.push(...merged.warnings);
  const columns = firstPrinciplesToColumns(merged.doc) as unknown as Record<string, Json>;
  plan.firstPrinciples = columns;
  plan.firstPrinciplesParts = merged.changed.length;
}
