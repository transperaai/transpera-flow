import "server-only";
import { listCompanyRevisions as listCompanyRevisionsOf, loadCompanyPartRevision as loadCompanyPartRevisionOf, loadCompanyPartVersion, loadLiveCompanyPart, loadLiveParts as loadLivePartsOf, type ProcessPart } from "@transpera-flow/db";
import { getDb } from "@/lib/auth/session";

/**
 * The workspace's company map at its live revision, which the Overview draws its map from (B11): where each process
 * sits and the handoff lines. Null when there is none (the Overview then lays the map out as it always did). As the
 * signed-in user (RLS decides what is visible).
 */
/** The company map's revisions for the Sandbox's "Company map" select (Q16): the open draft, the live version and the earlier published ones. */
export async function listCompanyRevisions(workspaceId: string) {
  return listCompanyRevisionsOf(await getDb(), workspaceId);
}

/** The company map at one of its revisions by id (the Sandbox's `?company=`). As the signed-in user. */
export async function loadCompanyRevision(workspaceId: string, revisionId: string): Promise<ProcessPart | null> {
  return loadCompanyPartRevisionOf(await getDb(), workspaceId, revisionId);
}

export async function loadLiveCompany(workspaceId: string): Promise<ProcessPart | null> {
  return loadLiveCompanyPart(await getDb(), workspaceId);
}

/**
 * The company map at published version `number`, for the Overview's `?version=N` (read only). Null when `number` is not a
 * published version of this workspace's map; the live number gives the live map. As the signed-in user (RLS decides).
 */
export async function loadCompanyVersion(workspaceId: string, number: number): Promise<ProcessPart | null> {
  return loadCompanyPartVersion(await getDb(), workspaceId, number);
}

/**
 * Every process of the workspace at its live revision, for the Overview's company map (issue #100). As the signed-in user (RLS
 * decides what is visible); the body lives in `packages/db` so a share link's snapshot builds it the same way (B3).
 */
export async function loadLiveParts(workspaceId: string): Promise<ProcessPart[]> {
  return loadLivePartsOf(await getDb(), workspaceId);
}
