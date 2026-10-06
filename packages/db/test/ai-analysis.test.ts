import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// AI analysis storage (issue #111, A46): five switches per workspace, one analysis per process version, and an
// append-only log of model runs (`ai_runs`, written only by `reserve_ai_run`) that bounds the cost. Every member reads;
// owners and editors write as themselves; an analysis must name a run its writer reserved; nobody can delete runs or
// analyses; anon has nothing; no one reaches another workspace's rows.

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const live = NORTHBEAM_REVISION_ID;
let db: TestDb;
let otherWs: string;
let otherProc: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

/** Reserve a run as the connected user: the run id, or the refusal. */
async function reserve(c: pg.Client, process = proc, workspace = ws, trigger = "publish") {
  return (await c.query("select public.reserve_ai_run($1, $2, $3) as r", [workspace, process, trigger])).rows[0].r as { status: string; id?: string; retry_after_seconds?: number };
}

/** Reserve a run and insert an analysis of `revision` against it, as the connected user. */
async function analysis(c: pg.Client, revision = live, extra = "", run?: string) {
  const runId = run ?? (await reserve(c)).id;
  return c.query(
    `insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id ${extra ? ", " + extra.split("=")[0] : ""})
     values ($1, $2, $3, 'ok', 'publish', 'h1', $4 ${extra ? ", " + extra.split("=").slice(1).join("=") : ""}) returning id`,
    [ws, proc, revision, runId],
  );
}

/** Seed an analysis as the administrator (triggers off, as a restore would): for tests that read or try to change one. */
async function seedAnalysis(summary = "[]", status = "ok") {
  await db.client.query("begin");
  await db.client.query("set local session_replication_role = replica");
  const run = (await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, user_name, started_at) values ($1, $2, 'publish', $3, 'Ed Itor', now() - interval '2 hours') returning id", [ws, proc, users.editor!.id])).rows[0].id;
  await db.client.query("insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, summary, run_id, created_by) values ($1, $2, $3, $4, 'publish', 'h', $5, $6, $7)", [ws, proc, live, status, summary, run, users.editor!.id]);
  await db.client.query("commit");
}

/** Fresh runs the editor (or `user`) holds, as the administrator: ids to write analyses against without the cooldown in the way. */
async function freshRuns(n: number, user = users.editor!.id, age = "1 minute") {
  const rows = (await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, started_at) select $1, $2, 'manual', $3, now() - $4::interval from generate_series(1, $5) returning id", [ws, proc, user, age, n])).rows;
  return rows.map((r) => r.id as string);
}

/** `n` runs of the workspace, started `ago` ago, as the administrator. */
async function seedRuns(n: number, ago = "1 hour", process = proc) {
  await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, started_at) select $1, $2, 'manual', $3, now() - $4::interval from generate_series(1, $5)", [ws, process, users.editor!.id, ago, n]);
}

const clean = async () => {
  await db.client.query("delete from ai_runs");
  await db.client.query("delete from ai_settings");
};

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@ai.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@ai.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-ai') returning id")).rows[0].id;
  otherProc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Theirs') returning id", [otherWs])).rows[0].id;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWs, users.stranger!.id]);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(clean);

