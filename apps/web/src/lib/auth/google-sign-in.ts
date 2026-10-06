import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Hands off to Google, which returns to /auth/callback. Shared by the login page and a share link's sign-in (B3), so both ask for
 * the same scopes. Never returns: it redirects to Google, or to /login with the reason.
 */
export async function redirectToGoogle(): Promise<never> {
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    // openid makes Google return an ID token, which carries the hosted-domain (hd) claim used for domain joins.
    options: { redirectTo: `${origin}/auth/callback`, scopes: "openid" },
  });
  if (error || !data.url) redirect(`/login?error=${encodeURIComponent(error?.message ?? "Google sign-in is unavailable.")}`);
  redirect(data.url);
}
