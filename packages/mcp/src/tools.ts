import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProcesses, loadLiveCompanyPart, loadProcessBundle, ModelError, toEngineModel } from "@transpera-flow/db";
import { applyPatches, isBlocking, MAX_PATCHES, PATCH_OPS, simulate, type EngineModel, type ScenarioPatch, type SimulationResult } from "@transpera-flow/engine";
import { resolveProcess, resolveWorkspace, revisionIdFor, visibleWorkspaces, matchWorkspace, type ToolContext } from "./context";
import { runTool, ToolError } from "./result";
import { ANALYSIS_TOOL_NAMES, registerAnalysisTools } from "./analysis-tools";
import { registerSuggestionTools, SUGGESTION_TOOL_NAMES } from "./suggestion-tools";
import { BUILDING_TOOL_NAMES, registerBuildingTools } from "./building-tools";
import { FIRST_PRINCIPLES_TOOL_NAMES, registerFirstPrinciplesTools } from "./first-principles-tools";
import { FINDINGS_TOOL_NAMES, registerFindingsTools } from "./findings-tools";

/** The browser's defaults (apps/web useSimulation): 30 replications, seed 1. */
export const DEFAULT_REPS = 30;
export const DEFAULT_SEED = 1;
const MAX_REPS = 200;

export const TOOL_NAMES = [
  "list_workspaces",
  "set_active_workspace",
  "get_workspace_summary",
  "get_process",
  "run_scenario",
  ...ANALYSIS_TOOL_NAMES,
  ...SUGGESTION_TOOL_NAMES,
  ...BUILDING_TOOL_NAMES,
  ...FIRST_PRINCIPLES_TOOL_NAMES,
  ...FINDINGS_TOOL_NAMES,
] as const;

const workspaceArg = z
  .string()
  .optional()
  .describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");
const revisionArg = z.enum(["live", "draft"]).optional().describe("Which revision to use (default live).");

function check<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/**
 * Apply scenario overrides (the same `{path, op, value}` patches saved
 * scenarios hold) to the model. A patch that can't be applied (unknown path,
 * missing step or person) fails the call instead of being dropped; values
 * brought into range are listed as assumptions.
 */
export function applyOverrides(model: EngineModel, overrides: ScenarioPatch[], assumptions: string[]): EngineModel {
  const { model: patched, issues } = applyPatches(model, overrides);
  const blocking = issues.filter(isBlocking);
  if (blocking.length) {
    throw new ToolError(
      "invalid_overrides",
      `${blocking.length} override${blocking.length === 1 ? "" : "s"} can't be applied: ${blocking.map((i) => i.message).join(" ")}`,
      blocking,
    );
  }
  for (const issue of issues) assumptions.push(`Override ${issue.index + 1}: ${issue.message}`);
  return patched;
}

const overridesArg = z
  .array(z.object({ path: z.string(), op: z.enum(PATCH_OPS), value: z.number() }).strict())
  .max(MAX_PATCHES)
  .optional()
  .describe(
    "Scenario patches applied in order on top of the model, e.g. {path: 'steps.<step_id>.work_hours', op: 'multiply', value: 0.5}. " +
      "Paths: demand.leads_per_week|active_clients|churn_monthly, finances.retainer, roles.<id>.headcount|cost_rate|ongoing_hours, " +
      "people.<id>.fte, steps.<id>.work_hours|wait_hours|rework_rate, services.<id>.price|mix_share; roles.@busiest and steps.@heaviest pick the model's busiest role and heaviest step.",
  );

