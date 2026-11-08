"use server";

import { redirectToProvider } from "@/lib/auth/google-sign-in";
import type { ProviderId } from "@/lib/auth/env";

/** Hands off to the chosen provider, which returns through /api/auth/callback/<provider>. */
export async function signInWith(provider: ProviderId): Promise<void> {
  await redirectToProvider(provider === "microsoft" ? "microsoft" : "google");
}
