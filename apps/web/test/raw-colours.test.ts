import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #44: dark mode works because components only use tokens. A raw colour in a component stays the same in both
// themes, so this fails on any raw colour outside the places that are allowed to hold one.
const SRC = join(__dirname, "../src");

const HEX = /(?<![^"'`(\[:,=\s])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/;
// Prose such as "issue #104" or "(#173)" is a pure-digit 3-4 character "hex" after a space or "(": an issue number, not a colour.
const ISSUE_REF = /(?<=^|[\s(])#\d{3,4}(?![0-9A-Za-z_-])/g;
const COLOUR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
const PALETTE =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|placeholder|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/;
const NAMED = /(?:fill|stroke|color|background(?:Color)?)\s*[=:]\s*["'{]\s*["']?(?:white|black)\b/;
const RULES: [string, RegExp][] = [
  ["hex colour", HEX],
  ["colour function", COLOUR_FN],
  ["Tailwind palette class", PALETTE],
  ["named colour", NAMED],
];

const ALLOWED_FILES: Record<string, string> = {
  "styles/tokens.css": "the tokens themselves",
  "lib/export/map-image.ts": "the exported PNG is always drawn light (a file, not the screen)",
  "lib/branding/contrast.ts": "contrast maths on the token values",
};
const ALLOWED_LINE = /like #[0-9a-fA-F]{6}/; // help text that shows how to type a colour

/** Blank out comments, keeping line numbers. Skips `//` that follows a colon (a URL) or sits inside a string on the same line only roughly. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function scan(src: string): { line: number; rule: string; text: string }[] {
  const hits: { line: number; rule: string; text: string }[] = [];
  stripComments(src)
    .split("\n")
    .forEach((text, i) => {
      if (ALLOWED_LINE.test(text)) return;
      const probe = text.replace(ISSUE_REF, "");
      for (const [rule, re] of RULES) if (re.test(probe)) hits.push({ line: i + 1, rule, text: text.trim() });
    });
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "prototype" || e.name === "stories" || e.name === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("the raw-colour rules", () => {
  const match = ["bg-white", "text-slate-500", "#fff", "'#1baf7a'", "rgba(0,0,0,.4)", "oklch(0.5 0 0)", 'fill="white"'];
  const noMatch = ["issue #104", "(#173)", "bg-panel", "text-crit-fg", "var(--accent)", "x // #123 adds", "/* #123 adds */ ok"];
  for (const s of match)
    it(`flags ${JSON.stringify(s)}`, () => {
      expect(scan(s).length).toBeGreaterThan(0);
    });
  for (const s of noMatch)
    it(`ignores ${JSON.stringify(s)}`, () => {
      expect(scan(s)).toEqual([]);
    });
});

describe("no raw colours outside the tokens (issue #44)", () => {
  const files = walk(SRC);
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  for (const [path, why] of Object.entries(ALLOWED_FILES)) it(`allows ${path}: ${why}`, () => expect(files.some((f) => relative(SRC, f).split(sep).join("/") === path)).toBe(true));

  it("finds none", () => {
    const found: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f).split(sep).join("/");
      if (rel in ALLOWED_FILES) continue;
      for (const h of scan(readFileSync(f, "utf8"))) found.push(`${rel}:${h.line} (${h.rule}) ${h.text}`);
    }
    expect(found).toEqual([]);
  });
});
