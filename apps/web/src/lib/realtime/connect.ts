// Where the process page saves and hears about other people's changes
// (issues #9, #10): the database and Supabase Realtime when signed in; memory
// and an in-memory Realtime with a simulated colleague on the public demo.

import type { ProcessBundle } from "@transpera-flow/db";
import { serverDraftBackend } from "@/lib/drafts/server-backend";
import { MemoryDraftBackend, type DraftBackend } from "@/lib/drafts/session";
import { createClient } from "@/lib/supabase/browser";
import type { ScreenMode } from "@/lib/mode";
import { DemoColleague } from "./demo-colleague";
import { MemoryRealtime } from "./memory";
import { supabaseRevisionReader } from "./supabase-reads";
import { supabaseTransport, type RealtimeClientLike } from "./supabase-transport";
import type { RealtimeTransport } from "./transport";

export interface Connection {
  backend: DraftBackend;
  /** Null when Realtime isn't available (Supabase not configured). */
  transport: RealtimeTransport | null;
  /** The demo's simulated colleague. */
  colleague: DemoColleague | null;
}

/** How long the demo's in-memory Realtime takes to deliver, like a network. */
const DEMO_LATENCY_MS = 250;

/** Block mode (issue #116): edits live in memory only, with no Realtime and no simulated colleague. Nothing is saved until the block is. */
export function connectScratch(live: ProcessBundle): Connection {
  return { backend: new MemoryDraftBackend(live, null), transport: null, colleague: null };
}

export function connect(mode: ScreenMode, live: ProcessBundle): Connection {
  const processId = live.process.id;
  // A share link's page (B3) makes no server or Realtime call, and has no colleague.
  if (mode === "share") return connectScratch(live);
  if (mode === "demo") {
    const realtime = new MemoryRealtime(DEMO_LATENCY_MS);
    const memory = new MemoryDraftBackend(live, realtime);
    const colleague = new DemoColleague(memory, realtime, processId);
    return { backend: colleague.wrap(memory), transport: realtime, colleague };
  }
  const client = createClient();
  const server = serverDraftBackend(processId);
  if (!client) return { backend: server, transport: null, colleague: null };
  return {
    backend: { ...server, ...supabaseRevisionReader(client, processId) },
    transport: supabaseTransport(client as unknown as RealtimeClientLike),
    colleague: null,
  };
}
