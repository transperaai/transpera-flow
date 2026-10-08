import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RATINGS } from "@transpera-flow/engine";
import { contrastRatio, normaliseHex, oklchToHex, type Hex } from "@/lib/branding/contrast";
import { formatHours, formatNumber } from "@/lib/format";
import { RATING_STYLE } from "@/lib/map/rating";
import { tileColours, tileHeadline } from "@/lib/map/tile";

// The rating tile (issue #242): its one headline number, its colours, and the contrast of its text.

describe("tile headline", () => {
  const run = { avgWait: 25, avgQueue: 1.5 };

  it("shows the queue wait of a staffed step in this run", () => {
    const h = tileHeadline({ staffed: true, run, waitHours: 4 });
    expect(h.value).toBe(formatHours(25));
    expect(h.value).toBe("25 h");
    expect(h.caption).toBe(`waiting · queue ${formatNumber(1.5)}`);
    expect(h.title).toContain("waits in the queue before work starts");
    expect(h.phrase).toBe(`waits 25 h in the queue on average, average queue ${formatNumber(1.5)}`);
  });

  it("shows 0 hours as a value when the run says so", () => {
    const h = tileHeadline({ staffed: true, run: { avgWait: 0, avgQueue: 0 }, waitHours: 0 });
    expect(h.value).toBe("0 h");
    expect(h.caption).toBe("waiting · queue 0");
  });

  it("shows a dash while a staffed step has no run (none yet, computing, or the step is not in the result)", () => {
    const h = tileHeadline({ staffed: true, run: null, waitHours: 8 });
    expect(h).toEqual({ value: "—", caption: "waiting", title: "Not simulated yet", phrase: null });
  });

  it("shows the planned wait of a step nobody works", () => {
    const h = tileHeadline({ staffed: false, run, waitHours: 48 });
    expect(h).toEqual({ value: "48 h", caption: "wait", title: "Planned wait at this step", phrase: null });
  });

  it("shows a dash for an unstaffed step with no wait entered", () => {
    expect(tileHeadline({ staffed: false, run: null, waitHours: 0 })).toEqual({ value: "—", caption: "wait", title: "No wait entered", phrase: null });
  });
});

describe("tile colours", () => {
  it("fills and edges a rated tile in its rating's tint and colour", () => {
    for (const r of RATINGS) {
      expect(tileColours(r, false)).toEqual({
        background: RATING_STYLE[r].soft,
        borderColor: RATING_STYLE[r].stripe,
        dot: RATING_STYLE[r].stripe,
        divider: `color-mix(in oklab, ${RATING_STYLE[r].stripe} 35%, transparent)`,
      });
    }
  });

  it("leaves an unrated tile on the panel with a neutral edge", () => {
    expect(tileColours(null, false)).toEqual({
      background: "var(--panel)",
      borderColor: "var(--line-2)",
      dot: "var(--line-2)",
      divider: "color-mix(in oklab, var(--line-2) 35%, transparent)",
    });
  });

  it("edges a bottleneck in the critical colour, whatever its rating", () => {
    expect(tileColours(null, true).borderColor).toBe("var(--crit)");
    expect(tileColours("great", true).borderColor).toBe("var(--crit)");
    expect(tileColours("great", true).background).toBe(RATING_STYLE.great.soft);
    expect(tileColours("great", true).dot).toBe(RATING_STYLE.great.stripe);
  });
});

describe("tile contrast (AA, 4.5:1)", () => {
  const css = readFileSync(join(__dirname, "../src/styles/tokens.css"), "utf8");
  /** The declarations of the first rule whose selector line contains `selector`. */
  const block = (selector: string): Map<string, string> => {
    const at = css.indexOf(selector);
    if (at < 0) throw new Error(`no ${selector} in tokens.css`);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    const out = new Map<string, string>();
    for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.replace(/\/\*.*?\*\//g, "").trim());
    return out;
  };
  const light = block(":root {");
  const dark = block(':root[data-theme="dark"]');

  const hex = (theme: Map<string, string>, name: string, depth = 0): Hex => {
    const raw = theme.get(name) ?? light.get(name);
    if (raw === undefined) throw new Error(`no ${name}`);
    const ref = raw.match(/^var\((--[\w-]+)\)$/);
    if (ref) {
      if (depth > 0) throw new Error(`${name} nests var() more than one level`);
      return hex(theme, ref[1]!, depth + 1);
    }
    const o = raw.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
    if (o) return oklchToHex(Number(o[1]), Number(o[2]), Number(o[3]));
    const h = normaliseHex(raw);
    if (!h) throw new Error(`cannot read ${name}: ${raw}`);
    return h;
  };

  for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
    it(`pill text on --destructive, ${theme}`, () => {
      expect(contrastRatio(hex(tokens, "--destructive"), hex(tokens, "--crit-fg"))).toBeGreaterThanOrEqual(4.5);
    });
    for (const r of RATINGS) {
      it(`--fg-2 on --rate-${r}-soft, ${theme}`, () => {
        expect(contrastRatio(hex(tokens, "--fg-2"), hex(tokens, `--rate-${r}-soft`))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
