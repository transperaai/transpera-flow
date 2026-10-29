import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, loadShareData, loadShareSecrets, northbeamIssues, shareSnapshotLeaks, type Db, type ShareKind, type ShareSnapshot, type ShareToggles } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Scenario share links (sandbox phase 5b, migration 20270116000000_scenario_share_links.sql) on a database full of real-shaped rows: it is built
// as it was before the migration (every migration up to 20270115000000), given a link of every kind whose snapshot the app really built
// (`loadShareData`, as an Owner), then migrated. Every link is untouched and still opens; the new leak check accepts each stored snapshot; and the
// probes of the migration's header behave. The new kind is then built for real and opened.

const BASE = "20270115000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tok = (n: string) => n.padEnd(43, "x").slice(0, 43);
let db: TestDb;
let editor: Db;
let editorClaims: Record<string, unknown>;
let editorId = "";
let solutionId = "";
let scenarioId = "";
let before: Record<string, unknown>[];
const links: { kind: ShareKind; token: string; toggles: ShareToggles; target: string | null; id: string }[] = [];
const TOGGLES: ShareToggles[] = [
  { people: false, financials: false },
  { people: true, financials: true },
];

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Record<string, unknown>[];
const workspaceRow = async () => (await q("select id, name, slug, settings from public.workspaces where id = $1", [ws]))[0] as { id: string; name: string; slug: string; settings: unknown };
const INSERT =
  "insert into public.share_links (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, snapshot, engine_version, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '1.14.0', $10) returning id";

const INSERT_AS_OWNER =
  "insert into public.share_links (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, snapshot, engine_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '1.14.0') returning id";

