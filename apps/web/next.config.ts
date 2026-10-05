import path from "node:path";
import type { NextConfig } from "next";

// Next loads this file as CommonJS (so `__dirname` is the project directory);
// under Node's native TypeScript loader it is ESM, and the build runs from here.
const projectDir = typeof __dirname === "string" ? __dirname : process.cwd();
const monorepoRoot = path.join(projectDir, "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@transpera-flow/engine", "@transpera-flow/db", "@transpera-flow/mcp"],
  // Read by a worker thread from node_modules at run time (lib/sources/extract.ts): kept out of the bundle, and traced.
  serverExternalPackages: ["unpdf"],
  // Trace from the monorepo root: the pnpm store (node_modules/.pnpm) lives there.
  outputFileTracingRoot: monorepoRoot,
  // The Block library's address before it was built (a bookmark of the placeholder still works).
  redirects: async () => [
    { source: "/w/:slug/library", destination: "/w/:slug/blocks", permanent: false },
    { source: "/demo/library", destination: "/demo/blocks", permanent: false },
  ],
};

export default nextConfig;
