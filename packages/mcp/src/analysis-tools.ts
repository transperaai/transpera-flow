// Analysis tools (docs/PRD.md §7.1; issue #26): save_scenario,
// compare_scenarios, check_robustness, get_bottlenecks, log_issue and
// list_issues. Like the v1 read tools they act as the token's user: every
// query goes through the context's Supabase client, so RLS decides what is
// visible and who may write (docs/adr/0002-mcp-acts-as-user-via-pre-request.md).
// Simulations use the live revision only (the PRD gives these tools no
// `revision`), run on this thread, and are capped in time where they can run
// long. Text comes from the engine's templates, never a language model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isVisibleIssue,
  loadIssue,
  saveIssue,
  listProcesses,
  loadFirstPrinciples,
  loadIssues,
  loadProcessBundle,
  loadScenarios,
  ModelError,
  SCENARIO_COLUMNS,
  toEngineModel,
  type Json,
  type ProcessBundle,
  type ScenarioRow,
} from "@transpera-flow/db";
import { absenceTest, applyPatches, detectIssues, ENGINE_VERSION, isBlocking, ISSUE_TYPES, MAX_PATCHES, PATCH_OPS, RATINGS, STORED_SEVERITIES, ratingOfStored, resolveMoney, shadowPricesFor, simulate, successMeasureSource, storedOfRating, toRatingConfig, withoutDisabledRules, type EngineModel } from "@transpera-flow/engine";
import { bottleneckReport, checkScenarioRobustness, compareScenarios, matchNamed, type NamedScenario } from "./analysis";
import { resolveProcess, resolveWorkspace, revisionIdFor, type ProcessWithDraft, type ToolContext, type WorkspaceRef } from "./context";
import { runTool, ToolError } from "./result";

/** The statuses a tool may give or filter an issue by: the four a person sees, and the two old spellings of testing and resolved. */
const ISSUE_STATUS_INPUT = ["open", "testing", "resolved", "wont_fix", "in_progress", "done"] as const;
/** An issue is about a process when its first link (`process_id`) or any other link is. */
const touches = (i: { process_id: string | null; links: readonly { process_id: string | null }[] }, processId: string | undefined) =>
  !!processId && (i.process_id === processId || i.links.some((l) => l.process_id === processId));
const normaliseStatus = (s: (typeof ISSUE_STATUS_INPUT)[number] | undefined): "open" | "testing" | "resolved" | "wont_fix" =>
  s === "in_progress" ? "testing" : s === "done" ? "resolved" : (s ?? "open");

export const ANALYSIS_TOOL_NAMES = ["save_scenario", "compare_scenarios", "check_robustness", "get_bottlenecks", "log_issue", "list_issues"] as const;

const DEFAULT_REPS = 30;
const DEFAULT_SEED = 1;
/** The most time the absence test (docs/analysis-rules.md rule 8) may take in `list_issues`. */
const ABSENCE_BUDGET_MS = 5000;
const MAX_REPS = 200;
/** Well inside the route's `maxDuration` (apps/web/src/app/api/mcp/route.ts; 300 s). */
export const DEFAULT_ROBUSTNESS_SECONDS = 20;
export const MAX_ROBUSTNESS_SECONDS = 45;
export const SHADOW_PRICE_BUDGET_MS = 15_000;
const MAX_TITLE = 200;
const MAX_EVIDENCE = 5000;

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");
const scenarioRefs = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .describe("A saved scenario's id or name, or several to stack in order (as applying them in the app does).");
const repsArg = z.number().int().min(1).max(MAX_REPS).optional().describe(`Replications (default ${DEFAULT_REPS}, as in the app)`);
const seedArg = z.number().int().min(0).optional().describe(`Random seed (default ${DEFAULT_SEED}, as in the app)`);
const startDateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("ISO date the run starts on; people's start/end dates and leave are measured from it (default today)");

