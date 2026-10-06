// What an analysis needs, over the connector (issue #175, B17; decision D40): the facts the engine measures, the findings
// (AI's, proposed until someone accepts them, and those added by hand), the latest AI analysis, the sources and the
// solutions. With get_process (the model), run_scenario (runs), list_issues (issues) and get_first_principles, Claude
// outside the app can make the same assessment the app's "Analyse" makes. Every tool reads as the token's user: RLS
// decides what is visible (docs/adr/0002-mcp-acts-as-user-via-pre-request.md). Read-only. Every list is bounded: facts are
// the worst first up to a limit with their sentences trimmed, findings and sources come a page at a time with the total,
// and solutions leave out their copied maps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findingKey, listProcesses, loadFirstPrinciples, loadIssues, readCitations, type FindingRow } from "@transpera-flow/db";
import { absenceTest, compareCostsDesc, detectIssues, RATINGS, resolveMoney, shadowPricesFor, simulate, successMeasureSource, toRatingConfig } from "@transpera-flow/engine";
import { loadLiveModel, processSteps } from "./analysis-tools";
import { resolveProcess, resolveWorkspace, type ToolContext } from "./context";
import { runTool, ToolError } from "./result";

export const FINDINGS_TOOL_NAMES = ["get_facts", "list_findings", "get_analysis", "list_sources", "list_solutions"] as const;

const REPS = 30;
const SEED = 1;
/** Time caps on the extra runs, as list_issues has them. */
const ABSENCE_BUDGET_MS = 5000;
const SHADOW_BUDGET_MS = 5000;
const MAX_SOURCE_TEXT = 4000;
/** How much one call returns: facts listed, a fact's sentences, and a page of findings or sources. */
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
  return { limit, offset, range: [offset, offset + limit - 1] as const };
}
const paged = (total: number, page: { limit: number; offset: number }, shown: number) => ({
  total,
  offset: page.offset,
  limit: page.limit,
  next_offset: page.offset + shown < total ? page.offset + shown : null,
});

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");

function check<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

