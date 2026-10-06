import { describe, expect, it } from "vitest";
import { loadIssuesForReader, loadLinkTargets, readerSeesPeople, type Db } from "../src";

// What a member reads of issue keys (B1 2b, issue #30): a fake database and rpc, no Postgres. `can_see_people` is the rpc.

const ID = { ai: "00000000-0000-4000-8000-0000000000a1", eng: "00000000-0000-4000-8000-0000000000a2", dismissed: "00000000-0000-4000-8000-0000000000a3" };
const WS = "00000000-0000-4000-8000-0000000000ff";
const row = (id: string, detected_key: string, status = "open") => ({
  id, workspace_id: WS, number: 1, title: "T", status, resolution: null, detected_key, source: "promoted", type: "capacity", severity: "serious", evidence: "e",
  evidence_metrics: {}, created_at: "2026-09-01T09:00:00Z", process_id: null, step_id: null, role_id: null, person_id: null, client_id: null, owner_person_id: null,
});
const TABLES: Record<string, unknown[]> = {
  issues: [row(ID.ai, "ai:insight:0123456789ab"), row(ID.eng, "overtime:person:00000000-0000-4000-8000-000000000001"), row(ID.dismissed, "ai:insight:ba9876543210", "dismissed")],
};

/** A database whose every query ends in the rows of its table, and whose rpc `can_see_people` answers as told. */
function fake(sees: { data: unknown; error: unknown }): Db {
  const chain = (table: string): unknown =>
    new Proxy({}, { get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => unknown) => ok({ data: TABLES[table] ?? [], error: null }) : () => chain(table)) });
  return { from: (table: string) => chain(table), rpc: async (name: string) => (name === "can_see_people" ? sees : { data: null, error: { message: "no such rpc" } }) } as unknown as Db;
}

describe("readerSeesPeople", () => {
  it("passes true and false through, and reads an error (or anything but true) as no", async () => {
    expect(await readerSeesPeople(fake({ data: true, error: null }), WS)).toBe(true);
    expect(await readerSeesPeople(fake({ data: false, error: null }), WS)).toBe(false);
    expect(await readerSeesPeople(fake({ data: true, error: { message: "boom" } }), WS)).toBe(false);
    expect(await readerSeesPeople(fake({ data: null, error: null }), WS)).toBe(false);
  });
});

describe("loadIssuesForReader", () => {
  const keys = (issues: { id: string; detected_key: string | null }[]) => Object.fromEntries(issues.map((i) => [i.id, i.detected_key]));

  it("gives a reader who can't see everyone an opaque key for an AI insight, and leaves engine keys alone", async () => {
    for (const sees of [{ data: false, error: null }, { data: null, error: { message: "boom" } }]) {
      const out = keys(await loadIssuesForReader(fake(sees), WS));
      expect(out[ID.ai]).toBe(`ai:insight:${ID.ai}`);
      expect(out[ID.dismissed]).toBe(`ai:insight:${ID.dismissed}`);
      expect(out[ID.eng]).toBe("overtime:person:00000000-0000-4000-8000-000000000001");
    }
  });

  it("leaves every stored key for a reader who sees everyone", async () => {
    const out = keys(await loadIssuesForReader(fake({ data: true, error: null }), WS));
    expect(out[ID.ai]).toBe("ai:insight:0123456789ab");
    expect(out[ID.dismissed]).toBe("ai:insight:ba9876543210");
  });
});

describe("loadLinkTargets", () => {
  it("masks the insight keys of a reader who can't see everyone, leaves them for one who can, and skips dismissed insights", async () => {
    const hidden = await loadLinkTargets(fake({ data: false, error: null }), WS);
    expect(hidden.insights.map((i) => i.key).sort()).toEqual([`ai:insight:${ID.ai}`, "overtime:person:00000000-0000-4000-8000-000000000001"].sort());
    const open = await loadLinkTargets(fake({ data: true, error: null }), WS);
    expect(open.insights.map((i) => i.key).sort()).toEqual(["ai:insight:0123456789ab", "overtime:person:00000000-0000-4000-8000-000000000001"].sort());
  });
});
