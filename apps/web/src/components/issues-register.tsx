"use client";

// The issues register (docs/PRD.md §4.1, screen 9; issue #17): audit findings
// logged by hand and the issues the latest run detected, in one list with
// filters. Detected issues are read-only and refresh on every run; tracking
// one stores it (`source: promoted`) so later runs show it once, as tracked.

import { useState, type ReactNode } from "react";
import type { IssueRow, IssueSource, ScenarioRow } from "@transpera-flow/db";
import { ISSUE_TYPES, RATING_LABELS, type DetectedIssue, type Rating } from "@transpera-flow/engine";
import type { Saver } from "@/lib/fields/field-controller";
import {
  NO_FILTERS,
  RATINGS_WORST_FIRST,
  SOURCE_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  entryView,
  entriesInProcess,
  filterEntries,
  fixFor,
  formatIssueCost,
  issueLabel,
  registerEntries,
  type IssueFilters,
  type RegisterEntry,
} from "@/lib/issues/register";
import type { IssuesState } from "@/lib/issues/use-issues";
import { ISSUE_STATUSES, type IssueField } from "@/lib/issues/validate";
import { draftFromIssue, emptyDraft, toSaveInput, type IssueDraft, type IssueFormOptions } from "@/lib/issues/draft";
import { buttonVariants } from "@/components/ui/button";
import { PayHidden } from "@/components/pay-hidden";
import { NativeSelect } from "@/components/ui/native-select";
import { AcknowledgeDialog } from "./acknowledge-dialog";
import { SelectField, TextField, type SelectOption } from "./fields";
import { HelpLabel } from "./help";


/** Plain-English (i) text for the issue fields and filters, with an example (issue #123). */
const ISSUE_HELP = {
  status: { description: "Where this issue is: still open, having a solution tested, resolved, or one you have decided not to fix.", example: "Testing solutions means a change is being tried in a copy of the process." },
  rating: { description: "How serious it is: Great, Good, Bad, or Operational risk (could break delivery or lose clients).", example: "Operational risk for a step only one person can do." },
  type: { description: "What kind of problem it is.", example: "Manual means you wrote it yourself; detected ones come from the simulation." },
  person: { description: "The person it affects, if it is about one person.", example: "Maya Collins, when she is too busy." },
  fix: { description: "A saved scenario that tries a fix for this issue, so you can see if it helps.", example: "Hire a strategist." },
  evidence: { description: "What you saw or heard, and where, so others can trust it.", example: "Rosa said in the 3 Oct interview that reviews take 2 days." },
  process: { description: "Show only issues on one process.", example: "Lead to live." },
  source: { description: "Show only issues found one way: written by you, spotted by the simulation, or promoted from a spotted one.", example: "Detected shows what the simulation found." },
} as const;

const NONE: ReadonlySet<string> = new Set();

export interface Named {
  id: string;
  name: string;
}

const RATING_STRIPE: Record<Rating, string> = {
  risk: "before:bg-crit",
  bad: "before:bg-serious",
  good: "before:bg-warn",
  great: "before:bg-accent",
};
const RATING_CHIP: Record<Rating, string> = {
  risk: "border-crit bg-crit-soft",
  bad: "border-serious bg-crit-soft/60",
  good: "border-warn bg-warn-soft",
  great: "border-line bg-panel-2",
};

const chip = "rounded-full border border-border px-2 py-px text-xs whitespace-nowrap";
const button = buttonVariants({ variant: "outline", size: "xs" });

const options = (list: readonly Named[]): SelectOption[] => list.map((x) => ({ value: x.id, label: x.name }));
const typeOptions = ISSUE_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }));
// Filters pick a rating. The Acknowledge dialog (components/acknowledge-dialog.tsx) edits an issue's title, rating, scope, owners, target and sources.
const ratingOptions = RATINGS_WORST_FIRST.map((r) => ({ value: r, label: RATING_LABELS[r] }));
const statusOptions = ISSUE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }));