export function registerFindingsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_facts",
    {
      title: "Facts from the run",
      description:
        "What the simulation measures for a process's live version, as the app shows it under \"Facts from the run\": how busy each role and person is, " +
        "queues and waits, rework, missed deadlines, key-person risk (the absence test), client health and churn drivers, and whether the success measures " +
        "are met. Facts are evidence, not findings. Each has a key (what a finding cites), a rating, its evidence sentence and a cost per month where it has one. " +
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
        const loaded = await loadLiveModel(ctx, { workspace: ws.id, process: proc.id }, assumptions);
        assumptions.push(`Facts come from a run of the live model at ${REPS} replications, seed ${SEED}, with the documented default cut-offs.`);
        const run = simulate(loaded.model, REPS, SEED);
        const config = toRatingConfig({}, loaded.model.hoursPerWeek);
        const currency = loaded.bundle.workspace.settings.currency;
        const money = { ...resolveMoney({}), currency };
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
        const all = rate(shadowPrices).sort((a, b) => RATINGS.indexOf(b.rating) - RATINGS.indexOf(a.rating) || compareCostsDesc(a.cost, b.cost));
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
    "list_findings",
    {
      title: "List findings",
      description:
        "The workspace's findings: what AI or a person concluded from the facts. AI findings are \"proposed\" until someone accepts or dismisses them in the app; " +
        "findings added by hand are \"accepted\". Each has a rating, where it sits (a process, or across the company), a step, its evidence, why it matters, " +
        "the facts and quotes it rests on, and the issue it became if someone acknowledged it. Default: proposed and accepted. " +
        `Oldest first, a page at a time (${DEFAULT_PAGE} by default): total and next_offset say when there are more.`,
      inputSchema: {
        status: z.array(z.enum(["proposed", "accepted", "dismissed", "superseded"])).optional().describe("Which statuses to list (default proposed and accepted)."),
        process: z.string().optional().describe("Only findings in this process (id or name)."),
        workspace: workspaceArg,
        ...pageArgs,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        const statuses = args.status?.length ? args.status : ["proposed", "accepted"];
        if (!args.status) assumptions.push("status defaulted to proposed and accepted.");
        const page = pageOf(args);
        let q = ctx.db
          .from("findings")
          .select("id, process_id, step_id, origin, status, rating, type, title, evidence, why, facts, source_ids, edited, created_at, decided_at", { count: "exact" })
          .eq("workspace_id", ws.id)
          .in("status", statuses);
        if (proc) q = q.eq("process_id", proc.id);
        const res = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(...page.range);
        const rows = check(res) as unknown as Pick<FindingRow, "id" | "process_id" | "step_id" | "origin" | "status" | "rating" | "type" | "title" | "evidence" | "why" | "facts" | "source_ids" | "edited" | "created_at" | "decided_at">[];
        const [processes, issues] = await Promise.all([listProcesses(ctx.db, ws.id), loadIssues(ctx.db, ws.id)]);
        const stepNames = new Map<string, string>();
        for (const p of processes.filter((p) => rows.some((r) => r.process_id === p.id))) for (const s of await processSteps(ctx, p)) stepNames.set(s.id, s.name);
        const issueOf = new Map(issues.flatMap((i) => (i.detected_key ? [[i.detected_key, i] as const] : [])));
        const findings = rows.map((f) => {
          const issue = issueOf.get(findingKey(f));
          return {
            id: f.id,
            origin: f.origin === "ai" ? "ai" : "by_hand",
            ...(f.origin === "ai" ? { edited_by_a_person: f.edited } : {}),
            status: f.status,
            rating: f.rating,
            type: f.type,
            title: f.title,
            evidence: f.evidence,
            why: f.why,
            process: f.process_id ? { id: f.process_id, name: processes.find((p) => p.id === f.process_id)?.name ?? null } : null,
            across_the_company: f.process_id === null,
            step: f.step_id ? { id: f.step_id, name: stepNames.get(f.step_id) ?? null } : null,
            rests_on: readCitations(f.facts).map((c) => ({ ...c, text: trim(c.text, MAX_FACT_TEXT) })),
            source_ids: f.source_ids,
            issue: issue ? { id: issue.id, number: issue.number, status: issue.status } : null,
            created_at: f.created_at,
            decided_at: f.decided_at,
          };
        });
        return { workspace: { id: ws.id, name: ws.name }, count: findings.length, ...paged(res.count ?? findings.length, page, findings.length), findings };
      }),
  );

  server.registerTool(
    "get_analysis",
    {
      title: "Latest AI analysis",
      description:
        "The latest AI analysis the app stored for a process, or for the whole company (company: true): its read (paragraphs), its review of the first " +
        "principles, the model that wrote it, when, how many numbers were checked against the run, and the version it read. The findings it proposed are in list_findings.",
      inputSchema: { process: processArg, company: z.boolean().optional().describe("The analysis of the whole company instead of one process."), workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        let target: { id: string; name: string };
        if (args.company) {
          const company = (await listProcesses(ctx.db, ws.id, { includeCompany: true })).find((p) => p.is_company);
          if (!company) throw new ToolError("not_found", "This workspace has no company map yet.");
          target = { id: company.id, name: "The whole company" };
        } else {
          const proc = await resolveProcess(ctx, ws, args.process, assumptions);
          target = { id: proc.id, name: proc.name };
        }
        const rows = check(
          await ctx.db
            .from("ai_analyses")
            .select("id, revision_id, status, reason, summary, review, checked, dropped, model, model_hash, updated_at")
            .eq("process_id", target.id)
            .order("updated_at", { ascending: false })
            .limit(1),
        );
        const row = rows[0];
        if (!row) return { workspace: { id: ws.id, name: ws.name }, scope: target, analysis: null, note: "Nobody has analysed this yet: someone presses Analyse in the app." };
        const revision = check(await ctx.db.from("process_revisions").select("number").eq("id", row.revision_id).maybeSingle()) as { number: number } | null;
        return {
          workspace: { id: ws.id, name: ws.name },
          scope: target,
          analysis: {
            id: row.id,
            status: row.status,
            reason: row.reason,
            read: row.summary,
            review: row.review,
            numbers_checked: row.checked,
            items_dropped: row.dropped,
            model: row.model,
            written_at: row.updated_at,
            version: revision?.number ?? null,
          },
        };
      }),
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "The workspace's sources (interview transcripts, notes, SOPs, data) and what each is linked to (a process, a step, an issue, a solution). " +
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
          const onProcess = check(await ctx.db.from("source_links").select("source_id").eq("workspace_id", ws.id).eq("process_id", proc.id));
          const onSteps = stepIds.length ? check(await ctx.db.from("source_links").select("source_id").eq("workspace_id", ws.id).in("step_id", stepIds)) : [];
          wanted = [...new Set([...onProcess, ...onSteps].map((l) => l.source_id))];
        }
        if (wanted && !wanted.length) return { workspace: { id: ws.id, name: ws.name }, count: 0, ...paged(0, page, 0), sources: [] };
        let q = ctx.db.from("sources").select("id, kind, title, speakers, recorded_at, body, created_at", { count: "exact" }).eq("workspace_id", ws.id);
        if (wanted) q = q.in("id", wanted);
        const res = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(...page.range);
        const rows = check(res);
        const linkRows = rows.length ? check(await ctx.db.from("source_links").select("source_id, kind, process_id, step_id, issue_id, solution_id, insight_key").in("source_id", rows.map((s) => s.id))) : [];
        const out = rows
          .map((s) => ({
            id: s.id,
            kind: s.kind,
            title: s.title,
            speakers: s.speakers,
            recorded_at: s.recorded_at,
            text: (s.body ?? "").slice(0, MAX_SOURCE_TEXT),
            text_truncated: (s.body ?? "").length > MAX_SOURCE_TEXT,
            links: linkRows.filter((l) => l.source_id === s.id).map(({ source_id, ...l }) => (void source_id, l)),
          }));
        return { workspace: { id: ws.id, name: ws.name }, count: out.length, ...paged(res.count ?? out.length, page, out.length), sources: out };
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
        let q = ctx.db.from("solutions").select("id, process_id, base_revision_id, name, notes, changed_step_ids, lever_changes, created_at, updated_at").eq("workspace_id", ws.id).order("created_at", { ascending: true });
        if (proc) q = q.eq("process_id", proc.id);
        const solutions = check(await q);
        const ids = solutions.map((s) => s.id);
        const links = ids.length ? check(await ctx.db.from("solution_issues").select("solution_id, issue_id, auto_verdict, holds_pct, auto_note, user_verdict, user_notes").in("solution_id", ids)) : [];
        return {
          workspace: { id: ws.id, name: ws.name },
          count: solutions.length,
          solutions: solutions.map((s) => ({ ...s, issues: links.filter((l) => l.solution_id === s.id).map(({ solution_id, ...l }) => (void solution_id, l)) })),
        };
      }),
  );
}
