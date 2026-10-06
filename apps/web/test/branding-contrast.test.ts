import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCENT,
  MIN_CONTRAST,
  RESERVED,
  SURFACES,
  accentChecks,
  accentTokens,
  checkAccent,
  contrastRatio,
  deriveDarkAccent,
  hexToOklch,
  normaliseHex,
  oklchToHex,
  relativeLuminance,
  reservedClash,
  suggestAccent,
  type Hex,
  type Theme,
} from "@/lib/branding/contrast";

// Client branding (issue #34, B5): the contrast maths. The surfaces and defaults are re-derived from tokens.css, so a token
// change breaks this test, not production.

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"] {'));
const token = (block: string, name: string): string => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`no --${name}`);
  return m[1]!.trim();
};
/** A token's value as hex: an oklch() converts, a #hex passes. */
const asHex = (value: string): Hex => {
  const o = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (o) return oklchToHex(Number(o[1]), Number(o[2]), Number(o[3]));
  const h = normaliseHex(value);
  if (!h) throw new Error(`cannot read ${value}`);
  return h;
};
const blocks: Record<Theme, string> = { light: lightBlock, dark: darkBlock };

describe("luminance and ratio", () => {
  it("known pairs", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(MIN_CONTRAST);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#000000")).toBe(0);
  });
});

describe("tokens.css", () => {
  it("SURFACES and DEFAULT_ACCENT equal what tokens.css converts to", () => {
    for (const theme of ["light", "dark"] as const) {
      const b = blocks[theme];
      expect(SURFACES[theme]).toEqual({ bg: asHex(token(b, "bg")), panel: asHex(token(b, "panel")), panel2: asHex(token(b, "panel-2")) });
    }
    // The accent's oklch() is just outside sRGB (Tailwind's cyan 700 and 500); the hex constants are Tailwind's own clipped
    // values, and chroma reduction lands a few steps away in blue. Close enough that the contrast verdict is the same.
    for (const theme of ["light", "dark"] as const) {
      const fromCss = asHex(token(blocks[theme], "accent"));
      for (const at of [1, 3, 5]) expect(Math.abs(parseInt(fromCss.slice(at, at + 2), 16) - parseInt(DEFAULT_ACCENT[theme].slice(at, at + 2), 16)), theme).toBeLessThanOrEqual(8);
      expect(checkAccent(fromCss, theme).ok, theme).toBe(true);
    }
  });

  it("the reserved colours equal tokens.css's --edit, --crit, --warn and --good", () => {
    for (const theme of ["light", "dark"] as const) {
      const b = blocks[theme];
      expect(RESERVED[theme]).toEqual({ editing: asHex(token(b, "edit")), critical: asHex(token(b, "crit")), warning: asHex(token(b, "warn")), good: asHex(token(b, "good")) });
    }
  });

  it("the defaults pass every pair, with the numbers the brief records", () => {
    const ratios = (accent: Hex, theme: Theme) => Object.fromEntries(accentChecks(accent, theme).map((r) => [r.pair, Number(r.ratio.toFixed(2))]));
    expect(ratios(DEFAULT_ACCENT.light, "light")).toMatchObject({ bg: 5.06, panel: 5.28, panel2: 4.84, soft: 4.57, fg: 5.28 });
    expect(ratios(DEFAULT_ACCENT.dark, "dark")).toMatchObject({ bg: 8.37, panel: 7.58, panel2: 6.4 });
    expect(ratios(DEFAULT_ACCENT.dark, "dark").soft).toBeGreaterThan(5.5);
    expect(ratios(DEFAULT_ACCENT.dark, "dark").fg).toBeGreaterThan(7);
    for (const theme of ["light", "dark"] as const) expect(checkAccent(DEFAULT_ACCENT[theme], theme).ok).toBe(true);
  });

  it("the soft tints are near the ones in tokens.css (the formula takes the accent's own hue)", () => {
    expect(accentTokens(DEFAULT_ACCENT.dark, "dark").accentSoft).toBe("#0d333d");
    expect(accentTokens(DEFAULT_ACCENT.light, "light").accentSoft).toBe("#def2fb");
  });
});

describe("normaliseHex", () => {
  it("accepts 3 or 6 digits, with or without #, any case, trimmed", () => {
    expect(normaliseHex("ABC")).toBe("#aabbcc");
    expect(normaliseHex("#abc")).toBe("#aabbcc");
    expect(normaliseHex("#AABBCC")).toBe("#aabbcc");
    expect(normaliseHex("  0b6E8a ")).toBe("#0b6e8a");
  });
  it("refuses everything else", () => {
    for (const bad of ["#abcd", "rgb(1,2,3)", "red", "#gg0000", "", " ", "#", "#aabbccdd", "#fff;}", null, undefined, 5, {}]) expect(normaliseHex(bad), String(bad)).toBeNull();
  });
});

describe("accentTokens", () => {
  it("button text is white on a dark accent and near-black on a light one", () => {
    expect(accentTokens("#000080", "light").accentFg).toBe("#ffffff");
    expect(accentTokens("#007595", "light").accentFg).toBe("#ffffff");
    expect(accentTokens("#ffff00", "dark").accentFg).toBe("#0a0a0a");
    expect(accentTokens("#00b8db", "dark").accentFg).toBe("#0a0a0a");
  });
});