describe("ai_settings", () => {
  it("has no row until someone saves, and a row defaults to the prototype's switches with reading sources off", async () => {
    expect((await db.client.query("select 1 from ai_settings")).rowCount).toBe(0);
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into ai_settings (workspace_id) values ($1)", [ws]);
      expect((await c.query("select review_on_publish, review_on_market, suggest_issues, suggest_solutions, read_sources, market_pending_at from ai_settings")).rows[0]).toEqual({
        review_on_publish: true,
        review_on_market: true,
        suggest_issues: true,
        suggest_solutions: true,
        read_sources: false,
        market_pending_at: null,
      });
    });
  });

  it("changes one switch without touching the others (the app's one-column upsert)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("insert into ai_settings (workspace_id, suggest_issues) values ($1, false) on conflict (workspace_id) do update set suggest_issues = excluded.suggest_issues", [ws]);
      await c.query("insert into ai_settings (workspace_id, read_sources) values ($1, true) on conflict (workspace_id) do update set read_sources = excluded.read_sources", [ws]);
      expect((await c.query("select review_on_publish, suggest_issues, read_sources from ai_settings")).rows[0]).toEqual({ review_on_publish: true, suggest_issues: false, read_sources: true });
    });
  });

  it("lets every member read and only owners and editors write", async () => {
    await db.client.query("insert into ai_settings (workspace_id, review_on_market) values ($1, false)", [ws]);
    for (const role of ["owner", "editor", "member", "viewer"]) {
      const rows = await db.as(users[role]!.claims, async (c) => (await c.query("select review_on_market from ai_settings")).rows);
      expect(rows, role).toEqual([{ review_on_market: false }]);
    }
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update ai_settings set review_on_market = true")).rowCount, role).toBe(1);
      });
    }
    for (const role of ["owner", "editor", "member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("delete from ai_settings"), `${role} can't delete`).rejects.toThrow(/permission denied/);
      });
    }
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update ai_settings set review_on_market = true")).rowCount, role).toBe(0);
      });
    }
  });

  it("hides another workspace's switches and stops its members writing here", async () => {
    await db.client.query("insert into ai_settings (workspace_id) values ($1)", [ws]);
    await db.as(users.stranger!.claims, async (c) => {
      expect((await c.query("select 1 from ai_settings")).rowCount).toBe(0);
      expect((await c.query("update ai_settings set read_sources = true")).rowCount).toBe(0);
    });
    await db.as(users.stranger!.claims, async (c) => {
      await expect(c.query("insert into ai_settings (workspace_id) values ($1)", [randomUUID()])).rejects.toThrow(/row-level security|foreign key/);
    });
  });

  it("goes with its workspace", async () => {
    const w = (await db.client.query("insert into workspaces (name, slug) values ('Gone', 'gone-ai') returning id")).rows[0].id;
    await db.client.query("insert into ai_settings (workspace_id) values ($1)", [w]);
    await db.client.query("delete from workspaces where id = $1", [w]);
    expect((await db.client.query("select 1 from ai_settings where workspace_id = $1", [w])).rowCount).toBe(0);
  });

  it("debounces the market trigger: only the latest mark can be claimed, once", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const first = "2026-10-01T12:00:00.123Z";
      const later = "2026-10-01T12:00:05.456Z";
      await c.query("insert into ai_settings (workspace_id, market_pending_at) values ($1, $2) on conflict (workspace_id) do update set market_pending_at = excluded.market_pending_at", [ws, first]);
      await c.query("insert into ai_settings (workspace_id, market_pending_at) values ($1, $2) on conflict (workspace_id) do update set market_pending_at = excluded.market_pending_at", [ws, later]);
      const claim = async (mark: string) => (await c.query("update ai_settings set market_pending_at = null where workspace_id = $1 and market_pending_at = $2 returning 1", [ws, mark])).rowCount;
      expect(await claim(first), "an earlier change's run finds the mark moved").toBe(0);
      expect(await claim(later)).toBe(1);
      expect(await claim(later), "claimed once").toBe(0);
    });
  });
});

