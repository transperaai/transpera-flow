"use client";

import { useCallback, useState } from "react";
import type { IssueEventRow, IssueRow, ResolveHow } from "@transpera-flow/db";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import type { ScreenMode } from "@/lib/mode";
import { liveIssueStore } from "./live-store";
import { MemoryIssueStore, type IssueStore, type SaveIssueResult } from "./store";
import type { IssueField, IssueInput, PromoteInput, SaveIssueInput, Scalar } from "./validate";

const NO_REVISIONS: Readonly<Record<string, string>> = {};

export interface IssuesState {
  issues: IssueRow[];
  busy: boolean;
  error: string | null;
  create(input: IssueInput): Promise<IssueRow | null>;
  promote(input: PromoteInput): Promise<IssueRow | null>;
  /** The Acknowledge dialog: create an issue (from an insight or by hand) or edit one. Null when it failed; `error` says why. */
  save(input: SaveIssueInput): Promise<IssueRow | null>;
  /** Dismiss an insight again, against the process's current live revision. */
  redismiss(id: string, revisionId: string | null): Promise<IssueRow | null>;
  /** A process's live revision id, which a dismissal is measured against; undefined when it isn't known. */
  revisionOf(processId: string | null | undefined): string | undefined;
  /** A saver for one field of one issue that also updates the list once saved. */
  saver(id: string, field: IssueField): Saver<Scalar>;
  remove(id: string): Promise<boolean>;
  /** Mark an issue resolved, with how and a note. Null when it failed; `error` says why. */
  resolve(id: string, how: ResolveHow, note: string | null, solution?: { id: string; name: string } | null): Promise<IssueRow | null>;
  /** Set a resolved issue back to Open. */
  reopen(id: string): Promise<IssueRow | null>;
  /** An issue's history, oldest first. */
  events(id: string): Promise<IssueEventRow[]>;
  dismissError(): void;
}

/**
 * Tracked issues and the writes on them. `live` saves through Server Actions
 * as the signed-in user; `demo` keeps them in memory (lost on reload).
 */
export function useIssues(
  workspaceId: string,
  initial: readonly IssueRow[],
  mode: ScreenMode,
  /** Each process's live revision id: a dismissed insight is hidden until its process's live revision changes. */
  liveRevisions: Readonly<Record<string, string>> = NO_REVISIONS,
): IssuesState {
  const [store] = useState<IssueStore>(() => (mode === "live" ? liveIssueStore(workspaceId) : new MemoryIssueStore(workspaceId, initial)));
  const [issues, setIssues] = useState<IssueRow[]>(() => [...initial]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async (write: () => Promise<SaveIssueResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await write();
      if (r.status === "error") {
        setError(r.message);
        return null;
      }
      setIssues((list) => [r.issue, ...list.filter((i) => i.id !== r.issue.id)]);
      return r.issue;
    } catch {
      setError("Couldn't save. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const saver = useCallback(
    (id: string, field: IssueField): Saver<Scalar> =>
      async (base, next) => {
        const outcome: SaveOutcome<Scalar> = await store.saveField(id, field, base, next);
        if (outcome.status === "saved") {
          setIssues((list) => list.map((i) => (i.id === id ? ({ ...i, [field]: outcome.value, updated_at: new Date().toISOString() } as IssueRow) : i)));
        }
        return outcome;
      },
    [store],
  );

  return {
    issues,
    busy,
    error,
    create: (input) => add(() => store.create(input)),
    promote: (input) => add(() => store.promote(input)),
    save: (input) => add(() => store.save(input)),
    redismiss: (id, revisionId) => add(() => store.redismiss(id, revisionId)),
    revisionOf: (processId) => (processId ? liveRevisions[processId] : undefined),
    saver,
    remove: async (id) => {
      setBusy(true);
      setError(null);
      try {
        const r = await store.remove(id);
        if (r.status === "error") {
          setError(r.message);
          return false;
        }
        setIssues((list) => list.filter((i) => i.id !== id));
        return true;
      } catch {
        setError("Couldn't delete. Try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    resolve: (id, how, note, solution) => add(() => store.resolve(id, how, note, solution)),
    reopen: (id) => add(() => store.reopen(id)),
    events: (id) => store.events(id).catch(() => []),
    dismissError: () => setError(null),
  };
}
