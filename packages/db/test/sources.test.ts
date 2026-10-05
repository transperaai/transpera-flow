import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  citeEvidence,
  northbeamBundle,
  northbeamSourceIds,
  northbeamSources,
  northbeamStepIds,
  perceptionGaps,
  type StepRow,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Sources, evidence and conflicts (issue #21, migration 20261009000000_sources.sql):
// the sources table under RLS, per-field saves on it, the step `conflict` flag
// following the provenance (so publishing counts conflicts), and the
// perception-gap issue logged when sources differ by 2× or more.

let db: TestDb;
let other: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const audit = northbeamStepIds.audit;
const interview = northbeamSourceIds.strategyInterview;

beforeAll(async () => {
  db = await createTestDb();
  other = (await db.client.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
  await db.client.query("insert into sources (workspace_id, title) values ($1, 'Other interview')", [other]);
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@sources.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@example.com");
});

afterAll(async () => {
  await db?.close();
});

const titles = async (c: pg.Client) => (await c.query("select title from sources order by title")).rows.map((r) => r.title as string);

const openDraft = async (c: pg.Client) => {
  const r = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
  expect(r.status).toBe("ok");
  return r.revision_id as string;
};

const saveStep = async (c: pg.Client, rev: string, id: string, base: object, changes: object) =>
  (
    await c.query("select public.save_fields('steps', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
      JSON.stringify({ revision_id: rev, id }),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as { status: string; row?: Record<string, unknown> };

const stepRow = async (c: pg.Client, rev: string, id: string): Promise<StepRow> =>
  (await c.query("select * from steps where revision_id = $1 and id = $2", [rev, id])).rows[0];

/** Save what citing `value` from Rosa Diaz does to the audit's hands-on time, as the editor would. */
async function citeRosa(c: pg.Client, rev: string, value: number) {
  const step = await stepRow(c, rev, audit);
  const patch = citeEvidence(
    { ...step, work_hours: Number(step.work_hours) },
    "work_hours",
    { source_id: interview, speaker: "Rosa Diaz", quote: "More like twelve hours by the time it goes out.", timestamp: "00:16:40", value },
    { at: "2026-09-30T09:00:00.000Z", by: users.editor!.id },
  );
  const base = Object.fromEntries(
    Object.keys(patch).map((f) => {
      const [col, sub] = f.split(".") as [keyof StepRow & string, string | undefined];
      const v = (step as unknown as Record<string, unknown>)[col];
      return [f, sub ? ((v as Record<string, unknown> | null)?.[sub] ?? null) : v];
    }),
  );
  expect((await saveStep(c, rev, audit, base, patch)).status).toBe("saved");
  return patch;
}

const gapIssues = async (c: pg.Client) =>
  (
    await c.query(
      "select title, evidence, severity, source, status, step_id, detected_key, evidence_metrics, evidence_sources from issues where type = 'perception_gap' order by detected_key",
    )
  ).rows;

describe("seed", () => {
  it("has Northbeam's sources, and step values citing them", async () => {
    const rows = (await db.client.query("select id, kind, title, speakers, recorded_at::text as recorded_at from sources where workspace_id = $1 order by id", [ws])).rows;
    expect(rows).toEqual(
      northbeamSources().map((s) => ({ id: s.id, kind: s.kind, title: s.title, speakers: s.speakers, recorded_at: s.recorded_at })),
    );
    const prov = (await db.client.query("select provenance from steps where id = $1", [audit])).rows[0].provenance;
    expect(prov.work_hours.evidence[0]).toMatchObject({ source_id: interview, speaker: "Maya Collins", value: 6 });
    // Evidence alone is no conflict and no perception gap.
    expect((await db.client.query("select count(*)::int as n from steps where conflict")).rows[0].n).toBe(0);
    expect((await db.client.query("select count(*)::int as n from issues where type = 'perception_gap'")).rows[0].n).toBe(0);
  });
});

describe("row-level security", () => {
  it("lets every member read their workspace's sources, and nobody else's", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      expect(await db.as(users[role]!.claims, titles), role).toEqual(["Sales team notes", "Strategy walkthrough"]);
    }
    expect(await db.as(users.stranger!.claims, titles)).toEqual([]);
  });

  it("lets editors and owners add, edit and delete sources; members and viewers only read", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (
          await c.query(
            "insert into sources (workspace_id, kind, title, speakers, recorded_at) values ($1, 'notes', 'Ops call', array['Rosa Diaz'], '2026-09-20') returning id, created_by",
            [ws],
          )
        ).rows[0];
        expect(id.created_by).toBe(users[role]!.id);
        expect((await c.query("update sources set title = 'Ops call (2)' where id = $1", [id.id])).rowCount).toBe(1);
        expect((await c.query("delete from sources where id = $1", [id.id])).rowCount).toBe(1);
      });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("insert into sources (workspace_id, title) values ($1, 'Nope')", [ws])).rejects.toMatchObject({ code: "42501" });
      });
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update sources set title = 'Changed' where workspace_id = $1", [ws])).rowCount).toBe(0);
        expect((await c.query("delete from sources where workspace_id = $1", [ws])).rowCount).toBe(0);
      });
    }
    // An editor here can't write into another workspace.
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("insert into sources (workspace_id, title) values ($1, 'Nope')", [other])).rejects.toMatchObject({ code: "42501" });
    });
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("delete from sources where workspace_id = $1", [other])).rowCount).toBe(0);
    });
  });

  it("gives anon no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from sources")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("constraints", () => {
  it("checks kind, title, speakers and the file link", async () => {
    const insert = (fields: Record<string, unknown>) => {
      const row = { workspace_id: ws, title: "A source", ...fields };
      const cols = Object.keys(row);
      return db.as(users.editor!.claims, (c) =>
        c.query(`insert into sources (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row)),
      );
    };
    await expect(insert({ kind: "video" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ title: "  " })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ file_url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ speakers: Array.from({ length: 51 }, (_, i) => `P${i}`) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ kind: "screenshot", file_url: "https://files.example.com/board.png" })).resolves.toBeTruthy();
    for (const kind of ["sop", "spreadsheet", "other", "notes", "data"]) await expect(insert({ kind })).resolves.toBeTruthy();
  });
});

describe("per-field saves", () => {
  it("saves a source's fields, speakers as a text array, with compare-and-set", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const save = async (base: object, changes: object) =>
        (
          await c.query("select public.save_fields('sources', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
            JSON.stringify({ id: interview }),
            JSON.stringify(base),
            JSON.stringify(changes),
          ])
        ).rows[0].r;
      expect((await save({ speakers: ["Maya Collins", "Rosa Diaz"] }, { speakers: ["Maya Collins", "Rosa Diaz", "Leah Brooks"] })).status).toBe("saved");
      expect((await c.query("select speakers from sources where id = $1", [interview])).rows[0].speakers).toEqual([
        "Maya Collins",
        "Rosa Diaz",
        "Leah Brooks",
      ]);
      const stale = await save({ title: "Old title" }, { title: "New title" });
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ title: "Strategy walkthrough" });
    });
    await db.as(users.viewer!.claims, async (c) => {
      const r = (
        await c.query("select public.save_fields('sources', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
          JSON.stringify({ id: interview }),
          JSON.stringify({ title: "Strategy walkthrough" }),
          JSON.stringify({ title: "Mine" }),
        ])
      ).rows[0].r;
      expect(r.status).toBe("not_found");
    });
  });
});

describe("conflicts", () => {
  it("turns a disagreement into a triangular range, flags the step, and publishing counts it", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      await citeRosa(c, rev, 12);
      const row = await stepRow(c, rev, audit);
      expect(row.conflict).toBe(true);
      expect(row.work_dist).toBe("triangular");
      expect(row.work_params).toEqual({ min: 6, mode: 9, max: 12 });
      expect(Number(row.work_hours)).toBe(9);
      expect(row.provenance.work_hours!.conflict!.values).toEqual([
        { value: 6, source_id: interview, speaker: "Maya Collins" },
        { value: 12, source_id: interview, speaker: "Rosa Diaz" },
      ]);

      const refused = (await c.query("select public.publish_process($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      expect(refused.status).toBe("unresolved");
      expect(refused.steps).toEqual([{ id: audit, name: "Audit & proposal", assumption: false, conflict: true }]);
    });
  });

  it("flags the step even when a writer records the conflict without the flag", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      const conflict = { values: [{ value: 1, source_id: null, speaker: null }, { value: 1.5, source_id: interview, speaker: "Maya Collins" }] };
      await c.query("update steps set provenance = jsonb_set(provenance, '{wait_hours}', $1::jsonb) where revision_id = $2 and id = $3", [
        JSON.stringify({ source: "entered", conflict }),
        rev,
        northbeamStepIds.qualify,
      ]);
      expect((await stepRow(c, rev, northbeamStepIds.qualify)).conflict).toBe(true);
      // Under 2× apart: no perception gap.
      expect(await gapIssues(c)).toEqual([]);
      // Resolved: the flag can be cleared, and stays cleared.
      await c.query(
        "update steps set conflict = false, provenance = jsonb_set(provenance, '{wait_hours,conflict,resolved}', $1::jsonb) where revision_id = $2 and id = $3",
        [JSON.stringify({ at: "2026-09-30T10:00:00Z", choice: "range" }), rev, northbeamStepIds.qualify],
      );
      expect((await stepRow(c, rev, northbeamStepIds.qualify)).conflict).toBe(false);
    });
  });
});

describe("perception gaps", () => {
  it("logs one tracked perception_gap issue when sources differ by 2× or more, matching the app's text", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      await citeRosa(c, rev, 12);
      const row = await stepRow(c, rev, audit);
      const [gap] = perceptionGaps([row]);
      expect(gap).toBeDefined();
      const issues = await gapIssues(c);
      expect(issues).toEqual([
        {
          title: gap!.title,
          evidence: gap!.evidence,
          severity: "warning",
          source: "promoted",
          status: "open",
          step_id: audit,
          detected_key: gap!.key,
          evidence_metrics: { min: 6, max: 12, ratio: 2 },
          evidence_sources: row.provenance.work_hours!.evidence,
        },
      ]);
      expect(gap!.title).toBe("Sources disagree on Audit & proposal: hands-on time");
      expect(gap!.evidence).toBe("Maya Collins: 6 h; Rosa Diaz: 12 h (2× apart). Measure it before relying on it.");

      // Saving the step again, or another value, doesn't log it twice.
      expect((await saveStep(c, rev, audit, { name: "Audit & proposal" }, { name: "Audit and proposal" })).status).toBe("saved");
      await citeRosa(c, rev, 14);
      expect(await gapIssues(c)).toHaveLength(1);

      // People can work and close it like any tracked issue.
      expect((await c.query("update issues set status = 'dismissed' where type = 'perception_gap'")).rowCount).toBe(1);
    });
  });

  it("logs nothing under 2×, and says so when one source says none", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      await citeRosa(c, rev, 11);
      expect(await gapIssues(c)).toEqual([]);
    });
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      const conflict = { values: [{ value: 0, source_id: interview, speaker: "Maya Collins" }, { value: 8, source_id: interview, speaker: "Rosa Diaz" }] };
      await c.query("update steps set provenance = jsonb_set(provenance, '{wait_hours}', $1::jsonb) where revision_id = $2 and id = $3", [
        JSON.stringify({ source: "estimated", conflict }),
        rev,
        audit,
      ]);
      const [issue] = await gapIssues(c);
      expect(issue.evidence).toBe("Maya Collins: 0 h; Rosa Diaz: 8 h (one says none). Measure it before relying on it.");
      expect(issue.evidence_metrics).toEqual({ min: 0, max: 8 });
      expect(perceptionGaps([await stepRow(c, rev, audit)]).map((g) => g.evidence)).toEqual([issue.evidence]);
    });
  });

  it("leaves retired steps alone: a split step's old row is neither flagged nor logged (issue #16)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const rev = await openDraft(c);
      const conflict = { values: [{ value: 6, source_id: interview, speaker: "Maya Collins" }, { value: 12, source_id: interview, speaker: "Rosa Diaz" }] };
      await c.query(
        "update steps set replaced_by = array[$1::uuid], conflict = false, provenance = jsonb_set(provenance, '{work_hours}', $2::jsonb) where revision_id = $3 and id = $4",
        [northbeamStepIds.kickoff, JSON.stringify({ source: "estimated", conflict }), rev, audit],
      );
      expect((await stepRow(c, rev, audit)).conflict).toBe(false);
      expect(await gapIssues(c)).toEqual([]);
      const r = (await c.query("select public.publish_process($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      expect(r.status).toBe("published");
    });
  });

  it("is written by the trigger, not the user: a member can't log one by editing a step", async () => {
    // Members can't edit steps at all, so they can't trigger one either.
    await db.as(users.member!.claims, async (c) => {
      const r = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
      expect(r.status).toBe("not_found");
    });
    expect(northbeamBundle().steps.every((s) => !s.conflict)).toBe(true);
  });
});
