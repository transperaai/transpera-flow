// What an outside analysis needs, over the connector (issue #175, B17; decision D40): the facts the engine measures, the sources
// and the solutions. With get_process (the model), run_scenario (runs), list_issues (issues) and get_first_principles, Claude or
// ChatGPT outside the app can make an assessment of their own. Every tool reads as the token's user: RLS decides what is visible
// (docs/adr/0018-mcp-tokens-checked-in-app-code.md). Read-only (docs/plans/cut-list.md item 5): findings, AI analyses and
// proposing anything are gone. Every list is bounded: facts are the worst first up to a limit with their sentences trimmed,
// sources come a page at a time with the total, and solutions leave out their copied maps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadFirstPrinciples } from "@transpera-flow/db";
import { absenceTest, compareCostsDesc, detectIssues, RATINGS, resolveMoney, shadowPricesFor, simulate, successMeasureSource, toRatingConfig, type DetectedIssue } from "@transpera-flow/engine";
import { loadLiveModel, processSteps } from "./analysis-tools";
import { resolveProcess, resolveWorkspace, type ProcessWithDraft, type ToolContext, type WorkspaceRef } from "./context";
import { runTool } from "./result";

export const FACT_TOOL_NAMES = ["get_facts", "list_sources", "list_solutions"] as const;

const REPS = 30;
const SEED = 1;
/** Time caps on the extra runs, as list_issues has them. */
const ABSENCE_BUDGET_MS = 5000;
const SHADOW_BUDGET_MS = 5000;
const MAX_SOURCE_TEXT = 4000;
/** How much one call returns: facts listed, a fact's sentences, and a page of sources. */
const MAX_FACTS = 100;
const DEFAULT_FACTS = 40;
const MAX_FACT_TEXT = 600;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const pageArgs = {
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`How many to return (default ${DEFAULT_PAGE}, at most ${MAX_PAGE}).`),
  offset: z.number().int().min(0).optional().describe("How many to skip, for the next page (default 0; use next_offset from the last call)."),
};
/** The page asked for, and what to say about it. */
function pageOf(args: { limit?: number; offset?: number }) {
  const limit = args.limit ?? DEFAULT_PAGE;
  const offset = args.offset ?? 0;
  return { limit, offset };
}
const paged = (total: number, page: { limit: number; offset: number }, shown: number) => ({
  total,
  offset: page.offset,
  limit: page.limit,
  next_offset: page.offset + shown < total ? page.offset + shown : null,
});

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");

/**
 * The live run's facts for a process, worst first, with the names of the steps they point at: what `get_facts` returns.
 */
export async function liveFacts(
  ctx: ToolContext,
  ws: WorkspaceRef,
  proc: ProcessWithDraft,
  assumptions: string[],
): Promise<{ loaded: Awaited<ReturnType<typeof loadLiveModel>>; facts: DetectedIssue[]; steps: Map<string, string> }> {
  const loaded = await loadLiveModel(ctx, { workspace: ws.id, process: proc.id }, assumptions);
  assumptions.push(`Facts come from a run of the live model at ${REPS} replications, seed ${SEED}, with the documented default cut-offs.`);
  const run = simulate(loaded.model, REPS, SEED);
  const config = toRatingConfig({}, loaded.model.hoursPerWeek);
  const money = { ...resolveMoney({}), currency: loaded.bundle.workspace.settings.currency };
  const fp = await loadFirstPrinciples(ctx.db, proc.id, loaded.bundle.revision.id).catch(() => null);
  const successMeasures = fp?.doc ? successMeasureSource(fp.doc, proc.id) : undefined;
  const absence = absenceTest(loaded.model, { seed: SEED, weeks: config.absence.weeks, timeBudgetMs: ABSENCE_BUDGET_MS });
  if (!absence.complete) assumptions.push(`The absence test ran out of time and tested ${absence.people.length} people; key-person facts cover only those.`);
  const rate = (shadowPrices?: Record<string, number>) =>
    detectIssues(loaded.model, run, config, { processId: proc.id, absence, cost: money, ...(successMeasures ? { successMeasures } : {}), ...(shadowPrices ? { shadowPrices } : {}) });
  const roleIds = [...new Set(rate().flatMap((d) => (d.key.startsWith("capacity:") && d.roleId ? [d.roleId] : [])))];
  const shadowPrices = roleIds.length ? shadowPricesFor(loaded.model, roleIds, { reps: REPS, seed: SEED, timeBudgetMs: SHADOW_BUDGET_MS }) : undefined;
  const steps = new Map(loaded.bundle.steps.concat((loaded.bundle.otherProcesses ?? []).flatMap((o) => o.steps)).map((s) => [s.id, s.name]));
  // Worst rating first, then dearest, so a limit keeps what matters.
  const facts = rate(shadowPrices).sort((a, b) => RATINGS.indexOf(b.rating) - RATINGS.indexOf(a.rating) || compareCostsDesc(a.cost, b.cost));
  return { loaded, facts, steps };
}

