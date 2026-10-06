// Deletes baselines whose story no longer exists (renamed or removed), so the folder never holds stale pictures.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readShots } from "./names.mjs";

const dir = fileURLToPath(new URL(process.env.VISUAL_BASELINES === "1" ? "./__screenshots__/" : "./.local-screenshots/", import.meta.url));
if (!existsSync(dir)) {
  console.log(`No screenshots in ${dir}`);
  process.exit(0);
}
const wanted = new Set(readShots().map((s) => s.name));
const stale = readdirSync(dir).filter((f) => f.endsWith(".png") && !wanted.has(f));
for (const f of stale) rmSync(`${dir}${f}`);
console.log(stale.length ? `Deleted ${stale.length} stale screenshot(s):\n  ${stale.join("\n  ")}` : "No stale screenshots.");
