"use server";

import { dismissTour } from "@transpera-flow/db";
import { createClient } from "@/lib/supabase/server";

// The Editor's written tour (issue #176, B18): once someone dismisses it, it never opens by itself for them again, on any
// device. Stored per user in `user_tours` (RLS: a person reads and writes only their own rows).

/** Remember that the signed-in person dismissed a tour (`process` or `company`). Fails quietly: the browser also remembers it. */
export async function dismissEditorTour(tour: unknown): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  if (tour !== "process" && tour !== "company") return { status: "error", message: "That isn't a tour." };
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) return { status: "error", message: "Your session has ended. Sign in again." };
  try {
    await dismissTour(supabase, tour);
    return { status: "ok" };
  } catch {
    return { status: "error", message: "Couldn't save that. The tour may open again next time." };
  }
}
