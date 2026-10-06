import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applySuggestion,
  companyOf,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamClientIds,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServiceIds,
  northbeamSourceIds,
  type CompanyModel,
  type SuggestionPatch,
  type SuggestionRow,
  type SuggestionTarget,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Company-model suggestions (issue #25; docs/PRD.md §7.1c, D19): the MCP
// server can only suggest, a person accepts or rejects, accepting applies the
// patch with the evidence as provenance, and every company-model write is
// audit-logged with its actor kind. Plus saved runs' row-level security.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const ads = northbeamLeadSourceIds.ads; // Google Ads: 4 a week
const sam = northbeamPersonIds["Sam Patel"]!;
const chloe = northbeamPersonIds["Chloe Evans"]!;
const client = northbeamClientIds.c01!; // Harbour Lane Dental: SEO, Sam Patel
const salesNotes = northbeamSourceIds.salesNotes;
const evidence = [{ source_id: salesNotes, speaker: "Priya Shah", quote: "Ads bring in fifteen a week now", timestamp: "00:03:10", value: 15 }];

/** An editor's API token, as the MCP server's requests carry it (docs/adr/0002-*). */
const mcp = () => ({ ...users.editor!.claims, api_token_id: randomUUID() });

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@suggestions.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@suggestions.example.com");
});

afterAll(async () => {
  await db?.close();
});

const claim = (c: pg.Client, claims: Record<string, unknown>) =>
  c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);

async function suggest(
  c: pg.Client,
  target: SuggestionTarget,
  targetId: string | null,
  patch: SuggestionPatch,
  extra: { evidence?: unknown[]; note?: string } = {},
): Promise<SuggestionRow> {
  return (
    await c.query(
      "insert into suggestions (workspace_id, target_table, target_id, patch, evidence, note) values ($1, $2, $3, $4, $5, $6) returning *",
      [ws, target, targetId, JSON.stringify(patch), JSON.stringify(extra.evidence ?? []), extra.note ?? null],
    )
  ).rows[0];
}

type Review = { id: string; status: string; message?: string; code?: string; applied?: { target_id: string; before: unknown; after: unknown } };
const review = async (c: pg.Client, ids: string[], decision: "accept" | "reject", note?: string): Promise<Review[]> =>
  (await c.query("select public.review_suggestions($1::uuid[], $2, $3) as r", [ids, decision, note ?? null])).rows[0].r;

const one = async (c: pg.Client, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

/** Read audit_log inside a test's transaction (only managers may read it under RLS), then carry on as the user. */
async function auditRows(c: pg.Client, where = "true", params: unknown[] = []) {
  await c.query("reset role");
  try {
    return (
      await c.query(
        `select actor_id, actor_kind, action, target_table, target_id, diff from audit_log
         where target_table not in ('memberships', 'workspace_domains', 'workspace_access_emails') and (${where})
         order by created_at, id`,
        params,
      )
    ).rows;
  } finally {
    await c.query("set local role authenticated");
  }
}

describe("making suggestions", () => {
  it("the MCP server (an editor's token) creates a pending suggestion and changes no live data", async () => {
    await db.as(mcp(), async (c) => {
      const before = await one(c, "select volume_week, provenance from lead_sources where id = $1", [ads]);
      const s = (
        await c.query(
          "insert into suggestions (workspace_id, target_table, target_id, patch, evidence, status, reviewed_at) values ($1, 'lead_sources', $2, $3, $4, 'accepted', now()) returning *",
          [ws, ads, JSON.stringify({ set: { volume_week: 15 } }), JSON.stringify(evidence)],
        )
      ).rows[0];
      expect(s).toMatchObject({ status: "pending", reviewed_at: null, created_by: users.editor!.id, created_via: "mcp" });
      expect(await one(c, "select volume_week, provenance from lead_sources where id = $1", [ads])).toEqual(before);
    });
  });

  it("everyone in the workspace reads suggestions; members and viewers can't make them; strangers see none", async () => {
    await db.as(users.editor!.claims, (c) => suggest(c, "lead_sources", ads, { set: { volume_week: 15 } }));
    for (const role of ["member", "viewer"]) {
      await expect(db.as(users[role]!.claims, (c) => suggest(c, "lead_sources", ads, { set: { volume_week: 15 } }))).rejects.toThrow(
        /row-level security/,
      );
    }
    // Committed so the readers below can see it.
    await db.client.query("insert into suggestions (workspace_id, target_table, target_id, patch) values ($1, 'lead_sources', $2, $3)", [
      ws,
      ads,
      JSON.stringify({ set: { volume_week: 9 } }),
    ]);
    for (const role of ["owner", "editor", "member", "viewer"]) {
      const n = await db.as(users[role]!.claims, async (c) => (await one(c, "select count(*)::int as n from suggestions")).n);
      expect(n, role).toBeGreaterThan(0);
    }
    expect(await db.as(users.stranger!.claims, async (c) => (await one(c, "select count(*)::int as n from suggestions")).n)).toBe(0);
    await db.client.query("delete from suggestions");
  });

  it("a suggestion can't be edited, marked reviewed directly or deleted", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } });
      await c.query("savepoint a");
      await expect(c.query("update suggestions set patch = $2 where id = $1", [s.id, JSON.stringify({ set: { volume_week: 99 } })])).rejects.toThrow(
        /can't be changed/,
      );
      await c.query("rollback to savepoint a");
      await expect(c.query("update suggestions set status = 'accepted', reviewed_at = now() where id = $1", [s.id])).rejects.toThrow(
        /review_suggestions/,
      );
      await c.query("rollback to savepoint a");
      await expect(c.query("delete from suggestions where id = $1", [s.id])).rejects.toThrow(/permission denied/);
    });
  });

  it("refuses patches that aren't objects with `set`", async () => {
    await expect(db.as(users.editor!.claims, (c) => suggest(c, "people", sam, { roles: [] } as unknown as SuggestionPatch))).rejects.toThrow(
      /suggestions_patch/,
    );
  });
});

