// One deployment is one client, so it holds one workspace (docs/adr/0024-one-workspace-per-deployment.md). The first is made
// from the home page; a second only where ALLOW_MULTIPLE_WORKSPACES=true (a demo or QA deployment). Server only: the flag is
// not a NEXT_PUBLIC_ variable.

/** True when this deployment may hold more than one workspace. */
export function allowMultipleWorkspaces(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALLOW_MULTIPLE_WORKSPACES?.trim().toLowerCase() === "true";
}

/** Whether another workspace may be made, given how many already exist. */
export function mayCreateWorkspace(existing: number, env: Record<string, string | undefined> = process.env): boolean {
  return existing === 0 || allowMultipleWorkspaces(env);
}

export const ONE_WORKSPACE_MESSAGE = "This deployment already has its workspace. Each client gets their own deployment.";
