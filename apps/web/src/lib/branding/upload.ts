// Uploading a workspace's logo from the browser (issue #34, B5). The file goes to the server action as form data (512 KB at most,
// well inside a server action's body limit), which checks its content and stores the bytes in the database. The check here only
// refuses a wrong file early, with the same words.

import { attachWorkspaceLogo } from "@/app/w/[slug]/settings/branding/actions";
import { checkLogo } from "@/lib/branding/logo-check";
import type { LogoResult } from "@/lib/branding/branding";

/** `base` is the hash of the logo this one replaces (null when there is none), so a change made by someone else is noticed. */
export async function uploadWorkspaceLogo(workspaceId: string, base: string | null, file: File): Promise<LogoResult> {
  const check = checkLogo(new Uint8Array(await file.arrayBuffer()));
  if (!check.ok) return { status: "error", message: check.error };
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  form.set("base", base ?? "");
  form.set("file", file);
  return attachWorkspaceLogo(form);
}