describe("the MCP server can't write the company model", () => {
  const writes: [string, string, unknown[]][] = [
    ["people", "update people set fte = 0.5 where id = $1", [sam]],
    ["person_roles", "delete from person_roles where person_id = $1", [sam]],
    ["person_leave", "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2026-12-01', '2026-12-05')", [sam, ws]],
    ["services", "insert into services (workspace_id, name) values ($1, 'Content')", [ws]],
    // Not a delete: nobody signed in deletes a client at all (B19).
    ["clients", "update clients set mrr = 999 where id = $1", [client]],
    ["client_assignments", "update client_assignments set person_id = $2 where client_id = $1 and role_id = $3", [client, chloe, northbeamRoleIds.seo]],
    ["lead_sources", "update lead_sources set volume_week = 15 where id = $1", [ads]],
    ["seasonality", "insert into seasonality (workspace_id, month, multiplier) values ($1, 12, 0.5)", [ws]],
    ["demand_settings", "update demand_settings set growth_monthly = 0.05 where workspace_id = $1", [ws]],
    ["roles", "insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws]],
  ];
  for (const [table, sql, params] of writes) {
    it(`refuses a write to ${table} made with an API token`, async () => {
      await expect(db.as(mcp(), (c) => c.query(sql, params))).rejects.toThrow(/only by review/);
      // The same write as the signed-in editor goes through.
      await db.as(users.editor!.claims, (c) => c.query(sql, params));
    });
  }

  it("refuses an owner's token changing the workspace settings or the roles", async () => {
    const owner = { ...users.owner!.claims, api_token_id: randomUUID() };
    await expect(db.as(owner, (c) => c.query("update workspaces set settings = settings || '{\"hours_per_week\": 35}' where id = $1", [ws]))).rejects.toThrow(
      /only by review/,
    );
    await expect(db.as(owner, (c) => c.query("insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws]))).rejects.toThrow(/only by review/);
  });

  it("refuses to review suggestions over the API", async () => {
    await expect(
      db.as(mcp(), async (c) => {
        const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } });
        return review(c, [s.id], "accept");
      }),
    ).rejects.toThrow(/reviewed by a person/);
  });
});

describe("accepting", () => {
  it("applies the patch with the evidence as provenance, records the review and audit-logs each actor", async () => {
    await db.as(mcp(), async (c) => {
      const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } }, { evidence, note: "Priya's weekly figure" });
      await claim(c, users.editor!.claims);
      const [r] = await review(c, [s.id], "accept");
      expect(r).toMatchObject({ id: s.id, status: "accepted", applied: { target_id: ads, before: { volume_week: 4 }, after: { volume_week: 15 } } });

      const row = await one(c, "select volume_week::float8 as v, provenance from lead_sources where id = $1", [ads]);
      expect(row.v).toBe(15);
      expect(row.provenance.volume_week).toMatchObject({
        source: "estimated",
        by: users.editor!.id,
        note: "Priya's weekly figure",
        evidence,
        suggestion_id: s.id,
      });
      expect(row.provenance.volume_week.assumption).toBeUndefined();
      // Conversion wasn't suggested: its provenance is as it was.
      expect(row.provenance.conversion_to_qualified.source).toBe("estimated");
      expect(row.provenance.conversion_to_qualified.suggestion_id).toBeUndefined();

      const stored = await one(c, "select status, reviewed_by, reviewed_at, applied from suggestions where id = $1", [s.id]);
      expect(stored).toMatchObject({ status: "accepted", reviewed_by: users.editor!.id });
      expect(stored.reviewed_at).not.toBeNull();

      const audit = await auditRows(c, "workspace_id = $1 and target_table in ('suggestions', 'lead_sources')", [ws]);
      // One transaction, so one timestamp: find each entry by what it is.
      const entry = (table: string, action: string) => audit.find((a) => a.target_table === table && a.action === action);
      expect(audit).toHaveLength(3);
      expect(entry("suggestions", "insert")).toMatchObject({ actor_kind: "mcp", actor_id: users.editor!.id, target_id: s.id });
      expect(entry("suggestions", "insert")!.diff.api_token_id).toBeDefined();
      expect(entry("lead_sources", "update")).toMatchObject({ actor_kind: "user", actor_id: users.editor!.id, target_id: ads });
      expect(entry("lead_sources", "update")!.diff).toMatchObject({ old: { volume_week: 4 }, new: { volume_week: 15 }, suggestion_id: s.id });
      expect(entry("suggestions", "accepted")).toMatchObject({ actor_kind: "user", target_id: s.id });
    });
  });

  it("adds a person with their roles and leave, as an estimate without evidence (an assumption)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "people", null, {
        set: { name: "Jo Smith", fte: 0.8, cost_rate: 38 },
        roles: [northbeamRoleIds.seo, northbeamRoleIds.am],
        leave: [{ start_date: "2026-12-21", end_date: "2027-01-01", note: "Christmas" }],
      });
      const [r] = await review(c, [s.id], "accept");
      expect(r!.status).toBe("accepted");
      const id = r!.applied!.target_id;
      expect(r!.applied!.before).toBeNull();
      const person = await one(c, "select name, fte::float8, cost_rate::float8, provenance from people where id = $1", [id]);
      expect(person).toMatchObject({ name: "Jo Smith", fte: 0.8, cost_rate: 38 });
      expect(person.provenance.fte).toMatchObject({ source: "estimated", assumption: true, suggestion_id: s.id });
      expect(person.provenance.name).toBeUndefined();
      const roles = (await c.query("select role_id from person_roles where person_id = $1 order by role_id", [id])).rows.map((x) => x.role_id);
      expect(roles).toEqual([northbeamRoleIds.am, northbeamRoleIds.seo].sort());
      expect((await c.query("select start_date::text, end_date::text, note from person_leave where person_id = $1", [id])).rows).toEqual([
        { start_date: "2026-12-21", end_date: "2027-01-01", note: "Christmas" },
      ]);
    });
  });

  it("adds a client with services and assignments, and reassigns an existing one", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const add = await suggest(c, "clients", null, {
        set: { name: "Fernbrook Vets", mrr: 3500, start_date: "2026-10-01" },
        services: [northbeamServiceIds.seo],
        assignments: { [northbeamRoleIds.seo]: sam },
      });
      const move = await suggest(c, "clients", client, {
        set: { health: 55 },
        services: [northbeamServiceIds.seo, northbeamServiceIds.ppc],
        assignments: { [northbeamRoleIds.seo]: chloe, [northbeamRoleIds.ppc]: sam },
      });
      const results = await review(c, [add.id, move.id], "accept");
      expect(results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
      const added = results[0]!.applied!.target_id;
      expect(await one(c, "select name, mrr::float8, provenance -> 'mrr' ->> 'source' as src from clients where id = $1", [added])).toEqual({
        name: "Fernbrook Vets",
        mrr: 3500,
        src: "estimated",
      });
      expect((await c.query("select role_id, person_id from client_assignments where client_id = $1", [added])).rows).toEqual([
        { role_id: northbeamRoleIds.seo, person_id: sam },
      ]);
      const assigned = Object.fromEntries(
        (await c.query("select role_id, person_id from client_assignments where client_id = $1", [client])).rows.map((x) => [x.role_id, x.person_id]),
      );
      expect(assigned[northbeamRoleIds.seo]).toBe(chloe);
      expect(assigned[northbeamRoleIds.ppc]).toBe(sam);
      expect(assigned[northbeamRoleIds.strat]).toBeDefined();
      expect(results[1]!.applied!.before).toMatchObject({ health: 88, services: [northbeamServiceIds.seo] });
      const services = (await c.query("select service_id from client_services where client_id = $1 order by service_id", [client])).rows;
      expect(services.map((x) => x.service_id)).toEqual([northbeamServiceIds.seo, northbeamServiceIds.ppc]);
    });
  });

  it("changes company settings only for owners; an editor's accept fails and the suggestion stays pending", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "workspaces", null, { set: { hours_per_week: 35, overhead_monthly: 12000 } });
      const [r] = await review(c, [s.id], "accept");
      expect(r).toMatchObject({ status: "failed" });
      expect(r!.message).toMatch(/owners can/);
      expect((await one(c, "select status from suggestions where id = $1", [s.id])).status).toBe("pending");

      await claim(c, users.owner!.claims);
      const [ok] = await review(c, [s.id], "accept");
      expect(ok).toMatchObject({ status: "accepted", applied: { target_id: ws, before: { hours_per_week: 40, overhead_monthly: null } } });
      const w = await one(c, "select settings, provenance from workspaces where id = $1", [ws]);
      expect(w.settings).toMatchObject({ hours_per_week: 35, overhead_monthly: 12000, currency: "GBP" });
      expect(w.provenance["settings.hours_per_week"]).toMatchObject({ source: "estimated", suggestion_id: s.id });
    });
  });

  it("sets demand growth and a month of seasonality, creating the rows when there are none", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const growth = await suggest(c, "demand_settings", null, { set: { growth_monthly: 0.02 } });
      const december = await suggest(c, "seasonality", null, { set: { month: 12, multiplier: 0.6 } });
      await review(c, [growth.id, december.id], "accept");
      const again = await suggest(c, "seasonality", null, { set: { month: 12, multiplier: 0.7 } });
      const [r] = await review(c, [again.id], "accept");
      expect(r!.applied!.before).toEqual({ month: 12, multiplier: 0.6 });
      expect(await one(c, "select growth_monthly::float8 as g, provenance -> 'growth_monthly' ->> 'source' as src from demand_settings where workspace_id = $1", [ws])).toEqual({
        g: 0.02,
        src: "estimated",
      });
      expect((await c.query("select month, multiplier::float8 from seasonality where workspace_id = $1", [ws])).rows).toEqual([{ month: 12, multiplier: 0.7 }]);
    });
  });

  it("in bulk, handles each suggestion on its own: the rest go through when one can't", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const good = await suggest(c, "people", sam, { set: { fte: 0.9 } });
      const bad = await suggest(c, "people", sam, { set: { fte: 5 } }); // fte must be at most 1.5
      const disallowed = await suggest(c, "people", sam, { set: { workspace_id: randomUUID() } });
      const done = await suggest(c, "lead_sources", ads, { set: { volume_week: 6 } });
      await review(c, [done.id], "reject");
      const gone = randomUUID();
      const results = await review(c, [good.id, bad.id, disallowed.id, done.id, gone], "accept");
      expect(results.map((r) => r.status)).toEqual(["accepted", "failed", "failed", "already_reviewed", "not_found"]);
      expect(results[1]!.message).toMatch(/check constraint/);
      expect(results[2]!.message).toMatch(/can't be suggested/);
      expect((await one(c, "select fte::float8 from people where id = $1", [sam])).fte).toBe(0.9);
      const statuses = (await c.query("select id, status from suggestions where id = any($1)", [[bad.id, disallowed.id]])).rows;
      expect(statuses.every((s) => s.status === "pending")).toBe(true);
    });
  });

  it("fails, leaving it pending, when what it changes has been deleted", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } });
      await c.query("delete from lead_sources where id = $1", [ads]);
      const [r] = await review(c, [s.id], "accept");
      expect(r).toMatchObject({ status: "failed", message: "What this suggestion changes no longer exists" });
    });
  });

  it("members and viewers can't review", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } });
      for (const role of ["member", "viewer"]) {
        await claim(c, users[role]!.claims);
        expect((await review(c, [s.id], "accept"))[0]!.status).toBe("not_found");
      }
      expect((await one(c, "select volume_week::float8 as v from lead_sources where id = $1", [ads])).v).toBe(4);
    });
  });
});

