import { describe, expect, it } from "vitest";
import { backSolveChurn, churnProposals, measureChurn, servicingChecks, type BackSolvedChurn, type CalibrationProposal } from "@transpera-flow/engine";
import { clientCalibrationServices, parseClientsFile, parseServicingLog, servicingLinks, toEngineModel } from "@transpera-flow/db";
import { mergeSolved, progressText } from "@/lib/calibration/backsolve";
import { clientCalibrationRows, simulationPlan } from "@/lib/calibration/client-rows";
import { parseClientApplyRequest, pickLatestChecks, storedClientResults } from "@/lib/calibration/client-request";
import { SAMPLE_AS_OF, northbeamSampleClients, northbeamSampleServicingLog, sampleClientIds } from "@/lib/calibration/client-sample";
import { CHECK_LABELS, applySummary, formatCheckValue, formatChurn, formatMultiplier, historyNote, initiallySelected, localDateText, selectable } from "@/lib/calibration/client-view";
import { demoBundle } from "@/lib/sources/demo";

// Historical data, "Clients and servicing work" (issue #41, part 2): what it ticks, how it words values and outcomes, what it
// sends and stores (never a client id, D27), and that the demo's sample files give churn for both services and the checks.

const WS = "00000000-0000-4000-8000-000000000001";
const GROUP = "00000000-0000-4000-8000-0000000000aa";
const GROUP2 = "00000000-0000-4000-8000-0000000000bb";
const KEY = `churn:${GROUP}`;
const NAMES = ["SEO retainer", "PPC management", "Web design"];
const store = (r: Record<string, unknown>) => storedClientResults(r, NAMES);

const proposal = (over: Partial<CalibrationProposal> = {}): CalibrationProposal => ({
  key: KEY,
  kind: "churn",
  target: { table: "client_groups", id: GROUP },
  subject: "SEO retainer",
  n: 20,
  leavers: 4,
  enough: true,
  currentSource: "estimated",
  current: 0.03,
  measured: 0.0196,
  multiplier: 1.25,
  proposed: 0.0157,
  changed: true,
  blocked: null,
  note: "4 of 20 clients left over 52 weeks (2% a month).",
  set: { churn_monthly: 0.0157 },
  before: { churn_monthly: 0.03 },
  ...over,
});

const FILE = { fileName: "clients.csv", columnMap: { client: "Customer", service: "Plan", started: "Signed" }, rowCount: 40 };
const LOG = { fileName: "servicing.csv", columnMap: { task: "Task", client: "Customer", due: "Due" }, rowCount: 100 };
const request = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, clients: FILE, log: LOG, results: { proposals: [proposal()] }, keys: [KEY], ...over });

describe("what is ticked", () => {
  it("ticks a change to an estimate, and never one to a value someone entered or measured", () => {
    expect(initiallySelected(proposal())).toBe(true);
    expect(initiallySelected(proposal({ currentSource: "entered" }))).toBe(false);
    expect(initiallySelected(proposal({ currentSource: "measured" }))).toBe(false);
    // Entered values can still be ticked by hand.
    expect(selectable(proposal({ currentSource: "entered" }))).toBe(true);
  });

  it("offers nothing that is blocked or already matches", () => {
    expect(selectable(proposal({ enough: false, set: null, proposed: null, changed: false, blocked: "Too few to measure" }))).toBe(false);
    expect(selectable(proposal({ changed: false }))).toBe(false);
  });
});

