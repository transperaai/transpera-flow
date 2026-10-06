"use server";

import { refresh } from "next/cache";
import { failureMessage, LOGO_PATH, logoUrl, type LogoResult } from "@/lib/branding/branding";
import { checkAccent, normaliseHex, type Theme } from "@/lib/branding/contrast";
import { MAX_LOGO_BYTES, checkLogo, LOGO_ERRORS } from "@/lib/branding/logo-check";
import { isId } from "@/lib/clients";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField } from "@/lib/fields/server";
import { createClient } from "@/lib/supabase/server";

// Client branding (issue #34, B5), from Settings -> Branding: the workspace's accent colour and logo. As the signed-in user
// through row-level security (never the service-role key): owners and agency admins change the workspace; the storage policies
// let only them write to the `branding` bucket. The database checks the shape of what is saved; contrast is checked here (and
// again when the page is drawn), so a failing colour never reaches the database.

const BUCKET = "branding";
const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const OWNERS_ONLY = "Only workspace owners can change the branding.";
const CHANGED = "Someone else changed the logo. Reload to see it.";

async function signedInClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

/** A logo path in this workspace's own folder, or null. */
const ownPath = (path: unknown, workspaceId: string): string | null =>
  typeof path === "string" && LOGO_PATH.test(path) && path.startsWith(`${workspaceId.toLowerCase()}/`) ? path : null;

const publicUrl = (path: string | null) => logoUrl(path, process.env.NEXT_PUBLIC_SUPABASE_URL);

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
 * Keep a logo the browser has just uploaded: read it back as the signed-in user, check its content, and save its path. The
 * upload is deleted on any refusal or error, and the logo it replaces is deleted once the new one is kept. An upload abandoned
 * before this runs is public under a random name (the sweep in docs/supabase-notes.md clears them).
 */
export async function attachWorkspaceLogo(workspaceId: unknown, path: unknown, base: unknown): Promise<LogoResult> {
  if (!isId(workspaceId)) return invalid;
  const newPath = ownPath(path, workspaceId);
  // Nothing outside this workspace's folder is touched, not even to clean up.
  if (!newPath) return invalid;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const storage = supabase.storage.from(BUCKET);
  const refuse = async (message: string): Promise<LogoResult> => {
    await storage.remove([newPath]);
    return { status: "error", message };
  };
  const oldPath = base === null ? null : ownPath(base, workspaceId);
  if (base !== null && !oldPath) return refuse(invalid.message);
  if (oldPath === newPath) return invalid;

  const { data: blob, error: downloadError } = await storage.download(newPath);
  if (downloadError || !blob) return refuse("Couldn't read the uploaded logo. Upload it again.");
  if (blob.size > MAX_LOGO_BYTES) return refuse(LOGO_ERRORS.big);
  let checked: ReturnType<typeof checkLogo>;
  try {
    checked = checkLogo(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return refuse("Couldn't read that logo. Try again.");
  }
  if (!checked.ok) return refuse(checked.error);
  // The type is what the bytes say; a PNG renamed .jpg is refused rather than stored under a lying name.
  if (!newPath.endsWith(`.${checked.type}`)) return refuse(LOGO_ERRORS.type);

  const out = await saveField("workspaces", { id: workspaceId }, "branding.logo_path", oldPath, newPath);
  if (out.status === "conflict") return refuse(CHANGED);
  if (out.status === "not_found") return refuse(OWNERS_ONLY);
  if (out.status === "error") return refuse(out.message);
  if (oldPath) await storage.remove([oldPath]);
  refresh();
  return { status: "ok", path: newPath, url: publicUrl(newPath) };
}

/** Remove the logo: save null, then delete the object. */
export async function removeWorkspaceLogo(workspaceId: unknown, base: unknown): Promise<LogoResult> {
  if (!isId(workspaceId)) return invalid;
  const oldPath = ownPath(base, workspaceId);
  if (!oldPath) return invalid;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const out = await saveField("workspaces", { id: workspaceId }, "branding.logo_path", oldPath, null);
  if (out.status === "conflict") return { status: "error", message: CHANGED };
  if (out.status === "not_found") return { status: "error", message: OWNERS_ONLY };
  if (out.status === "error") return out;
  await supabase.storage.from(BUCKET).remove([oldPath]);
  refresh();
  return { status: "ok", path: null, url: null };
}
