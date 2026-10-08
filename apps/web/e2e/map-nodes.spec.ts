import { expect, test, type Page } from "@playwright/test";
import { open, watchErrors } from "./checks";

// The map's rating tiles (issue #242), drawn by the real CSS: on every demo page that has a map, the tiles keep the width and
// height the layout assumes (192 px wide, closed groups at most 124 px tall), no tile lies on another, and no connection line
// or its label runs under a tile (the lines and labels are drawn below the nodes, so that part of them is hidden).
const PAGES = ["/demo/p/c0000000-0000-4000-8000-000000000001", "/demo/larkspur", "/demo/overview", "/demo/issues/1"];

/**
 * Lines and labels known to run under a tile, by page, as the start of the failure message. Larkspur's layout predates the
 * taller tiles and hasn't been moved yet (Northbeam's was, for #242); anything else hidden fails, and so does an entry here
 * that is no longer hidden, so the list only shrinks.
 */
const KNOWN_HIDDEN: Record<string, string[]> = {
  "/demo/larkspur": [
    "line Client decision → Contract & onboarding runs",
    'label "50% · social" lies',
    'label "30% · content" lies',
    'label "20% · web" lies',
  ],
};

interface Box {
  id: string;
  kind: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Waits until every node has a size and none moves between two frames (the map measures and frames itself first). */
async function settled(page: Page) {
  await page.waitForSelector(".react-flow__node");
  await page.waitForFunction(() => {
    const w = window as unknown as { __nodes?: string };
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    const now = nodes.map((e) => { const r = e.getBoundingClientRect(); return `${e.getAttribute("data-id")}:${r.left}:${r.top}:${r.width}:${r.height}`; }).join("|");
    const steady = now === w.__nodes && nodes.every((e) => e.getBoundingClientRect().width > 0);
    w.__nodes = now;
    return steady;
  }, undefined, { polling: 100, timeout: 20_000 });
}

/**
 * Every part of a connection that is hidden under a tile, on every map on the page, in map units: a line that passes through
 * a tile other than the two it joins, or a label that lies on any tile. Open groups are frames drawn around their steps, so
 * lines cross them by design and they are left out. Each line is sampled every map unit along its path; a sample counts when it
 * is more than 1 unit inside a tile (the line is 1.5 wide, so less than that is still half visible).
 */
function hiddenConnections(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const flow of document.querySelectorAll<HTMLElement>(".react-flow")) {
      const viewport = flow.querySelector<HTMLElement>(".react-flow__viewport")!;
      const scale = Number(/scale\(([\d.]+)\)/.exec(viewport.style.transform)?.[1] ?? 1);
      const origin = viewport.getBoundingClientRect();
      const toMap = (x: number, y: number) => ({ x: (x - origin.left) / scale, y: (y - origin.top) / scale });
      const tiles = [...flow.querySelectorAll<HTMLElement>(".react-flow__node")]
        .filter((el) => !el.querySelector("[data-group='open']"))
        .map((el) => {
          const r = el.getBoundingClientRect();
          const a = toMap(r.left, r.top);
          const b = toMap(r.right, r.bottom);
          return { name: el.querySelector("[data-field='name']")?.textContent ?? el.dataset.id ?? "", left: a.x, top: a.y, right: b.x, bottom: b.y };
        });
      type Tile = (typeof tiles)[number];
      type Point = { x: number; y: number };
      const away = (p: Point, t: Tile) => Math.hypot(Math.max(t.left - p.x, 0, p.x - t.right), Math.max(t.top - p.y, 0, p.y - t.bottom));
      const nearest = (p: Point) => tiles.reduce((best, t) => (away(p, t) < away(p, best) ? t : best));
      const under = (p: Point, t: Tile) => p.x > t.left + 1 && p.x < t.right - 1 && p.y > t.top + 1 && p.y < t.bottom - 1;
      if (!tiles.length) continue;
      for (const edge of flow.querySelectorAll<SVGGElement>(".react-flow__edge")) {
        const path = edge.querySelector<SVGPathElement>(".react-flow__edge-path");
        const ctm = path?.getScreenCTM();
        if (!path || !ctm) continue;
        const length = path.getTotalLength();
        const points: Point[] = [];
        for (let at = 0; at < length + 1; at++) {
          const q = path.getPointAtLength(Math.min(at, length)).matrixTransform(ctm);
          points.push(toMap(q.x, q.y));
        }
        // A line starts at its source's right handle and ends at its target's left one: the tiles nearest its two ends.
        const from = nearest(points[0]!);
        const to = nearest(points.at(-1)!);
        for (const t of tiles) {
          if (t === from || t === to) continue;
          const hidden = points.filter((p) => under(p, t)).length;
          if (hidden) found.push(`line ${from.name} → ${to.name} runs ${hidden} px under ${t.name}`);
        }
      }
      for (const label of flow.querySelectorAll<HTMLElement>(".react-flow__edgelabel-renderer > div")) {
        const r = label.getBoundingClientRect();
        const a = toMap(r.left, r.top);
        const b = toMap(r.right, r.bottom);
        for (const t of tiles) {
          const x = Math.min(b.x, t.right) - Math.max(a.x, t.left);
          const y = Math.min(b.y, t.bottom) - Math.max(a.y, t.top);
          if (x > 0.5 && y > 0.5) found.push(`label "${label.textContent}" lies ${x.toFixed(0)} x ${y.toFixed(0)} px under ${t.name}`);
        }
      }
    }
    return found;
  });
}

