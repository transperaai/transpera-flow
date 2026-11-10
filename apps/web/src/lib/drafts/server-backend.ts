import { discardDraft, openDraft, publishDraft } from "@/app/w/[slug]/actions";
import { liveStore } from "@/lib/editor/live-store";
import type { DraftBackend } from "./session";

/** Drafts in the database, through the editor's Server Actions, as the signed-in user. */
export function serverDraftBackend(processId: string): DraftBackend {
  return {
    open: () => openDraft(processId),
    discard: () => discardDraft(processId),
    publish: (acceptEstimates, draftId) => publishDraft(processId, acceptEstimates, draftId),
    store: (revisionId) => liveStore(revisionId),
  };
}
