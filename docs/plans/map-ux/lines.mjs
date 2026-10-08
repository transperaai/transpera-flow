import { chromium } from "playwright-core";

// Readability metrics of the lines on each demo map today: shared runs, shared attachment points, labels on labels or on lines.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const path of ["/demo/p/c0000000-0000-4000-8000-000000000001", "/demo/larkspur", "/demo/overview", "/demo/issues/1"]) {
  await p.goto("http://127.0.0.1:3477" + path, { waitUntil: "networkidle" });
  await p.waitForSelector(".react-flow__node");
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const out = { sharedRuns: [], sharedEnds: [], labelOnLabel: [], labelOnLine: [], crossings: 0 };
    for (const flow of document.querySelectorAll(".react-flow")) {
      const vp = flow.querySelector(".react-flow__viewport");
      const scale = Number(/scale\(([\d.]+)\)/.exec(vp.style.transform)?.[1] ?? 1);
      const o = vp.getBoundingClientRect();
      const toMap = (x, y) => ({ x: (x - o.left) / scale, y: (y - o.top) / scale });
      const edges = [...flow.querySelectorAll(".react-flow__edge")].map((g) => {
        const path = g.querySelector(".react-flow__edge-path");
        const ctm = path.getScreenCTM();
        const len = path.getTotalLength();
        const pts = [];
        for (let at = 0; at <= len; at += 1) { const q = path.getPointAtLength(at).matrixTransform(ctm); pts.push(toMap(q.x, q.y)); }
        return { name: (g.getAttribute("aria-label") ?? "").replace(/^(Connection|Handoff) from /, "").replace(/,.*$/, ""), pts };
      });
      // Shared runs: points of one line within 2 units of another line, counted in units of length.
      for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
        const a = edges[i], b = edges[j];
        let shared = 0;
        for (const pa of a.pts) if (b.pts.some((pb) => Math.abs(pa.x - pb.x) < 2 && Math.abs(pa.y - pb.y) < 2)) shared++;
        if (shared > 8) out.sharedRuns.push(`${a.name} | ${b.name}: ${shared}`);
        const ends = (e) => [e.pts[0], e.pts.at(-1)];
        for (const ea of ends(a)) for (const eb of ends(b)) if (Math.hypot(ea.x - eb.x, ea.y - eb.y) < 4) out.sharedEnds.push(`${a.name} | ${b.name}`);
      }
      const labels = [...flow.querySelectorAll(".react-flow__edgelabel-renderer > div")].map((l) => {
        const r = l.getBoundingClientRect(); const a = toMap(r.left, r.top); const b = toMap(r.right, r.bottom);
        return { text: l.textContent, a, b };
      });
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const A = labels[i], B = labels[j];
        if (Math.min(A.b.x, B.b.x) - Math.max(A.a.x, B.a.x) > 0.5 && Math.min(A.b.y, B.b.y) - Math.max(A.a.y, B.a.y) > 0.5) out.labelOnLabel.push(`${A.text} | ${B.text}`);
      }
      for (const L of labels) {
        const hits = edges.filter((e) => e.pts.some((q) => q.x > L.a.x + 1 && q.x < L.b.x - 1 && q.y > L.a.y + 1 && q.y < L.b.y - 1));
        if (hits.length > 1) out.labelOnLine.push(`${L.text}: ${hits.length} lines`);
      }
    }
    return out;
  });
  console.log(path, JSON.stringify(r));
}
await browser.close();
