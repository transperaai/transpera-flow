// Pure helpers for the "Who can sign in" list on the Access page. The database is the authority (formats, free-mail domains,
// duplicates, who may edit); these tidy input and turn its errors into sentences.

import { normalizeDomain, normalizeEmail } from "./access";

export const DEPLOYMENT_ROLES = ["admin", "editor", "viewer"] as const;
export type DeploymentRuleRole = (typeof DEPLOYMENT_ROLES)[number];
export type DeploymentRuleKind = "domain" | "email";

export interface DeploymentRule {
  id: string;
  kind: DeploymentRuleKind;
  value: string;
  role: DeploymentRuleRole;
}

export const DEPLOYMENT_ROLE_HELP: Record<DeploymentRuleRole, string> = {
  admin: "Sees and manages every workspace, and this list.",
  editor: "Added to every workspace as an editor.",
  viewer: "Added to every workspace as a viewer.",
};

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
  if (error.code === "42501" || m.includes("row-level security")) return "Only agency admins can change who can sign in.";
  return "Something went wrong saving that change. Please try again.";
}
