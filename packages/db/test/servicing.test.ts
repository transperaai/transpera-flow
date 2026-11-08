import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  ModelError,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  bundleForProcess,
  engineRecurrence,
  northbeamBundle,
  northbeamServiceIds,
  northbeamServicingProcessIds,
  northbeamServicingStepIds,
  parseRecurrence,
  toEngineModel,
  unpublishedLive,
  type ProcessBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Client servicing (issue #19): the `service_servicing` table and its checks,
// row-level security and per-field saves; how servicing processes resolve
// for the engine, from the pipeline and from a servicing process itself.

const START = "2026-10-05";
const ws = NORTHBEAM_WORKSPACE_ID;
const report = northbeamServicingProcessIds.report!;
const checkin = northbeamServicingProcessIds.checkin!;

describe("toEngineModel with servicing (pure)", () => {
  it("a servicing process's bundle simulates the same business as the pipeline's", () => {
    const b = northbeamBundle();
    const fromPipeline = toEngineModel(b, { startDate: START });
    const fromReport = toEngineModel(bundleForProcess(b, report)!, { startDate: START });
    expect(fromReport).toEqual(fromPipeline);
    expect(Object.keys(fromPipeline.servicingProcesses!).sort()).toEqual([report, checkin].sort());
    const seo = fromPipeline.services![northbeamServiceIds.seo]!;
    expect(seo.servicing).toEqual([
      { process: report, recurrence: { every: "month", times: 1 }, sla: 40 },
      { process: checkin, recurrence: { every: "week", times: 0.5 }, sla: 16 },
    ]);
    expect(seo.churnSensitivity).toBe(3);
    // Servicing ends are `done` ends: a task books nothing.
    expect(fromPipeline.ends![northbeamServicingStepIds.report_sent!]).toEqual({ outcome: "done" });
  });

  it("uses the servicing bundle's own revision: an edit to its draft reaches the model", () => {
    const b = bundleForProcess(northbeamBundle(), checkin)!;
    const call = northbeamServicingStepIds.checkin_call!;
    const draft: ProcessBundle = { ...b, steps: b.steps.map((s) => (s.id === call ? { ...s, work_hours: 3 } : s)) };
    expect(toEngineModel(draft, { startDate: START }).steps.find((s) => s.id === call)!.work).toBe(3);
  });

  it("an unlinked servicing process being edited is simulated too, so its steps show results", () => {
    const b = northbeamBundle();
    const unlinked = bundleForProcess({ ...b, servicingLinks: b.servicingLinks!.filter((l) => l.process_id !== checkin) }, checkin)!;
    const model = toEngineModel(unlinked, { startDate: START });
    expect(model.servicingProcesses![checkin]).toBeDefined();
    expect(Object.values(model.services!).every((sv) => sv.servicing!.every((l) => l.process === report))).toBe(true);
    const r = simulate(model, 2, 1);
    expect(r.steps[northbeamServicingStepIds.checkin_call!]!.arrivals).toBe(0);
  });

  it("needs a pipeline to run beside", () => {
    const b = bundleForProcess(northbeamBundle(), report)!;
    expect(() => toEngineModel({ ...b, otherProcesses: b.otherProcesses!.filter((p) => p.process.kind === "servicing") })).toThrow(ModelError);
  });

  it("names a broken servicing process, and leaves out links it can't use", () => {
    const b = northbeamBundle();
    const broken = {
      ...b,
      otherProcesses: b.otherProcesses!.map((p) => (p.process.id === report ? { ...p, edges: p.edges.slice(1) } : p)),
    };
    expect(() => toEngineModel(broken, { startDate: START })).toThrow(/Servicing process 'Monthly report'/);
    const odd = {
      ...b,
      servicingLinks: b.servicingLinks!.map((l) =>
        l.process_id === checkin ? { ...l, recurrence: { every: "fortnight", times: 1 } as never } : l,
      ),
    };
    const model = toEngineModel(odd, { startDate: START });
    expect(Object.keys(model.servicingProcesses!)).toEqual([report]);
    // A link to the pipeline itself (not a servicing process) is ignored.
    const toPipeline = { ...b, servicingLinks: b.servicingLinks!.map((l) => ({ ...l, process_id: NORTHBEAM_PROCESS_ID })) };
    expect(toEngineModel(toPipeline, { startDate: START })).not.toHaveProperty("servicingProcesses");
  });

  it("maps the workspace's health rules when set, and leaves them out otherwise", () => {
    const b = northbeamBundle();
    expect(toEngineModel(b, { startDate: START })).not.toHaveProperty("health");
    const set = { ...b, workspace: { ...b.workspace, settings: { ...b.workspace.settings, health_recover: 3, health_missed_penalty: 20 } } };
    expect(toEngineModel(set, { startDate: START }).health).toEqual({ recover: 3, missedPenalty: 20 });
  });

  it("a never-published process's stand-in live revision is empty", () => {
    const live = unpublishedLive(bundleForProcess(northbeamBundle(), report)!);
    expect(live.steps).toEqual([]);
    expect(live.revision.number).toBe(0);
  });

  it("reads recurrences, numbers as strings included", () => {
    expect(engineRecurrence({ every: "month", times: "2" })).toEqual({ every: "month", times: 2 });
    expect(engineRecurrence({ poisson_per_month: 1.5 })).toEqual({ poissonPerMonth: 1.5 });
    expect(engineRecurrence({ every: "day", times: 1 })).toBeNull();
  });
});

describe("service_servicing (database)", () => {
  let db: TestDb;
  const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

  beforeAll(async () => {
    db = await createTestDb();
    for (const role of ["owner", "editor", "member", "viewer"] as const) {
      users[role] = await createUser(db, `${role}@servicing.example.com`);
      await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
    }
    users.stranger = await createUser(db, "stranger@servicing.example.com");
  });

  afterAll(async () => {
    await db?.close();
  });

  const saveFields = async (c: pg.Client, key: object, base: object, changes: object) =>
    (
      await c.query("select public.save_fields('service_servicing', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
        JSON.stringify(key),
        JSON.stringify(base),
        JSON.stringify(changes),
      ])
    ).rows[0].r as { status: string; row?: Record<string, unknown>; conflicts?: Record<string, unknown> };

  it("seeds Northbeam's two published servicing processes, linked to both services", async () => {
    const processes = (
      await db.client.query("select name, kind, live_revision_id is not null as live from processes where workspace_id = $1 and not is_company order by id", [ws])
    ).rows;
    expect(processes).toEqual([
      { name: "Lead to live", kind: "pipeline", live: true },
      { name: "Monthly report", kind: "servicing", live: true },
      { name: "Client check-in", kind: "servicing", live: true },
    ]);
    const links = (await db.client.query("select service_id, process_id, recurrence, sla_hours::float8 as sla from service_servicing where workspace_id = $1 order by id", [ws])).rows;
    expect(links).toHaveLength(4);
    expect(links[0]).toEqual({ service_id: northbeamServiceIds.seo, process_id: report, recurrence: { every: "month", times: 1 }, sla: 40 });
    const prov = (await db.client.query("select provenance from service_servicing where workspace_id = $1 limit 1", [ws])).rows[0].provenance;
    expect(prov.recurrence.source).toBe("estimated");
  });

  it("checks the recurrence exactly as parseRecurrence does", async () => {
    const cases: unknown[] = [
      { every: "month", times: 1 },
      { every: "week", times: 0.5 },
      { every: "week", times: 100 },
      { every: "week", times: 101 },
      { every: "week", times: 0 },
      { every: "week", times: -1 },
      { every: "week", times: "2" },
      { every: "day", times: 1 },
      { every: "week" },
      { every: "week", times: 1, extra: true },
      { poisson_per_month: 3 },
      { poisson_per_month: 0 },
      { poisson_per_month: 1001 },
      { poisson_per_month: null },
      [],
      "monthly",
      null,
      {},
    ];
    for (const r of cases) {
      const sql = (await db.client.query("select private.is_recurrence($1::jsonb) as ok", [JSON.stringify(r)])).rows[0].ok;
      expect(sql ?? false, JSON.stringify(r)).toBe(parseRecurrence(r) !== null);
    }
  });

  it("every member reads links; strangers see none", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("select count(*)::int as n from service_servicing")).rows[0].n, role).toBe(4);
      });
    }
    await db.as(users.stranger!.claims, async (c) => {
      expect((await c.query("select count(*)::int as n from service_servicing")).rows[0].n).toBe(0);
    });
  });

  it("owners and editors link, change and unlink; members and viewers can't", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        await c.query("delete from service_servicing where service_id = $1 and process_id = $2", [northbeamServiceIds.ppc, checkin]);
        const inserted = await c.query(
          "insert into service_servicing (workspace_id, service_id, process_id, recurrence, sla_hours) values ($1, $2, $3, $4, 8) returning provenance",
          [ws, northbeamServiceIds.ppc, checkin, JSON.stringify({ poisson_per_month: 2 })],
        );
        expect(inserted.rows[0].provenance.recurrence.source).toBe("entered");
        expect((await c.query("update service_servicing set sla_hours = 24 where process_id = $1", [checkin])).rowCount).toBe(2);
      });
    }
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update service_servicing set sla_hours = 24")).rowCount).toBe(0);
        expect((await c.query("delete from service_servicing")).rowCount).toBe(0);
        await expect(
          c.query("insert into service_servicing (workspace_id, service_id, process_id) values ($1, $2, $3)", [ws, northbeamServiceIds.ppc, report]),
        ).rejects.toThrow(/row-level security/);
      });
    }
  });

  it("is company model (issue #25): the MCP server can't write links, and people's writes are audited (read by owners)", async () => {
    const mcp = { ...users.editor!.claims, api_token_id: "00000000-0000-4000-8000-000000000999" };
    await db.as(mcp, async (c) => {
      await expect(c.query("update service_servicing set sla_hours = 12")).rejects.toThrow(/can't be changed through an API token/);
    });
    await db.as(users.owner!.claims, async (c) => {
      await c.query("update service_servicing set sla_hours = 12 where service_id = $1 and process_id = $2", [northbeamServiceIds.seo, checkin]);
      const audit = (
        await c.query("select actor_kind, action, diff from audit_log where target_table = 'service_servicing' order by created_at desc limit 1")
      ).rows[0];
      expect(audit).toMatchObject({ actor_kind: "user", action: "update" });
      expect(audit.diff.new.sla_hours).toBe(12);
    });
  });

  it("refuses anon entirely", async () => {
    const r = await db.client.query("select has_table_privilege('anon', 'public.service_servicing', 'select') as s");
    expect(r.rows[0].s).toBe(false);
  });

  it("links only servicing processes, and a linked process stays one", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("delete from service_servicing where process_id = $1", [report]);
      await expect(
        c.query("insert into service_servicing (workspace_id, service_id, process_id) values ($1, $2, $3)", [ws, northbeamServiceIds.seo, NORTHBEAM_PROCESS_ID]),
      ).rejects.toThrow(/Only a servicing process/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("update processes set kind = 'pipeline' where id = $1", [checkin])).rejects.toThrow(/linked to services/);
    });
    await db.as(users.editor!.claims, async (c) => {
      // Unlinked, it can change kind.
      await c.query("delete from service_servicing where process_id = $1", [checkin]);
      expect((await c.query("update processes set kind = 'pipeline' where id = $1", [checkin])).rowCount).toBe(1);
    });
  });

  it("rejects malformed recurrences and SLAs, and duplicate links", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("update service_servicing set recurrence = '{\"every\": \"day\", \"times\": 1}'")).rejects.toThrow(/service_servicing_recurrence/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("update service_servicing set sla_hours = 0")).rejects.toThrow(/check/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(
        c.query("insert into service_servicing (workspace_id, service_id, process_id) values ($1, $2, $3)", [ws, northbeamServiceIds.seo, report]),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("saves a link's fields with save_fields, checked against what the editor saw", async () => {
    const id = (await db.client.query("select id from service_servicing where service_id = $1 and process_id = $2", [northbeamServiceIds.seo, report])).rows[0].id;
    await db.as(users.editor!.claims, async (c) => {
      const saved = await saveFields(c, { id }, { sla_hours: 40, recurrence: { every: "month", times: 1 } }, { sla_hours: 24, recurrence: { every: "month", times: 2 } });
      expect(saved.status).toBe("saved");
      expect(saved.row!.recurrence).toEqual({ every: "month", times: 2 });
      expect((saved.row!.provenance as Record<string, { source: string }>).sla_hours!.source).toBe("entered");
      const stale = await saveFields(c, { id }, { sla_hours: 40 }, { sla_hours: 16 });
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ sla_hours: 24 });
    });
    await db.as(users.viewer!.claims, async (c) => {
      expect((await saveFields(c, { id }, { sla_hours: 40 }, { sla_hours: 16 })).status).toBe("not_found");
    });
  });

  it("goes with its process or service", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("delete from processes where id = $1", [report]);
      expect((await c.query("select count(*)::int as n from service_servicing where process_id = $1", [report])).rows[0].n).toBe(0);
      await c.query("delete from services where id = $1", [northbeamServiceIds.ppc]);
      expect((await c.query("select count(*)::int as n from service_servicing")).rows[0].n).toBe(1);
    });
  });

  it("a signed-in editor builds a new servicing process through a draft", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const proc = (
        await c.query("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Quarterly review', 'servicing', 'review') returning id", [ws])
      ).rows[0].id;
      const draft = (await c.query("select public.open_draft($1) as r", [proc])).rows[0].r;
      expect(draft.status).toBe("ok");
      await c.query(
        "insert into steps (revision_id, workspace_id, process_id, name, kind, outcome) values ($1, $2, $3, 'Review due', 'start', null), ($1, $2, $3, 'Done', 'end', 'done')",
        [draft.revision_id, ws, proc],
      );
      await c.query("insert into service_servicing (workspace_id, service_id, process_id, recurrence) values ($1, $2, $3, $4)", [
        ws,
        northbeamServiceIds.seo,
        proc,
        JSON.stringify({ every: "month", times: 0.33 }),
      ]);
      const published = (await c.query("select public.publish_process($1) as r", [proc])).rows[0].r;
      expect(published.status).toBe("published");
      // Once published, its steps change only through a draft.
      await expect(c.query("update steps set name = 'x' where revision_id = $1", [published.revision_id])).rejects.toThrow(/edits go into/);
    });
  });
});
