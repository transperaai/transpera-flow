// Client branding (issue #34): the custom properties of the Branding page's preview panels. Each panel sets its own theme's
// tokens on its wrapper, so light and dark show side by side whatever theme the page itself is in. Grey values are made from
// the same OKLCH numbers as tokens.css, so no raw hex lives outside lib/branding.

import { DEFAULT_ACCENT, SURFACES, accentTokens, oklchToHex, type AccentTokens, type Theme } from "./contrast";

const GREYS: Record<Theme, { fg: number; fg2: number; line: number }> = {
  light: { fg: 0.145, fg2: 0.44, line: 0.922 },
  dark: { fg: 0.985, fg2: 0.76, line: 0.3 },
};

/** The tokens a preview panel sets: the theme's surfaces and text, and the accent (the workspace's, or Transpera's default). */
export function previewVars(theme: Theme, tokens: AccentTokens | null): Record<string, string> {
  const t = tokens ?? accentTokens(DEFAULT_ACCENT[theme], theme);
  const s = SURFACES[theme];
  const g = GREYS[theme];
  return {
    "--bg": s.bg,
    "--panel": s.panel,
    "--panel-2": s.panel2,
    "--fg": oklchToHex(g.fg, 0, 0),
    "--fg-2": oklchToHex(g.fg2, 0, 0),
    "--line": oklchToHex(g.line, 0, 0),
    "--accent": t.accent,
    "--accent-fg": t.accentFg,
    "--accent-soft": t.accentSoft,
    "--ring": t.accent,
  };
}
