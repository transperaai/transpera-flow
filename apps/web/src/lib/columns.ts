import type { DB } from "@transpera-flow/db";

/**
 * A `*_COLUMNS` constant of `@transpera-flow/db` as the list a Kysely `select` takes, whether the package exports it as a
 * comma-separated string or as an array.
 */
export function columnList<T extends keyof DB>(columns: string | readonly string[]): (keyof DB[T] & string)[] {
  const list = typeof columns === "string" ? columns.split(",").map((c) => c.trim()) : [...columns];
  return list as (keyof DB[T] & string)[];
}