describe("OKLCH round trip", () => {
  it("returns the colour it was given (within rounding), and greys keep C = 0", () => {
    for (const hex of ["#007595", "#ff00ff", "#6d3fc4", "#eda100"] as const) {
      const { l, c, h } = hexToOklch(hex);
      const back = oklchToHex(l, c, h);
      for (const at of [1, 3, 5]) expect(Math.abs(parseInt(back.slice(at, at + 2), 16) - parseInt(hex.slice(at, at + 2), 16))).toBeLessThanOrEqual(1);
    }
    expect(hexToOklch("#808080").c).toBe(0);
    expect(oklchToHex(0.5, 0, 0)).toBe("#636363");
    expect(oklchToHex(1, 0.3, 120)).toBe("#ffffff");
    expect(oklchToHex(0, 0.3, 120)).toBe("#000000");
  });
});

const hueGap = (a: Hex, b: Hex) => {
  const d = Math.abs(hexToOklch(a).h - hexToOklch(b).h);
  return Math.min(d, 360 - d);
};

describe("checkAccent and suggestAccent", () => {
  it("#ffff00 fails in the light theme; the suggestion passes, keeps its hue and is the nearest", () => {
    const v = checkAccent("#ffff00", "light");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.worst).toBeLessThan(MIN_CONTRAST);
    expect(checkAccent(v.suggestion, "light").ok).toBe(true);
    expect(hueGap("#ffff00", v.suggestion)).toBeLessThan(3);
    expect(v.suggestion).toBe(suggestAccent("#ffff00", "light"));
    // Nearest: a colour 0.01 of lightness lighter than the suggestion fails.
    const s = hexToOklch(v.suggestion);
    expect(checkAccent(oklchToHex(s.l + 0.01, s.c, s.h), "light").ok).toBe(false);
    expect(hexToOklch(v.suggestion).l).toBeLessThan(hexToOklch("#ffff00").l);
  });

  it("#000080 fails in the dark theme; the suggestion is lighter and passes", () => {
    const v = checkAccent("#000080", "dark");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(checkAccent(v.suggestion, "dark").ok).toBe(true);
    expect(hexToOklch(v.suggestion).l).toBeGreaterThan(hexToOklch("#000080").l);
    expect(hueGap("#000080", v.suggestion)).toBeLessThan(3);
    const s = hexToOklch(v.suggestion);
    expect(checkAccent(oklchToHex(s.l - 0.01, s.c, s.h), "dark").ok).toBe(false);
  });

  it("names the pair that fails worst, and the suggestion passes", () => {
    for (const hex of ["#ffff00", "#999999"] as const) {
      const v = checkAccent(hex, "light");
      expect(v.ok, hex).toBe(false);
      if (v.ok) continue;
      expect(["bg", "panel", "panel2", "soft", "fg"]).toContain(v.against);
      expect(checkAccent(v.suggestion, "light").ok, hex).toBe(true);
    }
  });

  it("a passing colour's suggestion is itself", () => {
    expect(suggestAccent("#007595", "light")).toBe("#007595");
    expect(suggestAccent("#00b8db", "dark")).toBe("#00b8db");
    expect(suggestAccent("#595959", "light")).toBe("#595959");
  });

  it("very saturated colours keep their hue as chroma allows", () => {
    for (const hex of ["#ff00ff", "#00ff00", "#ff0000", "#0000ff"] as const) {
      const s = suggestAccent(hex, "light");
      expect(checkAccent(s, "light").ok, hex).toBe(true);
      expect(hueGap(hex, s), hex).toBeLessThan(6);
    }
  });

  it("black passes the light theme, and its derived dark accent is a light grey; greys keep C = 0", () => {
    expect(checkAccent("#000000", "light").ok).toBe(true);
    const d = deriveDarkAccent("#000000");
    expect(checkAccent(d, "dark").ok).toBe(true);
    expect(hexToOklch(d).c).toBe(0);
    expect(hexToOklch(d).l).toBeGreaterThan(0.55);
    expect(checkAccent("#ffffff", "dark").ok).toBe(true);
    expect(checkAccent("#ffffff", "light").ok).toBe(false);
  });
});

describe("deriveDarkAccent", () => {
  it("passes for 200 hues and 3 lightnesses, and is never darker than its input", () => {
    for (let i = 0; i < 200; i++) {
      const h = (i * 360) / 200;
      for (const l of [0.3, 0.45, 0.6]) {
        const light = oklchToHex(l, 0.14, h);
        const dark = deriveDarkAccent(light);
        expect(checkAccent(dark, "dark").ok, `${light} -> ${dark}`).toBe(true);
        expect(hexToOklch(dark).l, `${light} -> ${dark}`).toBeGreaterThanOrEqual(hexToOklch(light).l - 0.004);
      }
    }
  });

  it("the default light accent derives a lighter blue that passes", () => {
    const d = deriveDarkAccent(DEFAULT_ACCENT.light);
    expect(checkAccent(d, "dark").ok).toBe(true);
    expect(hueGap(DEFAULT_ACCENT.light, d)).toBeLessThan(3);
  });
});

describe("reservedClash", () => {
  it("names the colour with a fixed meaning that the accent is close to; never refuses", () => {
    expect(reservedClash("#6d3fc4", "light")).toBe("editing");
    expect(reservedClash("#e34948", "light")).toBe("critical");
    expect(reservedClash("#eda100", "light")).toBe("warning");
    expect(reservedClash("#1baf7a", "light")).toBe("good");
    expect(reservedClash("#a37ef0", "dark")).toBe("editing");
  });
  it("a teal (the default) returns null in both themes", () => {
    expect(reservedClash("#007595", "light")).toBeNull();
    expect(reservedClash("#00b8db", "dark")).toBeNull();
    expect(reservedClash("#0b6e8a", "light")).toBeNull();
  });
});
