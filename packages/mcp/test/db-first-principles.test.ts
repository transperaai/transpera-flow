import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importNewProcess } from "@transpera-flow/db/process-import";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, userClaims, type McpTestDb } from "./helpers";

// get_first_principles end to end (issue #119, A54), as in production: MCP client → handleMcpRequest → token lookup in app code →
// Kysely under the token owner's claims → Postgres with every migration and RLS. It is the only first-principles tool: filling them
// in is done in the app, or arrives with an uploaded file (docs/plans/cut-list.md item 5). Runs on a throwaway database
// (test/helpers.ts), in a workspace of its own.

let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId: string;
let editorId: string;
let viewerToken: string;
let strangerToken: string;

async function createUser(email: string) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

async function issueToken(userId: string) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e')", [userId, hash]);
  return token;
}

interface FpData {
  started: boolean;
  revision: { which: string };
  first_principles: { job: { who: string }; requirements: { text: string; owner_text: string }[] };
  steps_filled: number;
  flag_count: number;
  text: string;
}

describe("get_first_principles (read-only, as the user)", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    workspaceId = (await admin.query("insert into workspaces (name, slug) values ('First Principles Co', 'fp-co') returning id")).rows[0].id;
    editorId = await createUser("fp-editor@example.com");
    const viewerId = await createUser("fp-viewer@example.com");
    const strangerId = await createUser("fp-stranger@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [workspaceId, editorId, viewerId]);
    const otherId = (await admin.query("insert into workspaces (name, slug) values ('Elsewhere FP', 'elsewhere-fp') returning id")).rows[0].id;
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherId, strangerId]);
    viewerToken = await issueToken(viewerId);
    strangerToken = await issueToken(strangerId);
    options = env.options;

    const editor = env.dbAs(userClaims(editorId));
    for (const name of ["FP pipeline", "No answers yet"]) {
      await importNewProcess(
        { db: editor, userId: editorId },
        workspaceId,
        {
          name,
          steps: [
            { name: "Start", kind: "start" },
            { name: "Do the work", kind: "task", work_hours: 2 },
            { name: "Done", kind: "end", outcome: "done" },
          ],
          edges: [
            { from: "Start", to: "Do the work" },
            { from: "Do the work", to: "Done" },
          ],
        },
      );
    }
    const draft = (await admin.query("select id, draft_revision_id from processes where workspace_id = $1 and name = 'FP pipeline'", [workspaceId])).rows[0];
    await admin.query(
      "insert into first_principles (workspace_id, process_id, revision_id, job_who, requirements) values ($1, $2, $3, 'Founders', $4)",
      [workspaceId, draft.id, draft.draft_revision_id, JSON.stringify([{ id: randomUUID(), text: "Every enquiry gets a reply the same day", owner_person_id: null, owner_text: "Marketing", why: "", step_id: null, verdict: "challenge" }])],
    );
  });

  afterAll(async () => {
    await env?.close();
  });

  it("reads a viewer the draft's answers, with what the rules flag; there is no tool to change them", async () => {
    const viewer = await connect(viewerToken, options);
    const r = await call<FpData>(viewer, "get_first_principles", { process: "FP pipeline" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data).toMatchObject({ started: true, revision: { which: "draft" }, first_principles: { job: { who: "Founders" } } });
    expect(r.data.first_principles.requirements.map((x) => x.text)).toEqual(["Every enquiry gets a reply the same day"]);
    // A requirement owned by a team, not a person, is flagged by the rule checks.
    expect(r.data.flag_count).toBeGreaterThan(0);
    const tools = (await viewer.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("get_first_principles");
    expect(tools).not.toContain("update_first_principles");
    await viewer.close();
  });

  it("says a process has no first principles yet, rather than inventing any", async () => {
    const viewer = await connect(viewerToken, options);
    const r = await call<FpData>(viewer, "get_first_principles", { process: "No answers yet" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data).toMatchObject({ started: false, steps_filled: 0 });
    expect(r.data.text).toMatch(/no first principles yet/);
    await viewer.close();
  });

  it("refuses a stranger", async () => {
    const stranger = await connect(strangerToken, options);
    expect(await call(stranger, "get_first_principles", { workspace: "fp-co", process: "FP pipeline" })).toMatchObject({ ok: false });
    await stranger.close();
  });
});
