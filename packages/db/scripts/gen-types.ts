// Regenerates src/db-types.ts: builds a throwaway database from the migrations, then runs kysely-codegen on it.
// The numeric and date options match the parsers in src/client.ts (numeric and int8 are numbers; dates are strings).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyCompat, applyMigrations } from "../src/migrations.ts";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const name = `transpera_flow_types_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`create database ${name}`);
try {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await applyCompat(client);
  await applyMigrations(client);
  await client.end();
  execFileSync(
    new URL("../node_modules/.bin/kysely-codegen", import.meta.url).pathname,
    [
      ...["--dialect", "postgres", "--url", url.toString(), "--include-pattern", "public.*"],
      ...["--numeric-parser", "number", "--date-parser", "string", "--type-mapping", JSON.stringify({ int8: "number", timestamptz: "string", timestamp: "string" })],
      ...["--out-file", new URL("../src/db-types.ts", import.meta.url).pathname],
    ],
    { stdio: "inherit" },
  );
} finally {
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
}
console.log("Wrote src/db-types.ts");