describe("rejecting", () => {
  it("records who turned it down and why, and changes nothing", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await suggest(c, "lead_sources", ads, { set: { volume_week: 15 } });
      const [r] = await review(c, [s.id], "reject", "  That was a one-off week  ");
      expect(r).toMatchObject({ status: "rejected" });
      expect(await one(c, "select status, review_note, reviewed_by, applied from suggestions where id = $1", [s.id])).toEqual({
        status: "rejected",
        review_note: "That was a one-off week",
        reviewed_by: users.editor!.id,
        applied: null,
      });
      expect((await one(c, "select volume_week::float8 as v from lead_sources where id = $1", [ads])).v).toBe(4);
      const audit = await auditRows(c, "target_table = 'suggestions' and target_id = $1 and action = 'rejected'", [s.id]);
      expect(audit).toMatchObject([{ action: "rejected", actor_kind: "user", actor_id: users.editor!.id }]);
    });
  });
});

describe("human edits apply live and are audit-logged", () => {
  it("the seed wrote no audit entries for the company model", async () => {
    const n = await one(
      db.client,
      "select count(*)::int as n from audit_log where workspace_id = $1 and target_table not in ('memberships', 'workspace_domains', 'workspace_access_emails')",
      [ws],
    );
    expect(n.n).toBe(0);
  });

  it("a person's FTE saved in settings is entered by them and logged with the old and new value", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await one(c, "select public.save_fields('people', $1, $2, $3) as r", [
        JSON.stringify({ id: sam }),
        JSON.stringify({ fte: 1 }),
        JSON.stringify({ fte: 0.6 }),
      ]);
      expect(r.r.status).toBe("saved");
      const p = await one(c, "select fte::float8, provenance from people where id = $1", [sam]);
      expect(p.fte).toBe(0.6);
      expect(p.provenance.fte).toMatchObject({ source: "entered", by: users.editor!.id });
      const [audit] = await auditRows(c, "target_table = 'people'");
      expect(audit).toMatchObject({ actor_id: users.editor!.id, actor_kind: "user", action: "update", target_id: sam });
      expect(audit.diff.old.fte).toBe(1);
      expect(audit.diff.new.fte).toBe(0.6);
      expect(audit.diff.suggestion_id).toBeUndefined();
    });
  });

  it("a workspace setting saved by its owner is entered, per key, and logged", async () => {
    await db.as(users.owner!.claims, async (c) => {
      await c.query("select public.save_fields('workspaces', $1, $2, $3)", [
        JSON.stringify({ id: ws }),
        JSON.stringify({ "settings.overtime_cap": 0.1 }),
        JSON.stringify({ "settings.overtime_cap": 0.2 }),
      ]);
      const w = await one(c, "select provenance from workspaces where id = $1", [ws]);
      expect(w.provenance["settings.overtime_cap"]).toMatchObject({ source: "entered", by: users.owner!.id });
      expect(w.provenance["settings.hours_per_week"]).toBeUndefined();
      const [audit] = await auditRows(c, "target_table = 'workspaces'");
      expect(audit).toMatchObject({ actor_kind: "user", action: "update", target_id: ws });
      expect(audit.diff.new.settings.overtime_cap).toBe(0.2);
    });
  });

  it("logs inserts and deletes of rows and set members (a new lead source, a role taken away)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into lead_sources (workspace_id, name, volume_week) values ($1, 'Podcast', 2)", [ws]);
      await c.query("delete from person_roles where person_id = $1 and role_id = $2", [sam, northbeamRoleIds.seo]);
      const rows = (await auditRows(c)).sort((a, b) => a.target_table.localeCompare(b.target_table));
      expect(rows.map((r) => [r.target_table, r.action, r.actor_kind])).toEqual([
        ["lead_sources", "insert", "user"],
        ["person_roles", "delete", "user"],
      ]);
      expect(rows[1]).toMatchObject({ target_id: sam, diff: { role_id: northbeamRoleIds.seo } });
      expect(rows[0].diff.new).toMatchObject({ name: "Podcast", provenance: { volume_week: { source: "entered" } } });
    });
  });
});