/** Every map on the page: its nodes in map units (screen size divided by the viewport's scale), and that scale. */
function maps(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".react-flow")].map((flow) => {
      const scale = Number(/scale\(([\d.]+)\)/.exec(flow.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "")?.[1] ?? 1);
      const nodes = [...flow.querySelectorAll<HTMLElement>(".react-flow__node")].map((el) => {
        const r = el.getBoundingClientRect();
        const kind = el.querySelector("[data-group='open']") ? "open" : el.querySelector("[data-group='closed']") ? "closed" : (el.querySelector("[data-tile]")?.getAttribute("data-tile") ?? "other");
        return { id: el.dataset.id ?? "", kind, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width / scale, height: r.height / scale };
      });
      return { scale, nodes };
    }),
  );
}

for (const [name, viewport] of [["1280", { width: 1280, height: 800 }], ["400", { width: 400, height: 900 }]] as const) {
  test.describe(`map tiles, ${name}px`, () => {
    test.use({ viewport });
    for (const path of PAGES) {
      test(path, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, path);
        await settled(page);
        const found = await maps(page);
        expect(found.length, "a map on the page").toBeGreaterThan(0);
        let tiles = 0;
        for (const { nodes } of found) {
          // (b) a step tile is 192 px wide at zoom 1.
          for (const n of nodes.filter((x) => x.kind === "step")) {
            tiles++;
            expect(Math.abs(n.width - 192), `step tile ${n.id} is ${n.width.toFixed(1)} px wide`).toBeLessThanOrEqual(1);
          }
          // (c) a closed group is at most 124 px tall at zoom 1.
          for (const n of nodes.filter((x) => x.kind === "closed")) expect(n.height, `closed group ${n.id}`).toBeLessThanOrEqual(124 + 1);
          // (a) no two tiles meet. Open groups are frames around their steps, so they are left out.
          const boxes: Box[] = nodes.filter((x) => x.kind !== "open");
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i]!;
              const b = boxes[j]!;
              const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              expect(x > 0.5 && y > 0.5, `${a.kind} ${a.id} and ${b.kind} ${b.id} overlap by ${x.toFixed(1)} x ${y.toFixed(1)} px`).toBe(false);
            }
          }
        }
        // The overview draws processes as closed groups, not step tiles; every other page has step tiles.
        if (path !== "/demo/overview") expect(tiles).toBeGreaterThan(0);
        // (d) no connection line or label is hidden under a tile, apart from the known ones listed for the page.
        const hidden = await hiddenConnections(page);
        const known = KNOWN_HIDDEN[path] ?? [];
        expect(hidden.filter((h) => !known.some((k) => h.startsWith(k))), "connections hidden under a tile").toEqual([]);
        expect(known.filter((k) => !hidden.some((h) => h.startsWith(k))), "known hidden connections that are no longer hidden: take them off KNOWN_HIDDEN").toEqual([]);
        expect(errors.list()).toEqual([]);
      });
    }
  });
}
