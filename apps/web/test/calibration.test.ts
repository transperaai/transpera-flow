import { describe, expect, it } from "vitest";
import { calibrate, proposePersonTimes, type CalibrationProposal, type PersonTimeProposal } from "@transpera-flow/engine";
import { calibrationInput, parseStepLog } from "@transpera-flow/db";
import { groupByPerson, initiallyTickedFactor, personTimesSetup } from "@/lib/calibration/person-times";
import { parseApplyRequest, storedResults } from "@/lib/calibration/request";
import { calibrationRows } from "@/lib/calibration/rows";
import { northbeamSampleLog } from "@/lib/calibration/sample";
import { applySummary, formatValue, groupProposals, initiallySelected, KIND_ORDER, selectable } from "@/lib/calibration/view";
import { demoBundle } from "@/lib/sources/demo";

// The Calibration page (issue #41): what it ticks, how it words values and outcomes, what it sends, and that the demo's
// sample log gives a useful set of proposals for Northbeam.

const WS = "00000000-0000-4000-8000-000000000001";
const PROC = "00000000-0000-4000-8000-000000000002";

const proposal = (over: Partial<CalibrationProposal>): CalibrationProposal => ({
  key: "work:s",
  kind: "work",
  target: { table: "steps", id: "s" },
  subject: "Audit",
  n: 20,
  enough: true,
  currentSource: "estimated",
  current: 6,
  proposed: 7,
  changed: true,
  blocked: null,
  note: "",
  set: { work_hours: 7 },
  before: { work_hours: 6 },
  ...over,
});

describe("what is ticked", () => {
  it("ticks a change to an estimate, and never one to a value someone entered or measured", () => {
    expect(initiallySelected(proposal({}))).toBe(true);
    expect(initiallySelected(proposal({ currentSource: "entered" }))).toBe(false);
    expect(initiallySelected(proposal({ currentSource: "measured" }))).toBe(false);
    // Entered values can still be ticked by hand.
    expect(selectable(proposal({ currentSource: "entered" }))).toBe(true);
  });

  it("offers nothing that is too few to measure or already matches", () => {
    expect(selectable(proposal({ enough: false, set: null, proposed: null, changed: false }))).toBe(false);
    expect(selectable(proposal({ changed: false }))).toBe(false);
  });
});

describe("wording", () => {
  it("words values in the page's units", () => {
    expect(formatValue("work", 2.5, 0.3)).toBe("2.5 h ±30%");
    expect(formatValue("wait", 17.14, null)).toBe("17.14 h");
    expect(formatValue("rework", 0.125)).toBe("13%");
    expect(formatValue("arrivals", 6.5)).toBe("6.5 a week");
    expect(formatValue("work", null)).toBe("—");
  });

  it("says where applied changes went and why any were skipped", () => {
    const subjects = new Map([["work:b", "Discovery call (hands-on time)"]]);
    expect(
      applySummary(
        [
          { key: "work:a", status: "applied" },
          { key: "arrivals:x", status: "applied" },
          { key: "work:b", status: "changed" },
        ],
        subjects,
        3,
      ),
    ).toBe(
      "1 change to steps went into the draft (version 3). Publish it to use them. 1 lead source updated. Discovery call (hands-on time): changed since the log was read, so left as it is.",
    );
    expect(applySummary([{ key: "work:b", status: "not_found" }], subjects, null)).toBe("Nothing was applied. Discovery call (hands-on time): no longer in the process.");
  });
});

