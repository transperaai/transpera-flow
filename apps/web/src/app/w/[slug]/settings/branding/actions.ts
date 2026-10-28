"use server";

import { refresh } from "next/cache";
import { createHash } from "node:crypto";
import { deleteWorkspaceLogo, saveWorkspaceLogo } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { failureMessage, isLogoSha, logoUrl, type LogoResult } from "@/lib/branding/branding";
import { checkAccent, normaliseHex, type Theme } from "@/lib/branding/contrast";
import { MAX_LOGO_BYTES, checkLogo, LOGO_ERRORS, LOGO_MIME } from "@/lib/branding/logo-check";
import { isId } from "@/lib/clients";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField } from "@/lib/fields/server";
import { getDb, getSessionUser } from "@/lib/auth/session";
import { pgError } from "@/app/action-db";

// Client branding (issue #34, B5), from Settings -> Branding: the workspace's accent colour and logo. As the signed-in user
// through row-level security: owners and agency admins change the workspace and write its row of `workspace_logos`. The database
// checks the shape of what is saved; contrast is checked here (and again when the page is drawn), so a failing colour never
// reaches the database. The logo is stored as bytes in `workspace_logos` and served by app/api/branding/[workspaceId]/logo.

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const OWNERS_ONLY = "Only Agency admins can change the branding.";
const CHANGED = "Someone else changed the logo. Reload to see it.";

async function signedInClient() {
  return (await getSessionUser()) ? getDb() : null;
}

/**
 * The light- or dark-theme accent. Null resets it (light: Transpera's default; dark: derived from the light one). Owners only.
 * A colour that fails contrast in its theme is refused here, with the nearest passing one in the message, and the database is
 * not called.
 */
export async function saveBrandAccent(workspaceId: string, theme: Theme, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  if (!isId(workspaceId) || (theme !== "light" && theme !== "dark") || !(base === null || typeof base === "string") || !(value === null || typeof value === "string")) return invalid;
  let next: string | null = null;
  if (value !== null) {
    const hex = normaliseHex(value);
    if (!hex) return { status: "error", message: "Enter a colour as six hex digits, like #0b6e8a." };
    const verdict = checkAccent(hex, theme);
    if (!verdict.ok) return { status: "error", message: failureMessage(verdict, theme) };
    next = hex;
  }
  if (!(await signedInClient())) return signedOut;
  const out = await saveField("workspaces", { id: workspaceId }, theme === "light" ? "branding.accent" : "branding.accent_dark", base, next);
  if (out.status === "saved") refresh();
  return out;
}

/**
 * Keep a logo the browser sends as form data (`workspaceId`, `base`, `file`): check its content, then store its bytes if the
 * stored logo is still `base` (the hash of the one the person was looking at; blank for none). Owners and agency admins only.
 */
export async function attachWorkspaceLogo(form: unknown): Promise<LogoResult> {
  if (!(form instanceof FormData)) return invalid;
  const workspaceId = form.get("workspaceId");
  const rawBase = form.get("base");
  const file = form.get("file");
  if (!isId(workspaceId) || !(rawBase === "" || isLogoSha(rawBase)) || !(file instanceof Blob)) return invalid;
  const base = rawBase === "" ? null : (rawBase as string);
  if (file.size > MAX_LOGO_BYTES) return { status: "error", message: LOGO_ERRORS.big };
  if (!(await signedInClient())) return signedOut;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let checked: ReturnType<typeof checkLogo>;
  try {
    checked = checkLogo(bytes);
  } catch {
    return { status: "error", message: "Couldn't read that logo. Try again." };
  }
  if (!checked.ok) return { status: "error", message: checked.error };
  const logo = { mime: LOGO_MIME[checked.type], bytes: Buffer.from(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  const db = await getDb();
  try {
    if (!(await rpc(db, "can_manage_workspace", { ws: workspaceId }))) return { status: "error", message: OWNERS_ONLY };
    if ((await saveWorkspaceLogo(db, workspaceId, base, logo)) === "conflict") return { status: "error", message: CHANGED };
  } catch (e) {
    return { status: "error", message: pgError(e).code === "42501" ? OWNERS_ONLY : "Couldn't save the logo. Try again." };
  }
  refresh();
  return { status: "ok", sha: logo.sha256, url: logoUrl(workspaceId, logo.sha256) };
}

/** Remove the logo, if the stored one is still `base` (its hash). */
export async function removeWorkspaceLogo(workspaceId: unknown, base: unknown): Promise<LogoResult> {
  if (!isId(workspaceId) || !isLogoSha(base)) return invalid;
  if (!(await signedInClient())) return signedOut;
  const db = await getDb();
  try {
    if (!(await rpc(db, "can_manage_workspace", { ws: workspaceId }))) return { status: "error", message: OWNERS_ONLY };
    if ((await deleteWorkspaceLogo(db, workspaceId, base)) === "conflict") return { status: "error", message: CHANGED };
  } catch (e) {
    return { status: "error", message: pgError(e).code === "42501" ? OWNERS_ONLY : "Couldn't remove the logo. Try again." };
  }
  refresh();
  return { status: "ok", sha: null, url: null };
}
