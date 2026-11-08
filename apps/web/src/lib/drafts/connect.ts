// Where the process page and Editor save drafts: the database through Server
// Actions when signed in, and memory with nothing saved for block mode.

import type { ProcessBundle } from "@transpera-flow/db";
import type { ScreenMode } from "@/lib/mode";
import { serverDraftBackend } from "./server-backend";
import { MemoryDraftBackend, type DraftBackend } from "./session";

/** Block mode (issue #116): edits live in memory only. Nothing is saved until the block is. */
export function connectScratch(live: ProcessBundle): DraftBackend {
  return new MemoryDraftBackend(live);
}

export function connect(mode: ScreenMode, live: ProcessBundle): DraftBackend {
  if (mode === "demo") return new MemoryDraftBackend(live);
  return serverDraftBackend(live.process.id);
}
