// Company-model tools (docs/PRD.md §7.1, §7.1c, decision D19; issue #25):
// set_company, upsert_service, upsert_person, upsert_client, upsert_role and
// set_demand create suggestions and change nothing else; list_suggestions reads them.
// A person accepts or rejects each one on the app's Suggestions page. The
// database backs this up: an API-token request can't write the company-model
// tables or review suggestions (migration 20261015000000_suggestions.sql).
// Like every tool, these act as the token's user under RLS
// (docs/adr/0018-mcp-tokens-checked-in-app-code.md).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  describeSuggestion,
  isVisibleIssue,
  loadBlocks,
  loadAiSettings,
  loadCompanyModel,
  loadIssues,
  loadProposals,
  loadSuggestions,
  type CompanyModel,
  type EvidenceCitation,
  type IssueLinkRef,
  type Json,
  type ProposalRow,
  type SuggestionRow,
} from "@transpera-flow/db";
import { ISSUE_TYPES, RATINGS, storedOfRating } from "@transpera-flow/engine";
import { matchNamed } from "./analysis";
import { processSteps } from "./analysis-tools";
import { resolveProcess, resolveWorkspace, type ToolContext, type WorkspaceRef } from "./context";
import { buildIssueProposal, buildSolutionIdeaProposal, matchIssue, MAX_PROPOSED_STEPS, requireSwitch, type ProposalInsert } from "./proposing";
import { runTool, ToolError } from "./result";
import {
  buildClientSuggestion,
  buildCompanySuggestion,
  buildDemandSuggestions,
  buildPersonSuggestion,
  buildRoleSuggestion,
  buildServiceSuggestion,
  type Built,
} from "./suggesting";

export const SUGGESTION_TOOL_NAMES = [
  "set_company",
  "upsert_service",
  "upsert_person",
  "upsert_client",
  "upsert_role",
  "set_demand",
  "list_suggestions",
  "propose_issue",
  "propose_solution_idea",
  "list_proposals",
] as const;

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO date (YYYY-MM-DD)");
const share = z.number().min(0).max(1);

const evidenceArg = z
  .array(
    z
      .object({
        source_id: z.string().uuid().describe("A source's id (add_source, or the Sources page)"),
        speaker: z.string().max(200).optional(),
        quote: z.string().trim().min(1).max(2000).describe("The speaker's words, verbatim"),
        timestamp: z.string().max(50).optional().describe("Where in the source, e.g. 00:12:40"),
        value: z.number().optional().describe("The number they stated, in the field's units"),
      })
      .strict(),
  )
  .max(20)
  .optional()
  .describe("Citations for the values: who said what, and where. Accepted values keep them as provenance.");
const noteArg = z.string().max(2000).optional().describe("Your reasoning, shown to the reviewer and kept with the value.");
const nameRefArg = (kind: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(`The ${kind}'s exact name or id to update, or a new name to add one. A name that only partly matches is refused with the candidates.`);
const createArg = z.boolean().optional().describe("Add a new row even though the name partly matches existing ones.");
const renameArg = z.string().trim().min(1).max(200).optional().describe("A new name for an existing row.");

const companySettings = {
  hours_per_week: z.number().positive().max(168).optional(),
  working_days: z.number().int().min(1).max(7).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "an ISO currency code such as GBP").optional(),
  fy_start: z.string().max(20).optional().describe("Month the financial year starts, e.g. April"),
  overhead_monthly: z.number().min(0).optional(),
  target_margin: share.optional(),
  overtime_cap: share.optional().describe("Overtime allowed as a share of capacity (0.1 = 10%)"),
  availability_floor: share.optional().describe("Minimum share of a week left for pipeline work"),
  utilisation_threshold: share.optional(),
  capacity_factor_enabled: z.boolean().optional(),
  horizon_weeks: z.number().int().min(1).max(104).optional(),
};

type DbError = { code?: string; message?: string };

const SUGGESTION_FIELDS = ["id", "workspace_id", "target_table", "target_id", "patch", "evidence", "note", "status", "created_via", "import_source", "applied", "review_note", "reviewed_by", "reviewed_at", "created_at", "created_by"] as const;
const PROPOSAL_FIELDS = ["id", "workspace_id", "kind", "title", "detail", "payload", "evidence", "note", "issue_id", "status", "created_via", "import_source", "proposer_name", "share_link_id", "applied", "review_note", "reviewed_by", "reviewed_at", "created_at", "created_by"] as const;

