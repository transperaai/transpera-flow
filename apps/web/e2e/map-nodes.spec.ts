import { expect, test, type Page } from "@playwright/test";
import { open, watchErrors } from "./checks";

// The map's rating tiles (issue #242), drawn by the real CSS: on every demo page that has a map, the tiles keep the width and
// height the layout assumes (192 px wide, closed groups at most 124 px tall) and no tile lies on another.
const PAGES = ["/demo/p/c0000000-0000-4000-8000-000000000001", "/demo/larkspur", "/demo/overview", "/demo/issues/1"];

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
        expect(errors.list()).toEqual([]);
      });
    }
  });
}
