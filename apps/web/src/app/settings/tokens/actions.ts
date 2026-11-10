"use server";

import { refresh } from "next/cache";
import { generateApiToken } from "@transpera-flow/mcp";
import { pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

export type CreateTokenState = { token: string; label: string } | { error: string } | null;

export type RevokeTokenResult = { status: "ok" } | { status: "error"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Revoke one of the signed-in user's tokens (RLS limits the update to their own). Says what went wrong instead of throwing. */
export async function revokeToken(id: string): Promise<RevokeTokenResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { status: "error", message: "That isn't one of your tokens. Reload the page and try again." };
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  try {
    const db = await getDb();
    await db.updateTable("api_tokens").set({ revoked_at: new Date().toISOString() }).where("id", "=", id).where("revoked_at", "is", null).execute();
  } catch {
    return { status: "error", message: "Couldn't revoke the token. Try again." };
  }
  refresh();
  return { status: "ok" };
}
