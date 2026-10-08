import { chromium } from "playwright-core";

// Counts which React components ran per interaction (dev build: names kept), via a stand-in DevTools hook.
const BASE = process.env.BASE ?? "http://127.0.0.1:3478";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    const w = window;
    w.__renders = {};
    w.__commits = 0;
    const nameOf = (f) => {
      const t = f.type;
      if (!t || typeof t === "string") return null;
      return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null;
    };
    let seen = new WeakSet();
    let next = new WeakSet();
    const walk = (f) => {
      while (f) {
        next.add(f);
        if (!seen.has(f) && (f.flags & 1) && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15)) {
          const n = nameOf(f);
          if (n) w.__renders[n] = (w.__renders[n] || 0) + 1;
        }
        if (f.child) walk(f.child);
        f = f.sibling;
      }
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1; },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id, root) {
        w.__commits++;
        // The top-most components that ran in this commit: where the update started.
        const tops = [];
        const find = (f, path) => {
          while (f) {
            const n = nameOf(f);
            if (!seen.has(f) && (f.flags & 1) && n && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15)) { tops.push(path.slice(-3).concat(n).join(">")); }
            else if (f.child) find(f.child, n ? path.concat(n) : path);
            f = f.sibling;
          }
        };
        find(root.current.child, []);
        w.__tops = w.__tops || {};
        for (const t of tops) w.__tops[t] = (w.__tops[t] || 0) + 1;
        next = new WeakSet();
        walk(root.current.child);
        seen = next;
      },
      onPostCommitFiberRoot() {},
      onCommitFiberUnmount() {},
    };
  });
  await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 180_000 });
  await p.waitForSelector(".react-flow__node", { timeout: 180_000 });
  await p.waitForTimeout(4000);
  return { p, ctx };
}

const reset = (p) => p.evaluate(() => { window.__renders = {}; window.__commits = 0; window.__tops = {}; });
async function report(p, label) {
  const r = await p.evaluate(() => ({ commits: window.__commits, renders: window.__renders, tops: window.__tops }));
  const top = Object.entries(r.renders).filter(([n]) => /Canvas|Node|Edge|BranchEdge|StepNode|GroupNode|Terminal|PlaybackBar|PlaybackLayer|Overview|ProcessCanvas|ReactFlow|EdgeRenderer|NodeRenderer|NodeWrapper|EdgeWrapper|LaneLayer|ZoomControls|MapLegend|FirstRun|Chart|Trend|Health|Findings|Viewport|Background|Pane|EdgeLabel|Minimap|Wrapper|Flow|Store|Selection|Handle/.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 22);
  console.log(`  tops: ${JSON.stringify(r.tops)}`);
  console.log(`${label}: commits=${r.commits} ${top.map(([n, c]) => `${n}=${c}`).join(" ")}`);
}
async function measure(p, label, action, wait = 1000) {
  await reset(p);
  await action();
  await p.waitForTimeout(wait);
  await report(p, label);
}

const { p, ctx } = await open("/demo/overview");
await measure(p, "overview idle", async () => {}, 1000);
await measure(p, "overview zoom-in", () => p.locator("[data-company-map] button[aria-label*='Zoom in' i]").first().click());
await measure(p, "overview Fit", () => p.locator("[data-company-map] button", { hasText: "Fit" }).first().click());
const pane = await p.evaluate(() => { const r = document.querySelector("[data-company-map] .react-flow__pane").getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height - 10 }; });
await measure(p, "overview pan 30 moves", async () => {
  await p.mouse.move(pane.x, pane.y); await p.mouse.down();
  for (let k = 1; k <= 30; k++) await p.mouse.move(pane.x + k * 5, pane.y - k);
  await p.mouse.up();
});
const play = p.locator("[data-company-map] button[aria-label*='Play' i]").first();
if (await play.count()) await measure(p, "overview playback 2s", () => play.click(), 2000);
const pause = p.locator("[data-company-map] button[aria-label*='Pause' i]").first();
if (await pause.count()) await pause.click();
const horizon = p.locator("[data-company-map] [data-map-controls] button, [data-company-map] [data-map-controls] [role=radio]").nth(1);
if (await horizon.count()) await measure(p, "overview horizon change", () => horizon.click(), 6000);
await ctx.close();

const e = await open("/demo/edit");
const box = await e.p.evaluate(() => { const r = document.querySelectorAll(".react-flow__node")[2].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 12 }; });
await reset(e.p);
await e.p.mouse.move(box.x, box.y); await e.p.mouse.down();
for (let k = 1; k <= 30; k++) await e.p.mouse.move(box.x + k * 4, box.y + k * 2);
await report(e.p, "editor during drag (30 moves)");
await reset(e.p);
await e.p.mouse.up();
await e.p.waitForTimeout(3000);
await report(e.p, "editor drop + re-run");
await e.ctx.close();
await browser.close();