async function insertLink(kind: ShareKind, target: string | null, toggles: ShareToggles, snapshot: unknown, token: string, asOwner = false) {
  const restricted = toggles.people || toggles.financials;
  const args = [ws, sha(token), kind, target, toggles.people, toggles.financials, restricted ? ["a@x.example"] : [], restricted ? new Date(Date.now() + 7 * 86400_000).toISOString() : null, JSON.stringify(snapshot)];
  // An Owner may not set created_by (the trigger stamps it); the superuser sets it for the old links.
  const r = asOwner ? await db.client.query(INSERT_AS_OWNER, args) : await db.client.query(INSERT, [...args, editorId]);
  return r.rows[0].id as string;
}

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, supabaseDefaultPrivileges: true });
  const u = await createUser(db, "scenario-share-owner@example.com");
  editorId = u.id;
  editorClaims = u.claims;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, u.id]);
  editor = db.dbAs(u.claims as never);
  solutionId = (
    await q("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) select $1, id, live_revision_id, 'Migration test', $2::jsonb from processes where id = $3 returning id", [ws, JSON.stringify({ steps: [], edges: [], entry_step_id: null }), NORTHBEAM_PROCESS_ID])
  )[0]!.id as string;
  scenarioId = (await q("insert into public.sandbox_scenarios (workspace_id, name, description, changes) values ($1, 'Share migration test', 'Why we try it', $2::jsonb) returning id", [ws, JSON.stringify([{ id: "5c000000-0000-4000-8000-000000000001", lever: "A1", target: null, op: "multiply", value: 1.2, note: "Assumes leads rise" }])]))[0]!.id as string;

  // A link of every kind, with real snapshots built the way the app builds them, under both extremes of the toggles.
  const workspace = await workspaceRow();
  let n = 0;
  for (const toggles of TOGGLES) {
    const targets: [ShareKind, string | null][] = [["overview", null], ["process", NORTHBEAM_PROCESS_ID], ["issue", northbeamIssues()[0]!.id], ["solution", solutionId]];
    for (const [kind, target] of targets) {
      const snapshot = await loadShareData(editor, workspace, { kind, id: target }, toggles);
      expect(shareSnapshotLeaks(snapshot, await loadShareSecrets(editor, ws), toggles), `${kind}`).toEqual([]);
      const token = tok(`old-${kind}-${n++}`);
      const id = await insertLink(kind, target, toggles, snapshot, token);
      links.push({ kind, token, toggles, target, id });
    }
  }
  // A play link of the process (mode play needs hiddenLevers in the snapshot, which loadShareData adds for a process).
  const playSnapshot = await loadShareData(editor, workspace, { kind: "process", id: NORTHBEAM_PROCESS_ID }, TOGGLES[0]!);
  await db.client.query("insert into public.share_links (workspace_id, token_hash, kind, target_id, mode, snapshot, engine_version, created_by) values ($1, $2, 'process', $3, 'play', $4::jsonb, '1.14.0', $5)", [ws, sha(tok("old-play")), NORTHBEAM_PROCESS_ID, JSON.stringify(playSnapshot), editorId]);
  before = await q("select to_jsonb(s) as j from public.share_links s order by id");

  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270116000000_scenario_share_links.sql");
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored links", () => {
  it("has a link of every old kind, and a play link, to test on", () => {
    expect(new Set(links.map((l) => l.kind))).toEqual(new Set(["overview", "process", "issue", "solution"]));
    expect(before.length).toBe(links.length + 1);
  });

  it("writes no row: every link is as it was", async () => {
    expect(await q("select to_jsonb(s) as j from public.share_links s order by id")).toEqual(before);
  });

  it("the kind check now lists 'scenario' and still lists the four old kinds", async () => {
    const def = (await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'share_links_kind'"))[0]!.d as string;
    for (const kind of ["overview", "process", "issue", "solution", "scenario"]) expect(def).toContain(`'${kind}'`);
  });

  it("every stored snapshot passes the new leak check, for its own kind and toggles (the new key formats refuse nothing real)", async () => {
    const rows = await q("select kind, show_people, show_financials, snapshot, workspace_id from public.share_links");
    expect(rows.length).toBe(links.length + 1);
    for (const r of rows) {
      const p = (await q("select private.share_snapshot_problem($1, $2, $3::jsonb, $4, $5) as p", [r.workspace_id, r.kind, JSON.stringify(r.snapshot), r.show_people, r.show_financials]))[0]!.p;
      expect(p, `${r.kind} people ${r.show_people} financials ${r.show_financials}`).toBeNull();
    }
  });

  it("every old link still opens for an anonymous visitor (an open one), and a restricted one asks to sign in", async () => {
    for (const l of links) {
      await db.client.query("begin");
      try {
        await db.client.query("set local role anon");
        await db.client.query("select set_config('request.jwt.claims', '', true)");
        const r = (await db.client.query("select public.open_share_link($1) as r", [l.token])).rows[0].r as { status: string; kind?: string } | null;
        const restricted = l.toggles.people || l.toggles.financials;
        expect(r?.status, `${l.kind} ${JSON.stringify(l.toggles)}`).toBe(restricted ? "sign_in" : "ok");
        if (!restricted) expect(r?.kind).toBe(l.kind);
      } finally {
        await db.client.query("rollback");
      }
    }
  });

  it("an old link's snapshot can be replaced (Update copy) through the new trigger", async () => {
    const workspace = await workspaceRow();
    const l = links.find((x) => x.kind === "process" && !x.toggles.people)!;
    const fresh = await loadShareData(editor, workspace, { kind: "process", id: NORTHBEAM_PROCESS_ID }, l.toggles);
    await db.as(editorClaims, async (c) => {
      const r = await c.query("update public.share_links set snapshot = $2::jsonb where id = $1 returning id", [l.id, JSON.stringify(fresh)]);
      expect(r.rows).toHaveLength(1);
    });
  });
});