function check<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/** A write RLS or a check constraint refused, as a ToolError the caller can act on. */
function writeError(error: { code?: string; message?: string }, what: string): ToolError {
  if (error.code === "42501") return new ToolError("forbidden", `You don't have permission to ${what} in this workspace (editors and owners can).`);
  if (error.code === "23514") return new ToolError("invalid_input", `Some of those values aren't allowed: ${error.message ?? ""}`.trim());
  if (error.code === "23503") return new ToolError("not_found", "Something the issue links to no longer exists.");
  return new ToolError("write_failed", `Couldn't ${what}: ${error.message ?? "unknown error"}`);
}

const refs = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

interface Loaded {
  ws: WorkspaceRef;
  proc: ProcessWithDraft;
  bundle: ProcessBundle;
  model: EngineModel;
  startDate: string;
}

/** The live revision as an engine model, run from `start_date` (default today). */
export async function loadLiveModel(
  ctx: ToolContext,
  args: { workspace?: string; process?: string; start_date?: string },
  assumptions: string[],
): Promise<Loaded> {
  const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
  const proc = await resolveProcess(ctx, ws, args.process, assumptions);
  const startDate = args.start_date ?? ctx.today;
  if (!args.start_date) assumptions.push(`start_date defaulted to today (${ctx.today}).`);
  const bundle = await loadProcessBundle(ctx.db, ws, proc, revisionIdFor(proc, "live"));
  try {
    return { ws, proc, bundle, model: toEngineModel(bundle, { startDate }), startDate };
  } catch (err) {
    if (err instanceof ModelError) throw new ToolError("invalid_model", `This process can't be simulated yet: ${err.message}`);
    throw err;
  }
}

function runSettings(args: { reps?: number; seed?: number }, assumptions: string[]) {
  if (args.reps === undefined) assumptions.push(`reps defaulted to ${DEFAULT_REPS}.`);
  if (args.seed === undefined) assumptions.push(`seed defaulted to ${DEFAULT_SEED}.`);
  return { reps: args.reps ?? DEFAULT_REPS, seed: args.seed ?? DEFAULT_SEED };
}

async function resolveScenarios(ctx: ToolContext, ws: WorkspaceRef, names: string[]): Promise<ScenarioRow[]> {
  if (!names.length) return [];
  const all = await loadScenarios(ctx.db, ws.id);
  return names.map((n) => matchNamed(all, n, "saved scenario", ` in '${ws.name}'`));
}

const scenarioSummary = (s: NamedScenario) => ({ id: s.id, name: s.name, patch: s.patch });

const header = (l: Loaded) => ({
  workspace: { id: l.ws.id, name: l.ws.name },
  process: { id: l.proc.id, name: l.proc.name },
  revision: { id: l.bundle.revision.id, number: l.bundle.revision.number, status: l.bundle.revision.status, which: "live" as const },
  start_date: l.startDate,
  /** The engine version the numbers come from (issue #22). */
  engine_version: ENGINE_VERSION,
});

/** Stable-id steps of a process (live revision, then the draft's for steps only drafted so far). */
export async function processSteps(ctx: ToolContext, proc: ProcessWithDraft): Promise<{ id: string; name: string }[]> {
  const ids = [proc.live_revision_id, proc.draft_revision_id].filter((id): id is string => !!id);
  if (!ids.length) return [];
  const rows = check(await ctx.db.from("steps").select("id, name, revision_id").in("revision_id", ids));
  const byId = new Map<string, { id: string; name: string }>();
  for (const r of rows.filter((r) => r.revision_id === proc.live_revision_id)) byId.set(r.id, { id: r.id, name: r.name });
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, { id: r.id, name: r.name });
  return [...byId.values()];
}

