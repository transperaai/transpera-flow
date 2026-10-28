import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID } from "@transpera-flow/db";
import { TOOL_NAMES } from "../src";
import { call, connect, createUser, issueToken, startTestDb, type McpTestDb } from "./helpers";

// MCP is read-only (docs/plans/cut-list.md item 5; strip brief S2). This proves it for every tool rather than by the list of
// names: a statement trigger on every table in public records any insert, update or delete, then every tool is called by the
// Owner and by an Agency admin. The only writes allowed are the token's own bookkeeping (api_tokens: last use, rate window,
// active workspace). A robustness cache, a saved run or an audit row from a read would show up here.

let env: McpTestDb;
let admin: pg.Client;

const scenario = "Hire a strategist";
const argsFor: Record<string, Record<string, unknown>> = {
  list_workspaces: {},
  set_active_workspace: { workspace: NORTHBEAM_WORKSPACE_ID },
  get_workspace_summary: {},
  get_process: { process: NORTHBEAM_PROCESS_ID },
  run_scenario: { process: NORTHBEAM_PROCESS_ID, reps: 3, start_date: "2026-10-05" },
  list_templates: {},
  compare_scenarios: { b: scenario, reps: 3, start_date: "2026-10-05" },
  check_robustness: { scenario, time_budget_seconds: 1, start_date: "2026-10-05" },
  get_bottlenecks: { process: NORTHBEAM_PROCESS_ID, reps: 3, start_date: "2026-10-05" },
  list_issues: { include_detected: true },
  get_facts: { process: NORTHBEAM_PROCESS_ID },
  list_sources: {},
  list_solutions: {},
  get_first_principles: { process: NORTHBEAM_PROCESS_ID },
};

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  await admin.query(`
    create table private.test_writes (tbl text not null, op text not null);
    create function private.test_record_write() returns trigger language plpgsql security definer set search_path = '' as $$
    begin
      insert into private.test_writes values (tg_table_name, tg_op);
      return null;
    end $$;
    do $$
    declare t record;
    begin
      for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r', 'p') loop
        execute format('create trigger zz_test_record_write after insert or update or delete on public.%I
                        for each statement execute function private.test_record_write()', t.relname);
      end loop;
    end $$;`);
});

afterAll(async () => {
  await env?.close();
});

describe("every MCP tool is read-only", () => {
  it("has arguments here for every tool, so a new tool is checked too", () => {
    expect(Object.keys(argsFor).sort()).toEqual([...TOOL_NAMES].sort());
  });

  for (const who of ["the Owner", "an Agency admin"] as const) {
    it(`writes nothing but the token's own bookkeeping when ${who} calls every tool`, async () => {
      const id =
        who === "the Owner"
          ? await createUser(admin, `ro-owner-${Date.now()}@example.com`, { agency_admin: true })
          : await createUser(admin, `ro-admin-${Date.now()}@example.com`);
      if (who === "an Agency admin") {
        await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, id]);
      }
      const client = await connect(await issueToken(admin, id), env.options);
      await admin.query("truncate private.test_writes");
      for (const name of TOOL_NAMES) {
        const r = await call(client, name, argsFor[name]);
        expect(r.ok, `${name}: ${JSON.stringify(r.error)}`).toBe(true);
      }
      await client.close();
      const writes = (await admin.query("select distinct tbl from private.test_writes order by tbl")).rows.map((r) => r.tbl as string);
      // The recorder works: the token lookup's own stamp is seen.
      expect(writes).toContain("api_tokens");
      expect(writes.filter((t) => t !== "api_tokens")).toEqual([]);
    }, 60_000);
  }
});
