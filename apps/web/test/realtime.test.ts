import { describe, expect, it, vi } from "vitest";
import { northbeamBundle, northbeamStepIds, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { DraftSession, MemoryDraftBackend } from "@/lib/drafts/session";
import { addStep, deleteSteps, updateStep } from "@/lib/editor/commands";
import { ProcessEditor } from "@/lib/editor/editor";
import { MemoryStore, type ProcessStore } from "@/lib/editor/store";
import { COLLEAGUE, DemoColleague } from "@/lib/realtime/demo-colleague";
import { MemoryRealtime } from "@/lib/realtime/memory";
import { RemoteChangeMerger } from "@/lib/realtime/merge";
import { changeFromPayload, stepFromRecord, type RemoteChange } from "@/lib/realtime/rows";
import { parseNote, presentFrom, supabaseTransport, type RealtimeChannelLike, type RealtimeClientLike } from "@/lib/realtime/supabase-transport";
import { RealtimeSync } from "@/lib/realtime/sync";
import type { Viewer } from "@/lib/realtime/transport";

const ids = northbeamStepIds;
const step = (b: Pick<ProcessBundle, "steps">, id: string) => b.steps.find((s) => s.id === id)!;
const stored = (m: MemoryStore, id: string) => step(m.snapshot(), id);

/** An editor over a MemoryStore; `remote` saves as someone else would and hands back the change Realtime would send. */
function setup(store?: ProcessStore) {
  const bundle = northbeamBundle();
  const memory = new MemoryStore(bundle);
  const changes: RemoteChange[] = [];
  memory.onChange = (c) => changes.push(c);
  const editor = new ProcessEditor(bundle, store ?? memory);
  const now = () => editor.getState().bundle;
  /** Deliver what Realtime has queued (our echoes and others' saves), in order. */
  const deliver = () => {
    for (const c of changes.splice(0)) editor.applyRemote(c);
  };
  return { bundle, memory, editor, now, changes, deliver };
}

describe("merging other people's saved changes", () => {
  it("shows a remote change at once, outside the undo history, and saves later edits against it", async () => {
    const { editor, memory, now, deliver } = setup();
    await memory.update("steps", ids.audit, { work_hours: 6 }, { work_hours: 4 });
    deliver();
    expect(step(now(), ids.audit).work_hours).toBe(4);
    expect(editor.getState().undoLabel).toBeNull();
    // Our next edit of that field compares against the remote value: no conflict.
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 5 }));
    await editor.settled();
    expect(editor.getState().conflicts).toEqual([]);
    expect(stored(memory, ids.audit).work_hours).toBe(5);
    // Undo goes back to the remote value, not to what we loaded.
    editor.undo();
    await editor.settled();
    expect(stored(memory, ids.audit).work_hours).toBe(4);
  });

  it("skips echoes of our own saves, even late ones that arrive after a newer save", async () => {
    const { editor, memory, now, changes, deliver } = setup();
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit v2" }));
    editor.run((b) => updateStep(b, ids.audit, { name: "Audit v3" }));
    await editor.settled();
    expect(changes).toHaveLength(2);
    const seen: string[] = [];
    editor.subscribe(() => seen.push(step(now(), ids.audit).name));
    deliver();
    // The echo of "Audit v2" didn't flash back on screen.
    expect(seen).toEqual([]);
    expect(step(now(), ids.audit).name).toBe("Audit v3");
    expect(stored(memory, ids.audit).name).toBe("Audit v3");
  });

  it("keeps both people's edits to different fields of the same step", async () => {
    const { editor, memory, now, deliver } = setup();
    // Tom renames the step; we change its hands-on time before hearing about it.
    await memory.update("steps", ids.audit, { name: "Audit & proposal" }, { name: "Audit" });
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    deliver();
    expect(editor.getState().conflicts).toEqual([]);
    expect(step(now(), ids.audit)).toMatchObject({ name: "Audit", work_hours: 4 });
    expect(stored(memory, ids.audit)).toMatchObject({ name: "Audit", work_hours: 4 });
  });

  it("skips older values of a field we are saving, and shows newer ones (after our echo) at once", async () => {
    const memory = new MemoryStore(northbeamBundle());
    let release!: () => void;
    const slow: ProcessStore = {
      insert: (s, e) => memory.insert(s, e),
      remove: (s, e) => memory.remove(s, e),
      update: async (...args) => {
        const r = await memory.update(...args);
        await new Promise<void>((resolve) => (release = resolve));
        return r;
      },
    };
    const { editor, now } = setup(slow);
    const before = stored(memory, ids.audit);
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // A change committed before ours (Tom renamed it; the row still says 6h) arrives late: the name shows, the hours don't.
    editor.applyRemote({ kind: "upsert", table: "steps", row: { ...before, name: "Audit" } });
    expect(step(now(), ids.audit)).toMatchObject({ name: "Audit", work_hours: 4 });
    // Our echo, then Tom's later save, arrive before our save returns: his value shows.
    editor.applyRemote({ kind: "upsert", table: "steps", row: stored(memory, ids.audit) });
    await memory.update("steps", ids.audit, { work_hours: 4 }, { work_hours: 9 });
    editor.applyRemote({ kind: "upsert", table: "steps", row: stored(memory, ids.audit) });
    expect(step(now(), ids.audit).work_hours).toBe(9);
    release();
    await editor.settled();
    expect(step(now(), ids.audit).work_hours).toBe(9);
    expect(editor.getState().conflicts).toEqual([]);
  });

  it("shows a value skipped during our save if that save fails", async () => {
    const memory = new MemoryStore(northbeamBundle());
    const failing: ProcessStore = {
      insert: (s, e) => memory.insert(s, e),
      remove: (s, e) => memory.remove(s, e),
      update: async () => {
        await memory.update("steps", ids.audit, { work_hours: 6 }, { work_hours: 8 });
        editor.applyRemote({ kind: "upsert", table: "steps", row: stored(memory, ids.audit) });
        return { status: "error", message: "Offline." };
      },
    };
    const { editor, now } = setup(failing);
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    expect(step(now(), ids.audit).work_hours).toBe(8);
    expect(editor.getState().undoLabel).toBeNull();
  });

  it("asks keep mine / keep theirs when both change the same field, and the choice persists", async () => {
    const { editor, memory, now, deliver } = setup();
    await memory.update("steps", ids.audit, { work_hours: 6 }, { work_hours: 8 });
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    deliver();
    // Their change arrived after the conflict: ours stays on screen, theirs in the prompt.
    expect(editor.getState().conflicts).toMatchObject([{ field: "work_hours", mine: 4, theirs: 8 }]);
    expect(step(now(), ids.audit).work_hours).toBe(4);
    // They change it again meanwhile: the prompt follows.
    await memory.update("steps", ids.audit, { work_hours: 8 }, { work_hours: 10 });
    deliver();
    expect(editor.getState().conflicts).toMatchObject([{ mine: 4, theirs: 10 }]);
    await editor.keepMine(editor.getState().conflicts[0]!);
    deliver();
    expect(stored(memory, ids.audit).work_hours).toBe(4);
    expect(step(now(), ids.audit).work_hours).toBe(4);

    await memory.update("steps", ids.audit, { name: "Audit & proposal" }, { name: "Tom's name" });
    editor.run((b) => updateStep(b, ids.audit, { name: "My name" }));
    await editor.settled();
    editor.keepTheirs(editor.getState().conflicts[0]!);
    deliver();
    expect(step(now(), ids.audit).name).toBe("Tom's name");
    expect(stored(memory, ids.audit).name).toBe("Tom's name");
  });

  it("drops a conflict when the stored value comes to match ours", async () => {
    const { editor, memory, deliver } = setup();
    await memory.update("steps", ids.audit, { work_hours: 6 }, { work_hours: 8 });
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    await memory.update("steps", ids.audit, { work_hours: 8 }, { work_hours: 4 });
    deliver();
    expect(editor.getState().conflicts).toEqual([]);
  });

  it("an undo of a field someone else has since changed is a conflict, not an overwrite", async () => {
    const { editor, memory, now, deliver } = setup();
    editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await editor.settled();
    deliver();
    await memory.update("steps", ids.audit, { work_hours: 4 }, { work_hours: 7 });
    deliver();
    expect(step(now(), ids.audit).work_hours).toBe(7);
    editor.undo();
    await editor.settled();
    expect(editor.getState().conflicts).toMatchObject([{ field: "work_hours", mine: 6, theirs: 7 }]);
    expect(stored(memory, ids.audit).work_hours).toBe(7);
  });

  it("adds and removes rows others add and remove, with a removed step's edges", async () => {
    const { editor, memory, now, deliver } = setup();
    const added = addStep(now(), { kind: "task", x: 1, y: 2 });
    const row = added.edit.ops[0]!.kind === "insert" ? added.edit.ops[0]!.steps[0]! : null;
    await memory.insert([row!], []);
    await memory.remove([ids.kickoff], []);
    deliver();
    expect(now().steps.some((s) => s.id === added.id)).toBe(true);
    expect(now().steps.some((s) => s.id === ids.kickoff)).toBe(false);
    expect(now().edges.some((e) => e.from_step_id === ids.kickoff || e.to_step_id === ids.kickoff)).toBe(false);
    expect(editor.getState().undoLabel).toBeNull();
  });

  it("treats a change to a row we are removing as older than our remove, until our delete comes back", () => {
    const merger = new RemoteChangeMerger();
    const b = northbeamBundle();
    const removing = deleteSteps(b, [ids.kickoff])!.ops[0]!;
    if (removing.kind !== "remove") throw new Error("expected a remove");
    merger.begin(removing);
    const without = { ...b, steps: b.steps.filter((s) => s.id !== ids.kickoff) };
    const late = { kind: "upsert", table: "steps", row: step(b, ids.kickoff) } as const;
    expect(merger.merge(without, [], late).bundle).toBe(without);
    merger.end(removing, { kind: "saved", conflicted: new Set() });
    expect(merger.merge(without, [], late).bundle).toBe(without);
    // Our delete's echo; after it, someone re-creating the row is news.
    expect(merger.merge(without, [], { kind: "delete", table: "steps", id: ids.kickoff }).applied).toBeNull();
    expect(merger.merge(without, [], late).applied?.kind).toBe("added");
  });

  it("gives up waiting for an echo that never comes", () => {
    let t = 0;
    const merger = new RemoteChangeMerger(() => t);
    const b = northbeamBundle();
    const unit = { kind: "update", change: { table: "steps", id: ids.audit, before: { work_hours: 6 }, after: { work_hours: 4 } } } as const;
    merger.begin(unit);
    merger.end(unit, { kind: "saved", conflicted: new Set() });
    const tom = { kind: "upsert", table: "steps", row: { ...step(b, ids.audit), work_hours: 9 } } as const;
    expect(merger.merge(b, [], tom).applied).toBeNull();
    t = 60_000;
    expect(merger.merge(b, [], tom).applied).toMatchObject({ values: { work_hours: 9 } });
  });

  it("turns a field someone saved while it was being typed into a conflict whose 'keep mine' is an undoable edit", async () => {
    const { editor, memory, now, deliver } = setup();
    await memory.update("steps", ids.audit, { name: "Audit & proposal" }, { name: "Tom's name" });
    deliver();
    editor.raiseConflict({
      table: "steps",
      id: ids.audit,
      field: "name",
      mine: "My name",
      theirs: "Tom's name",
      retry: (b) => updateStep(b, ids.audit, { name: "My name" }),
    });
    expect(step(now(), ids.audit).name).toBe("My name");
    await editor.keepMine(editor.getState().conflicts[0]!);
    expect(stored(memory, ids.audit).name).toBe("My name");
    expect(editor.getState().undoLabel).toMatch(/Changed/);
    editor.undo();
    await editor.settled();
    expect(stored(memory, ids.audit).name).toBe("Tom's name");
  });

  it("catches up from the stored rows after missing changes, keeping our unsaved work", async () => {
    const { editor, memory, now, changes } = setup();
    await memory.update("steps", ids.audit, { name: "Audit & proposal" }, { name: "Missed" });
    await memory.remove([ids.kickoff], []);
    changes.length = 0; // Lost while offline.
    editor.raiseConflict({ table: "steps", id: ids.qualify, field: "work_hours", mine: 3, theirs: 1 });
    editor.resync(memory.snapshot());
    expect(step(now(), ids.audit).name).toBe("Missed");
    expect(now().steps.some((s) => s.id === ids.kickoff)).toBe(false);
    expect(step(now(), ids.qualify).work_hours).toBe(3);
    expect(editor.getState().conflicts).toHaveLength(1);
  });
});

