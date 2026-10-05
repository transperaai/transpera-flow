import "server-only";

// Running AI analysis on the server (issue #111, A46; issue #175, B17; docs/adr/0013-ai-analysis.md and 0015). Analysis
// runs ON DEMAND only: someone presses "Analyse" on a process page (one process) or on the Overview (the whole company).
// Nothing runs on a publish or a market change any more. Everything runs as the signed-in user under RLS, with the client
// of the person who pressed it, so a viewer's click or a stranger's request writes nothing.
//
// Results are cached: an analysis is stored with a hash of the model it read, and pressing Analyse again while the model
// hashes the same returns the stored one without simulating or calling the model. Every model call first reserves a run
// in the database (`reserve_ai_run`: 40 runs a day per workspace, one a minute per process), so the cost stays bounded
// whatever calls this. What AI found is stored as PROPOSED findings, each citing the facts it rests on, for a person to
// accept, edit or dismiss.

import {
  AI_DAILY_RUN_LIMIT,
  ModelError,
  reserveAiRun,
  type AiReservation,
  loadAiSettings,
  loadFirstPrinciplesFor,
  loadIssues,
  loadLatestAiAnalyses,
  loadProcessBundle,
  listProcesses,
  saveAiAnalysis,
  storeProposedFindings,
  toEngineModel,
  type AiSettings,
  type Db,
  type ProcessBundle,
  type ProposedFinding,
  type SaveAiAnalysisInput,
} from "@transpera-flow/db";
import { absenceTest, resolveMoney, shadowPricesFor, simulate, type AbsenceTest, type DetectedIssue } from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { anthropicAnalyst } from "@/lib/narration/anthropic";
import { analyseWithAi, type AiModel, type AiOutcome } from "./analyse";
import { aiInputForRun, costedRoleIds, quotesFromBundle, ruleFindings, type AiRunInput } from "./input";
import { analysisModelHash } from "./model-hash";
import type { AiInsight } from "./types";

/** The replications and seed every page uses, so AI reads the same run the person sees. */
const REPS = 30;
const SEED = 1;

export type AiSkip =
  /** The server has no Anthropic API key. */
  | "not_set_up"
  /** The version has no first principles to review. */
  | "no_first_principles"
  /** This process ran less than a minute ago (the database refuses a second run). */
  | "cooldown"
  /** The model is the one the stored analysis read: it is still current, and nothing was run. */
  | "unchanged"
  /** The workspace has used its model runs for the day (the database counts them). */
  | "limit"
  /** The process has no live version. */
  | "no_live"
  /** The user can't write here. */
  | "forbidden"
  /** The model of the process can't be built (a step is broken, say). */
  | "model_error";

export type AiRunResult =
  | { status: "stored"; outcome: AiOutcome; added: number }
  | { status: "skipped"; why: AiSkip; message?: string }
  | { status: "error"; message: string };

export interface AiRunDeps {
  /** Run even when the model is unchanged (it still reserves a run, so it still counts against the cap and the cooldown). */
  force: boolean;
  scope: "process" | "company";
  workspaceId: string;
  /** The process the analysis is stored against: the one analysed, or the company map's for the whole company. */
  processId: string;
  revisionId: string | null;
  settings: Pick<AiSettings, "read_sources">;
  canWrite: boolean;
  /** The latest stored analysis of this scope, if any. */
  existing: { input_hash: string; status: string; model_hash: string | null } | null;
  /** The hash of the model as it is now (`analysisModelHash`); null when it can't be built. */
  modelHash: string | null;
  /** Load the version and run it. Called only once the cheap checks pass. */
  build: () => Promise<AiRunInput | { error: string }>;
  /** Claude, or null when the server has no key. */
  model: AiModel | null;
  /** Reserve a model run in the database before calling the model: it counts the daily cap and the cooldown. */
  reserve: () => Promise<AiReservation>;
  /** Store the analysis; its id, or null when it couldn't be written. */
  save: (row: SaveAiAnalysisInput) => Promise<string | null>;
  /** Store what it found as proposed findings; how many were new, or an error in words. */
  propose: (analysisId: string, findings: ProposedFinding[]) => Promise<{ added: number } | { error: string }>;
}

/** The process each step belongs to in a bundle (its own, and those of every other process in it). */
export function stepProcesses(bundle: ProcessBundle): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of bundle.otherProcesses ?? []) for (const s of o.steps) out.set(s.id, o.process.id);
  for (const s of bundle.steps) out.set(s.id, bundle.process.id);
  return out;
}

/**
 * AI insights as proposed findings. A finding on a step sits in that step's process; one on no step sits in the process
 * analysed, or across the company for the whole company.
 */
export function proposedFindings(insights: readonly AiInsight[], scope: "process" | "company", processId: string, steps: ReadonlyMap<string, string>): ProposedFinding[] {
  return insights.map((i) => ({
    aiKey: i.key,
    processId: (i.stepId && steps.get(i.stepId)) || (scope === "company" ? null : processId),
    stepId: i.stepId,
    rating: i.rating,
    type: i.type,
    title: i.title,
    evidence: i.evidence,
    why: i.why,
    facts: i.facts ?? [],
  }));
}

