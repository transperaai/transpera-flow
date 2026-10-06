"use server";

import { redirectToGoogle } from "@/lib/auth/google-sign-in";

/** Google sign-in: hand off to Google, which returns to /auth/callback. */
export async function signInWithGoogle(): Promise<void> {
  await redirectToGoogle();
}