describe("wording", () => {
  it("words churn, the drivers' multiplier and each check in its own unit", () => {
    expect(formatChurn(0.0211)).toBe("2.1% a month");
    expect(formatChurn(null)).toBe("—");
    expect(formatMultiplier(1.25)).toBe("×1.25");
    expect(formatCheckValue("late", 0.152)).toBe("15%");
    expect(formatCheckValue("resp", 6.5)).toBe("6.5 working hours");
    expect(formatCheckValue("onb", 8)).toBe("8 working days");
    expect(formatCheckValue("onb", null)).toBe("—");
  });

  it("has an (i) text with an example for each check, saying it is a check only", () => {
    for (const id of ["late", "resp", "onb"] as const) {
      expect(CHECK_LABELS[id].description).toMatch(/check only/i);
      expect(CHECK_LABELS[id].example.length).toBeGreaterThan(20);
    }
  });

  it("says what applying did and why anything was skipped", () => {
    const subjects = new Map([[KEY, "SEO retainer (normal churn)"]]);
    expect(applySummary([{ key: KEY, status: "applied" }, { key: "churn:b", status: "applied" }], subjects)).toBe("Normal churn updated for 2 services.");
    expect(applySummary([{ key: KEY, status: "applied" }], subjects)).toBe("Normal churn updated for 1 service.");
    expect(applySummary([{ key: KEY, status: "changed" }], subjects)).toBe("Nothing was applied. SEO retainer (normal churn): changed since the file was read, so left as it is.");
    expect(applySummary([{ key: KEY, status: "invalid" }], subjects)).toContain("can't be applied");
  });

  it("adds the history to a driver's line for late, response time and onboarding only, when there is a value", () => {
    const history = {
      asOf: Date.UTC(2026, 8, 30),
      checks: [
        { id: "late", n: 250, value: 0.152, enough: true },
        { id: "resp", n: 4, value: null, enough: false },
        { id: "onb", n: 12, value: 8, enough: true },
      ],
    };
    expect(historyNote("late", history)).toMatch(/^ · history: 15% \(250 tasks, to 30 Sept? 2026\)$/);
    expect(historyNote("onb", history)).toContain("8 working days (12 new clients, to 30");
    expect(historyNote("resp", history)).toBe("");
    expect(historyNote("rework", history)).toBe("");
    expect(historyNote("late", null)).toBe("");
  });
});

describe("parseClientApplyRequest", () => {
  it("accepts a ticked churn key, and none at all: the checks are saved on their own", () => {
    const some = parseClientApplyRequest(request(), NAMES);
    expect(some.ok && some.request.keys).toEqual([KEY]);
    const none = parseClientApplyRequest(request({ keys: [] }), NAMES);
    expect(none.ok && none.request.keys).toEqual([]);
    const missing = parseClientApplyRequest(request({ keys: undefined }), NAMES);
    expect(missing.ok && missing.request.keys).toEqual([]);
  });

  it("accepts one file or the other, and refuses neither", () => {
    expect(parseClientApplyRequest(request({ log: null }), NAMES).ok).toBe(true);
    expect(parseClientApplyRequest(request({ clients: null }), NAMES).ok).toBe(true);
    expect(parseClientApplyRequest(request({ clients: null, log: null }), NAMES)).toEqual({ ok: false, message: "Add a clients file or a servicing log first." });
  });

  it("skips ticked keys that aren't proposals, with why", () => {
    const out = parseClientApplyRequest(request({ keys: [KEY, `churn:${GROUP2}`, "work:x", "churn:nonsense", 5] }), NAMES);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.request.keys).toEqual([KEY]);
      expect(out.request.skipped.map((s) => s.status)).toEqual(["not_proposed", "not_proposed", "not_proposed", "not_proposed"]);
    }
  });

  it("refuses bad files and bad requests", () => {
    for (const bad of [
      request({ workspaceId: "nope" }),
      request({ clients: { ...FILE, fileName: " " } }),
      request({ clients: { ...FILE, fileName: "x".repeat(301) } }),
      request({ clients: { ...FILE, columnMap: { secret: "Customer" } } }),
      request({ clients: { ...FILE, columnMap: { client: "x".repeat(201) } } }),
      request({ clients: { ...FILE, rowCount: -1 } }),
      request({ clients: { ...FILE, rowCount: 1_000_001 } }),
      request({ log: { ...LOG, columnMap: { client: 5 } } }),
      request({ log: "x" }),
      request({ results: { proposals: "no" } }),
      request({ results: null }),
      request({ keys: "churn" }),
      null,
      "x",
    ]) {
      expect(parseClientApplyRequest(bad, NAMES).ok).toBe(false);
    }
  });
});

