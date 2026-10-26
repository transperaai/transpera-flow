import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every end-to-end suite builds its own throwaway database (every migration and the seed) first.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
