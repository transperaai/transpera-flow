import { describe, expect, it } from "vitest";
import {
  CLIENTS_TEMPLATE,
  SERVICING_LOG_TEMPLATE,
  clientCalibrationServices,
  hasTimeOfDay,
  northbeamBundle,
  parseClientsFile,
  parseServicingLog,
  servicingLinks,
  type ClientCalibrationRows,
} from "../src";

// Reading a clients file and a servicing log for calibration (issue #41, part 2) and turning stored rows into the
// engine's input. No database.

const d = (y: number, m: number, day: number, h = 0, mi = 0) => Date.UTC(y, m - 1, day, h, mi);

describe("parseClientsFile", () => {
  it("finds the columns by common names and reads the rows", () => {
    const r = parseClientsFile("Customer ID,Plan,Signed on,Churned\nC1,SEO retainer,2025-01-13,\nC2,PPC management,2025-02-03,2025-11-28\n");
    expect(r.missing).toEqual([]);
    expect(r.columns).toEqual({ client: "Customer ID", service: "Plan", started: "Signed on", ended: "Churned" });
    expect(r.rows).toEqual([
      { client: "C1", service: "SEO retainer", started: d(2025, 1, 13), ended: null },
      { client: "C2", service: "PPC management", started: d(2025, 2, 3), ended: d(2025, 11, 28) },
    ]);
    expect(r.lines).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it("treats ended as optional", () => {
    const r = parseClientsFile("client,service,started\nC1,SEO,2025-01-13");
    expect(r.missing).toEqual([]);
    expect(r.columns.ended).toBeUndefined();
    expect(r.rows[0]!.ended).toBeNull();
  });

  it("says which required columns are missing, and reads nothing then", () => {
    const r = parseClientsFile("client,service\nC1,SEO");
    expect(r.missing).toEqual(["started"]);
    expect(r.rows).toEqual([]);
  });

  it("reports bad rows by line and keeps the good ones", () => {
    const r = parseClientsFile(
      ["client,service,started,ended", "C1,SEO,2025-01-13,", ",SEO,2025-01-13,", "C3,,2025-01-13,", "C4,SEO,someday,", "C5,SEO,2025-01-13,never", "C6,SEO,2025-03-01,2025-02-01", "C7,SEO,2025-01-13,2025-06-01"].join("\n"),
    );
    expect(r.rows.map((x) => x.client)).toEqual(["C1", "C7"]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(r.errors[0]!.message).toBe("Missing client.");
    expect(r.errors[1]!.message).toBe("Missing service.");
    expect(r.errors[2]!.message).toMatch(/Can't read the start/);
    expect(r.errors[3]!.message).toMatch(/Can't read the end/);
    expect(r.errors[4]!.message).toBe("They left before they started.");
  });

  it("finds day and month order from the whole file, and asks when it can't tell", () => {
    const dmy = parseClientsFile("client,service,started,ended\nC1,SEO,02/03/2026,\nC2,SEO,13/03/2026,");
    expect(dmy.dateOrder).toBe("dmy");
    expect(dmy.rows.map((x) => x.started)).toEqual([d(2026, 3, 2), d(2026, 3, 13)]);
    const ambiguous = parseClientsFile("client,service,started,ended\nC1,SEO,02/03/2026,\nC2,SEO,04/05/2026,");
    expect(ambiguous.dateProblem).toBe("ambiguous");
    expect(ambiguous.rows).toEqual([]);
    const told = parseClientsFile("client,service,started,ended\nC1,SEO,02/03/2026,\nC2,SEO,04/05/2026,", { dateOrder: "mdy" });
    expect(told.rows.map((x) => x.started)).toEqual([d(2026, 2, 3), d(2026, 4, 5)]);
    expect(parseClientsFile("client,service,started\nC1,SEO,13/03/2026\nC2,SEO,03/13/2026").dateProblem).toBe("mixed");
  });

  it("reads its own template", () => {
    const r = parseClientsFile(CLIENTS_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.rows.length).toBe(5);
    expect(r.rows.filter((x) => x.ended !== null).length).toBe(2);
  });
});

describe("hasTimeOfDay", () => {
  it("tells a date from a date-time", () => {
    expect(hasTimeOfDay("2026-03-02")).toBe(false);
    expect(hasTimeOfDay("02/03/2026")).toBe(false);
    expect(hasTimeOfDay("2026-03-02 09:30")).toBe(true);
    expect(hasTimeOfDay("2026-03-02T09:30:00Z")).toBe(true);
    expect(hasTimeOfDay("02/03/2026 09:30")).toBe(true);
    expect(hasTimeOfDay("someday")).toBe(false);
  });
});

describe("parseServicingLog", () => {
  it("finds the columns by common names and reads the rows", () => {
    const r = parseServicingLog("Deliverable,Account,Deadline,Delivered on,Raised\nMonthly report,C1,2026-03-06 17:00,2026-03-05 16:00,\nAd-hoc request,C2,2026-03-07 12:00,,2026-03-06 09:00\n");
    expect(r.missing).toEqual([]);
    expect(r.columns).toEqual({ task: "Deliverable", client: "Account", due: "Deadline", done: "Delivered on", requested: "Raised" });
    expect(r.rows).toEqual([
      { task: "Monthly report", client: "C1", due: d(2026, 3, 6, 17), done: d(2026, 3, 5, 16), requested: null },
      { task: "Ad-hoc request", client: "C2", due: d(2026, 3, 7, 12), done: null, requested: d(2026, 3, 6, 9) },
    ]);
  });

  it("says which required columns are missing, and reads nothing then", () => {
    const r = parseServicingLog("task,due\nMonthly report,2026-03-06");
    expect(r.missing).toEqual(["client"]);
    expect(r.rows).toEqual([]);
  });

  it("reads a due date with no time as the end of that day, and one with a time as it is", () => {
    const r = parseServicingLog("task,client,due\nA,C1,2026-03-06\nB,C1,2026-03-06 09:00\nC,C1,13/03/2026");
    expect(r.rows.map((x) => x.due)).toEqual([d(2026, 3, 6) + 86_400_000 - 1, d(2026, 3, 6, 9), d(2026, 3, 13) + 86_400_000 - 1]);
  });

  it("reports bad rows by line, allows done before due, and refuses done before requested", () => {
    const r = parseServicingLog(
      [
        "task,client,due,done,requested",
        "A,C1,2026-03-06,2026-03-01,", // early: fine
        ",C1,2026-03-06,,",
        "B,,2026-03-06,,",
        "C,C1,soon,,",
        "D,C1,2026-03-06,never,",
        "E,C1,2026-03-06,,whenever",
        "F,C1,2026-03-06,2026-03-01,2026-03-02",
      ].join("\n"),
    );
    expect(r.rows.map((x) => x.task)).toEqual(["A"]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(r.errors[0]!.message).toBe("Missing task.");
    expect(r.errors[1]!.message).toBe("Missing client.");
    expect(r.errors[2]!.message).toMatch(/Can't read the due date/);
    expect(r.errors[5]!.message).toBe("It was done before it was requested.");
  });

  it("finds day and month order from the whole file", () => {
    const r = parseServicingLog("task,client,due,done\nA,C1,13/03/2026,12/03/2026");
    expect(r.dateOrder).toBe("dmy");
    expect(parseServicingLog("task,client,due\nA,C1,02/03/2026\nB,C1,04/05/2026").dateProblem).toBe("ambiguous");
  });

  it("reads its own template", () => {
    const r = parseServicingLog(SERVICING_LOG_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.rows.length).toBe(4);
  });

  it("stops at the row limit", () => {
    const header = "task,client,due\n";
    const body = Array.from({ length: 200_002 }, (_, i) => `A,C${i},2026-03-06`).join("\n");
    const r = parseServicingLog(header + body);
    expect(r.rows.length).toBe(200_000);
    expect(r.errors.at(-1)!.message).toMatch(/Only the first 200,000 rows are read/);
  });
});

describe("clientCalibrationServices and servicingLinks", () => {
  const bundle = northbeamBundle();
  const stored: ClientCalibrationRows = {
    services: bundle.services,
    clientGroups: bundle.clientGroups ?? [],
    servicing: bundle.servicingLinks ?? [],
    processes: [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)],
    hoursPerWeek: 40,
  };

  it("gives each active service with its client group and where its churn came from", () => {
    const services = clientCalibrationServices(stored);
    expect(services.map((s) => s.name).sort()).toEqual(["PPC management", "SEO retainer"]);
    const seo = services.find((s) => s.name === "SEO retainer")!;
    expect(seo.pricingModel).toBe("retainer");
    expect(seo.group).toEqual({ id: expect.any(String), churnMonthly: 0.03, count: 17, source: "estimated" });
    expect(services.find((s) => s.name === "PPC management")!.group).toMatchObject({ churnMonthly: 0.04, count: 12 });
  });

  it("reads provenance: entered and measured churn", () => {
    const g = stored.clientGroups[0]!;
    const entered = clientCalibrationServices({ ...stored, clientGroups: [{ ...g, provenance: { churn_monthly: { source: "entered" } } }] });
    expect(entered.find((s) => s.group?.id === g.id)!.group!.source).toBe("entered");
    const measured = clientCalibrationServices({ ...stored, clientGroups: [{ ...g, provenance: { churn_monthly: { source: "measured", dataset_id: "x" } } }] });
    expect(measured.find((s) => s.group?.id === g.id)!.group!.source).toBe("measured");
  });

  it("leaves out inactive services and services with no group get none", () => {
    const [first] = stored.services;
    const services = clientCalibrationServices({ services: stored.services.map((s) => (s.id === first!.id ? { ...s, active: false } : s)), clientGroups: stored.clientGroups.slice(0, 0) });
    expect(services.map((s) => s.serviceId)).not.toContain(first!.id);
    expect(services.every((s) => s.group === null)).toBe(true);
  });

  it("gives the servicing links with their processes' names, SLA and whether they are ad-hoc", () => {
    const links = servicingLinks(stored);
    // Northbeam's two services each run both servicing processes, on a schedule.
    expect(links.length).toBe(4);
    expect(links.map((l) => l.processName).sort()).toEqual(["Client check-in", "Client check-in", "Monthly report", "Monthly report"]);
    expect(links.find((l) => l.processName === "Monthly report")!.slaHours).toBe(40);
    expect(links.find((l) => l.processName === "Client check-in")!.slaHours).toBe(16);
    expect(links.every((l) => !l.adhoc)).toBe(true);
    const adhoc = servicingLinks({ ...stored, servicing: stored.servicing.map((l, i) => (i === 0 ? { ...l, recurrence: { poisson_per_month: 1.5 } } : l)) });
    expect(adhoc.filter((l) => l.adhoc).length).toBe(1);
    // Numbers can arrive as strings from pg.
    const text = servicingLinks({ ...stored, servicing: stored.servicing.map((l, i) => (i === 0 ? { ...l, recurrence: { poisson_per_month: "2" } as never, sla_hours: "24" as never } : l)) });
    expect(text.find((l) => l.adhoc)!.slaHours).toBe(24);
  });
});