export function registerFactTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_facts",
    {
      title: "Facts from the run",
      description:
        "What the simulation measures for a process's live version, as the app shows it under \"Facts from the run\": how busy each role and person is, " +
        "queues and waits, rework, missed deadlines, key-person risk (the absence test), client health and churn drivers, and whether the success measures " +
        "are met. Facts are evidence, read-only. Each has a key, a rating, its evidence sentence and a cost per month where it has one. " +
        `Rated with the app's documented default cut-offs. Worst first; up to ${DEFAULT_FACTS} by default (count says how many there are), sentences trimmed to ${MAX_FACT_TEXT} characters.`,
      inputSchema: {
        process: processArg,
        workspace: workspaceArg,
        limit: z.number().int().min(1).max(MAX_FACTS).optional().describe(`How many facts to return, worst first (default ${DEFAULT_FACTS}, at most ${MAX_FACTS}).`),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, args.process, assumptions);
        const { loaded, facts: all, steps } = await liveFacts(ctx, ws, proc, assumptions);
        const currency = loaded.bundle.workspace.settings.currency;
        const limit = args.limit ?? DEFAULT_FACTS;
        const facts = all.slice(0, limit).map((d) => ({
          key: d.key,
          type: d.type,
          rating: d.rating,
          title: d.title,
          evidence: trim(d.evidence, MAX_FACT_TEXT),
          step: d.stepId ? { id: d.stepId, name: steps.get(d.stepId) ?? null } : null,
          cost: { per_month: d.cost.perMonth, hours_per_month: d.cost.hoursPerMonth, how: trim(d.cost.method, 300), currency, estimate: true, ...(d.cost.payHidden ? { pay_hidden: true } : {}) },
        }));
        if (all.length > facts.length) assumptions.push(`Showing the worst ${facts.length} of ${all.length} facts; pass a larger limit for more.`);
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          revision: { id: loaded.bundle.revision.id, number: loaded.bundle.revision.number },
          count: all.length,
          shown: facts.length,
          facts,
        };
      }),
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "The workspace's sources (interview transcripts, notes, SOPs, data), the link to each one's original (file_url) and what each is linked to (a process, a step, an issue, a solution). " +
        `Each source's text is included up to ${MAX_SOURCE_TEXT} characters (text_truncated says when there is more). Filter by process. ` +
        `Oldest first, a page at a time (${DEFAULT_PAGE} by default): total and next_offset say when there are more.`,
      inputSchema: { process: z.string().optional().describe("Only sources linked to this process or its steps (id or name)."), workspace: workspaceArg, ...pageArgs },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        const page = pageOf(args);
        // With a process, the sources linked to it or its steps (its links first, so the page is of those sources only).
        let wanted: string[] | null = null;
        if (proc) {
          const stepIds = (await processSteps(ctx, proc)).map((s) => s.id);
          const onProcess = await ctx.db.selectFrom("source_links").select("source_id").where("workspace_id", "=", ws.id).where("process_id", "=", proc.id).execute();
          const onSteps = stepIds.length ? await ctx.db.selectFrom("source_links").select("source_id").where("workspace_id", "=", ws.id).where("step_id", "in", stepIds).execute() : [];
          wanted = [...new Set([...onProcess, ...onSteps].map((l) => l.source_id))];
        }
        if (wanted && !wanted.length) return { workspace: { id: ws.id, name: ws.name }, count: 0, ...paged(0, page, 0), sources: [] };
        const matching = ctx.db.selectFrom("sources").where("workspace_id", "=", ws.id).$if(!!wanted, (qb) => qb.where("id", "in", wanted!));
        const [rows, counted] = await Promise.all([
          matching
            .select(["id", "kind", "title", "speakers", "recorded_at", "body", "file_url", "created_at"])
            .orderBy("created_at")
            .orderBy("id")
            .limit(page.limit)
            .offset(page.offset)
            .execute(),
          matching.select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
        ]);
        const total = Number(counted.count);
        const linkRows = rows.length ? await ctx.db.selectFrom("source_links").select(["source_id", "kind", "process_id", "step_id", "issue_id", "solution_id", "insight_key"]).where("source_id", "in", rows.map((s) => s.id)).execute() : [];
        const out = rows
          .map((s) => ({
            id: s.id,
            kind: s.kind,
            title: s.title,
            speakers: s.speakers,
            recorded_at: s.recorded_at,
            file_url: s.file_url,
            text: (s.body ?? "").slice(0, MAX_SOURCE_TEXT),
            text_truncated: (s.body ?? "").length > MAX_SOURCE_TEXT,
            links: linkRows.filter((l) => l.source_id === s.id).map(({ source_id, ...l }) => (void source_id, l)),
          }));
        return { workspace: { id: ws.id, name: ws.name }, count: out.length, ...paged(total, page, out.length), sources: out };
      }),
  );

  server.registerTool(
    "list_solutions",
    {
      title: "List solutions",
      description:
        "The workspace's solutions: changed copies of a process tested against its issues, each with the issues it is for, the automatic verdict and the " +
        "team's own verdict per issue, and which steps it changed (get_process reads a process's steps). Filter by process.",
      inputSchema: { process: z.string().optional().describe("Only solutions of this process (id or name)."), workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        // Not the copied map (`steps`): it can be large, and the changed step ids say what the solution changed.
        const solutions = await ctx.db
          .selectFrom("solutions")
          .select(["id", "process_id", "base_revision_id", "name", "notes", "changed_step_ids", "lever_changes", "created_at", "updated_at"])
          .where("workspace_id", "=", ws.id)
          .$if(!!proc, (qb) => qb.where("process_id", "=", proc!.id))
          .orderBy("created_at")
          .execute();
        const ids = solutions.map((s) => s.id);
        const links = ids.length ? await ctx.db.selectFrom("solution_issues").select(["solution_id", "issue_id", "auto_verdict", "holds_pct", "auto_note", "user_verdict", "user_notes"]).where("solution_id", "in", ids).execute() : [];
        return {
          workspace: { id: ws.id, name: ws.name },
          count: solutions.length,
          solutions: solutions.map((s) => ({ ...s, issues: links.filter((l) => l.solution_id === s.id).map(({ solution_id, ...l }) => (void solution_id, l)) })),
        };
      }),
  );
}
