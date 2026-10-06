// Client branding (issue #34): what a workspace's stored branding becomes on screen. Pure and framework-free.

import { accentTokens, checkAccent, deriveDarkAccent, type AccentTokens, type Hex } from "./contrast";

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
 * guard): a stored accent that fails is ignored for that theme, whatever wrote it. The dark theme uses `accentDark` if set
 * and passing, else the accent's derived dark shade, else null.
 */
export function resolveBranding(b: Branding): { light: AccentTokens | null; dark: AccentTokens | null } {
  const light = b.accent && checkAccent(b.accent, "light").ok ? accentTokens(b.accent, "light") : null;
  let dark: AccentTokens | null = null;
  if (b.accentDark && checkAccent(b.accentDark, "dark").ok) dark = accentTokens(b.accentDark, "dark");
  else if (b.accent) dark = accentTokens(deriveDarkAccent(b.accent), "dark");
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
