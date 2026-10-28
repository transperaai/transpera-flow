// What went wrong saving a scenario, in plain words (docs/plans/sandbox-p1-brief.md §5). A "use server" file may only export async
// functions, so the error mapping the actions use lives here, where the tests can reach it.

/** The message for a failed scenario write, from the database's error (`code` and `message`). */
export function sandboxFailure(error: { code?: string | null; message?: string | null } | null | undefined): string {
  const message = error?.message ?? "";
  if (error?.code === "23505") return "A scenario with that name already exists.";
  if (error?.code === "23514") {
    if (/at most 900 scenarios/.test(message)) return "This workspace already has 900 scenarios. Delete one first.";
    if (/at most 5 deep/.test(message)) return "Scenarios can build on each other up to 5 deep.";
    if (/build on itself/.test(message)) return "A scenario can't build on itself.";
    if (/different months|sandbox_scenarios_changes/.test(message)) return "That scenario has changes the database doesn't allow: up to 200 changes, from up to 6 different months, with up to 4 solutions.";
    return "Some of those changes aren't allowed.";
  }
  if (error?.code === "23503") return "The scenario this one builds on isn't there any more.";
  if (error?.code === "42501") return "You don't have permission to change scenarios here.";
  return "Couldn't save the scenario. Try again.";
}

export const SANDBOX_SIGNED_OUT = "Your session has ended. Sign in again.";
export const SANDBOX_CHANGED_ELSEWHERE = "Someone else changed or deleted this scenario. Reload to see it.";
