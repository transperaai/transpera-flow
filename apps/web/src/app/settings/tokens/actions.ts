"use server";

import { refresh } from "next/cache";
import { generateApiToken } from "@transpera-flow/mcp";
import { pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

export type CreateTokenState = { token: string; label: string } | { error: string } | null;

/** Create a personal API token. The token is returned once; only its hash is stored. */
export async function createToken(_prev: CreateTokenState, form: FormData): Promise<CreateTokenState> {
  const label = String(form.get("label") ?? "").trim();
  if (!label || label.length > 100) return { error: "Give the token a name of up to 100 characters." };
  if (!(await getSessionUser())) return { error: "Your session has ended. Sign in again." };
  const db = await getDb();
  const { token, hash } = generateApiToken();
  // RLS: user_id defaults to the signed-in user and the policy only allows their own.
  try {
    await db.insertInto("api_tokens").values({ label, token_hash: hash }).execute();
  } catch (e) {
    return { error: pgError(e).message ?? "Couldn't create the token. Try again." };
  }
  refresh();
  return { token, label };
}

/** Revoke one of the signed-in user's tokens (RLS limits the update to their own). */
export async function revokeToken(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const db = await getDb();
  await db.updateTable("api_tokens").set({ revoked_at: new Date().toISOString() }).where("id", "=", id).where("revoked_at", "is", null).execute();
  refresh();
}
