"use client";

// Add or edit one marker of a forecast plan (B7, issue #36): a hire, someone's leave, or a solution going live. One dialog
// for the three kinds and for adding and editing. Months are the forecast's own months; no earlier month is offered.

import { useState } from "react";
import type { ForecastPlanMarker } from "@transpera-flow/db";
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PLAN_HELP } from "@/lib/forecast/help";
import { longDate, weekdayDate } from "@/lib/forecast/lane";
import { firstOfMonth, mondayOnOrBefore } from "@/lib/forecast/positions";

export type MarkerTarget = { mode: "add"; kind: ForecastPlanMarker["kind"] } | { mode: "edit"; marker: ForecastPlanMarker };

export interface MarkerSolutionOption {
  id: string;
  name: string;
  processId: string;
  processName: string;
  /** Whether the forecast's company model runs this solution's process. */
  inModel: boolean;
  leverChanges: number;
  /** True when the solution was made from a version of its process other than the live one. */
  older: boolean;
}

export interface MarkerDialogProps {
  target: MarkerTarget;
  roles: { id: string; name: string }[];
  people: { id: string; name: string }[];
  solutions: MarkerSolutionOption[];
  /** The forecast's months: the 1st of each as the value, "October 2026" as the label. */
  months: { value: string; label: string }[];
  /** The month a new hire or solution starts in. */
  defaultMonth: string;
  /** The Monday a new leave starts on. */
  defaultMonday: string;
  /** A message when the marker (as it would be saved) can't be part of the plan, else null. */
  validate: (marker: ForecastPlanMarker) => string | null;
  onSubmit: (marker: ForecastPlanMarker) => void;
  onRemove: () => void;
  onClose: () => void;
}

const TITLES = { hire: "hire", leave: "leave", solution: "solution" } as const;

