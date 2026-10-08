import { chromium } from "playwright-core";

// Frame times for the map interactions, production build, CPU throttled 4x (a mid laptop on battery).
const BASE = process.env.BASE ?? "http://127.0.0.1:3477";
const THROTTLE = Number(process.env.THROTTLE ?? 4);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const out = {};

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await p.addInitScript(() => {
    const w = window;
    w.__frames = [];
    let last = performance.now();
    const loop = (t) => { w.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await p.goto(BASE + path, { waitUntil: "networkidle" });
  await p.waitForSelector(".react-flow__node");
  await p.waitForTimeout(3000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  return { p, ctx };
}
const reset = (p) => p.evaluate(() => { window.__frames = []; });
async function stats(p, label) {
  const f = await p.evaluate(() => window.__frames.slice(1));
  const s = [...f].sort((a, b) => a - b);
  const q = (x) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(x * s.length))]) : 0);
  (out[label] ??= []).push({ n: f.length, p50: q(0.5), p95: q(0.95), max: Math.round(s.at(-1) ?? 0), janky: f.filter((x) => x > 25).length });
}
async function measure(p, label, action, wait = 700) {
  await reset(p);
  await action();
  await p.waitForTimeout(wait);
  await stats(p, label);
}

for (let run = 0; run < 3; run++) {
  {
    const { p, ctx } = await open("/demo/overview");
    const map = p.locator("[data-company-map]");
    await measure(p, "overview: Zoom in", () => map.locator("button[aria-label*='Zoom in' i]").first().click());
    await measure(p, "overview: Fit", () => map.locator("button", { hasText: "Fit" }).first().click());
    await ctx.close();
  }
  {
    const { p, ctx } = await open("/demo/p/c0000000-0000-4000-8000-000000000001");
    const map = p.locator("[data-process-map]").first();
    await measure(p, "process: Zoom in", () => map.locator("button[aria-label*='Zoom in' i]").first().click());
    await measure(p, "process: Fit", () => map.locator("button", { hasText: "Fit" }).first().click());
    await ctx.close();
  }
  {
    const { p, ctx } = await open("/demo/edit");
    const b = await p.evaluate(() => { const r = document.querySelectorAll(".react-flow__node")[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 12 }; });
    await p.mouse.move(b.x, b.y);
    await p.mouse.down();
    await reset(p);
    for (let k = 1; k <= 40; k++) { await p.mouse.move(b.x + k * 3, b.y + k * 2); await p.waitForTimeout(16); }
    await stats(p, "editor: drag a step (40 moves)");
    await reset(p);
    await p.mouse.up();
    await p.waitForTimeout(2500);
    await stats(p, "editor: drop (save + re-run)");
    const map = p.locator("[data-process-map]").first();
    await measure(p, "editor: Fit", () => map.locator("button", { hasText: "Fit" }).first().click());
    await ctx.close();
  }
}
for (const [label, runs] of Object.entries(out)) {
  const med = (k) => [...runs.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  console.log(`${label.padEnd(34)} frames=${med("n")} p50=${med("p50")}ms p95=${med("p95")}ms max=${med("max")}ms janky>25ms=${med("janky")}`);
}
await browser.close();
