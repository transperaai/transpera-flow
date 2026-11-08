import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  northbeamBundle,
  northbeamIssues,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamScenarios,
  northbeamSourceIds,
  northbeamStepIds,
  toEngineModel,
} from "@transpera-flow/db";
import { absenceTest, detectIssues, simulate, storedOfRating, type DetectedIssue } from "@transpera-flow/engine";
import {
  NO_FILTERS,
  entryView,
  filterEntries,
  fixFor,
  formatIssueCost,
  matchingScenario,
  promoteInput,
  registerEntries,
  stepBadges,
} from "@/lib/issues/register";
import { ALREADY_TRACKED, MemoryIssueStore } from "@/lib/issues/store";
import { cleanFieldValue, parseIssueInput, parsePromoteInput, type IssueInput } from "@/lib/issues/validate";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// The issue Server Actions run against a real database (the seeded Northbeam workspace) as an editor, so what they write is
// read back from the tables.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { createIssue, deleteIssue, promoteIssue, redismissIssue, saveIssueField, saveIssueFromDialog } = await import("@/app/w/[slug]/issue-actions");

const START = { startDate: "2026-10-05" };
const WS = northbeamBundle().workspace.id;
const audit = northbeamStepIds.audit;
const kickoff = northbeamStepIds.kickoff;
const scenarios = northbeamScenarios();

/**
 * Northbeam's detections, as the demo computes them, from its pooled client
 * load: the seeded roster (issue #18) adds overload findings about Nina
 * Kowalski, which the engine's tests cover. These tests are about the register,
 * so they use the single-point-of-failure detections the seeded issues track;
 * the rating rules' own findings (strategist, rework, waits) are tested in the engine.
 */
function northbeamDetections(): DetectedIssue[] {
  const b = northbeamBundle();
  const model = toEngineModel({ ...b, clients: [], clientServices: [], clientAssignments: [], clientGroups: [] }, START);
  return detectIssues(model, simulate(model, 30, 1), {}, { absence: absenceTest(model) }).filter((d) => d.key.startsWith("spof:"));
}

const manual: IssueInput = {
  title: "  Reports copied by hand ",
  type: "manual",
  severity: "serious",
  status: "open",
  evidence: "  ",
  process_id: NORTHBEAM_PROCESS_ID,
  step_id: audit,
  role_id: null,
  person_id: null,
  owner_person_id: northbeamPersonIds["Rosa Diaz"]!,
  scenario_id: null,
};