describe("reserve_ai_run: who may reserve", () => {
  it("names the run after the person linked to the member (People), never an email or user metadata", async () => {
    const person = (await db.client.query("insert into people (workspace_id, name, email) values ($1, 'Pat Linked', 'pat@secret.example') returning id", [ws])).rows[0].id;
    await db.client.query("update memberships set person_id = $1 where workspace_id = $2 and user_id = $3", [person, ws, users.editor!.id]);
    await db.client.query("update auth.users set raw_user_meta_data = jsonb_build_object('full_name', 'Spoofed Name'), email = 'editor@ai.example.com' where id = $1", [users.editor!.id]);
    await db.as(users.editor!.claims, async (c) => {
      const r = await reserve(c);
      expect((await c.query("select user_name from ai_runs where id = $1", [r.id])).rows[0].user_name).toBe("Pat Linked");
    });
    // Unlinked: no name at all, not the email and not the metadata.
    await db.client.query("update memberships set person_id = null where workspace_id = $1 and user_id = $2", [ws, users.owner!.id]);
    await db.client.query("update auth.users set raw_user_meta_data = jsonb_build_object('full_name', 'Owner Spoof') where id = $1", [users.owner!.id]);
    await db.as(users.owner!.claims, async (c) => {
      const r = await reserve(c);
      expect((await c.query("select user_name from ai_runs where id = $1", [r.id])).rows[0].user_name).toBeNull();
    });
    // A viewer reads the log and sees no email anywhere in it.
    await db.client.query("delete from ai_runs");
    await db.as(users.editor!.claims, async (c) => {
      await reserve(c);
    });
    await db.client.query("update ai_runs set started_at = now() - interval '5 minutes'");
    await db.as(users.owner!.claims, async (c) => {
      await reserve(c);
    });
    await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, user_name) values ($1, $2, 'manual', $3, 'x')", [ws, proc, users.owner!.id]);
    const seen = await db.as(users.viewer!.claims, async (c) => (await c.query("select * from ai_runs")).rows);
    expect(JSON.stringify(seen)).not.toMatch(/@/);
    await db.client.query("delete from ai_runs");
    await db.client.query("update people set name = name where id = $1", [person]);
  });

  it("lets owners and editors reserve a run, which is logged with who and when", async () => {
    for (const role of ["owner", "editor"]) {
      await db.client.query("delete from ai_runs");
      await db.as(users[role]!.claims, async (c) => {
        const r = await reserve(c);
        expect(r.status, role).toBe("ok");
        const row = (await c.query("select workspace_id, process_id, trigger, user_id, started_at from ai_runs where id = $1", [r.id])).rows[0];
        expect(row).toMatchObject({ workspace_id: ws, process_id: proc, trigger: "publish", user_id: users[role]!.id });
      });
    }
  });

  it("refuses members, viewers and strangers, and a process of another workspace, and a made-up trigger", async () => {
    for (const role of ["member", "viewer", "stranger"]) {
      await db.as(users[role]!.claims, async (c) => expect((await reserve(c)).status, role).toBe("forbidden"));
    }
    await db.as(users.editor!.claims, async (c) => {
      expect((await reserve(c, otherProc)).status, "another workspace's process").toBe("forbidden");
      expect((await reserve(c, proc, otherWs)).status, "another workspace").toBe("forbidden");
      expect((await reserve(c, proc, ws, "cron")).status, "trigger").toBe("forbidden");
      expect((await reserve(c, randomUUID())).status, "no such process").toBe("forbidden");
    });
    expect((await db.client.query("select 1 from ai_runs")).rowCount).toBe(0);
  });

  it("is not callable by anon", async () => {
    await db.client.query("begin");
    await db.client.query("set local role anon");
    await expect(db.client.query("select public.reserve_ai_run($1, $2, 'manual')", [ws, proc])).rejects.toThrow(/permission denied/);
    await db.client.query("rollback");
  });
});

