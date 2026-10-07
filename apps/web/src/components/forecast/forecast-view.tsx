"use client";

// The Forecast page (issue #35, B6): will someone become too busy, and when? The company model is run forward month
// by month over the horizon picked, with planned hires (people's start dates), end dates and leave, the market
// schedule and the client groups. The first month each role and person crosses the "Too busy" line becomes an insight
// (Acknowledge, as any other), and the monthly timeline shows how busy each role or person is, the client groups by
// service, the market conditions and the planned changes.
//
// B7 (#36) makes it a planning tool: a "Your plan" lane on the timeline holds hire, leave and solution markers that can be
// added, dragged along the months (or moved by keyboard) and removed, and the forecast re-runs with them. A set of
// markers is a plan, saved with a name (owners, editors and agency admins only; the demo keeps plans in the tab), and
// two plans can be compared side by side. The live forecast, and its insights, are never changed by a plan.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { partOf, speedsNormalisedFor, type ForecastPlanMarker, type ForecastPlanRow, type IssueRow, type ProcessBundle, type SolutionRow, type SourceRow } from "@transpera-flow/db";
import { firstCrossing, toRatingConfig } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { InsightsSection } from "@/components/insights";
import { PageHeader } from "@/components/shell/page";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { savePlan, deletePlan } from "@/app/w/[slug]/forecast-plan-actions";
import { DEFAULT_FORECAST_MONTHS, forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { laneMarkers } from "@/lib/forecast/lane";
import { MAX_MARKERS, parsePlanInput, type PlanParseContext } from "@/lib/forecast/plan";
import { addDays, dateAtPosition, hoursToDate, mondayOnOrBefore, monthBounds } from "@/lib/forecast/positions";
import { deleteDemoPlan, saveDemoPlan, useDemoPlans } from "@/lib/forecast/plans-demo";
import { runKey, sharedSimPool } from "@/lib/forecast/sim-pool";
import { timelineData, timelineMonths } from "@/lib/forecast/timeline";
import { usePlanForecast } from "@/lib/forecast/use-plan-forecast";
import { useDemoSolutions } from "@/lib/solutions/demo";
import { horizonLabel, horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import { issueFormOptions } from "@/lib/issues/draft";
import { useIssues } from "@/lib/issues/use-issues";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { SPEEDS_NORMALISED_NOTE } from "@/lib/people";
import { useSimulation } from "@/lib/sim/use-simulation";
import { cn } from "@/lib/utils";
import { ForecastTimeline, TimelineLegend, type PlanLane } from "./forecast-timeline";
import { NO_CHANGES, NameDialog, ConfirmDialog, PlanBar, UNSAVED_PLAN } from "./plan-bar";
import { COMPARE_LIVE, PlanCompare } from "./plan-compare";
import { PlanMarkerDialog, type MarkerTarget } from "./plan-marker-dialog";
import { namedForViewer, viewerOf } from "@/lib/viewer";

export interface ForecastViewProps {
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Tracked issues: an acknowledged alert is one of them. */
  issues: IssueRow[];
  sources?: SourceRow[];
  mode: "live" | "demo" | "readonly";
  issuesHref: string;
  rulesHref?: string;
  /** Settings, where people's start dates, end dates and leave are set. Null on the demo. */
  peopleHref?: string | null;
  /** The ISO date the forecast starts on; today when omitted. Fixed on the demo so its months don't move. */
  startDate?: string;
  /** A line under the title, e.g. the demo's note about its sample plan. */
  note?: string;
  /** Saved forecast plans (owners, editors and agency admins; none otherwise). */
  plans?: ForecastPlanRow[];
  /** Saved solutions a plan can put live. On the demo the tab's own are added to these. */
  solutions?: SolutionRow[];
  /** The demo: plans live in the tab (a store seeded with two) instead of the database. */
  demoPlans?: boolean;
}

const NO_SOURCES: SourceRow[] = [];
const NO_PLANS: ForecastPlanRow[] = [];
const NO_SOLUTIONS: SolutionRow[] = [];
const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const isForecastIssue = (i: IssueRow) => i.detected_key?.startsWith("forecast:") ?? false;

/** The plan on screen, as it is being worked on: its name and markers. */
interface Draft {
  name: string;
  markers: ForecastPlanMarker[];
}

type Confirm = { title: string; description?: string; confirm: string; cancel: string; destructive?: boolean; onConfirm: () => void } | null;
type NameAsk = { title: string; initial: string; confirm: string; taken: string[]; onConfirm: (name: string) => void } | null;

export function ForecastView({ live, issues, sources = NO_SOURCES, mode, issuesHref, peopleHref = null, startDate, note, plans = NO_PLANS, solutions = NO_SOLUTIONS, demoPlans = false }: ForecastViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const horizonParam = Number(searchParams.get("horizon"));
  const [months, setMonths] = useState<number>(isHorizonMonths(horizonParam) ? horizonParam : DEFAULT_FORECAST_MONTHS);
  /** Change some of the page's URL parameters (null removes one), without a scroll or a new history entry. */
  const writeUrl = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    // A comma stays a comma: `?compare=a,b`.
    const qs = next.toString().replace(/%2C/gi, ",");
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const pick = (m: number) => {
    setMonths(m);
    writeUrl({ horizon: String(m) });
  };
  const [rows, setRows] = useState<"roles" | "people">("roles");
  const start = useMemo(() => startDate ?? today(), [startDate]);

  const built = useMemo(() => forecastModel(live, months, start), [live, months, start]);
  const sim = useSimulation(built.model, 30, 1, { monthly: true, monthStarts: built.monthStarts });
  const result = sim.status === "done" && built.model && sim.run.result.H === built.model.horizonWeeks * built.model.hoursPerWeek ? sim.run.result : null;
  // The live run is also what a plan with no changes would run (and segment 0 of any plan with no solution at month 0): hand it
  // to the plans' pool, so nobody runs it twice.
  useEffect(() => {
    if (built.model && built.monthStarts && result) sharedSimPool().seed(runKey(built.model, built.monthStarts), result);
  }, [built.model, built.monthStarts, result]);
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

  // ---- Plans (B7): owners, editors and agency admins only; a member or viewer sees the forecast as it was. ----
  const planUi = mode !== "readonly";
  const demoStore = useDemoPlans();
  const demoSolutions = useDemoSolutions();
  const [livePlans, setLivePlans] = useState(plans);
  const saved = planUi ? (demoPlans ? demoStore : livePlans) : NO_PLANS;
  const planSolutions = useMemo(() => (!planUi ? NO_SOLUTIONS : demoPlans ? [...solutions, ...demoSolutions.solutions] : solutions), [planUi, demoPlans, solutions, demoSolutions.solutions]);
  const [selected, setSelected] = useState<string | null>(() => {
    const id = planUi ? searchParams.get("plan") : null;
    return id && saved.some((p) => p.id === id) ? id : null;
  });
  /** Changes on top of the saved plan shown, or (with none shown) a new plan that isn't saved yet. */
  const [edit, setEdit] = useState<Draft | null>(null);
  const [compare, setCompare] = useState<[string, string] | null>(() => {
    const ids = planUi ? (searchParams.get("compare")?.split(",") ?? []) : [];
    const known = (id: string) => id === COMPARE_LIVE || saved.some((p) => p.id === id);
    return ids.length === 2 && ids.every(known) ? [ids[0]!, ids[1]!] : null;
  });
  const [markerTarget, setMarkerTarget] = useState<MarkerTarget | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [nameAsk, setNameAsk] = useState<NameAsk>(null);
  const [saveNote, setSaveNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  const savedPlan = saved.find((p) => p.id === selected) ?? null;
  const workingMarkers = planUi ? (edit?.markers ?? savedPlan?.markers ?? null) : null;
  const workingName = edit?.name ?? savedPlan?.name ?? "New plan";
  const dirty = edit !== null && (savedPlan === null || edit.name !== savedPlan.name || JSON.stringify(edit.markers) !== JSON.stringify(savedPlan.markers));
  const plan = usePlanForecast({ bundle: live, markers: compare ? null : workingMarkers, solutions: planSolutions, months, startDate: start });
  const hpw = live.workspace.settings.hours_per_week;
  const bounds = useMemo(() => (built.model ? monthBounds(built.monthStarts, built.model.horizonWeeks * built.model.hoursPerWeek) : null), [built]);
  const horizonHours = bounds ? bounds[bounds.length - 1]! : 0;

  // The timeline shows the plan's numbers once a run has finished (the old chart stays while a newer one runs).
  const planData = useMemo(
    () => (plan.run ? timelineData(plan.run.model, plan.run.result, live, start, { markersModel: plan.run.markersModel, planPeople: plan.run.planPeople }) : null),
    [plan.run, live, start],
  );
  const shownData = workingMarkers !== null && planData ? planData : data;

  const lane = useMemo(() => laneMarkers(live, workingMarkers ?? [], planSolutions, plan.problems, start, hpw), [live, workingMarkers, planSolutions, plan.problems, start, hpw]);
  const inSpan = useMemo(() => lane.filter((mk) => bounds !== null && hoursToDate(start, mk.date, hpw) < horizonHours), [lane, bounds, start, hpw, horizonHours]);
  const afterSpan = useMemo(() => lane.filter((mk) => !inSpan.includes(mk)).map((mk) => `${mk.label} (${mk.when})`), [lane, inSpan]);

  const parseContext: PlanParseContext = useMemo(
    () => ({ solutions: planSolutions, processName: (id: string) => processNames.get(id) ?? "that process" }),
    [planSolutions, processNames],
  );
  const monthOptions = useMemo(() => {
    if (!built.model || !bounds) return [];
    const spans = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1]! }));
    return timelineMonths(start, spans, built.model.hoursPerWeek).map((mo, i) => ({ value: dateAtPosition(i, "month", start, bounds, hpw), label: mo.long }));
  }, [built.model, bounds, start, hpw]);

  /** What a plan does to when each role gets too busy, against the live forecast. */
  const withThisPlan = useMemo(() => {
    if (workingMarkers === null || compare || !plan.run || !result || !built.model || plan.status === "error") return null;
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
  }, [workingMarkers, compare, plan.run, plan.status, result, built.model, cutoffs, start, months]);

  const changeMarkers = (fn: (markers: ForecastPlanMarker[]) => ForecastPlanMarker[]) => {
    setSaveNote(null);
    setEdit((prev) => {
      const base: Draft = prev ?? (savedPlan ? { name: savedPlan.name, markers: savedPlan.markers } : { name: "New plan", markers: [] });
      return { ...base, markers: fn(base.markers) };
    });
  };
  const addMarker = (marker: ForecastPlanMarker) => changeMarkers((ms) => [...ms, marker]);
  const moveMarker = (id: string, date: string) => changeMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, date } : m)));
  const replaceMarker = (marker: ForecastPlanMarker) => changeMarkers((ms) => ms.map((m) => (m.id === marker.id ? marker : m)));
  const removeMarker = (id: string) => changeMarkers((ms) => ms.filter((m) => m.id !== id));
  const editMarker = (id: string) => {
    const marker = workingMarkers?.find((m) => m.id === id);
    if (marker) setMarkerTarget({ mode: "edit", marker });
  };

  /** Run `go` now, or after asking whether to throw away the changes made to the plan on screen. */
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
  const selectPlan = (value: string) => {
    if (value === UNSAVED_PLAN || (value === NO_CHANGES ? savedPlan === null && edit === null : value === selected && !edit)) return;
    guarded(() => {
      setEdit(null);
      setSaveNote(null);
      setSelected(value === NO_CHANGES ? null : value);
      writeUrl({ plan: value === NO_CHANGES ? null : value });
    });
  };

  const finishSave = (row: ForecastPlanRow) => {
    setSelected(row.id);
    setEdit(null);
    setSaveNote({ text: "Saved", tone: "ok" });
    writeUrl({ plan: row.id });
  };
  const save = async (name: string, asNew: boolean, markers: ForecastPlanMarker[]) => {
    const parsed = parsePlanInput({ name, markers }, parseContext);
    if (!parsed.ok) return setSaveNote({ text: parsed.error, tone: "error" });
    const existing = asNew ? null : savedPlan;
    setSaveNote({ text: "Saving…", tone: "ok" });
    if (demoPlans) return finishSave(saveDemoPlan({ id: existing?.id ?? null, name: parsed.value.name, markers: parsed.value.markers }));
    try {
      const r = await savePlan(live.workspace.id, existing?.id ?? null, parsed.value, existing?.updated_at ?? null);
      if (r.status === "error") return setSaveNote({ text: r.message, tone: "error" });
      setLivePlans((prev) => [...prev.filter((p) => p.id !== r.plan.id), r.plan].sort((a, b) => a.name.localeCompare(b.name)));
      finishSave(r.plan);
    } catch {
      setSaveNote({ text: "Couldn't save the plan. Try again.", tone: "error" });
    }
  };
  /** Save the plan on screen; markers that need attention are left out, after a question. */
  const startSave = (name: string, asNew: boolean) => {
    const markers = workingMarkers ?? [];
    const stale = new Set(plan.problems.map((p) => p.markerId));
    if (!stale.size) return void save(name, asNew, markers);
    setConfirm({
      title: `Save without the ${stale.size} marker${stale.size === 1 ? "" : "s"} that need${stale.size === 1 ? "s" : ""} attention?`,
      description: plan.problems.map((p) => p.message).join("; ") + ".",
      confirm: "Save without them",
      cancel: "Cancel",
      onConfirm: () => {
        setConfirm(null);
        void save(name, asNew, markers.filter((m) => !stale.has(m.id)));
      },
    });
  };
  const namesTaken = (except: string | null) => saved.filter((p) => p.id !== except).map((p) => p.name);
  const onSave = () => {
    if (savedPlan) return startSave(workingName, false);
    setNameAsk({ title: "Save the plan", initial: workingName, confirm: "Save", taken: namesTaken(null), onConfirm: (name) => (setNameAsk(null), startSave(name, false)) });
  };
  const onSaveAsNew = () =>
    setNameAsk({ title: "Save as a new plan", initial: `${workingName} (copy)`, confirm: "Save", taken: namesTaken(null), onConfirm: (name) => (setNameAsk(null), startSave(name, true)) });
  const onRename = () =>
    setNameAsk({
      title: "Rename the plan",
      initial: workingName,
      confirm: "Rename",
      taken: namesTaken(savedPlan?.id ?? null),
      onConfirm: (name) => {
        setNameAsk(null);
        setSaveNote(null);
        setEdit((prev) => ({ markers: prev?.markers ?? savedPlan?.markers ?? [], name }));
      },
    });
  const onDelete = () => {
    if (!savedPlan) return;
    const target = savedPlan;
    setConfirm({
      title: `Delete the plan “${target.name}”? This can't be undone.`,
      confirm: "Delete",
      cancel: "Cancel",
      destructive: true,
      onConfirm: async () => {
        setConfirm(null);
        if (demoPlans) deleteDemoPlan(target.id);
        else {
          try {
            const r = await deletePlan(live.workspace.id, target.id);
            if (r.status === "error") return setSaveNote({ text: r.message, tone: "error" });
          } catch {
            return setSaveNote({ text: "Couldn't delete the plan. Try again.", tone: "error" });
          }
          setLivePlans((prev) => prev.filter((p) => p.id !== target.id));
        }
        setSelected(null);
        setEdit(null);
        setSaveNote({ text: "Deleted", tone: "ok" });
        writeUrl({ plan: null });
      },
    });
  };

  const openCompare = () =>
    guarded(() => {
      const other = savedPlan?.id ?? saved[0]?.id;
      if (!other) return;
      const ids: [string, string] = [COMPARE_LIVE, other];
      setEdit(null);
      setCompare(ids);
      writeUrl({ compare: ids.join(",") });
    });
  const changeCompare = (ids: [string, string]) => {
    setCompare(ids);
    writeUrl({ compare: ids.join(",") });
  };
  const closeCompare = () => {
    setCompare(null);
    writeUrl({ compare: null });
  };
  // A plan deleted elsewhere can't stay in a comparison.
  const comparing: [string, string] | null = compare && compare.every((id) => id === COMPARE_LIVE || saved.some((p) => p.id === id)) ? compare : null;

  const span = horizonLabel(months);
  const planned = shownData?.markers.length ?? 0;
  const laneProps: PlanLane | undefined =
    planUi && bounds
      ? {
          markers: inSpan,
          bounds,
          startDate: start,
          hoursPerWeek: built.model?.hoursPerWeek ?? hpw,
          editable: true,
          status: plan.status,
          runs: plan.finished,
          onMove: moveMarker,
          onEdit: editMarker,
          onRemove: removeMarker,
        }
      : undefined;
  const solutionOptions = planSolutions.map((s) => ({
    id: s.id,
    name: s.name,
    processId: s.process_id,
    processName: processNames.get(s.process_id) ?? "Another process",
    inModel: processNames.has(s.process_id),
    leverChanges: s.lever_changes.length,
    older: liveRevisions[s.process_id] !== undefined && s.base_revision_id !== liveRevisions[s.process_id],
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Company"
        title="Forecast"
        description={note ?? "Who gets too busy, and when: your live model run forward month by month, with planned hires, leave and the market schedule."}
        actions={<HorizonPicker weeks={horizonWeeks(months)} onChange={pick} />}
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
            Over the next {span}. Roles already too busy today are in the Overview&apos;s insights instead.
            {planUi ? " These are your live model, whatever plan is open below." : ""}
          </p>
          {speedsNormalisedFor(live) && (
            <p className="flex items-center text-sm text-muted-foreground" data-speeds-normalised>
              {SPEEDS_NORMALISED_NOTE.text}
              <Help label="Per-person times" description={SPEEDS_NORMALISED_NOTE.description} example={SPEEDS_NORMALISED_NOTE.example} />
            </p>
          )}
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
            canEdit={mode !== "readonly"}
          />
        )}
      </section>

      {planUi ? (
        <section className="flex min-w-0 flex-col gap-3" data-forecast-plan>
          <PlanBar
            plans={saved}
            selectedId={savedPlan?.id ?? null}
            unsavedName={savedPlan === null && edit ? edit.name : null}
            planName={workingMarkers === null ? "" : workingName}
            dirty={dirty}
            hasPlan={workingMarkers !== null}
            markerCount={workingMarkers?.length ?? 0}
            solutionMarkerCount={workingMarkers?.filter((m) => m.kind === "solution").length ?? 0}
            solutionCount={planSolutions.length}
            running={!comparing && plan.status === "running"}
            saveNote={saveNote}
            problems={comparing ? [] : plan.problems.map((p) => p.message)}
            later={comparing ? [] : afterSpan}
            onSelect={selectPlan}
            onAdd={(kind) => setMarkerTarget({ mode: "add", kind })}
            onSave={onSave}
            onSaveAsNew={onSaveAsNew}
            onRename={onRename}
            onDelete={onDelete}
            onCompare={openCompare}
          />
          {!comparing && workingMarkers !== null && plan.status !== "idle" ? (
            <div className="flex flex-col gap-1" data-with-this-plan>
              <h3 className="flex items-center text-sm font-medium">
                With this plan
                <Help
                  label="With this plan"
                  description="For each role, the first month it gets too busy with this plan, set against your live forecast. It is a preview: it isn't kept as an insight."
                  example="“PPC specialist: too busy from March 2027 (with no changes: February 2027)” means the plan buys a month."
                />
              </h3>
              {plan.status === "error" ? (
                <p className="text-sm text-muted-foreground" role="alert">
                  The plan couldn&apos;t be worked out: {plan.error}
                </p>
              ) : withThisPlan === null ? (
                <p className="text-sm text-muted-foreground">Working out what this plan does…</p>
              ) : withThisPlan.length ? (
                <ul className="list-disc pl-5 text-sm">
                  {withThisPlan.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">This plan doesn&apos;t change when anyone gets too busy.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {comparing ? (
        <PlanCompare live={live} startDate={start} months={months} plans={saved} solutions={planSolutions} ids={comparing} cutoffs={cutoffs} onChange={changeCompare} onBack={closeCompare} />
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
          <Card className="gap-3 px-4 py-4" data-chart="forecast" aria-busy={workingMarkers !== null && plan.status === "running" ? true : undefined}>
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
                description="Where a role or person counts as too busy (the “Too busy” cut-off for Bad). Above it there is little room for a bad month or a new client. You can change it in Settings, Analysis rules."
                example="At 85%, someone with 40 hours spends more than 34 of them on work."
              />
            </div>
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
            <p className="text-xs text-muted-foreground">
              {planned ? `${planned} planned change${planned === 1 ? "" : "s"} from Settings: ` : "No planned hires, end dates or leave from Settings in this span. "}
              {shownData?.markers.map((mk) => `${mk.label} ${mk.kind === "leave" ? `from ${mk.when}` : `on ${mk.when}`}`).join("; ")}
              {planned ? ". " : ""}
              {planUi && inSpan.length ? `Your plan: ${inSpan.map((mk) => `${mk.label}, ${mk.when}`).join("; ")}. ` : ""}
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

      {markerTarget ? (
        <PlanMarkerDialog
          key={markerTarget.mode === "edit" ? markerTarget.marker.id : `add-${markerTarget.kind}`}
          target={markerTarget}
          roles={live.roles.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }))}
          people={namedForViewer(viewerOf(live), live.people.filter((p) => p.active))
            .map((p) => ({ id: p.id, name: p.name }))
            .sort((a, b) => a.name.localeCompare(b.name))}
          solutions={solutionOptions}
          months={monthOptions}
          defaultMonth={monthOptions[1]?.value ?? monthOptions[0]?.value ?? start}
          defaultMonday={mondayOnOrBefore(addDays(start, 7))}
          validate={(marker) => {
            const others = (workingMarkers ?? []).filter((m) => m.id !== marker.id);
            if (others.length >= MAX_MARKERS) return `A plan can have up to ${MAX_MARKERS} markers.`;
            const parsed = parsePlanInput({ name: "x", markers: [...others, marker] }, parseContext);
            return parsed.ok ? null : parsed.error;
          }}
          onSubmit={(marker) => {
            if (markerTarget.mode === "edit") replaceMarker(marker);
            else addMarker(marker);
            setMarkerTarget(null);
          }}
          onRemove={() => {
            if (markerTarget.mode === "edit") removeMarker(markerTarget.marker.id);
            setMarkerTarget(null);
          }}
          onClose={() => setMarkerTarget(null)}
        />
      ) : null}
      {confirm ? <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} /> : null}
      {nameAsk ? <NameDialog {...nameAsk} onCancel={() => setNameAsk(null)} /> : null}
    </div>
  );
}