export function IssuesRegister({
  layout,
  view = "all",
  stepIds,
  state,
  detected,
  running,
  processId,
  processes,
  steps,
  people,
  options: formOptions,
  scenarios,
  brokenScenarios = NONE,
  canEdit,
  currency,
  stepFilter,
  onStepFilterChange,
  onHighlight,
  issueExtra,
  includeClosed = false,
}: {
  /** With `issues`: also list resolved and won't-fix issues (open ones first), so the status track can show them through to Verified. */
  includeClosed?: boolean;
  /** Drawn under a confirmed issue's row (the process page's status track and linked solutions). */
  issueExtra?: (issue: IssueRow) => ReactNode;
  /** The workspace currency, for each issue's cost per month. */
  currency: string;
  /** `rail`: narrow, beside the map; `page`: the full register screen. */
  layout: "rail" | "page";
  /**
   * `all`: insights and issues together, with filters (the register and the map's rail). `insights`: only what the run
   * found and nobody has confirmed. `issues`: only confirmed ones, with a button to log one by hand. The last two are
   * the process page's sections: they list this process's, with no filters.
   */
  view?: "all" | "insights" | "issues";
  /** With `insights` or `issues`: the steps that belong to the process (its own and those inside it); anything on another step is left out. */
  stepIds?: ReadonlySet<string>;
  state: IssuesState;
  /** This run's detections; null until the first run finishes. */
  detected: DetectedIssue[] | null;
  running: boolean;
  /** The process the detections came from. */
  processId: string;
  processes: Named[];
  steps: Named[];
  people: Named[];
  /** What the Acknowledge dialog offers to pick (New issue and Edit): processes, steps with their process, people and sources. */
  options: IssueFormOptions;
  scenarios: ScenarioRow[];
  /** Ids of saved scenarios that need attention: issues whose fix is one say so (issue #16). */
  brokenScenarios?: ReadonlySet<string>;
  canEdit: boolean;
  /** Show only issues on this step (from a badge on the map). */
  stepFilter: string;
  onStepFilterChange: (stepId: string) => void;
  /** Hovering or focusing an issue (null when leaving it) names the step it sits on, so the map can highlight it (issue #99). */
  onHighlight?: (stepId: string | null) => void;
}) {
  const [filters, setFilters] = useState<IssueFilters>(NO_FILTERS);
  // The Acknowledge dialog, for "+ New issue" and for Edit.
  const [dialog, setDialog] = useState<{ mode: "new" | "edit"; draft: IssueDraft; number?: number | null } | null>(null);
  const sectioned = view !== "all";
  const all = registerEntries(state.issues, detected ?? [], state.revisionOf).filter((e) => !sectioned || e.kind === (view === "insights" ? "detected" : "tracked"));
  const entries = sectioned && stepIds ? entriesInProcess(all, processId, stepIds) : all;
  const listed = filterEntries(entries, { ...filters, step: stepFilter, ...(sectioned ? { process: processId } : {}), ...(includeClosed ? { status: "" as const } : {}) }, processId);
  const shown = includeClosed ? [...listed.filter((e) => entryView(e).open), ...listed.filter((e) => !entryView(e).open)] : listed;
  const active = entries.filter((e) => entryView(e).open);
  const count = (r: Rating) => active.filter((e) => entryView(e).rating === r).length;
  const names = {
    step: new Map(steps.map((s) => [s.id, s.name])),
    person: new Map(people.map((p) => [p.id, p.name])),
    process: new Map(processes.map((p) => [p.id, p.name])),
  };
  const set = <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const filterSelect = (label: string, key: keyof IssueFilters, opts: SelectOption[], all: string) => (
    <label className="flex min-w-0 flex-col gap-0.5">
      <HelpLabel label={label} {...(key === "source" ? ISSUE_HELP.source : key === "process" ? ISSUE_HELP.process : key === "person" ? ISSUE_HELP.person : ISSUE_HELP.rating)} />
      <NativeSelect value={filters[key]} onChange={(e) => set(key, e.target.value as never)} className="h-7 text-sm md:text-sm">
        <option value="">{all}</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <section aria-label="Issues register" className="flex min-w-0 flex-col gap-2" data-issues-register>
      <p className="text-xs text-fg-2" aria-live="polite">
        {sectioned ? (
          <>
            <strong className="text-fg">
              {shown.filter((e) => entryView(e).open).length} {view === "insights" ? "insight" : "open issue"}
              {shown.filter((e) => entryView(e).open).length === 1 ? "" : "s"}
            </strong>
            {detected === null || running ? ". Checking the latest run…" : view === "insights" ? " from the latest run, not confirmed yet." : "."}
          </>
        ) : (
          <>
            <strong className="text-fg">
              {active.length} open issue{active.length === 1 ? "" : "s"}
            </strong>
            {count("risk") ? ` · ${count("risk")} operational risk` : ""}
            {count("bad") ? ` · ${count("bad")} bad` : ""}.{" "}
            {detected === null || running ? "Checking the latest run…" : "Detected issues refresh on every run; tracked ones stay until you close them."}
          </>
        )}
      </p>

      {!sectioned && (
      <div className={`grid gap-1.5 ${layout === "page" ? "grid-cols-2 sm:grid-cols-5" : "grid-cols-2"}`}>
        {processes.length > 1 && filterSelect("Process", "process", options(processes), "All processes")}
        {filterSelect("Person", "person", options(people), "Anyone")}
        {filterSelect("Rating", "rating", ratingOptions, "Any rating")}
        {filterSelect(
          "Source",
          "source",
          (["manual", "detected", "promoted"] as IssueSource[]).map((s) => ({ value: s, label: SOURCE_LABELS[s] })),
          "Any source",
        )}
        <label className="flex min-w-0 flex-col gap-0.5">
          <HelpLabel label="Status" {...ISSUE_HELP.status} />
          <NativeSelect value={filters.status} onChange={(e) => set("status", e.target.value as IssueFilters["status"])} className="h-7 text-sm md:text-sm">
            <option value="active">Open and detected</option>
            <option value="">Any status</option>
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      )}
      {stepFilter && (
        <p className="flex items-center gap-2 text-xs">
          <span className={chip}>On {names.step.get(stepFilter) ?? "a removed step"}</span>
          <button type="button" className="underline" onClick={() => onStepFilterChange("")}>
            Show all steps
          </button>
        </p>
      )}

      {state.error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
          {state.error}{" "}
          <button type="button" className="underline" onClick={state.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {canEdit && view !== "insights" && (
        <button type="button" className={`${button} self-start`} onClick={() => setDialog({ mode: "new", draft: emptyDraft(processId, stepFilter) })}>
          + New issue
        </button>
      )}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-xs text-fg-2">
          {entries.length === 0
            ? detected === null
              ? "Running the simulation…"
              : "Nothing detected in this run, and nothing logged yet."
            : "No issues match these filters."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((e) => (
            <IssueItem
              key={entryView(e).id}
              entry={e}
              names={names}
              people={people}
              scenarios={scenarios}
              brokenScenarios={brokenScenarios}
              canEdit={canEdit}
              currency={currency}
              state={state}
              showProcess={processes.length > 1}
              onHighlight={onHighlight}
              extra={issueExtra}
              onEdit={(issue) => setDialog({ mode: "edit", draft: draftFromIssue(issue), number: issue.number })}
            />
          ))}
        </ul>
      )}

      <AcknowledgeDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "new"}
        draft={dialog?.draft ?? emptyDraft(processId)}
        issueNumber={dialog?.number}
        options={formOptions}
        busy={state.busy}
        error={state.error}
        onClose={() => setDialog(null)}
        onSubmit={(draft) => state.save(toSaveInput(draft, formOptions))}
      />
    </section>
  );
}

