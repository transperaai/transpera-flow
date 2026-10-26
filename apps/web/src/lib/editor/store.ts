// Where edits are saved. The editor talks to this interface only: `live`
// (./live-store.ts) calls Server Actions that write to the database as the
// signed-in user; `MemoryStore` keeps rows in memory for the public demo and
// for tests. Updates are per-field compare-and-set (docs/adr/0001-per-field-saves.md):
// `base` is what the editor last saw, and a field someone else changed since
// comes back as a conflict instead of being overwritten. Creates and deletes
// are plain inserts and deletes.

import type { EdgeRow, ProcessBundle, StepRow } from "@transpera-flow/db";
import { sameScalar } from "./commands";
import { readField, writeFields, type Patch, type Table } from "./ops";

export type WriteResult = { status: "ok" } | { status: "error"; message: string };

export type UpdateResult =
  | { status: "saved" }
  /** Fields someone else changed since `base`, with what is stored now. The other fields were saved. */
  | { status: "conflict"; theirs: Patch }
  /** The row is gone, or the user may not edit it. */
  | { status: "not_found" }
  | { status: "error"; message: string };

export interface ProcessStore {
  insert(steps: StepRow[], edges: EdgeRow[]): Promise<WriteResult>;
  /** Removing a step removes its edges too. Rows already gone are fine. */
  remove(stepIds: string[], edgeIds: string[]): Promise<WriteResult>;
  update(table: Table, id: string, base: Patch, next: Patch): Promise<UpdateResult>;
}

/**
 * Rows in memory, with the same compare-and-set rules as the database.
 */
export class MemoryStore implements ProcessStore {
  private steps = new Map<string, StepRow>();
  private edges = new Map<string, EdgeRow>();

  constructor(bundle: Pick<ProcessBundle, "steps" | "edges">) {
    for (const s of bundle.steps) this.steps.set(s.id, structuredClone(s));
    for (const e of bundle.edges) this.edges.set(e.id, structuredClone(e));
  }

  /** What is stored, as a reload would see it. */
  snapshot(): { steps: StepRow[]; edges: EdgeRow[] } {
    return { steps: [...this.steps.values()].map((s) => structuredClone(s)), edges: [...this.edges.values()].map((e) => structuredClone(e)) };
  }

  async insert(steps: StepRow[], edges: EdgeRow[]): Promise<WriteResult> {
    const clash = steps.some((s) => this.steps.has(s.id)) || edges.some((e) => this.edges.has(e.id));
    if (clash) return { status: "error", message: "That item already exists." };
    for (const s of steps) this.steps.set(s.id, structuredClone(s));
    for (const e of edges) {
      if (!this.steps.has(e.from_step_id) || !this.steps.has(e.to_step_id)) {
        return { status: "error", message: "That connection points at a step that no longer exists." };
      }
      this.edges.set(e.id, structuredClone(e));
    }
    return { status: "ok" };
  }

  async remove(stepIds: string[], edgeIds: string[]): Promise<WriteResult> {
    const gone = new Set(stepIds);
    const edges = new Set(edgeIds.filter((id) => this.edges.has(id)));
    for (const [id, e] of this.edges) if (gone.has(e.from_step_id) || gone.has(e.to_step_id)) edges.add(id);
    const steps = stepIds.filter((id) => this.steps.has(id));
    for (const id of edges) this.edges.delete(id);
    for (const id of steps) this.steps.delete(id);
    return { status: "ok" };
  }

  async update(table: Table, id: string, base: Patch, next: Patch): Promise<UpdateResult> {
    const rows: Map<string, object> = table === "steps" ? this.steps : this.edges;
    const row = rows.get(id);
    if (!row) return { status: "not_found" };
    const write: Patch = {};
    const theirs: Patch = {};
    for (const [field, value] of Object.entries(next)) {
      const stored = readField(row, field);
      const seen = field in base ? base[field]! : null;
      if (!sameScalar(stored, seen) && !sameScalar(stored, value)) theirs[field] = stored;
      else write[field] = value;
    }
    rows.set(id, writeFields(row, write));
    return Object.keys(theirs).length ? { status: "conflict", theirs } : { status: "saved" };
  }
}
