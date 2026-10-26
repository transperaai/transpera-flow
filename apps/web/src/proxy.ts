import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { authEnv } from "@/lib/auth/env";

// "/s" is a share link's page (B3): it opens signed out; a restricted link asks for sign-in itself. "/api/auth" is Better Auth.
const PUBLIC_PATHS = ["/login", "/auth", "/api/auth", "/demo", "/privacy", "/s"];

/**
 * Sends visitors without a session cookie to /login. This is the fast, optimistic check: it only looks for the cookie. The
 * session itself is validated against the database in `getSessionUser()`, which every page and action goes through.
 */
export function proxy(request: NextRequest) {
  // Demo mode: no sign-in settings, so nothing to guard.
  if (!authEnv()) return NextResponse.next({ request });
  const path = request.nextUrl.pathname;
  // The MCP endpoint authenticates with an API token, not a session cookie.
  if (path === "/api/mcp") return NextResponse.next({ request });

  if (!getSessionCookie(request) && !PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