describe("parseApplyRequest", () => {
  const KEY = `work:${PROC}`;
  const ok = {
    workspaceId: WS,
    processId: PROC,
    fileName: " log.csv ",
    columnMap: { item: "Deal", step: "Stage", started: "Start" },
    rowCount: 3,
    results: { proposals: [{ key: KEY }], unmatchedSteps: [{ name: "Invoice to Acme Ltd", rows: 2 }], unmatchedSources: [] },
    keys: [KEY, KEY],
  };

  it("accepts a well-formed request, tidies it, and stores no free text from the log", () => {
    const r = parseApplyRequest(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.fileName).toBe("log.csv");
    expect(r.request.keys).toEqual([KEY]);
    expect(r.request.results.unmatchedSteps).toBe(1);
    expect(r.request.results.unmatchedSources).toBe(0);
    expect(JSON.stringify(r.request.results)).not.toContain("Acme");
  });

  it("skips ticked keys that aren't proposals, with a reason, and applies the rest", () => {
    const r = parseApplyRequest({ ...ok, keys: [KEY, "work:other", 7] });
    expect(r.ok && r.request.keys).toEqual([KEY]);
    expect(r.ok && r.request.skipped).toEqual([
      { key: "work:other", status: "not_proposed" },
      { key: "7", status: "not_proposed" },
    ]);
  });

  it("refuses what isn't", () => {
    expect(parseApplyRequest({ ...ok, workspaceId: "x" }).ok).toBe(false);
    expect(parseApplyRequest({ ...ok, keys: [] }).ok).toBe(false);
    expect(parseApplyRequest({ ...ok, keys: ["work:other"] }).ok).toBe(false);
    expect(parseApplyRequest({ ...ok, columnMap: { owner: "Rep" } }).ok).toBe(false);
    expect(parseApplyRequest({ ...ok, results: { proposals: "all" } }).ok).toBe(false);
    expect(parseApplyRequest({ ...ok, rowCount: -1 }).ok).toBe(false);
  });
});

describe("the demo's sample log on Northbeam", () => {
  const bundle = demoBundle();
  const log = parseStepLog(northbeamSampleLog());
  const result = calibrate(calibrationInput(calibrationRows(bundle, null), log.rows));
  const find = (kind: string, subject: string) => result.proposals.find((p) => p.kind === kind && p.subject === subject);

  it("reads cleanly, and every step name is on the map", () => {
    expect(log.errors).toEqual([]);
    expect(log.missing).toEqual([]);
    expect(result.items).toBe(56);
    expect(result.unmatchedSteps).toEqual([]);
  });

  it("proposes something of every kind", () => {
    expect(groupProposals(result.proposals).map((g) => g.kind)).toEqual(KIND_ORDER);
    expect(find("work", "Audit & proposal")).toMatchObject({ enough: true, changed: true });
    expect(find("wait", "Client decision")).toMatchObject({ enough: true });
    expect(find("rework", "Audit & proposal")!.proposed).toBeGreaterThan(0);
    expect(find("routing", "Qualify lead")).toMatchObject({ enough: true });
    // Kickoff's way out is chosen by each client's service: no odds to measure.
    expect(find("routing", "Kickoff & strategy")).toBeUndefined();
  });

  it("measures leads a week close to Northbeam's own seven qualified a week", () => {
    const qualified = result.proposals
      .filter((p) => p.kind === "arrivals")
      .reduce((sum, p) => sum + p.proposed! * Number(bundle.leadSources!.find((s) => s.id === p.target.id)!.conversion_to_qualified), 0);
    expect(qualified).toBeCloseTo(7, 0);
  });
});

// Per-person times (issue #227): who may see them, what is sent and what is ticked.

const PERSON_A = "00000000-0000-4000-8000-0000000000a1";
const PERSON_B = "00000000-0000-4000-8000-0000000000b2";
const STEP_ID = "00000000-0000-4000-8000-0000000000c3";

const factor = (over: Partial<PersonTimeProposal> = {}): PersonTimeProposal => ({
  key: `factor:${PERSON_A}:${STEP_ID}`,
  kind: "capacity_factor",
  target: { table: "person_capacity_factors", id: PERSON_A, step_id: STEP_ID },
  personId: PERSON_A,
  stepId: STEP_ID,
  subject: "Kickoff",
  n: 14,
  stepN: 40,
  enough: true,
  current: null,
  currentSource: null,
  every: null,
  measured: 0.8,
  proposed: 0.8,
  limited: false,
  within: false,
  changed: true,
  blocked: null,
  note: "14 of the step's 40 logged visits.",
  set: { factor: 0.8 },
  before: { factor: null },
  ...over,
});

