// What an analysis needs, over the connector (issue #175, B17; decision D40): the facts the engine measures, the findings
// (AI's, proposed until someone accepts them, and those added by hand), the latest AI analysis, the sources and the
// solutions. With get_process (the model), run_scenario (runs), list_issues (issues) and get_first_principles, Claude
// outside the app can make the same assessment the app's "Analyse" makes. Every tool reads as the token's user: RLS
// decides what is visible (docs/adr/0002-mcp-acts-as-user-via-pre-request.md). Read-only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findingKey, listProcesses, loadFirstPrinciples, loadIssues, readCitations, type FindingRow } from "@transpera-flow/db";
import { absenceTest, detectIssues, resolveMoney, shadowPricesFor, simulate, successMeasureSource, toRatingConfig } from "@transpera-flow/engine";
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
        "Rated with the app's documented default cut-offs.",
      inputSchema: { process: processArg, workspace: workspaceArg },
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
        const facts = rate(shadowPrices).map((d) => ({
          key: d.key,
          type: d.type,
          rating: d.rating,
          title: d.title,
          evidence: d.evidence,
          step: d.stepId ? { id: d.stepId, name: steps.get(d.stepId) ?? null } : null,
          cost: { ...d.cost, currency, estimate: true },
        }));
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          revision: { id: loaded.bundle.revision.id, number: loaded.bundle.revision.number },
          count: facts.length,
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
        "the facts and quotes it rests on, and the issue it became if someone acknowledged it. Default: proposed and accepted.",
      inputSchema: {
        status: z.array(z.enum(["proposed", "accepted", "dismissed", "superseded"])).optional().describe("Which statuses to list (default proposed and accepted)."),
        process: z.string().optional().describe("Only findings in this process (id or name)."),
        workspace: workspaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        const statuses = args.status?.length ? args.status : ["proposed", "accepted"];
        if (!args.status) assumptions.push("status defaulted to proposed and accepted.");
        let q = ctx.db.from("findings").select("*").eq("workspace_id", ws.id).in("status", statuses).order("created_at", { ascending: true });
        if (proc) q = q.eq("process_id", proc.id);
        const rows = check(await q) as unknown as FindingRow[];
        const [processes, issues] = await Promise.all([listProcesses(ctx.db, ws.id), loadIssues(ctx.db, ws.id)]);
        const stepNames = new Map<string, string>();
        for (const p of processes.filter((p) => rows.some((r) => r.process_id === p.id))) for (const s of await processSteps(ctx, p)) stepNames.set(s.id, s.name);
        const issueOf = new Map(issues.flatMap((i) => (i.detected_key ? [[i.detected_key, i] as const] : [])));
        const findings = rows.map((f) => {
          const issue = issueOf.get(findingKey(f));
          return {
            id: f.id,
            origin: f.origin === "ai" ? "ai" : "by_hand",
            status: f.status,
            rating: f.rating,
            type: f.type,
            title: f.title,
            evidence: f.evidence,
            why: f.why,
            process: f.process_id ? { id: f.process_id, name: processes.find((p) => p.id === f.process_id)?.name ?? null } : null,
            across_the_company: f.process_id === null,
            step: f.step_id ? { id: f.step_id, name: stepNames.get(f.step_id) ?? null } : null,
            rests_on: readCitations(f.facts),
            source_ids: f.source_ids,
            issue: issue ? { id: issue.id, number: issue.number, status: issue.status } : null,
            created_at: f.created_at,
            decided_at: f.decided_at,
          };
        });
        return { workspace: { id: ws.id, name: ws.name }, count: findings.length, findings };
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
        `Each source's text is included up to ${MAX_SOURCE_TEXT} characters (text_truncated says when there is more). Filter by process.`,
      inputSchema: { process: z.string().optional().describe("Only sources linked to this process or its steps (id or name)."), workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        const [sources, links] = await Promise.all([
          ctx.db.from("sources").select("id, kind, title, speakers, recorded_at, body, created_at").eq("workspace_id", ws.id).order("created_at", { ascending: true }),
          ctx.db.from("source_links").select("source_id, kind, process_id, step_id, issue_id, solution_id, insight_key").eq("workspace_id", ws.id),
        ]);
        const linkRows = check(links);
        let wanted: Set<string> | null = null;
        if (proc) {
          const stepIds = new Set((await processSteps(ctx, proc)).map((s) => s.id));
          wanted = new Set(linkRows.filter((l) => l.process_id === proc.id || (l.step_id && stepIds.has(l.step_id))).map((l) => l.source_id));
        }
        const out = check(sources)
          .filter((s) => !wanted || wanted.has(s.id))
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
        return { workspace: { id: ws.id, name: ws.name }, count: out.length, sources: out };
      }),
  );

  server.registerTool(
    "list_solutions",
    {
      title: "List solutions",
      description:
        "The workspace's solutions: changed copies of a process tested against its issues, each with the issues it is for, the automatic verdict and the " +
        "team's own verdict per issue. Filter by process.",
      inputSchema: { process: z.string().optional().describe("Only solutions of this process (id or name)."), workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        let q = ctx.db.from("solutions").select("*").eq("workspace_id", ws.id).order("created_at", { ascending: true });
        if (proc) q = q.eq("process_id", proc.id);
        const solutions = check(await q) as unknown as { id: string; process_id: string; name: string }[];
        const ids = solutions.map((s) => s.id);
        const links = ids.length ? (check(await ctx.db.from("solution_issues").select("*").in("solution_id", ids)) as unknown as { solution_id: string }[]) : [];
        return {
          workspace: { id: ws.id, name: ws.name },
          count: solutions.length,
          solutions: solutions.map((s) => ({ ...s, issues: links.filter((l) => l.solution_id === s.id) })),
        };
      }),
  );
}
