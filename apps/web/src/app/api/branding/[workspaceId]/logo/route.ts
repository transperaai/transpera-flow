import { loadWorkspaceLogo } from "@transpera-flow/db";
import { authEnv } from "@/lib/auth/env";
import { getDb } from "@/lib/auth/session";

// GET /api/branding/<workspace id>/logo: a workspace's logo, stored as bytes in `workspace_logos` (step 4 of the move off
// Supabase). Open to anyone, signed in or not: share-link visitors see the logo too, and the public `branding` bucket it
// replaces was public. It reads through `public.workspace_logo(uuid)`, a SECURITY DEFINER function that anon may call; nothing
// else about the workspace is reachable here. The ETag is the bytes' SHA-256, so a request that sends it back gets a 304, and
// the pages ask for `?v=<first 12 of the hash>`, so a new logo is a new address.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE = "public, max-age=300";
// `?v=` naming the current hash is an address that never changes, so the CDN keeps it and the database isn't asked again.
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Whether an If-None-Match header names this ETag (a list, `*`, and weak validators included). */
function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

export async function GET(request: Request, ctx: RouteContext<"/api/branding/[workspaceId]/logo">): Promise<Response> {
  const { workspaceId } = await ctx.params;
  // Demo mode has no database, so no logos.
  if (!authEnv() || !UUID.test(workspaceId)) return new Response(null, { status: 404 });
  const logo = await loadWorkspaceLogo(await getDb(), workspaceId.toLowerCase());
  if (!logo) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  const etag = `"${logo.sha256}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": new URL(request.url).searchParams.get("v") === logo.sha256.slice(0, 12) ? IMMUTABLE : CACHE,
    // The bytes are an image and nothing else: never sniffed into a page, never allowed to run anything.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (matches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(logo.bytes), { status: 200, headers: { ...headers, "Content-Type": logo.mime, "Content-Length": String(logo.bytes.length) } });
}