export function PlanMarkerDialog({ target, roles, people, solutions, months, defaultMonth, defaultMonday, validate, onSubmit, onRemove, onClose }: MarkerDialogProps) {
  const editing = target.mode === "edit" ? target.marker : null;
  const kind = editing?.kind ?? (target as { kind: ForecastPlanMarker["kind"] }).kind;
  const [roleId, setRoleId] = useState(editing?.kind === "hire" ? editing.role_id : (roles[0]?.id ?? ""));
  const [month, setMonth] = useState(editing && editing.kind !== "leave" ? editing.date : defaultMonth);
  const [fte, setFte] = useState(editing?.kind === "hire" ? String(editing.fte) : "1");
  const [name, setName] = useState(editing?.kind === "hire" ? (editing.name ?? "") : "");
  const [personId, setPersonId] = useState(editing?.kind === "leave" ? editing.person_id : (people[0]?.id ?? ""));
  const [from, setFrom] = useState(editing?.kind === "leave" ? editing.date : defaultMonday);
  const [weeks, setWeeks] = useState(editing?.kind === "leave" ? String(editing.weeks) : "2");
  const firstUsable = solutions.find((s) => s.inModel)?.id ?? "";
  const [solutionId, setSolutionId] = useState(editing?.kind === "solution" ? editing.solution_id : firstUsable);
  const [error, setError] = useState<string | null>(null);

  // A month the marker already has but the forecast no longer offers (the horizon changed) stays pickable.
  const monthOptions = months.some((m) => m.value === month) ? months : [{ value: month, label: longDate(month).replace(/^\d+ /, "") }, ...months];
  const role = roles.find((r) => r.id === roleId);
  const solution = solutions.find((s) => s.id === solutionId);
  const snapped = /^\d{4}-\d{2}-\d{2}$/.test(from) && !Number.isNaN(Date.parse(`${from}T00:00:00Z`)) ? mondayOnOrBefore(from) : null;

  const build = (): { marker: ForecastPlanMarker } | { error: string } => {
    const id = editing?.id ?? crypto.randomUUID();
    if (kind === "hire") {
      const n = Number(fte);
      if (!roleId) return { error: "Pick a role." };
      if (!fte.trim() || !Number.isFinite(n) || n < 0.1 || n > 2) return { error: "FTE must be between 0.1 and 2." };
      const typed = name.trim();
      if (typed.length > 120) return { error: "A name can have up to 120 characters." };
      return { marker: { id, kind: "hire", date: firstOfMonth(month), role_id: roleId, fte: n, ...(typed ? { name: typed } : {}) } };
    }
    if (kind === "leave") {
      const n = Number(weeks);
      if (!personId) return { error: "Pick a person." };
      if (!snapped) return { error: "Pick the date the leave starts." };
      if (!weeks.trim() || !Number.isInteger(n) || n < 1 || n > 52) return { error: "Leave lasts 1 to 52 whole weeks." };
      return { marker: { id, kind: "leave", date: snapped, person_id: personId, weeks: n } };
    }
    if (!solutionId || !solution) return { error: "Pick a solution." };
    if (!solution.inModel) return { error: "That solution changes a process the forecast doesn't run." };
    return { marker: { id, kind: "solution", date: firstOfMonth(month), solution_id: solutionId } };
  };

  const submit = () => {
    const built = build();
    if ("error" in built) return setError(built.error);
    const problem = validate(built.marker);
    if (problem) return setError(problem);
    onSubmit(built.marker);
  };

  const byProcess = [...new Set(solutions.map((s) => s.processName))];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-plan-dialog={kind}
        // Start on the first field, not on the (i) beside its label (which would open its help).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("select, input")?.focus();
        }}
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? `Change this ${TITLES[kind]}` : `Add a ${TITLES[kind]}`}</DialogTitle>
            <DialogDescription>
              {kind === "hire" ? "Someone new joins from the month you pick." : kind === "leave" ? "Someone is away for whole weeks." : "A saved solution goes live from the month you pick."}
            </DialogDescription>
          </DialogHeader>

          {kind === "hire" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.hireRole} />
                <NativeSelect aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                  {editing?.kind === "hire" && !role ? <option value={editing.role_id}>(a role that is gone)</option> : null}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.hireStarts} />
                <NativeSelect aria-label="Starts in" value={month} onChange={(e) => setMonth(e.target.value)}>
                  {monthOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.hireFte} />
                <Input aria-label="FTE" type="number" inputMode="decimal" min={0.1} max={2} step={0.1} value={fte} onChange={(e) => setFte(e.target.value)} />
              </label>
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.hireName} />
                <Input aria-label="Name" value={name} maxLength={120} placeholder={`New ${role?.name ?? "hire"}`} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
          )}

          {kind === "leave" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.leavePerson} />
                <NativeSelect aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.leaveFrom} />
                <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                {snapped ? <span className="text-xs text-muted-foreground">{weekdayDate(snapped)}</span> : null}
              </label>
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.leaveFor} />
                <Input aria-label="For (weeks)" type="number" inputMode="numeric" min={1} max={52} step={1} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
              </label>
            </div>
          )}

          {kind === "solution" && (
            <div className="flex flex-col gap-3">
              {solutions.length ? (
                <label className="flex flex-col gap-0.5">
                  <HelpLabel {...PLAN_HELP.solutionPick} />
                  <NativeSelect aria-label="Solution" value={solutionId} onChange={(e) => setSolutionId(e.target.value)}>
                    {byProcess.map((process) => (
                      <optgroup key={process} label={process}>
                        {solutions
                          .filter((s) => s.processName === process)
                          .map((s) => (
                            <option key={s.id} value={s.id} disabled={!s.inModel && s.id !== solutionId}>
                              {s.name}
                              {s.inModel ? "" : " (not part of the forecast)"}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </NativeSelect>
                  {solution && solution.leverChanges > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      Its {solution.leverChanges} lever change{solution.leverChanges === 1 ? "" : "s"} aren&apos;t part of the forecast, as on the solution&apos;s page.
                    </span>
                  ) : null}
                  {solution?.older ? (
                    <span className="text-xs text-muted-foreground">Made from an older version of {solution.processName}; the forecast uses the solution&apos;s map as saved.</span>
                  ) : null}
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">No saved solutions yet.</p>
              )}
              <label className="flex flex-col gap-0.5">
                <HelpLabel {...PLAN_HELP.solutionFrom} />
                <NativeSelect aria-label="Live from" value={month} onChange={(e) => setMonth(e.target.value)}>
                  {monthOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive" data-plan-dialog-error>
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {editing ? (
              <Button type="button" variant="destructive" className="sm:mr-auto" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={kind === "solution" && !solutions.length}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
