// A limit on fetching pages by link (issue #166, B13 follow-up). The server fetches whatever link a signed-in editor pastes, so
// each person gets 10 a minute. The count lives in Postgres (`take_link_fetch`, which can only touch the caller's own
// counter), not in the server's memory, so it holds on serverless hosts where each request may run on a different instance.

import type { ToolContext } from "./context";

export const LINK_FETCHES_PER_MINUTE = 10;

export type LinkFetchTurn = { allowed: true } | { allowed: false; message: string };

/** Count one link fetch for the signed-in user, or say how long to wait. Call it before fetching. */
export async function takeLinkFetch(ctx: Pick<ToolContext, "db">): Promise<LinkFetchTurn> {
  const { data, error } = await ctx.db.rpc("take_link_fetch");
  if (error) {
    // Before the migration is applied the function doesn't exist: the preview still works, without the limit. Logged, so a
    // deploy that got ahead of its migration is visible rather than silently unlimited.
    if (error.code === "PGRST202" || error.code === "42883") {
      console.warn("[link-limit] take_link_fetch is missing (migration 20261128000000 not applied?): link fetches are NOT rate limited.");
      return { allowed: true };
    }
    return { allowed: false, message: "Couldn't open that link right now. Try again in a moment." };
  }
  const wait = typeof data === "number" ? data : 0;
  if (wait <= 0) return { allowed: true };
  return { allowed: false, message: `You've opened ${LINK_FETCHES_PER_MINUTE} links in the last minute. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.` };
}
