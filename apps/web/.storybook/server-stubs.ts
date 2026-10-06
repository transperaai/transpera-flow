// Vite plugin for Storybook: Server Actions ("use server" modules) can't run on a bare page, so each is replaced by a
// module with the same exports that answer with an error (same logic as `stubs` in test/build-harness.ts), and
// `server-only` resolves to an empty module.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EMPTY = "\0server-only-empty";

export function serverStubs(): Plugin {
  return {
    name: "storybook-server-stubs",
    enforce: "pre",
    resolveId(id) {
      return id === "server-only" ? EMPTY : undefined;
    },
    load(id) {
      if (id === EMPTY) return "export {};";
      const path = id.split("?")[0]!;
      if (!/\.tsx?$/.test(path) || !path.startsWith(SRC)) return undefined;
      const text = readFileSync(path, "utf8");
      if (!/^\s*["']use server["']/.test(text)) return undefined;
      const names = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]!);
      return names.map((n) => `export const ${n} = async () => ({ status: "error", message: "Not available in Storybook." });`).join("\n");
    },
  };
}