describe("per-person times in the request", () => {
  const KEY = `work:${PROC}`;
  const base = {
    workspaceId: WS,
    processId: PROC,
    kind: "time_logs",
    fileName: "log.csv",
    columnMap: { job: "Job", task: "Task", date: "Date", hours: "Hours" },
    rowCount: 3,
    results: { proposals: [{ key: KEY }] },
    keys: [KEY],
  };
  const f = factor();

  it("drops per-person data from the results, whatever it is called", () => {
    const stored = storedResults({ proposals: [], capacity_factors: [f], capacityFactors: [f], personTimes: [f], rows: 3 });
    expect(Object.keys(stored).sort()).toEqual(["proposals", "rows", "unmatchedSources", "unmatchedSteps"]);
    const r = parseApplyRequest({ ...base, results: { proposals: [{ key: KEY }], capacity_factors: [f], personTimes: [f] }, capacityFactors: [f], keys: [KEY, f.key] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.request.results)).not.toContain(PERSON_A);
    expect(r.request.capacityFactors).toEqual([f]);
    expect(r.request.keys).toEqual([KEY, f.key]);
  });

  it("rebuilds each proposal from known fields only", () => {
    const r = parseApplyRequest({ ...base, capacityFactors: [{ ...f, extra: "Sam Patel" }], keys: [f.key] });
    expect(r.ok && r.request.capacityFactors[0]).toEqual(f);
    expect(JSON.stringify(r)).not.toContain("Sam Patel");
  });

  it("refuses a bad proposal, a key for another person than its target, and a time outside 0.5 to 2", () => {
    const bad = (over: Record<string, unknown>) => parseApplyRequest({ ...base, capacityFactors: [{ ...f, ...over }], keys: [f.key] });
    expect(bad({ key: `factor:${PERSON_B}:${STEP_ID}` })).toEqual({ ok: false, message: "The per-person times aren't valid." });
    expect(bad({ personId: PERSON_B }).ok).toBe(false);
    expect(bad({ target: { table: "person_capacity_factors", id: PERSON_B, step_id: STEP_ID } }).ok).toBe(false);
    expect(bad({ target: { table: "people", id: PERSON_A, step_id: STEP_ID } }).ok).toBe(false);
    expect(bad({ proposed: 2.5, set: { factor: 2.5 } }).ok).toBe(false);
    expect(bad({ set: { factor: 0.4 } }).ok).toBe(false);
    expect(bad({ n: -1 }).ok).toBe(false);
    expect(bad({ n: 1.5 }).ok).toBe(false);
    expect(bad({ subject: "x".repeat(201) }).ok).toBe(false);
    expect(bad({ currentSource: "guessed" }).ok).toBe(false);
    expect(bad({ changed: "yes" }).ok).toBe(false);
    expect(bad({ set: { factor: 0.8 }, before: null }).ok).toBe(false);
    expect(parseApplyRequest({ ...base, capacityFactors: "all", keys: [f.key] }).ok).toBe(false);
    expect(parseApplyRequest({ ...base, capacityFactors: [f, f], keys: [f.key] }).ok).toBe(false);
    expect(parseApplyRequest({ ...base, capacityFactors: Array(2001).fill(f), keys: [f.key] }).ok).toBe(false);
  });

  it("accepts a factor key only when it belongs to a proposal with a value", () => {
    const blocked = factor({ key: `factor:${PERSON_B}:${STEP_ID}`, personId: PERSON_B, target: { table: "person_capacity_factors", id: PERSON_B, step_id: STEP_ID }, set: null, before: null, proposed: null, blocked: "Too few" });
    const r = parseApplyRequest({ ...base, capacityFactors: [f, blocked], keys: [KEY, f.key, blocked.key, `factor:${PERSON_A}:${PERSON_B}`] });
    expect(r.ok && r.request.keys).toEqual([KEY, f.key]);
    expect(r.ok && r.request.skipped.map((s) => s.status)).toEqual(["not_proposed", "not_proposed"]);
    // With no proposals at all a factor key is skipped, and with nothing else ticked the request is refused.
    expect(parseApplyRequest({ ...base, keys: [f.key] }).ok).toBe(false);
  });
});