describe("provenance in remote changes", () => {
  const stamped = (row: StepRow) => (row as StepRow & { provenance?: Record<string, unknown> }).provenance ?? {};

  it("applies a remote value together with its provenance, and knows our own stamped echo", async () => {
    const bundle = northbeamBundle();
    const memory = new MemoryStore(bundle);
    const changes: RemoteChange[] = [];
    memory.onChange = (c) => changes.push(c);
    const editor = new ProcessEditor(bundle, memory, () => ({ at: "2026-10-07T09:00:00.000Z", by: "00000000-0000-4000-8000-00000000a0a0" }));
    editor.run((b) => updateStep(b, ids.onboard, { work_hours: 4 }));
    await editor.settled();
    // The echo comes back with the entry's keys in another order (jsonb does that): still ours.
    const echo = changes.splice(0)[0]!;
    if (echo.kind !== "upsert" || echo.table !== "steps") throw new Error("expected a step upsert");
    const entry = stamped(echo.row).work_hours as Record<string, unknown>;
    const reordered = { ...echo.row, provenance: { work_hours: { by: entry.by, at: entry.at, source: entry.source } } } as StepRow;
    let notified = 0;
    editor.subscribe(() => notified++);
    editor.applyRemote({ kind: "upsert", table: "steps", row: reordered });
    expect(notified).toBe(0);

    // Tom enters a new value: it arrives with his provenance.
    const tom = { source: "entered" as const, at: "2026-10-07T09:05:00.000Z", by: "00000000-0000-4000-8000-00000000b0b0" };
    await memory.update("steps", ids.onboard, { work_hours: 4, "provenance.work_hours": entry as never }, { work_hours: 9, "provenance.work_hours": tom });
    for (const c of changes.splice(0)) editor.applyRemote(c);
    const now = step(editor.getState().bundle, ids.onboard);
    expect(now.work_hours).toBe(9);
    expect(stamped(now).work_hours).toEqual(tom);
    // Our next edit compares against his provenance too, so it saves without a conflict.
    editor.run((b) => updateStep(b, ids.onboard, { work_hours: 5 }));
    await editor.settled();
    expect(editor.getState().conflicts).toEqual([]);
    expect(stored(memory, ids.onboard).work_hours).toBe(5);
  });
});

