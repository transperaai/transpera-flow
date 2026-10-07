"use server";

import { isAgencyAdmin } from "@/lib/access-data";

/** Throws on purpose, so the server's error reporting can be seen working (issue #44). Agency admins only. */
export async function throwServerTestError(): Promise<void> {
  if (!(await isAgencyAdmin())) throw new Error("Not allowed");
  throw new Error("Sentry check from the server");
}
