import { anthropicNarrator } from "@/lib/narration/anthropic";
import { explainRun } from "@/lib/narration/explain";
import type { StoredNarration } from "@/lib/narration/service";
import { authEnv } from "@/lib/auth/env";
import { getDb, getSessionUser } from "@/lib/auth/session";

// POST /api/narrate (issue #29; docs/PRD.md §7.3): narration on demand, as
// the signed-in user under RLS, server-side only (the Anthropic key never
// leaves the server).
//   {target: "run", runId, regenerate?}       "explain this run"
// Every number is checked against the facts; a draft that fails twice, a
// timeout or an API error falls back to the templated text, and the reason
// comes back and is recorded in `narrations`.

// Two drafts at most (75 s together).
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const view = (n: StoredNarration) => ({
  source: n.source,
  paragraphs: n.paragraphs,
  validated: n.validated,
  fallback: n.fallback,
  reason: n.reason,
  cached: n.cached,
  model: n.model,
  checked: n.checked,
  retried: n.rejected.length > 0,
  at: n.at,
  editedBy: n.editedBy,
});

export async function POST(request: Request): Promise<Response> {
  if (!authEnv()) return Response.json({ status: "error", message: "The database is not configured; the demo uses a stand-in writer." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { target?: unknown; runId?: unknown; regenerate?: unknown } | null;
  if (!(await getSessionUser())) return Response.json({ status: "error", message: "Your session has ended. Sign in again." }, { status: 401 });
  const regenerate = body?.regenerate === true;

  if (body?.target === "run" && isUuid(body.runId)) {
    const result = await explainRun(await getDb(), body.runId, { model: anthropicNarrator(), regenerate });
    if (result.status === "error") return Response.json({ status: "error", message: result.message }, { status: result.code === "not_found" ? 404 : 403 });
    return Response.json({ status: "ok", narration: view(result.narration) });
  }
  return Response.json({ status: "error", message: "Say what to narrate: {target: 'run', runId}." }, { status: 400 });
}
