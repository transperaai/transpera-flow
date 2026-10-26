// Where the process page and Editor save drafts: the database through Server
// Actions when signed in, memory on the public demo, and memory with nothing
// saved for block mode and share links.

import type { ProcessBundle } from "@transpera-flow/db";
import type { ScreenMode } from "@/lib/mode";
import { serverDraftBackend } from "./server-backend";
import { MemoryDraftBackend, type DraftBackend } from "./session";

/** Block mode (issue #116): edits live in memory only. Nothing is saved until the block is. */
export function connectScratch(live: ProcessBundle): DraftBackend {
  return new MemoryDraftBackend(live);
}

export function connect(mode: ScreenMode, live: ProcessBundle): DraftBackend {
  // A share link's page (B3) makes no server call at all.
  if (mode === "share") return connectScratch(live);
  if (mode === "demo") return new MemoryDraftBackend(live);
  return serverDraftBackend(live.process.id);
}
