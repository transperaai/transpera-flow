/**
 * How a screen is used. `live`: a signed-in editor, who saves to the server. `readonly`: a signed-in member or viewer (or an
 * earlier version): nothing can be changed. `demo`: in memory (the public demo pages are gone, but the screens still take it).
 */
export type ScreenMode = "live" | "demo" | "readonly";

/** Nothing on screen can be changed. */
export const isReadOnly = (m: ScreenMode): m is "readonly" => m === "readonly";

/** Reads and writes go to the server (server actions). */
export const usesServer = (m: ScreenMode): boolean => m === "live" || m === "readonly";