describe("reserve_ai_run: the daily cap and the cooldown", () => {
  it("refuses a second run of the same process within 60 seconds, and says when to try again", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await reserve(c)).status).toBe("ok");
      const again = await reserve(c);
      expect(again.status).toBe("cooldown");
      expect(again.retry_after_seconds).toBeGreaterThan(0);
      expect(again.retry_after_seconds).toBeLessThanOrEqual(60);
      expect((await c.query("select count(*)::int as n from ai_runs")).rows[0].n, "a refusal logs nothing").toBe(1);
    });
  });

  it("allows it again after 60 seconds, and counts other processes separately", async () => {
    await seedRuns(1, "61 seconds");
    await db.as(users.editor!.claims, async (c) => expect((await reserve(c)).status).toBe("ok"));
    await clean();
    await seedRuns(1, "10 seconds");
    const other = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Second') returning id", [ws])).rows[0].id;
    await db.as(users.editor!.claims, async (c) => {
      expect((await reserve(c)).status, "same process, 10 s ago").toBe("cooldown");
      expect((await reserve(c, other)).status, "another process").toBe("ok");
    });
    await db.client.query("delete from processes where id = $1", [other]);
  });

  it("refuses the 41st run in 24 hours for the workspace, whoever asks and whichever process", async () => {
    await seedRuns(39, "2 hours");
    await db.as(users.editor!.claims, async (c) => expect((await reserve(c)).status, "the 40th").toBe("ok"));
    await seedRuns(1, "3 hours");
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => expect((await reserve(c)).status, role).toBe("limit"));
    }
  });

  it("counts only the last 24 hours, and only this workspace", async () => {
    await seedRuns(60, "25 hours");
    await db.client.query("insert into ai_runs (workspace_id, process_id, trigger) select $1, $2, 'manual' from generate_series(1, 60)", [otherWs, otherProc]);
    await db.as(users.editor!.claims, async (c) => expect((await reserve(c)).status).toBe("ok"));
  });

  it("can't be reset by an editor: runs and analyses can't be deleted, runs can't be written or edited", async () => {
    await seedRuns(40);
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("delete from ai_runs"), role).rejects.toThrow(/permission denied/);
      });
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("update ai_runs set started_at = now() - interval '2 days'"), role).rejects.toThrow(/permission denied/);
      });
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("insert into ai_runs (workspace_id, process_id, trigger) values ($1, $2, 'manual')", [ws, proc]), role).rejects.toThrow(/permission denied/);
      });
      await db.as(users[role]!.claims, async (c) => {
        await expect(c.query("delete from ai_analyses"), role).rejects.toThrow(/permission denied/);
      });
      await db.as(users[role]!.claims, async (c) => expect((await reserve(c)).status, role).toBe("limit"));
    }
    expect((await db.client.query("select count(*)::int as n from ai_runs")).rows[0].n).toBe(40);
  });

  it("can't be reset by deleting the process: the runs stay, and the workspace is still at its cap", async () => {
    const other = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Doomed') returning id", [ws])).rows[0].id;
    await seedRuns(40, "2 hours", other);
    await db.as(users.editor!.claims, async (c) => expect((await reserve(c, other)).status).toBe("limit"));
    // An editor deletes the process (editors can), then tries again on another one.
    await db.as(users.editor!.claims, async (c) => {
      expect((await c.query("delete from processes where id = $1", [other])).rowCount, "editors can delete a process").toBe(1);
      await c.query("savepoint a");
      expect((await c.query("select count(*)::int as n from ai_runs where workspace_id = $1", [ws])).rows[0].n).toBe(40);
      expect((await c.query("select count(*)::int as n from ai_runs where process_id is null")).rows[0].n, "runs keep, without the process").toBe(40);
      expect((await reserve(c)).status, "still at the cap").toBe("limit");
    });
    // The same, committed.
    await db.client.query("delete from processes where id = $1", [other]);
    await db.as(users.editor!.claims, async (c) => expect((await reserve(c)).status).toBe("limit"));
  });

  it("holds under concurrency: two reservations at 39 runs make exactly one more", async () => {
    await seedRuns(39, "2 hours");
    const other = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Parallel') returning id", [ws])).rows[0].id;
    const connect = async () => {
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.editor!.claims)]);
      return c;
    };
    const a = await connect();
    const b = await connect();
    try {
      const first = await reserve(a, proc);
      expect(first.status).toBe("ok");
      // B asks while A's transaction (and its lock) is still open: it waits, then sees A's run.
      let settled = false;
      const second = reserve(b, other).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled, "B waits for A").toBe(false);
      await a.query("commit");
      expect((await second).status, "B sees 40 runs").toBe("limit");
    } finally {
      await a.end();
      await b.query("rollback").catch(() => {});
      await b.end();
      await db.client.query("delete from processes where id = $1", [other]);
    }
    expect((await db.client.query("select count(*)::int as n from ai_runs where workspace_id = $1", [ws])).rows[0].n).toBe(40);
  });
});

