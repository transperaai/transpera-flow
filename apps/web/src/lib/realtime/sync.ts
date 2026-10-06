// Presence and live changes for one open process (issue #10, PRD §4.1, D14;
// docs/adr/0005-realtime-presence-and-live-changes.md). Framework-free: it
// wires a RealtimeTransport (Supabase, or memory for the demo and tests) to a
// DraftSession and its editor.
//
// - Presence: this tab tracks who is signed in and whether they are looking
//   at Live or Draft; `others` lists everyone else on the process.
// - Live changes: rows of the revision being edited (the draft, or live while
//   there is none) are merged into the editor as they are saved. When the
//   process's revisions change, or the feed (re)connects and may have missed
//   something, the session catches up from the database.
// - Names: after each save this tab broadcasts a note naming its author, so
//   the others can say "Tom changed this to 4h". Changes without a note (MCP,
//   or a note that got lost) are "Someone else".

import type { DraftSession } from "@/lib/drafts/session";
import { describeValue, fieldLabel, namesOf } from "@/lib/editor/describe";
import { sameScalar } from "@/lib/editor/commands";
import type { Table, Value } from "@/lib/editor/ops";
import type { Applied } from "./merge";
import type { ChannelStatus, Note, Present, ProcessChannel, RealtimeTransport, View, Viewer } from "./transport";

/**
 * Something someone else did, for the activity line ("Tom changed Audit's
 * hands-on time to 4h"). The name is looked up when shown (`activityText`),
 * since the note naming them can arrive after the change.
 */
export interface Activity {
  id: number;
  at: number;
  /** The sentence without its subject: "changed Audit's hands-on time to 4h". */
  what: string;
  author:
    | { kind: "field"; table: Table; id: string; field: string; value: Value }
    | { kind: "rows"; op: "insert" | "remove"; table: Table; id: string };
}

export interface RealtimeState {
  /** Presence channel: "live" once joined. */
  status: ChannelStatus;
  /** Everyone else on the process, one entry per tab, oldest first. */
  others: Present[];
  /** Latest first; at most a few. */
  activity: Activity[];
  /** Bumped when a note arrives, so names shown in conflict prompts update. */
  notes: number;
}

export interface SyncOptions {
  /** What this tab shows at first. */
  view?: View;
  /** This tab's presence key (random by default). */
  key?: string;
  now?: () => number;
  /** How long to wait before catching up after a draft is opened, published or discarded elsewhere, so the note naming who did it can arrive first (0: at once). */
  noteWaitMs?: number;
}

/** How long a note's name is used for a matching change. */
const NOTE_MS = 2 * 60_000;
const MAX_ACTIVITY = 4;

