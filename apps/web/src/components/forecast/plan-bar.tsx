"use client";

// The plan bar above the forecast timeline (B7, issue #36): pick a plan, add markers to it, save, rename, delete, and open
// the compare view. Presentational: the Forecast page holds the plan and does the saving.

import { ChevronDown, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ForecastPlanRow } from "@transpera-flow/db";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PLAN_HELP } from "@/lib/forecast/help";
import { MAX_MARKERS, MAX_NAME, MAX_PLANS, MAX_SOLUTIONS } from "@/lib/forecast/plan";
import { EDIT_ONLY } from "@/lib/phone";

/** The option value for "No changes" (the live forecast), and for a plan that isn't saved yet. */
export const NO_CHANGES = "";
export const UNSAVED_PLAN = "__unsaved";

export interface PlanBarProps {
  plans: ForecastPlanRow[];
  /** Saved plan shown, or null. */
  selectedId: string | null;
  /** A plan that isn't saved yet is being worked on (shown after the saved ones). */
  unsavedName: string | null;
  /** The name of the plan on screen (saved or not), "" for No changes. */
  planName: string;
  dirty: boolean;
  /** Something is on the plan (so Save, Rename and "Save as new plan" make sense). */
  hasPlan: boolean;
  markerCount: number;
  solutionMarkerCount: number;
  /** Saved solutions to put live: none disables that menu item. */
  solutionCount: number;
  running: boolean;
  /** The last thing that happened to saving, shown in the status line. */
  saveNote: { text: string; tone: "ok" | "error" } | null;
  /** Needs attention, each in words, then the markers after the span. */
  problems: string[];
  later: string[];
  onSelect: (value: string) => void;
  onAdd: (kind: "hire" | "leave" | "solution") => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCompare: () => void;
}

export function PlanBar(p: PlanBarProps) {
  const atMarkerLimit = p.markerCount >= MAX_MARKERS;
  const atSolutionLimit = p.solutionMarkerCount >= MAX_SOLUTIONS;
  const planLimit = p.selectedId === null && p.plans.length >= MAX_PLANS;
  const status = p.running ? "Updating the forecast…" : (p.saveNote?.text ?? (p.dirty ? "Unsaved changes" : p.selectedId ? "Saved" : ""));
  const failed = !p.running && p.saveNote?.tone === "error";
  return (
    <Card className="gap-3 px-4 py-3" data-plan-bar>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex min-w-[12rem] flex-col gap-0.5">
          <HelpLabel {...PLAN_HELP.plan} />
          <NativeSelect aria-label="Plan" value={p.selectedId ?? (p.unsavedName !== null ? UNSAVED_PLAN : NO_CHANGES)} onChange={(e) => p.onSelect(e.target.value)} data-plan-select>
            <option value={NO_CHANGES}>No changes</option>
            {p.plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
            {p.unsavedName !== null ? <option value={UNSAVED_PLAN}>{p.unsavedName} (unsaved)</option> : null}
          </NativeSelect>
        </label>

        <div className={`flex items-center ${EDIT_ONLY}`} data-edit-entry>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-plan-add>
                <Plus aria-hidden /> Add <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={atMarkerLimit} onSelect={() => p.onAdd("hire")}>
                Add a hire
              </DropdownMenuItem>
              <DropdownMenuItem disabled={atMarkerLimit} onSelect={() => p.onAdd("leave")}>
                Add leave
              </DropdownMenuItem>
              <DropdownMenuItem disabled={atMarkerLimit || atSolutionLimit || p.solutionCount === 0} onSelect={() => p.onAdd("solution")}>
                Add a solution
                {p.solutionCount === 0 ? <span className="ml-2 text-xs text-muted-foreground">No saved solutions yet</span> : atSolutionLimit ? <span className="ml-2 text-xs text-muted-foreground">Up to {MAX_SOLUTIONS} a plan</span> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Help {...PLAN_HELP.add} />
        </div>

        <div className={`flex flex-wrap items-center gap-2 ${EDIT_ONLY}`} data-edit-entry>
          {p.dirty || (p.hasPlan && p.selectedId === null) ? (
            <Button onClick={p.onSave} disabled={planLimit} title={planLimit ? `This workspace already has ${MAX_PLANS} plans. Delete one first.` : undefined} data-plan-save>
              Save
            </Button>
          ) : null}
          {p.hasPlan ? (
            <>
              {p.selectedId !== null ? (
                <Button variant="outline" onClick={p.onSaveAsNew} disabled={p.plans.length >= MAX_PLANS} title={p.plans.length >= MAX_PLANS ? `This workspace already has ${MAX_PLANS} plans. Delete one first.` : undefined}>
                  Save as new plan
                </Button>
              ) : null}
              <Button variant="outline" onClick={p.onRename}>
                Rename
              </Button>
              {p.selectedId !== null ? (
                <Button variant="outline" onClick={p.onDelete}>
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}
          <Help {...PLAN_HELP.save} />
        </div>

        <div className="flex items-center sm:ml-auto">
          <Button variant="outline" onClick={p.onCompare} disabled={p.plans.length === 0} title={p.plans.length === 0 ? "Save a plan to compare it" : undefined} data-plan-compare>
            Compare plans
          </Button>
          <Help {...PLAN_HELP.compare} />
        </div>
      </div>

      <p className={failed ? "text-sm text-destructive" : "text-xs text-muted-foreground"} aria-live="polite" role={failed ? "alert" : undefined} data-plan-status-line>
        {status}
        {atMarkerLimit ? ` A plan can have up to ${MAX_MARKERS} markers.` : ""}
      </p>
      {p.problems.length ? (
        <p className="text-sm" data-plan-problems>
          <b className="font-medium">Needs attention:</b> {p.problems.join("; ")}.
        </p>
      ) : null}
      {p.later.length ? (
        <p className="text-sm text-muted-foreground" data-plan-later>
          After this span: {p.later.join("; ")}.
        </p>
      ) : null}
    </Card>
  );
}

/** A yes-or-no question: "Discard your changes to “Hire in March”?" [Discard] [Keep editing]. */
export function ConfirmDialog({
  title,
  description,
  confirm,
  cancel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description?: ReactNode;
  confirm: string;
  cancel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-plan-confirm>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {cancel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A plan's name: to save a new plan, save a copy, or rename. */
export function NameDialog({
  title,
  initial,
  confirm,
  taken,
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  confirm: string;
  /** Names already used by other plans, compared as the database does (ignoring case and spaces). */
  taken: string[];
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const clean = name.trim();
    if (!clean) return setError("Give the plan a name.");
    if (clean.length > MAX_NAME) return setError(`A plan's name can have up to ${MAX_NAME} characters.`);
    if (taken.some((t) => t.trim().toLowerCase() === clean.toLowerCase())) return setError("A plan with that name already exists.");
    onConfirm(clean);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-plan-name-dialog>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-fg-2">Plan name</span>
            <Input aria-label="Plan name" value={name} maxLength={MAX_NAME} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{confirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