/** Decide, run and store one analysis. Pure orchestration over the injected pieces, so it is tested with fakes. */
export async function runAnalysis(deps: AiRunDeps): Promise<AiRunResult> {
  if (!deps.revisionId) return { status: "skipped", why: "no_live" };
  if (!deps.canWrite) return { status: "skipped", why: "forbidden" };
  if (!deps.model) return { status: "skipped", why: "not_set_up" };
  const current = deps.existing?.status === "ok";
  // The cache: the model hashes as it did when the stored analysis was written, so nothing is simulated or sent.
  if (!deps.force && current && deps.modelHash && deps.existing?.model_hash === deps.modelHash) return { status: "skipped", why: "unchanged" };

  const built = await deps.build();
  if ("error" in built) return { status: "skipped", why: "model_error", message: built.error };
  const made = aiInputForRun({ ...built, scope: deps.scope, quotes: deps.settings.read_sources ? quotesFromBundle(built.bundle) : null });
  if (!made) return { status: "skipped", why: "no_first_principles" };
  if (!deps.force && current && deps.existing?.input_hash === made.input.hash) return { status: "skipped", why: "unchanged" };

  // The one place the model is called: reserve first, so the database has counted the run whatever happens next.
  const reservation = await deps.reserve();
  if (reservation.status === "limit") return { status: "skipped", why: "limit", message: `This workspace has used its ${AI_DAILY_RUN_LIMIT} AI runs for the day.` };
  if (reservation.status === "cooldown") return { status: "skipped", why: "cooldown", message: `AI analysed this a moment ago. Try again in ${reservation.retryAfterSeconds} seconds.` };
  if (reservation.status === "forbidden") return { status: "skipped", why: "forbidden" };
  if (reservation.status === "error") return { status: "error", message: "AI analysis couldn't start. Try again." };

  const outcome = await analyseWithAi(made.input, deps.model);
  const id = await deps.save({
    run_id: reservation.runId,
    workspace_id: deps.workspaceId,
    process_id: deps.processId,
    revision_id: deps.revisionId,
    status: outcome.status,
    reason: outcome.reason?.slice(0, 2000) ?? null,
    trigger: "manual",
    summary: outcome.summary,
    insights: outcome.insights as unknown as SaveAiAnalysisInput["insights"],
    review: outcome.review as unknown as SaveAiAnalysisInput["review"],
    checked: outcome.checked,
    dropped: outcome.dropped,
    input_hash: made.input.hash,
    model: outcome.model,
    model_hash: deps.modelHash,
    usage: outcome.usage as unknown as SaveAiAnalysisInput["usage"],
  });
  if (!id) return { status: "error", message: "The analysis ran but couldn't be saved." };
  if (outcome.status !== "ok") return { status: "stored", outcome, added: 0 };
  const stored = await deps.propose(id, proposedFindings(outcome.insights, deps.scope, deps.scope === "company" ? "" : built.bundle.process.id, stepProcesses(built.bundle)));
  if ("error" in stored) return { status: "error", message: "The analysis ran, but its findings couldn't be saved for review. Try again." };
  return { status: "stored", outcome, added: stored.added };
}

// ---------------------------------------------------------------------------
// The database side
// ---------------------------------------------------------------------------

/** A process's version as AI reads it: its bundle, its model, one run and its first principles. Rule 8 and the busy cost take their own extra runs, as on the pages. */
async function loadRun(db: Db, bundle: ProcessBundle, firstPrinciplesOf: string): Promise<AiRunInput | { error: string }> {
  let model;
  try {
    model = toEngineModel(bundle);
  } catch (err) {
    if (err instanceof ModelError) return { error: err.message };
    throw err;
  }
  const fp = await loadFirstPrinciplesFor(db, firstPrinciplesOf, [bundle.revision.id]);
  const result = simulate(model, REPS, SEED);
  let absence: AbsenceTest | null = null;
  try {
    absence = absenceTest(model, { seed: SEED, weeks: resolveMoney(ANALYSIS_DEFAULTS).absenceWeeks });
  } catch {
    // Without it "only one person can do it" raises nothing, as on a page while the test is still running.
  }
  const firstPrinciples = fp[bundle.revision.id]?.doc ?? null;
  // The too-busy cost needs the shadow price of each busy role (an extra run), as the pages compute it.
  const first: DetectedIssue[] = ruleFindings({ bundle, model, result, firstPrinciples, absence });
  const roleIds = costedRoleIds(first);
  let shadowPrices: Record<string, number> | undefined;
  if (roleIds.length) {
    try {
      shadowPrices = shadowPricesFor(model, roleIds, { reps: REPS, seed: SEED });
    } catch {
      // Those costs read "n/a", as on a page whose extra run failed.
    }
  }
  return { bundle, model, result, firstPrinciples, absence, ...(shadowPrices ? { shadowPrices } : {}) };
}