describe("rows from Realtime", () => {
  it("turns Postgres Changes payloads into rows, numbers and all", () => {
    const row = { ...step(northbeamBundle(), ids.audit), work_hours: "6.5", created_at: "2026-10-01", provenance: {} };
    const change = changeFromPayload({ table: "steps", eventType: "UPDATE", new: row, old: {} });
    expect(change).toMatchObject({ kind: "upsert", table: "steps", revisionId: row.revision_id });
    const parsed = (change as { row: StepRow }).row;
    expect(parsed.work_hours).toBe(6.5);
    expect(parsed).not.toHaveProperty("created_at");
    expect(changeFromPayload({ table: "steps", eventType: "DELETE", new: {}, old: { id: ids.audit, revision_id: row.revision_id } })).toEqual({
      kind: "delete",
      table: "steps",
      id: ids.audit,
      revisionId: row.revision_id,
    });
    expect(changeFromPayload({ table: "processes", eventType: "UPDATE", new: {}, old: {} })).toBeNull();
    expect(stepFromRecord({ id: "x" })).toBeNull();
  });
});

const TOM: Viewer = { userId: "u-tom", name: "Tom", email: "tom@example.com" };
const ANA: Viewer = { userId: "u-ana", name: "Ana", email: "ana@example.com" };

