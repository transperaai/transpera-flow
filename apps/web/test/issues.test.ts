import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  northbeamBundle,
  northbeamIssues,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamScenarios,
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

// A stand-in for Supabase behind the issue Server Actions: records what
// reaches the database, so the tests can show malformed input never does.
const db = vi.hoisted(() => ({
  calls: [] as { op: string; args: unknown[] }[],
  signedIn: true,
  /** What a select (or delete) returns. */
  result: { data: null as unknown, error: null as unknown },
  /** What the save_issue call returns. */
  rpcResult: { data: null as unknown, error: null as unknown },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = {
      insert: (...args: unknown[]) => (db.calls.push({ op: "insert", args }), chain),
      delete: () => (db.calls.push({ op: "delete", args: [] }), chain),
      eq: (...args: unknown[]) => (db.calls.push({ op: "eq", args }), chain),
      in: (...args: unknown[]) => (db.calls.push({ op: "in", args }), chain),
      order: () => chain,
      select: () => chain,
      single: async () => db.result,
      then: (resolve: (v: unknown) => void) => resolve(db.result),
    };
    return {
      auth: { getClaims: async () => ({ data: db.signedIn ? { claims: { sub: "u1" } } : null }) },
      from: (table: string) => (db.calls.push({ op: "from", args: [table] }), chain),
      rpc: async (fn: string, args: unknown) => (db.calls.push({ op: "rpc", args: [fn, args] }), fn === "save_issue" ? db.rpcResult : db.result),
    };
  },
}));
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
  beforeEach(() => {
    db.calls = [];
    db.signedIn = true;
    db.result = { data: null, error: null };
    db.rpcResult = { data: { id: "i1" }, error: null };
  });
  const saved = () => db.calls.find((c) => c.op === "rpc" && c.args[0] === "save_issue")?.args[1] as { p_workspace: string; p_id?: string; p_fields: Record<string, unknown>; p_links: unknown; p_owners: unknown; p_sources: unknown } | undefined;

  it("reject malformed input before touching the database", async () => {
    expect(await createIssue("not-a-uuid", manual)).toMatchObject({ status: "error" });
    expect(await createIssue(WS, { ...manual, title: "" })).toMatchObject({ status: "error" });
    expect(await createIssue(WS, { ...manual, type: "gremlins" })).toEqual({ status: "error", message: "Pick a type." });
    expect(await promoteIssue(WS, { ...manual, detected_key: "nope" })).toMatchObject({ status: "error" });
    expect(await saveIssueField("x", "title", "a", "b")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "source", "manual", "promoted")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "detected_key", null, "a:b:c")).toMatchObject({ status: "error" });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "status", "open", "closed")).toMatchObject({ status: "error" });
    expect(await deleteIssue("x")).toMatchObject({ status: "error" });
    expect(db.calls).toEqual([]);
  });

  it("refuse a signed-out user", async () => {
    db.signedIn = false;
    expect(await createIssue(WS, manual)).toEqual({ status: "error", message: "Your session has ended. Sign in again." });
    expect(await saveIssueField(northbeamIssues()[0]!.id, "status", "open", "resolved")).toEqual({
      status: "error",
      message: "Your session has ended. Sign in again.",
    });
    expect(db.calls).toEqual([]);
  });

  it("save a manual issue into the given workspace through save_issue, with the parsed fields only", async () => {
    db.result = { data: [{ id: "i1" }], error: null };
    const r = await createIssue(WS, { ...manual, workspace_id: "someone-elses", source: "promoted", detected_key: "a:b:c" });
    expect(r).toMatchObject({ status: "ok", issue: { id: "i1", links: [], owner_ids: [], source_ids: [] } });
    const call = saved()!;
    expect(call.p_workspace).toBe(WS);
    expect(call.p_id).toBeUndefined();
    expect(call.p_fields).toMatchObject({ source: "manual", title: "Reports copied by hand", evidence: null });
    expect(call.p_fields).not.toHaveProperty("detected_key");
    expect(call.p_fields).not.toHaveProperty("workspace_id");
  });
  it("promote with source 'promoted', status open and the detection's key", async () => {
    db.result = { data: [{ id: "i2" }], error: null };
    const d = northbeamDetections()[1]!;
    await promoteIssue(WS, promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios));
    expect(saved()!.p_fields).toMatchObject({ source: "promoted", status: "open", detected_key: d.key });
    // What it touches goes in the link table, with the process it was found on.
    expect(saved()!.p_links).toEqual([{ process_id: NORTHBEAM_PROCESS_ID, step_id: d.stepId }]);
  });
  const OLD_SENTENCE =
    "Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap, costing about £1,040 at cost rates over the 26-week run. The cap is used up.";
  it("promote strips the overtime money an old browser tab still sends (B1 2b)", async () => {
    db.result = { data: [{ id: "i2" }], error: null };
    const d = northbeamDetections()[1]!;
    await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), evidence: OLD_SENTENCE, evidence_metrics: { overtime_hours_week: 4, overtime_cost: 1040 } });
    const fields = saved()!.p_fields;
    expect(fields.evidence).toBe("Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap. The cap is used up.");
    expect(fields.evidence_metrics).toEqual({ overtime_hours_week: 4 });
  });
  it("the Acknowledge dialog strips it too, for a new issue and for an edit", async () => {
    db.result = { data: [{ id: "i1" }], error: null };
    const d = northbeamDetections()[1]!;
    await saveIssueFromDialog(WS, dialog({ evidence: OLD_SENTENCE, from: { detected_key: d.key, evidence: OLD_SENTENCE, evidence_metrics: { overtime_cost: 1040, a: 1 }, role_id: null, person_id: null, client_id: null, scenario_id: null } }));
    expect(saved()!.p_fields.evidence).not.toMatch(/costing/);
    expect(saved()!.p_fields.evidence_metrics).toEqual({ a: 1 });
    db.calls.length = 0;
    await saveIssueFromDialog(WS, dialog({ id: "00000000-0000-4000-8000-0000000000a1", evidence: OLD_SENTENCE }));
    expect(saved()!.p_fields.evidence).toBe("Simulated: 44 h/wk of client work against 40 h/wk capacity, so 4 h/wk overtime on average within the 10% cap. The cap is used up.");
  });
  it("promote can store a dismissed insight in one write, with the revision it was dismissed against, and refuses any other status", async () => {
    db.result = { data: [{ id: "i2" }], error: null };
    const d = northbeamDetections()[1]!;
    const revision = "00000000-0000-4000-8000-0000000000aa";
    await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), status: "dismissed", dismissed_revision_id: revision });
    expect(saved()!.p_fields).toMatchObject({ source: "promoted", status: "dismissed", detected_key: d.key, dismissed_revision_id: revision });
    db.calls.length = 0;
    const r = await promoteIssue(WS, { ...promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios), status: "resolved" });
    expect(r.status).toBe("error");
    expect(saved()).toBeUndefined();
  });
  it("say so when a detection is already tracked (unique key)", async () => {
    db.rpcResult = { data: null, error: { code: "23505" } };
    const d = northbeamDetections()[0]!;
    expect(await promoteIssue(WS, promoteInput(d, NORTHBEAM_PROCESS_ID, scenarios))).toEqual({ status: "error", message: ALREADY_TRACKED });
  });
  it("save one field through save_fields with its base", async () => {
    db.result = { data: { status: "saved", row: { title: "New" } }, error: null };
    const id = northbeamIssues()[0]!.id;
    expect(await saveIssueField(id, "title", "Old", "New")).toEqual({ status: "saved", value: "New" });
    expect(db.calls).toEqual([{ op: "rpc", args: ["save_fields", { target: "issues", key: { id }, base: { title: "Old" }, changes: { title: "New" } }] }]);
  });

  it("save a status as the older spelling plus a resolution, each checked against what the person saw", async () => {
    const id = northbeamIssues()[0]!.id;
    const change = async (from: string, to: string) => {
      db.calls.length = 0;
      db.result = { data: { status: "saved", row: {} }, error: null };
      const r = await saveIssueField(id, "status", from, to);
      return { r, call: db.calls[0]!.args[1] as { base: unknown; changes: unknown } };
    };
    expect((await change("open", "testing")).call).toMatchObject({ base: { status: "open", resolution: null }, changes: { status: "in_progress", resolution: null } });
    expect((await change("testing", "resolved")).call).toMatchObject({ base: { status: "in_progress", resolution: null }, changes: { status: "done", resolution: null } });
    expect((await change("resolved", "wont_fix")).call).toMatchObject({ base: { status: "done", resolution: null }, changes: { status: "done", resolution: "wont_fix" } });
    expect((await change("wont_fix", "open")).call).toMatchObject({ base: { status: "done", resolution: "wont_fix" }, changes: { status: "open", resolution: null } });
    expect((await change("open", "testing")).r).toEqual({ status: "saved", value: "testing" });
    // Someone else moved it on: what they stored is shown as the status it stands for.
    db.result = { data: { status: "conflict", conflicts: { status: "done", resolution: "wont_fix" } }, error: null };
    expect(await saveIssueField(id, "status", "open", "testing")).toEqual({ status: "conflict", theirs: "wont_fix" });
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
    db.result = { data: [{ id: "i1" }], error: null };
    const d = northbeamDetections()[1]!;
    const r = await saveIssueFromDialog(WS, dialog({ from: { detected_key: d.key, evidence_metrics: { a: 1 }, role_id: null, person_id: null, client_id: null, scenario_id: null } }));
    expect(r.status).toBe("ok");
    expect(db.calls.filter((c) => c.op === "rpc")).toHaveLength(1);
    const call = saved()!;
    expect(call.p_id).toBeUndefined();
    expect(call.p_fields).toMatchObject({ title: "Slow check", severity: "serious", source: "promoted", detected_key: d.key, type: "manual", target_goal: "under 4 hours" });
    expect(call.p_links).toHaveLength(2);
    expect(call.p_owners).toEqual([northbeamPersonIds["Rosa Diaz"]]);
    expect(call.p_sources).toEqual([]);
  });

  it("the dialog's edit sends the issue id and only the fields a person can change", async () => {
    db.result = { data: [{ id: "i1" }], error: null };
    const id = northbeamIssues()[0]!.id;
    await saveIssueFromDialog(WS, dialog({ id, status: "testing" }));
    const call = saved()!;
    expect(call.p_id).toBe(id);
    expect(call.p_fields).toMatchObject({ title: "Slow check", status: "testing" });
    expect(call.p_fields).not.toHaveProperty("source");
    expect(call.p_fields).not.toHaveProperty("type");
  });

  it("an edit takes the links of only the sources it removed from the issue's list (A53): one made elsewhere stays", async () => {
    const S1 = "30000000-0000-4000-8000-000000000001";
    const S2 = "30000000-0000-4000-8000-000000000002";
    const S3 = "30000000-0000-4000-8000-000000000003";
    // The issue's list before the save is [S1, S2] (what the select returns); the dialog saves [S2, S3].
    db.result = { data: [{ source_id: S1 }, { source_id: S2 }], error: null };
    const id = northbeamIssues()[0]!.id;
    await saveIssueFromDialog(WS, dialog({ id, source_ids: [S2, S3] }));
    const at = db.calls.findIndex((c) => c.op === "from" && c.args[0] === "source_links");
    expect(at).toBeGreaterThan(-1);
    const after = db.calls.slice(at);
    expect(after.find((c) => c.op === "delete")).toBeTruthy();
    expect(after.find((c) => c.op === "in")?.args).toEqual(["source_id", [S1]]);
  });

  it("an edit that removes nothing leaves the links alone, and a new issue has none to take off", async () => {
    const S1 = "30000000-0000-4000-8000-000000000001";
    db.result = { data: [{ source_id: S1 }], error: null };
    await saveIssueFromDialog(WS, dialog({ id: northbeamIssues()[0]!.id, source_ids: [S1] }));
    // (Reading the issue back reads its links; nothing is deleted.)
    expect(db.calls.some((c) => c.op === "delete")).toBe(false);
    db.calls.length = 0;
    await saveIssueFromDialog(WS, dialog({ source_ids: [S1] }));
    expect(db.calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("the dialog's save is refused without a title, or without steps or the whole process", async () => {
    expect(await saveIssueFromDialog(WS, dialog({ title: " " }))).toMatchObject({ status: "error" });
    expect(await saveIssueFromDialog(WS, dialog({ links: [] }))).toEqual({ status: "error", message: "Pick at least one step, or choose the whole process." });
    expect(await saveIssueFromDialog("nope", dialog())).toMatchObject({ status: "error" });
    expect(saved()).toBeUndefined();
  });

  it("dismissing again moves the dismissal to the new revision", async () => {
    db.result = { data: [{ id: "i1" }], error: null };
    const id = northbeamIssues()[1]!.id;
    const revision = "00000000-0000-4000-8000-0000000000bb";
    expect((await redismissIssue(WS, id, revision)).status).toBe("ok");
    expect(saved()).toMatchObject({ p_id: id, p_fields: { status: "dismissed", dismissed_revision_id: revision } });
    expect(await redismissIssue(WS, id, "nope")).toMatchObject({ status: "error" });
  });

  it("turn RLS refusals into a sentence", async () => {
    db.rpcResult = { data: null, error: { code: "42501" } };
    expect(await createIssue(WS, manual)).toEqual({ status: "error", message: "You don't have permission to change issues here." });
    db.result = { data: [], error: null };
    expect(await deleteIssue(northbeamIssues()[0]!.id)).toEqual({ status: "error", message: "You don't have permission to change issues here." });
  });
});
