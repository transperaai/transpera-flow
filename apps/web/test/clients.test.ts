import { describe, expect, it } from "vitest";
import { CLIENT_FIELDS, clientSources, clientsRuleSentence, parseNewClient } from "@/lib/clients";

// Clients by hand (issue #182, B19; PRD D42): what the add form and field saves accept, and which clients the simulation uses.

describe("a new client", () => {
  it("needs a name; MRR and the start date are optional", () => {
    expect(parseNewClient({ name: "  Harbour Lane Dental ", mrr: "", start_date: "" })).toEqual({ ok: true, value: { name: "Harbour Lane Dental", mrr: 0, start_date: null } });
    expect(parseNewClient({ name: "Bright Smile", mrr: "2400.50", start_date: "2026-09-01" })).toEqual({ ok: true, value: { name: "Bright Smile", mrr: 2400.5, start_date: "2026-09-01" } });
    expect(parseNewClient({ name: "  ", mrr: "", start_date: "" })).toEqual({ ok: false, error: "Enter the client's name." });
    expect(parseNewClient({ name: "X", mrr: "-5", start_date: "" })).toEqual({ ok: false, error: "Enter MRR as a number, 0 or more." });
    expect(parseNewClient({ name: "X", mrr: "lots", start_date: "" })).toMatchObject({ ok: false });
    expect(parseNewClient({ name: "X", mrr: "", start_date: "next week" })).toEqual({ ok: false, error: "Enter the start date as a date." });
  });

  it("field saves check each value the way the database does", () => {
    expect(CLIENT_FIELDS.name("x".repeat(201))).toBe(false);
    expect(CLIENT_FIELDS.mrr(Number.NaN)).toBe(false);
    expect(CLIENT_FIELDS.start_date(null)).toBe(true);
    expect(CLIENT_FIELDS.active("false")).toBe(false);
  });
});

describe("which clients each process simulates", () => {
  const processes = [
    { id: "sales", name: "Sales", kind: "pipeline" },
    { id: "partners", name: "Partnerships", kind: "pipeline" },
    { id: "delivery", name: "Monthly reporting", kind: "servicing" },
  ];
  // SEO is open to every process; Referral is entered through Partnerships only; PPC is inactive.
  const services = [
    { id: "seo", active: true, entry_process_id: null },
    { id: "referral", active: true, entry_process_id: "partners" },
    { id: "ppc", active: false, entry_process_id: null },
  ];

  it("a process uses groups only when a group counts clients for one of its own services, as the engine does", () => {
    expect(clientSources(processes, services, [])).toEqual({ groups: [], named: ["Sales", "Partnerships"] });
    expect(clientSources(processes, services, [{ service_id: "seo", client_count: 0.4 }])).toEqual({ groups: [], named: ["Sales", "Partnerships"] });
    expect(clientSources(processes, services, [{ service_id: "seo", client_count: 12 }])).toEqual({ groups: ["Sales", "Partnerships"], named: [] });
    // A group for a service only another process takes doesn't switch this one.
    expect(clientSources(processes, services, [{ service_id: "referral", client_count: 5 }])).toEqual({ groups: ["Partnerships"], named: ["Sales"] });
    // Nor does a group for an inactive service.
    expect(clientSources(processes, services, [{ service_id: "ppc", client_count: "9" }])).toEqual({ groups: [], named: ["Sales", "Partnerships"] });
  });

  it("says so in one sentence", () => {
    expect(clientsRuleSentence({ groups: ["Sales"], named: [] })).toMatch(/groups drive the simulation and this list is a record/);
    expect(clientsRuleSentence({ groups: [], named: ["Sales"] })).toMatch(/uses the active clients on this list/);
    expect(clientsRuleSentence({ groups: ["Sales", "Upsell"], named: ["Partnerships"] })).toBe(
      "Client groups drive the simulation of Sales and Upsell, whose services have clients counted; Partnerships uses the active clients on this list. Inactive clients are always left out.",
    );
    expect(clientsRuleSentence({ groups: [], named: [] })).toMatch(/^A process whose services have clients counted/);
  });
});
