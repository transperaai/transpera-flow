"use server";

import { redirect } from "next/navigation";
import { redirectToGoogle } from "@/lib/auth/google-sign-in";
import { SHARE_TOKEN } from "@/lib/share/after-sign-in";

/**
 * "Continue with Google" on a restricted link: the same Google hand-off as the login page, returning to the link afterwards
 * (`/s/<token>` is Better Auth's callbackURL). A malformed token goes nowhere.
 */
export async function signInToOpen(token: string): Promise<void> {
  if (typeof token !== "string" || !SHARE_TOKEN.test(token)) redirect("/login");
  await redirectToGoogle(`/s/${token}`);
}