export function registerAnalysisTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "save_scenario",
    {
      title: "Save scenario",
      description:
        "Save a named scenario (a list of {path, op, value} patches) to the workspace's library, where the app and compare_scenarios can use it. " +
        "The patches are checked against the process's live model first; one whose target doesn't exist is refused.",
      inputSchema: {
        name: z.string().trim().min(1).max(120).describe("Scenario name, unique in the workspace"),
        description: z.string().max(2000).optional(),
        overrides: z
          .array(z.object({ path: z.string(), op: z.enum(PATCH_OPS), value: z.number() }).strict())
          .min(1)
          .max(MAX_PATCHES)
          .describe("Patches in the run_scenario `overrides` grammar, applied in order."),
        process: z.string().optional().describe("Process to check the patches against (default: the workspace's only process)."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const processes = await listProcesses(ctx.db, ws.id);
        // One process, or one pipeline with its servicing processes (issue #19), is checked by default.
        if (args.process || processes.length === 1 || processes.filter((p) => p.kind !== "servicing").length === 1) {
          const proc = await resolveProcess(ctx, ws, args.process, assumptions);
          if (proc.live_revision_id) {
            const bundle = await loadProcessBundle(ctx.db, ws, proc, proc.live_revision_id);
            let model: EngineModel | null = null;
            try {
              model = toEngineModel(bundle, { startDate: ctx.today });
            } catch (err) {
              if (!(err instanceof ModelError)) throw err;
              assumptions.push(`Not checked against '${proc.name}': it can't be simulated yet (${err.message}).`);
            }
            if (model) {
              const { issues } = applyPatches(model, args.overrides);
              const blocking = issues.filter(isBlocking);
              if (blocking.length) {
                throw new ToolError("invalid_overrides", `These changes can't be applied to '${proc.name}': ${blocking.map((i) => i.message).join(" ")}`, blocking);
              }
              for (const i of issues) assumptions.push(`Override ${i.index + 1}: ${i.message}`);
            }
          }
        } else {
          assumptions.push("The workspace has several processes and none was given, so the patches were not checked against a model.");
        }
        const existing = await loadScenarios(ctx.db, ws.id);
        const clash = existing.find((s) => s.name.trim().toLowerCase() === args.name.trim().toLowerCase());
        if (clash) throw new ToolError("name_taken", `A scenario called '${clash.name}' already exists`, [{ id: clash.id, name: clash.name }]);
        const { data, error } = await ctx.db
          .from("scenarios")
          .insert({ workspace_id: ws.id, name: args.name.trim(), description: args.description?.trim() || null, patch: args.overrides as unknown as Json })
          .select(SCENARIO_COLUMNS)
          .single();
        if (error) throw writeError(error, "save scenarios");
        const row = data as unknown as ScenarioRow;
        return { workspace: { id: ws.id, name: ws.name }, scenario: { id: row.id, name: row.name, description: row.description, patch: row.patch } };
      }),
  );

  server.registerTool(
    "compare_scenarios",
    {
      title: "Compare scenarios",
      description:
        "Baseline vs saved scenario(s) on the live process: the app's compare view as data. Returns the KPI delta table (means with 10th–90th " +
        "percentile ranges, paired replication by replication), utilisation per role and person on both sides, and the templated headline. " +
        "`a` defaults to the baseline (the model as it is); `b` is the scenario. Each side's scenarios are applied to the live model in order.",
      inputSchema: {
        b: scenarioRefs,
        a: scenarioRefs.optional().describe("The other side's scenario(s); omit to compare against the baseline, as the app does."),
        process: processArg,
        workspace: workspaceArg,
        reps: repsArg,
        seed: seedArg,
        start_date: startDateArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const loaded = await loadLiveModel(ctx, args, assumptions);
        const { reps, seed } = runSettings(args, assumptions);
        if (!args.a) assumptions.push("a defaulted to the baseline (the live model with no scenario applied).");
        const [a, b] = await Promise.all([resolveScenarios(ctx, loaded.ws, refs(args.a)), resolveScenarios(ctx, loaded.ws, refs(args.b))]);
        const started = performance.now();
        const { runs, ...out } = compareScenarios({ model: loaded.model, a, b, reps, seed, currency: loaded.bundle.workspace.settings.currency });
        return {
          ...header(loaded),
          reps,
          seed,
          currency: loaded.bundle.workspace.settings.currency,
          a: a.length ? a.map(scenarioSummary) : "baseline",
          b: b.map(scenarioSummary),
          ...out,
          kpi: { baseline: runs.baseline.kpi, scenario: runs.scenario.kpi },
          duration_ms: Math.round(performance.now() - started),
        };
      }),
  );

  server.registerTool(
    "check_robustness",
    {
      title: "Check robustness",
      description:
        "Does the scenario's conclusion hold if the estimates are off? Re-runs baseline and scenario with every estimated input 25% lower and " +
        "higher (conflicting estimates across their range), one at a time, then refines the most sensitive (docs/PRD.md §6.5). Server-side and " +
        `time-capped (default ${DEFAULT_ROBUSTNESS_SECONDS} s, at most ${MAX_ROBUSTNESS_SECONDS} s): a check that runs out of time returns ` +
        "`partial: true` with the inputs it covered.",
      inputSchema: {
        scenario: scenarioRefs,
        metric: z.enum(["won", "mrrAdded"]).optional().describe("The conclusion checked: wins (default) or new MRR."),
        time_budget_seconds: z
          .number()
          .min(1)
          .max(MAX_ROBUSTNESS_SECONDS)
          .optional()
          .describe(`Stop starting new runs after this long (default ${DEFAULT_ROBUSTNESS_SECONDS}).`),
        process: processArg,
        workspace: workspaceArg,
        start_date: startDateArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const loaded = await loadLiveModel(ctx, args, assumptions);
        const scenario = await resolveScenarios(ctx, loaded.ws, refs(args.scenario));
        const metric = args.metric ?? "won";
        if (!args.metric) assumptions.push("metric defaulted to wins.");
        const seconds = args.time_budget_seconds ?? DEFAULT_ROBUSTNESS_SECONDS;
        if (args.time_budget_seconds === undefined) assumptions.push(`time_budget_seconds defaulted to ${DEFAULT_ROBUSTNESS_SECONDS}.`);
        const started = performance.now();
        const { result, ...out } = checkScenarioRobustness({
          model: loaded.model,
          scenario,
          provenance: {
            // The servicing processes' steps too (issue #19): their provenance decides whether they are perturbed.
            steps: [...loaded.bundle.steps, ...(loaded.bundle.otherProcesses ?? []).flatMap((p) => p.steps)],
            // Churn sensitivity and the health rules (issue #79).
            services: loaded.bundle.services,
            workspace: loaded.bundle.workspace.provenance,
            // Calibrated lead volumes (issue #41): measured qualified leads are not perturbed.
            leadSources: loaded.bundle.leadSources ?? [],
          },
          metric,
          currency: loaded.bundle.workspace.settings.currency,
          timeBudgetMs: seconds * 1000,
        });
        return {
          ...header(loaded),
          scenario: scenario.map(scenarioSummary),
          metric,
          time_budget_seconds: seconds,
          ...out,
          text: [out.verdict, ...out.details].join(" "),
          ...(result
            ? {
                nominal: result.nominal,
                bottleneck_holds: result.bottleneckHolds,
                sign_holds: result.signHolds,
                sensitivities: result.sensitivities,
                seed: result.seed,
                perturbation: result.perturbation,
              }
            : {}),
          duration_ms: Math.round(performance.now() - started),
        };
      }),
  );

  server.registerTool(
    "get_bottlenecks",
    {
      title: "Get bottlenecks",
      description:
        "Ranked constraints of the live process's baseline run: roles and people by utilisation, steps by queue, each with its evidence, and the " +
        "shadow price of the top bottleneck: the extra completed units (wins or finished items) per quarter from one more FTE in that role, " +
        "from an automatic extra replication set paired with the baseline (mean and 10th–90th percentile range).",
      inputSchema: {
        process: processArg,
        workspace: workspaceArg,
        reps: repsArg,
        seed: seedArg,
        start_date: startDateArg,
        limit: z.number().int().min(1).max(50).optional().describe("Keep at most this many of each kind (default 5)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const loaded = await loadLiveModel(ctx, args, assumptions);
        const { reps, seed } = runSettings(args, assumptions);
        const started = performance.now();
        const { result, ...report } = bottleneckReport({ model: loaded.model, reps, seed, limit: args.limit ?? 5, timeBudgetMs: SHADOW_PRICE_BUDGET_MS });
        if (report.shadow_price && !report.shadow_price.complete) {
          assumptions.push(`The shadow price ran out of time after ${report.shadow_price.reps} of ${reps} replication pairs.`);
        }
        return {
          ...header(loaded),
          reps,
          seed,
          bottleneck: {
            role: result.bnRole,
            step: result.bnStep,
            person: result.bnPerson,
          },
          ...report,
          duration_ms: Math.round(performance.now() - started),
        };
      }),
  );

  server.registerTool(
    "log_issue",
    {
      title: "Log issue",
      description:
        "Log a finding in the workspace's issues register (a manual issue), linked to a step, person, role, client, owner and/or the saved " +
        "scenario that fixes it, each by id or name. Steps are looked up in the process (default: the workspace's only process); clients in " +
        "the workspace's client roster.",
      inputSchema: {
        title: z.string().trim().min(1).max(MAX_TITLE),
        type: z.enum(ISSUE_TYPES),
        rating: z.enum(RATINGS).optional().describe("great, good (could improve), bad (not urgent) or risk (operational risk). Default good."),
        severity: z
          .enum(STORED_SEVERITIES)
          .optional()
          .describe("Deprecated: use rating. critical = risk, serious = bad, warning = good, info = great. Ignored when rating is given."),
        evidence: z.string().max(MAX_EVIDENCE).optional().describe("What was seen or said, and where."),
        process: z.string().optional().describe("Process the issue is about (id or name)."),
        step: z.string().optional().describe("Step id or name."),
        person: z.string().optional().describe("Person the issue is about (id or name)."),
        role: z.string().optional().describe("Role the issue is about (id or name)."),
        client: z.string().optional().describe("Client on the roster the issue is about (id or name)."),
        owner: z.string().optional().describe("Person who owns the fix (id or name)."),
        scenario: z.string().optional().describe("Saved scenario that tests the fix (id or name)."),
        status: z.enum(ISSUE_STATUS_INPUT).optional().describe("open, testing (testing solutions), resolved or wont_fix. Default open. in_progress and done are deprecated spellings of testing and resolved."),
        workspace: workspaceArg,
      },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        // Refuse before any name lookup: a caller who can't edit may not read other people, so a lookup would answer not_found (B1 2/3).
        const { data: canEdit, error: accessError } = await ctx.db.rpc("can_edit_workspace", { ws: ws.id });
        if (accessError) throw writeError(accessError, "log issues");
        if (canEdit !== true) throw writeError({ code: "42501" }, "log issues");
        const client = args.client
          ? matchNamed(check(await ctx.db.from("clients").select("id, name").eq("workspace_id", ws.id).order("name")), args.client, "client", ` in '${ws.name}'`)
          : null;
        let proc: ProcessWithDraft | null = null;
        if (args.process || args.step) proc = await resolveProcess(ctx, ws, args.process, assumptions);
        const step = args.step && proc ? matchNamed(await processSteps(ctx, proc), args.step, "step", ` in '${proc.name}'`) : null;
        const needPeople = args.person || args.owner;
        const people = needPeople
          ? check(await ctx.db.from("people").select("id, name").eq("workspace_id", ws.id).order("name"))
          : [];
        const person = args.person ? matchNamed(people, args.person, "person", ` in '${ws.name}'`) : null;
        const owner = args.owner ? matchNamed(people, args.owner, "person", ` in '${ws.name}'`) : null;
        const role = args.role
          ? matchNamed(check(await ctx.db.from("roles").select("id, name").eq("workspace_id", ws.id).order("name")), args.role, "role", ` in '${ws.name}'`)
          : null;
        const scenario = args.scenario ? matchNamed(await loadScenarios(ctx.db, ws.id), args.scenario, "saved scenario", ` in '${ws.name}'`) : null;
        const rating = args.rating ?? (args.severity ? ratingOfStored(args.severity) : "good");
        if (!args.rating && args.severity) assumptions.push(`severity '${args.severity}' is deprecated; read as rating '${rating}'.`);
        else if (!args.rating) assumptions.push("rating defaulted to good (could improve).");
        const status = normaliseStatus(args.status);
        if (args.status && status !== args.status) assumptions.push(`status '${args.status}' is deprecated; read as '${status}'.`);
        // One call writes the issue with what it touches and who owns it, so its history starts with one entry.
        const saved = await saveIssue(ctx.db, {
          workspaceId: ws.id,
          fields: {
            title: args.title.trim(),
            type: args.type,
            severity: storedOfRating(rating),
            evidence: args.evidence?.trim() || null,
            status,
            source: "manual",
            person_id: person?.id ?? null,
            role_id: role?.id ?? null,
            client_id: client?.id ?? null,
            scenario_id: scenario?.id ?? null,
          },
          links: step ? [{ process_id: proc?.id ?? null, step_id: step.id }] : proc ? [{ process_id: proc.id, step_id: null }] : [],
          owners: owner ? [owner.id] : [],
        });
        if ("error" in saved) throw writeError(saved.error, "log issues");
        const row = await loadIssue(ctx.db, ws.id, saved.id);
        if (!row) throw writeError({ code: "42501" }, "log issues");
        return {
          workspace: { id: ws.id, name: ws.name },
          issue: {
            ...row,
            rating: ratingOfStored(row.severity),
            process: proc ? { id: proc.id, name: proc.name } : null,
            step: step ? { id: step.id, name: step.name } : null,
            person: person ? { id: person.id, name: person.name } : null,
            role: role ? { id: role.id, name: role.name } : null,
            client: client ? { id: client.id, name: client.name } : null,
            owner: owner ? { id: owner.id, name: owner.name } : null,
            scenario: scenario ? { id: scenario.id, name: scenario.name } : null,
          },
        };
      }),
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "The workspace's issues register: tracked issues (logged by hand or promoted from a detection), newest first, with the names of what " +
        "each links to. Filter by status, type, process or client. With include_detected, also runs the live process and lists what the run detects " +
        "that isn't tracked yet.",
      inputSchema: {
        status: z.enum(ISSUE_STATUS_INPUT).optional().describe("open, testing, resolved or wont_fix (in_progress and done are deprecated spellings)."),
        type: z.enum(ISSUE_TYPES).optional(),
        process: z.string().optional().describe("Only issues about this process (id or name)."),
        client: z.string().optional().describe("Only issues about this client on the roster (id or name)."),
        include_detected: z.boolean().optional().describe("Also list the live run's untracked detections (default false)."),
        workspace: workspaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        const proc = args.process || args.include_detected ? await resolveProcess(ctx, ws, args.process, assumptions) : null;
        const [issues, scenarios, people, roles, processes, clients] = await Promise.all([
          loadIssues(ctx.db, ws.id),
          loadScenarios(ctx.db, ws.id),
          ctx.db.from("people").select("id, name").eq("workspace_id", ws.id),
          ctx.db.from("roles").select("id, name").eq("workspace_id", ws.id),
          listProcesses(ctx.db, ws.id),
          ctx.db.from("clients").select("id, name").eq("workspace_id", ws.id).order("name"),
        ]);
        const client = args.client ? matchNamed(check(clients), args.client, "client", ` in '${ws.name}'`) : null;
        const wanted = args.status ? normaliseStatus(args.status) : null;
        // A dismissed insight is not an issue, so it is never listed.
        const filtered = issues.filter(isVisibleIssue).filter(
          (i) =>
            (!wanted || i.status === wanted) &&
            (!args.type || i.type === args.type) &&
            (!args.process || touches(i, proc?.id)) &&
            (!client || i.client_id === client.id),
        );
        const stepNames = new Map<string, string>();
        for (const p of processes.filter((p) => filtered.some((i) => touches(i, p.id)))) {
          for (const s of await processSteps(ctx, p)) stepNames.set(s.id, s.name);
        }
        const nameIn = (list: { id: string; name: string }[] | null) => (id: string | null) => {
          if (!id) return null;
          return { id, name: list?.find((x) => x.id === id)?.name ?? null };
        };
        const personOf = nameIn(check(people));
        const roleOf = nameIn(check(roles));
        const clientOf = nameIn(check(clients));
        const scenarioOf = nameIn(scenarios);
        const processOf = nameIn(processes);
        const tracked = filtered.map((i) => ({
          ...i,
          rating: ratingOfStored(i.severity),
          process: processOf(i.process_id),
          step: i.step_id ? { id: i.step_id, name: stepNames.get(i.step_id) ?? null } : null,
          person: personOf(i.person_id),
          role: roleOf(i.role_id),
          client: clientOf(i.client_id),
          owner: personOf(i.owner_person_id),
          scenario: scenarioOf(i.scenario_id),
        }));

        let detected: unknown[] | undefined;
        if (args.include_detected && proc) {
          const loaded = await loadLiveModel(ctx, { workspace: ws.id, process: proc.id }, assumptions);
          assumptions.push(`Detections come from a run of the live model at ${DEFAULT_REPS} replications, seed ${DEFAULT_SEED}.`);
          const run = simulate(loaded.model, DEFAULT_REPS, DEFAULT_SEED);
          const keys = new Set(issues.map((i) => i.detected_key).filter(Boolean));
          // The documented defaults, as every page of the app rates with them since B17 (D40): the rules give facts.
          const rules = { settings: {} };
          const currency = loaded.bundle.workspace.settings.currency;
          // The money settings (the cap on what a loss is worth, absences a year) are the defaults too (issue #108, D40).
          const money = { ...resolveMoney(rules.settings), currency };
          const config = toRatingConfig(rules.settings, loaded.model.hoursPerWeek);
          // The success measures of the live version's first principles, which rule 11 (goals met) rates, as the app does.
          const firstPrinciples = await loadFirstPrinciples(ctx.db, proc.id, loaded.bundle.revision.id).catch(() => null);
          const successMeasures = firstPrinciples?.doc ? successMeasureSource(firstPrinciples.doc, proc.id) : undefined;
          // The absence test (rule 8) is its own pass, a few more replications per person who is the only one for a step.
          // Skip it when the filters would drop its findings anyway, and cap its time; say so when it didn't finish.
          const wantsAbsence = config.rules.spof.enabled && !client && (!args.type || args.type === "spof") && (!args.status || args.status === "open");
          let absence: ReturnType<typeof absenceTest> | null = null;
          if (wantsAbsence) {
            absence = absenceTest(loaded.model, { seed: DEFAULT_SEED, weeks: config.absence.weeks, timeBudgetMs: ABSENCE_BUDGET_MS });
            if (!absence.complete) assumptions.push(`The absence test ran out of time (${ABSENCE_BUDGET_MS / 1000} s) and tested ${absence.people.length} of the people who are the only one for a step; "only one person can do it" lists only those.`);
          }
          const rate = (shadowPrices?: Record<string, number>) =>
            withoutDisabledRules(rules.settings, detectIssues(loaded.model, run, config, { processId: proc.id, absence, cost: money, ...(successMeasures ? { successMeasures } : {}), ...(shadowPrices ? { shadowPrices } : {}) })).filter(
              (d) => !keys.has(d.key) && (!args.type || d.type === args.type) && !client,
            );
          const dropped = Boolean(args.status && args.status !== "open");
          // The "too busy" cost needs the extra run of one more person in each flagged role: one time budget for all of
          // them together, and none when the filters leave no capacity issue to cost.
          const roleIds = dropped ? [] : rate().flatMap((d) => (d.key.startsWith("capacity:") && d.roleId ? [d.roleId] : []));
          const shadowPrices = roleIds.length ? shadowPricesFor(loaded.model, roleIds, { reps: DEFAULT_REPS, seed: DEFAULT_SEED, timeBudgetMs: 5000 }) : {};
          assumptions.push(`Costs per month are estimates in ${currency}: what a loss is worth is the revenue still to come, capped at ${money.capMonths} months.`);
          detected = dropped ? [] : rate(shadowPrices).map((d) => ({ ...d, cost: { ...d.cost, currency, estimate: true }, source: "detected", status: null }));
        }
        return {
          workspace: { id: ws.id, name: ws.name },
          filters: {
            status: args.status ?? null,
            type: args.type ?? null,
            process: proc && args.process ? { id: proc.id, name: proc.name } : null,
            client: client ? { id: client.id, name: client.name } : null,
          },
          count: tracked.length,
          issues: tracked,
          ...(detected ? { detected } : {}),
        };
      }),
  );
}