/** Two people on the same process, sharing one "database" and one in-memory Realtime. */
function twoEditors() {
  const live = northbeamBundle();
  const realtime = new MemoryRealtime();
  const backend = new MemoryDraftBackend(live, realtime);
  const ana = new DraftSession(live, null, backend);
  const tom = new DraftSession(northbeamBundle(), null, backend);
  const anaSync = new RealtimeSync(ana, realtime, ANA, { key: "ana-tab", noteWaitMs: 0 });
  const tomSync = new RealtimeSync(tom, realtime, TOM, { key: "tom-tab", view: "live", noteWaitMs: 0 });
  anaSync.start();
  tomSync.start();
  /** Let saves, deliveries and catch-ups run until nothing is left. */
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.all([ana.editor.settled(), tom.editor.settled()]);
      realtime.flush();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { live, realtime, backend, ana, tom, anaSync, tomSync, settle };
}

describe("presence and live changes between two editors", () => {
  it("sends the name but never the email, in presence or in notes (B1 2/3)", async () => {
    const { anaSync, tomSync, settle } = twoEditors();
    await settle();
    for (const sync of [anaSync, tomSync]) for (const other of sync.getState().others) expect(other.email).toBeNull();
    expect(JSON.stringify(anaSync.getState())).not.toMatch(/@example\.com/);
    expect(JSON.stringify(tomSync.getState())).not.toMatch(/@example\.com/);
  });
  it("never reads an email out of someone else's presence", () => {
    expect(presentFrom({ a: [{ userId: "u", name: "N", email: "n@example.com", view: "live" }] })[0]!.email).toBeNull();
  });

  it("lists the other people on the process and what they are looking at", async () => {
    const { anaSync, tomSync, settle } = twoEditors();
    await settle();
    expect(anaSync.getState().others).toEqual([expect.objectContaining({ name: "Tom", view: "live", key: "tom-tab" })]);
    expect(tomSync.getState().others).toEqual([expect.objectContaining({ name: "Ana", view: "draft" })]);
    tomSync.setView("draft");
    await settle();
    expect(anaSync.getState().others[0]!.view).toBe("draft");
    tomSync.stop();
    await settle();
    expect(anaSync.getState().others).toEqual([]);
  });

  it("shows one person's saved change to the other, named, without a reload", async () => {
    const { ana, tom, anaSync, settle } = twoEditors();
    await settle();
    tom.editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await settle();
    // Tom's first edit opened the draft; Ana's session follows it.
    expect(ana.getState().draft?.id).toBe(tom.getState().draft?.id);
    expect(ana.getState().notice).toMatch(/^Tom started a draft/);
    expect(step(ana.editor.getState().bundle, ids.audit).work_hours).toBe(4);
    expect(ana.editor.getState().undoLabel).toBeNull();
    tom.editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    await settle();
    expect(step(ana.editor.getState().bundle, ids.audit).name).toBe("Audit");
    expect(anaSync.activityText(anaSync.getState().activity[0]!)).toBe("Tom changed Audit's name to Audit");
    expect(anaSync.who("steps", ids.audit, "work_hours", 4)).toBe("Tom");
  });

  it("merges concurrent edits to different fields, and names the other person in a same-field conflict", async () => {
    const { ana, tom, backend, anaSync, settle } = twoEditors();
    await settle();
    // Both edit before hearing from the other.
    ana.editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    tom.editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    await settle();
    const draft = backend.draftRows()!;
    expect(step(draft, ids.audit)).toMatchObject({ work_hours: 4, name: "Audit" });
    for (const s of [ana, tom]) expect(step(s.editor.getState().bundle, ids.audit)).toMatchObject({ work_hours: 4, name: "Audit" });

    // Same field at once: whoever saves second gets the prompt, naming the other.
    tom.editor.run((b) => updateStep(b, ids.audit, { wait_hours: 8 }));
    ana.editor.run((b) => updateStep(b, ids.audit, { wait_hours: 2 }));
    await settle();
    const [conflict] = ana.editor.getState().conflicts;
    expect(conflict).toMatchObject({ field: "wait_hours", mine: 2, theirs: 8 });
    expect(anaSync.who("steps", ids.audit, "wait_hours", conflict!.theirs)).toBe("Tom");
    await ana.editor.keepMine(conflict!);
    await settle();
    expect(step(backend.draftRows()!, ids.audit).wait_hours).toBe(2);
    expect(step(tom.editor.getState().bundle, ids.audit).wait_hours).toBe(2);
  });

  it("follows a publish or discard by someone else", async () => {
    const { ana, tom, settle } = twoEditors();
    await settle();
    tom.editor.run((b) => updateStep(b, ids.qualify, { work_hours: 3 }));
    await settle();
    ana.editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await settle();
    await tom.publish(true);
    await settle();
    expect(ana.getState().draft).toBeNull();
    expect(ana.getState().live.revision.id).toBe(tom.getState().live.revision.id);
    expect(ana.getState().notice).toMatch(/^Tom published the draft as revision 2/);
    expect(step(ana.editor.getState().bundle, ids.audit).work_hours).toBe(4);
    expect(ana.editor.getState().undoLabel).toBeNull();

    ana.editor.run((b) => updateStep(b, ids.audit, { work_hours: 5 }));
    await settle();
    expect(tom.getState().draft).not.toBeNull();
    await tom.discard();
    await settle();
    expect(ana.getState().draft).toBeNull();
    expect(ana.getState().notice).toMatch(/^Tom discarded the draft/);
    expect(step(ana.editor.getState().bundle, ids.audit).work_hours).toBe(4);
  });

  it("catches up on changes missed while disconnected", async () => {
    const { ana, tom, realtime, settle } = twoEditors();
    await settle();
    tom.editor.run((b) => updateStep(b, ids.audit, { work_hours: 4 }));
    await settle();
    realtime.drop();
    tom.editor.run((b) => updateStep(b, ids.audit, { name: "Offline rename" }));
    await settle();
    expect(step(ana.editor.getState().bundle, ids.audit).name).toBe("Audit & proposal");
    realtime.restore();
    await settle();
    expect(step(ana.editor.getState().bundle, ids.audit).name).toBe("Offline rename");
  });
});