describe("per-person times on the page", () => {
  it("ticks a value that changes, isn't within the spread, isn't at a bound and doesn't replace an entered time", () => {
    expect(initiallyTickedFactor(factor())).toBe(true);
    expect(initiallyTickedFactor(factor({ within: true }))).toBe(false);
    expect(initiallyTickedFactor(factor({ limited: true }))).toBe(false);
    expect(initiallyTickedFactor(factor({ changed: false }))).toBe(false);
    expect(initiallyTickedFactor(factor({ current: 0.9, currentSource: "entered" }))).toBe(false);
    expect(initiallyTickedFactor(factor({ current: 0.9, currentSource: "measured" }))).toBe(true);
    expect(initiallyTickedFactor(factor({ set: null, before: null, proposed: null }))).toBe(false);
  });

  it("groups by person in the roster's order, leaving out people with nothing, and never by value", () => {
    const people = [
      { id: PERSON_B, name: "B" },
      { id: PERSON_A, name: "A" },
      { id: "00000000-0000-4000-8000-0000000000d4", name: "C" },
    ];
    const a = factor({ proposed: 0.5 });
    const b = factor({ personId: PERSON_B, key: `factor:${PERSON_B}:${STEP_ID}`, proposed: 1.9 });
    expect(groupByPerson([a, b], people).map((g) => [g.person.name, g.proposals.length])).toEqual([
      ["B", 1],
      ["A", 1],
    ]);
  });

  it("is hidden for a member, off with the switch off, and on otherwise", () => {
    const b = demoBundle();
    const steps = b.steps;
    expect(personTimesSetup(b, steps)).toEqual({ state: "off" });
    const on = { ...b, workspace: { ...b.workspace, settings: { ...b.workspace.settings, capacity_factor_enabled: true } } };
    const setup = personTimesSetup(on, steps);
    expect(setup.state).toBe("on");
    if (setup.state !== "on") return;
    expect(setup.people.length).toBe(b.people.length);
    expect(setup.persons.map((p) => p.id)).toEqual(setup.people.map((p) => p.id));
    // A member or viewer, or a share link that hides pay, gets nothing, with the switch on or off.
    for (const viewer of [{ seesEveryone: false, ownPersonId: null }, { seesEveryone: false, ownPersonId: b.people[0]!.id }]) {
      expect(personTimesSetup({ ...on, viewer }, steps)).toEqual({ state: "hidden" });
      expect(personTimesSetup({ ...b, viewer }, steps)).toEqual({ state: "hidden" });
    }
    expect(personTimesSetup({ ...on, payHidden: true }, steps)).toEqual({ state: "hidden" });
    // Stored times come through, with where they came from.
    const [p0, p1] = b.people;
    const step0 = steps.find((s) => s.role_id)!;
    const withFactors = {
      ...on,
      personCapacityFactors: [
        { person_id: p0!.id, workspace_id: b.workspace.id, step_id: null, factor: 0.9, source: "entered" },
        { person_id: p0!.id, workspace_id: b.workspace.id, step_id: step0.id, factor: 1.1, source: "measured", items: 12 },
      ],
    };
    const got = personTimesSetup(withFactors, steps);
    if (got.state !== "on") throw new Error("expected on");
    expect(got.persons.find((p) => p.id === p0!.id)).toMatchObject({ every: { factor: 0.9, source: "entered" }, steps: { [step0.id]: { factor: 1.1, source: "measured" } } });
    expect(got.persons.find((p) => p.id === p1!.id)).toMatchObject({ every: null, steps: {} });
  });

  it("proposes nothing per person from a log with no one named", () => {
    expect(proposePersonTimes({ steps: [], rows: [], people: [] }).proposals).toEqual([]);
  });
});

describe("applySummary with per-person times", () => {
  it("counts factor keys apart from steps and leads, and words a switched-off time", () => {
    const text = applySummary(
      [
        { key: `work:${STEP_ID}`, status: "applied" },
        { key: `factor:${PERSON_A}:${STEP_ID}`, status: "applied" },
        { key: `factor:${PERSON_B}:${STEP_ID}`, status: "applied" },
        { key: `factor:${PERSON_B}:${PERSON_A}`, status: "switched_off" },
      ],
      new Map([[`factor:${PERSON_B}:${PERSON_A}`, "Kickoff"]]),
      3,
    );
    expect(text).toContain("1 change to steps went into the draft (version 3)");
    expect(text).toContain("2 per-person times set");
    expect(text).not.toContain("lead source");
    expect(text).toContain("Kickoff: per-person times are switched off");
    expect(applySummary([{ key: `factor:${PERSON_A}:${STEP_ID}`, status: "applied" }], new Map(), null)).toBe("1 per-person time set.");
  });
});