describe("the register merges tracked issues with this run's detections", () => {
  const detected = northbeamDetections();
  const entries = registerEntries(northbeamIssues(), detected);

  it("shows a promoted detection once, as tracked, and keeps the rest as detected", () => {
    expect(detected.map((d) => d.key)).toEqual([`spof:step:${audit}`, `spof:step:${kickoff}`]);
    // The absence test rates the person, so both of Maya's steps are Operational risk, and the detection sorts above the tracked issues.
    expect(entries.map((e) => [e.kind, entryView(e).title])).toEqual([
      ["detected", "Only Maya Collins can do Kickoff & strategy"],
      // The same rating, so the one with a cost (the absence test's damage) comes before the one with none.
      ["tracked", "Only Maya Collins can do Audit & proposal"],
      ["tracked", "Every proposal is built by hand"],
      ["tracked", "Lead scoring could skip unqualified discovery calls"],
    ]);
    const promoted = entries[1]!;
    expect(promoted.kind === "tracked" && promoted.detection?.key).toBe(`spof:step:${audit}`);
  });

  it("isn't duplicated on the next run: the same model gives the same register", () => {
    const again = registerEntries(northbeamIssues(), northbeamDetections());
    expect(again.map((e) => entryView(e).id)).toEqual(entries.map((e) => entryView(e).id));
  });

  it("keeps a resolved issue closed when its detection fires again (D38), and a dismissed one is never an issue", () => {
    const [, promoted] = northbeamIssues();
    const done = registerEntries([{ ...promoted!, status: "resolved" }], detected);
    expect(entryView(done.find((e) => e.kind === "tracked")!).open).toBe(false);
    const dismissed = registerEntries([{ ...promoted!, status: "dismissed" }], detected);
    // A dismissed insight is not an issue: it is not listed, and its detection isn't listed again either.
    expect(dismissed.some((e) => e.kind === "tracked")).toBe(false);
    expect(dismissed.some((e) => entryView(e).id === promoted!.detected_key)).toBe(false);
    // A resolved one still sorts after the open ones.
    const resolved = registerEntries([{ ...promoted!, status: "resolved" }], []);
    expect(resolved.at(-1)!.kind).toBe("tracked");
  });

  it("filters by process, person, rating, source, status and step", () => {
    const titles = (f: Partial<typeof NO_FILTERS>) => filterEntries(entries, { ...NO_FILTERS, ...f }, NORTHBEAM_PROCESS_ID).map((e) => entryView(e).title);
    expect(titles({})).toHaveLength(4);
    expect(titles({ process: "c0000000-0000-4000-8000-00000000ffff" })).toEqual([]);
    expect(titles({ process: NORTHBEAM_PROCESS_ID })).toHaveLength(4);
    // About Maya, or owned by her: both spof issues name her.
    expect(titles({ person: northbeamPersonIds["Maya Collins"]! })).toEqual([
      "Only Maya Collins can do Kickoff & strategy",
      "Only Maya Collins can do Audit & proposal",
    ]);
    // Rosa owns the two audit issues.
    expect(titles({ person: northbeamPersonIds["Rosa Diaz"]! })).toHaveLength(2);
    expect(titles({ rating: "great" })).toEqual(["Lead scoring could skip unqualified discovery calls"]);
    expect(titles({ source: "detected" })).toEqual(["Only Maya Collins can do Kickoff & strategy"]);
    expect(titles({ source: "promoted" })).toEqual(["Only Maya Collins can do Audit & proposal"]);
    expect(titles({ source: "manual" })).toHaveLength(2);
    expect(titles({ status: "testing" })).toEqual(["Only Maya Collins can do Audit & proposal"]);
    expect(titles({ step: audit })).toHaveLength(2);
  });

  it("puts a badge on each step with open issues, coloured by the most severe", () => {
    const badges = stepBadges(entries);
    expect(Object.keys(badges).sort()).toEqual([northbeamStepIds.qualify, audit, kickoff].sort());
    expect(badges[audit]).toMatchObject({ count: 2, rating: "bad" });
    expect(badges[northbeamStepIds.qualify]).toMatchObject({ count: 1, rating: "great" });
  });
});

describe("cost per month (issue #108)", () => {
  const cheap: DetectedIssue = { ...northbeamDetections()[0]!, rating: "bad", key: "wait:step:cheap", cost: { perMonth: 800, hoursPerMonth: null, method: "x" } };
  const dear: DetectedIssue = { ...cheap, key: "wait:step:dear", cost: { perMonth: 9000, hoursPerMonth: null, method: "y" } };
  const timeOnly: DetectedIssue = { ...cheap, key: "wait:step:time", cost: { perMonth: null, hoursPerMonth: 12, method: "z" } };
  const none: DetectedIssue = { ...cheap, key: "wait:step:none", cost: { perMonth: null, hoursPerMonth: null, method: "n" } };
  const worse: DetectedIssue = { ...cheap, key: "wait:step:worse", rating: "risk", cost: { perMonth: 5, hoursPerMonth: null, method: "w" } };

  it("lists open issues by rating, then cost, highest first", () => {
    const entries = registerEntries([], [none, cheap, timeOnly, dear, worse]);
    expect(entries.map((e) => entryView(e).id)).toEqual(["wait:step:worse", "wait:step:dear", "wait:step:cheap", "wait:step:time", "wait:step:none"]);
  });

  it("prints costs in the workspace currency, labelled as estimates; no money method shows time or n/a", () => {
    expect(formatIssueCost(dear.cost, "AUD")).toBe("About A$9,000 a month (estimate)");
    expect(formatIssueCost(dear.cost, "GBP")).toBe("About £9,000 a month (estimate)");
    expect(formatIssueCost(timeOnly.cost, "AUD")).toBe("About 12 h a month (estimate, time only)");
    expect(formatIssueCost(none.cost, "AUD")).toBe("Cost per month: n/a");
    expect(formatIssueCost(null, "AUD")).toBe("Cost per month: n/a");
    // A cost that needs people's pay, hidden from this viewer: a dash (the screens add the (i)), never 0 or a role's rate.
    expect(formatIssueCost({ perMonth: null, hoursPerMonth: null, method: "", payHidden: true }, "AUD")).toBe("—");
  });

  it("costs a tracked issue by what the latest run detects for it", () => {
    const [, promoted] = northbeamIssues();
    const key = promoted!.detected_key!;
    const entries = registerEntries([promoted!], [{ ...dear, key }]);
    expect(entryView(entries[0]!).cost).toEqual(dear.cost);
    expect(entryView(registerEntries([promoted!], [])[0]!).cost).toBeNull();
  });
});

