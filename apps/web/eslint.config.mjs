import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { noServiceRoleKey } from "../../packages/mcp/eslint.config.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Decision D12: the MCP endpoint and the Supabase clients act as the user; never the service-role key.
  { files: ["src/app/api/mcp/**", "src/lib/supabase/**"], rules: noServiceRoleKey },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "storybook-static/**", "visual/.local-screenshots/**", "playwright-report/**", "test-results/**"]),
]);
