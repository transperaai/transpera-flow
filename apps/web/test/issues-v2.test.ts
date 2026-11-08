import { describe, expect, it } from "vitest";
import { noCost, storedOfRating, type DetectedIssue, type Rating } from "@transpera-flow/engine";
import { isDismissalCurrent, type IssueRow } from "@transpera-flow/db";
import { acknowledgeDraft, acknowledgeInsight, dismissInsight } from "@/lib/insights/actions";
import { buildInsights, type Detection } from "@/lib/insights/insights";
import { draftFromIssue, emptyDraft, hasErrors, toSaveInput, validateDraft, type IssueFormOptions } from "@/lib/issues/draft";
import { issueLabel, mapFeed, registerEntries } from "@/lib/issues/register";
import { MemoryIssueStore } from "@/lib/issues/store";
import type { IssuesState } from "@/lib/issues/use-issues";
import { parseSaveInput } from "@/lib/issues/validate";

// Issues v2 in the app (issue #112, A47): the Acknowledge dialog's draft and validation, what saving it stores, the stable
// "Issue #N", and dismissals that last until the process's next published version.

const uuid = (n: string) => `00000000-0000-4000-8000-${n.charCodeAt(0).toString(16).padStart(12, "0")}`;
const P1 = uuid("p");
const R1 = uuid("1");
const R2 = uuid("2");
const R3 = uuid("3");
const det = (id: string, rating: Rating, extra: Partial<Detection> = {}): Detection => ({
  key: `capacity:role:${id}`,
  type: "capacity",
  rating,
  escalation: { base: rating, raised: [] } as unknown as DetectedIssue["escalation"],
  cost: noCost(""),
  title: `Title ${id}`,
  evidence: `Busy ${id}. Second sentence.`,
  metrics: { utilisation: 0.94 },
  stepId: uuid(id),
  roleId: null,
  personId: null,
  fix: null,
  ...extra,
});

type Done = Promise<IssueRow | null>;
function state(store: MemoryIssueStore, revisions: Record<string, string> = {}): Pick<IssuesState, "promote" | "save" | "redismiss" | "revisionOf"> {
  const done = async (run: () => Promise<{ status: "ok"; issue: IssueRow } | { status: "error"; message: string }>): Done => {
    const r = await run();
    return r.status === "ok" ? r.issue : null;
  };
  return {
    promote: (input) => done(() => store.promote(input)),
    save: (input) => done(() => store.save(input)),
    redismiss: (id, revision) => done(() => store.redismiss(id, revision)),
    revisionOf: (processId) => (processId ? revisions[processId] : undefined),
  };
}
const rowsOf = (store: MemoryIssueStore) => [...(store as unknown as { rows: Map<string, IssueRow> }).rows.values()];

const options: IssueFormOptions = {
  processes: [{ id: P1, name: "Lead to live" }],
  steps: [
    { id: uuid("a"), name: "Check fit", processId: P1, sourceIds: [uuid("s")] },
    { id: uuid("b"), name: "Send proposal", processId: P1, sourceIds: [] },
  ],
  people: [
    { id: uuid("x"), name: "Rosa Diaz" },
    { id: uuid("y"), name: "Priya Shah" },
  ],
  sources: [{ id: uuid("s"), title: "Interview with Maya" }],
};
const ctx = { processId: P1, scenarios: [], options };

