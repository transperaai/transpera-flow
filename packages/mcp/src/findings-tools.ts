// What an analysis needs, over the connector (issue #175, B17; decision D40): the facts the engine measures, the findings
// (AI's, proposed until someone accepts them, and those added by hand), the latest AI analysis, the sources and the
// solutions. With get_process (the model), run_scenario (runs), list_issues (issues) and get_first_principles, Claude
// outside the app can make the same assessment the app's "Analyse" makes. Every tool reads as the token's user: RLS
// decides what is visible (docs/adr/0002-mcp-acts-as-user-via-pre-request.md). Read-only. Every list is bounded: facts are
// the worst first up to a limit with their sentences trimmed, findings and sources come a page at a time with the total,
// and solutions leave out their copied maps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  FINDING_LIMITS,
  FINDING_TYPES,
  findingKey,
  labelNames,
  labelsForPeople,
  labelsUsed,
  listProcesses,
  loadFirstPrinciples,
  loadIssues,
  loadTeam,
  nameAnalysisRow,
  nameFinding,
  proposeConnectorFinding,
  readCitations,
  type FindingCitation,
  type FindingRow,
} from "@transpera-flow/db";
import { absenceTest, compareCostsDesc, detectIssues, RATINGS, resolveMoney, shadowPricesFor, simulate, successMeasureSource, toRatingConfig, type DetectedIssue } from "@transpera-flow/engine";
import { loadLiveModel, processSteps } from "./analysis-tools";
import { matchNamed } from "./analysis";
import { hasLabel, quoteIn, titleKey, unsupportedMoney } from "./finding-proposal";
import { resolveProcess, resolveWorkspace, type ProcessWithDraft, type ToolContext, type WorkspaceRef } from "./context";
import { runTool, ToolError } from "./result";

export const FINDINGS_TOOL_NAMES = ["get_facts", "list_findings", "propose_finding", "get_analysis", "list_sources", "list_solutions"] as const;

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

/**
 * The live run's facts for a process, worst first, with the names of the steps they point at. What `get_facts` returns and what
 * `propose_finding` checks a cited key against. With `payFree` the model is built as a member's browser builds it, so the
 * facts hold no pay and nothing derived from it (B20: a finding proposed over the connector is read by members).
 */
