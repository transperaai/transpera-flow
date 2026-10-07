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
  "settings/access": "inherit settings/loading.tsx",
  "settings/ai": "inherit settings/loading.tsx",
  "settings/branding": "inherit settings/loading.tsx",
  "settings/calibration": "inherit settings/loading.tsx",
  "settings/levers": "inherit settings/loading.tsx",
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
      expect(src).not.toMatch(/from "@\/lib\/supabase/);
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
      expect(src).not.toMatch(/from "@\/lib\/(data|supabase)/);
      expect(src).not.toMatch(/\bawait\b|\basync\b/);
    });
  }
});
