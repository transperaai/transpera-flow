import type { Database } from "@transpera-flow/db";
import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

/**
 * Supabase client for the browser, signed in through the session cookies the
 * proxy keeps fresh. Used only by the upload helpers until step 4 replaces them.
 * Null when Supabase isn't configured.
 */
export function createClient() {
  const env = supabaseEnv();
  // createBrowserClient returns one shared client per page.
  return env ? createBrowserClient<Database>(env.url, env.key) : null;
}
