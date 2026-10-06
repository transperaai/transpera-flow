// The editor's Realtime port on Supabase Realtime (issue #10; see
// docs/adr/0005-realtime-presence-and-live-changes.md). A thin adapter:
//
// - `process:<id>`: a private channel (Realtime Authorization; policies in
//   migration 20261007000000_realtime.sql) for Presence and the "who saved
//   what" broadcast notes.
// - `process-rows:<id>:<revision>`: Postgres Changes on steps and edges of the
//   revision (inserts and updates filtered by revision_id; deletes can't be
//   filtered by Supabase, so they are filtered here) and on the process row.
//   Supabase checks each row against the listener's RLS before sending it.
//
// Typed against the few calls it makes, so tests can pass a fake client.

import { changeFromPayload } from "./rows";
import type { ChannelStatus, Note, Present, ProcessChannel, ProcessChannelHandlers, RealtimeTransport, RevisionFeedHandlers, Viewer } from "./transport";

/* eslint-disable @typescript-eslint/no-explicit-any -- payloads are checked before use */
export interface RealtimeChannelLike {
  on(type: string, filter: Record<string, unknown>, callback: (payload: any) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannelLike;
  track(payload: Record<string, unknown>): Promise<unknown>;
  send(message: { type: "broadcast"; event: string; payload: unknown }): Promise<unknown>;
  presenceState(): Record<string, Record<string, unknown>[]>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface RealtimeClientLike {
  channel(name: string, opts?: { config: Record<string, unknown> }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
  realtime: { setAuth(token?: string | null): Promise<void> };
}

const statusOf = (s: string): ChannelStatus => (s === "SUBSCRIBED" ? "live" : "offline");

export function supabaseTransport(client: RealtimeClientLike): RealtimeTransport {
  return {
    joinProcess(processId, key, handlers) {
      return joinProcess(client, processId, key, handlers);
    },
    watchRevision(processId, revisionId, handlers) {
      return watchRevision(client, processId, revisionId, handlers);
    },
  };
}

function joinProcess(client: RealtimeClientLike, processId: string, key: string, handlers: ProcessChannelHandlers): ProcessChannel {
  let closed = false;
  let joined = false;
  let tracked: Record<string, unknown> | null = null;
  const channel = client.channel(`process:${processId}`, { config: { private: true, presence: { key, enabled: true } } });
  channel
    .on("presence", { event: "sync" }, () => {
      if (!closed) handlers.presence(presentFrom(channel.presenceState()));
    })
    .on("broadcast", { event: "note" }, (message: { payload?: unknown }) => {
      const note = parseNote(message?.payload);
      if (note && !closed) handlers.note(note);
    });
  handlers.status("connecting");
  // Private channels need the user's token on the socket first.
  void client.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (closed) return;
      channel.subscribe((status) => {
        if (closed) return;
        joined = status === "SUBSCRIBED";
        handlers.status(statusOf(status));
        // Presence isn't re-sent after a reconnect: track again on every join.
        if (joined && tracked) void channel.track(tracked);
      });
    });
  return {
    track(state) {
      tracked = { ...state };
      if (joined) void channel.track(tracked);
    },
    send(note) {
      if (joined) void channel.send({ type: "broadcast", event: "note", payload: note });
    },
    close() {
      closed = true;
      void client.removeChannel(channel);
    },
  };
}

function watchRevision(client: RealtimeClientLike, processId: string, revisionId: string, handlers: RevisionFeedHandlers): { close(): void } {
  let closed = false;
  const onRow = (payload: { table: string; eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
    const change = changeFromPayload(payload);
    // Deletes arrive for every revision (they can't be filtered server-side).
    if (!closed && change && change.revisionId === revisionId) handlers.row(change);
  };
  const channel = client.channel(`process-rows:${processId}:${revisionId}`);
  for (const table of ["steps", "edges"]) {
    channel
      .on("postgres_changes", { event: "INSERT", schema: "public", table, filter: `revision_id=eq.${revisionId}` }, onRow)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table, filter: `revision_id=eq.${revisionId}` }, onRow)
      .on("postgres_changes", { event: "DELETE", schema: "public", table }, onRow);
  }
  channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "processes", filter: `id=eq.${processId}` }, () => {
    if (!closed) handlers.process();
  });
  handlers.status("connecting");
  channel.subscribe((status) => {
    if (!closed) handlers.status(statusOf(status));
  });
  return {
    close() {
      closed = true;
      void client.removeChannel(channel);
    },
  };
}

/** Presence state as one entry per tab (the latest a key tracked), dropping anything malformed. */
export function presentFrom(state: Record<string, Record<string, unknown>[]>): Present[] {
  const out: Present[] = [];
  for (const [key, metas] of Object.entries(state)) {
    const meta = metas.at(-1);
    const viewer = meta && parseViewer(meta);
    if (!viewer || !meta) continue;
    const view = meta.view === "live" ? "live" : "draft";
    const since = typeof meta.since === "string" ? meta.since : "";
    out.push({ ...viewer, key, view, since });
  }
  return out;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function parseViewer(v: unknown): Viewer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const userId = text(o.userId, 100);
  const name = text(o.name, 200);
  if (!userId || !name) return null;
  // Never read an email from presence (B1 2/3): older tabs may still send one.
  return { userId, name, email: null };
}

/** A note from another tab: untrusted input, so only well-formed notes are used. */
export function parseNote(v: unknown): Note | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const by = parseViewer(o.by);
  if (!by) return null;
  const ids = (x: unknown) => (Array.isArray(x) && x.every((i) => typeof i === "string") ? (x as string[]) : null);
  if (o.kind === "draft" && (o.event === "opened" || o.event === "published" || o.event === "discarded") && text(o.revisionId, 100)) {
    return { kind: "draft", by, event: o.event, revisionId: o.revisionId as string };
  }
  if (o.kind === "rows" && (o.op === "insert" || o.op === "remove")) {
    const steps = ids(o.steps);
    const edges = ids(o.edges);
    return steps && edges ? { kind: "rows", by, op: o.op, steps, edges } : null;
  }
  if (o.kind === "saved" && (o.table === "steps" || o.table === "edges") && text(o.id, 100) && o.values && typeof o.values === "object") {
    const values: Record<string, string | number | boolean | null> = {};
    for (const [k, val] of Object.entries(o.values as Record<string, unknown>)) {
      if (val === null || ["string", "number", "boolean"].includes(typeof val)) values[k] = val as string | number | boolean | null;
    }
    return { kind: "saved", by, table: o.table, id: o.id as string, values };
  }
  return null;
}
