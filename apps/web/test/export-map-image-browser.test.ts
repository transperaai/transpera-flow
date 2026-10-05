import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The map image in a real browser (issue #39, B10): the SVG is well-formed and loads as an image, the PNG is a real PNG at
// twice the SVG's size, and the page's own colours (light and dark) are what get drawn.

let browser: Browser;
let script: string;

beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `import { northbeamBundle } from "@transpera-flow/db";
        import { buildMapImage, readPalette, svgToPng } from "@/lib/export/map-image";
        window.exp = { northbeamBundle, buildMapImage, readPalette, svgToPng };`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

const page = async (dark = false) => {
  const p = await browser.newPage();
  await p.setContent(`<style>:root{--panel:oklch(1 0 0);--panel-2:oklch(.97 0 0);--line:#eee;--line-2:#ddd;--fg:#111;--fg-2:#555;--fg-3:#777;--crit:#e34948;--background:#fff;--rate-great:green;--rate-great-soft:#dfd;--rate-good:#cc0;--rate-good-soft:#ffd;--rate-bad:orange;--rate-bad-soft:#fed;--rate-risk:red;--rate-risk-soft:#fdd}
    ${dark ? ":root{--background:#111;--panel:#222;--fg:#fafafa}" : ""}</style>`);
  await p.addScriptTag({ content: script });
  return p;
};

describe("map image in the browser", () => {
  it("makes a well-formed SVG that loads as an image, and a 2x PNG of it", async () => {
    const p = await page();
    const r = await p.evaluate(async () => {
      const w = window as unknown as { exp: { northbeamBundle: () => { steps: unknown[]; edges: unknown[] }; buildMapImage: (i: unknown) => { svg: string; width: number; height: number }; readPalette: () => unknown; svgToPng: (i: unknown, s: number) => Promise<Blob> } };
      const b = w.exp.northbeamBundle();
      const image = w.exp.buildMapImage({ title: "Sales <&> \"x\"", steps: b.steps, edges: b.edges, expanded: "all", date: "2026-10-05", palette: w.exp.readPalette() });
      const doc = new DOMParser().parseFromString(image.svg, "image/svg+xml");
      const parseError = doc.querySelector("parsererror")?.textContent ?? null;
      const png = await w.exp.svgToPng(image, 2);
      const bytes = new Uint8Array(await png.arrayBuffer());
      const bmp = await createImageBitmap(png);
      return { parseError, type: png.type, sig: [...bytes.slice(0, 8)], width: bmp.width, height: bmp.height, w: image.width, h: image.height, legend: doc.querySelectorAll("[data-legend]").length };
    });
    expect(r.parseError).toBeNull();
    expect(r.type).toBe("image/png");
    expect(r.sig).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(r.width).toBe(r.w * 2);
    expect(r.height).toBe(r.h * 2);
    expect(r.legend).toBe(6);
    await p.close();
  });

  it("draws in the colours the page has now: light and dark differ", async () => {
    const light = await (await page(false)).evaluate(() => (window as unknown as { exp: { readPalette: () => { background: string } } }).exp.readPalette().background);
    const dark = await (await page(true)).evaluate(() => (window as unknown as { exp: { readPalette: () => { background: string } } }).exp.readPalette().background);
    expect(light).not.toBe(dark);
    expect(dark).toMatch(/rgb\(17, 17, 17\)|#111/);
  });
});
