// Bundles a browser-test harness (a page that mounts real components) with esbuild. Shared by the sources library and Editor
// tour browser tests. Server Actions ("use server" modules) can't run on a bare page, so each is replaced by a module with
// the same exports that answer with an error; `next/navigation` and `next/link` are replaced by small stand-ins. Everything
// else is the real source.

import { build, type Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const STUBS = fileURLToPath(new URL("./build-harness-stubs", import.meta.url));

/** `"use server"` files, and the stand-ins for Next's client modules. */
const stubs: Plugin = {
  name: "harness-stubs",
  setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: `${STUBS}/navigation.ts` }));
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: `${STUBS}/link.tsx` }));
    b.onLoad({ filter: /\.tsx?$/ }, (args) => {
      if (!args.path.startsWith(SRC)) return undefined;
      const text = readFileSync(args.path, "utf8");
      if (!/^\s*["']use server["']/.test(text)) return undefined;
      const names = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]!);
      const body = names.map((n) => `export const ${n} = async () => ({ status: "error", message: "Not available in this test." });`).join("\n");
      return { contents: body, loader: "js" };
    });
  },
};

/** The bundled script of a harness entry, ready to add to a page. */
export async function bundleHarness(entry: URL): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": SRC },
    plugins: [stubs],
    logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}
