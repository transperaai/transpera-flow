"use client";

// The scenario bar above the Sandbox's change list (docs/plans/sandbox-p1-brief.md §4): pick a scenario, add changes to it, save,
// rename, duplicate, build on it, delete, and open the compare view. Presentational: the Sandbox holds the scenario and does the saving.
// A Viewer gets the picker and Compare only.

import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SandboxScenarioRow } from "@transpera-flow/db";
import { MAX_SCENARIO_NAME, MAX_SCENARIOS } from "@transpera-flow/db";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { EDIT_ONLY } from "@/lib/phone";
import { CHANGE_PARENT } from "@/lib/sandbox/save-errors";

const MAX_NAME = MAX_SCENARIO_NAME;

/** The option value for "No changes" (the live model), and for a scenario that isn't saved yet. */
export const NO_CHANGES = "";
export const UNSAVED_SCENARIO = "__unsaved";

export interface ScenarioBarProps {
  scenarios: SandboxScenarioRow[];
  /** Saved scenario shown, or null. */
  selectedId: string | null;
  /** A scenario that isn't saved yet is being worked on (shown after the saved ones). */
  unsavedName: string | null;
  dirty: boolean;
  /** Something is on screen that Save, Rename and Save as new make sense for (a saved scenario, or a new one). */
  hasScenario: boolean;
  /** Agency admins and the Owner: the editing buttons. A Viewer opens, runs and compares only. */
  canEdit: boolean;
  /** The scenario on screen builds on another: its name, for the line under the bar. */
  parentName: string | null;
  running: boolean;
  /** The last thing that happened to saving, shown in the status line. */
  saveNote: { text: string; tone: "ok" | "error" } | null;
  /** Needs attention, each in words, then the changes after the horizon. */
  problems: string[];
  later: string[];
  onSelect: (value: string) => void;
  onNew: () => void;
  onAddChange: () => void;
  onSave: () => void;
  /** Opens goal seek ("Find a value"); Agency admins and the Owner only (a Viewer gets no button); nothing it does is saved. */
  onFindValue?: () => void;
  /** The Share button for the saved scenario on screen (Agency admins and the Owner); null when the scenario can't be shared yet. */
  share?: React.ReactNode;
  /** Why it can't be shared yet (unsaved changes), shown where the button would be. */
  shareHint?: string | null;
  onSaveAsNew: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onBuildOn: () => void;
  /** Change or clear what the scenario on screen builds on. */
  onChangeParent: () => void;
  onDelete: () => void;
  onCompare: () => void;
}

