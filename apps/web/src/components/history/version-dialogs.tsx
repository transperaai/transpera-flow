"use client";

import Link from "next/link";
import { useState } from "react";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DuplicateResult, RestoreResult } from "@/app/w/[slug]/p/[processId]/history/actions";

/** What an editor can do with a version. Server actions in a workspace; the demo's say nothing is kept. */
export interface VersionActions {
  restore: (revisionId: string, replaceDraft: boolean) => Promise<RestoreResult>;
  duplicate: (revisionId: string, name: string) => Promise<DuplicateResult>;
}

/** Where the dialogs send people afterwards. `{id}` in `newProcessEdit` is the new process's id. */
export interface VersionLinks {
  /** The Editor for this process (its draft). */
  edit: string;
  /** The Editor for a new process. */
  newProcessEdit: string;
}

type Phase =
  | { step: "ask" }
  | { step: "working" }
  | { step: "replace" }
  | { step: "done"; unlinkedChildren: number; skippedHolders: number; addedHolders: number }
  | { step: "error"; message: string };

/**
 * Restore: copy a published version into the draft. Live doesn't change until the draft is published. If the
 * draft already has changes of its own, say so and ask before replacing them.
 */
export function RestoreDialog({
  version,
  processName,
  revisionId,
  restore,
  links,
  onClose,
}: {
  version: number;
  processName: string;
  revisionId: string;
  restore: VersionActions["restore"];
  links: VersionLinks;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ step: "ask" });
  const go = async (replace: boolean) => {
    setPhase({ step: "working" });
    try {
      const r = await restore(revisionId, replace);
      if (r.status === "restored") setPhase({ step: "done", unlinkedChildren: r.unlinkedChildren, skippedHolders: r.skippedHolders, addedHolders: r.addedHolders });
      else if (r.status === "draft_exists") setPhase({ step: "replace" });
      else setPhase({ step: "error", message: r.message });
    } catch {
      setPhase({ step: "error", message: "Couldn't do that. Try again." });
    }
  };
  const working = phase.step === "working";
  return (
    <Dialog open onOpenChange={(open) => !open && !working && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore version {version}?</DialogTitle>
          <DialogDescription>
            {phase.step === "done"
              ? `Version ${version} of ${processName} is now your draft.`
              : `This copies version ${version} of ${processName} into your draft. What people see and simulate today doesn't change until you publish.`}
          </DialogDescription>
        </DialogHeader>
        {phase.step === "replace" && (
          <p role="alert" className="rounded-lg border border-warn bg-warn-soft p-2 text-xs">
            There is already a draft with changes that aren&apos;t published. Restoring replaces them with version {version}.
          </p>
        )}
        {phase.step === "done" && (
          <p className="text-sm text-muted-foreground">
            Open it in the Editor to check it, then publish it as a new version.
            {phase.unlinkedChildren > 0 &&
              ` ${phase.unlinkedChildren === 1 ? "One step" : `${phase.unlinkedChildren} steps`} held a process that has since moved elsewhere, so ${phase.unlinkedChildren === 1 ? "it comes back as an ordinary step" : "they come back as ordinary steps"}.`}
            {phase.skippedHolders > 0 &&
              ` ${phase.skippedHolders === 1 ? "One process on that version" : `${phase.skippedHolders} processes on that version`} ${phase.skippedHolders === 1 ? "isn't" : "aren't"} on the map any more (deleted, or now inside another process), so ${phase.skippedHolders === 1 ? "it was" : "they were"} left out.`}
            {phase.addedHolders > 0 &&
              ` ${phase.addedHolders === 1 ? "One process" : `${phase.addedHolders} processes`} made since ${phase.addedHolders === 1 ? "was" : "were"} added back at the bottom of ${phase.addedHolders === 1 ? "its" : "their"} column.`}
          </p>
        )}
        {phase.step === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {phase.message}
          </p>
        )}
        <DialogFooter>
          {phase.step === "done" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Stay here
              </Button>
              <Button asChild className="bg-edit text-edit-fg hover:bg-edit/90">
                <Link href={links.edit}>✎ Open in Editor</Link>
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={working}>
                Cancel
              </Button>
              <Button onClick={() => void go(phase.step === "replace")} disabled={working}>
                {working ? "Restoring…" : phase.step === "replace" ? "Replace my draft" : `Restore version ${version}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Duplicate: a new process that starts as a copy of a published version, opened in the Editor as a draft. */
export function DuplicateDialog({
  version,
  processName,
  revisionId,
  duplicate,
  links,
  onClose,
}: {
  version: number;
  processName: string;
  revisionId: string;
  duplicate: VersionActions["duplicate"];
  links: VersionLinks;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${processName} (from v${version})`);
  const [phase, setPhase] = useState<Phase & { processId?: string }>({ step: "ask" });
  const submit = async () => {
    setPhase({ step: "working" });
    try {
      const r = await duplicate(revisionId, name);
      if (r.status === "duplicated") setPhase({ step: "done", unlinkedChildren: 0, skippedHolders: 0, addedHolders: 0, processId: r.processId });
      else setPhase({ step: "error", message: r.message });
    } catch {
      setPhase({ step: "error", message: "Couldn't do that. Try again." });
    }
  };
  const working = phase.step === "working";
  return (
    <Dialog open onOpenChange={(open) => !open && !working && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate version {version} as a new process</DialogTitle>
          <DialogDescription>
            {phase.step === "done"
              ? `Created “${name.trim()}”. It starts as a draft, and nothing is live until you publish it.`
              : `Starts a new process from version ${version} of ${processName}. The original isn't changed. The copy sits at the top level of the company map.`}
          </DialogDescription>
        </DialogHeader>
        {phase.step !== "done" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center">
              <label className="text-sm font-medium" htmlFor="duplicate-name">
                Name of the new process
              </label>
              <Help
                label="Name of the new process"
                description="What the copy is called in the company map and the Processes list. It has to be different from the names already there."
                example="Sales (from v3) keeps a copy of how sales worked at version 3 while you try a new design on the live one."
              />
            </div>
            <Input id="duplicate-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
            {phase.step === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {phase.message}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={working}>
                Cancel
              </Button>
              <Button type="submit" disabled={working || name.trim() === ""}>
                {working ? "Creating…" : "Create process"}
              </Button>
            </DialogFooter>
          </form>
        )}
        {phase.step === "done" && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Stay here
            </Button>
            <Button asChild className="bg-edit text-edit-fg hover:bg-edit/90">
              <Link href={links.newProcessEdit.replace("{id}", phase.processId ?? "")}>✎ Open in Editor</Link>
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
