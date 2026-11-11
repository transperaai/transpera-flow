import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Loading states (issue #44): every page in a workspace shows something while its server loaders run. A folder under
// `src/app/w/[slug]` with a `page.tsx` needs a `loading.tsx` of its own, and a loading state loads nothing.

const WEB = fileURLToPath(new URL("../", import.meta.url));
const ROOT = join(WEB, "src/app/w/[slug]");

/** Folders that show their parent's `loading.tsx` (the nearest one wins), and why. */
const INHERITS: Record<string, string> = {
  people: "only redirects to capacity; inherit w/[slug]/loading.tsx",
};

/** Every folder under `dir` (and `dir` itself) that has a `page.tsx`, as a path under the workspace root ("" is the root). */
function pageFolders(dir: string): string[] {
  const here = existsSync(join(dir, "page.tsx")) ? [relative(ROOT, dir)] : [];
  const below = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => pageFolders(join(dir, e.name)));
  return [...here, ...below];
}

const folders = pageFolders(ROOT);
const withLoading = folders.filter((f) => existsSync(join(ROOT, f, "loading.tsx")));
/** Loading states outside the workspace shell, checked the same way. */
const OUTSIDE = [join(WEB, "src/app/settings/tokens/loading.tsx")];

describe("every workspace page has a loading state", () => {
  it("finds the pages", () => {
    expect(folders).toContain("");
    expect(folders).toContain("p/[processId]/edit");
    expect(folders.length).toBeGreaterThan(15);
  });

  for (const folder of folders) {
    const name = folder === "" ? "w/[slug]" : folder;
    const reason = INHERITS[folder];
    if (reason) {
      it(`${name}: ${reason}`, () => {
        const parent = folder.split("/").slice(0, -1).join("/");
        expect(existsSync(join(ROOT, parent, "loading.tsx")), `${parent}/loading.tsx is missing`).toBe(true);
        expect(existsSync(join(ROOT, folder, "loading.tsx")), `${name} has its own loading.tsx: take it out of INHERITS`).toBe(false);
      });
      continue;
    }
    it(`${name} has a loading.tsx`, () => {
      expect(existsSync(join(ROOT, folder, "loading.tsx")), `${name} has a page.tsx but no loading.tsx`).toBe(true);
    });
  }
});

describe("a loading state loads nothing", () => {
  const files = [
    ...withLoading.map((folder) => ({ name: `${folder === "" ? "w/[slug]" : folder}/loading.tsx`, path: join(ROOT, folder, "loading.tsx") })),
    ...OUTSIDE.map((path) => ({ name: relative(join(WEB, "src/app"), path), path })),
  ];
  for (const { name, path } of files) {
    const src = readFileSync(path, "utf8");
    it(`${name} draws a skeleton`, () => {
      expect(src).toMatch(/from "@\/components\/(shell\/skeletons|sources\/sources-library)"/);
      expect(src).toMatch(/export default function \w+\(/);
    });
    it(`${name} imports no data and no server actions`, () => {
      expect(src).not.toMatch(/from "@\/lib\/data"/);
      expect(src).not.toMatch(/from "@\/lib\/(supabase|auth\/session|db\/)/);
      expect(src).not.toMatch(/from "@transpera-flow\/db\/client"/);
      expect(src).not.toContain('"use server"');
      expect(src).not.toMatch(/\bawait\b|\basync\b/);
    });
  }
});

describe("the skeletons load nothing either", () => {
  // They render on the server inside `loading.tsx`: no client code of their own, no data, no server actions.
  for (const file of ["src/components/shell/skeletons.tsx", "src/components/map/map-placeholder.tsx"]) {
    const src = readFileSync(join(WEB, file), "utf8");
    it(`${file} is a server module that imports no data`, () => {
      expect(src).not.toMatch(/^["']use client["']/m);
      expect(src).not.toContain('"use server"');
      expect(src).not.toMatch(/from "@\/lib\/(data|supabase|auth\/session|db\/)/);
      expect(src).not.toMatch(/from "@transpera-flow\/db\/client"/);
      expect(src).not.toMatch(/\bawait\b|\basync\b/);
    });
  }
});

describe("the Settings skeleton is the one scrolling page", () => {
  // Settings has no sub-pages: settings/loading.tsx draws the sub-nav column, then a few section bands (a heading over a rule) with a card each.
  const src = readFileSync(join(WEB, "src/components/shell/skeletons.tsx"), "utf8");
  const fn = src.slice(src.indexOf("export function SettingsSkeleton"), src.indexOf("export function", src.indexOf("export function SettingsSkeleton") + 1));
  it("has the sub-nav and the bands", () => {
    expect(fn).toContain("lg:grid-cols-[14rem_minmax(0,1fr)]");
    expect(fn).toContain("data-skeleton-band");
    expect(fn).toMatch(/border-t\]?:?.*pt-8|pt-8.*border-t/);
  });
  it("is the loading state of settings/ and nothing below it has its own page", () => {
    expect(readFileSync(join(ROOT, "settings/loading.tsx"), "utf8")).toContain("<SettingsSkeleton />");
    expect(folders.filter((f) => f.startsWith("settings/"))).toEqual([]);
  });
});

describe("the Sandbox skeleton is the one scrolling page", () => {
  // The Sandbox is one page that scrolls: the toolbar, the company map's big block, the levers band with its five columns, then the verdict line, the
  // strip of its figures and the charts' grid. No viewport-height frame and no panes of its own.
  const src = readFileSync(join(WEB, "src/components/sandbox/sandbox-skeleton.tsx"), "utf8");
  it("has the map, the levers band and the results, in that order, with no workbench frame", () => {
    expect(src).not.toMatch(/h-svh|overflow-hidden flex-1|lg:overflow|lg:grid-cols-\[20rem/);
    expect(src).toContain("pageBodyClass()");
    expect(src).toContain("h-[82svh] min-h-[34rem]");
    expect(src).toMatch(/Array\.from\(\{ length: 5 \}/);
    const at = (s: string) => src.indexOf(s);
    expect(at("data-skeleton-map")).toBeGreaterThan(-1);
    expect(at("data-skeleton-map")).toBeLessThan(at("data-skeleton-levers"));
    expect(at("data-skeleton-levers")).toBeLessThan(at("h-[4.5rem]"));
    expect(at("h-[4.5rem]")).toBeLessThan(at("minmax(min(20rem,100%),1fr)"));
  });
  it("is the loading state of sandbox/", () => {
    expect(readFileSync(join(ROOT, "sandbox/loading.tsx"), "utf8")).toContain("<SandboxSkeleton />");
  });
});