function IssueItem({
  entry,
  names,
  people,
  scenarios,
  brokenScenarios,
  canEdit,
  currency,
  state,
  showProcess,
  onHighlight,
  onEdit,
  extra,
}: {
  extra?: (issue: IssueRow) => ReactNode;
  currency: string;
  entry: RegisterEntry;
  names: { step: Map<string, string>; person: Map<string, string>; process: Map<string, string> };
  people: Named[];
  scenarios: ScenarioRow[];
  brokenScenarios: ReadonlySet<string>;
  canEdit: boolean;
  state: IssuesState;
  showProcess: boolean;
  onHighlight?: (stepId: string | null) => void;
  /** Opens the Acknowledge dialog on this issue. */
  onEdit: (issue: IssueRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const v = entryView(entry);
  const fix = fixFor(entry, scenarios);
  // A fix that needs attention must be re-pointed (issue #16).
  const fixBroken = Boolean(fix?.scenarioId && brokenScenarios.has(fix.scenarioId));
  const issue = entry.kind === "tracked" ? entry.issue : null;
  const meta: ReactNode[] = [
    issue?.number != null ? (
      <span key="number" className={`${chip} font-mono`} data-issue-number>
        {issueLabel(issue)}
      </span>
    ) : null,
    <span key="source" className={`${chip} ${entry.kind === "detected" ? "border-accent" : ""}`}>
      {SOURCE_LABELS[v.source]}
    </span>,
    <span key="type" className={chip}>
      {TYPE_LABELS[v.type]}
    </span>,
    <span key="sev" className={`${chip} ${RATING_CHIP[v.rating]}`}>
      {RATING_LABELS[v.rating]}
    </span>,
  ];
  if (v.status) meta.push(<span key="status" className={chip}>{STATUS_LABELS[v.status]}</span>);
  if (issue?.detected_key) {
    meta.push(
      <span key="det" className={`${chip} ${entry.kind === "tracked" && entry.detection ? "" : "text-fg-3"}`}>
        {entry.kind === "tracked" && entry.detection ? "Still detected" : "No longer detected"}
      </span>,
    );
  }
  const owners = issue ? (issue.owner_ids.length ? issue.owner_ids : issue.owner_person_id ? [issue.owner_person_id] : []) : [];
  const touches = v.stepIds.length
    ? v.stepIds.map((id) => names.step.get(id) ?? "a removed step").join(", ")
    : issue && v.processIds.length
      ? "The whole process"
      : null;
  const target = issue?.target_measure ? `Target: ${issue.target_measure}${issue.target_now ? `, now ${issue.target_now}` : ""}${issue.target_goal ? `, goal ${issue.target_goal}` : ""}` : null;
  const where = [
    showProcess && v.processId ? names.process.get(v.processId) : null,
    touches,
    v.personId ? names.person.get(v.personId) : null,
    owners.length ? `${owners.length > 1 ? "owners" : "owner"} ${owners.map((id) => names.person.get(id) ?? "someone who left").join(", ")}` : null,
    target,
  ].filter(Boolean);

  return (
    <li
      id={`issue-${v.id}`}
      data-issue={v.id}
      data-source={v.source}
      onMouseEnter={onHighlight && v.stepId ? () => onHighlight(v.stepId) : undefined}
      onMouseLeave={onHighlight && v.stepId ? () => onHighlight(null) : undefined}
      onFocus={onHighlight && v.stepId ? () => onHighlight(v.stepId) : undefined}
      onBlur={onHighlight && v.stepId ? () => onHighlight(null) : undefined}
      className={`relative rounded-lg border border-line bg-panel py-2 pr-2 pl-3.5 before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-lg ${RATING_STRIPE[v.rating]}`}
    >
      <p className="text-sm font-semibold">{v.title}</p>
      {v.evidence && <p className="mt-0.5 text-xs text-fg-2">{v.evidence}</p>}
      {entry.kind === "detected" || entry.detection ? (
        <p className="mt-0.5 text-xs text-fg-2" data-cost title={v.cost?.method}>
          {v.cost?.payHidden ? <PayHidden /> : <span className="font-medium">{formatIssueCost(v.cost, currency)}</span>}
          {v.cost?.method && !v.cost.payHidden ? <span className="text-fg-3"> · {v.cost.method}</span> : null}
        </p>
      ) : null}
      {where.length > 0 && <p className="mt-0.5 text-xs text-fg-3">{where.join(" · ")}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {meta}
        <span className="ml-auto flex flex-wrap gap-1">
          {issue && canEdit && (
            <>
              <button type="button" className={button} onClick={() => onEdit(issue)}>
                Edit
              </button>
              <button type="button" className={button} aria-expanded={editing} onClick={() => setEditing((x) => !x)}>
                {editing ? "Hide details" : "Status and details"}
              </button>
            </>
          )}
        </span>
      </div>
      {v.type === "broken_scenario" ? (
        <p className="mt-1 text-xs text-fg-3">Re-point its changes under Scenarios; this issue resolves itself once the scenario applies again.</p>
      ) : fixBroken ? (
        <p className="mt-1 text-xs text-crit" data-fix-broken>
          Fix: {fix!.name} needs attention (a change in it no longer resolves), so it needs re-pointing under Scenarios.
        </p>
      ) : (
        fix && <p className="mt-1 text-xs text-fg-3">Fix: {fix.name}</p>
      )}
      {issue && extra?.(issue)}
      {issue && editing && canEdit && (
        <div className="mt-2 grid gap-2 border-t border-line pt-2">
          <IssueFields issue={issue} people={people} scenarios={scenarios} state={state} />
          {confirming ? (
            <p className="flex items-center gap-2 text-xs">
              Delete this issue?
              <button
                type="button"
                className={`${button} border-crit`}
                disabled={state.busy}
                onClick={() => void state.remove(issue.id)}
              >
                Delete
              </button>
              <button type="button" className={button} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </p>
          ) : (
            <button type="button" className={`${button} self-start`} onClick={() => setConfirming(true)}>
              Delete issue
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Every field of a tracked issue, each saved on its own (per-field saves). */
function IssueFields({
  issue,
  people,
  scenarios,
  state,
}: {
  issue: IssueRow;
  people: Named[];
  scenarios: ScenarioRow[];
  state: IssuesState;
}) {
  const save = (field: IssueField) => state.saver(issue.id, field) as Saver<string | null>;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <SelectField label="Status" value={issue.status} save={save("status")} options={statusOptions} help={ISSUE_HELP.status} />
        <SelectField label="Type" value={issue.type} save={save("type")} options={typeOptions} help={ISSUE_HELP.type} />
        <SelectField label="Person" value={issue.person_id} save={save("person_id")} options={options(people)} noneLabel="Nobody" help={ISSUE_HELP.person} />
      </div>
      <SelectField
        label="Fix (scenario)"
        value={issue.scenario_id}
        save={save("scenario_id")}
        options={options(scenarios)}
        noneLabel="No linked scenario"
        help={ISSUE_HELP.fix}
              />
      <TextField label="Evidence" value={issue.evidence} save={save("evidence")} optional multiline help={ISSUE_HELP.evidence} />
    </>
  );
}