describe("the demo applies suggestions as the database does", () => {
  it("gives the same rows for the same suggestions", async () => {
    const patches: [SuggestionTarget, string | null, SuggestionPatch][] = [
      ["lead_sources", ads, { set: { volume_week: 15, conversion_to_qualified: 0.4 } }],
      ["lead_sources", null, { set: { name: "Podcast", volume_week: 2 } }],
      ["people", null, { set: { name: "Jo Smith", fte: 0.8 }, roles: [northbeamRoleIds.seo], leave: [{ start_date: "2026-12-21", end_date: "2026-12-31" }] }],
      ["people", sam, { set: { cost_rate: 41 }, roles: [northbeamRoleIds.ppc] }],
      ["clients", client, { set: { mrr: 4000 }, services: [northbeamServiceIds.ppc], assignments: { [northbeamRoleIds.seo]: null, [northbeamRoleIds.ppc]: sam } }],
      ["services", northbeamServiceIds.seo, { set: { price: 3800, churn_monthly_base: 0.025 } }],
      ["demand_settings", null, { set: { growth_monthly: 0.01 } }],
      ["seasonality", null, { set: { month: 8, multiplier: 0.7 } }],
      ["roles", null, { set: { name: "Copywriter" } }],
      ["roles", northbeamRoleIds.fin!, { set: { name: "Finance and admin" } }],
    ];
    let model: CompanyModel = companyOf(northbeamBundle());
    let n = 0;
    await db.as(users.editor!.claims, async (c) => {
      for (const [target, id, patch] of patches) {
        const s = await suggest(c, target, id, patch, { evidence });
        const [r] = await review(c, [s.id], "accept");
        expect(r!.status, `${target} ${JSON.stringify(patch)}`).toBe("accepted");
        const local = applySuggestion(model, s, { at: "2026-10-15T00:00:00Z", by: users.editor!.id, newId: () => `new-${++n}` });
        model = local.model;
        // Same before and after, but for new rows' ids.
        expect({ ...local.applied, target_id: null }).toEqual({ ...r!.applied, target_id: null });
      }
      const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));
      const sources = byName((await c.query("select name, volume_week::float8, conversion_to_qualified::float8 from lead_sources where workspace_id = $1", [ws])).rows);
      expect(sources).toEqual(byName(model.leadSources.map((l) => ({ name: l.name, volume_week: l.volume_week, conversion_to_qualified: l.conversion_to_qualified }))));
      const people = byName(
        (await c.query("select id, name, fte::float8, cost_rate::float8 from people where workspace_id = $1", [ws])).rows.map((p) => ({ ...p, id: undefined })),
      );
      expect(people).toEqual(byName(model.people.map((p) => ({ id: undefined, name: p.name, fte: p.fte, cost_rate: p.cost_rate }))));
      const roleCount = (await one(c, "select count(*)::int as n from person_roles where workspace_id = $1", [ws])).n;
      expect(roleCount).toBe(model.personRoles.length);
      const leave = (await one(c, "select count(*)::int as n from person_leave where workspace_id = $1", [ws])).n;
      expect(leave).toBe(model.personLeave.length);
      const assigned = (await c.query("select role_id, person_id from client_assignments where client_id = $1 order by role_id", [client])).rows;
      expect(assigned).toEqual(
        model.clientAssignments
          .filter((a) => a.client_id === client)
          .map((a) => ({ role_id: a.role_id, person_id: a.person_id }))
          .sort((a, b) => a.role_id.localeCompare(b.role_id)),
      );
      const svc = await one(c, "select price::float8, churn_monthly_base::float8, provenance -> 'price' as prov from services where id = $1", [northbeamServiceIds.seo]);
      const localSvc = model.services.find((s) => s.id === northbeamServiceIds.seo)!;
      expect({ price: svc.price, churn: svc.churn_monthly_base }).toEqual({ price: localSvc.price, churn: localSvc.churn_monthly_base });
      expect({ ...svc.prov, at: null, suggestion_id: null }).toEqual({ ...localSvc.provenance!.price, at: null, suggestion_id: null });
      expect((await c.query("select name from roles where workspace_id = $1", [ws])).rows.map((r) => r.name).sort()).toEqual(
        model.roles.map((r) => r.name).sort(),
      );
      expect((await one(c, "select growth_monthly::float8 as g from demand_settings where workspace_id = $1", [ws])).g).toBe(model.demand!.growth_monthly);
      expect((await c.query("select month, multiplier::float8 from seasonality where workspace_id = $1", [ws])).rows).toEqual(
        model.seasonality.map((m) => ({ month: m.month, multiplier: m.multiplier })),
      );
    });
  });
});

