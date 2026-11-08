"use client";

import { NumberField, SelectField, TextField } from "@/components/fields";
import { SettingsSection } from "./section";
import type { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import type { saveOverheadMonthly } from "./actions";

// Settings, Workspace (issue #182, B19): the workspace's name, the currency every amount is shown in and the overheads a month
// (sandbox phase 2: the fixed costs the forecast takes off revenue with pay to show profit). Owners change them;
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
  overheadMonthly = null,
  canManage,
  saveName,
  saveCurrency,
  saveOverhead,
}: {
  workspaceId: string;
  name: string;
  currency: string;
  /** Fixed costs a month in `currency`; null when none are set. Shown to everyone: it is a company figure, not pay. */
  overheadMonthly?: number | null;
  /** Owners and agency admins. */
  canManage: boolean;
  saveName: typeof saveWorkspaceName;
  saveCurrency: typeof saveWorkspaceCurrency;
  saveOverhead: typeof saveOverheadMonthly;
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
          hint={canManage ? undefined : "Only Agency admins can change this."}
          help={{ description: "The company's name, as everyone in this workspace sees it.", example: "Northbeam Digital." }}
        />
        <SelectField
          label="Currency"
          value={currency}
          save={(base, next) => saveCurrency(workspaceId, base, next)}
          options={options}
          disabled={!canManage}
          hint={canManage ? "Changes how amounts are shown. Amounts already entered are not converted." : "Only Agency admins can change this."}
          help={{ description: "The money every fee, cost and MRR is shown in. Changing it relabels amounts; it doesn't convert them.", example: "AUD shows a fee of 3,600 as A$3,600." }}
        />
        <NumberField
          label="Overheads a month"
          value={overheadMonthly}
          save={(base, next) => saveOverhead(workspaceId, base, next)}
          optional
          min={0}
          max={100_000_000}
          step={100}
          unit={`${currency} a month`}
          placeholder="None"
          disabled={!canManage}
          hint={canManage ? "Leave blank for none." : "Only Agency admins can change this."}
          help={{
            description: "Fixed costs a month that don't depend on the work: rent, software, insurance. The forecast takes them off revenue with pay to show profit.",
            example: "18,000 a month is 216,000 over a 12-month forecast.",
          }}
        />
      </div>
    </SettingsSection>
  );
}
