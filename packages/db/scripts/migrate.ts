// Applies the schema to DATABASE_URL: compat.sql and legacy-shims.sql, then each migration not yet in
// public.schema_migrations, each in its own transaction.
//   pnpm --filter @transpera-flow/db migrate [--dry-run] [--seed] [--driver pg|neon-ws]
// --dry-run lists the pending migrations and changes nothing. --seed also loads seed.sql after a run that applied
// migrations (local dev and tests only). --driver neon-ws connects through @neondatabase/serverless over a WebSocket, for a
// machine that can't reach Neon on port 5432 (scripts/copy-from-supabase/connect.ts).
import { parseArgs } from "node:util";
import { applyCompat, applyMigrations } from "../src/migrations.ts";
import { DRIVERS, connectTarget, type Driver } from "./copy-from-supabase/connect.ts";

let values: { "dry-run"?: boolean; seed?: boolean; driver?: string };
try {
  ({ values } = parseArgs({ options: { "dry-run": { type: "boolean" }, seed: { type: "boolean" }, driver: { type: "string" } }, strict: true }));
} catch {
  values = { driver: "?" };
}
const driver = (values.driver ?? "pg") as Driver;
if (!DRIVERS.includes(driver) || (values["dry-run"] && values.seed)) {
  console.error("Usage: migrate.ts [--dry-run | --seed] [--driver pg|neon-ws]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const { client, close } = await connectTarget(url, driver);
try {
  const dryRun = values["dry-run"] === true;
  if (!dryRun) await applyCompat(client);
  const { files, seeded } = await applyMigrations(client, { dryRun, seed: values.seed === true });
  const verb = dryRun ? "Pending" : "Applied";
  for (const f of files) console.log(`${verb} ${f}`);
  console.log(files.length === 0 ? "Nothing to apply" : `${verb} ${files.length} migration(s)${seeded ? " and the seed" : ""}`);
} finally {
  await close();
}