describe("suggesting roles", () => {
  it("accepts a new role and a rename, and refuses a duplicate or a column that can't be suggested", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const created = await suggest(c, "roles", null, { set: { name: "Copywriter" } });
      const [r] = await review(c, [created.id], "accept");
      expect(r!.status).toBe("accepted");
      const row = await one(c, "select id, name, active, provenance from roles where id = $1", [r!.applied!.target_id]);
      expect(row).toMatchObject({ name: "Copywriter", active: true, provenance: {} });
      expect(r!.applied).toEqual({ target_id: row.id, before: null, after: { name: "Copywriter" } });

      const renamed = await suggest(c, "roles", northbeamRoleIds.fin!, { set: { name: "Finance and admin" } });
      const [r2] = await review(c, [renamed.id], "accept");
      expect(r2!.status).toBe("accepted");
      expect(r2!.applied).toEqual({ target_id: northbeamRoleIds.fin, before: { name: "Finance" }, after: { name: "Finance and admin" } });

      const dup = await suggest(c, "roles", null, { set: { name: "copywriter" } });
      const [r3] = await review(c, [dup.id], "accept");
      expect(r3).toMatchObject({ status: "failed", code: "23505" });
      expect((await one(c, "select status from suggestions where id = $1", [dup.id])).status).toBe("pending");

      const bad = await suggest(c, "roles", northbeamRoleIds.fin!, { set: { headcount: 2 } });
      const [r4] = await review(c, [bad.id], "accept");
      expect(r4).toMatchObject({ status: "failed" });
      expect(r4!.message).toMatch(/can't be suggested/);
    });
  });

  it("still refuses a suggestion for any other table", async () => {
    await expect(
      db.as(users.editor!.claims, (c) =>
        c.query("insert into suggestions (workspace_id, target_table, patch) values ($1, 'person_roles', '{\"set\":{}}')", [ws]),
      ),
    ).rejects.toThrow(/suggestions_target_table/);
  });
});

describe("saved runs", () => {
  const insertRun = (c: pg.Client) =>
    c.query(
      "insert into runs (workspace_id, process_id, name, revision_ids, reps, seed, params_snapshot, results) values ($1, $2, 'Baseline', $3, 30, 1, $4, '{}') returning id",
      [ws, NORTHBEAM_PROCESS_ID, [], JSON.stringify({ version: 1 })],
    );

  it("editors save runs; owners and editors read them (B1 2/3: results hold per-person utilisation); members, viewers and strangers can't save", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await insertRun(c)).rowCount).toBe(1);
    });
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => insertRun(c)), role).rejects.toThrow(/row-level security/);
    }
    await db.client.query("insert into runs (workspace_id, name, reps, seed, params_snapshot) values ($1, 'Committed', 30, 1, '{}')", [ws]);
    expect(await db.as(users.editor!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(1);
    expect(await db.as(users.viewer!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(0);
    expect(await db.as(users.stranger!.claims, async (c) => (await one(c, "select count(*)::int as n from runs")).n)).toBe(0);
    await db.client.query("delete from runs");
  });
});
