// Client branding (issue #34): what a workspace's stored branding becomes on screen. Pure and framework-free.

import { accentTokens, checkAccent, deriveDarkAccent, type AccentTokens, type AccentVerdict, type Hex, type Theme } from "./contrast";

export interface Branding {
  accent: Hex | null;
  accentDark: Hex | null;
  logoPath: string | null;
}

export const LOGO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

const STORED_HEX = /^#[0-9a-f]{6}$/;

const hexOrNull = (v: unknown): Hex | null => (typeof v === "string" && STORED_HEX.test(v) ? (v as Hex) : null);

/** The stored jsonb -> Branding. Anything malformed (wrong type, bad hex, a path outside `<workspaceId>/`) reads as null. */
export function readBranding(raw: unknown, workspaceId: string): Branding {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const path = o.logo_path;
  const logoPath = typeof path === "string" && LOGO_PATH.test(path) && path.startsWith(`${workspaceId.toLowerCase()}/`) ? path : null;
  return { accent: hexOrNull(o.accent), accentDark: hexOrNull(o.accent_dark), logoPath };
}

/**
 * What the shell applies: per theme, the three tokens, or null to keep the defaults. Re-checks contrast (the render-time
 * guard): a stored accent that fails is ignored, whatever wrote it, and so is the dark shade that would come from it
 * (Settings shows the same). The dark theme uses `accentDark` if set and passing, else the derived dark shade of a light
 * accent that passes, else null.
 */
export function resolveBranding(b: Branding): { light: AccentTokens | null; dark: AccentTokens | null } {
  const light = b.accent && checkAccent(b.accent, "light").ok ? accentTokens(b.accent, "light") : null;
  let dark: AccentTokens | null = null;
  if (b.accentDark && checkAccent(b.accentDark, "dark").ok) dark = accentTokens(b.accentDark, "dark");
  // Derived only from a light accent that passes: a failing one is ignored in both themes, so the page and Settings agree.
  else if (light && b.accent) dark = accentTokens(deriveDarkAccent(b.accent), "dark");
  return { light, dark };
}

const declarations = (t: AccentTokens): string => `--accent:${t.accent};--accent-fg:${t.accentFg};--accent-soft:${t.accentSoft}`;

/** The CSS the layout injects, or null when nothing is branded. Mirrors tokens.css's selectors so specificity matches. */
export function brandingCss(b: Branding): string | null {
  const { light, dark } = resolveBranding(b);
  const blocks: string[] = [];
  if (light) blocks.push(`:root{${declarations(light)}}`);
  if (dark) {
    blocks.push(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${declarations(dark)}}}`);
    blocks.push(`:root[data-theme="dark"]{${declarations(dark)}}`);
  }
  return blocks.length ? blocks.join("\n") : null;
}

/** The logo's public URL from NEXT_PUBLIC_SUPABASE_URL, or null. */
export function logoUrl(path: string | null, supabaseUrl: string | undefined): string | null {
  if (!path || !supabaseUrl || !LOGO_PATH.test(path)) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/branding/${path}`;
}

/** What the logo actions answer: the kept path and its public URL (both null once removed), or a plain message. */
export type LogoResult = { status: "ok"; path: string | null; url: string | null } | { status: "error"; message: string };

/** A ratio as a person reads it. A failing one is rounded down, so "4.5:1" never sits beside a refusal. */
export function formatRatio(ratio: number, passing: boolean): string {
  const v = passing ? Math.round(ratio * 10) / 10 : Math.floor(ratio * 10) / 10;
  return `${v.toFixed(1)}:1`;
}

/** The sentence for a failing accent: what is wrong, the number, and the nearest passing colour. */
export function failureMessage(v: Extract<AccentVerdict, { ok: false }>, theme: Theme): string {
  const shade = theme === "light" ? "darker" : "lighter";
  const needs = `${formatRatio(v.worst, false)}, and text needs 4.5:1`;
  const fix = `Try ${v.suggestion}, the nearest ${shade} shade.`;
  if (v.against === "fg") return `Button text can't be read on this colour: ${needs}. ${fix}`;
  const tone = theme === "light" ? "light" : "dark";
  const where =
    v.against === "soft"
      ? "on its own highlight tint (count badges)"
      : v.against === "panel2"
        ? theme === "light" ? "on grey panels" : "on dark grey panels"
        : theme === "light" ? "on a white page" : "on the dark page";
  return `Too ${tone} to read ${where}: ${needs}. ${fix}`;
}
