"use client";

import { SelectField, TextField } from "@/components/fields";
import { SettingsSection } from "./section";
import type { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";

// Settings, Workspace (issue #182, B19): the workspace's name and the currency every amount is shown in. Owners change them;
// everyone else sees them. The writes come in as props (the server actions, or a stand-in in the browser tests).

/** Currencies offered, by code. A workspace set to another code (from before) keeps it as an option. */
export const CURRENCIES: { value: string; label: string }[] = [
  { value: "AUD", label: "AUD, Australian dollar" },
  { value: "NZD", label: "NZD, New Zealand dollar" },
  { value: "GBP", label: "GBP, British pound" },
  { value: "EUR", label: "EUR, Euro" },
  { value: "USD", label: "USD, US dollar" },
  { value: "CAD", label: "CAD, Canadian dollar" },
  { value: "SGD", label: "SGD, Singapore dollar" },
  { value: "ZAR", label: "ZAR, South African rand" },
  { value: "INR", label: "INR, Indian rupee" },
];

export function WorkspaceDetails({
  workspaceId,
  name,
  currency,
  canManage,
  saveName,
  saveCurrency,
}: {
  workspaceId: string;
  name: string;
  currency: string;
  /** Owners and agency admins. */
  canManage: boolean;
  saveName: typeof saveWorkspaceName;
  saveCurrency: typeof saveWorkspaceCurrency;
}) {
  const options = CURRENCIES.some((c) => c.value === currency) ? CURRENCIES : [{ value: currency, label: currency }, ...CURRENCIES];
  return (
    <SettingsSection id="workspace" title="Workspace">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          value={name}
          save={(base, next) => saveName(workspaceId, base, next)}
          disabled={!canManage}
          hint={canManage ? undefined : "Only workspace owners can change this."}
          help={{ description: "The company's name, as everyone in this workspace sees it.", example: "Northbeam Digital." }}
        />
        <SelectField
          label="Currency"
          value={currency}
          save={(base, next) => saveCurrency(workspaceId, base, next)}
          options={options}
          disabled={!canManage}
          hint={canManage ? "Changes how amounts are shown. Amounts already entered are not converted." : "Only workspace owners can change this."}
          help={{ description: "The money every fee, cost and MRR is shown in. Changing it relabels amounts; it doesn't convert them.", example: "AUD shows a fee of 3,600 as A$3,600." }}
        />
      </div>
    </SettingsSection>
  );
}
