import { readFileSync } from "node:fs";

/**
 * The SQL of a migration's ROLLBACK block, as written in its header: the lines that start `--   ` (three spaces), without the
 * prefix and without the comment lines among them. Parsing it from the file means a test runs what the operator would run.
 */
export function headerRollback(file: string): string {
  const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
  const start = sql.indexOf("-- ROLLBACK (");
  if (start < 0) throw new Error(`${file} has no ROLLBACK block`);
  const lines = sql.slice(start).split("\n").slice(1);
  const out: string[] = [];
  let begun = false;
  for (const line of lines) {
    if (!line.startsWith("--")) break;
    if (!line.startsWith("--   ")) {
      if (begun) break;
      continue;
    }
    const text = line.slice(5);
    if (text.startsWith("--")) continue;
    begun = true;
    out.push(text);
  }
  return out.join("\n");
}
