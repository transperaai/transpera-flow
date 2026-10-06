// The one place that decides which screenshots exist and what they are called. The spec and prune.mjs both read it, so a
// baseline can never be named differently from the test that compares it.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Relative to the working directory (apps/web): every command runs from there. No `import.meta`, so Playwright can load this as CommonJS.
export const INDEX = resolve("storybook-static/index.json");
export const THEMES = ["light", "dark"];

/** Every story that is screenshotted (not tagged `visual-skip`), sorted by id. */
export function readStories() {
  if (!existsSync(INDEX)) throw new Error("storybook-static/index.json is missing. Run `pnpm build-storybook` first.");
  const index = JSON.parse(readFileSync(INDEX, "utf8"));
  return Object.values(index.entries)
    .filter((e) => e.type === "story" && !(e.tags ?? []).includes("visual-skip"))
    .map((e) => ({ id: e.id, tags: e.tags ?? [] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The node and edge types the process canvas registers (the keys of `nodeTypes` and `edgeTypes` in process-canvas.tsx). */
export function canvasTypes() {
  const source = readFileSync(resolve("src/components/process-canvas.tsx"), "utf8");
  const keys = (name) => {
    const m = source.match(new RegExp(`const ${name}\\s*=\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`Could not find \`const ${name} = { ... }\` in process-canvas.tsx; update canvasTypes() in visual/names.mjs.`);
    return m[1].split(",").map((p) => p.split(":")[0].trim()).filter(Boolean);
  };
  return { nodes: keys("nodeTypes"), edges: keys("edgeTypes") };
}

/** The file name of one shot. */
export const shotName = (id, theme, phone) => `${id}--${theme}${phone ? "--400" : ""}.png`;

/** Every shot there should be: story x theme, plus a 400 px one for stories tagged `visual-phone`. */
export function readShots() {
  return readStories().flatMap((s) =>
    THEMES.flatMap((theme) => [
      { ...s, theme, phone: false, name: shotName(s.id, theme, false) },
      ...(s.tags.includes("visual-phone") ? [{ ...s, theme, phone: true, name: shotName(s.id, theme, true) }] : []),
    ]),
  );
}
