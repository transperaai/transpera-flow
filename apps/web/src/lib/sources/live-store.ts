import { createSource, deleteSource, linkSource, readSourceFile, saveSourceField, sourceFileLink, unlinkSource } from "@/app/w/[slug]/source-actions";
import type { SourceStore } from "./store";
import { uploadSourceFile } from "./upload";

/** Saves sources and their links to the database through Server Actions, as the signed-in user. */
export function liveSourceStore(workspaceId: string): SourceStore {
  return {
    create: (input, links) => createSource(workspaceId, input, links),
    saveField: (id, field, base, value) => saveSourceField(id, field, base, value),
    remove: (id) => deleteSource(id),
    link: (sourceId, target) => linkSource(sourceId, target),
    unlink: (linkId) => unlinkSource(linkId),
    attachFile: (sourceId, file) => uploadSourceFile(workspaceId, sourceId, file),
    fileLink: (sourceId) => sourceFileLink(sourceId),
    file: async (sourceId) => {
      const r = await readSourceFile(sourceId);
      if (r.status === "error") throw new Error(r.message);
      return r.file;
    },
  };
}