/** Evidence must cite this workspace's sources. */
async function checkSources(ctx: ToolContext, ws: WorkspaceRef, evidence: EvidenceCitation[]): Promise<void> {
  const ids = [...new Set(evidence.map((e) => e.source_id))];
  if (!ids.length) return;
  const found = (await ctx.db.selectFrom("sources").select("id").where("workspace_id", "=", ws.id).where("id", "in", ids).execute()).map((r) => r.id);
  const missing = ids.filter((id) => !found.includes(id));
  if (missing.length) throw new ToolError("not_found", `No source in '${ws.name}' has the id ${missing.join(", ")}; add it with add_source first`);
}

const headlineOf = (s: SuggestionRow, model: CompanyModel) => {
  const v = describeSuggestion(s, model);
  return { subject: v.subject, headline: v.headline, changes: v.changes, missing: v.missing };
};

/** Store the suggestions a builder made, as the user, and describe them. */
async function store(ctx: ToolContext, ws: WorkspaceRef, model: CompanyModel, built: Built) {
  await checkSources(ctx, ws, built.proposals.flatMap((p) => p.evidence));
  let rows: SuggestionRow[] = [];
  if (built.proposals.length) {
    let data: unknown;
    try {
      data = await ctx.db
        .insertInto("suggestions")
        .values(
          built.proposals.map((p) => ({
            workspace_id: ws.id,
            target_table: p.target_table,
            target_id: p.target_id,
            patch: p.patch as unknown as Json,
            // A JSON array: node-postgres would send a JS array as a Postgres array.
            evidence: JSON.stringify(p.evidence) as unknown as Json,
            note: p.note,
          })),
        )
        .returning([...SUGGESTION_FIELDS])
        .execute();
    } catch (e) {
      const error = e as DbError;
      if (error.code === "42501") throw new ToolError("forbidden", "You don't have permission to suggest changes in this workspace (editors and owners can).");
      if (error.code === "23514") throw new ToolError("invalid_input", `Some of those values aren't allowed: ${error.message}`);
      throw new ToolError("write_failed", `Couldn't save the suggestion: ${error.message}`);
    }
    rows = data as unknown as SuggestionRow[];
  }
  return {
    workspace: { id: ws.id, name: ws.name },
    suggestions: rows.map((r) => ({ id: r.id, status: r.status, target_table: r.target_table, target_id: r.target_id, ...headlineOf(r, model) })),
    unchanged: built.unchanged,
    message: rows.length
      ? `Created ${rows.length} suggestion${rows.length === 1 ? "" : "s"}. Nothing changes until someone accepts ${rows.length === 1 ? "it" : "them"} on the workspace's Suggestions page.`
      : "Nothing to suggest: the model already has those values.",
  };
}

/** Store one proposal, as the user, and describe it. */
async function storeProposal(ctx: ToolContext, ws: WorkspaceRef, p: ProposalInsert, what: string) {
  await checkSources(ctx, ws, p.evidence);
  let data: unknown;
  try {
    data = await ctx.db
      .insertInto("suggestion_proposals")
      .values({
        workspace_id: ws.id,
        kind: p.kind,
        title: p.title,
        detail: p.detail,
        payload: p.payload as unknown as Json,
        // A JSON array: node-postgres would send a JS array as a Postgres array.
        evidence: JSON.stringify(p.evidence) as unknown as Json,
        note: p.note,
        issue_id: p.issue_id,
      })
      .returning([...PROPOSAL_FIELDS])
      .executeTakeFirstOrThrow();
  } catch (e) {
    const error = e as DbError;
    if (error.code === "42501") throw new ToolError("forbidden", "You don't have permission to propose changes in this workspace (editors and owners can).");
    if (error.code === "23514") throw new ToolError("invalid_input", `Some of those values aren't allowed: ${error.message}`);
    if (error.code === "23503") throw new ToolError("not_found", "The issue this idea is for no longer exists.");
    throw new ToolError("write_failed", `Couldn't save the proposal: ${error.message}`);
  }
  const row = data as unknown as ProposalRow;
  return {
    workspace: { id: ws.id, name: ws.name },
    proposal: { id: row.id, kind: row.kind, status: row.status, title: row.title, issue_id: row.issue_id },
    message: `Proposed ${what}. Nothing is created until someone ${row.kind === "issue" ? "accepts it" : "builds it"} on the workspace's Suggestions page.`,
  };
}

async function load(ctx: ToolContext, workspace: string | undefined, assumptions: string[]) {
  const ws = await resolveWorkspace(ctx, workspace, assumptions);
  return { ws, model: await loadCompanyModel(ctx.db, ws) };
}

