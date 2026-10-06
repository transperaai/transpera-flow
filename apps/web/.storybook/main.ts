import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { serverStubs } from "./server-stubs";

const stub = (f: string) => fileURLToPath(new URL(`../test/build-harness-stubs/${f}`, import.meta.url));

const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../stories/**/*.stories.tsx"],
  addons: [],
  core: { disableTelemetry: true },
  typescript: { reactDocgen: false }, // faster builds; we don't use autodocs
  viteFinal: (c) =>
    mergeConfig(c, {
      plugins: [serverStubs()],
      resolve: {
        alias: [
          { find: /^@\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) },
          { find: /^next\/link$/, replacement: stub("link.tsx") },
          { find: /^next\/navigation$/, replacement: stub("navigation.ts") },
          { find: /^next\/dynamic$/, replacement: stub("dynamic.tsx") },
        ],
      },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    }),
};
export default config;
