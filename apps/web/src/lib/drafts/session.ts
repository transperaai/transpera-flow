// Draft mode in the editor (issue #9, PRD §7.1b). A process has one live
// revision and at most one draft. The editor always edits the draft: its
// first save opens one (a copy of live with the same ids) and later saves
// continue it, so the live revision never changes until Publish. Discard
// throws the draft away. Framework-free so it can be unit tested;
// `useDraftSession` wraps it for React.

import type { ProcessBundle } from "@transpera-flow/db";
import { ProcessEditor } from "@/lib/editor/editor";
import type { Stamp } from "@/lib/editor/provenance";
import { MemoryStore, type ProcessStore, type WriteResult } from "@/lib/editor/store";
import { unresolvedSteps } from "./diff";

export interface RevisionInfo {
  id: string;
  number: number;
}

export type OpenResult = { status: "ok"; revision: RevisionInfo; created: boolean } | { status: "error"; message: string };

export type PublishResult =
  | { status: "published"; revision: RevisionInfo }
  /** Steps still marked as assumptions (or conflicts); nothing was published. */
  | { status: "unresolved"; steps: { id: string; name: string }[] }
  | { status: "error"; message: string };

/** Where drafts live: the database (through Server Actions) or memory (the demo, tests). */
export interface DraftBackend {
  /** The process's draft, opened from live if there is none. Idempotent. */
  open(): Promise<OpenResult>;
  discard(): Promise<WriteResult>;
  publish(acceptEstimates: boolean): Promise<PublishResult>;
  /** Saves into a draft revision. */
  store(revisionId: string): ProcessStore;
}

export interface DraftState {
  /** The live revision, as loaded or as last published here. */
  live: ProcessBundle;
  /** The open draft; null until the first edit opens one. */
  draft: RevisionInfo | null;
  /** The first edit is opening a draft. */
  opening: boolean;
  busy: "publishing" | "discarding" | null;
  /** Steps a refused publish listed as unresolved, until published or dismissed. */
  unresolved: { id: string; name: string }[] | null;
  /** What just happened ("Published version 3."), until dismissed. */
  notice: string | null;
  error: string | null;
}

export class DraftSession {
  readonly editor: ProcessEditor;
  private state: DraftState;
  private listeners = new Set<() => void>();
  private opening: Promise<string | null> | null = null;

  constructor(
    live: ProcessBundle,
    draft: { bundle: ProcessBundle; number: number } | null,
    private readonly backend: DraftBackend,
    /** Who is editing, and when: step parameters they change in the draft are recorded as entered (lib/editor/provenance.ts). */
    stamp?: () => Stamp,
  ) {
    this.state = {
      live,
      draft: draft ? { id: draft.bundle.revision.id, number: draft.number } : null,
      opening: false,
      busy: null,
      unresolved: null,
      notice: null,
      error: null,
    };
    this.editor = new ProcessEditor(draft?.bundle ?? live, this.store, stamp);
  }

  getState = (): DraftState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Whether a draft exists or is being opened. */
  hasDraft(): boolean {
    return this.state.draft !== null || this.state.opening;
  }

  /** The editor's store: every write goes to the draft, opening it first if needed. */
  private readonly store: ProcessStore = {
    insert: async (steps, edges) => {
      const id = await this.draftId();
      return id ? this.backend.store(id).insert(steps, edges) : this.openFailed();
    },
    remove: async (stepIds, edgeIds) => {
      const id = await this.draftId();
      return id ? this.backend.store(id).remove(stepIds, edgeIds) : this.openFailed();
    },
    update: async (table, rowId, base, next) => {
      const id = await this.draftId();
      return id ? this.backend.store(id).update(table, rowId, base, next) : this.openFailed();
    },
  };

  private openError = "Couldn't open a draft.";

  private openFailed(): { status: "error"; message: string } {
    return { status: "error", message: this.openError };
  }

  private draftId(): Promise<string | null> {
    if (this.state.draft) return Promise.resolve(this.state.draft.id);
    if (!this.opening) {
      this.set({ opening: true });
      this.opening = this.backend.open().then(
        (r) => {
          this.opening = null;
          if (r.status !== "ok") {
            this.openError = r.message;
            this.set({ opening: false });
            return null;
          }
          this.set({
            opening: false,
            draft: r.revision,
            // Someone else's draft was already open: their changes are in it, not on this screen until a reload.
            notice: r.created ? null : "Someone else already had a draft of this process open; your edits went into it. Reload to see their changes.",
          });
          return r.revision.id;
        },
        () => {
          this.opening = null;
          this.openError = "Couldn't open a draft. Check your connection and try again.";
          this.set({ opening: false });
          return null;
        },
      );
    }
    return this.opening;
  }

