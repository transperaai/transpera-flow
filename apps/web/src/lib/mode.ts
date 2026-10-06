/**
 * How a screen is used. `live`: a signed-in editor, who saves to the server. `readonly`: a signed-in member or viewer (or an
 * earlier version): nothing can be changed, but the page is still connected (Realtime). `demo`: the public demo, in memory.
 * `share`: a visitor's copy of a page behind a share link (B3): read only, and it makes no server or Realtime call at all.
 */
export type ScreenMode = "live" | "demo" | "readonly" | "share";

/** Nothing on screen can be changed. */
export const isReadOnly = (m: ScreenMode): m is "readonly" | "share" => m === "readonly" || m === "share";

/** Reads and writes go to the server (Supabase, server actions, Realtime). */
export const usesServer = (m: ScreenMode): boolean => m === "live" || m === "readonly";
