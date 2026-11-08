import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESS_TEMPLATES, createProcessFromTemplate } from "@transpera-flow/db/process-import";
import { startTestDb, userClaims, type McpTestDb } from "./helpers";

// A process made from a template gets the template's category (D52) and the template's kind, unchanged: Client onboarding is
// onboarding but still servicing (it runs per new client through its service link), so nothing in the engine moves.

let env: McpTestDb;
let ws = "";
let owner = "";

beforeAll(async () => {
  env = await startTestDb();
  const admin = env.t.client;
  const tag = randomUUID().slice(0, 8);
  ws = (await admin.query("insert into workspaces (name, slug) values ('Template Co', $1) returning id", [`tpl-${tag}`])).rows[0].id as string;
  owner = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [owner, `tpl-owner-${tag}@example.com`]);
  await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, owner]);
}, 120_000);

afterAll(async () => {
  await env?.close?.();
});

describe("templates carry a category", () => {
  it("names the category of each template, and keeps its kind", () => {
    expect(PROCESS_TEMPLATES.map((t) => [t.id, t.category, t.kind])).toEqual([
      ["agency-sales-pipeline", "sales", "pipeline"],
      ["client-onboarding", "onboarding", "servicing"],
      ["monthly-reporting", "routine_client_work", "servicing"],
    ]);
  });

  for (const t of PROCESS_TEMPLATES) {
    it(`creates ${t.name} with its category and its unchanged kind`, async () => {
      const db = env.dbAs(userClaims(owner));
      const made = await createProcessFromTemplate({ db, userId: owner }, ws, t.id, `${t.name} from test`);
      expect(made.kind).toBe(t.kind);
      const row = (await env.t.client.query("select category, kind from public.processes where id = $1", [made.id])).rows[0];
      expect(row).toEqual({ category: t.category, kind: t.kind });
    });
  }
});