describe("ai_analyses: shape", () => {
  it("defaults to an empty read, no insights and no review, and names its run and writer", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await analysis(c);
      const row = (await c.query("select summary, insights, review, checked, dropped, usage, trigger, status, created_by, run_id from ai_analyses")).rows[0];
      expect(row).toMatchObject({ summary: [], insights: [], review: [], checked: 0, dropped: 0, usage: [], trigger: "publish", status: "ok", created_by: users.editor!.id });
      expect(row.run_id).toBeTruthy();
    });
  });

  it("holds one analysis per version, which a re-run replaces (and re-stamps with whoever ran it)", async () => {
    const [r1, r2] = await freshRuns(2);
    await db.as(users.editor!.claims, async (c) => {
      await analysis(c, live, "", r1);
      await expect(analysis(c, live, "", r2)).rejects.toThrow(/ai_analyses_revision_id_key/);
    });
    await seedAnalysis();
    await db.as(users.owner!.claims, async (c) => {
      const run = (await reserve(c)).id;
      await c.query(
        `insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, summary, run_id)
         values ($1, $2, $3, 'ok', 'manual', 'h2', '["New read."]', $4)
         on conflict (revision_id) do update set summary = excluded.summary, trigger = excluded.trigger, input_hash = excluded.input_hash, run_id = excluded.run_id`,
        [ws, proc, live, run],
      );
      expect((await c.query("select summary, trigger, input_hash, created_by from ai_analyses")).rows).toEqual([{ summary: ["New read."], trigger: "manual", input_hash: "h2", created_by: users.owner!.id }]);
    });
  });

  it("checks the status, the trigger and the kind and size of each JSON part", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const run = (await reserve(c)).id;
      await c.query("savepoint a");
      await expect(c.query("insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id) values ($1, $2, $3, 'great', 'publish', 'h', $4)", [ws, proc, live, run])).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(c.query("insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id) values ($1, $2, $3, 'ok', 'cron', 'h', $4)", [ws, proc, live, run])).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(analysis(c, live, "summary='{}'::jsonb", run)).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(analysis(c, live, "insights=(select jsonb_agg(1) from generate_series(1, 31))", run)).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(analysis(c, live, "review=(select jsonb_agg(1) from generate_series(1, 41))", run)).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(analysis(c, live, "summary=(select jsonb_agg(repeat('x', 10000)) from generate_series(1, 8))", run)).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(analysis(c, live, "checked=-1", run)).rejects.toThrow(/check/);
    });
  });

  it("ties a row's revision to its process: another process's revision is refused", async () => {
    const other = (await db.client.query("select id, live_revision_id from processes where workspace_id = $1 and id <> $2 and live_revision_id is not null limit 1", [ws, proc])).rows[0];
    expect(other, "the seed has a second process").toBeTruthy();
    await db.as(users.editor!.claims, async (c) => {
      await expect(analysis(c, other.live_revision_id)).rejects.toThrow(/ai_analyses_revision_id_process_id_workspace_id_fkey/);
    });
  });

  it("goes with its revision's workspace or process, and keeps updated_at moving", async () => {
    await seedAnalysis();
    const before = (await db.client.query("select updated_at from ai_analyses")).rows[0].updated_at as Date;
    await db.client.query("select pg_sleep(0.01)");
    await db.client.query("begin");
    await db.client.query("set local session_replication_role = replica");
    await db.client.query("update ai_analyses set status = 'failed', updated_at = now() + interval '1 second'");
    await db.client.query("commit");
    expect(((await db.client.query("select updated_at from ai_analyses")).rows[0].updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it("takes an analysis of an earlier version too (history keeps what AI said then)", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("select public.publish_process($1, true)", [proc]);
    const [r1, r2] = await freshRuns(2);
    await db.as(users.editor!.claims, async (c) => {
      await analysis(c, live, "", r1);
      await analysis(c, draft.revision_id, "", r2);
      expect((await c.query("select count(*)::int as n from ai_analyses")).rows[0].n).toBe(2);
    });
  });
});

describe("ai_analyses: who can write, and as whom", () => {
  it("takes one analysis per run, and only a run reserved in the last 15 minutes", async () => {
    const [run] = await freshRuns(1);
    const [old] = await freshRuns(1, users.editor!.id, "16 minutes");
    await db.as(users.editor!.claims, async (c) => {
      await expect(analysis(c, live, "", old), "an old reservation can't be spent later").rejects.toThrow(/in the last 15 minutes/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await analysis(c, live, "", run);
      await c.query("savepoint a");
      const draft = (await c.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
      await expect(analysis(c, draft.revision_id, "", run), "a run backs one analysis").rejects.toThrow(/ai_analyses_run_id_key/);
    });
  });

  it("nobody can delete or truncate an analysis or the switches", async () => {
    await seedAnalysis();
    for (const role of ["owner", "editor"]) {
      for (const table of ["ai_analyses", "ai_settings"]) {
        await db.as(users[role]!.claims, async (c) => expect(c.query(`delete from ${table}`), `${role} ${table}`).rejects.toThrow(/permission denied/));
        await db.as(users[role]!.claims, async (c) => expect(c.query(`truncate ${table}`), `${role} truncate ${table}`).rejects.toThrow(/permission denied/));
      }
    }
  });

  it("lets owners and editors write as themselves", async () => {
    for (const role of ["owner", "editor"]) {
      await db.client.query("delete from ai_runs");
      await db.as(users[role]!.claims, async (c) => {
        expect((await analysis(c)).rowCount, role).toBe(1);
        expect((await c.query("update ai_analyses set reason = 'x'")).rowCount, role).toBe(1);
      });
    }
  });

  it("stamps created_by with the caller whatever the client sends", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await analysis(c, live, `created_by='${users.owner!.id}'`);
      expect((await c.query("select created_by from ai_analyses")).rows[0].created_by).toBe(users.editor!.id);
      await c.query("update ai_analyses set created_by = $1", [users.owner!.id]);
      expect((await c.query("select created_by from ai_analyses")).rows[0].created_by, "an update re-stamps it").toBe(users.editor!.id);
    });
  });

  it("refuses an analysis that doesn't name a run the writer reserved for that process", async () => {
    await seedRuns(1, "1 minute");
    const theirs = (await db.client.query("select id from ai_runs limit 1")).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      // Someone else's run (the seeded one belongs to the editor here, so use the owner's below).
      expect((await analysis(c, live, "", theirs)).rowCount).toBe(1);
    });
    await clean();
    await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id) values ($1, $2, 'manual', $3)", [ws, proc, users.owner!.id]);
    const owners = (await db.client.query("select id from ai_runs")).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      await expect(analysis(c, live, "", owners)).rejects.toThrow(/run_id must be a run you reserved/);
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(analysis(c, live, "", randomUUID())).rejects.toThrow(/run_id must be a run you reserved|foreign key/);
    });
    const other = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Elsewhere') returning id", [ws])).rows[0].id;
    await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id) values ($1, $2, 'manual', $3)", [ws, other, users.editor!.id]);
    const wrongProcess = (await db.client.query("select id from ai_runs where process_id = $1", [other])).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      await expect(analysis(c, live, "", wrongProcess)).rejects.toThrow(/run_id must be a run you reserved/);
    });
    await db.client.query("delete from processes where id = $1", [other]);
  });

  it("lets every member read it, and the name of whoever ran it only to those who see people (B1 2/3)", async () => {
    await seedAnalysis('["Visible"]');
    for (const role of ["owner", "editor"]) {
      const rows = await db.as(users[role]!.claims, async (c) => (await c.query("select a.summary, r.user_name from ai_analyses a join ai_runs r on r.id = a.run_id")).rows);
      expect(rows, role).toEqual([{ summary: ["Visible"], user_name: "Ed Itor" }]);
    }
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("select summary from ai_analyses")).rows, role).toEqual([{ summary: ["Visible"] }]);
        // The run holds the runner's name, so a member who didn't run it reads none.
        expect((await c.query("select user_name from ai_runs")).rows, role).toEqual([]);
      });
    }
  });

  it("stops members and viewers writing", async () => {
    await seedAnalysis('["Kept"]');
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("update ai_analyses set summary = '[\"x\"]'")).rowCount, role).toBe(0);
      });
      await db.as(users[role]!.claims, async (c) => {
        // They can't reserve a run, so they have nothing to write against.
        expect((await reserve(c)).status, role).toBe("forbidden");
        await expect(analysis(c, live, "", randomUUID()), role).rejects.toThrow(/row-level security|run_id must be|violates/);
      });
    }
    expect((await db.client.query("select summary from ai_analyses")).rows).toEqual([{ summary: ["Kept"] }]);
  });

  it("hides another workspace's analyses, and stops its members writing into this one", async () => {
    await seedAnalysis();
    await db.as(users.stranger!.claims, async (c) => {
      expect((await c.query("select 1 from ai_analyses")).rowCount).toBe(0);
      expect((await c.query("select 1 from ai_runs")).rowCount).toBe(0);
      expect((await c.query("update ai_analyses set reason = 'x'")).rowCount).toBe(0);
    });
    await db.as(users.stranger!.claims, async (c) => {
      await expect(analysis(c)).rejects.toThrow(/row-level security|run_id must be|violates/);
    });
  });

  it("gives anon nothing", async () => {
    await seedAnalysis();
    for (const table of ["ai_analyses", "ai_settings", "ai_runs"]) {
      await db.client.query("begin");
      await db.client.query("set local role anon");
      await expect(db.client.query(`select 1 from ${table}`), table).rejects.toThrow(/permission denied/);
      await db.client.query("rollback");
    }
  });

  it("defines no SECURITY DEFINER function but reserve_ai_run, which writes no AI content", async () => {
    const rows = (
      await db.client.query(
        "select proname, proconfig::text as cfg from pg_proc where prosecdef and pronamespace in ('public'::regnamespace, 'private'::regnamespace) and (proname like '%ai\\_%' or prosrc ilike '%ai_analyses%' or prosrc ilike '%ai_settings%' or prosrc ilike '%ai_runs%')",
      )
    ).rows;
    expect(rows.map((r) => r.proname)).toEqual(["reserve_ai_run"]);
    expect(rows[0].cfg).toContain("search_path");
    const src = (await db.client.query("select prosrc from pg_proc where proname = 'reserve_ai_run'")).rows[0].prosrc as string;
    expect(src).not.toMatch(/ai_analyses|ai_settings/);
  });
});
