/** The SQLSTATE of an error thrown by `pg` (PostgREST's `error.code`), or undefined for anything else. */
export function pgCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
