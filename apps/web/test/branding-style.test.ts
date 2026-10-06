import { describe, expect, it } from "vitest";
import { brandingCss, failureMessage, logoUrl, readBranding, resolveBranding, type Branding } from "@/lib/branding/branding";
import { checkAccent, deriveDarkAccent, oklchToHex, type Hex, type Theme } from "@/lib/branding/contrast";

// Client branding (issue #34, B5): what a stored branding becomes on screen. The CSS carries only values that came out of the
// colour maths, and a stored accent that fails contrast is ignored at render time.

const WS = "0d5f6f0e-0000-4000-8000-000000000001";
const OTHER = "0d5f6f0e-0000-4000-8000-000000000002";
const UUID = "11111111-2222-4333-8444-555555555555";
const none: Branding = { accent: null, accentDark: null, logoPath: null };
const SAFE = /^[:a-z0-9#\-;{}()[\]="\s@,]*$/i;

describe("brandingCss", () => {
  it("is null when nothing is branded", () => {
    expect(brandingCss(none)).toBeNull();
    expect(brandingCss(readBranding({}, WS))).toBeNull();
    expect(brandingCss(readBranding(null, WS))).toBeNull();
    // A logo alone sets no colours.
    expect(brandingCss({ ...none, logoPath: `${WS}/${UUID}.png` })).toBeNull();
  });

  it("an accent gives the light block and, derived, the two dark ones, with tokens.css's selectors", () => {
    const css = brandingCss({ ...none, accent: "#0b6e8a" })!;
    const dark = deriveDarkAccent("#0b6e8a");
    expect(css.split("\n")).toHaveLength(3);
    expect(css).toMatch(/^:root\{--accent:#0b6e8a;--accent-fg:#[0-9a-f]{6};--accent-soft:#[0-9a-f]{6}\}$/m);
    expect(css).toContain(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:${dark};`);
    expect(css).toMatch(new RegExp(`^:root\\[data-theme="dark"\\]\\{--accent:${dark};--accent-fg:#[0-9a-f]{6};--accent-soft:#[0-9a-f]{6}\\}$`, "m"));
    expect(css).toMatch(SAFE);
  });

  it("a custom dark accent replaces the derived one; a failing custom dark accent falls back to the derived", () => {
    expect(brandingCss({ ...none, accent: "#0b6e8a", accentDark: "#4cc3e0" })).toContain("--accent:#4cc3e0;");
    const css = brandingCss({ ...none, accent: "#0b6e8a", accentDark: "#000080" })!;
    expect(css).not.toContain("#000080");
    expect(css).toContain(`--accent:${deriveDarkAccent("#0b6e8a")};`);
  });

  it("a dark accent on its own gives only the dark blocks", () => {
    const css = brandingCss({ ...none, accentDark: "#4cc3e0" })!;
    expect(css.split("\n")).toHaveLength(2);
    expect(css).not.toMatch(/^:root\{/m);
  });

  it("a stored accent that fails contrast is dropped, and so is the dark shade that would come from it (render-time guard)", () => {
    const failing = { ...none, accent: "#ffff00" as const };
    expect(checkAccent("#ffff00", "light").ok).toBe(false);
    // Settings shows the default dark accent for it too, so the shell and the page agree.
    expect(resolveBranding(failing)).toEqual({ light: null, dark: null });
    expect(brandingCss(failing)).toBeNull();
    // A custom dark accent that passes still applies beside a failing light one; a failing one never does.
    expect(resolveBranding({ ...failing, accentDark: "#4cc3e0" })).toMatchObject({ light: null, dark: { accent: "#4cc3e0" } });
    expect(brandingCss({ ...none, accentDark: "#000080" })).toBeNull();
    expect(brandingCss({ ...failing, accentDark: "#000080" })).toBeNull();
  });

  it("every colour it writes passes in its own theme", () => {
    for (const accent of ["#0b6e8a", "#7a1fa2", "#000000", "#595959", "#b00020"] as const) {
      const r = resolveBranding({ ...none, accent });
      expect(checkAccent(r.light!.accent, "light").ok, accent).toBe(true);
      expect(checkAccent(r.dark!.accent, "dark").ok, accent).toBe(true);
    }
  });
});

describe("readBranding", () => {
  it("reads a good value", () => {
    expect(readBranding({ accent: "#0b6e8a", accent_dark: "#4cc3e0", logo_path: `${WS}/${UUID}.webp` }, WS)).toEqual({ accent: "#0b6e8a", accentDark: "#4cc3e0", logoPath: `${WS}/${UUID}.webp` });
  });

  it("turns anything malformed into null", () => {
    const injected = readBranding({ accent: "#fff;}body{display:none", accent_dark: "red" }, WS);
    expect(injected).toEqual(none);
    expect(brandingCss(injected)).toBeNull();
    expect(readBranding({ logo_path: `${OTHER}/${UUID}.png` }, WS).logoPath).toBeNull(); // another workspace's folder
    expect(readBranding({ logo_path: `${WS}/${UUID}.svg` }, WS).logoPath).toBeNull();
    expect(readBranding({ logo_path: `${WS}/x/${UUID}.png` }, WS).logoPath).toBeNull();
    expect(readBranding({ accent: 5, accent_dark: ["#aabbcc"], logo_path: 7 }, WS)).toEqual(none);
    expect(readBranding({ accent: "#FFF" }, WS).accent).toBeNull();
    for (const raw of [null, undefined, "x", 5, [], true]) expect(readBranding(raw, WS)).toEqual(none);
  });

  it("whatever is stored, the output is safe CSS", () => {
    const css = brandingCss(readBranding({ accent: "#0b6e8a", accent_dark: "#4cc3e0;}body{x:y" }, WS))!;
    expect(css).toMatch(SAFE);
  });
});

describe("logoUrl", () => {
  const path = `${WS}/${UUID}.png`;
  it("builds the public URL", () => {
    expect(logoUrl(path, "https://abc.supabase.co")).toBe(`https://abc.supabase.co/storage/v1/object/public/branding/${path}`);
    expect(logoUrl(path, "https://abc.supabase.co/")).toBe(`https://abc.supabase.co/storage/v1/object/public/branding/${path}`);
  });
  it("is null without a path or a URL, or for a path off the layout", () => {
    expect(logoUrl(null, "https://abc.supabase.co")).toBeNull();
    expect(logoUrl(path, undefined)).toBeNull();
    expect(logoUrl(path, "")).toBeNull();
    expect(logoUrl("../x.png", "https://abc.supabase.co")).toBeNull();
  });
});

describe("failureMessage names the surface that actually fails", () => {
  /** The first colour in a fixed sweep of lightness and hue whose worst pair is `pair` in `theme`. */
  const find = (pair: string, theme: Theme): Hex => {
    for (let l = 0.2; l <= 0.95; l += 0.01) {
      for (let h = 0; h < 360; h += 5) {
        const hex = oklchToHex(l, 0.12, h);
        const v = checkAccent(hex, theme);
        if (!v.ok && v.against === pair) return hex;
      }
    }
    throw new Error(`no colour fails first on ${pair} in ${theme}`);
  };
  const say = (hex: Hex, theme: Theme) => {
    const v = checkAccent(hex, theme);
    if (v.ok) throw new Error("passes");
    return failureMessage(v, theme);
  };

  it("the highlight tint, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(say(find("soft", theme), theme), theme).toMatch(
        /^Too (light|dark) to read on its own highlight tint \(count badges\): \d\.\d:1, and text needs 4\.5:1\. Try #[0-9a-f]{6}, the nearest (darker|lighter) shade\.$/,
      );
    }
  });
  it("grey panels, in both themes", () => {
    expect(say(find("panel2", "light"), "light")).toMatch(/^Too light to read on grey panels: /);
    expect(say(find("panel2", "dark"), "dark")).toMatch(/^Too dark to read on dark grey panels: /);
  });
  it("the page itself keeps the brief's wording", () => {
    expect(say("#ffff00", "light")).toMatch(/^Too light to read on a white page: /);
    expect(say("#000080", "dark")).toMatch(/^Too dark to read on the dark page: /);
  });
  it("the number it quotes is the failing pair's own", () => {
    for (const theme of ["light", "dark"] as const) {
      const hex = find("soft", theme);
      const v = checkAccent(hex, theme);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(say(hex, theme)).toContain(`${(Math.floor(v.worst * 10) / 10).toFixed(1)}:1`);
    }
  });
});
