// Pure helpers for the "Who can sign in" list on the Access page. The database is the authority (formats, free-mail domains,
// duplicates, who may edit); these tidy input and turn its errors into sentences.

import { normalizeDomain, normalizeEmail } from "./access";

export const DEPLOYMENT_ROLES = ["owner", "agency_admin", "viewer"] as const;
export type DeploymentRuleRole = (typeof DEPLOYMENT_ROLES)[number];
export type DeploymentRuleKind = "domain" | "email";

export interface DeploymentRule {
  id: string;
  kind: DeploymentRuleKind;
  value: string;
  role: DeploymentRuleRole;
}

/** What each role is called on screen. The stored word `owner` is the Owner here and `owner` on a membership is an Agency admin. */
export const DEPLOYMENT_ROLE_LABEL: Record<DeploymentRuleRole, string> = {
  owner: "Owner",
  agency_admin: "Agency admin",
  viewer: "Viewer",
};

/** A membership's role as shown: `owner` there is an Agency admin (the Owner needs no membership). */
export const MEMBERSHIP_ROLE_LABEL: Record<"owner" | "viewer", string> = { owner: "Agency admin", viewer: "Viewer" };

export const DEPLOYMENT_ROLE_HELP: Record<DeploymentRuleRole, string> = {
  owner: "Everything, in every workspace, including who can sign in as an Owner.",
  agency_admin: "Edits everything, sees individual pay, and manages who can sign in (not Owners).",
  viewer: "Reads everything except individual pay, and can't edit.",
};

/** The roles a person may give: an Agency admin can't make an Owner (the database refuses too). */
export function assignableRoles(isOwner: boolean): readonly DeploymentRuleRole[] {
  return isOwner ? DEPLOYMENT_ROLES : DEPLOYMENT_ROLES.filter((r) => r !== "owner");
}

export function isDeploymentRole(value: unknown): value is DeploymentRuleRole {
  return typeof value === "string" && (DEPLOYMENT_ROLES as readonly string[]).includes(value);
}

/** What goes in the table: a domain without scheme, path or www, or a lower-cased email. */
export function normalizeRuleValue(kind: DeploymentRuleKind, input: string): string {
  return kind === "domain" ? normalizeDomain(input) : normalizeEmail(input);
}

export function deploymentErrorMessage(error: { code?: string; message?: string }): string {
  const m = error.message ?? "";
  if (m.includes("deployment_access_kind_value_key")) return "That is already on the list.";
  if (m.includes("deployment_access_value_format")) {
    return "Enter a company domain like acme.com (free email providers like gmail.com can't be allowed) or a full email address.";
  }
  if (error.code === "42501" || m.includes("row-level security")) {
    return "You can add and change Agency admins and Viewers. Only an Owner can add, change or remove an Owner.";
  }
  return "Something went wrong saving that change. Please try again.";
}
