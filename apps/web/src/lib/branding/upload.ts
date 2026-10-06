// Uploading a workspace's logo from the browser (issue #34, B5). The file goes straight to the public `branding` bucket in
// Supabase Storage as the signed-in user, under `<workspace id>/<new uuid>.<type>` (a name is never reused, so a year's cache
// is safe); the storage policies let only the workspace's owners and agency admins write there. Then the server action reads
// it back, checks its content and keeps it. The check here only refuses a wrong file early, with the same words.

import { attachWorkspaceLogo } from "@/app/w/[slug]/settings/branding/actions";
import { LOGO_ERRORS, LOGO_MIME, checkLogo } from "@/lib/branding/logo-check";
import type { LogoResult } from "@/lib/branding/branding";
import { createClient } from "@/lib/supabase/browser";

export async function uploadWorkspaceLogo(workspaceId: string, base: string | null, file: File): Promise<LogoResult> {
  const check = checkLogo(new Uint8Array(await file.arrayBuffer()));
  if (!check.ok) return { status: "error", message: check.error };
  const supabase = createClient();
  if (!supabase) return { status: "error", message: "Uploading a logo needs a workspace. Sign in to upload one." };
  const path = `${workspaceId}/${crypto.randomUUID()}.${check.type}`;
  // The content type is ours, from the checked content, not the browser's guess.
  const { error } = await supabase.storage.from("branding").upload(path, file, { contentType: LOGO_MIME[check.type], upsert: false, cacheControl: "31536000" });
  if (error) {
    const status = String((error as { statusCode?: string | number }).statusCode);
    return {
      status: "error",
      message: status === "413" ? LOGO_ERRORS.big : status === "403" ? "Only workspace owners can change the branding." : "Couldn't upload the logo. Try again.",
    };
  }
  return attachWorkspaceLogo(workspaceId, path, base);
}
