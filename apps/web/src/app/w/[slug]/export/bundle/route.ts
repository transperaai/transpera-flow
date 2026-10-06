import { BundleTooLargeError, bundleJsonChunks, exportWorkspaceBundle, supabaseReader, supabaseWorkspaceReader } from "@transpera-flow/db";
import { supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// GET /w/<slug>/export/bundle (issue #39, B10): the whole workspace as one JSON file (`transpera-workspace/1`), the backup
// and migration format. Only agency admins, owners and editors may export it (`can_edit_workspace`; Austin's decision 4 on
// #39): a member or viewer gets 403 and nothing else is read. Read as the signed-in user, so row-level security decides what
// can be read: a non-member gets a 404 (the same answer as for a workspace that doesn't exist). The tables are read one
// after another, so a bundle taken during edits can mix moments (`exported_at` says when reading began). The file is sent
// in pieces without indentation. One too big for a restore to take (see `restore_warning`) is still sent, with the warning in
// the `X-Backup-Warning` header. Nothing is cached, and it is a download, never rendered.

export const maxDuration = 60;

const fileName = (slug: string, now: Date) => `${slug.replace(/[^a-z0-9-]/gi, "-")}-workspace-${now.toISOString().slice(0, 10)}.json`;

export async function GET(_request: Request, ctx: RouteContext<"/w/[slug]/export/bundle">): Promise<Response> {
  if (!supabaseEnv()) return Response.json({ message: "Exports need a connected workspace; the demo has none." }, { status: 503 });
  const { slug } = await ctx.params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ message: "Your session has ended. Sign in again." }, { status: 401 });

  const { data: workspace, error } = await supabase.from("workspaces").select("id").eq("slug", slug).maybeSingle();
  if (error) return Response.json({ message: "The workspace could not be read." }, { status: 500 });
  if (!workspace) return Response.json({ message: "No such workspace." }, { status: 404 });
  const { data: canEdit } = await supabase.rpc("can_edit_workspace", { ws: workspace.id });
  if (canEdit !== true) return Response.json({ message: "Only owners, editors and agency admins can export the workspace." }, { status: 403 });

  const now = new Date();
  try {
    const bundle = await exportWorkspaceBundle(workspace.id, supabaseWorkspaceReader(supabase), supabaseReader(supabase), { canEdit: true, now });
    if (!bundle) return Response.json({ message: "No such workspace." }, { status: 404 });
    const chunks = bundleJsonChunks(bundle);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Pieces are small; send a few together to keep the number of writes down.
        let text = "";
        for (let i = 0; i < 64; i++) {
          const next = chunks.next();
          if (next.done) {
            if (text) controller.enqueue(encoder.encode(text));
            controller.close();
            return;
          }
          text += next.value;
          if (text.length > 256 * 1024) break;
        }
        controller.enqueue(encoder.encode(text));
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName(slug, now)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // A workspace bigger than a restore takes is still exported; the file and this header say so (workspace-bundle.ts).
        ...(bundle.restore_warning ? { "X-Backup-Warning": bundle.restore_warning.replace(/[^\x20-\x7e]/g, " ") } : {}),
      },
    });
  } catch (e) {
    if (e instanceof BundleTooLargeError) return Response.json({ message: e.message }, { status: 413 });
    return Response.json({ message: "The export failed. Try again." }, { status: 500 });
  }
}
