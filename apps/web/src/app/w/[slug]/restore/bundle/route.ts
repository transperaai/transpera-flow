import { MAX_BACKUP_BYTES, MAX_COMPRESSED_BYTES, checkWorkspaceBundle, planWorkspaceImport, type WorkspaceBundle } from "@transpera-flow/db";
import { restoreFailure, ROLE_MESSAGE, SLOW_START_MESSAGE } from "@/lib/restore/errors";
import { supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// POST /w/<slug>/restore/bundle (issue #39, B10 2b): restore a `transpera-workspace/1` backup into this new, empty workspace,
// all or nothing, by `import_workspace_bundle` (every process comes back as a draft of its live version). A Route Handler and
// not a Server Action, because Server Actions cap a body at 1 MB and Vercel caps any request at 4.5 MB: the browser sends the
// file gzipped (at most 4 MB), and it is unpacked here with a ceiling of 25 MB, so a gzip bomb stops at the ceiling.
//
// Order: environment, session, same-origin, the workspace (RLS: a non-member gets 404), `can_edit_workspace` (403), the size of
// the body, unzip, JSON, `checkWorkspaceBundle` (400 with its errors), `can_manage_workspace`, the plan, the database call.
// Everything is read and written as the signed-in user, so row-level security and the database's own rules decide. Nothing is
// cached, and no SQL reaches the answer.
//
// Time (B21, #203): the one database call may run for up to 40 s (the function sets its own `statement_timeout`; every other request
// by the signed-in user keeps Supabase's 8 s). The route's 60 s covers reading, unzipping, checking and planning a 25 MB backup (a few
// seconds) plus that call, but only if the call starts early: once 15 s have gone since the request arrived the route doesn't start it
// (503, `SLOW_START_MESSAGE`), so Vercel never cuts the request off while the database goes on to commit. The page says what to do
// when it loses the connection anyway.

export const maxDuration = 60;

/** The database call isn't started once this long (ms) has passed since the request arrived: 15 s + the call's 40 s stays inside `maxDuration`. */
const START_BUDGET_MS = 15_000;

const noStore = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status: number) => Response.json(body, { status, headers: noStore });
const tooBig = (what: string) => reply({ message: `${what} is too big to restore in one go.` }, 413);

/** Read a body to the end, counting; null once it passes `max` bytes (the rest is not read). */
async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The file name the browser sent, for the "Upload (<name>)" label: URI-decoded, control characters out, short. */
function backupName(header: string | null): string | null {
  if (!header) return null;
  let name = header;
  try {
    name = decodeURIComponent(header);
  } catch {
    // Not encoded: use it as it is.
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return name || null;
}

export async function POST(request: Request, ctx: RouteContext<"/w/[slug]/restore/bundle">): Promise<Response> {
  const started = Date.now();
  if (!supabaseEnv()) return reply({ message: "Restoring needs a connected workspace; the demo has none." }, 503);
  const { slug } = await ctx.params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return reply({ message: "Your session has ended. Sign in again." }, 401);

  // Against cross-site posts: the browser names where the request came from, and it must be here.
  if (request.headers.get("origin") !== new URL(request.url).origin) return reply({ message: "Refused." }, 403);

  const { data: workspace, error } = await supabase.from("workspaces").select("id").eq("slug", slug).maybeSingle();
  if (error) return reply({ message: "The workspace could not be read." }, 500);
  if (!workspace) return reply({ message: "No such workspace." }, 404);
  const { data: canEdit } = await supabase.rpc("can_edit_workspace", { ws: workspace.id });
  if (canEdit !== true) return reply({ message: ROLE_MESSAGE }, 403);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_COMPRESSED_BYTES) return tooBig("This backup");
  const zipped = await readLimited(request.body, MAX_COMPRESSED_BYTES);
  if (!zipped) return tooBig("This backup");

  let text: string;
  try {
    const unzipped = await readLimited(new Blob([zipped as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_BACKUP_BYTES);
    if (!unzipped) return reply({ message: "This backup is bigger than a restore takes once unpacked." }, 413);
    text = new TextDecoder("utf-8", { fatal: true }).decode(unzipped);
  } catch {
    return reply({ message: "That file couldn't be unpacked. Choose the .json backup again." }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reply({ message: "That file isn't valid JSON." }, 400);
  }
  const { data: canManage } = await supabase.rpc("can_manage_workspace", { ws: workspace.id });
  const check = checkWorkspaceBundle(parsed, { canManage: canManage === true });
  if (!check.ok) return reply({ message: check.errors[0] ?? "This backup can't be restored.", errors: check.errors }, 400);

  const { plan, summary } = planWorkspaceImport(parsed as WorkspaceBundle, { canManage: canManage === true });
  if (Date.now() - started > START_BUDGET_MS) return reply({ message: SLOW_START_MESSAGE }, 503);
  const { data, error: failed, status } = await supabase.rpc("import_workspace_bundle", { p_workspace: workspace.id, p_plan: plan as never, p_label: backupName(request.headers.get("x-backup-name")) ?? undefined });
  if (failed) {
    const f = restoreFailure(failed, status);
    return reply({ message: f.message }, f.status);
  }
  const done = data as { processes?: { id: string; name: string }[]; counts?: Record<string, number>; settings?: string } | null;
  return reply(
    {
      processes: (done?.processes ?? []).map((p) => ({ id: p.id, name: p.name })),
      counts: done?.counts ?? {},
      leftOut: summary.leftOut,
      settings: done?.settings ?? "none",
    },
    200,
  );
}