/** A run summary: means and 10th–90th percentile ranges, no trace (docs/PRD.md §6.4, §7.1). */
export function summarizeRun(model: EngineModel, result: SimulationResult) {
  const roleName = (id: string | null) => (id ? (model.roles[id]?.name ?? id) : null);
  const stepName = (id: string | null) => (id ? (model.steps.find((s) => s.id === id)?.name ?? id) : null);
  const personName = (id: string | null) => (id ? (result.resolvedPeople[id]?.name ?? id) : null);
  return {
    /** The engine version the numbers come from (issue #22); a saved run records the same. */
    engine_version: result.engineVersion,
    reps: result.reps,
    horizon_weeks: model.horizonWeeks,
    kpi: result.kpi,
    bottleneck: {
      role: result.bnRole ? { id: result.bnRole, name: roleName(result.bnRole), util: result.kpi.roles[result.bnRole]?.util ?? null } : null,
      step: result.bnStep ? { id: result.bnStep, name: stepName(result.bnStep) } : null,
      person: result.bnPerson
        ? { id: result.bnPerson, name: personName(result.bnPerson), util: result.kpi.people[result.bnPerson]?.util ?? null }
        : null,
    },
    names: {
      roles: Object.fromEntries(Object.entries(model.roles).map(([id, r]) => [id, r.name])),
      people: Object.fromEntries(Object.entries(result.resolvedPeople).map(([id, p]) => [id, p.name])),
      steps: Object.fromEntries(model.steps.map((s) => [s.id, s.name])),
    },
  };
}

