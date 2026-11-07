// Contrast maths for the token tests (map-tile.test.ts): WCAG 2.x contrast ratio and OKLCH -> sRGB, moved here from the client
// branding folder when that was removed (D70). Test-only.

/** Always normalised: lower case, six digits. */
export type Hex = `#${string}`;

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
