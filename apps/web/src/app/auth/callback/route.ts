import { NextResponse, type NextRequest } from "next/server";
import { AFTER_SIGN_IN_COOKIE, afterSignInPath } from "@/lib/share/after-sign-in";
import { createClient } from "@/lib/supabase/server";

/**
 * Sign-in landing: exchange the code for a session, resolve workspace access, then go home, or back to the share link the visitor
 * came from (a cookie the link's sign-in set; only `/s/<token>` is honoured, B3).
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  // Read before the query is cleared; always dropped below, so it can't send a later sign-in anywhere.
  const back = afterSignInPath(request.cookies.get(AFTER_SIGN_IN_COOKIE)?.value);
  const code = url.searchParams.get("code");
  // Supabase appends these when the link itself was rejected (expired, already used).
  let error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  url.search = "";
  if (code && !error) {
    const supabase = await createClient();
    const result = await supabase.auth.exchangeCodeForSession(code);
    if (result.error) {
      console.error("auth callback: code exchange failed", result.error.code, result.error.message);
      error = result.error.message;
    } else {
      // Grant or withdraw workspace access from the allowed domains and
      // pre-assigned emails (docs/adr/0003-workspace-access.md). A failure
      // here must not block sign-in; the home page retries.
      const access = await supabase.rpc("resolve_my_access");
      if (access.error) console.error("auth callback: resolving access failed", access.error.code, access.error.message);
    }
  } else if (!error) {
    error = "The sign-in link was missing its code.";
  }
  if (error) {
    url.pathname = "/login";
    url.searchParams.set("error", error);
  } else {
    url.pathname = back ?? "/";
  }
  const response = NextResponse.redirect(url);
  response.cookies.delete(AFTER_SIGN_IN_COOKIE);
  return response;
}
