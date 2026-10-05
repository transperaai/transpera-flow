import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"],
    tags: [
      {
        name: "perf",
        // The root `pnpm test` runs these last, after every package's other tests, one package and one file at a time
        // (issue #181). Run beside other test files and packages they share the CPU, so they measured the machine's load,
        // not the engine. A package's own `pnpm test` leaves them out; `pnpm test:perf` runs them.
        description: "Timing tests against the PRD §6.7 targets, run on their own (pnpm test:perf).",
      },
    ],
  },
});