describe("the Acknowledge dialog", () => {
  it("opens prefilled from the insight: its title, rating, steps and the sources already citing them", () => {
    const [i] = buildInsights(registerEntries([], [det("a", "risk")]));
    const draft = acknowledgeDraft(i!, ctx);
    expect(draft).toMatchObject({ title: "Title a", rating: "risk", processId: P1, scope: "steps", stepIds: [uuid("a")], sourceIds: [uuid("s")], ownerIds: [] });
    expect(draft.from?.detected_key).toBe("capacity:role:a");
  });

  it("an insight on no step is about the whole process", () => {
    const [i] = buildInsights(registerEntries([], [det("a", "bad", { stepId: null })]));
    expect(acknowledgeDraft(i!, ctx)).toMatchObject({ scope: "process", stepIds: [] });
  });

  it("acknowledging saves what the person put in, linking the insight and the issue", async () => {
    const store = new MemoryIssueStore("w1");
    const d = det("a", "risk");
    const [i] = buildInsights(registerEntries([], [d]));
    const draft = {
      ...acknowledgeDraft(i!, ctx),
      title: "Strategist is too busy to review",
      rating: "bad" as Rating,
      stepIds: [uuid("a"), uuid("b")],
      ownerIds: [uuid("x"), uuid("y")],
      targetMeasure: "Wait at Check fit",
      targetNow: "1.4 days",
      targetGoal: "under 4 hours",
      sourceIds: [uuid("s")],
    };
    const row = await acknowledgeInsight(state(store), i!, ctx, draft);
    expect(row).toMatchObject({
      title: "Strategist is too busy to review",
      severity: storedOfRating("bad"),
      status: "open",
      source: "promoted",
      detected_key: d.key,
      process_id: P1,
      // An issue belongs to its process (QA round 2), and its target moves into what's wrong.
      step_id: null,
      owner_person_id: uuid("x"),
      owner_ids: [uuid("x"), uuid("y")],
      source_ids: [uuid("s")],
      target_measure: null,
      target_now: null,
      target_goal: null,
      number: 1,
    });
    expect(row!.evidence).toMatch(/What good looks like: Wait at Check fit, now 1\.4 days, goal under 4 hours$/);
    expect(row!.links).toEqual([{ process_id: P1, step_id: null }]);
    // The insight now shows as that issue, with its number.
    const [after] = buildInsights(registerEntries([row!], [d]));
    expect(after!.issue?.id).toBe(row!.id);
    expect(issueLabel(after!.issue!)).toBe("Issue #1");
  });

  it("without the dialog, an insight is acknowledged as found (the single function behind it)", async () => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [det("a", "bad")]));
    const row = await acknowledgeInsight(state(store), i!, ctx);
    expect(row).toMatchObject({ title: "Title a", severity: storedOfRating("bad"), process_id: P1, step_id: null, source_ids: [uuid("s")], number: 1 });
  });

  it("a second acknowledge of the same insight is refused, not duplicated", async () => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [det("a", "bad")]));
    expect(await acknowledgeInsight(state(store), i!, ctx)).not.toBeNull();
    expect(await acknowledgeInsight(state(store), i!, ctx)).toBeNull();
    expect(rowsOf(store)).toHaveLength(1);
  });

  it("New issue starts empty and a title and its process are required (no steps, QA round 2)", () => {
    const draft = emptyDraft(P1);
    expect(validateDraft(draft)).toEqual({ title: "Give the issue a title." });
    expect(validateDraft({ ...draft, title: "Slow check" })).toEqual({});
    expect(validateDraft({ ...draft, title: "   " }).title).toBeDefined();
    expect(hasErrors(validateDraft({ ...draft, title: "x", processId: null }))).toBe(true);
    expect(validateDraft({ ...draft, title: "x", processId: null }).process).toBeDefined();
  });

  it("the server refuses what the dialog does: no title, no steps when steps are meant", () => {
    const ok = toSaveInput({ ...emptyDraft(P1), title: "Slow check", stepIds: [uuid("a")] }, options);
    expect(parseSaveInput(ok).ok).toBe(true);
    expect(parseSaveInput({ ...ok, title: "  " })).toMatchObject({ ok: false });
    expect(parseSaveInput({ ...ok, links: [] })).toMatchObject({ ok: false, error: "Pick at least one step, or choose the whole process." });
    expect(parseSaveInput({ ...ok, links: [{ process_id: P1, step_id: null }, { process_id: P1, step_id: uuid("a") }] })).toMatchObject({ ok: false });
    expect(parseSaveInput({ ...ok, severity: "worst" })).toMatchObject({ ok: false });
    expect(parseSaveInput({ ...ok, owner_ids: ["nobody"] })).toMatchObject({ ok: false });
    expect(parseSaveInput({ ...ok, target_goal: "x".repeat(201) })).toMatchObject({ ok: false });
  });

  it("New issue links its process only; a step it came from names the process, not the step (QA round 2)", () => {
    const whole = toSaveInput({ ...emptyDraft(P1), title: "T", scope: "process" }, options);
    expect(whole.links).toEqual([{ process_id: P1, step_id: null }]);
    const picked = toSaveInput({ ...emptyDraft(P1), title: "T", stepIds: [uuid("b")] }, options);
    expect(picked.links).toEqual([{ process_id: P1, step_id: null }]);
    expect(picked.severity).toBe("serious");
  });

  it("a target in the old fields moves into what's wrong, once", () => {
    const d = { ...emptyDraft(P1), title: "T", evidence: "Leads wait.", targetMeasure: "Wait", targetNow: "1 d", targetGoal: "4 h" };
    const input = toSaveInput(d, options);
    expect(input).toMatchObject({ target_measure: null, target_now: null, target_goal: null, evidence: "Leads wait.\n\nWhat good looks like: Wait, now 1 d, goal 4 h" });
    expect(toSaveInput({ ...d, evidence: input.evidence }, options).evidence).toBe(input.evidence);
  });

  it("Edit reopens the dialog on the issue and saves over it, keeping its number and status", async () => {
    const store = new MemoryIssueStore("w1");
    const created = await store.save(toSaveInput({ ...emptyDraft(P1), title: "Slow check", stepIds: [uuid("a")], ownerIds: [uuid("x")] }, options));
    if (created.status !== "ok") throw new Error("setup");
    const draft = draftFromIssue(created.issue);
    expect(draft).toMatchObject({ id: created.issue.id, title: "Slow check", scope: "process", stepIds: [], ownerIds: [uuid("x")], rating: "bad" });
    const edited = await store.save(toSaveInput({ ...draft, title: "Slow check, renamed", ownerIds: [uuid("x"), uuid("y")], targetGoal: "under 4 hours" }, options));
    if (edited.status !== "ok") throw new Error("edit");
    expect(edited.issue).toMatchObject({ id: created.issue.id, number: created.issue.number, status: "open", title: "Slow check, renamed", step_id: null, process_id: P1, owner_ids: [uuid("x"), uuid("y")], target_goal: null, evidence: "What good looks like: goal under 4 hours" });
    expect(edited.issue.links).toEqual([{ process_id: P1, step_id: null }]);
    expect(rowsOf(store)).toHaveLength(1);
  });

  it("numbers count up and are not reused, and a dismissed insight takes none", async () => {
    const store = new MemoryIssueStore("w1");
    const mk = (title: string) => store.save(toSaveInput({ ...emptyDraft(P1), title, scope: "process" }, options));
    const [a, b] = [await mk("one"), await mk("two")];
    expect([a, b].map((r) => (r.status === "ok" ? r.issue.number : null))).toEqual([1, 2]);
    const [i] = buildInsights(registerEntries([], [det("a", "bad")]));
    await dismissInsight(state(store, { [P1]: R1 }), i!, ctx);
    const dismissed = rowsOf(store).find((r) => r.status === "dismissed")!;
    expect(dismissed.number).toBeNull();
    await store.remove(rowsOf(store).find((r) => r.title === "two")!.id);
    const c = await mk("three");
    expect(c.status === "ok" ? c.issue.number : null).toBe(3);
  });
});