describe("storedClientResults (D27: client ids are never stored)", () => {
  it("rebuilds from known fields: an extra field holding a client id is dropped, and so are names that matched nothing", () => {
    const stored = store({
      kind: "clients",
      asOf: 1,
      rows: 40,
      clients: 20,
      tasks: 100,
      startsAfterAsOf: 0,
      clientIds: ["C-014", "C-015"],
      unmatchedServices: [{ name: "Secret service for C-014", rows: 3 }],
      unmatchedTasks: [{ name: "Task for C-015", rows: 2 }],
      noGroup: ["Web design"],
      proposals: [{ ...proposal(), clientId: "C-014", extra: { client: "C-015" } }],
      checks: [{ id: "late", n: 100, value: 0.15, simulated: 0.12, enough: true, blocked: null, note: "x", firstClient: "C-014" }],
      run: { engineVersion: "1.7.0", seed: 1, reps: 30, horizonWeeks: 13, runs: 2, converged: true, processIds: [WS, "C-014"], secret: "C-014" },
      window: { from: 1, to: 2, weeks: 3, client: "C-014" },
    });
    const text = JSON.stringify(stored);
    expect(text).not.toContain("C-014");
    expect(text).not.toContain("C-015");
    expect(text).not.toContain("Secret");
    expect(stored).toMatchObject({ kind: "clients", unmatchedServices: 1, unmatchedTasks: 1, noGroup: ["Web design"], rows: 40, clients: 20, tasks: 100 });
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({ key: KEY, set: { churn_monthly: 0.0157 }, before: { churn_monthly: 0.03 } });
    expect(stored.run?.processIds).toEqual([WS]);
    expect(Object.keys(stored.proposals[0]!).sort()).toEqual(
      ["before", "blocked", "changed", "current", "currentSource", "enough", "key", "kind", "leavers", "measured", "multiplier", "n", "note", "proposed", "set", "subject", "target"].sort(),
    );
  });

  it("keeps a name only when the workspace has it, and a note or reason only when it is one of our sentences: nothing typed in a file is stored", () => {
    const stored = store({
      noGroup: ["Web design", "Acme Corp (C-014)"],
      proposals: [
        { ...proposal(), subject: "C-014 Acme", note: "Client C-014 left. 4 of 20 clients left over 52 weeks (2% a month).", blocked: "Client C-014 is unknown." },
        { ...proposal({ key: `churn:${GROUP2}`, target: { table: "client_groups", id: GROUP2 }, subject: " seo   RETAINER " }) },
      ],
      checks: [{ id: "late", n: 1, value: 0.1, enough: true, note: "C-014 was late", blocked: "C-014" }],
    });
    const text = JSON.stringify(stored);
    expect(text).not.toContain("C-014");
    expect(text).not.toContain("Acme");
    expect(stored.noGroup).toEqual(["Web design"]);
    expect(stored.proposals.map((p) => p.subject)).toEqual(["", "seo   RETAINER"]);
    expect(stored.proposals[0]!.note).toBe("");
    expect(stored.proposals[0]!.blocked).toBeNull();
    expect(stored.proposals[1]!.note).toBe("4 of 20 clients left over 52 weeks (2% a month).");
    expect(stored.checks[0]).toMatchObject({ note: "", blocked: null });
  });

  it("drops proposals and checks that aren't what they claim, and takes counts as they come", () => {
    const stored = store({
      unmatchedServices: 3,
      proposals: [{ ...proposal(), key: "churn:bad" }, { ...proposal(), target: { table: "steps", id: GROUP } }, { ...proposal(), kind: "work" }, proposal()],
      checks: [{ id: "other", n: 1 }, { id: "onb", n: 12, value: 8, simulated: null, enough: true, blocked: null, note: "n" }],
    });
    expect(stored.unmatchedServices).toBe(3);
    expect(stored.proposals.map((p) => p.key)).toEqual([KEY]);
    expect(stored.checks.map((c) => c.id)).toEqual(["onb"]);
    expect(stored.run).toBeNull();
    expect(stored.window).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The demo's sample files, against Northbeam
// ---------------------------------------------------------------------------

describe("the demo samples", () => {
  const bundle = demoBundle();
  const processes = [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  const rows = clientCalibrationRows(bundle, processes);
  const services = clientCalibrationServices(rows);
  const links = servicingLinks(rows);
  const asOf = Date.parse(SAMPLE_AS_OF) + 86_400_000 - 1;
  const clients = parseClientsFile(northbeamSampleClients());
  const log = parseServicingLog(northbeamSampleServicingLog());
  const measured = measureChurn({ rows: clients.rows, services, asOf });
  const checks = servicingChecks({ log: log.rows, clients: clients.rows, links, services, hoursPerWeek: rows.hoursPerWeek, asOf });

  it("read cleanly: every service and task name matches Northbeam", () => {
    expect(clients.errors).toEqual([]);
    expect(clients.missing).toEqual([]);
    expect(log.errors).toEqual([]);
    expect(log.missing).toEqual([]);
    expect(measured.unmatchedServices).toEqual([]);
    expect(checks.unmatchedTasks).toEqual([]);
    expect(measured.startsAfterAsOf).toBe(0);
    // About forty clients (a few rows more for those who came back).
    expect(measured.clients).toBe(40);
    expect(clients.rows.length).toBeGreaterThanOrEqual(40);
    expect(clients.rows.length).toBeLessThanOrEqual(46);
  });

  it("measure churn for both services: six to eight leavers each", () => {
    expect(measured.services).toHaveLength(2);
    for (const m of measured.services) {
      expect(m.enough).toBe(true);
      expect(m.leavers).toBeGreaterThanOrEqual(6);
      expect(m.leavers).toBeLessThanOrEqual(8);
      expect(m.monthly).toBeGreaterThan(0.01);
      expect(m.monthly).toBeLessThan(0.08);
    }
  });

  it("give the late-work and onboarding checks values; response time has none, as Northbeam has no ad-hoc servicing", () => {
    const by = (id: string) => checks.checks.find((c) => c.id === id)!;
    expect(by("late").enough).toBe(true);
    // About 15% late, and some work still open past its due date.
    expect(by("late").value!).toBeGreaterThan(0.08);
    expect(by("late").value!).toBeLessThan(0.25);
    expect(log.rows.some((r) => r.done === null && r.due <= asOf)).toBe(true);
    expect(by("onb").enough).toBe(true);
    expect(by("onb").value!).toBeGreaterThan(0);
    expect(by("resp").blocked).toBe("No servicing work is set to come in as ad-hoc requests.");
    expect(by("resp").value).toBeNull();
  });

  it("propose churn for both services, and store no client id", () => {
    const plan = simulationPlan(rows, bundle.process.id);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.serviceIds).toHaveLength(2);
    const measuredBy = Object.fromEntries(measured.services.filter((m) => m.enough && m.monthly !== null).map((m) => [m.serviceId, m.monthly!]));
    const solved = backSolveChurn(toEngineModel(bundle), measuredBy, { reps: 10 });
    expect(Object.keys(solved.bases).sort()).toEqual(plan[0]!.serviceIds);
    const { proposals, noGroup } = churnProposals(services, measured.services, solved);
    expect(noGroup).toEqual([]);
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.enough).toBe(true);
      expect(p.proposed!).toBeLessThan(p.measured!);
      expect(p.multiplier!).toBeGreaterThan(1);
    }
    // Late work and onboarding are simulated now too; no ad-hoc requests, so no response time.
    expect(solved.simulated.late).not.toBeNull();
    expect(solved.simulated.resp).toBeNull();

    // As the page would send it: nothing that holds a client id survives into what is stored.
    const results = {
      asOf,
      window: measured.window,
      rows: measured.rows,
      clients: measured.clients,
      tasks: checks.tasks,
      startsAfterAsOf: measured.startsAfterAsOf,
      unmatchedServices: measured.unmatchedServices.length,
      unmatchedTasks: checks.unmatchedTasks.length,
      noGroup,
      proposals,
      checks: checks.checks.map((c) => ({ id: c.id, n: c.n, value: c.value, simulated: solved.simulated[c.id], enough: c.enough, blocked: c.blocked, note: c.note })),
      run: { engineVersion: solved.engineVersion, seed: solved.seed, reps: solved.reps, horizonWeeks: solved.horizonWeeks, runs: solved.runs, converged: solved.converged, processIds: [bundle.process.id] },
    };
    const parsed = parseClientApplyRequest({ workspaceId: WS, clients: FILE, log: LOG, results, keys: proposals.map((p) => p.key) }, NAMES);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.keys).toHaveLength(2);
    // Every note and reason the calibration itself writes is one the store keeps.
    for (const p of proposals) {
      const kept = parsed.request.results.proposals.find((x) => x.key === p.key)!;
      expect(kept.note).toBe(p.note);
      expect(kept.subject).toBe(p.subject);
    }
    for (const c of checks.checks) {
      const kept = parsed.request.results.checks.find((x) => x.id === c.id)!;
      expect(kept.note).toBe(c.note);
      expect(kept.blocked).toBe(c.blocked);
    }
    const stored = JSON.stringify(parsed.request.results);
    for (const id of sampleClientIds()) expect(stored).not.toContain(id);
    expect(stored).toContain("SEO retainer");
    expect(stored.length).toBeLessThan(20_000);
  });

  it("have a clients file and a servicing log that share their client ids", () => {
    const ids = new Set(clients.rows.map((r) => r.client));
    expect(log.rows.every((r) => ids.has(r.client))).toBe(true);
  });
});

describe("which process simulates which services", () => {
  const services = (over: Record<string, unknown>[]) => over.map((o, i) => ({ id: `s${i}`, active: true, pricing_model: "retainer", entry_process_id: null, ...o })) as never;
  const groups = (...ids: string[]) => ids.map((id) => ({ id: `g-${id}`, service_id: id })) as never;

  it("puts a service in the process it enters, or the default one, and leaves out one-off and inactive services and services with no group", () => {
    const rows = {
      services: services([{}, { entry_process_id: "p2" }, { pricing_model: "one_off" }, { active: false }, {}]),
      clientGroups: groups("s0", "s1", "s2", "s3"),
    };
    expect(simulationPlan(rows, "p1")).toEqual([
      { processId: "p1", serviceIds: ["s0"] },
      { processId: "p2", serviceIds: ["s1"] },
    ]);
    expect(simulationPlan({ ...rows, clientGroups: [] }, "p1")).toEqual([]);
  });
});

describe("putting the processes' answers together", () => {
  const solved = (over: Partial<BackSolvedChurn>): BackSolvedChurn => ({
    bases: {},
    multipliers: {},
    why: {},
    runs: 2,
    converged: true,
    simulated: { late: null, resp: null, onb: null },
    engineVersion: "1.7.0",
    seed: 1,
    reps: 30,
    horizonWeeks: 13,
    ...over,
  });

  it("joins proposals and reasons, takes the first value each check has, and reports the longest run", () => {
    const merged = mergeSolved([
      solved({ bases: { a: 0.01 }, multipliers: { a: 1.2 }, simulated: { late: 0.1, resp: null, onb: null }, runs: 2 }),
      solved({ bases: { b: 0.02 }, multipliers: { b: 1.5 }, why: { c: "No clients" }, simulated: { late: 0.3, resp: 5, onb: 4 }, runs: 4, converged: false }),
    ])!;
    expect(merged.bases).toEqual({ a: 0.01, b: 0.02 });
    expect(merged.multipliers).toEqual({ a: 1.2, b: 1.5 });
    expect(merged.why).toEqual({ c: "No clients" });
    expect(merged.simulated).toEqual({ late: 0.1, resp: 5, onb: 4 });
    expect(merged.runs).toBe(4);
    expect(merged.converged).toBe(false);
    expect(mergeSolved([])).toBeNull();
  });

  it("is converged unless a job that solved something is approximate", () => {
    const merged = mergeSolved([solved({ converged: true, bases: { a: 0.01 } }), solved({ converged: false, bases: {} })])!;
    expect(merged.converged).toBe(true);
    expect(mergeSolved([solved({ converged: false, bases: { a: 0.01 } })])!.converged).toBe(false);
  });

  it("words the progress", () => {
    expect(progressText(1, 0, 1)).toBe("Measuring today's driver pressure… (run 2 of up to 4)");
    expect(progressText(3, 1, 2)).toBe("Measuring today's driver pressure… (run 4 of up to 4, process 2 of 2)");
  });
});

describe("the newest checks, and today's date", () => {
  const check = { id: "late", n: 100, value: 0.15, simulated: 0.12, enough: true, blocked: null, note: "x" };

  it("skips a newer clients-only calibration (no checks) for an older one that has them", () => {
    const picked = pickLatestChecks([
      { checks: [], asOf: 3 },
      { checks: undefined, asOf: 2 },
      { checks: [check], asOf: 1 },
    ]);
    expect(picked?.asOf).toBe(1);
    expect(picked?.checks.map((c) => c.id)).toEqual(["late"]);
    expect(pickLatestChecks([{ checks: [], asOf: 3 }])).toBeNull();
    expect(pickLatestChecks([])).toBeNull();
  });

  it("writes the local calendar day, not the UTC one", () => {
    expect(localDateText(new Date(2026, 9, 6, 0, 30))).toBe("2026-10-06");
    expect(localDateText(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