describe("a scenario link, built for real", () => {
  const T0: ShareToggles = { people: false, financials: false };

  it("loadShareData builds the snapshot, and the new trigger stores it and an anonymous visitor opens it", async () => {
    const workspace = await workspaceRow();
    const snap = (await loadShareData(editor, workspace, { kind: "scenario", id: scenarioId }, T0, { today: "2027-01-04" })) as ShareSnapshot & { kind: "scenario" };
    expect(snap).toMatchObject({ v: 1, kind: "scenario", scenarioId, startDate: "2027-01-04", months: 12, hiddenCostChanges: 0 });
    expect(snap.scenarios.map((s) => s.id)).toEqual([scenarioId]);
    expect(snap.bundle.payHidden).toBe(true);
    expect(shareSnapshotLeaks(snap, await loadShareSecrets(editor, ws), T0)).toEqual([]);
    const token = tok("scn-real");
    // The Owner can store it (inside a transaction that is rolled back), and so can the superuser for the visitor's open below.
    await db.as(editorClaims, async () => {
      expect(await insertLink("scenario", scenarioId, T0, snap, tok("scn-as-owner"), true)).toBeTruthy();
    });
    await insertLink("scenario", scenarioId, T0, snap, token);
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await db.client.query("select set_config('request.jwt.claims', '', true)");
      const r = (await db.client.query("select public.open_share_link($1) as r", [token])).rows[0].r as { status: string; kind: string; snapshot: { scenarioId: string } };
      expect(r).toMatchObject({ status: "ok", kind: "scenario" });
      expect(r.snapshot.scenarioId).toBe(scenarioId);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("the probes of the migration's header: clean is null, each refused shape is named", async () => {
    const workspace = await workspaceRow();
    const snap = (await loadShareData(editor, workspace, { kind: "scenario", id: scenarioId }, T0, { today: "2027-01-04" })) as unknown as Record<string, unknown>;
    const problem = async (s: unknown, t: ShareToggles = T0) => (await q("select private.share_snapshot_problem($1, 'scenario', $2::jsonb, $3, $4) as p", [ws, JSON.stringify(s), t.people, t.financials]))[0]!.p;
    expect(await problem(snap)).toBeNull();
    const mismatch = "The snapshot doesn't match the link.";
    expect(await problem({ ...snap, months: 24 })).toBeNull();
    expect(await problem({ ...snap, months: 0 })).toBe(mismatch);
    expect(await problem({ ...snap, months: 25 })).toBe(mismatch);
    expect(await problem({ ...snap, startDate: "next week" })).toBe(mismatch);
    expect(await problem({ ...snap, extra: { target: "Free text" } })).toBe(mismatch);
    expect(await problem({ ...snap, extra: { lever: ["A1"] } })).toBe(mismatch);
  });

  it("an Update copy of a scenario link rebuilds from today's scenario (a new note is in the copy)", async () => {
    const workspace = await workspaceRow();
    const first = (await loadShareData(editor, workspace, { kind: "scenario", id: scenarioId }, T0, { today: "2027-01-04" })) as unknown as { scenarios: { changes: { note?: string }[] }[] };
    await q("update public.sandbox_scenarios set changes = $2::jsonb where id = $1", [scenarioId, JSON.stringify([{ id: "5c000000-0000-4000-8000-000000000001", lever: "A1", target: null, op: "multiply", value: 1.2, note: "Now assumes a bigger rise" }])]);
    const second = (await loadShareData(editor, workspace, { kind: "scenario", id: scenarioId }, T0, { today: "2027-02-01" })) as unknown as { startDate: string; scenarios: { changes: { note?: string }[] }[] };
    expect(first.scenarios[0]!.changes[0]!.note).toBe("Assumes leads rise");
    expect(second.scenarios[0]!.changes[0]!.note).toBe("Now assumes a bigger rise");
    expect(second.startDate).toBe("2027-02-01");
  });
});

describe("an overheads change in a Financials-off link (review fix, 20270117000000)", () => {
  const T0: ShareToggles = { people: false, financials: false };

  it("a Sandbox scenario's whole-run C2 is a process link's scenario patch: the app drops the amount, and the database refuses it", async () => {
    await q("insert into public.sandbox_scenarios (workspace_id, name, changes) values ($1, 'Dearer office', $2::jsonb)", [ws, JSON.stringify([{ id: "5c000000-0000-4000-8000-0000000000e1", lever: "C2", target: null, op: "set", value: 98765 }])]);
    const workspace = await workspaceRow();
    const snap = (await loadShareData(editor, workspace, { kind: "process", id: NORTHBEAM_PROCESS_ID }, T0)) as unknown as { scenarios: { name: string; patch: { path: string }[] }[] };
    const office = snap.scenarios.find((s) => s.name === "Dearer office")!;
    expect(office.patch).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain("98765");
    expect(shareSnapshotLeaks(snap, await loadShareSecrets(editor, ws), T0)).toEqual([]);
    const problem = async (s: unknown) => (await q("select private.share_snapshot_problem($1, 'process', $2::jsonb, false, false) as p", [ws, JSON.stringify(s)]))[0]!.p;
    expect(await problem(snap)).toBeNull();
    office.patch = [{ path: "finances.overhead_monthly", op: "set", value: 98765 } as never];
    expect(await problem(snap)).toBe("The snapshot contains costs or margins.");
    // With Financials on the scenario keeps its change.
    const on = (await loadShareData(editor, workspace, { kind: "process", id: NORTHBEAM_PROCESS_ID }, { people: false, financials: true })) as unknown as { scenarios: { name: string; patch: { path: string; value: number }[] }[] };
    expect(on.scenarios.find((s) => s.name === "Dearer office")!.patch).toEqual([{ path: "finances.overhead_monthly", op: "set", value: 98765 }]);
  });
});