export function ScenarioBar(p: ScenarioBarProps) {
  const atLimit = p.scenarios.length >= MAX_SCENARIOS;
  const status = p.running ? "Updating the forecast…" : (p.saveNote?.text ?? (p.dirty ? "Unsaved changes" : p.selectedId ? "Saved" : ""));
  const failed = !p.running && p.saveNote?.tone === "error";
  const limit = atLimit ? `This workspace already has ${MAX_SCENARIOS} scenarios. Delete one first.` : undefined;
  return (
    <Card className="gap-3 px-4 py-3" data-scenario-bar>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex min-w-[12rem] flex-col gap-0.5">
          <HelpLabel {...SANDBOX_HELP.scenario} />
          <NativeSelect aria-label="Scenario" value={p.selectedId ?? (p.unsavedName !== null ? UNSAVED_SCENARIO : NO_CHANGES)} onChange={(e) => p.onSelect(e.target.value)} data-scenario-select>
            <option value={NO_CHANGES}>No changes</option>
            {p.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {p.unsavedName !== null ? <option value={UNSAVED_SCENARIO}>{p.unsavedName} (unsaved)</option> : null}
          </NativeSelect>
        </label>

        {p.canEdit ? (
          <>
            <div className={`flex flex-wrap items-center gap-2 ${EDIT_ONLY}`} data-edit-entry>
              <Button variant="outline" onClick={p.onNew} disabled={atLimit} title={limit} data-scenario-new>
                <Plus aria-hidden /> New scenario
              </Button>
              {p.hasScenario ? (
                <Button variant="outline" onClick={p.onAddChange} data-change-add>
                  <Plus aria-hidden /> Add change
                </Button>
              ) : null}
            </div>
            <div className={`flex flex-wrap items-center gap-2 ${EDIT_ONLY}`} data-edit-entry>
              {p.dirty || (p.hasScenario && p.selectedId === null) ? (
                <Button onClick={p.onSave} disabled={p.selectedId === null && atLimit} title={limit} data-scenario-save>
                  Save
                </Button>
              ) : null}
              {p.hasScenario ? (
                <>
                  {p.selectedId !== null ? (
                    <Button variant="outline" onClick={p.onSaveAsNew} disabled={atLimit} title={limit} data-scenario-save-new>
                      Save as new
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={p.onRename} data-scenario-rename>
                    Rename
                  </Button>
                  {p.parentName !== null || p.scenarios.length > (p.selectedId !== null ? 1 : 0) ? (
                    <Button variant="outline" onClick={p.onChangeParent} data-scenario-change-parent>
                      {CHANGE_PARENT}
                    </Button>
                  ) : null}
                  {p.selectedId !== null ? (
                    <>
                      <Button variant="outline" onClick={p.onDuplicate} disabled={atLimit} title={limit} data-scenario-duplicate>
                        Duplicate
                      </Button>
                      <Button variant="outline" onClick={p.onBuildOn} disabled={atLimit} title={limit} data-scenario-build-on>
                        Build on
                      </Button>
                      <Button variant="outline" onClick={p.onDelete} data-scenario-delete>
                        Delete
                      </Button>
                      {p.share ?? null}
                      {p.shareHint ? (
                        <span className="text-xs text-muted-foreground" data-scenario-share-hint>
                          {p.shareHint}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
              <Help {...SANDBOX_HELP.save} />
            </div>
          </>
        ) : null}

        <div className="flex items-center gap-2 sm:ml-auto">
          {p.onFindValue ? (
            <Button variant="outline" onClick={p.onFindValue} data-goal-open>
              Find a value
            </Button>
          ) : null}
          <Button variant="outline" onClick={p.onCompare} disabled={p.scenarios.length === 0} title={p.scenarios.length === 0 ? "Save a scenario to compare it" : undefined} data-scenario-compare>
            Compare
          </Button>
          <Help {...SANDBOX_HELP.compare} />
        </div>
      </div>

      <p className={failed ? "text-sm text-destructive" : "text-xs text-muted-foreground"} aria-live="polite" role={failed ? "alert" : undefined} data-scenario-status-line>
        {status}
      </p>
      {p.parentName ? (
        <p className="text-xs text-muted-foreground" data-scenario-parent>
          Builds on “{p.parentName}”: its changes come first.
        </p>
      ) : null}
      {p.problems.length ? (
        <p className="text-sm" data-scenario-problems>
          <b className="font-medium">Needs attention:</b> {p.problems.join("; ")}.
        </p>
      ) : null}
      {p.later.length ? (
        <p className="text-sm text-muted-foreground" data-scenario-later>
          After this horizon: {p.later.join("; ")}.
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
      <DialogContent data-sandbox-confirm>
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

/** A scenario's name: to save a new one, a copy, or rename. */
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
  /** Names already used by other scenarios, compared as the database does (ignoring case and spaces). */
  taken: string[];
  /** Return a message to keep the dialog open with it (a save that was refused). */
  onConfirm: (name: string) => void | string | null | Promise<void | string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const clean = name.trim();
    if (!clean) return setError("Give the scenario a name.");
    if (clean.length > MAX_NAME) return setError(`A scenario's name can have up to ${MAX_NAME} characters.`);
    if (taken.some((t) => t.trim().toLowerCase() === clean.toLowerCase())) return setError("A scenario with that name already exists.");
    setBusy(true);
    try {
      const refused = await onConfirm(clean);
      if (typeof refused === "string") setError(refused);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-sandbox-name-dialog>
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
            <span className="text-xs font-medium text-fg-2">Scenario name</span>
            <Input aria-label="Scenario name" value={name} maxLength={MAX_NAME} autoFocus onChange={(e) => setName(e.target.value)} />
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
            <Button type="submit" disabled={busy}>
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What a scenario builds on: another saved scenario, or nothing (it starts from the live model). Every other scenario is offered; a choice the database would refuse (a loop, more than 5 deep) comes back as its message. */
export function ParentDialog({
  title,
  current,
  options,
  onConfirm,
  onCancel,
}: {
  title: string;
  current: string | null;
  options: { id: string; name: string }[];
  /** Return a message to keep the dialog open with it. */
  onConfirm: (parentId: string | null) => void | string | null | Promise<void | string | null>;
  onCancel: () => void;
}) {
  const [parent, setParent] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-sandbox-parent-dialog>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const refused = await onConfirm(parent || null);
              if (typeof refused === "string") setError(refused);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>A scenario that builds on another runs that one&apos;s changes first, then its own. Changing the parent changes this scenario&apos;s results.</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-fg-2">Builds on</span>
            <NativeSelect aria-label="Builds on" value={parent} onChange={(e) => (setParent(e.target.value), setError(null))}>
              <option value="">Nothing (start from the live model)</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive" data-parent-dialog-error>
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
