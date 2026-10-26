// Applies the schema to DATABASE_URL: compat.sql and legacy-shims.sql, then each migration not yet in
// public.schema_migrations, each in its own transaction.
//   pnpm --filter @transpera-flow/db migrate [--dry-run] [--seed]
// --dry-run lists the pending migrations and changes nothing. --seed also loads seed.sql after a run that applied
// migrations (local dev and tests only).
import pg from "pg";
import { applyCompat, applyMigrations } from "../src/migrations.ts";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--dry-run" && a !== "--seed");
if (unknown.length > 0 || (args.has("--dry-run") && args.has("--seed"))) {
  console.error("Usage: migrate.ts [--dry-run | --seed]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const dryRun = args.has("--dry-run");
  if (!dryRun) await applyCompat(client);
  const { files, seeded } = await applyMigrations(client, { dryRun, seed: args.has("--seed") });
  const verb = dryRun ? "Pending" : "Applied";
  for (const f of files) console.log(`${verb} ${f}`);
  console.log(files.length === 0 ? "Nothing to apply" : `${verb} ${files.length} migration(s)${seeded ? " and the seed" : ""}`);
} finally {
  await client.end();
}
