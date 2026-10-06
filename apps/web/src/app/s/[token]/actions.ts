"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Json } from "@transpera-flow/db";
import { redirectToGoogle } from "@/lib/auth/google-sign-in";
import { AFTER_SIGN_IN_COOKIE, AFTER_SIGN_IN_MAX_AGE_SECONDS, SHARE_TOKEN } from "@/lib/share/after-sign-in";
import { parsePlayIdea, type PlayResult } from "@/lib/share/play-input";
import { createClient } from "@/lib/supabase/server";

/**
 * "Continue with Google" on a restricted link: remember the link for ten minutes, then the same Google hand-off as the login
 * page. /auth/callback sends the visitor back to the link when the cookie is there. A malformed token goes nowhere.
 */
export async function signInToOpen(token: string): Promise<void> {
  if (typeof token !== "string" || !SHARE_TOKEN.test(token)) redirect("/login");
  (await cookies()).set(AFTER_SIGN_IN_COOKIE, `/s/${token}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AFTER_SIGN_IN_MAX_AGE_SECONDS,
  });
  await redirectToGoogle();
}

/**
 * "Send" in a play link's dialog (issue #33, B4): the visitor's idea goes to the workspace's Suggestions through
 * `public.submit_play_proposal`, the only write a play link can make. The browser could call that function directly with the
 * public key, so every check is repeated there; this action's checks only spare a round trip and use the same sentences.
 *
 * No text redaction or name check here: the visitor can't read the workspace's names (and must not learn them). The function holds
 * what fails for the team's members and viewers, and answers `ok` either way, so this never says whether anything was held.
 * Nothing the visitor sees changed, so nothing is revalidated.
 */
export async function submitPlayIdea(token: unknown, input: unknown): Promise<PlayResult> {
  if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return { status: "gone" };
  // The honeypot: a person never fills it. Report success, send nothing.
  const honey = input && typeof input === "object" ? (input as { website?: unknown }).website : undefined;
  if (typeof honey === "string" && honey !== "") return { status: "ok" };
  // A restricted link ignores the typed address (the verified one is used) and an open link's is checked by the function.
  const parsed = parsePlayIdea(input, { needEmail: false });
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const v = parsed.value;
  const db = await createClient();
  const { data, error } = await db.rpc("submit_play_proposal", {
    token,
    title: v.title,
    note: v.note,
    name: v.name,
    email: v.email ?? "",
    issue: v.issue,
    levers: v.levers as unknown as Json,
  });
  if (error) {
    if (error.code === "22023" && error.message) return { status: "error", message: error.message };
    return { status: "error", message: "Couldn't send. Try again." };
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (status === "ok" || status === "rate_limited" || status === "busy" || status === "gone" || status === "sign_in" || status === "not_allowed") return { status };
  return { status: "error", message: "Couldn't send. Try again." };
}
