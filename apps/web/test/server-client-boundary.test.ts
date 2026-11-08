import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A server file (no "use client") must never *call* a function exported from a "use client" module: Next.js refuses on the
// server, and the whole page fails (People & roles threw on every load because its server page called `peopleMeta()` from
// `components/setup/people-roles.tsx`). Components imported from a client module are fine (they're rendered, not called);
// this looks for lower-case imports used as calls.

const SRC = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const isClient = (path: string) => /^\s*["']use client["']/m.test(readFileSync(path, "utf8").slice(0, 400));

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts", ""]) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

describe("server files never call functions from client modules", () => {
  it("finds no such call", () => {
    const found: string[] = [];
    for (const file of files(SRC).filter((f) => !isClient(f))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
        if (m[1]) continue;
        const target = resolve(m[3]!, file);
        if (!target || !isClient(target)) continue;
        const names = m[2]!
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith("type "))
          .map((n) => n.split(/\s+as\s+/).pop()!.trim());
        for (const name of names) {
          if (!/^[a-z]/.test(name)) continue;
          if (new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(src)) found.push(`${relative(SRC, file)} calls ${name}() from ${m[3]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