describe("run the fix", () => {
  const entries = registerEntries(northbeamIssues(), northbeamDetections());
  const byTitle = (t: string) => entries.find((e) => entryView(e).title.startsWith(t))!;

  it("uses the tracked issue's saved scenario", () => {
    expect(fixFor(byTitle("Every proposal"), scenarios)).toEqual({ name: "Automate proposals", scenarioId: scenarios[1]!.id, patch: scenarios[1]!.patch });
  });

  it("maps a detection's suggested fix to the saved scenario that makes the same change", () => {
    // Hire another Strategist is exactly "Hire a strategist".
    expect(fixFor(byTitle("Only Maya Collins can do Kickoff"), scenarios)).toMatchObject({ name: "Hire a strategist", scenarioId: scenarios[0]!.id });
    expect(matchingScenario([{ path: `roles.${northbeamRoleIds.strat}.headcount`, op: "add", value: 2 }], scenarios)).toBeNull();
  });

  it("falls back to the suggestion when no saved scenario matches, and to nothing when there is none", () => {
    expect(fixFor(byTitle("Only Maya Collins can do Kickoff"), [])).toMatchObject({ name: "Hire another Strategist", scenarioId: null });
    expect(fixFor(byTitle("Lead scoring"), scenarios)).toBeNull();
  });
});

describe("promoting a detection", () => {
  const kickoffSpof = northbeamDetections().find((d) => d.key === `spof:step:${kickoff}`)!;

  it("stores its fields and key, links the matching saved scenario, and starts open", async () => {
    const input = promoteInput(kickoffSpof, NORTHBEAM_PROCESS_ID, scenarios);
    // The rating is stored as the database's value for it (good = warning, bad = serious, risk = critical, great = info).
    expect(input.severity).toBe(storedOfRating(kickoffSpof.rating));
    expect(input).toMatchObject({ detected_key: kickoffSpof.key, step_id: kickoff, role_id: northbeamRoleIds.strat, scenario_id: scenarios[0]!.id });
    const store = new MemoryIssueStore(WS, northbeamIssues());
    const r = await store.promote(input);
    expect(r).toMatchObject({ status: "ok", issue: { source: "promoted", status: "open", detected_key: kickoffSpof.key, evidence_metrics: kickoffSpof.metrics } });
    // The next run lists it once, as tracked.
    const tracked = r.status === "ok" ? [...northbeamIssues(), r.issue] : [];
    const entries = registerEntries(tracked, northbeamDetections());
    expect(entries.filter((e) => entryView(e).title === kickoffSpof.title).map((e) => e.kind)).toEqual(["tracked"]);
    expect(entries.some((e) => e.kind === "detected")).toBe(false);
  });

  it("refuses to track the same detection twice", async () => {
    const store = new MemoryIssueStore(WS, northbeamIssues());
    const input = promoteInput(kickoffSpof, NORTHBEAM_PROCESS_ID, scenarios);
    expect((await store.promote(input)).status).toBe("ok");
    expect(await store.promote(input)).toEqual({ status: "error", message: ALREADY_TRACKED });
  });
});

describe("validation", () => {
  it("trims the title and blanks empty evidence", () => {
    expect(parseIssueInput(manual)).toEqual({ ok: true, value: { ...manual, title: "Reports copied by hand", evidence: null } });
  });

  it.each([
    [{ title: " " }, "Give the issue a title of up to 200 characters."],
    [{ title: "x".repeat(201) }, "Give the issue a title of up to 200 characters."],
    [{ type: "gremlins" }, "Pick a type."],
    [{ severity: "urgent" }, "Pick a rating."],
    [{ status: "closed" }, "Pick a status."],
    [{ evidence: "x".repeat(5001) }, "Keep the evidence to 5000 characters."],
    [{ step_id: "not-a-uuid" }, "That issue links to something that isn't valid."],
  ])("rejects %j", (fields, error) => {
    expect(parseIssueInput({ ...manual, ...fields })).toEqual({ ok: false, error });
  });

  it("checks a promoted detection's key and metrics", () => {
    const d = northbeamDetections()[0]!;
    const input = promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios);
    expect(parsePromoteInput(input).ok).toBe(true);
    expect(parsePromoteInput({ ...input, detected_key: "not a key" }).ok).toBe(false);
    expect(parsePromoteInput({ ...input, evidence_metrics: { a: "1" } }).ok).toBe(false);
    expect(parsePromoteInput({ ...input, evidence_metrics: { a: Infinity } }).ok).toBe(false);
  });

  it("cleans one field's new value, or refuses it", () => {
    expect(cleanFieldValue("title", "  New title ")).toEqual({ value: "New title" });
    expect(cleanFieldValue("title", " ")).toBeNull();
    expect(cleanFieldValue("evidence", "  ")).toEqual({ value: null });
    expect(cleanFieldValue("status", "resolved")).toEqual({ value: "resolved" });
    expect(cleanFieldValue("status", "closed")).toBeNull();
  });
});