export class RealtimeSync {
  private state: RealtimeState = { status: "connecting", others: [], activity: [], notes: 0 };
  private listeners = new Set<() => void>();
  private channel: ProcessChannel | null = null;
  private feed: { revisionId: string; close(): void } | null = null;
  private view: View;
  private readonly since: string;
  private readonly key: string;
  private notes = new Map<string, { value: Value; by: Viewer; at: number }>();
  private draftNotes = new Map<string, { by: Viewer; at: number }>();
  private rowNotes = new Map<string, { by: Viewer; at: number }>();
  private seenOffline = false;
  private nextActivity = 1;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly session: DraftSession,
    private readonly transport: RealtimeTransport,
    me: Viewer,
    options: SyncOptions = {},
  ) {
    // Presence and notes name a person, never their email (B1 2/3: other tabs' viewers get no email address).
    this.me = { ...me, email: null };
    this.now = options.now ?? Date.now;
    this.view = options.view ?? "draft";
    this.key = options.key ?? randomKey();
    this.noteWaitMs = options.noteWaitMs ?? 800;
    this.since = new Date(this.now()).toISOString();
  }

  private readonly me: Viewer;
  private readonly now: () => number;
  private readonly noteWaitMs: number;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  /** Run `fn` once a note has had time to arrive (notes are sent after the save returns, so often land second). */
  private later(fn: () => void): void {
    if (this.noteWaitMs <= 0) return fn();
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, this.noteWaitMs);
    this.timers.add(t);
  }

  getState = (): RealtimeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** This tab's presence key. */
  get presenceKey(): string {
    return this.key;
  }

  start(): void {
    if (this.channel) return;
    const processId = this.session.getState().live.process.id;
    this.channel = this.transport.joinProcess(processId, this.key, {
      presence: (members) => this.set({ others: members.filter((m) => m.key !== this.key).sort((a, b) => a.since.localeCompare(b.since)) }),
      note: (note) => this.remember(note),
      status: (status) => this.set({ status }),
    });
    this.track();
    this.watch();
    const editor = this.session.editor;
    this.cleanup.push(
      this.session.subscribe(() => this.watch()),
      editor.onSaved((saved) =>
        this.channel?.send(
          saved.kind === "update"
            ? { kind: "saved", by: this.me, table: saved.table, id: saved.id, values: saved.values }
            : { kind: "rows", by: this.me, op: saved.kind, steps: saved.steps, edges: saved.edges },
        ),
      ),
      editor.onRemote((applied) => this.describe(applied)),
      this.session.onDraftEvent((event, revisionId) => this.channel?.send({ kind: "draft", by: this.me, event, revisionId })),
    );
  }

  stop(): void {
    for (const off of this.cleanup.splice(0)) off();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.feed?.close();
    this.feed = null;
    this.channel?.close();
    this.channel = null;
    this.set({ status: "offline", others: [] });
  }

  /** The Live / Draft switch changed. */
  setView(view: View): void {
    if (view === this.view) return;
    this.view = view;
    this.track();
  }

  /** Who saved `value` into this field, if a note said so. */
  who(table: Table, id: string, field: string, value: Value): string | null {
    const note = this.notes.get(`${table}:${id}:${field}`);
    return note && this.now() - note.at < NOTE_MS && sameScalar(note.value, value) ? note.by.name : null;
  }

  private track(): void {
    this.channel?.track({ ...this.me, view: this.view, since: this.since });
  }

  /** Follow the revision the session edits now (it changes when a draft is opened, published or discarded). */
  private watch(): void {
    const revisionId = this.session.currentRevision();
    if (this.feed?.revisionId === revisionId) return;
    this.feed?.close();
    const processId = this.session.getState().live.process.id;
    let first = true;
    const handle = this.transport.watchRevision(processId, revisionId, {
      row: (change) => {
        if (this.feed === feed && this.session.currentRevision() === revisionId) this.session.editor.applyRemote(change);
      },
      // Wait a moment so the note naming who opened, published or discarded can arrive.
      process: () => this.later(() => void this.session.reconcile(this.actor)),
      status: (status) => {
        if (status === "offline") this.seenOffline = true;
        // Joined (first time: anything saved since the page loaded; again: anything missed while away).
        if (status === "live" && (first || this.seenOffline)) {
          first = false;
          this.seenOffline = false;
          void this.session.reconcile(this.actor);
        }
      },
    });
    const feed = { revisionId, close: () => handle.close() };
    this.feed = feed;
  }

  private readonly actor = (event: "opened" | "published" | "discarded", revisionId: string): string | null => {
    const note = this.draftNotes.get(`${event}:${revisionId}`);
    return note && this.now() - note.at < NOTE_MS ? note.by.name : null;
  };

  private remember(note: Note): void {
    const at = this.now();
    if (note.kind === "draft") {
      this.draftNotes.set(`${note.event}:${note.revisionId}`, { by: note.by, at });
    } else if (note.kind === "rows") {
      for (const [table, ids] of [["steps", note.steps], ["edges", note.edges]] as const) {
        for (const id of ids) this.rowNotes.set(`${note.op}:${table}:${id}`, { by: note.by, at });
      }
    } else {
      for (const [field, value] of Object.entries(note.values)) this.notes.set(`${note.table}:${note.id}:${field}`, { value, by: note.by, at });
    }
    for (const map of [this.notes, this.draftNotes, this.rowNotes] as Map<string, { at: number }>[]) {
      if (map.size > 500) for (const [k, v] of map) if (at - v.at >= NOTE_MS) map.delete(k);
    }
    this.set({ notes: this.state.notes + 1 });
  }

  /** Who added or removed a row, if a note said so. */
  private whoRows(table: Table, id: string, op: "insert" | "remove"): string | null {
    const note = this.rowNotes.get(`${op}:${table}:${id}`);
    return note && this.now() - note.at < NOTE_MS ? note.by.name : null;
  }

  /** An activity entry as a sentence, naming whoever a note says did it. */
  activityText(a: Activity): string {
    const by = a.author.kind === "field" ? this.who(a.author.table, a.author.id, a.author.field, a.author.value) : this.whoRows(a.author.table, a.author.id, a.author.op);
    return `${by ?? "Someone else"} ${a.what}`;
  }

  private describe(applied: Applied[]): void {
    const bundle = this.session.editor.getState().bundle;
    const names = namesOf(bundle, this.session.getState().live);
    const out: Omit<Activity, "id" | "at">[] = [];
    const removed = applied.filter((a) => a.table === "steps" && a.kind === "removed");
    if (removed.length) {
      const name = names.get(removed[0]!.id);
      out.push({
        what: removed.length > 1 ? `removed ${removed.length} steps` : `removed ${name ? `the step ${name}` : "a step"}`,
        author: { kind: "rows", op: "remove", table: "steps", id: removed[0]!.id },
      });
    }
    for (const a of applied) {
      // Connections coming and going are told with their steps (or are too small to mention).
      if (a.kind === "removed" || (a.table === "edges" && a.kind === "added")) continue;
      const name = a.table === "steps" ? names.get(a.id) : edgeName(bundle.edges.find((e) => e.id === a.id), names);
      if (a.kind === "added") {
        out.push({ what: `added the step ${name ?? ""}`.trim(), author: { kind: "rows", op: "insert", table: a.table, id: a.id } });
        continue;
      }
      const fields = Object.entries(a.values).filter(([f]) => f !== "y" || !("x" in a.values));
      if (!fields.length) continue;
      const [field, value] = fields[0]!;
      const subject = name ?? (a.table === "steps" ? "a step" : "a connection");
      const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
      out.push({
        what: field === "x" || field === "y" ? `moved ${subject}` : `changed ${subject}'s ${fieldLabel(field)} to ${describeValue(field, value, names)}${more}`,
        author: { kind: "field", table: a.table, id: a.id, field, value },
      });
    }
    if (!out.length) return;
    const at = this.now();
    const fresh = out.slice(-MAX_ACTIVITY).map((a) => ({ ...a, id: this.nextActivity++, at }));
    this.set({ activity: [...fresh.reverse(), ...this.state.activity].slice(0, MAX_ACTIVITY) });
  }

  private set(patch: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function edgeName(edge: { from_step_id: string; to_step_id: string } | undefined, names: Map<string, string>): string | undefined {
  return edge ? `${names.get(edge.from_step_id) ?? "a step"} → ${names.get(edge.to_step_id) ?? "a step"}` : undefined;
}

function randomKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
