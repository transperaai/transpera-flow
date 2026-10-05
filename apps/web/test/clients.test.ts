import { describe, expect, it } from "vitest";
import { CLIENT_FIELDS, clientsRuleSentence, namedClientsSimulated, parseNewClient } from "@/lib/clients";

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

describe("which clients are simulated", () => {
  it("the named clients only while no client group counts any", () => {
    expect(namedClientsSimulated([])).toBe(true);
    expect(namedClientsSimulated([{ client_count: 0 }, { client_count: "0" }])).toBe(true);
    expect(namedClientsSimulated([{ client_count: 0 }, { client_count: 3 }])).toBe(false);
    expect(clientsRuleSentence(false)).toMatch(/client groups drive the simulation/);
    expect(clientsRuleSentence(true)).toMatch(/uses the active clients on this list/);
  });
});