/** An MCP server exposing the v1 tools (read, analysis and process building), acting as the context's user. */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "transpera-flow", version: "0.1.0" });

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "Workspaces you can access, and which one is active for this token.",
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(async () => {
        const workspaces = await visibleWorkspaces(ctx.db);
        return workspaces.map((w) => ({ id: w.id, name: w.name, slug: w.slug, active: w.id === ctx.activeWorkspaceId }));
      }),
  );

  server.registerTool(
    "set_active_workspace",
    {
      title: "Set active workspace",
      description: "Choose the workspace later calls act on (by id, slug or name). Remembered for this API token.",
      inputSchema: { workspace: z.string().describe("Workspace id, slug or name") },
      annotations: { idempotentHint: true },
    },
    ({ workspace }) =>
      runTool(async () => {
        const target = matchWorkspace(await visibleWorkspaces(ctx.db), workspace);
        const updated = check(
          await ctx.db.from("api_tokens").update({ active_workspace_id: target.id }).eq("token_hash", ctx.tokenHash).select("id"),
        );
        if (!updated?.length) throw new ToolError("token", "Could not update this API token");
        ctx.activeWorkspaceId = target.id;
        return { id: target.id, name: target.name, slug: target.slug };
      }),
  );

  server.registerTool(
    "get_workspace_summary",
    {
      title: "Workspace summary",
      description: "Company model overview: settings, processes, roles and people of the active workspace.",
      inputSchema: { workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    ({ workspace }) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, workspace, assumptions);
        const [processes, company, roles, people] = await Promise.all([
          listProcesses(ctx.db, ws.id),
          loadLiveCompanyPart(ctx.db, ws.id),
          ctx.db.from("roles").select("id, name, headcount, default_cost_rate, active").eq("workspace_id", ws.id).order("name"),
          ctx.db.from("people").select("id, name, fte, capacity_hours_week, active").eq("workspace_id", ws.id).order("name"),
        ]);
        const revisionIds = processes.flatMap((p) => [p.live_revision_id, p.draft_revision_id]).filter((id): id is string => !!id);
        const revisions = revisionIds.length
          ? check(await ctx.db.from("process_revisions").select("id, number").in("id", revisionIds))
          : [];
        const number = (id: string | null) => revisions.find((r) => r.id === id)?.number ?? null;
        assumptions.push("No runs are stored yet, so there are no baseline KPIs; call run_scenario for current numbers.");
        return {
          workspace: { id: ws.id, name: ws.name, slug: ws.slug, settings: ws.settings },
          processes: processes.map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.kind,
            entity_name: p.entity_name,
            description: p.description,
            live_revision: number(p.live_revision_id),
            draft_revision: number(p.draft_revision_id),
          })),
          // The company map (B11): a stored picture of how the processes fit together, never simulated. Each process on it
          // is a card at a position; a handoff is a line between two cards (visual only for now).
          company_map: company
            ? {
                id: company.process.id,
                name: company.process.name,
                live_revision: company.revision.number,
                processes: company.steps.flatMap((s) => {
                  const p = processes.find((x) => x.id === s.child_process_id);
                  return p ? [{ process_id: p.id, name: p.name, x: Number(s.x), y: Number(s.y) }] : [];
                }),
                handoffs: company.edges.flatMap((e) => {
                  const from = company.steps.find((s) => s.id === e.from_step_id)?.child_process_id;
                  const to = company.steps.find((s) => s.id === e.to_step_id)?.child_process_id;
                  return from && to ? [{ from_process_id: from, to_process_id: to, label: e.label }] : [];
                }),
              }
            : null,
          roles: check(roles),
          people: check(people),
          last_baseline_run: null,
        };
      }),
  );

  server.registerTool(
    "get_process",
    {
      title: "Get process",
      description: "A process graph (steps, edges, roles) at its live or draft revision.",
      inputSchema: { process: processArg, revision: revisionArg, workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    ({ process, revision, workspace }) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, process, assumptions, { allowCompany: true });
        // A process built over MCP has only a draft until it is first published.
        const which = revision ?? (!proc.live_revision_id && proc.draft_revision_id ? "draft" : "live");
        if (!revision) assumptions.push(which === "live" ? "revision defaulted to live." : "revision defaulted to draft: the process hasn't been published yet.");
        const bundle = await loadProcessBundle(ctx.db, ws, proc, revisionIdFor(proc, which));
        if (proc.is_company) {
          assumptions.push("This is the company map: each step holds a process (its child_process_id) at the position the map draws it; each edge is a handoff line between two of them. It is layout only: nothing here is simulated.");
        }
        return {
          process: { ...bundle.process, draft_revision_id: proc.draft_revision_id },
          revision: bundle.revision,
          roles: bundle.roles,
          steps: bundle.steps,
          edges: bundle.edges,
        };
      }),
  );

  server.registerTool(
    "run_scenario",
    {
      title: "Run scenario",
      description:
        "Simulate a process on the server (Monte Carlo) and return means with 10th–90th percentile ranges. Same engine, model and seed as the browser, so the numbers match.",
      inputSchema: {
        process: processArg,
        revision: revisionArg,
        workspace: workspaceArg,
        overrides: overridesArg,
        reps: z.number().int().min(1).max(MAX_REPS).optional().describe(`Replications (default ${DEFAULT_REPS})`),
        seed: z.number().int().min(0).optional().describe(`Random seed (default ${DEFAULT_SEED})`),
        horizon_weeks: z.number().int().min(1).max(104).optional().describe("Weeks to simulate (default: workspace setting)"),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date the run starts on; people's start/end dates and leave are measured from it (default today)"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = await resolveProcess(ctx, ws, args.process, assumptions);
        const revision = args.revision ?? "live";
        if (!args.revision) assumptions.push("revision defaulted to live.");
        const reps = args.reps ?? DEFAULT_REPS;
        if (args.reps === undefined) assumptions.push(`reps defaulted to ${DEFAULT_REPS}.`);
        const seed = args.seed ?? DEFAULT_SEED;
        if (args.seed === undefined) assumptions.push(`seed defaulted to ${DEFAULT_SEED}.`);
        const startDate = args.start_date ?? ctx.today;
        if (!args.start_date) assumptions.push(`start_date defaulted to today (${ctx.today}).`);

        const bundle = await loadProcessBundle(ctx.db, ws, proc, revisionIdFor(proc, revision));
        let model: EngineModel;
        try {
          model = toEngineModel(bundle, { startDate });
        } catch (err) {
          if (err instanceof ModelError) throw new ToolError("invalid_model", `This process can't be simulated yet: ${err.message}`);
          throw err;
        }
        if (args.horizon_weeks !== undefined) model = { ...model, horizonWeeks: args.horizon_weeks };
        else assumptions.push(`horizon_weeks defaulted to the workspace setting (${model.horizonWeeks}).`);
        if (args.overrides?.length) model = applyOverrides(model, args.overrides, assumptions);

        const started = performance.now();
        const result = simulate(model, reps, seed);
        return {
          workspace: { id: ws.id, name: ws.name },
          process: { id: proc.id, name: proc.name },
          revision: { id: bundle.revision.id, number: bundle.revision.number, status: bundle.revision.status, which: revision },
          seed,
          start_date: startDate,
          overrides: args.overrides ?? [],
          duration_ms: Math.round(performance.now() - started),
          ...summarizeRun(model, result),
        };
      }),
  );

  registerAnalysisTools(server, ctx);
  registerSuggestionTools(server, ctx);
  registerBuildingTools(server, ctx);
  registerFirstPrinciplesTools(server, ctx);
  registerFindingsTools(server, ctx);
  return server;
}