describe("a dismissal lasts until the process's next published version", () => {
  const d = det("a", "bad");
  const dismissedAgainst = async (revision: string) => {
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [d]));
    expect(await dismissInsight(state(store, { [P1]: revision }), i!, ctx)).toBe(true);
    return store;
  };
  const at = (revision: string) => (processId: string | null | undefined) => (processId === P1 ? revision : undefined);

  it("stores the live revision it was dismissed against", async () => {
    const store = await dismissedAgainst(R1);
    expect(rowsOf(store)).toHaveLength(1);
    expect(rowsOf(store)[0]).toMatchObject({ status: "dismissed", dismissed_revision_id: R1, detected_key: d.key });
  });

  it("dismissed, same version: hidden from the insights, the register and the map", async () => {
    const rows = rowsOf(await dismissedAgainst(R1));
    expect(buildInsights(registerEntries(rows, [d], at(R1)))).toEqual([]);
    expect(registerEntries(rows, [d], at(R1))).toEqual([]);
    expect(registerEntries(rows, [], at(R1))).toEqual([]);
    expect(mapFeed(registerEntries(rows, [d], at(R1)))).toEqual({ badges: {}, ratings: {} });
  });

  it("a new version is published and the analysis still finds it: it is listed again, as an insight, not as an issue", async () => {
    const rows = rowsOf(await dismissedAgainst(R1));
    const entries = registerEntries(rows, [d], at(R2));
    const list = buildInsights(entries);
    expect(list).toHaveLength(1);
    expect(list[0]!.issue).toBeNull();
    expect(list[0]!.dismissed?.id).toBe(rows[0]!.id);
    // Still not an issue: nothing on the map.
    expect(mapFeed(entries)).toEqual({ badges: {}, ratings: {} });
  });

  it("a new version is published but the analysis no longer finds it: nothing is listed", async () => {
    const rows = rowsOf(await dismissedAgainst(R1));
    expect(registerEntries(rows, [], at(R2))).toEqual([]);
  });

  it("dismissing it again works, and lasts until the version after", async () => {
    const store = await dismissedAgainst(R1);
    const [again] = buildInsights(registerEntries(rowsOf(store), [d], at(R2)));
    expect(await dismissInsight(state(store, { [P1]: R2 }), again!, ctx)).toBe(true);
    // Reused the row: still one, now against the newer version.
    expect(rowsOf(store)).toHaveLength(1);
    expect(rowsOf(store)[0]).toMatchObject({ status: "dismissed", dismissed_revision_id: R2 });
    expect(buildInsights(registerEntries(rowsOf(store), [d], at(R2)))).toEqual([]);
    expect(buildInsights(registerEntries(rowsOf(store), [d], at(R3)))).toHaveLength(1);
  });

  it("acknowledging it after it comes back turns the dismissed row into the issue", async () => {
    const store = await dismissedAgainst(R1);
    const [again] = buildInsights(registerEntries(rowsOf(store), [d], at(R2)));
    const row = await acknowledgeInsight(state(store, { [P1]: R2 }), again!, ctx);
    expect(rowsOf(store)).toHaveLength(1);
    expect(row).toMatchObject({ id: rowsOf(store)[0]!.id, status: "open", dismissed_revision_id: null, number: 1, detected_key: d.key });
    const entries = registerEntries([row!], [d], at(R2));
    expect(entries.map((e) => e.kind)).toEqual(["tracked"]);
    // An issue of the process: no badge on the step it was found at (QA round 2).
    expect(mapFeed(entries).badges).toEqual({});
  });

  it("a dismissal made before the process was ever published expires on its first publish", async () => {
    // No live revision at the time: it is stored as "before any version".
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [d]));
    expect(await dismissInsight(state(store, {}), i!, ctx)).toBe(true);
    const rows = rowsOf(store);
    expect(rows[0]).toMatchObject({ status: "dismissed", dismissed_revision_id: null });
    // Still never published (or the page doesn't know): hidden.
    expect(buildInsights(registerEntries(rows, [d]))).toEqual([]);
    expect(buildInsights(registerEntries(rows, [d], () => undefined))).toEqual([]);
    // The first version is published: it comes back.
    expect(buildInsights(registerEntries(rows, [d], at(R1)))).toHaveLength(1);
  });

  it("is measured against the step's own process, not the page's", async () => {
    const P2 = uuid("q");
    const nested = {
      ...ctx,
      options: { ...options, steps: [{ id: uuid("a"), name: "Check fit", processId: P2, sourceIds: [] as string[] }, ...options.steps.slice(1)] },
    };
    const store = new MemoryIssueStore("w1");
    const [i] = buildInsights(registerEntries([], [d]));
    // The page is P1 (at R1), but the insight is on a step of P2 (at R2).
    expect(await dismissInsight(state(store, { [P1]: R1, [P2]: R2 }), i!, nested)).toBe(true);
    const rows = rowsOf(store);
    expect(rows[0]).toMatchObject({ dismissed_revision_id: R2, process_id: P2 });
    const live = (p1: string, p2: string) => (processId: string | null | undefined) => (processId === P1 ? p1 : processId === P2 ? p2 : undefined);
    // The page's process is published again: the insight's own process hasn't changed, so it stays hidden.
    expect(buildInsights(registerEntries(rows, [d], live(R3, R2)))).toEqual([]);
    // Its own process is published again: it comes back.
    expect(buildInsights(registerEntries(rows, [d], live(R1, R3)))).toHaveLength(1);
  });

  it("isDismissalCurrent: current only for a dismissed row on the same live revision", () => {
    const row = rowsOfDismissed();
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: R1 }, R1)).toBe(true);
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: R1 }, R2)).toBe(false);
    expect(isDismissalCurrent({ ...row, status: "open", dismissed_revision_id: R1 }, R1)).toBe(false);
    // The process's revision isn't known (never published, or not loaded): it can't have changed.
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: R1 }, undefined)).toBe(true);
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: R1 }, null)).toBe(true);
    // Dismissed before any version: held until there is one, then over.
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: null }, undefined)).toBe(true);
    expect(isDismissalCurrent({ ...row, dismissed_revision_id: null }, R1)).toBe(false);
  });

  it("without revisions to compare, a dismissal holds (a page that doesn't know its versions never lists it again)", async () => {
    const rows = rowsOf(await dismissedAgainst(R1));
    expect(buildInsights(registerEntries(rows, [d]))).toEqual([]);
  });

  function rowsOfDismissed(): IssueRow {
    const store = new MemoryIssueStore("w1");
    void store;
    return {
      id: uuid("d"),
      workspace_id: "w1",
      process_id: P1,
      step_id: uuid("a"),
      role_id: null,
      person_id: null,
      client_id: null,
      type: "capacity",
      severity: "serious",
      title: "Title a",
      evidence: null,
      evidence_metrics: {},
      owner_person_id: null,
      status: "dismissed",
      scenario_id: null,
      source: "promoted",
      detected_key: d.key,
      resolved_at: "2026-10-01T00:00:00Z",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      resolved_how: null,
      resolved_solution_id: null,
      resolution_note: null,
      number: null,
      dismissed_revision_id: R1,
      target_measure: null,
      target_now: null,
      target_goal: null,
      links: [{ process_id: P1, step_id: uuid("a") }],
      owner_ids: [],
      source_ids: [],
    };
  }
});
