// What the loaders return for a new client's workspace (issue #243), for the mocked page tests. The database-backed twin is
// packages/mcp/test/fresh-workspace.ts, which builds the same workspace through `create_workspace`.

export const FRESH_SLUG = "fresh-co";
export const FRESH_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";
export const FRESH_NAME = "Fresh Co";
export const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
/** A well-formed id that belongs to no process of the workspace. */
export const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";
export const DRAFT = { id: "00000000-0000-4000-8000-0000000000d1", name: "Quote to cash" };

export type FreshVariant = "company map only" | "company map and one draft";
export const VARIANTS: FreshVariant[] = ["company map only", "company map and one draft"];

export const freshHead = { id: FRESH_WORKSPACE_ID, name: FRESH_NAME, slug: FRESH_SLUG, branding: null };

/** `loadWorkspaceOverview`: the workspace and its ordinary processes (never the company map). */
export function freshOverview(variant: FreshVariant) {
  return {
    workspace: { id: FRESH_WORKSPACE_ID, name: FRESH_NAME, slug: FRESH_SLUG },
    processes:
      variant === "company map only"
        ? []
        : [{ id: DRAFT.id, name: DRAFT.name, kind: "pipeline", live: false, draft: true, parentId: null }],
  };
}

/** `loadPublishState`: nothing published, and the oldest draft-only process if there is one. */
export function freshPublishState(variant: FreshVariant) {
  return {
    workspace: { id: FRESH_WORKSPACE_ID, name: FRESH_NAME, slug: FRESH_SLUG },
    published: false,
    firstDraft: variant === "company map only" ? null : { ...DRAFT },
  };
}

/** `loadWorkspaceSetup` for a workspace where nothing is set up: every count zero, and the company map. */
export const ZERO_SETUP = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0, companyId: COMPANY_ID };

/**
 * Counts and names no reader may see: fed to the mocks so a leak shows up in the HTML. They cannot be zero, because then a page that
 * printed them would look like a page that did not.
 */
export const DISTINCTIVE_SETUP = { roles: 4711, people: 4722, clients: 4733, clientGroups: 4744, processes: 4755, published: 0, companyId: COMPANY_ID };
export const SECRET_PEOPLE = ["Zelda Quillfeather", "Barnaby Thistlewick"];
