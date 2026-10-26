import { qualified, quoteIdent, tableName, type Queryable } from "./shared.ts";

// Foreign keys of the target, for import.ts (the order tables load in when foreign-key checks can't be switched off) and verify.ts
// (the check that every reference resolves).

export interface ForeignKey {
  name: string;
  /** `schema.table` of the referencing table. */
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
  /** Whether each of `childColumns` may be null. */
  nullable: boolean[];
  /** `f` for MATCH FULL, `s` for MATCH SIMPLE (Postgres default). */
  match: string;
}

const SCHEMAS = ["public", "auth", "better_auth"];

export async function listForeignKeys(db: Queryable): Promise<ForeignKey[]> {
  const { rows } = await db.query(
    `select con.conname as name, cn.nspname as child_schema, cc.relname as child, pn.nspname as parent_schema, pc.relname as parent,
            (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as child_columns,
            (select array_agg(not a.attnotnull order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as nullable,
            (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_columns,
            con.confmatchtype::text as match
       from pg_constraint con
       join pg_class cc on cc.oid = con.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
       join pg_class pc on pc.oid = con.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
      where con.contype = 'f' and cn.nspname = any ($1)
      order by cn.nspname, cc.relname, con.conname`,
    [SCHEMAS],
  );
  return rows.map((r) => ({
    name: r.name as string,
    child: tableName(r.child_schema as string, r.child as string),
    parent: tableName(r.parent_schema as string, r.parent as string),
    childColumns: r.child_columns as string[],
    parentColumns: r.parent_columns as string[],
    nullable: r.nullable as boolean[],
    match: r.match as string,
  }));
}

export interface LoadPlan {
  /** Tables, parents before children. */
  order: string[];
  /** Foreign keys whose columns load as null and are filled by an update once every table is in: every self-reference, and one key per cycle. */
  deferred: ForeignKey[];
}

/**
 * The order to insert `tables` in when foreign keys are enforced (the replica role is not allowed). A parent outside `tables` is
 * ignored. A table that references itself, and a cycle between tables, can't be ordered, so one key of each is deferred: its
 * nullable columns load as null and an update sets them afterwards. Throws when a cycle has no key with a nullable column.
 */
export function planLoad(tables: string[], foreignKeys: ForeignKey[]): LoadPlan {
  const inSet = new Set(tables);
  const deferred: ForeignKey[] = [];
  let edges = foreignKeys.filter((fk) => inSet.has(fk.child) && inSet.has(fk.parent));
  for (const fk of edges.filter((e) => e.child === e.parent)) {
    if (!fk.nullable.some(Boolean)) throw new Error(`${fk.child}.${fk.name} references its own table with no nullable column`);
    deferred.push(fk);
  }
  edges = edges.filter((e) => e.child !== e.parent);

  const order: string[] = [];
  const remaining = new Set([...tables].sort());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => !edges.some((e) => e.child === t && remaining.has(e.parent)));
    if (ready.length > 0) {
      for (const t of ready) {
        order.push(t);
        remaining.delete(t);
      }
      continue;
    }
    // Everything left waits on something left: break one cycle at a key that sits on it (its parent leads back to its child).
    const onCycle = edges.filter(
      (e) => remaining.has(e.child) && remaining.has(e.parent) && reaches(edges, remaining, e.parent, e.child) && e.nullable.some(Boolean),
    );
    const pick = onCycle[0];
    if (!pick) throw new Error(`foreign keys form a cycle with no nullable column to break it at: ${[...remaining].join(", ")}`);
    deferred.push(pick);
    edges = edges.filter((e) => e !== pick);
  }
  return { order, deferred };
}

/** Whether `from` depends (through foreign keys) on `to`, among `within`. */
function reaches(edges: ForeignKey[], within: Set<string>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (t === to) return true;
    if (seen.has(t)) continue;
    seen.add(t);
    for (const e of edges) if (e.child === t && within.has(e.parent)) stack.push(e.parent);
  }
  return false;
}

/** SQL counting the rows of the referencing table whose reference matches nothing, as the foreign key itself would judge it. */
export function danglingSql(fk: ForeignKey): string {
  const c = (col: string) => `c.${quoteIdent(col)}`;
  const present =
    fk.match === "f"
      ? `(${fk.childColumns.map((col) => `${c(col)} is not null`).join(" or ")})`
      : fk.childColumns.map((col) => `${c(col)} is not null`).join(" and ");
  const join = fk.childColumns.map((col, i) => `p.${quoteIdent(fk.parentColumns[i]!)} = ${c(col)}`).join(" and ");
  return `select count(*)::int as n from ${qualified(fk.child)} c where ${present} and not exists (select 1 from ${qualified(fk.parent)} p where ${join})`;
}
