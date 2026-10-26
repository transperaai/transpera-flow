// Client branding (issue #34): what a workspace's stored branding becomes on screen. Pure and framework-free.

import { accentTokens, checkAccent, deriveDarkAccent, type AccentTokens, type AccentVerdict, type Hex, type Theme } from "./contrast";

export interface Branding {
  accent: Hex | null;
  accentDark: Hex | null;
}

const STORED_HEX = /^#[0-9a-f]{6}$/;

const hexOrNull = (v: unknown): Hex | null => (typeof v === "string" && STORED_HEX.test(v) ? (v as Hex) : null);

/** The stored jsonb -> Branding. Anything malformed (wrong type, bad hex) reads as null. The logo is not in it: see `logoUrl`. */
export function readBranding(raw: unknown): Branding {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { accent: hexOrNull(o.accent), accentDark: hexOrNull(o.accent_dark) };
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

const SHA256 = /^[0-9a-f]{64}$/;
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `v` is a logo's SHA-256 as the database stores it: 64 lower-case hex digits. */
export const isLogoSha = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);

/**
 * The logo's address: the app's own route, with the first 12 characters of its hash so a new logo is a new address (the route
 * itself is cached for five minutes). Null when the workspace has no logo.
 */
export function logoUrl(workspaceId: string, sha256: string | null): string | null {
  if (!sha256 || !SHA256.test(sha256) || !WORKSPACE_ID.test(workspaceId.toLowerCase())) return null;
  return `/api/branding/${workspaceId.toLowerCase()}/logo?v=${sha256.slice(0, 12)}`;
}

/** What the logo actions answer: the kept logo's hash and URL (both null once removed), or a plain message. */
export type LogoResult = { status: "ok"; sha: string | null; url: string | null } | { status: "error"; message: string };

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
