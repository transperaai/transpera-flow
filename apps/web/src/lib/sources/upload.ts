// Uploading a source's original file from the browser (issue #182, B19 2/2). The file goes straight to the private `sources`
// bucket in Supabase Storage as the signed-in user (so a 10 MB file never passes through the app's own server, whose request
// size is limited), under `<workspace id>/<new uuid>/<plain name>`; the storage policies let only the workspace's editors write
// there. Then the server action reads it back, checks it by name and content, reads its text and keeps it on the source.
// The checks here only refuse a wrong file early, with the same words.

import { attachSourceFile } from "@/app/w/[slug]/source-actions";
import { createClient } from "@/lib/supabase/browser";
import { SOURCE_FILE_MIME, checkSourceFile, safeFileName, storagePath } from "./file-check";
import type { AttachFileResult } from "./store";

export async function uploadSourceFile(workspaceId: string, sourceId: string, file: File): Promise<AttachFileResult> {
  const check = checkSourceFile(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!check.ok) return { status: "error", message: check.error };
  const supabase = createClient();
  if (!supabase) return { status: "error", message: "Uploading files needs a workspace. Sign in to upload one." };
  const path = storagePath(workspaceId, sourceId, crypto.randomUUID(), safeFileName(file.name, check.type));
  // The content type is ours, from the checked extension, not the browser's guess.
  const { error } = await supabase.storage.from("sources").upload(path, file, { contentType: SOURCE_FILE_MIME[check.type], upsert: false, cacheControl: "60" });
  if (error) {
    const status = (error as { statusCode?: string | number }).statusCode;
    return {
      status: "error",
      message: String(status) === "413" ? "That file is over 10 MB." : String(status) === "403" ? "Only owners and editors can upload files here." : "Couldn't upload the file. Try again.",
    };
  }
  return attachSourceFile(sourceId, path, file.name);
}
