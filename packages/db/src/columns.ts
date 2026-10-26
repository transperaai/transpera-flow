// The `*_COLUMNS` constants are comma-separated strings (what supabase-js `.select()` took). Kysely takes a list, and
// types the rows from it, so `columns()` splits one at the type level too: `db.selectFrom("t").select(columns(T_COLUMNS))`.

export type SplitColumns<S extends string> = S extends `${infer A}, ${infer B}` ? [A, ...SplitColumns<B>] : [S];

/** "a, b, c" → ["a", "b", "c"], typed as that tuple. */
export function columns<const S extends string>(list: S): SplitColumns<S> {
  return list.split(",").map((c) => c.trim()) as SplitColumns<S>;
}