describe("the demo store", () => {
  it("logs, edits with a same-field conflict check, closes and deletes", async () => {
    const store = new MemoryIssueStore(WS, [], () => "2026-10-01T00:00:00Z");
    const r = await store.create(manual);
    if (r.status !== "ok") throw new Error(r.message);
    expect(r.issue).toMatchObject({ source: "manual", detected_key: null, title: "Reports copied by hand", resolved_at: null });
    const id = r.issue.id;
    expect(await store.saveField(id, "status", "open", "resolved")).toEqual({ status: "saved", value: "resolved" });
    expect(await store.saveField(id, "status", "open", "wont_fix")).toEqual({ status: "conflict", theirs: "resolved" });
    expect(await store.saveField(id, "severity", "serious", "critical")).toEqual({ status: "saved", value: "critical" });
    expect(await store.saveField(id, "title", "Reports copied by hand", "")).toMatchObject({ status: "error" });
    expect(await store.remove(id)).toEqual({ status: "ok" });
    expect(await store.saveField(id, "title", "x", "y")).toEqual({ status: "not_found" });
  });
});

describe("issue Server Actions", () => {
  let tdb: TestDb;
  let editor: TestUser;
  let viewer: TestUser;
  const q = (sql: string, params: unknown[] = []) => tdb.client.query(sql, params);
  const issueCount = async () => Number((await q("select count(*) from issues where workspace_id = $1", [WS])).rows[0].count);
  const issueRow = async (id: string) => (await q("select * from issues where id = $1", [id])).rows[0];
  const byKey = async (key: string) => (await q("select * from issues where workspace_id = $1 and detected_key = $2", [WS, key])).rows;
  const linksOf = async (id: string) => (await q("select process_id, step_id from issue_links where issue_id = $1 order by step_id", [id])).rows;
  const ownersOf = async (id: string) => (await q("select person_id from issue_owners where issue_id = $1", [id])).rows.map((r) => r.person_id);

  beforeAll(async () => {
    tdb = await createTestDb();
    editor = await addMember(tdb, WS, "editor");
    viewer = await addMember(tdb, WS, "viewer");
  }, 120_000);
  afterAll(async () => {
    await tdb?.close();
  });
  beforeEach(() => {
    signInAs({ tdb }, editor);
  });

  it("reject malformed input before touching the database", async () => {
    const before = await issueCount();
    const seededTitle = (await issueRow(northbeamIssues()[0]!.id)).title;
    expect(await createIssue("not-a-uuid", manual)).toMatchObject({ status: "error" });
    expect(await createIssue(WS, { ...manual, title: "" })).toMatchObject({ status: "error" });
    expect(await createIssue(WS, { ...manual, type: "gremlins" })).toEqual({ status: "error", message: "Pick a type." });
    expect(await promoteIssue(WS, { ...manual, detected_key: "nope" })).toMatchObject({ status: "error" });
    expect(await saveIssueField("x", "title", "a", "b")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "source", "manual", "promoted")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "detected_key", null, "a:b:c")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "status", "open", "closed")).toMatchObject({ status: "error" });
    expect(await deleteIssue("x")).toMatchObject({ status: "error" });
    expect(await issueCount()).toBe(before);
    expect((await issueRow(northbeamIssues()[0]!.id)).title).toBe(seededTitle);
  });

  it("refuse a signed-out user", async () => {
    const before = await issueCount();
    signOut({ tdb });
    expect(await createIssue(WS, manual)).toEqual({ status: "error", message: "Your session has ended. Sign in again." });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "status", "open", "resolved")).toEqual({
      status: "error",
      message: "Your session has ended. Sign in again.",
    });
    expect(await issueCount()).toBe(before);
  });

  it("save a manual issue into the given workspace through save_issue, with the parsed fields only", async () => {
    const r = await createIssue(WS, { ...manual, workspace_id: "someone-elses", source: "promoted", detected_key: "a:b:c" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const row = await issueRow(r.issue.id);
    expect(row).toMatchObject({ workspace_id: WS, source: "manual", title: "Reports copied by hand", evidence: null, detected_key: null });
    expect(await linksOf(r.issue.id)).toEqual([{ process_id: NORTHBEAM_PROCESS_ID, step_id: audit }]);
    expect(await ownersOf(r.issue.id)).toEqual([northbeamPersonIds["Rosa Diaz"]]);
    expect(r.issue).toMatchObject({ id: r.issue.id, title: "Reports copied by hand", links: [{ process_id: NORTHBEAM_PROCESS_ID, step_id: audit }], owner_ids: [northbeamPersonIds["Rosa Diaz"]], source_ids: [] });
  });

  /** A detection not yet tracked in the seeded workspace: its issue, if the seed has one, is removed first. */
  const untracked = async (index: number) => {
    const d = northbeamDetections()[index]!;
    await q("delete from issues where workspace_id = $1 and detected_key = $2", [WS, d.key]);
    return d;
  };

  it("promote with source 'promoted', status open and the detection's key", async () => {
    const d = await untracked(1);
    const r = await promoteIssue(WS, promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios));
    expect(r.status).toBe("ok");
    const [row] = await byKey(d.key);
    expect(row).toMatchObject({ source: "promoted", status: "open", detected_key: d.key });
    // What it touches goes in the link table, with the process it was found on.
    expect(await linksOf(row.id)).toEqual([{ process_id: NORTHBEAM_PROCESS_ID, step_id: d.stepId }]);
  });
  const OLD_SENTENCE =
    "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap, costing about £1,040 at cost rates over the 26-week run. The cap is used up.";
  const NEW_SENTENCE = "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap. The cap is used up.";
  it("promote strips the overtime money an old browser tab still sends (B1 2b)", async () => {
    const d = await untracked(1);
    await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), evidence: OLD_SENTENCE, evidence_metrics: { overtime_hours_week: 4, overtime_cost: 1040 } });
    const [row] = await byKey(d.key);
    expect(row.evidence).toBe(NEW_SENTENCE);
    expect(row.evidence_metrics).toEqual({ overtime_hours_week: 4 });
  });
  it("the Acknowledge dialog strips it too, for a new issue and for an edit", async () => {
    const d = await untracked(1);
    await saveIssueFromDialog(WS, dialog({ evidence: OLD_SENTENCE, from: { detected_key: d.key, evidence: OLD_SENTENCE, evidence_metrics: { overtime_cost: 1040, a: 1 }, role_id: null, person_id: null, client_id: null, scenario_id: null } }));
    const [row] = await byKey(d.key);
    expect(row.evidence).not.toMatch(/costing/);
    expect(row.evidence_metrics).toEqual({ a: 1 });
    await saveIssueFromDialog(WS, dialog({ id: row.id, evidence: OLD_SENTENCE }));
    expect((await issueRow(row.id)).evidence).toBe(NEW_SENTENCE);
  });
  it("promote can store a dismissed insight in one write, with the revision it was dismissed against, and refuses any other status", async () => {
    const d = await untracked(1);
    await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), status: "dismissed", dismissed_revision_id: NORTHBEAM_REVISION_ID });
    const [row] = await byKey(d.key);
    expect(row).toMatchObject({ source: "promoted", status: "dismissed", detected_key: d.key, dismissed_revision_id: NORTHBEAM_REVISION_ID });
    await q("delete from issues where id = $1", [row.id]);
    const r = await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), status: "resolved" });
    expect(r.status).toBe("error");
    expect(await byKey(d.key)).toEqual([]);
  });
  it("say so when a detection is already tracked (unique key)", async () => {
    const d = await untracked(0);
    expect((await promoteIssue(WS, promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios))).status).toBe("ok");
    expect(await promoteIssue(WS, promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios))).toEqual({ status: "error", message: ALREADY_TRACKED });
    expect(await byKey(d.key)).toHaveLength(1);
  });
  it("save one field through save_fields with its base", async () => {
    const id = northbeamIssues()[0]!.id;
    const old = (await issueRow(id)).title as string;
    expect(await saveIssueField(id, "title", old, "New")).toEqual({ status: "saved", value: "New" });
    expect((await issueRow(id)).title).toBe("New");
    // A stale base is a conflict, and changes nothing.
    expect(await saveIssueField(id, "title", old, "Newer")).toEqual({ status: "conflict", theirs: "New" });
    expect((await issueRow(id)).title).toBe("New");
  });

  it("save a status as the older spelling plus a resolution, each checked against what the person saw", async () => {
    const id = northbeamIssues()[0]!.id;
    await q("update issues set status = 'open', resolution = null where id = $1", [id]);
    const stored = async () => {
      const row = await issueRow(id);
      return { status: row.status, resolution: row.resolution };
    };
    expect(await saveIssueField(id, "status", "open", "testing")).toEqual({ status: "saved", value: "testing" });
    expect(await stored()).toEqual({ status: "in_progress", resolution: null });
    expect((await saveIssueField(id, "status", "testing", "resolved")).status).toBe("saved");
    expect(await stored()).toEqual({ status: "done", resolution: null });
    expect((await saveIssueField(id, "status", "resolved", "wont_fix")).status).toBe("saved");
    expect(await stored()).toEqual({ status: "done", resolution: "wont_fix" });
    expect((await saveIssueField(id, "status", "wont_fix", "open")).status).toBe("saved");
    expect(await stored()).toEqual({ status: "open", resolution: null });
    // Someone else moved it on: what they stored is shown as the status it stands for.
    await q("update issues set status = 'done', resolution = 'wont_fix' where id = $1", [id]);
    expect(await saveIssueField(id, "status", "open", "testing")).toEqual({ status: "conflict", theirs: "wont_fix" });
    expect(await stored()).toEqual({ status: "done", resolution: "wont_fix" });
    // "dismissed" is never offered, and never saved through here.
    expect(await saveIssueField(id, "status", "open", "dismissed")).toMatchObject({ status: "error" });
  });

  const dialog = (extra: Record<string, unknown> = {}) => ({
    title: "Slow check",
    severity: "serious",
    evidence: null,
    target_measure: "Wait at Check fit",
    target_now: "1.4 days",
    target_goal: "under 4 hours",
    links: [{ process_id: NORTHBEAM_PROCESS_ID, step_id: audit }, { process_id: NORTHBEAM_PROCESS_ID, step_id: kickoff }],
    owner_ids: [northbeamPersonIds["Rosa Diaz"]!],
    source_ids: [],
    ...extra,
  });

  it("the Acknowledge dialog creates an issue with its steps, owners and target in one save_issue call", async () => {
    const d = await untracked(1);
    const r = await saveIssueFromDialog(WS, dialog({ from: { detected_key: d.key, evidence_metrics: { a: 1 }, role_id: null, person_id: null, client_id: null, scenario_id: null } }));
    expect(r.status).toBe("ok");
    const [row] = await byKey(d.key);
    expect(row).toMatchObject({ title: "Slow check", severity: "serious", source: "promoted", detected_key: d.key, type: "manual", target_goal: "under 4 hours" });
    expect(await linksOf(row.id)).toHaveLength(2);
    expect(await ownersOf(row.id)).toEqual([northbeamPersonIds["Rosa Diaz"]]);
    expect((await q("select source_id from issue_sources where issue_id = $1", [row.id])).rows).toEqual([]);
    // One save, one history entry.
    expect((await q("select count(*) from issue_events where issue_id = $1", [row.id])).rows[0].count).toBe("1");
  });

  it("the dialog's edit sends the issue id and only the fields a person can change", async () => {
    const id = northbeamIssues()[0]!.id;
    await q("update issues set status = 'open', resolution = null where id = $1", [id]);
    const before = await issueRow(id);
    await saveIssueFromDialog(WS, dialog({ id, status: "testing" }));
    const row = await issueRow(id);
    expect(row).toMatchObject({ title: "Slow check", status: "in_progress" });
    expect(row.source).toBe(before.source);
    expect(row.type).toBe(before.type);
  });

  describe("sources on an issue's list (A53)", () => {
    const [S1, S2] = [northbeamSourceIds.strategyInterview, northbeamSourceIds.salesNotes];
    let S3: string;
    let S4: string;
    let issueId: string;
    const sourceLinkIds = async () => (await q("select source_id from source_links where kind = 'issue' and issue_id = $1 order by source_id", [issueId])).rows.map((r) => r.source_id as string);
    beforeAll(async () => {
      [S3, S4] = await Promise.all(
        ["Third", "Fourth"].map(async (title) => (await q("insert into sources (workspace_id, kind, title, body) values ($1, 'notes', $2, 'x') returning id", [WS, title])).rows[0].id as string),
      );
    });
    beforeEach(async () => {
      const made = await saveIssueFromDialog(WS, dialog({ title: "With sources", source_ids: [S1, S2] }));
      if (made.status !== "ok") throw new Error("setup failed");
      issueId = made.issue.id;
      // A link made elsewhere (another tab, the MCP link_source): on the issue, but not on its own list.
      await q("insert into source_links (workspace_id, source_id, kind, issue_id) values ($1, $2, 'issue', $3)", [WS, S4, issueId]);
    });

    it("an edit takes the links of only the sources it removed from the issue's list: one made elsewhere stays", async () => {
      expect(await sourceLinkIds()).toEqual([S1, S2, S4].sort());
      // The list before the save is [S1, S2]; the dialog saves [S2, S3].
      await saveIssueFromDialog(WS, dialog({ id: issueId, source_ids: [S2, S3] }));
      expect((await q("select source_id from issue_sources where issue_id = $1 order by source_id", [issueId])).rows.map((r) => r.source_id)).toEqual([S2, S3].sort());
      const remaining = await sourceLinkIds();
      expect(remaining).not.toContain(S1);
      expect(remaining).toContain(S2);
      expect(remaining).toContain(S4);
    });

    it("an edit that removes nothing leaves the links alone, and a new issue has none to take off", async () => {
      const before = await sourceLinkIds();
      await saveIssueFromDialog(WS, dialog({ id: issueId, source_ids: [S1, S2] }));
      expect(await sourceLinkIds()).toEqual(before);
      const fresh = await saveIssueFromDialog(WS, dialog({ title: "Fresh", source_ids: [S1] }));
      expect(fresh.status).toBe("ok");
      if (fresh.status === "ok") expect((await q("select source_id from source_links where kind = 'issue' and issue_id = $1", [fresh.issue.id])).rows.map((r) => r.source_id)).toEqual([S1]);
    });
  });

  it("the dialog's save is refused without a title, or without steps or the whole process", async () => {
    const before = await issueCount();
    expect(await saveIssueFromDialog(WS, dialog({ title: " " }))).toMatchObject({ status: "error" });
    expect(await saveIssueFromDialog(WS, dialog({ links: [] }))).toEqual({ status: "error", message: "Pick at least one step, or choose the whole process." });
    expect(await saveIssueFromDialog("nope", dialog())).toMatchObject({ status: "error" });
    expect(await issueCount()).toBe(before);
  });

  it("dismissing again moves the dismissal to the new revision", async () => {
    const d = await untracked(1);
    await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), status: "dismissed", dismissed_revision_id: NORTHBEAM_REVISION_ID });
    const [row] = await byKey(d.key);
    // A newer published revision to dismiss it against.
    const revision = (await q("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 99, 'draft') returning id", [WS, NORTHBEAM_PROCESS_ID])).rows[0].id;
    expect((await redismissIssue(WS, row.id, revision)).status).toBe("ok");
    expect(await issueRow(row.id)).toMatchObject({ status: "dismissed", dismissed_revision_id: revision });
    expect(await redismissIssue(WS, row.id, "nope")).toMatchObject({ status: "error" });
  });

  it("turn RLS refusals into a sentence", async () => {
    signInAs({ tdb }, viewer);
    const before = await issueCount();
    expect(await createIssue(WS, manual)).toEqual({ status: "error", message: "You don't have permission to change issues here." });
    expect(await issueCount()).toBe(before);
    // A delete RLS filters out removes nothing.
    expect(await deleteIssue(northbeamIssues()[0]!.id)).toEqual({ status: "error", message: "You don't have permission to change issues here." });
    expect(await issueCount()).toBe(before);
    signInAs({ tdb }, editor);
    const made = await createIssue(WS, manual);
    if (made.status !== "ok") throw new Error("setup failed");
    expect(await deleteIssue(made.issue.id)).toEqual({ status: "ok" });
    expect(await issueCount()).toBe(before);
  });
});