/** The keys of AI insights already acknowledged as issues before B17 (`ai:insight:<hash>`): those aren't proposed again. */
async function acknowledgedAiKeys(db: Db, workspaceId: string): Promise<Set<string>> {
  try {
    return new Set((await loadIssues(db, workspaceId)).flatMap((i) => (i.detected_key?.startsWith("ai:insight:") ? [i.detected_key] : [])));
  } catch {
    return new Set();
  }
}

/** The pieces both scopes share: settings, write access, the latest stored analysis, the reservation, the stores. */
async function common(db: Db, workspaceId: string, storedOn: string) {
  const [settings, canWrite, latest, skip] = await Promise.all([
    loadAiSettings(db, workspaceId),
    db.rpc("can_edit_workspace", { ws: workspaceId }),
    loadLatestAiAnalyses(db, [storedOn]),
    acknowledgedAiKeys(db, workspaceId),
  ]);
  const row = latest[storedOn];
  return {
    settings,
    canWrite: canWrite.data === true,
    existing: row ? { input_hash: row.input_hash, status: row.status, model_hash: row.model_hash } : null,
    reserve: () => reserveAiRun(db, workspaceId, storedOn, "manual"),
    save: (r: SaveAiAnalysisInput) => saveAiAnalysis(db, r),
    propose: async (analysisId: string, findings: ProposedFinding[]) => {
      const out = await storeProposedFindings(db, { workspaceId, analysisId, scope: storedOn, findings, skipKeys: skip });
      return "error" in out ? out : { added: out.added };
    },
  };
}

/** "Analyse" on a process page: the signed-in user's client analyses the process's live version. */
export async function runAiAnalysis(db: Db, processId: string, { force = false, model = anthropicAnalyst() }: { force?: boolean; model?: AiModel | null } = {}): Promise<AiRunResult> {
  try {
    const { data: process, error } = await db.from("processes").select("id, workspace_id, live_revision_id, is_company").eq("id", processId).maybeSingle();
    if (error || !process) return { status: "error", message: "That process isn't available." };
    if (process.is_company) return { status: "error", message: "Analyse the whole company from the Overview." };
    const workspaceId = process.workspace_id;
    const revisionId = process.live_revision_id;
    if (!revisionId) return { status: "skipped", why: "no_live" };
    const { data: workspace } = await db.from("workspaces").select("id, name, slug, settings").eq("id", workspaceId).maybeSingle();
    const listed = (await listProcesses(db, workspaceId)).find((p) => p.id === processId);
    if (!workspace || !listed) return { status: "error", message: "The process couldn't be found." };
    const bundle = await loadProcessBundle(db, workspace, listed, revisionId);
    const fp = (await loadFirstPrinciplesFor(db, processId, [revisionId]))[revisionId]?.doc ?? null;
    return await runAnalysis({
      force,
      scope: "process",
      workspaceId,
      processId,
      revisionId,
      ...(await common(db, workspaceId, processId)),
      modelHash: analysisModelHash(bundle, fp, "process"),
      build: () => loadRun(db, bundle, processId),
      model,
    });
  } catch (err) {
    console.error("AI analysis failed.", err instanceof Error ? err.message : err);
    return { status: "error", message: "AI analysis couldn't run. Try again." };
  }
}

/**
 * "Analyse the whole company" on the Overview: the company model (the first sales pipeline with every process it runs
 * beside, as the Overview simulates it), judged against the pipeline's first principles, stored against the company map.
 */
export async function runCompanyAiAnalysis(db: Db, workspaceId: string, { force = false, model = anthropicAnalyst() }: { force?: boolean; model?: AiModel | null } = {}): Promise<AiRunResult> {
  try {
    const { data: workspace } = await db.from("workspaces").select("id, name, slug, settings").eq("id", workspaceId).maybeSingle();
    if (!workspace) return { status: "error", message: "That workspace isn't available." };
    const everything = await listProcesses(db, workspaceId, { includeCompany: true });
    const company = everything.find((p) => p.is_company);
    // The company model, picked as the Overview picks it (`loadProcessBySlug`): the first top-level process with a live version.
    const all = everything.filter((p) => !p.is_company);
    const pipeline = all.find((p) => p.live_revision_id && !p.parent_process_id) ?? all.find((p) => p.live_revision_id);
    if (!company?.live_revision_id) return { status: "error", message: "This workspace has no company map yet." };
    if (!pipeline?.live_revision_id) return { status: "skipped", why: "no_live" };
    const bundle = await loadProcessBundle(db, workspace, pipeline, pipeline.live_revision_id);
    const fp = (await loadFirstPrinciplesFor(db, pipeline.id, [pipeline.live_revision_id]))[pipeline.live_revision_id]?.doc ?? null;
    return await runAnalysis({
      force,
      scope: "company",
      workspaceId,
      processId: company.id,
      revisionId: company.live_revision_id,
      ...(await common(db, workspaceId, company.id)),
      modelHash: analysisModelHash(bundle, fp, "company"),
      build: () => loadRun(db, bundle, pipeline.id),
      model,
    });
  } catch (err) {
    console.error("AI analysis (company) failed.", err instanceof Error ? err.message : err);
    return { status: "error", message: "AI analysis couldn't run. Try again." };
  }
}
