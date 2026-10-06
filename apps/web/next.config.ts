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
  // The PDF worker loads unpdf's CommonJS build by path, which tracing can't see: ship it (and the PDF.js it imports) too.
  outputFileTracingIncludes: {
    "/**/*": ["../../node_modules/.pnpm/unpdf@*/node_modules/unpdf/{package.json,dist/index.cjs,dist/pdfjs.mjs}"],
  },
  // Trace from the monorepo root: the pnpm store (node_modules/.pnpm) lives there.
  outputFileTracingRoot: monorepoRoot,
  // A share link's page (B3): the token is in the address, so nothing may leak it (no Referer to other sites), nothing may keep a copy
  // (no caching), and search engines stay away.
  headers: async () => [
    {
      source: "/s/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "private, no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    },
  ],
  // The Block library's address before it was built (a bookmark of the placeholder still works).
  redirects: async () => [
    { source: "/w/:slug/library", destination: "/w/:slug/blocks", permanent: false },
    { source: "/demo/library", destination: "/demo/blocks", permanent: false },
  ],
};

export default nextConfig;
