// Small helpers the server actions share after the move from supabase-js to Kysely (docs/plans/supabase-exit-brief.md, step 3).

/** The SQLSTATE of a thrown `pg` error, as PostgREST's `error.code` carried it; undefined for anything else. */
export function pgCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A thrown `pg` error in the shape PostgREST's `error` had: `code` (SQLSTATE), `message`, and `details` (pg's DETAIL plus the constraint name). */
export function pgError(e: unknown): { code?: string; message?: string; details?: string } {
  const o = (e ?? {}) as { code?: unknown; message?: unknown; detail?: unknown; constraint?: unknown };
  const details = [o.detail, o.constraint].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
  return {
    code: typeof o.code === "string" ? o.code : undefined,
    message: typeof o.message === "string" ? o.message : undefined,
    ...(details ? { details } : {}),
  };
}

/**
 * A value for a jsonb column, as JSON text. `pg` turns a JS array into a Postgres array literal, which jsonb rejects; text is
 * cast to jsonb by the server, so arrays, objects and scalars all take one path. Not for `rpc()` arguments: it encodes those.
 */
export function jsonb<T>(value: T): string {
  return JSON.stringify(value);
}
