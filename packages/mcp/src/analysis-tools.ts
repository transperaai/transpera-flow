// Analysis tools (docs/PRD.md §7.1; issue #26): compare_scenarios, check_robustness, get_bottlenecks and list_issues, all
// read-only (docs/plans/cut-list.md item 5: save_scenario and log_issue are gone). Like the other read tools they act as the token's user: every
// query goes through the context's database handle, which runs as the token's user, so RLS decides what is
// visible (docs/adr/0018-mcp-tokens-checked-in-app-code.md).
// Simulations use the live revision only (the PRD gives these tools no
// `revision`), run on this thread, and are capped in time where they can run
// long. Text comes from the engine's templates, never a language model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isVisibleIssue,
  listProcesses,
  loadIssuesForReader,
  loadProcessBundle,
  loadScenarios,
  loadSandboxScenarios,
  ModelError,
  toEngineModel,
  type ProcessBundle,
  type ScenarioRow,
} from "@transpera-flow/db";
import { absenceTest, detectIssues, ENGINE_VERSION, ISSUE_TYPES, ratingOfStored, resolveMoney, shadowPricesFor, simulate, toRatingConfig, withoutDisabledRules, type EngineModel } from "@transpera-flow/engine";
import { bottleneckReport, checkScenarioRobustness, compareScenarios, matchNamed, type NamedScenario } from "./analysis";
import { resolveProcess, resolveWorkspace, revisionIdFor, type ProcessWithDraft, type ToolContext, type WorkspaceRef } from "./context";
import { runTool, ToolError } from "./result";
import { isRunDate, listScenarios } from "./saved-scenarios";

/** The statuses a tool may give or filter an issue by: the four a person sees, and the two old spellings of testing and resolved. */
const ISSUE_STATUS_INPUT = ["open", "testing", "resolved", "wont_fix", "in_progress", "done"] as const;
/** An issue is about a process when its first link (`process_id`) or any other link is. */
const touches = (i: { process_id: string | null; links: readonly { process_id: string | null }[] }, processId: string | undefined) =>
  !!processId && (i.process_id === processId || i.links.some((l) => l.process_id === processId));
const normaliseStatus = (s: (typeof ISSUE_STATUS_INPUT)[number] | undefined): "open" | "testing" | "resolved" | "wont_fix" =>
  s === "in_progress" ? "testing" : s === "done" ? "resolved" : (s ?? "open");

export const ANALYSIS_TOOL_NAMES = ["compare_scenarios", "check_robustness", "get_bottlenecks", "list_issues", "list_scenarios"] as const;

const DEFAULT_REPS = 30;
const DEFAULT_SEED = 1;
/** The most time the absence test (docs/analysis-rules.md rule 8) may take in `list_issues`. */
const ABSENCE_BUDGET_MS = 5000;
const MAX_REPS = 200;
/** Well inside the route's `maxDuration` (apps/web/src/app/api/mcp/route.ts; 300 s). */
export const DEFAULT_ROBUSTNESS_SECONDS = 20;
export const MAX_ROBUSTNESS_SECONDS = 45;
export const SHADOW_PRICE_BUDGET_MS = 15_000;

const workspaceArg = z.string().optional().describe("Workspace id, slug or name. Defaults to the active workspace (set_active_workspace).");
const processArg = z.string().optional().describe("Process id or name. Defaults to the workspace's only process.");
const scenarioRefs = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .describe("A saved scenario's id or name, or several to stack in order (as applying them in the app does). Only whole-run scenarios (one that has changes from a month, a hire or a parent runs only in the Sandbox: run_scenario with `scenario` runs it month by month).");
const repsArg = z.number().int().min(1).max(MAX_REPS).optional().describe(`Replications (default ${DEFAULT_REPS}, as in the app)`);
const seedArg = z.number().int().min(0).optional().describe(`Random seed (default ${DEFAULT_SEED}, as in the app)`);
const startDateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("ISO date the run starts on; people's start/end dates and leave are measured from it (default today)");

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
  if (!isRunDate(startDate)) throw new ToolError("invalid_args", `start_date '${startDate}' isn't a calendar date between 2000 and 2100 (YYYY-MM-DD).`);
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

