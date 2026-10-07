import { expect, type Page } from "@playwright/test";

/** Open a route and wait until nothing is still loading or computing (the skeletons and the map's first-run chip are gone). */
export async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => {
      const shown = (el: Element) => (el as HTMLElement).checkVisibility?.() ?? true;
      return ![...document.querySelectorAll("[data-first-run], [role=status][data-loading]")].some(shown);
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Collect page errors and console errors; call `.list()` at the end of the test. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // The browser asks for /favicon.ico by itself; a missing one is not the page's error.
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) errors.push(`${m.text()} (${m.location().url})`);
  });
  return { list: () => errors };
}

/** 1. The page itself never scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `the page is ${scrollWidth}px wide in a ${clientWidth}px screen`).toBeLessThanOrEqual(clientWidth);
}

/**
 * 2. Nothing visible runs past the right edge, unless it is fixed, screen-reader-only, inside the map, or clipped by an ancestor
 * that scrolls or clips and itself ends inside the screen (a wide table in its frame).
 */
export async function expectNothingEscapes(page: Page) {
  const escaping = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const h = el as HTMLElement;
      if (!h.checkVisibility?.({ visibilityProperty: true })) continue;
      const r = h.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= width + 1) continue;
      if (h.closest(".react-flow, .sr-only")) continue;
      let fixed = false;
      let clipped = false;
      for (let a: HTMLElement | null = h; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.position === "fixed") fixed = true;
        if (a !== h && cs.overflowX !== "visible" && a.getBoundingClientRect().right <= width + 1) clipped = true;
      }
      if (fixed || clipped) continue;
      out.push(`${h.tagName.toLowerCase()}${h.className && typeof h.className === "string" ? "." + h.className.trim().split(/\s+/).slice(0, 3).join(".") : ""} right=${Math.round(r.right)} "${(h.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out.slice(0, 15);
  });
  expect(escaping, `elements past the ${"right"} edge`).toEqual([]);
}

/** Controls whose name says they change something. Put `data-allow-on-phone` (with a comment) on one this catches wrongly. */
export const EDIT_NAME =
  /^(\+ |✎)|open in editor|new (issue|process|solution|block|plan|workspace)|upload|acknowledge|resolve|analyse|accept|dismiss|reject|build|link a source|delete|archive|rename|publish|restore|discard|save/i;

/** The visible, enabled controls on the page that look like they change something (see `EDIT_NAME`). */
export async function editControls(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src.source, src.flags);
    const out: string[] = [];
    for (const el of document.querySelectorAll("button, a, [role=menuitem]")) {
      const h = el as HTMLElement;
      if (!h.checkVisibility({ visibilityProperty: true }) || h.matches(":disabled") || h.getAttribute("aria-disabled") === "true") continue;
      if (h.closest("[data-allow-on-phone]")) continue;
      const name = (h.getAttribute("aria-label") || h.innerText || h.getAttribute("title") || "").trim().replace(/\s+/g, " ");
      if (re.test(name)) out.push(`${h.tagName.toLowerCase()} "${name.slice(0, 50)}"`);
    }
    return out;
  }, { source: EDIT_NAME.source, flags: EDIT_NAME.flags });
}

/** 3. On a phone: no visible edit entry, no enabled field in a read-only form, and no control named like an edit. */
export async function expectReadOnly(page: Page) {
  const visibleEntries = await page.evaluate(() =>
    [...document.querySelectorAll("[data-edit-entry]")]
      .filter((e) => (e as HTMLElement).checkVisibility({ visibilityProperty: true }))
      .map((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 40)}"`),
  );
  expect(visibleEntries, "edit entries visible on a phone").toEqual([]);
  const enabled = await page.evaluate(() =>
    [...document.querySelectorAll("[data-phone-read-only] :is(input, select, textarea)")]
      // `:disabled` also matches a field disabled by its fieldset, which the `disabled` property doesn't.
      .filter((e) => !e.matches(":disabled") && (e as HTMLInputElement).type !== "hidden")
      .map((e) => `${e.tagName.toLowerCase()}[name=${e.getAttribute("name")}]`),
  );
  expect(enabled, "fields still enabled in a read-only form").toEqual([]);
  expect(await editControls(page), "controls named like an edit, visible and enabled on a phone").toEqual([]);
}

type Rgba = [number, number, number, number];

/** The colours on the page that break dark mode: a light surface, and dark text on a dark surface. Inside `[data-allow-light]` is fine. */
export async function darkProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const cache = new Map<string, Rgba>();
    // Any CSS colour Chromium accepts (rgb, oklch, color(srgb ...)) read back as sRGB through a 1 x 1 canvas.
    const parse = (c: string): Rgba => {
      const hit = cache.get(c);
      if (hit) return hit;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      const v: Rgba = [r!, g!, b!, a! / 255];
      cache.set(c, v);
      return v;
    };
    const lum = ([r, g, b]: Rgba) => {
      const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const label = (h: HTMLElement) => `${h.tagName.toLowerCase()}${typeof h.className === "string" && h.className ? "." + h.className.trim().split(/\s+/).slice(0, 3).join(".") : ""} "${(h.textContent ?? "").trim().slice(0, 30)}"`;
    const out: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const h = el as HTMLElement;
      if (h.closest("[data-allow-light]") || !h.checkVisibility?.({ visibilityProperty: true })) continue;
      const r = h.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(h);
      const bg = parse(cs.backgroundColor);
      // A hairline (an error bar, a threshold rule) is drawn in the text colour on purpose, so it is a mark and not a surface.
      const hairline = Math.min(r.width, r.height) < 4;
      if (bg[3] > 0.5 && lum(bg) > 0.6 && !hairline) out.push(`light surface: ${label(h)}`);
      const ownText = [...h.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!ownText) continue;
      const fg = parse(cs.color);
      if (lum(fg) >= 0.1) continue;
      let under: Rgba | null = null;
      for (let a: HTMLElement | null = h; a; a = a.parentElement) {
        const c = parse(getComputedStyle(a).backgroundColor);
        if (c[3] > 0.5) {
          under = c;
          break;
        }
      }
      // No opaque surface above it: the canvas, which is dark in dark mode.
      if (!under || lum(under) < 0.1) out.push(`dark on dark: ${label(h)}`);
    }
    return [...new Set(out)].slice(0, 30);
  });
}
