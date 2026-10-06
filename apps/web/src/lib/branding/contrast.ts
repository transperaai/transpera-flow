// Client branding (issue #34): contrast maths for a workspace's accent colour. Pure and framework-free, so the browser, the
// server actions and the tests share it. WCAG 2.x relative luminance and contrast ratio, plus OKLCH <-> sRGB for moving a
// colour's lightness while keeping its hue. Hex lives only in this folder (and in the CSS it generates), never in components.

export type Theme = "light" | "dark";
/** Always normalised: lower case, six digits. */
export type Hex = `#${string}`;

/** WCAG AA for normal text: the accent is used as small text (links, badges, icons), so 4.5:1, not 3:1. */
export const MIN_CONTRAST = 4.5;

/** "#ABC", "abc", "#AABBCC" -> "#aabbcc"; anything else -> null. Accepts 3 or 6 hex digits, optional '#', trims. */
export function normaliseHex(input: unknown): Hex | null {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const d = m[1]!.toLowerCase();
  const six = d.length === 3 ? [...d].map((x) => x + x).join("") : d;
  return `#${six}`;
}

type Rgb = [number, number, number];
const toRgb = (hex: Hex): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const toHex = (rgb: Rgb): Hex => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

const srgbToLinear = (v8: number): number => {
  const v = v8 / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
};