/**
 * The saved scenarios named, as whole-run patches. A name is matched against EVERY saved scenario, the Sandbox's too, so a part of a
 * name never quietly picks the one whole-run scenario it happens to match while it means a Sandbox scenario ("hire in" for "Hire in
 * January"); a match that has a change from a month, a hire, leave, a solution or a parent is refused by name (`sandbox_only`).
 */
async function resolveScenarios(ctx: ToolContext, ws: WorkspaceRef, names: string[]): Promise<ScenarioRow[]> {
  if (!names.length) return [];
  const [runnable, every] = await Promise.all([loadScenarios(ctx.db, ws.id), loadSandboxScenarios(ctx.db, ws.id)]);
  const byId = new Map(runnable.map((s) => [s.id, s]));
  // Every whole-run scenario is a Sandbox scenario; the union only guards a read of the Sandbox's that failed.
  const named = [...every.map((s) => ({ id: s.id, name: s.name })), ...runnable.filter((s) => !every.some((e) => e.id === s.id)).map((s) => ({ id: s.id, name: s.name }))];
  return names.map((n) => {
    const hit = matchNamed(named, n, "saved scenario", ` in '${ws.name}'`);
    const scenario = byId.get(hit.id);
    if (!scenario) {
      throw new ToolError(
        "sandbox_only",
        `'${hit.name}' runs only in the Sandbox: it has a change from a month, a hire, leave or a solution going live, or builds on another scenario. These tools take whole-run scenarios; run_scenario with \`scenario\` runs it month by month.`,
        runnable.map((s) => ({ id: s.id, name: s.name })).slice(0, 50),
      );
    }
    return scenario;
  });
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
  const rows = await ctx.db.selectFrom("steps").select(["id", "name", "revision_id"]).where("revision_id", "in", ids).execute();
  const byId = new Map<string, { id: string; name: string }>();
  for (const r of rows.filter((r) => r.revision_id === proc.live_revision_id)) byId.set(r.id, { id: r.id, name: r.name });
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, { id: r.id, name: r.name });
  return [...byId.values()];
}

export function registerAnalysisTools(server: McpServer, ctx: ToolContext): void {
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
    "list_scenarios",
    {
      title: "List scenarios",
      description:
        "Saved Sandbox scenarios: each one's changes (lever, target, value, from which month, and the note saying why), what it builds on, and whether compare_scenarios can take it. Read-only; run one with run_scenario.",
      inputSchema: { workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool(async (assumptions) => {
        const ws = await resolveWorkspace(ctx, args.workspace, assumptions);
        return await listScenarios(ctx, ws);
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
          loadIssuesForReader(ctx.db, ws.id),
          // Every saved scenario by name: an issue may link to one that runs only in the Sandbox.
          loadSandboxScenarios(ctx.db, ws.id),
          ctx.db.selectFrom("people").select(["id", "name"]).where("workspace_id", "=", ws.id).execute(),
          ctx.db.selectFrom("roles").select(["id", "name"]).where("workspace_id", "=", ws.id).execute(),
          listProcesses(ctx.db, ws.id),
          ctx.db.selectFrom("clients").select(["id", "name"]).where("workspace_id", "=", ws.id).orderBy("name").execute(),
        ]);
        const client = args.client ? matchNamed(clients, args.client, "client", ` in '${ws.name}'`) : null;
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
        const personOf = nameIn(people);
        const roleOf = nameIn(roles);
        const clientOf = nameIn(clients);
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
          // The absence test (rule 8) is its own pass, a few more replications per person who is the only one for a step.
          // Skip it when the filters would drop its facts anyway, and cap its time; say so when it didn't finish.
          const wantsAbsence = config.rules.spof.enabled && !client && (!args.type || args.type === "spof") && (!args.status || args.status === "open");
          let absence: ReturnType<typeof absenceTest> | null = null;
          if (wantsAbsence) {
            absence = absenceTest(loaded.model, { seed: DEFAULT_SEED, weeks: config.absence.weeks, timeBudgetMs: ABSENCE_BUDGET_MS });
            if (!absence.complete) assumptions.push(`The absence test ran out of time (${ABSENCE_BUDGET_MS / 1000} s) and tested ${absence.people.length} of the people who are the only one for a step; "only one person can do it" lists only those.`);
          }
          const rate = (shadowPrices?: Record<string, number>) =>
            withoutDisabledRules(rules.settings, detectIssues(loaded.model, run, config, { processId: proc.id, absence, cost: money, ...(shadowPrices ? { shadowPrices } : {}) })).filter(
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