export function registerSuggestionTools(server: McpServer, ctx: ToolContext): void {
  const suggestionNote = " Creates a suggestion for a person to accept or reject in the app; changes no live data.";

  server.registerTool(
    "set_company",
    {
      title: "Suggest company settings",
      description: "Suggest changes to the company settings (working hours, currency, overhead, overtime cap, availability floor …)." + suggestionNote,
      inputSchema: { ...companySettings, evidence: evidenceArg, note: noteArg, workspace: workspaceArg },
    },
    ({ evidence, note, workspace, ...settings }) =>
      runTool(async (assumptions) => {
        if (!Object.values(settings).some((v) => v !== undefined)) throw new ToolError("invalid_input", "Give at least one setting to change");
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildCompanySuggestion(model, settings, { evidence, note }));
      }),
  );

  server.registerTool(
    "upsert_service",
    {
      title: "Suggest a service",
      description: "Suggest a new service (engagement type) or changes to one: pricing, price, margin, tenure, churn and mix." + suggestionNote,
      inputSchema: {
        name: nameRefArg("service"),
        rename: renameArg,
        create: createArg,
        pricing_model: z.enum(["retainer", "one_off", "hourly"]).optional(),
        price: z.number().min(0).optional().describe("Monthly fee (retainer), whole fee (one-off) or hourly rate"),
        margin: share.optional().describe("Gross margin as a share of price"),
        tenure_months: z.number().min(0).optional(),
        churn_monthly_base: share.optional(),
        mix_share: z.number().min(0).optional().describe("Relative share of new work"),
        active: z.boolean().optional(),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    ({ workspace, ...args }) =>
      runTool(async (assumptions) => {
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildServiceSuggestion(model, args, assumptions));
      }),
  );

  server.registerTool(
    "upsert_role",
    {
      title: "Suggest a role",
      description:
        "Suggest a new role (a kind of work: steps, people and client assignments name roles) or a new name for one." + suggestionNote,
      inputSchema: {
        name: nameRefArg("role"),
        rename: renameArg,
        create: createArg,
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    ({ workspace, ...args }) =>
      runTool(async (assumptions) => {
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildRoleSuggestion(model, args, assumptions));
      }),
  );

  server.registerTool(
    "upsert_person",
    {
      title: "Suggest a person",
      description:
        "Suggest a new person or changes to one: roles (the full set, by name), FTE, capacity, cost rate, dates and leave to add." + suggestionNote,
      inputSchema: {
        name: nameRefArg("person"),
        rename: renameArg,
        create: createArg,
        roles: z.array(z.string().min(1)).max(20).optional().describe("Every role they hold, by name or id (replaces their roles)"),
        fte: z.number().positive().max(1.5).optional(),
        capacity_hours_week: z.number().positive().max(168).nullable().optional().describe("Null: FTE × the workspace's hours a week"),
        cost_rate: z.number().min(0).nullable().optional().describe("Hourly cost"),
        email: z.string().email().nullable().optional(),
        start_date: date.nullable().optional(),
        end_date: date.nullable().optional(),
        active: z.boolean().optional(),
        leave: z
          .array(z.object({ start_date: date, end_date: date, note: z.string().max(200).optional() }).strict())
          .max(50)
          .optional()
          .describe("Leave periods to add (inclusive dates)"),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    ({ workspace, ...args }) =>
      runTool(async (assumptions) => {
        for (const l of args.leave ?? []) if (l.end_date < l.start_date) throw new ToolError("invalid_input", "Leave ends before it starts");
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildPersonSuggestion(model, args, assumptions));
      }),
  );

  server.registerTool(
    "upsert_client",
    {
      title: "Suggest a client",
      description:
        "Suggest a new client or changes to one: services (the full set, by name), MRR, start date, health and who looks after them per role." +
        suggestionNote,
      inputSchema: {
        name: nameRefArg("client"),
        rename: renameArg,
        create: createArg,
        services: z.array(z.string().min(1)).max(20).optional().describe("Every service they take, by name or id (replaces their services)"),
        mrr: z.number().min(0).optional().describe("Monthly recurring revenue"),
        start_date: date.nullable().optional(),
        health: z.number().min(0).max(100).nullable().optional().describe("0–100"),
        notes: z.string().max(2000).nullable().optional(),
        active: z.boolean().optional(),
        assignments: z
          .record(z.string(), z.string().nullable())
          .optional()
          .describe("Role → person, by name or id, e.g. {\"SEO specialist\": \"Sam Patel\"}; null clears the role"),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    ({ workspace, ...args }) =>
      runTool(async (assumptions) => {
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildClientSuggestion(model, args, assumptions));
      }),
  );

  server.registerTool(
    "set_demand",
    {
      title: "Suggest demand",
      description:
        "Suggest demand changes: lead sources (added or changed, by name), seasonality multipliers and monthly growth. Each change becomes its own suggestion." +
        suggestionNote,
      inputSchema: {
        lead_sources: z
          .array(
            z
              .object({
                name: nameRefArg("lead source"),
                rename: renameArg,
                create: createArg,
                volume_week: z.number().min(0).optional().describe("Leads a week"),
                conversion_to_qualified: share.optional().describe("Share that become qualified leads"),
                evidence: evidenceArg,
                note: noteArg,
              })
              .strict(),
          )
          .max(50)
          .optional(),
        seasonality: z
          .union([
            z.array(z.number().min(0).max(100)).length(12),
            z.array(z.object({ month: z.number().int().min(1).max(12), multiplier: z.number().min(0).max(100) }).strict()).min(1).max(12),
          ])
          .optional()
          .describe("Twelve monthly multipliers (January first), or [{month, multiplier}] for the months to change; 1 is no effect"),
        growth_monthly: z.number().gt(-1).max(10).optional().describe("Compound change in demand a month (0.02 = +2%)"),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    ({ workspace, ...args }) =>
      runTool(async (assumptions) => {
        if (!args.lead_sources?.length && !args.seasonality && args.growth_monthly === undefined) {
          throw new ToolError("invalid_input", "Give lead_sources, seasonality or growth_monthly");
        }
        const { ws, model } = await load(ctx, workspace, assumptions);
        return store(ctx, ws, model, buildDemandSuggestions(model, args, assumptions));
      }),
  );

  server.registerTool(
    "list_suggestions",
    {
      title: "List suggestions",
      description: "Suggested company-model changes and whether a person has accepted or rejected them, newest first.",
      inputSchema: { status: z.enum(["pending", "accepted", "rejected"]).optional(), workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    ({ status, workspace }) =>
      runTool(async (assumptions) => {
        const { ws, model } = await load(ctx, workspace, assumptions);
        const rows = await loadSuggestions(ctx.db, ws.id, status);
        return {
          workspace: { id: ws.id, name: ws.name },
          suggestions: rows.map((r) => ({
            id: r.id,
            status: r.status,
            target_table: r.target_table,
            target_id: r.target_id,
            ...headlineOf(r, model),
            evidence: r.evidence,
            note: r.note,
            created_at: r.created_at,
            reviewed_at: r.reviewed_at,
            review_note: r.review_note,
          })),
        };
      }),
  );

  const proposalNote = " Creates a proposal for a person to review on the Suggestions page; it never writes an issue or a solution.";

  server.registerTool(
    "propose_issue",
    {
      title: "Propose an issue",
      description:
        "Propose a new issue (a problem worth tracking) for a person to accept or reject. Accepting logs it in the issues register like an acknowledged insight; rejecting drops it. " +
        "Use log_issue only when told to log one directly." +
        proposalNote,
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe("The problem, in plain words, e.g. 'Ad-hoc requests wait 20 h for an SEO specialist'"),
        detail: z.string().max(5000).optional().describe("What was seen or said, and where. Shown on the card and kept as the issue's evidence."),
        rating: z.enum(RATINGS).optional().describe("great, good (could improve), bad (not urgent) or risk (operational risk). Default good."),
        type: z.enum(ISSUE_TYPES).optional().describe("Default manual."),
        process: z.string().optional().describe("The process it touches (id or name)."),
        steps: z.array(z.string().min(1)).max(20).optional().describe("Steps of that process it touches (ids or names). Without steps it touches the whole process."),
        target_measure: z.string().max(200).optional().describe("What would be measured, e.g. 'Wait at Ad-hoc requests'"),
        target_now: z.string().max(200).optional().describe("Where it is now, e.g. '20 h'"),
        target_goal: z.string().max(200).optional().describe("Where it should be, e.g. 'under 8 h'"),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        requireSwitch(await loadAiSettings(ctx.db, ws.id), "suggest_issues");
        let links: IssueLinkRef[] = [];
        if (args.process || args.steps?.length) {
          const proc = await resolveProcess(ctx, ws, args.process, assumptions);
          if (args.steps?.length) {
            const known = await processSteps(ctx, proc);
            links = args.steps.map((s) => ({ process_id: proc.id, step_id: matchNamed(known, s, "step", ` in '${proc.name}'`).id }));
          } else {
            links = [{ process_id: proc.id, step_id: null }];
          }
        }
        if (!args.rating) assumptions.push("rating defaulted to good (could improve).");
        const built = buildIssueProposal({
          title: args.title,
          detail: args.detail,
          severity: storedOfRating(args.rating ?? "good"),
          type: args.type,
          links,
          target_measure: args.target_measure,
          target_now: args.target_now,
          target_goal: args.target_goal,
          evidence: args.evidence,
          note: args.note,
        });
        return storeProposal(ctx, ws, built, "an issue");
      }),
  );

  server.registerTool(
    "propose_solution_idea",
    {
      title: "Propose a solution idea",
      description:
        "Propose an idea for solving an issue, as the steps you would place (in order, each leading to the next), optionally from library blocks. " +
        "It is not built and not simulated: a person builds it in the Editor (or dismisses it)." +
        proposalNote,
      inputSchema: {
        issue: z.string().min(1).describe("The issue it is for: its number (12 or #12), id or title. It must be open or being tested."),
        title: z.string().trim().min(1).max(200).describe("The idea in a line, e.g. 'Fast-track partner leads past Check fit'"),
        detail: z.string().max(5000).optional().describe("The idea in plain words: what changes and why it should help."),
        steps: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(200),
                kind: z.string().max(40).optional().describe("task, decision, wait, or another step kind"),
                role: z.string().max(200).optional().describe("The role who does it"),
                block: z.string().optional().describe("A library block it comes from (id or name)"),
                ai: z.boolean().optional().describe("True when the step is done by AI and no library block covers it"),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PROPOSED_STEPS)
          .describe("The proposed steps, in order."),
        replaces: z.array(z.string().min(1)).max(20).optional().describe("Existing steps (ids or names, in the issue's process) the new steps would replace."),
        expect: z.string().max(1000).optional().describe("What you expect, in plain words, e.g. 'First contact for partner leads under 2 h'. Not simulated."),
        evidence: evidenceArg,
        note: noteArg,
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        requireSwitch(await loadAiSettings(ctx.db, ws.id), "suggest_solutions");
        const issues = (await loadIssues(ctx.db, ws.id)).filter(isVisibleIssue);
        const issue = matchIssue(issues, args.issue);
        const blocks = args.steps.some((s) => s.block) ? await loadBlocks(ctx.db, ws.id) : [];
        let replaces: string[] = [];
        if (args.replaces?.length) {
          const full = issues.find((i) => i.id === issue.id)!;
          const processId = full.links.find((l) => l.process_id)?.process_id ?? full.process_id;
          if (!processId) throw new ToolError("invalid_input", "That issue isn't linked to a process, so there are no steps to replace");
          const proc = await resolveProcess(ctx, ws, processId, assumptions);
          const known = await processSteps(ctx, proc);
          replaces = args.replaces.map((r) => matchNamed(known, r, "step", ` in '${proc.name}'`).id);
        }
        assumptions.push("Edges: each proposed step leads to the next, in the order given.");
        const built = buildSolutionIdeaProposal({
          issue_id: issue.id,
          title: args.title,
          detail: args.detail,
          steps: args.steps.map((s) => ({
            name: s.name,
            kind: s.kind,
            role: s.role,
            ai: s.ai,
            block_id: s.block ? matchNamed(blocks, s.block, "block", ` in '${ws.name}'`).id : null,
          })),
          replaces_step_ids: replaces,
          expect: args.expect,
          evidence: args.evidence,
          note: args.note,
        });
        return storeProposal(ctx, ws, built, `an idea for issue #${issue.number}`);
      }),
  );

  server.registerTool(
    "list_proposals",
    {
      title: "List proposals",
      description: "Proposed issues and solution ideas, and whether a person has accepted, rejected, dismissed or built them, newest first.",
      inputSchema: {
        status: z.enum(["pending", "accepted", "rejected", "dismissed", "built"]).optional(),
        workspace: workspaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, workspace }) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, workspace, assumptions);
        const rows = await loadProposals(ctx.db, ws.id, status);
        return {
          workspace: { id: ws.id, name: ws.name },
          proposals: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            title: r.title,
            detail: r.detail,
            issue_id: r.issue_id,
            payload: r.payload,
            evidence: r.evidence,
            note: r.note,
            created_via: r.created_via,
            proposer_name: r.proposer_name,
            created_at: r.created_at,
            reviewed_at: r.reviewed_at,
            review_note: r.review_note,
            applied: r.applied,
          })),
        };
      }),
  );
}