  /**
   * Make the draft live. Refused (and reported in `unresolved`) while steps
   * are unconfirmed estimates, unless `acceptEstimates`.
   */
  async publish(acceptEstimates = false): Promise<PublishResult | null> {
    if (this.state.busy) return null;
    this.set({ busy: "publishing", error: null, notice: null });
    await this.editor.settled();
    if (!this.state.draft) {
      this.set({ busy: null });
      return null;
    }
    let r: PublishResult;
    try {
      r = await this.backend.publish(acceptEstimates);
    } catch {
      r = { status: "error", message: "Couldn't publish. Check your connection and try again." };
    }
    if (r.status === "published") {
      const bundle = this.editor.getState().bundle;
      const live: ProcessBundle = { ...bundle, revision: { ...bundle.revision, id: r.revision.id, number: r.revision.number, status: "published" } };
      this.editor.reset(live);
      const accepted = acceptEstimates && unresolvedSteps(live).length;
      this.set({
        live,
        draft: null,
        busy: null,
        unresolved: null,
        notice: `Published version ${r.revision.number}${accepted ? `, with ${accepted} step${accepted === 1 ? "" : "s"} accepted as estimates` : ""}. It is now the live model.`,
      });
    } else if (r.status === "unresolved") {
      this.set({ busy: null, unresolved: r.steps });
    } else {
      this.set({ busy: null, error: r.message });
    }
    return r;
  }

  /** Throw the whole draft away; the editor goes back to live. */
  async discard(): Promise<boolean> {
    if (this.state.busy) return false;
    this.set({ busy: "discarding", error: null, notice: null });
    await this.editor.settled();
    let r: WriteResult = { status: "ok" };
    if (this.state.draft) {
      try {
        r = await this.backend.discard();
      } catch {
        r = { status: "error", message: "Couldn't discard the draft. Check your connection and try again." };
      }
    }
    if (r.status !== "ok") {
      this.set({ busy: null, error: r.message });
      return false;
    }
    this.editor.reset(this.state.live);
    this.set({ draft: null, busy: null, unresolved: null, notice: "Draft discarded. You're looking at the live model." });
    return true;
  }

  dismiss(): void {
    this.set({ notice: null, error: null, unresolved: null });
  }

  /** The revision the editor shows and saves into: the draft, or live while there is none. */
  currentRevision(): string {
    return this.state.draft?.id ?? this.state.live.revision.id;
  }

  private set(patch: Partial<DraftState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/**
 * Drafts in memory, with the database's rules: one draft at a time, copied
 * from live with the same ids, publishing refused while steps are estimates
 * unless accepted. For the public demo and tests.
 */
export class MemoryDraftBackend implements DraftBackend {
  private live: MemoryStore;
  private liveRevision: RevisionInfo;
  private draft: { store: MemoryStore; revision: RevisionInfo } | null = null;
  private revisionCount = 0;
  /** Publishes, newest last, as the audit log would record them. */
  readonly published: { number: number; acceptEstimates: boolean; estimates: string[] }[] = [];

  constructor(live: ProcessBundle) {
    this.liveRevision = { id: live.revision.id, number: live.revision.number };
    // Retired steps are stored rows too (issue #16).
    this.live = new MemoryStore({ steps: [...live.steps, ...(live.retired ?? [])], edges: live.edges });
    this.revisionCount = live.revision.number;
  }

  /** What a run of the live model loads. */
  liveRows() {
    return this.live.snapshot();
  }

  draftRows() {
    return this.draft?.store.snapshot() ?? null;
  }

  liveRevisionInfo(): RevisionInfo {
    return this.liveRevision;
  }

  async open(): Promise<OpenResult> {
    if (this.draft) return { status: "ok", revision: this.draft.revision, created: false };
    this.revisionCount += 1;
    const revision = { id: crypto.randomUUID(), number: this.revisionCount };
    this.draft = { store: new MemoryStore(this.live.snapshot()), revision };
    return { status: "ok", revision: this.draft.revision, created: true };
  }

  async discard(): Promise<WriteResult> {
    if (this.draft) this.revisionCount -= 1;
    this.draft = null;
    return { status: "ok" };
  }

  async publish(acceptEstimates: boolean): Promise<PublishResult> {
    if (!this.draft) return { status: "error", message: "There is no draft to publish." };
    const rows = this.draft.store.snapshot();
    const estimates = unresolvedSteps(rows).map((s) => ({ id: s.id, name: s.name }));
    if (estimates.length && !acceptEstimates) return { status: "unresolved", steps: estimates };
    this.live = this.draft.store;
    this.liveRevision = this.draft.revision;
    this.published.push({ number: this.draft.revision.number, acceptEstimates, estimates: estimates.map((s) => s.id) });
    this.draft = null;
    return { status: "published", revision: this.liveRevision };
  }

  store(revisionId: string): ProcessStore {
    const draft = this.draft;
    if (!draft || draft.revision.id !== revisionId) {
      const gone = { status: "error" as const, message: "This draft was published or discarded. Reload to continue." };
      return { insert: async () => gone, remove: async () => gone, update: async () => gone };
    }
    return draft.store;
  }
}
