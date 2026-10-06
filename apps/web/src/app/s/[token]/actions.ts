"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { redirectToGoogle } from "@/lib/auth/google-sign-in";
import { AFTER_SIGN_IN_COOKIE, AFTER_SIGN_IN_MAX_AGE_SECONDS, SHARE_TOKEN } from "@/lib/share/after-sign-in";

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
