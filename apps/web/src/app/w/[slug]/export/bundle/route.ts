import { exportWorkspaceBundle, supabaseReader, supabaseWorkspaceReader } from "@transpera-flow/db";
import { supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// GET /w/<slug>/export/bundle (issue #39, B10 part 1): the whole workspace as one JSON file (`transpera-workspace/1`), the
// backup and migration format. Read as the signed-in user, so row-level security decides what they may read: a member
// (a viewer included) gets what they can read, anyone else gets a 404 (the same answer as for a workspace that doesn't
// exist). Nothing is cached, and the file is a download, never rendered.

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

  const now = new Date();
  try {
    const bundle = await exportWorkspaceBundle(workspace.id, supabaseWorkspaceReader(supabase), supabaseReader(supabase), now);
    if (!bundle) return Response.json({ message: "No such workspace." }, { status: 404 });
    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName(slug, now)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ message: "The export failed. Try again." }, { status: 500 });
  }
}