/** WCAG 2.x relative luminance from 8-bit sRGB (0.04045 threshold, 2.4 exponent). */
export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = toRgb(hex).map(srgbToLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** (L1 + 0.05) / (L2 + 0.05), larger over smaller. */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- OKLab / OKLCH (Bjorn Ottosson's matrices) ---

interface Lab {
  l: number;
  a: number;
  b: number;
}

function linearToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(lab: Lab): Rgb {
  const l = Math.pow(lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const hexToLab = (hex: Hex): Lab => {
  const [r, g, b] = toRgb(hex).map(srgbToLinear) as Rgb;
  return linearToOklab(r, g, b);
};

export function hexToOklch(hex: Hex): { l: number; c: number; h: number } {
  const { l, a, b } = hexToLab(hex);
  const c = Math.sqrt(a * a + b * b);
  // Hue is undefined for greys: keep C = 0.
  if (c < 1e-4) return { l, c: 0, h: 0 };
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c, h: h < 0 ? h + 360 : h };
}

const EPS = 1e-6;
const inGamut = (rgb: Rgb): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS);
const labFrom = (l: number, c: number, h: number): Lab => ({ l, a: c * Math.cos((h * Math.PI) / 180), b: c * Math.sin((h * Math.PI) / 180) });

/** OKLCH (L 0-1, C, h degrees) -> hex, reducing chroma until it is inside sRGB (never clipping channels). */
export function oklchToHex(l: number, c: number, h: number): Hex {
  const lightness = Math.max(0, Math.min(1, l));
  let chroma = Math.max(0, c);
  let rgb = oklabToLinear(labFrom(lightness, chroma, h));
  if (!inGamut(rgb)) {
    // Bisection on chroma: the largest chroma that is still inside sRGB at this lightness and hue.
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(labFrom(lightness, mid, h)))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
    rgb = oklabToLinear(labFrom(lightness, chroma, h));
  }
  return toHex(rgb.map((v) => linearToSrgb(Math.max(0, Math.min(1, v)))) as Rgb);
}

// --- Surfaces and fixed colours ---

/** The theme surfaces an accent sits on, as hex, mirrored from tokens.css (a test re-derives them from tokens.css). */
export const SURFACES: Record<Theme, { bg: Hex; panel: Hex; panel2: Hex }> = {
  light: { bg: "#fafafa", panel: "#ffffff", panel2: "#f5f5f5" },
  dark: { bg: "#0a0a0a", panel: "#171717", panel2: "#262626" },
};

/** The defaults, for the "Reset" button's preview and the tests. */
export const DEFAULT_ACCENT: Record<Theme, Hex> = { light: "#007595", dark: "#00b8db" };

/** Colours with a fixed meaning, per theme, mirrored from tokens.css (`--edit`, `--crit`, `--warn`, `--good`). */
export const RESERVED: Record<Theme, Record<"editing" | "critical" | "warning" | "good", Hex>> = {
  light: { editing: "#6d3fc4", critical: "#e34948", warning: "#eda100", good: "#1baf7a" },
  dark: { editing: "#a37ef0", critical: "#e66767", warning: "#c98500", good: "#199e70" },
};

const WHITE: Hex = "#ffffff";
const NEAR_BLACK: Hex = "#0a0a0a";

type Pair = "bg" | "panel" | "panel2" | "soft" | "fg";
export type AccentTokens = { accent: Hex; accentFg: Hex; accentSoft: Hex };

/** The three tokens an accent sets in one theme. */
export function accentTokens(accent: Hex, theme: Theme): AccentTokens {
  const { c, h } = hexToOklch(accent);
  const accentSoft = theme === "light" ? oklchToHex(0.95, Math.min(c * 0.25, 0.04), h) : oklchToHex(0.3, Math.min(c * 0.35, 0.06), h);
  const accentFg = contrastRatio(accent, WHITE) >= contrastRatio(accent, NEAR_BLACK) ? WHITE : NEAR_BLACK;
  return { accent, accentFg, accentSoft };
}

/** Every pair that must reach MIN_CONTRAST, with its ratio, worst first. */
export function accentChecks(accent: Hex, theme: Theme): { pair: Pair; ratio: number }[] {
  const s = SURFACES[theme];
  const t = accentTokens(accent, theme);
  const rows: { pair: Pair; ratio: number }[] = [
    { pair: "bg", ratio: contrastRatio(accent, s.bg) },
    { pair: "panel", ratio: contrastRatio(accent, s.panel) },
    { pair: "panel2", ratio: contrastRatio(accent, s.panel2) },
    { pair: "soft", ratio: contrastRatio(accent, t.accentSoft) },
    { pair: "fg", ratio: contrastRatio(t.accentFg, accent) },
  ];
  return rows.sort((a, b) => a.ratio - b.ratio);
}

export type AccentVerdict = { ok: true; worst: number } | { ok: false; worst: number; against: Pair; suggestion: Hex };

const passes = (accent: Hex, theme: Theme): boolean => accentChecks(accent, theme)[0]!.ratio >= MIN_CONTRAST;

const STEP = 0.005;
/** The first colour, from lightness `l0` in steps of 0.005 towards black (light) or white (dark), that passes. */
function nearestPassing(l0: number, c: number, h: number, theme: Theme, fromStep: number): Hex {
  const dir = theme === "light" ? -1 : 1;
  const last = Math.ceil(1 / STEP) + 2;
  for (let k = fromStep; k <= last; k++) {
    const candidate = oklchToHex(l0 + dir * k * STEP, c, h);
    if (passes(candidate, theme)) return candidate;
  }
  // Unreachable: black passes in the light theme and white in the dark one.
  return theme === "light" ? "#000000" : WHITE;
}

/** The order a failure is reported in: the page first, then the surfaces and uses that are further from it. */
const REPORT_ORDER: Pair[] = ["bg", "panel", "panel2", "soft", "fg"];

/**
 * Passes when every pair reaches MIN_CONTRAST (`worst` is then the lowest ratio). When it fails, `against` is the first
 * failing pair in REPORT_ORDER and `worst` is that pair's own ratio, so a message can name the surface and quote its number.
 */
export function checkAccent(accent: Hex, theme: Theme): AccentVerdict {
  const checks = accentChecks(accent, theme);
  if (checks[0]!.ratio >= MIN_CONTRAST) return { ok: true, worst: checks[0]!.ratio };
  const failing = checks.filter((c) => c.ratio < MIN_CONTRAST).sort((a, b) => REPORT_ORDER.indexOf(a.pair) - REPORT_ORDER.indexOf(b.pair))[0]!;
  return { ok: false, worst: failing.ratio, against: failing.pair, suggestion: suggestAccent(accent, theme) };
}

/** The nearest passing colour: same hue (and chroma where sRGB allows), lightness moved darker (light) or lighter (dark). */
export function suggestAccent(accent: Hex, theme: Theme): Hex {
  if (passes(accent, theme)) return accent;
  const { l, c, h } = hexToOklch(accent);
  return nearestPassing(l, c, h, theme, 1);
}

/** The dark-theme accent made from a light-theme one: same hue, the smallest lightness >= the light one's that passes. */
export function deriveDarkAccent(light: Hex): Hex {
  const { l, c, h } = hexToOklch(light);
  return nearestPassing(Math.max(l, 0.6), c, h, "dark", 0);
}

/** A non-blocking note when the accent is close to a colour with a fixed meaning. */
export function reservedClash(accent: Hex, theme: Theme): "editing" | "critical" | "warning" | "good" | null {
  const a = hexToLab(accent);
  let best: { name: "editing" | "critical" | "warning" | "good"; d: number } | null = null;
  for (const [name, hex] of Object.entries(RESERVED[theme]) as ["editing" | "critical" | "warning" | "good", Hex][]) {
    const b = hexToLab(hex);
    const d = Math.sqrt((a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
    if (d < 0.08 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}
