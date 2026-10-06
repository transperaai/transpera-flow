// What went wrong saving a plan, in plain words (B7, issue #36). A "use server" file may only export async functions,
// so the error mapping the actions use lives here, where the tests can reach it.

/** The message for a failed plan write, from the database's error (`code` and `message`). */
export function planFailure(error: { code?: string | null; message?: string | null } | null | undefined): string {
  const message = error?.message ?? "";
  if (error?.code === "23505") return "A plan with that name already exists.";
  if (/at most 50 plans/.test(message)) return "This workspace already has 50 plans. Delete one first.";
  if (/at most 4 solutions/.test(message)) return "A plan can have up to 4 solutions.";
  if (/needs a (role|person|solution)/.test(message)) return "Something in this plan isn't there any more. Reload and try again.";
  if (error?.code === "42501") return "You don't have permission to change plans here.";
  return "Couldn't save the plan. Try again.";
}

export const PLAN_SIGNED_OUT = "Your session has ended. Sign in again.";
export const PLAN_CHANGED_ELSEWHERE = "Someone else changed or deleted this plan. Reload to see it.";
