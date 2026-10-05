import { describe, expect, it } from "vitest";
import { calibrate, type CalibrationProposal } from "@transpera-flow/engine";
import { calibrationInput, parseStepLog } from "@transpera-flow/db";
import { parseApplyRequest } from "@/lib/calibration/request";
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
  const ok = { workspaceId: WS, processId: PROC, fileName: " log.csv ", columnMap: { item: "Deal", step: "Stage", started: "Start" }, rowCount: 3, results: { proposals: [{ key: "work:s" }] }, keys: ["work:s", "work:s"] };

  it("accepts a well-formed request and tidies it", () => {
    const r = parseApplyRequest(ok);
    expect(r.ok && r.request.fileName).toBe("log.csv");
    expect(r.ok && r.request.keys).toEqual(["work:s"]);
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
    expect(result.items).toBe(40);
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

  it("flags too few and proposes nothing for them", () => {
    const thin = result.proposals.filter((p) => !p.enough);
    expect(thin.length).toBeGreaterThan(0);
    for (const p of thin) expect(p.set).toBeNull();
  });
});