export async function liveFacts(
  ctx: ToolContext,
  ws: WorkspaceRef,
  proc: ProcessWithDraft,
  assumptions: string[],
  { payFree }: { payFree: boolean },
): Promise<{ loaded: Awaited<ReturnType<typeof loadLiveModel>>; facts: DetectedIssue[]; steps: Map<string, string> }> {
  const loaded = await loadLiveModel(ctx, { workspace: ws.id, process: proc.id }, assumptions, { payFree });
  if (!payFree) assumptions.push(`Facts come from a run of the live model at ${REPS} replications, seed ${SEED}, with the documented default cut-offs.`);
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
        const { loaded, facts: all, steps } = await liveFacts(ctx, ws, proc, assumptions, { payFree: false });
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
    "list_findings",
    {
      title: "List findings",
      description:
        "The workspace's findings: what AI or a person concluded from the facts. AI findings, proposed by the app's Analyse or by Claude over this connector (propose_finding; " +
        "proposed_via says which), are \"proposed\" until someone accepts or dismisses them in the app; " +
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
          .select("id, process_id, step_id, origin, status, rating, type, title, evidence, why, facts, person_labels, source_ids, edited, proposed_via, created_at, decided_at", { count: "exact" })
          .eq("workspace_id", ws.id)
          .in("status", statuses);
        if (proc) q = q.eq("process_id", proc.id);
        const res = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(...page.range);
        // AI text is stored with labels ("Team member A"); the token's owner gets names where they may see them (B1 2b).
        const team = await loadTeam(ctx.db, ws.id);
        const rows = (check(res) as unknown as Pick<FindingRow, "id" | "process_id" | "step_id" | "origin" | "status" | "rating" | "type" | "title" | "evidence" | "why" | "facts" | "person_labels" | "source_ids" | "edited" | "proposed_via" | "created_at" | "decided_at">[]).map((r) => nameFinding(r, team));
        const [processes, issues] = await Promise.all([listProcesses(ctx.db, ws.id), loadIssues(ctx.db, ws.id)]);
        const stepNames = new Map<string, string>();
        for (const p of processes.filter((p) => rows.some((r) => r.process_id === p.id))) for (const s of await processSteps(ctx, p)) stepNames.set(s.id, s.name);
        const issueOf = new Map(issues.flatMap((i) => (i.detected_key ? [[i.detected_key, i] as const] : [])));
        const findings = rows.map((f) => {
          const issue = issueOf.get(findingKey(f));
          return {
            id: f.id,
            origin: f.origin === "ai" ? "ai" : "by_hand",
            ...(f.origin === "ai" ? { edited_by_a_person: f.edited, proposed_via: f.proposed_via === "connector" ? "connector" : "app" } : {}),
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
    "propose_finding",
    {
      title: "Propose a finding",
      description:
        "Propose a finding for the team to review in the app: what you conclude from the facts (get_facts) and the sources (list_sources), on a process or across the company. " +
        "It arrives as proposed in the analysis review list, marked as from Claude (connector); an owner or editor accepts, edits or dismisses it. " +
        "It must cite at least one fact key or source. Write people's names as the tools show them: the app stores labels and shows each reader the names they may see. " +
        "Money in your words must be a figure from a fact you cite. Owners, editors and agency admins only.",
      inputSchema: {
        title: z.string().trim().min(1).max(FINDING_LIMITS.title).describe("What you conclude, in one line."),
        rating: z.enum(RATINGS).describe("risk, bad, good or great."),
        type: z.enum(FINDING_TYPES).describe("The kind of finding."),
        evidence: z.string().max(FINDING_LIMITS.evidence).optional().describe("What the facts and sources show."),
        why: z.string().max(FINDING_LIMITS.why).optional().describe("Why it matters."),
        process: z.string().optional().describe("Process the finding is about (id or name). Defaults to the workspace's only process."),
        company: z.boolean().optional().describe("Across the whole company instead of one process."),
        step: z.string().optional().describe("A step of the process's live version (id or name)."),
        facts: z.array(z.string().min(1)).max(FINDING_LIMITS.facts).optional().describe("Fact keys from get_facts that the finding rests on."),
        facts_from: z.string().optional().describe("For a company-wide finding: the process whose facts you cite. Defaults to the main pipeline."),
        quotes: z
          .array(z.object({ source: z.string().min(1).describe("Source id or title."), text: z.string().min(10).max(1000).describe("Word for word.") }))
          .max(10)
          .optional()
          .describe("Passages quoted word for word from a source."),
        sources: z.array(z.string().min(1)).max(FINDING_LIMITS.sources).optional().describe("Sources the finding rests on (id or title)."),
        workspace: workspaceArg,
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        // Refuse before any lookup: a caller who can't edit may not read other people, so a lookup would answer not_found (as log_issue does).
        const forbidden = new ToolError("forbidden", "You don't have permission to propose findings in this workspace (owners, editors and agency admins can).");
        const { data: canEdit, error: accessError } = await ctx.db.rpc("can_edit_workspace", { ws: ws.id });
        if (accessError || canEdit !== true) throw forbidden;

        const factKeys = [...new Set(args.facts ?? [])];
        const quotes = args.quotes ?? [];
        const evidence = args.evidence ?? "";
        const why = args.why ?? "";
        // Shape.
        if (args.company && (args.process || args.step)) throw new ToolError("invalid_input", "A company-wide finding sits on no process or step; drop process and step, or company.");
        if (args.facts_from && !args.company) throw new ToolError("invalid_input", "facts_from is for company-wide findings; a process finding cites its own process's facts");
        if (factKeys.length + quotes.length > FINDING_LIMITS.facts) {
          throw new ToolError("invalid_input", `A finding can rest on at most ${FINDING_LIMITS.facts} facts and quotes together; you gave ${factKeys.length} facts and ${quotes.length} quotes.`);
        }
        if (hasLabel([args.title, evidence, why, ...quotes.map((q) => q.text)])) {
          throw new ToolError("invalid_input", "Write people's names as get_process shows them, not \"Team member\" labels: the app labels names itself.");
        }

        // Place.
        let proc: ProcessWithDraft | null = null;
        let factsProc: ProcessWithDraft | null;
        if (args.company) {
          factsProc = args.facts_from ? await resolveProcess(ctx, ws, args.facts_from, assumptions) : factKeys.length ? await resolveProcess(ctx, ws, undefined, assumptions) : null;
        } else {
          proc = await resolveProcess(ctx, ws, args.process, assumptions);
          factsProc = proc;
        }

        // Step: of the live version only, since the facts it rests on are the live run's.
        let step: { id: string; name: string } | null = null;
        if (args.step && proc) {
          if (!proc.live_revision_id) throw new ToolError("not_found", `'${proc.name}' has no live version yet; publish it first`);
          const rows = check(await ctx.db.from("steps").select("id, name").eq("revision_id", proc.live_revision_id));
          step = matchNamed(rows, args.step, "step", ` in '${proc.name}'`);
        }

        // Sources, and the passages quoted from them.
        const sourceIds = new Set<string>();
        const quoted: { source: { id: string; name: string }; text: string }[] = [];
        if ((args.sources?.length ?? 0) + quotes.length > 0) {
          const all = check(await ctx.db.from("sources").select("id, title").eq("workspace_id", ws.id).order("created_at", { ascending: true })).map((s) => ({ id: s.id, name: s.title }));
          for (const ref of args.sources ?? []) sourceIds.add(matchNamed(all, ref, "source", ` in '${ws.name}'`).id);
          for (const q of quotes) {
            const source = matchNamed(all, q.source, "source", ` in '${ws.name}'`);
            sourceIds.add(source.id);
            quoted.push({ source, text: q.text });
          }
          if (sourceIds.size > FINDING_LIMITS.sources) throw new ToolError("invalid_input", `Cite at most ${FINDING_LIMITS.sources} sources.`);
          const needBodies = [...new Set(quoted.map((q) => q.source.id))];
          if (needBodies.length) {
            const bodies = new Map(check(await ctx.db.from("sources").select("id, body").in("id", needBodies)).map((b) => [b.id, b.body ?? ""]));
            for (const q of quoted) {
              if (!quoteIn(bodies.get(q.source.id) ?? "", q.text)) {
                throw new ToolError("quote_not_found", `That passage isn't in '${q.source.name}' word for word: ${q.text.slice(0, 80)}…`);
              }
            }
          }
        }

        // Facts: recomputed now, pay-free, so a cited key is a fact of the live run and holds no pay.
        const cited: FindingCitation[] = [];
        if (factKeys.length) {
          if (!factsProc?.live_revision_id) throw new ToolError("not_found", `'${factsProc?.name ?? "that process"}' has no live version yet; publish it first`);
          const { facts } = await liveFacts(ctx, ws, factsProc, assumptions, { payFree: true });
          assumptions.push(`Facts were checked against a fresh run of the live model at ${REPS} replications, seed ${SEED}, with pay hidden (as members see it).`);
          const byKey = new Map(facts.map((f) => [f.key, f]));
          const unknown = factKeys.filter((k) => !byKey.has(k));
          if (unknown.length) {
            throw new ToolError("unknown_fact", `Not facts of the live run of '${factsProc.name}': ${unknown.join(", ")}. get_facts lists the keys.`, facts.slice(0, 40).map((f) => ({ key: f.key })));
          }
          // The app's shape for a cited fact (apps/web/src/lib/ai/facts.ts factRefs).
          for (const k of factKeys) cited.push({ kind: "fact", key: k, text: `${byKey.get(k)!.title}. ${byKey.get(k)!.evidence}`.slice(0, 600) });
        }

        // Evidence-backed.
        if (!factKeys.length && !quotes.length && !sourceIds.size) {
          throw new ToolError("invalid_input", "Cite at least one fact (get_facts) or source (list_sources): a finding rests on evidence.");
        }

        // Pay: money in Claude's words only as a cited (pay-free) fact states it.
        const unsupported = unsupportedMoney([args.title, evidence, why], cited.map((c) => c.text));
        if (unsupported.length) {
          throw new ToolError(
            "money_not_in_facts",
            `These figures aren't in a fact you cite: ${unsupported.join(", ")}. Members and viewers get no pay data, so a finding states money only as a cited fact states it (pay-dependent costs read "—" there). Cite the fact, or leave the figure out.`,
          );
        }

        // Names: stored as labels (B1 2b); each reader gets the names they may see.
        const team = await loadTeam(ctx.db, ws.id);
        const labels = labelsForPeople(team.people);
        const lab = (text: string) => labelNames(text, labels, team.people);
        const title = lab(args.title).slice(0, FINDING_LIMITS.title);
        const storedEvidence = lab(evidence).slice(0, FINDING_LIMITS.evidence);
        const storedWhy = lab(why).slice(0, FINDING_LIMITS.why);
        const citations: FindingCitation[] = [
          ...cited.map((c) => ({ ...c, text: lab(c.text) })),
          ...quoted.map((q) => ({ kind: "quote" as const, key: (step?.name ?? q.source.name).slice(0, 300), text: lab(q.text).slice(0, 1000) })),
        ];
        const personLabels = labelsUsed([title, storedEvidence, storedWhy, ...citations.map((c) => c.text)], labels);

        // A finding with these words already waits or was accepted here, whoever wrote it (the database's key refuses a connector one for good).
        const processId = proc?.id ?? null;
        // Any proposed or accepted finding, and any connector proposal whatever its status: a person's dismissal stands (D38).
        const base = ctx.db.from("findings").select("id, title, status, origin, proposed_via").eq("workspace_id", ws.id).or("status.in.(proposed,accepted),proposed_via.eq.connector");
        const twin = check(await (processId ? base.eq("process_id", processId) : base.is("process_id", null))).find((f) => titleKey(lab(f.title)) === titleKey(title));
        if (twin) throw new ToolError("duplicate", `There's already a finding with that title here (${twin.status}${twin.status === "dismissed" ? "; a person dismissed it, and that stands" : ""}).`, [{ id: twin.id, status: twin.status }]);

        const written = await proposeConnectorFinding(ctx.db, {
          workspaceId: ws.id,
          processId,
          stepId: step?.id ?? null,
          rating: args.rating,
          type: args.type,
          title,
          evidence: storedEvidence,
          why: storedWhy,
          facts: citations,
          sourceIds: [...sourceIds],
          personLabels,
        });
        if (written.status === "duplicate") {
          throw new ToolError("duplicate", "Claude proposed this here before; a person has it already (it may have been accepted or dismissed). list_findings shows it.");
        }
        if (written.status === "limit") throw new ToolError("rate_limited", written.message);
        if (written.status === "forbidden") throw forbidden;
        if (written.status === "invalid") throw new ToolError("invalid_input", written.message);
        if (written.status === "error") throw new ToolError("write_failed", written.message);

        const f = nameFinding(written.finding, team);
        return {
          workspace: { id: ws.id, name: ws.name },
          finding: {
            id: f.id,
            status: "proposed",
            origin: "ai",
            proposed_via: "connector",
            rating: f.rating,
            type: f.type,
            title: f.title,
            evidence: f.evidence,
            why: f.why,
            process: proc ? { id: proc.id, name: proc.name } : null,
            across_the_company: !proc,
            step: step ?? null,
            rests_on: readCitations(f.facts),
            source_ids: f.source_ids,
            created_at: f.created_at,
          },
          review: `Waiting for review on ${proc ? `${proc.name}'s page` : "the Overview"}. An owner or editor accepts, edits or dismisses it.`,
        };
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
            .select("id, revision_id, status, reason, summary, review, person_labels, checked, dropped, model, model_hash, updated_at")
            .eq("process_id", target.id)
            .order("updated_at", { ascending: false })
            .limit(1),
        );
        // Stored with labels; named for the token's owner (B1 2b). The insights aren't returned here (they're findings).
        const row = rows[0] ? nameAnalysisRow({ ...rows[0], insights: [] }, await loadTeam(ctx.db, ws.id)) : undefined;
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
