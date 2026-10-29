"use client";

// The Sandbox (docs/plans/sandbox-design.md, docs/plans/sandbox-p1-brief.md): the page that was the Forecast. The company model is run
// forward month by month over the horizon picked, and "who gets too busy, and when" comes from it, as before. On top of that you can
// try changes: a scenario is a named list of changes (a hire, a price change, a solution going live), each for the whole run or from
// a month, saved, run against today's live model and compared with up to two others. A scenario can build on another. The live
// forecast, and its insights, are never changed by a scenario, and nothing here changes live data.
//
// Who: the Owner and Agency admins (mode "live") add, move, save and delete; a Viewer (mode "readonly") opens, runs and compares
// saved scenarios and sees the alerts without acknowledging them; the demo (mode "demo") keeps scenarios in the tab.

import { useIsPhone } from "@/hooks/use-mobile";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { partOf, speedsNormalisedFor, type IssueRow, type ProcessBundle, type SandboxChange, type SandboxScenarioRow, type SolutionRow, type SourceRow } from "@transpera-flow/db";
import { offeredLevers, sandboxLever, workspacePurposes } from "@transpera-flow/db";
import { BUILTIN_CHURN_DRIVER_IDS, CHURN_DRIVER_SPECS, CUSTOM_DRIVER_PREFIX, ENGINE_VERSION, firstCrossing, toRatingConfig } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { InsightsSection } from "@/components/insights";
import { PageHeader } from "@/components/shell/page";
import { ShareButton } from "@/components/share/share-dialog";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteSandboxScenario, saveSandboxScenario } from "@/app/w/[slug]/sandbox-actions";
import { DEFAULT_FORECAST_MONTHS, forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { dateAtPosition, hoursToDate, mondayOnOrBefore, monthBounds, addDays, effectiveChanges, effectiveLimitProblem, type EffectiveChange } from "@transpera-flow/db/sandbox";
import { runKey, sharedSimPool } from "@/lib/forecast/sim-pool";
import { partMonthNote, timelineData, timelineMonths } from "@/lib/forecast/timeline";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { horizonLabel, horizonWeeks } from "@/lib/horizon";
import { issueFormOptions } from "@/lib/issues/draft";
import { useIssues } from "@/lib/issues/use-issues";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { SPEEDS_NORMALISED_NOTE } from "@/lib/people";
import { useSimulation } from "@/lib/sim/use-simulation";
import { cn } from "@/lib/utils";
import { deleteDemoScenario, saveDemoScenario, useDemoScenarios } from "@/lib/sandbox/demo";
import type { DescribeContext } from "@/lib/sandbox/describe";
import { solutionReason } from "@/lib/sandbox/greyed";
import { todayValue } from "@/lib/sandbox/today";
import { explainFull } from "@/lib/sandbox/explain";
import { EDIT_ONLY } from "@/lib/phone";
import { laneMarkers } from "@/lib/sandbox/lane";
import { parseSandboxInput } from "@/lib/sandbox/validate";
import { useScenarioRun } from "@/lib/sandbox/use-scenario-run";
import { canSeePerson, namedForViewer, viewerOf } from "@/lib/viewer";
import { capacityLine, capacityRunsOut } from "@/lib/sandbox/timing";
import { forecastMoney } from "@/lib/forecast/money";
import { ForecastMoney } from "@/components/forecast/forecast-money";
import { TimeByPurpose } from "@/components/sandbox/time-by-purpose";
import { ForecastTimeline, TimelineLegend, type PlanLane } from "@/components/forecast/forecast-timeline";
import { ChangeDialog, type ChangeTarget } from "./change-dialog";
import { ChangeList } from "./change-list";
import { SandboxExportMenu, type ExportData } from "./export-menu";
import { PrintSummary, type PrintColumn } from "./print-summary";
import { Timing } from "./timing";
import { PriceRise } from "./price-rise";
import { GoalSeekDialog } from "./goal-seek-dialog";
import { Tornado } from "./tornado";
import { SandboxCompare, MAX_COMPARE } from "./sandbox-compare";
import { ConfirmDialog, NameDialog, NO_CHANGES, ParentDialog, ScenarioBar, UNSAVED_SCENARIO } from "./scenario-bar";

export interface SandboxViewProps {
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Tracked issues: an acknowledged alert is one of them. */
  issues: IssueRow[];
  sources?: SourceRow[];
  /** "live": Agency admins and the Owner. "readonly": a Viewer. "demo": the public demo, scenarios kept in the tab. */
  mode: "live" | "demo" | "readonly";
  issuesHref: string;
  /** Settings, where people's start dates, end dates and leave are set. Null on the demo. */
  peopleHref?: string | null;
  /** Settings, Levers: where a kind of change is switched off. Null on the demo. */
  leversHref?: string | null;
  /** Settings → Purposes, for someone who may change the categories. */
  purposesHref?: string | null;
  /** The ISO date the forecast starts on; today when omitted. Fixed on the demo so its months don't move. */
  startDate?: string;
  /** A line under the title, e.g. the demo's note about its sample scenarios. */
  note?: ReactNode;
  /** Saved scenarios (everyone who can read the workspace). The demo's own are added from its store. */
  scenarios?: SandboxScenarioRow[];
  /** Saved solutions a scenario can put live (everyone reads them). On the demo the tab's own are added to these. */
  solutions?: SolutionRow[];
  /** Lever kinds switched off in Settings, Levers: not offered for a new change; saved changes of them still apply. */
  hiddenLevers?: readonly string[];
}

/** The workspace slug from the Sandbox's address, /w/<slug>/sandbox. */
const sharePath = (pathname: string): string => pathname.split("/")[2] ?? "";
const NO_SOURCES: SourceRow[] = [];
const NO_SCENARIOS: SandboxScenarioRow[] = [];
const NO_SOLUTIONS: SolutionRow[] = [];
const NO_HIDDEN: readonly string[] = [];
const NO_EFFECTIVE: EffectiveChange[] = [];
const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const HORIZONS = [3, 6, 12, 24];
const CUSTOM = { min: 1, max: 24 } as const;
const isForecastIssue = (i: IssueRow) => i.detected_key?.startsWith("forecast:") ?? false;

/** The scenario on screen, as it is being worked on. */
interface Draft {
  name: string;
  description: string | null;
  parent_id: string | null;
  changes: SandboxChange[];
}

type Confirm = { title: string; description?: string; confirm: string; cancel: string; destructive?: boolean; onConfirm: () => void } | null;
type NameAsk = { title: string; initial: string; confirm: string; taken: string[]; onConfirm: (name: string) => void | string | null | Promise<void | string | null> } | null;

export function SandboxView({ live, issues, sources = NO_SOURCES, mode, issuesHref, peopleHref = null, leversHref = null, purposesHref = null, startDate, note, scenarios = NO_SCENARIOS, solutions = NO_SOLUTIONS, hiddenLevers = NO_HIDDEN }: SandboxViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canEdit = mode !== "readonly";
  const demo = mode === "demo";
  /** The query string this page last wrote, or was opened with: any other one came from outside (a link, the sidebar). */
  const lastWritten = useRef(searchParams.toString());
  /** Change some of the page's URL parameters (null removes one), without a scroll or a new history entry. */
  const writeUrl = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    lastWritten.current = next.toString();
    // A comma stays a comma: `?compare=a,b`.
    const qs = next.toString().replace(/%2C/gi, ",");
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [rows, setRows] = useState<"roles" | "people">("roles");
  const start = useMemo(() => startDate ?? today(), [startDate]);
  const isPhone = useIsPhone();

  // ---- Scenarios ----
  const demoStore = useDemoScenarios();
  const demoSolutions = useDemoSolutions();
  const [liveScenarios, setLiveScenarios] = useState(scenarios);
  const saved = demo ? demoStore : liveScenarios;
  const planSolutions = useMemo(() => (demo ? [...solutions, ...demoSolutions.solutions] : solutions), [demo, solutions, demoSolutions.solutions]);
  const [selected, setSelected] = useState<string | null>(() => {
    const id = searchParams.get("scenario") ?? searchParams.get("plan");
    return id && saved.some((p) => p.id === id) ? id : null;
  });
  /** Changes on top of the saved scenario shown, or (with none shown) a new scenario that isn't saved yet. */
  const [edit, setEdit] = useState<Draft | null>(null);
  const [compare, setCompare] = useState<string[] | null>(() => {
    const ids = (searchParams.get("compare")?.split(",") ?? []).filter((id) => saved.some((s) => s.id === id)).slice(0, MAX_COMPARE);
    return ids.length ? ids : null;
  });
  const [changeTarget, setChangeTarget] = useState<ChangeTarget | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [nameAsk, setNameAsk] = useState<NameAsk>(null);
  const [parentAsk, setParentAsk] = useState(false);
  const [saveNote, setSaveNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  /** The export's "Include costs and profit" (Agency admins and the Owner; a Viewer's runs have none). */
  const [includeCosts, setIncludeCosts] = useState(true);

  const savedScenario = saved.find((p) => p.id === selected) ?? null;
  // The horizon: ?horizon=1..24, else the open scenario's own, else a year.
  const horizonParam = Number(searchParams.get("horizon"));
  const [override, setOverride] = useState<number | null>(Number.isInteger(horizonParam) && horizonParam >= 1 && horizonParam <= 24 ? horizonParam : null);
  // The page stays mounted when only the address's query changes, so state read from it once would go stale: the sidebar's
  // "Sandbox" link (no query) left the last scenario on screen under a bare address, and a reload then showed something else.
  // When the address changes and this page didn't write it, show what it says (as opening it fresh would).
  useEffect(() => {
    const now = searchParams.toString();
    if (now === lastWritten.current) return;
    lastWritten.current = now;
    const id = searchParams.get("scenario") ?? searchParams.get("plan");
    const ids = (searchParams.get("compare")?.split(",") ?? []).filter((c) => saved.some((s) => s.id === c)).slice(0, MAX_COMPARE);
    const h = Number(searchParams.get("horizon"));
    setSelected(id && saved.some((p) => p.id === id) ? id : null);
    setEdit(null);
    setCompare(ids.length ? ids : null);
    setOverride(Number.isInteger(h) && h >= 1 && h <= 24 ? h : null);
    setChangeTarget(null);
    setConfirm(null);
    setNameAsk(null);
    setParentAsk(false);
    setSaveNote(null);
    // Only an address change from outside resets the page; `saved` is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const months = override ?? savedScenario?.horizon_months ?? DEFAULT_FORECAST_MONTHS;
  const pickHorizon = (m: number) => {
    setOverride(m);
    writeUrl({ horizon: String(m) });
  };

  const built = useMemo(() => forecastModel(live, months, start), [live, months, start]);
  const sim = useSimulation(built.model, 30, 1, { monthly: true, monthStarts: built.monthStarts });
  const result = sim.status === "done" && built.model && sim.run.result.H === built.model.horizonWeeks * built.model.hoursPerWeek ? sim.run.result : null;
  // The live run is also what a scenario with no changes would run (and segment 0 of any scenario with no change at month 0): hand it
  // to the scenarios' pool, so nobody runs it twice.
  useEffect(() => {
    if (built.model && built.monthStarts && result) sharedSimPool().seed(runKey(built.model, built.monthStarts, result.initialState), result);
  }, [built.model, built.monthStarts, result]);
  // The alerts use the documented defaults (D40): the rules editor is gone, so a stored setting nobody can reach doesn't move results.
  const rules = ANALYSIS_DEFAULTS;
  const cutoffs = useMemo(() => toRatingConfig(rules, live.workspace.settings.hours_per_week).rules.busy.cutoffs, [rules, live.workspace.settings.hours_per_week]);
  const busyLine = cutoffs[1];
  const alerts = useMemo(() => (built.model && result ? forecastInsights(built.model, result, rules, start) : null), [built.model, result, rules, start]);
  const data = useMemo(() => (built.model && result ? timelineData(built.model, result, live, start) : null), [built.model, result, live, start]);

  // Acknowledging an alert tracks it as an issue, as on the Overview; this page lists only the forecast's own.
  const liveRevisions = useMemo(() => Object.fromEntries([partOf(live), ...(live.otherProcesses ?? [])].map((p) => [p.process.id, p.revision.id])), [live]);
  const all = useIssues(live.workspace.id, issues, mode, liveRevisions);
  const state = useMemo(() => ({ ...all, issues: all.issues.filter(isForecastIssue) }), [all]);
  const parts = useMemo(() => [partOf(live), ...(live.otherProcesses ?? [])], [live]);
  const processOfStepMap = useMemo(() => new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, p.process.id] as const))), [parts]);
  const stepNames = useMemo(() => new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, s.name] as const))), [parts]);
  const processNames = useMemo(() => new Map(parts.map((p) => [p.process.id, p.process.name])), [parts]);
  const formOptions = useMemo(
    () =>
      issueFormOptions({
        processes: parts.map((p) => ({ id: p.process.id, name: p.process.name })),
        steps: parts.flatMap((p) => p.steps),
        people: namedForViewer(viewerOf(live), live.people.filter((p) => p.active)),
        sources,
      }),
    [parts, live, sources],
  );

  // What is on screen: the saved scenario with the changes made to it, or a new one.
  const working: Draft | null = useMemo(
    () => edit ?? (savedScenario ? { name: savedScenario.name, description: savedScenario.description, parent_id: savedScenario.parent_id, changes: savedScenario.changes } : null),
    [edit, savedScenario],
  );
  const workingName = working?.name ?? "New scenario";
  const dirty = edit !== null && (savedScenario === null || edit.name !== savedScenario.name || edit.parent_id !== savedScenario.parent_id || (edit.description ?? null) !== (savedScenario.description ?? null) || JSON.stringify(edit.changes) !== JSON.stringify(savedScenario.changes));
  const horizonChanged = savedScenario !== null && months !== savedScenario.horizon_months;
  const effective = useMemo(() => {
    if (!working) return null;
    const eff = effectiveChanges({ id: selected ?? "unsaved", name: working.name, parent_id: working.parent_id, changes: working.changes }, saved);
    if (!eff.ok) return { ok: false as const, error: eff.error };
    const limit = effectiveLimitProblem(eff.changes.map((c) => c.change));
    return limit ? { ok: false as const, error: limit } : { ok: true as const, changes: eff.changes, parents: eff.parents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working?.name, working?.parent_id, working?.changes, selected, saved]);
  const effectiveList: EffectiveChange[] | null = effective && effective.ok ? effective.changes : null;
  const plan = useScenarioRun({ bundle: live, changes: compare ? null : effectiveList, solutions: planSolutions, months, startDate: start });
  const hpw = live.workspace.settings.hours_per_week;
  const bounds = useMemo(() => (built.model ? monthBounds(built.monthStarts, built.model.horizonWeeks * built.model.hoursPerWeek) : null), [built]);
  const horizonHours = bounds ? bounds[bounds.length - 1]! : 0;
  const scenarioError = effective && !effective.ok ? effective.error : null;

  // The timeline shows the scenario's numbers once a run has finished (the old chart stays while a newer one runs).
  const planData = useMemo(
    () => (plan.run ? timelineData(plan.run.model, plan.run.result, live, start, { markersModel: plan.run.markersModel, planPeople: plan.run.planPeople }) : null),
    [plan.run, live, start],
  );
  const shownData = working !== null && planData && !scenarioError ? planData : data;

  // Sales and money (sandbox phase 2) for the run on screen: the open scenario's spliced run, or the live one.
  const shownRun = useMemo(
    () => (working !== null && plan.run && !scenarioError ? plan.run : built.model && result ? { model: built.model, result, spliced: false } : null),
    [working, plan.run, scenarioError, built.model, result],
  );
  const serviceNames = useMemo(() => new Map(live.services.map((sv) => [sv.id, sv.name])), [live.services]);
  const moneyView = useMemo(
    () =>
      shownRun?.result.monthly
        ? forecastMoney(shownRun.result, timelineMonths(start, shownRun.result.monthly.months, shownRun.model.hoursPerWeek), (id) => serviceNames.get(id) ?? "Hourly", { spliced: shownRun.spliced })
        : null,
    [shownRun, start, serviceNames],
  );

  // The weight of each service type in the live model: what "Traffic by type" percentages are shares of.
  const mix = useMemo(() => Object.fromEntries(Object.entries(built.model?.services ?? {}).map(([id, sv]) => [id, sv.mixShare])), [built.model]);
  const ctx: DescribeContext = useMemo(() => ({ bundle: live, solutions: planSolutions, changes: effectiveList?.map((e) => e.change) ?? [], mix }), [live, planSolutions, effectiveList, mix]);
  const lane = useMemo(() => (effectiveList ? laneMarkers(ctx, effectiveList, plan.problems, start, hpw) : []), [ctx, effectiveList, plan.problems, start, hpw]);
  const inSpan = useMemo(() => lane.filter((mk) => bounds !== null && hoursToDate(start, mk.date, hpw) < horizonHours), [lane, bounds, start, hpw, horizonHours]);
  const model = built.model;
  // A solution can go live only when one is saved for a process in the run (the solution options are worked out below).
  const appliesReason = (leverId: string) => (leverId === "E6" ? solutionReason(solutionOptions) : model ? (sandboxLever(leverId)?.applies?.(model) ?? null) : null);
  const monthOptions = useMemo(() => {
    if (!built.model || !bounds) return [];
    const spans = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1]! }));
    return timelineMonths(start, spans, built.model.hoursPerWeek).map((mo, i) => ({ value: dateAtPosition(i, "month", start, bounds, hpw).slice(0, 7), label: mo.long }));
  }, [built.model, bounds, start, hpw]);

  /** What a scenario does to when each role gets too busy, against the live forecast. */
  const withThisScenario = useMemo(() => {
    if (working === null || compare || !plan.run || !result || !built.model || plan.status === "error") return null;
    const names = timelineMonths(start, plan.run.result.monthly!.months, built.model.hoursPerWeek).map((mo) => mo.long);
    const lines: string[] = [];
    for (const [id, role] of Object.entries(built.model.roles)) {
      const l = firstCrossing(result.monthly!.roles[id] ?? [], cutoffs).average;
      const p = firstCrossing(plan.run.result.monthly!.roles[id] ?? [], cutoffs).average;
      if (l?.month === p?.month) continue;
      if (l && p) lines.push(`${role.name}: too busy from ${names[p.month]} (with no changes: ${names[l.month]})`);
      else if (l) lines.push(`${role.name}: no longer too busy in the next ${horizonLabel(months)}`);
      else if (p) lines.push(`${role.name}: too busy from ${names[p.month]} (not with no changes)`);
    }
    return lines;
  }, [working, compare, plan.run, plan.status, result, built.model, cutoffs, start, months]);

  /** Why a scenario that fills a role or person can look worse: it says so, with a hire to try. Worked out from the two runs already on screen. */
  const fullNotes = useMemo(() => {
    if (working === null || compare || !plan.run || !result?.monthly || !built.model || plan.status === "error") return [];
    const monthly = plan.run.result.monthly;
    if (!monthly) return [];
    const viewer = viewerOf(live);
    const people = Object.fromEntries(
      Object.entries(plan.run.model.people ?? {})
        .filter(([id]) => canSeePerson(viewer, id))
        .map(([id, p]) => [id, { name: p.name, roles: p.roles }]),
    );
    return explainFull({
      live: result.monthly,
      scenario: monthly,
      monthNames: timelineMonths(start, monthly.months, built.model.hoursPerWeek).map((mo) => mo.long),
      roles: plan.run.model.roles,
      people,
    });
  }, [working, compare, plan.run, plan.status, result, built.model, start, live]);

  const changeChanges = (fn: (changes: SandboxChange[]) => SandboxChange[]) => {
    setSaveNote(null);
    setEdit((prev) => {
      const base: Draft = prev ?? (savedScenario ? { name: savedScenario.name, description: savedScenario.description, parent_id: savedScenario.parent_id, changes: savedScenario.changes } : { name: "New scenario", description: null, parent_id: null, changes: [] });
      return { ...base, changes: fn(base.changes) };
    });
  };
  const addChange = (c: SandboxChange) => changeChanges((cs) => [...cs, c]);
  const replaceChange = (c: SandboxChange) => changeChanges((cs) => cs.map((x) => (x.id === c.id ? c : x)));
  const removeChange = (id: string) => changeChanges((cs) => cs.filter((x) => x.id !== id));
  /** A drag or key press on the lane: month changes move to `YYYY-MM`, leave to its Monday. */
  const moveChange = (id: string, date: string) => changeChanges((cs) => cs.map((x) => (x.id === id && x.from ? { ...x, from: x.from.length === 7 ? date.slice(0, 7) : date } : x)));
  const editChange = (id: string) => {
    const change = working?.changes.find((c) => c.id === id);
    if (change) setChangeTarget({ mode: "edit", change });
  };

  /** Run `go` now, or after asking whether to throw away the changes made to the scenario on screen. */
  const guarded = (go: () => void) => {
    if (!dirty) return go();
    setConfirm({
      title: `Discard your changes to “${workingName}”?`,
      confirm: "Discard",
      cancel: "Keep editing",
      onConfirm: () => {
        setConfirm(null);
        go();
      },
    });
  };
  const selectScenario = (value: string) => {
    if (value === UNSAVED_SCENARIO || (value === NO_CHANGES ? savedScenario === null && edit === null : value === selected && !edit)) return;
    guarded(() => {
      setEdit(null);
      setSaveNote(null);
      setSelected(value === NO_CHANGES ? null : value);
      // The scenario's own horizon applies unless the address says otherwise.
      setOverride(null);
      writeUrl({ scenario: value === NO_CHANGES ? null : value, plan: null, horizon: null });
    });
  };
  const newScenario = () =>
    guarded(() => {
      setSelected(null);
      setSaveNote(null);
      setEdit({ name: "New scenario", description: null, parent_id: null, changes: [] });
      writeUrl({ scenario: null, plan: null });
    });

  const parseContext = useMemo(
    () => ({ solutions: planSolutions, processName: (id: string) => processNames.get(id) ?? "that process", scenarios: saved, selfId: selected }),
    [planSolutions, processNames, saved, selected],
  );
  const finishSave = (row: SandboxScenarioRow) => {
    setSelected(row.id);
    setEdit(null);
    setSaveNote({ text: "Saved", tone: "ok" });
    setOverride(null);
    writeUrl({ scenario: row.id, plan: null, horizon: null });
  };
  /** Save `input` (a new scenario when `existing` is null, else a change to it). */
  const save = async (input: Draft & { horizon_months: number }, existing: SandboxScenarioRow | null) => {
    const parsed = parseSandboxInput(input, { ...parseContext, selfId: existing?.id ?? null });
    if (!parsed.ok) return setSaveNote({ text: parsed.error, tone: "error" });
    setSaveNote({ text: "Saving…", tone: "ok" });
    if (demo) return finishSave(saveDemoScenario({ id: existing?.id ?? null, ...parsed.value }));
    try {
      const r = await saveSandboxScenario(live.workspace.id, existing?.id ?? null, parsed.value, existing?.updated_at ?? null);
      if (r.status === "error") return setSaveNote({ text: r.message, tone: "error" });
      setLiveScenarios((prev) => [...prev.filter((p) => p.id !== r.scenario.id), r.scenario].sort((a, b) => a.name.localeCompare(b.name)));
      finishSave(r.scenario);
    } catch {
      setSaveNote({ text: "Couldn't save the scenario. Try again.", tone: "error" });
    }
  };
  /** Save the scenario on screen; changes that need attention are left out, after a question. */
  const startSave = (name: string, asNew: boolean) => {
    const draft = working ?? { name, description: null, parent_id: null, changes: [] };
    const own = new Set(draft.changes.map((c) => c.id));
    const stale = new Set(plan.problems.filter((p) => !p.note && own.has(p.changeId)).map((p) => p.changeId));
    const go = (changes: SandboxChange[]) => void save({ ...draft, name, changes, horizon_months: months }, asNew ? null : savedScenario);
    if (!stale.size) return go(draft.changes);
    setConfirm({
      title: `Save without the ${stale.size} change${stale.size === 1 ? "" : "s"} that need${stale.size === 1 ? "s" : ""} attention?`,
      description: plan.problems.filter((p) => stale.has(p.changeId)).map((p) => p.message).join("; ") + ".",
      confirm: "Save without them",
      cancel: "Cancel",
      onConfirm: () => {
        setConfirm(null);
        go(draft.changes.filter((c) => !stale.has(c.id)));
      },
    });
  };
  const namesTaken = (except: string | null) => saved.filter((p) => p.id !== except).map((p) => p.name);
  const onSave = () => {
    if (savedScenario) return startSave(workingName, false);
    setNameAsk({ title: "Save the scenario", initial: workingName, confirm: "Save", taken: namesTaken(null), onConfirm: (name) => (setNameAsk(null), startSave(name, false)) });
  };
  const onSaveAsNew = () =>
    setNameAsk({ title: "Save as a new scenario", initial: `${workingName} (copy)`, confirm: "Save", taken: namesTaken(null), onConfirm: (name) => (setNameAsk(null), startSave(name, true)) });
  /**
   * Change one field of the saved scenario on screen and save it at once (a rename, a new parent), as the saved scenario stands: any
   * other edits not yet saved stay on screen, unsaved. Saved with the usual check that nobody else changed it since the page loaded it.
   * Returns why it was refused, or null.
   */
  const saveField = async (fields: { name: string } | { parent_id: string | null }): Promise<string | null> => {
    const base = savedScenario;
    if (!base) return "Save the scenario first.";
    const parsed = parseSandboxInput({ name: base.name, description: base.description, parent_id: base.parent_id, changes: base.changes, horizon_months: base.horizon_months, ...fields }, { ...parseContext, selfId: base.id });
    if (!parsed.ok) return parsed.error;
    let row: SandboxScenarioRow;
    if (demo) row = saveDemoScenario({ id: base.id, ...parsed.value });
    else {
      try {
        const r = await saveSandboxScenario(live.workspace.id, base.id, parsed.value, base.updated_at);
        if (r.status === "error") return r.message;
        row = r.scenario;
      } catch {
        return "Couldn't save the scenario. Try again.";
      }
      setLiveScenarios((prev) => [...prev.filter((p) => p.id !== row.id), row].sort((a, b) => a.name.localeCompare(b.name)));
    }
    // What was being edited stays, with this change in it.
    setEdit((prev) => (prev ? { ...prev, ...fields } : prev));
    setSaveNote({ text: "Saved", tone: "ok" });
    return null;
  };
  const onRename = () =>
    setNameAsk({
      title: "Rename the scenario",
      initial: workingName,
      confirm: "Rename",
      taken: namesTaken(savedScenario?.id ?? null),
      onConfirm: async (name) => {
        // A scenario that isn't saved yet has no row to rename: the name is kept for when it is saved.
        if (!savedScenario) {
          setNameAsk(null);
          setSaveNote(null);
          setEdit((prev) => ({ ...(prev ?? { description: null, parent_id: null, changes: [] }), name }));
          return null;
        }
        const refused = await saveField({ name });
        if (refused === null) setNameAsk(null);
        return refused;
      },
    });
  /** Change or clear what the scenario on screen builds on. A saved one is saved at once; a new one keeps it for when it is saved. */
  const applyParent = async (parentId: string | null): Promise<string | null> => {
    if (!savedScenario) {
      const parsed = parseSandboxInput({ name: workingName, description: null, parent_id: parentId, changes: working?.changes ?? [], horizon_months: months }, { ...parseContext, selfId: null });
      if (!parsed.ok) return parsed.error;
      setEdit((prev) => ({ ...(prev ?? { name: workingName, description: null, parent_id: null, changes: [] }), parent_id: parentId }));
      setParentAsk(false);
      return null;
    }
    const refused = await saveField({ parent_id: parentId });
    if (refused === null) setParentAsk(false);
    return refused;
  };
  /** Duplicate: a new scenario with the same changes and the same parent. */
  const onDuplicate = () => {
    if (!savedScenario) return;
    const source = savedScenario;
    guarded(() =>
      setNameAsk({
        title: "Duplicate the scenario",
        initial: `${source.name} (copy)`,
        confirm: "Duplicate",
        taken: namesTaken(null),
        onConfirm: (name) => {
          setNameAsk(null);
          void save({ name, description: source.description, parent_id: source.parent_id, changes: source.changes, horizon_months: source.horizon_months }, null);
        },
      }),
    );
  };
  /** Build on: a new scenario that starts from this one, with no changes of its own. */
  const onBuildOn = () => {
    if (!savedScenario) return;
    const source = savedScenario;
    guarded(() =>
      setNameAsk({
        title: `Build on “${source.name}”`,
        initial: `${source.name}, then …`,
        confirm: "Create",
        taken: namesTaken(null),
        onConfirm: (name) => {
          setNameAsk(null);
          void save({ name, description: null, parent_id: source.id, changes: [], horizon_months: months }, null);
        },
      }),
    );
  };
  const onDelete = () => {
    if (!savedScenario) return;
    const target = savedScenario;
    setConfirm({
      title: `Delete the scenario “${target.name}”? This can't be undone.`,
      confirm: "Delete",
      cancel: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setConfirm(null);
        if (demo) {
          const r = deleteDemoScenario(target.id);
          if (!r.ok) return setSaveNote({ text: r.message, tone: "error" });
        } else {
          try {
            const r = await deleteSandboxScenario(live.workspace.id, target.id);
            if (r.status === "error") return setSaveNote({ text: r.message, tone: "error" });
          } catch {
            return setSaveNote({ text: "Couldn't delete the scenario. Try again.", tone: "error" });
          }
          setLiveScenarios((prev) => prev.filter((p) => p.id !== target.id));
        }
        setSelected(null);
        setEdit(null);
        setOverride(null);
        setSaveNote({ text: "Deleted", tone: "ok" });
        writeUrl({ scenario: null, plan: null, horizon: null });
      },
    });
  };

  const openCompare = () =>
    guarded(() => {
      const other = savedScenario?.id ?? saved[0]?.id;
      if (!other) return;
      const ids = [other];
      setEdit(null);
      setCompare(ids);
      writeUrl({ compare: ids.join(",") });
    });
  const changeCompare = (ids: string[]) => {
    const next = ids.slice(0, MAX_COMPARE);
    setCompare(next.length ? next : null);
    writeUrl({ compare: next.length ? next.join(",") : null });
  };
  const closeCompare = () => {
    setCompare(null);
    writeUrl({ compare: null });
  };
  // A scenario deleted elsewhere can't stay in a comparison.
  const comparing = compare && compare.some((id) => saved.some((s) => s.id === id)) ? compare.filter((id) => saved.some((s) => s.id === id)) : null;

  const span = horizonLabel(months);
  const planned = shownData?.markers.length ?? 0;
  const laneProps: PlanLane | undefined =
    working !== null && bounds
      ? {
          markers: inSpan,
          bounds,
          startDate: start,
          hoursPerWeek: built.model?.hoursPerWeek ?? hpw,
          // A phone is read only (issue #44), and so is a Viewer: the lane draws the changes but can't move or remove them.
          editable: canEdit && !isPhone,
          status: plan.status,
          runs: plan.finished,
          onMove: moveChange,
          onEdit: editChange,
          onRemove: removeChange,
        }
      : undefined;
  // A hire can be offered when its lever is on in Settings, Levers and does something in this model.
  const hireOffered = offeredLevers(hiddenLevers).some((l) => l.id === "D1") && !appliesReason("D1");
  const solutionOptions = planSolutions.map((s) => ({
    id: s.id,
    name: s.name,
    processName: processNames.get(s.process_id) ?? "Another process",
    inModel: processNames.has(s.process_id),
    leverChanges: s.lever_changes.length,
    older: liveRevisions[s.process_id] !== undefined && s.base_revision_id !== liveRevisions[s.process_id],
  }));
  const purposeCategories = useMemo(() => workspacePurposes(live.workspace.settings), [live.workspace.settings]);
  // What the Export menu and the printed summary hold: the live run, and the scenario on screen once its run has finished.
  const exportMonths = useMemo(() => (shownRun?.result.monthly ? timelineMonths(start, shownRun.result.monthly.months, shownRun.model.hoursPerWeek) : null), [shownRun, start]);
  const exportColumns: PrintColumn[] | null = useMemo(() => {
    if (!built.model || !result?.monthly) return null;
    const columns: PrintColumn[] = [{ name: "No changes", monthly: result.monthly, priceRise: null, changes: [] }];
    if (working !== null && !scenarioError) {
      if (plan.status !== "done" || !plan.run?.result.monthly) return null;
      columns.push({ name: workingName, monthly: plan.run.result.monthly, priceRise: plan.priceRise, changes: effectiveList ?? [] });
    }
    return columns;
  }, [built.model, result, working, scenarioError, plan.status, plan.run, plan.priceRise, workingName, effectiveList]);
  const exportReason = comparing ? null : exportColumns ? null : working !== null && (plan.status === "running" || plan.status === "idle") ? "Wait for the run to finish." : "There is nothing to export yet.";
  const exportData: ExportData | null = useMemo(
    () => (exportColumns && exportMonths && shownRun ? { columns: exportColumns, months: exportMonths, model: shownRun.model, categories: purposeCategories, currency: live.workspace.settings.currency, ctx } : null),
    [exportColumns, exportMonths, shownRun, purposeCategories, live.workspace.settings.currency, ctx],
  );
  const roleNames = useMemo(() => Object.fromEntries(Object.entries(shownRun?.model.roles ?? {}).map(([id, r]) => [id, r.name])), [shownRun]);
  const timingLine = useMemo(
    () => (shownRun?.result.monthly && exportMonths ? capacityLine(capacityRunsOut(shownRun.result.monthly, roleNames, cutoffs), exportMonths, horizonLabel(months)) : null),
    [shownRun, exportMonths, roleNames, cutoffs, months],
  );
  const people = namedForViewer(viewerOf(live), live.people.filter((p) => p.active))
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Built-in drivers by key (tenure and market have no chances), then your own as custom:<id>.
  const driverOptions = [
    ...BUILTIN_CHURN_DRIVER_IDS.filter((id) => id !== "tenure" && id !== "market").map((id) => ({ id: id as string, name: CHURN_DRIVER_SPECS[id].name })),
    ...(live.churnDrivers ?? []).filter((d) => d.driver === null).map((d) => ({ id: `${CUSTOM_DRIVER_PREFIX}${d.id}`, name: d.name ?? "Your own driver" })),
  ];
  const parentName = working?.parent_id ? (saved.find((s) => s.id === working.parent_id)?.name ?? null) : null;

  // Goal seek and "What matters most" run on the scenario on screen, or on No changes: the same bundle, solutions, horizon and start.
  const analysisRun = useMemo(() => ({ bundle: live, solutions: planSolutions, months, startDate: start }), [live, planSolutions, months, start]);
  const analysisBase = useMemo<EffectiveChange[]>(() => (working !== null && !scenarioError ? (effectiveList ?? NO_EFFECTIVE) : NO_EFFECTIVE), [working, scenarioError, effectiveList]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Company"
        title="Sandbox"
        description={note ?? "Try a change before you make it: your live model run forward month by month, with scenarios of hires, price changes and solutions you can save and compare. Nothing here changes live data."}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!comparing ? (
              <SandboxExportMenu fileName={`${live.workspace.name} ${working !== null ? workingName : "live model"}`} disabledReason={exportReason} data={exportData} hasCosts={canEdit && (exportData?.columns.every((c) => c.monthly.money) ?? false)} includeCosts={includeCosts} onIncludeCosts={setIncludeCosts} onPrint={() => window.print()} />
            ) : null}
            <HorizonPicker weeks={horizonWeeks(months)} onChange={pickHorizon} options={HORIZONS} custom={CUSTOM} />
          </div>
        }
      />

      {built.error ? (
        <Card className="px-4 py-3 text-sm" role="alert">
          The company can&apos;t be simulated yet: {built.error}.
        </Card>
      ) : null}

      <section className="flex min-w-0 flex-col gap-3" data-forecast-alerts>
        <div className="flex flex-col gap-0.5">
          <h2 className={cn(SECTION_TITLE, "flex items-center")}>
            Who gets too busy, and when
            <Help
              label="Too busy alerts"
              description="For each role and person, the first month their work passes the “Too busy” line, on average or in a bad month (the worst 10% of the 30 simulated runs). Each is an insight: acknowledge it to track it as an issue."
              example="“PPC specialist gets too busy in February (92% in a bad month)” means hiring or moving work before February avoids it."
            />
          </h2>
          <p className="text-sm text-muted-foreground">
            Over the next {span}. Roles already too busy today are in the Overview&apos;s insights instead. These are your live model, whatever scenario is open below.
          </p>
          {speedsNormalisedFor(live) && (
            <p className="flex items-center text-sm text-muted-foreground" data-speeds-normalised>
              {SPEEDS_NORMALISED_NOTE.text}
              <Help label="Per-person times" description={SPEEDS_NORMALISED_NOTE.description} example={SPEEDS_NORMALISED_NOTE.example} />
            </p>
          )}
          {!canEdit ? (
            <p className="flex items-center text-sm text-muted-foreground" data-viewer-note>
              Your numbers can differ slightly from an Agency admin&apos;s.
              <Help {...SANDBOX_HELP.viewers} />
            </p>
          ) : null}
        </div>
        {alerts !== null && alerts.length === 0 && state.issues.length === 0 ? (
          <Card className="px-4 py-3 text-sm text-muted-foreground" data-forecast-empty>
            Nobody crosses the {Math.round(busyLine * 100)}% line in the next {span}, on average or in a bad month.
          </Card>
        ) : (
          <InsightsSection
            state={state}
            detected={alerts}
            processId={live.process.id}
            scenarios={[]}
            formOptions={formOptions}
            currency={live.workspace.settings.currency}
            stepName={(id) => stepNames.get(id) ?? null}
            processName={(id) => {
              const p = processOfStepMap.get(id);
              return p ? (processNames.get(p) ?? null) : null;
            }}
            processOfStep={(id) => processOfStepMap.get(id) ?? null}
            onLight={() => {}}
            registerHref={issuesHref}
            canEdit={canEdit}
          />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-sandbox-scenario>
        <ScenarioBar
          scenarios={saved}
          selectedId={savedScenario?.id ?? null}
          unsavedName={savedScenario === null && edit ? edit.name : null}
          // A Viewer may change the horizon, but has nothing to save: no "Unsaved changes" for them.
          dirty={dirty || (canEdit && horizonChanged)}
          hasScenario={working !== null}
          canEdit={canEdit}
          parentName={parentName}
          running={!comparing && working !== null && plan.status === "running"}
          saveNote={saveNote}
          problems={[]}
          later={[]}
          onSelect={selectScenario}
          onNew={newScenario}
          onAddChange={() => setChangeTarget({ mode: "add" })}
          onSave={onSave}
          onFindValue={built.model && !scenarioError ? () => setGoalOpen(true) : undefined}
          share={mode === "live" && savedScenario && !dirty && !horizonChanged ? <ShareButton slug={sharePath(pathname)} kind="scenario" targetId={savedScenario.id} what={savedScenario.name} /> : null}
          shareHint={mode === "live" && savedScenario && (dirty || horizonChanged) ? "Save first to share it." : null}
          onSaveAsNew={onSaveAsNew}
          onRename={onRename}
          onDuplicate={onDuplicate}
          onBuildOn={onBuildOn}
          onChangeParent={() => setParentAsk(true)}
          onDelete={onDelete}
          onCompare={openCompare}
        />
        {!comparing ? (
          <>
            {scenarioError ? (
              <Card className="px-4 py-3 text-sm" role="alert" data-scenario-error>
                {scenarioError}
              </Card>
            ) : null}
            <ChangeList
              ctx={ctx}
              changes={effectiveList ?? []}
              problems={plan.problems}
              later={plan.later}
              hiddenKinds={hiddenLevers}
              appliesReason={appliesReason}
              changeReason={(c) => (model ? (sandboxLever(c.lever)?.changeApplies?.(model, c) ?? null) : null)}
              leversHref={leversHref}
              canEdit={canEdit}
              hasScenario={working !== null}
              hasSaved={saved.length > 0}
              onAdd={() => setChangeTarget({ mode: "add" })}
              onEdit={editChange}
              onRemove={removeChange}
              onNew={newScenario}
            />
            {working !== null && plan.status !== "idle" && !scenarioError ? (
              <div className="flex flex-col gap-1" data-with-this-scenario>
                <h3 className="flex items-center text-sm font-medium">
                  With this scenario
                  <Help
                    label="With this scenario"
                    description="For each role, the first month it gets too busy with this scenario, set against your live forecast. It is a preview: it isn't kept as an insight."
                    example="“PPC specialist: too busy from March 2027 (with no changes: February 2027)” means the scenario buys a month."
                  />
                </h3>
                {plan.status === "error" ? (
                  <p className="text-sm text-muted-foreground" role="alert">
                    The scenario couldn&apos;t be worked out: {plan.error}
                  </p>
                ) : withThisScenario === null ? (
                  <p className="text-sm text-muted-foreground">Working out what this scenario does…</p>
                ) : withThisScenario.length || fullNotes.length ? (
                  <ul className="list-disc pl-5 text-sm">
                    {withThisScenario.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                    {fullNotes.map((note) => (
                      <li key={note.text} data-full-note>
                        {note.text}
                        {canEdit && note.hireRoleId && hireOffered ? (
                          <>
                            {" "}
                            <button
                              type="button"
                              className={cn("underline", EDIT_ONLY)}
                              data-edit-entry
                              data-full-note-hire={note.hireRoleId}
                              onClick={() => setChangeTarget({ mode: "add", preset: { lever: "D1", target: note.hireRoleId!, month: monthOptions[note.month]?.value } })}
                            >
                              Try a hire for this role
                            </button>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">This scenario doesn&apos;t change when anyone gets too busy.</p>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      {comparing ? (
        <SandboxCompare live={live} startDate={start} months={months} scenarios={saved} solutions={planSolutions} ids={comparing} cutoffs={cutoffs} canEdit={canEdit} onChange={changeCompare} onBack={closeCompare} />
      ) : (
        <section className="flex min-w-0 flex-col gap-3" data-forecast-timeline-section>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className={SECTION_TITLE}>Month by month</h2>
              <p className="text-sm text-muted-foreground">How busy each {rows === "roles" ? "role" : "person"} is, with the 10–90% range from 30 runs, and your clients by service.</p>
            </div>
            <div role="group" aria-label="Show" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
              {(["roles", "people"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={rows === r}
                  onClick={() => setRows(r)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    rows === r ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r === "roles" ? "By role" : "By person"}
                </button>
              ))}
            </div>
          </div>
          <Card className="gap-3 px-4 py-4" data-chart="forecast" aria-busy={working !== null && plan.status === "running" ? true : undefined}>
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
              <TimelineLegend
                busyLine={busyLine}
                hasUncovered={shownData?.roles.some((r) => r.uncovered) ?? false}
                hasMarkers={planned > 0}
                hasMarket={(shownData?.market.length ?? 0) > 0}
                hasPlan={laneProps !== undefined}
              />
              <Help
                label="The “Too busy” line"
                description="Where a role or person counts as too busy (the “Too busy” cut-off for Bad). Above it there is little room for a bad month or a new client."
                example="At 85%, someone with 40 hours spends more than 34 of them on work."
              />
            </div>
            {rows === "people" && shownData && shownData.people.length === 0 && !viewerOf(live).seesEveryone ? (
              <p className="text-sm text-muted-foreground" data-people-empty>
                By person shows only your own row, and there is none to show: you aren&apos;t linked to a person on the team, or they have no work in this span. Agency admins and the Owner see everyone.
              </p>
            ) : null}
            {shownData ? (
              <ForecastTimeline
                data={shownData}
                rows={rows}
                cutoffs={cutoffs}
                plan={laneProps}
                label={`How busy each ${rows === "roles" ? "role" : "person"} is per month over the next ${span}, against the ${Math.round(busyLine * 100)}% too busy line.`}
              />
            ) : sim.status === "error" ? (
              <p className="text-sm text-muted-foreground">The forecast couldn&apos;t be worked out: {sim.error}</p>
            ) : (
              <Skeleton className="h-[320px] w-full" aria-busy="true" />
            )}
            {shownData && partMonthNote(shownData.months) ? (
              <p className="text-xs text-muted-foreground" data-part-month-note>
                * {partMonthNote(shownData.months)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {planned ? `${planned} planned change${planned === 1 ? "" : "s"} from Settings: ` : "No planned hires, end dates or leave from Settings in this span. "}
              {shownData?.markers.map((mk) => `${mk.label} ${mk.kind === "leave" ? `from ${mk.when}` : `on ${mk.when}`}`).join("; ")}
              {planned ? ". " : ""}
              {inSpan.length ? `This scenario: ${inSpan.map((mk) => `${mk.label}, ${mk.when}`).join("; ")}. ` : ""}
              {peopleHref ? (
                <>
                  Start dates, end dates and leave are set in{" "}
                  <Link href={peopleHref} className="underline">
                    Settings
                  </Link>
                  , under People.
                </>
              ) : null}{" "}
            </p>
          </Card>
        </section>
      )}
      {!compare && shownRun?.result.monthly && exportMonths ? (
        <Timing
          monthly={shownRun.result.monthly}
          months={exportMonths}
          model={shownRun.model}
          roleNames={roleNames}
          cutoffs={cutoffs}
          horizonMonths={months}
          onLonger={pickHorizon}
          changes={working !== null && !scenarioError ? (effectiveList ?? []) : NO_EFFECTIVE}
          live={live}
          solutions={planSolutions}
          startDate={start}
          ctx={ctx}
          currency={live.workspace.settings.currency}
          canSeeMoney={canEdit && Boolean(shownRun.result.monthly.money)}
        />
      ) : null}
      {!compare && shownRun?.result.monthly ? (
        <TimeByPurpose
          monthly={shownRun.result.monthly}
          months={timelineMonths(start, shownRun.result.monthly.months, shownRun.model.hoursPerWeek)}
          categories={purposeCategories}
          roles={Object.entries(shownRun.model.roles).map(([id, r]) => ({ id, name: r.name }))}
          people={people}
          viewer={viewerOf(live)}
          span={span}
          purposesHref={mode === "live" ? purposesHref : null}
        />
      ) : null}
      {!compare && moneyView ? (
        <ForecastMoney view={moneyView} currency={live.workspace.settings.currency} overheadsHref={mode === "live" && peopleHref ? `${peopleHref}#workspace-heading` : null} span={span} />
      ) : null}
      {!compare && built.model && !scenarioError ? (
        <Tornado
          key={`${selected ?? "none"}|${months}|${JSON.stringify(analysisBase.map((e) => e.change))}`}
          run={analysisRun}
          base={analysisBase}
          model={built.model}
          hiddenLevers={hiddenLevers}
          cutoffs={cutoffs}
          categories={purposeCategories}
          currency={live.workspace.settings.currency}
          canSeeMoney={canEdit && Boolean(result?.monthly?.money)}
          canAdd={canEdit}
          onUse={(preset) => setChangeTarget({ mode: "add", preset })}
        />
      ) : null}
      {!compare && working !== null && plan.priceRise && !scenarioError ? <PriceRise tradeoff={plan.priceRise} months={timelineMonths(start, plan.run!.result.monthly!.months, plan.run!.model.hoursPerWeek)} currency={live.workspace.settings.currency} /> : null}

      {!comparing && built.model && exportColumns && exportMonths ? (
        <PrintSummary
          workspaceName={live.workspace.name}
          title={working !== null ? workingName : "Live model"}
          printedOn={today()}
          startDate={start}
          horizonMonths={months}
          engineVersion={ENGINE_VERSION}
          model={built.model}
          bundle={live}
          columns={exportColumns}
          cutoffs={cutoffs}
          categories={purposeCategories}
          currency={live.workspace.settings.currency}
          costs={canEdit && includeCosts && exportColumns.every((c) => c.monthly.money)}
          timingLine={timingLine}
          ctx={ctx}
        />
      ) : null}

      {changeTarget && canEdit ? (
        <ChangeDialog
          key={changeTarget.mode === "edit" ? changeTarget.change.id : "add"}
          target={changeTarget}
          levers={offeredLevers(hiddenLevers)}
          appliesReason={appliesReason}
          roles={live.roles.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }))}
          people={people}
          steps={parts.flatMap((p) => p.steps).filter((s) => s.role_id || s.person_id).map((s) => ({ id: s.id, name: s.name }))}
          services={live.services.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
          leadSources={(live.leadSources ?? []).map((s) => ({ id: s.id, name: s.name }))}
          drivers={driverOptions}
          solutions={solutionOptions}
          months={monthOptions}
          defaultMonth={monthOptions[1]?.value ?? monthOptions[0]?.value ?? start.slice(0, 7)}
          defaultMonday={mondayOnOrBefore(addDays(start, 7))}
          currency={live.workspace.settings.currency}
          today={(leverId, targetId) => {
            const lever = sandboxLever(leverId);
            if (!lever || !model) return null;
            // What the live run measured, for the levers whose "today" is an outcome (conversion, a driver's chance).
            const finished = result ? result.kpi.won.mean + result.kpi.lost.mean : 0;
            return todayValue(lever, targetId, model, live.workspace.settings.currency, {
              conversion: result && finished > 0 ? result.kpi.won.mean / finished : null,
              causes: result?.churnCauses?.causes,
            });
          }}
          mix={mix}
          validate={(change) => {
            const others = (working?.changes ?? []).filter((c) => c.id !== change.id);
            const parsed = parseSandboxInput({ name: "x", parent_id: working?.parent_id ?? null, changes: [...others, change], horizon_months: months }, { ...parseContext, selfId: selected });
            return parsed.ok ? null : parsed.error;
          }}
          onSubmit={(change) => {
            if (changeTarget.mode === "edit") replaceChange(change);
            else addChange(change);
            setChangeTarget(null);
          }}
          onRemove={() => {
            if (changeTarget.mode === "edit") removeChange(changeTarget.change.id);
            setChangeTarget(null);
          }}
          onClose={() => setChangeTarget(null)}
        />
      ) : null}
      {goalOpen && built.model ? (
        <GoalSeekDialog
          run={analysisRun}
          base={analysisBase}
          cutoffs={cutoffs}
          roles={live.roles.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }))}
          steps={parts.flatMap((p) => p.steps).filter((s) => s.role_id || s.person_id).map((s) => ({ id: s.id, name: s.name }))}
          services={live.services.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
          months={monthOptions}
          currency={live.workspace.settings.currency}
          canSeeMoney={canEdit && Boolean(result?.monthly?.money)}
          canAdd={canEdit && working !== null}
          onAdd={(preset) => setChangeTarget({ mode: "add", preset })}
          onClose={() => setGoalOpen(false)}
          hiddenLevers={hiddenLevers}
        />
      ) : null}
      {confirm ? <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} /> : null}
      {nameAsk ? <NameDialog {...nameAsk} onCancel={() => setNameAsk(null)} /> : null}
      {parentAsk && working ? (
        <ParentDialog
          title={`What “${workingName}” builds on`}
          current={working.parent_id}
          options={saved.filter((s) => s.id !== savedScenario?.id).map((s) => ({ id: s.id, name: s.name }))}
          onConfirm={applyParent}
          onCancel={() => setParentAsk(false)}
        />
      ) : null}
    </div>
  );
}

