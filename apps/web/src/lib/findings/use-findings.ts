"use client";

// The findings a page holds, and the writes on them (issue #175, B17): add one by hand, edit one (and accept it in the same
// step), accept or dismiss one. `live` writes through Server Actions as the signed-in user; `demo` keeps them in memory
// for this tab (lost on reload); `readonly` writes nothing.

import { useCallback, useState } from "react";
import { findingDraftProblem, type FindingDraft, type FindingRow, type FindingWrite } from "@transpera-flow/db";
import { createFinding, decideFinding, editFinding } from "@/app/w/[slug]/findings-actions";
import { isReadOnly, type ScreenMode } from "@/lib/mode";

export interface FindingsStore {
  create(draft: FindingDraft): Promise<FindingWrite>;
  edit(id: string, draft: FindingDraft, accept: boolean): Promise<FindingWrite>;
  decide(id: string, status: "accepted" | "dismissed"): Promise<FindingWrite>;
}

export const liveFindingsStore = (workspaceId: string): FindingsStore => ({
  create: (draft) => createFinding(workspaceId, draft),
  edit: (id, draft, accept) => editFinding(id, draft, accept),
  decide: (id, status) => decideFinding(id, status),
});

/** What the database says when a superseded proposal is decided. */
const SUPERSEDED = "A later analysis replaced this proposal, so it can't be decided. Analyse again.";

let demoCount = 0;
const demoId = () => `00000000-0000-4000-8000-${String(++demoCount).padStart(12, "0")}`;

/** Findings in memory: what the demo and the browser tests use. It checks what the database's trigger checks. */
export class MemoryFindingsStore implements FindingsStore {
  constructor(
    private readonly workspaceId: string,
    private rows: FindingRow[],
    private readonly who = "demo",
  ) {}
  private find(id: string) {
    return this.rows.find((r) => r.id === id);
  }
  private put(row: FindingRow): FindingWrite {
    this.rows = [...this.rows.filter((r) => r.id !== row.id), row];
    return { status: "saved", finding: row };
  }
  async create(d: FindingDraft): Promise<FindingWrite> {
    const problem = findingDraftProblem(d);
    if (problem) return { status: "invalid", message: problem };
    const now = new Date().toISOString();
    return this.put({
      id: demoId(),
      workspace_id: this.workspaceId,
      process_id: d.processId,
      step_id: d.stepId,
      origin: "manual",
      status: "accepted",
      rating: d.rating,
      type: d.type,
      title: d.title.trim(),
      evidence: d.evidence.trim(),
      why: d.why.trim(),
      facts: [],
      person_labels: {},
      source_ids: d.sourceIds ?? [],
      ai_key: null,
      analysis_id: null,
      run_id: null,
      edited: false,
      created_by: this.who,
      created_at: now,
      updated_by: this.who,
      updated_at: now,
      decided_by: this.who,
      decided_at: now,
    });
  }
  async edit(id: string, d: FindingDraft, accept: boolean): Promise<FindingWrite> {
    const row = this.find(id);
    if (!row) return { status: "forbidden" };
    const problem = findingDraftProblem(d);
    if (problem) return { status: "invalid", message: problem };
    if (row.status === "superseded") return { status: "invalid", message: SUPERSEDED };
    const now = new Date().toISOString();
    const changed =
      row.title !== d.title.trim() || row.evidence !== d.evidence.trim() || row.why !== d.why.trim() || row.rating !== d.rating || row.type !== d.type || row.step_id !== d.stepId || row.process_id !== d.processId;
    return this.put({
      ...row,
      edited: row.edited || (row.origin === "ai" && changed),
      process_id: d.processId,
      step_id: d.stepId,
      rating: d.rating,
      type: d.type,
      title: d.title.trim(),
      evidence: d.evidence.trim(),
      why: d.why.trim(),
      source_ids: d.sourceIds ?? row.source_ids,
      updated_at: now,
      ...(accept && row.status !== "accepted" ? { status: "accepted" as const, decided_at: now, decided_by: this.who } : {}),
    });
  }
  /** Take in a proposed finding an analysis made (the demo's "Analyse"), unless one with its key is there. */
  async adopt(row: FindingRow): Promise<void> {
    if (!this.rows.some((r) => r.ai_key && r.ai_key === row.ai_key && r.process_id === row.process_id)) this.rows = [...this.rows, row];
  }
  async decide(id: string, status: "accepted" | "dismissed"): Promise<FindingWrite> {
    const row = this.find(id);
    if (!row) return { status: "forbidden" };
    if (row.status === "superseded") return { status: "invalid", message: SUPERSEDED };
    return this.put({ ...row, status, decided_at: new Date().toISOString(), decided_by: this.who });
  }
}

export interface FindingsState {
  findings: FindingRow[];
  busy: boolean;
  error: string | null;
  /** Whether the viewer may write (not readonly). */
  canEdit: boolean;
  create(draft: FindingDraft): Promise<FindingRow | null>;
  edit(id: string, draft: FindingDraft, accept?: boolean): Promise<FindingRow | null>;
  accept(id: string): Promise<FindingRow | null>;
  dismiss(id: string): Promise<FindingRow | null>;
  /** Proposed findings from a new analysis (the demo's "Analyse"): added unless one with the same key is there. */
  receive(rows: readonly FindingRow[]): void;
  dismissError(): void;
}

const messageOf = (w: Exclude<FindingWrite, { status: "saved" }>) =>
  w.status === "forbidden" ? "Only owners and editors can change findings." : w.status === "invalid" ? w.message : w.message;

export function useFindings(workspaceId: string, initial: readonly FindingRow[], mode: ScreenMode, store?: FindingsStore): FindingsState {
  const [writer] = useState<FindingsStore>(() => store ?? (mode === "live" ? liveFindingsStore(workspaceId) : new MemoryFindingsStore(workspaceId, [...initial])));
  const [findings, setFindings] = useState<FindingRow[]>(() => [...initial]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (write: () => Promise<FindingWrite>) => {
    if (isReadOnly(mode)) return null;
    setBusy(true);
    setError(null);
    try {
      const out = await write();
      if (out.status !== "saved") {
        setError(messageOf(out));
        return null;
      }
      setFindings((all) => [...all.filter((f) => f.id !== out.finding.id), out.finding]);
      return out.finding;
    } catch {
      setError("Couldn't save. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [mode]);

  return {
    findings,
    busy,
    error,
    canEdit: !isReadOnly(mode),
    create: (d) => run(() => writer.create(d)),
    edit: (id, d, accept = false) => run(() => writer.edit(id, d, accept)),
    accept: (id) => run(() => writer.decide(id, "accepted")),
    dismiss: (id) => run(() => writer.decide(id, "dismissed")),
    receive: (rows) => {
      if (writer instanceof MemoryFindingsStore) for (const r of rows) void writer.adopt(r);
      setFindings((all) => [...all, ...rows.filter((r) => !all.some((f) => f.ai_key && f.ai_key === r.ai_key && f.process_id === r.process_id))]);
    },
    dismissError: () => setError(null),
  };
}