describe("the demo's simulated colleague", () => {
  it("is present, edits through the shared store, and can beat your next save to cause a named conflict", async () => {
    const live = northbeamBundle();
    const realtime = new MemoryRealtime();
    const memory = new MemoryDraftBackend(live, realtime);
    const tom = new DemoColleague(memory, realtime, live.process.id);
    const you = new DraftSession(live, null, tom.wrap(memory));
    const sync = new RealtimeSync(you, realtime, ANA, { noteWaitMs: 0 });
    sync.start();
    tom.join();
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await you.editor.settled();
        realtime.flush();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await settle();
    expect(sync.getState().others.map((p) => p.name)).toEqual([COLLEAGUE.name]);

    expect(await tom.editSomething(ids.qualify)).toMatch(/^Tom set Qualify lead's hands-on time/);
    await settle();
    expect(step(you.editor.getState().bundle, ids.qualify).work_hours).toBe(step(memory.draftRows()!, ids.qualify).work_hours);

    tom.race(true);
    you.editor.run((b) => updateStep(b, ids.audit, { name: "Audit" }));
    await settle();
    const [conflict] = you.editor.getState().conflicts;
    expect(conflict).toMatchObject({ field: "name", mine: "Audit", theirs: "Audit (Tom's version)" });
    expect(sync.who("steps", ids.audit, "name", conflict!.theirs)).toBe("Tom");
    expect(tom.isRacing).toBe(false);
    tom.leave();
    await settle();
    expect(sync.getState().others).toEqual([]);
  });
});

describe("the Supabase adapter", () => {
  function fakeClient() {
    const channels: (RealtimeChannelLike & {
      name: string;
      opts: unknown;
      bindings: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[];
      status?: (s: string) => void;
      tracked: Record<string, unknown>[];
      sent: unknown[];
      state: Record<string, Record<string, unknown>[]>;
      emit(type: string, event: string, payload: unknown): void;
    })[] = [];
    const removed: string[] = [];
    const client: RealtimeClientLike = {
      realtime: { setAuth: async () => undefined },
      channel(name, opts) {
        const ch = {
          name,
          opts,
          bindings: [] as { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[],
          status: undefined as ((s: string) => void) | undefined,
          tracked: [] as Record<string, unknown>[],
          sent: [] as unknown[],
          state: {} as Record<string, Record<string, unknown>[]>,
          on(type: string, filter: Record<string, unknown>, cb: (p: unknown) => void) {
            ch.bindings.push({ type, filter, cb });
            return ch;
          },
          subscribe(cb?: (s: string) => void) {
            ch.status = cb;
            return ch;
          },
          async track(p: Record<string, unknown>) {
            ch.tracked.push(p);
          },
          async send(m: unknown) {
            ch.sent.push(m);
          },
          presenceState: () => ch.state,
          emit(type: string, event: string, payload: unknown) {
            for (const b of ch.bindings) if (b.type === type && (b.filter.event === event || b.filter.event === "*")) b.cb(payload);
          },
        };
        channels.push(ch);
        return ch;
      },
      async removeChannel(ch) {
        removed.push((ch as unknown as { name: string }).name);
      },
    };
    return { client, channels, removed };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("joins the private process channel, re-tracks presence on every join, and passes on notes", async () => {
    const { client, channels, removed } = fakeClient();
    const presence = vi.fn();
    const notes = vi.fn();
    const status = vi.fn();
    const ch = supabaseTransport(client).joinProcess("p1", "tab-1", { presence, note: notes, status });
    ch.track({ ...TOM, view: "draft", since: "2026-10-01T00:00:00Z" });
    await tick();
    const [c] = channels;
    expect(c!.name).toBe("process:p1");
    expect(c!.opts).toEqual({ config: { private: true, presence: { key: "tab-1", enabled: true } } });
    c!.status!("SUBSCRIBED");
    c!.status!("CHANNEL_ERROR");
    c!.status!("SUBSCRIBED");
    expect(c!.tracked).toHaveLength(2);
    expect(status.mock.calls.map((x) => x[0])).toEqual(["connecting", "live", "offline", "live"]);

    c!.state = { "tab-2": [{ ...ANA, view: "live", since: "x", presence_ref: "r" }], junk: [{ name: 3 }] };
    c!.emit("presence", "sync", {});
    expect(presence).toHaveBeenLastCalledWith([{ ...ANA, email: null, key: "tab-2", view: "live", since: "x" }]);

    c!.emit("broadcast", "note", { payload: { kind: "saved", by: ANA, table: "steps", id: "s1", values: { work_hours: 4, bad: {} } } });
    c!.emit("broadcast", "note", { payload: { kind: "saved", by: { name: "no id" }, table: "steps", id: "s1", values: {} } });
    expect(notes).toHaveBeenCalledTimes(1);
    expect(notes).toHaveBeenCalledWith({ kind: "saved", by: { ...ANA, email: null }, table: "steps", id: "s1", values: { work_hours: 4 } });

    ch.send({ kind: "draft", by: TOM, event: "opened", revisionId: "r2" });
    expect(c!.sent).toEqual([{ type: "broadcast", event: "note", payload: { kind: "draft", by: TOM, event: "opened", revisionId: "r2" } }]);
    ch.close();
    expect(removed).toEqual(["process:p1"]);
  });

  it("listens for the revision's rows and the process row, filtering deletes to the revision", () => {
    const { client, channels } = fakeClient();
    const row = vi.fn();
    const process = vi.fn();
    supabaseTransport(client).watchRevision("p1", "rev-1", { row, process, status: () => undefined });
    const [c] = channels;
    expect(c!.bindings.map((b) => b.filter)).toEqual([
      { event: "INSERT", schema: "public", table: "steps", filter: "revision_id=eq.rev-1" },
      { event: "UPDATE", schema: "public", table: "steps", filter: "revision_id=eq.rev-1" },
      { event: "DELETE", schema: "public", table: "steps" },
      { event: "INSERT", schema: "public", table: "edges", filter: "revision_id=eq.rev-1" },
      { event: "UPDATE", schema: "public", table: "edges", filter: "revision_id=eq.rev-1" },
      { event: "DELETE", schema: "public", table: "edges" },
      { event: "UPDATE", schema: "public", table: "processes", filter: "id=eq.p1" },
    ]);
    const deleteOf = (rev: string) => ({ table: "steps", eventType: "DELETE", new: {}, old: { id: "s1", revision_id: rev } });
    c!.bindings[2]!.cb(deleteOf("rev-other"));
    c!.bindings[2]!.cb(deleteOf("rev-1"));
    expect(row).toHaveBeenCalledTimes(1);
    expect(row.mock.calls[0]![0]).toMatchObject({ kind: "delete", table: "steps", id: "s1" });
    c!.bindings[6]!.cb({});
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("parses only well-formed presence and notes", () => {
    expect(presentFrom({ a: [{ userId: "u", name: "N", view: "weird" }] })).toEqual([{ userId: "u", name: "N", email: null, key: "a", view: "draft", since: "" }]);
    expect(parseNote({ kind: "rows", by: TOM, op: "remove", steps: ["a"], edges: [1] })).toBeNull();
    expect(parseNote({ kind: "draft", by: TOM, event: "published", revisionId: "r" })).toMatchObject({ event: "published" });
    expect(parseNote("nope")).toBeNull();
  });
});
