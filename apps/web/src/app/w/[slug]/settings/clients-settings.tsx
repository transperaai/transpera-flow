"use client";

import { useActionState, useState } from "react";
import { A_TEAM_MEMBER, type ClientAssignmentRow, type ClientRow, type ClientServiceRow } from "@transpera-flow/db";
import { ChecklistField, DateField, NumberField, SelectField, TextField, ToggleField, type FieldHelp } from "@/components/fields";
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { clientsRuleSentence, MAX_MRR, type ClientField, type ClientSources } from "@/lib/clients";
import { formatWholeCurrency } from "@/lib/format";
import { SettingsSection } from "./section";
import type { AddClientResult, saveClientAssignment, saveClientField, saveClientServices } from "./client-actions";

// Settings, Clients (issue #182, B19; PRD D42): clients one by one, with their MRR, start date, services and who looks after
// them in each role. A client who leaves is made inactive: hidden here and left out of simulations, never deleted. The
// writes come in as `ops` (the server actions, or a stand-in in the browser tests), so this file never imports server code.

type Scalar = string | number | boolean | null;

export interface ClientOps {
  add: (workspaceId: string, prev: AddClientResult, form: FormData) => Promise<AddClientResult>;
  saveField: typeof saveClientField;
  saveServices: typeof saveClientServices;
  saveAssignment: typeof saveClientAssignment;
}

export interface ClientsSettingsProps {
  workspaceId: string;
  currency: string;
  clients: ClientRow[];
  clientServices: ClientServiceRow[];
  clientAssignments: ClientAssignmentRow[];
  services: { id: string; name: string; active: boolean }[];
  roles: { id: string; name: string; active: boolean }[];
  people: { id: string; name: string; active: boolean }[];
  personRoles: { person_id: string; role_id: string }[];
  /** Owners and editors. */
  canEdit: boolean;
  /** Which processes simulate client groups and which these clients (PRD D42). */
  sources: ClientSources;
  ops: ClientOps;
}

const HELP: Record<"name" | "status" | "mrr" | "start" | "services" | "role", FieldHelp> = {
  name: { description: "The client's name, as you call them.", example: "Harbour Lane Dental." },
  status: {
    description: "A client who has left is made inactive. They are hidden from this list and left out of simulations, but their record is kept. Clients are never deleted.",
    example: "Harbour Lane Dental left in March: mark them inactive.",
  },
  mrr: { description: "What the client pays you each month, in total.", example: "3,600 a month for SEO." },
  start: { description: "When they became a client. A client who starts after a run's start date is left out of that run.", example: "1 March 2025." },
  services: { description: "What the client buys from you. Their work and churn come from these services.", example: "SEO and PPC." },
  role: {
    description: "The person who looks after this client in this role. Leave it as shared and the role's people share the work.",
    example: "Account director: Maya Collins.",
  },
};

export function ClientsSettings(props: ClientsSettingsProps) {
  const { clients, canEdit, sources } = props;
  const [showInactive, setShowInactive] = useState(false);
  const active = clients.filter((c) => c.active);
  const inactive = clients.filter((c) => !c.active);
  return (
    <SettingsSection
      id="clients"
      title="Clients"
      description={
        <>
          {active.length} active{inactive.length ? `, ${inactive.length} inactive` : ""}. {clientsRuleSentence(sources)}
        </>
      }
    >
      {canEdit ? <AddClient {...props} /> : <p className="text-fg-2">You can view clients here; owners and editors can change them.</p>}
      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2" data-empty="clients">
          No active clients yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line" data-clients="active">
          {active.map((c) => (
            <li key={c.id}>
              <ClientRowView client={c} {...props} />
            </li>
          ))}
        </ul>
      )}
      {inactive.length > 0 && (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="link" size="sm" className="self-start px-0" aria-expanded={showInactive} onClick={() => setShowInactive((s) => !s)}>
            {showInactive ? "Hide inactive clients" : `Show ${inactive.length} inactive ${inactive.length === 1 ? "client" : "clients"}`}
          </Button>
          {showInactive && (
            <ul className="flex flex-col divide-y divide-line border-y border-line" data-clients="inactive">
              {inactive.map((c) => (
                <li key={c.id}>
                  <ClientRowView client={c} {...props} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function AddClient({ workspaceId, currency, ops }: ClientsSettingsProps) {
  const [state, action, pending] = useActionState<AddClientResult, FormData>((prev, form) => ops.add(workspaceId, prev, form), {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-add-client>
      <label className="flex flex-col gap-1">
        <HelpLabel label="Name" {...HELP.name} />
        <Input name="name" required maxLength={200} />
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel label={`MRR (${currency})`} {...HELP.mrr} />
        <Input name="mrr" type="number" min={0} max={MAX_MRR} step="any" inputMode="decimal" className="w-32" />
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel label="Start date" {...HELP.start} />
        <Input name="start_date" type="date" />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add client"}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-crit">
          {state.error}
        </p>
      )}
    </form>
  );
}

function ClientRowView({ client: c, ...props }: ClientsSettingsProps & { client: ClientRow }) {
  const { workspaceId, currency, canEdit, ops } = props;
  const disabled = !canEdit;
  const serviceIds = props.clientServices.filter((s) => s.client_id === c.id).map((s) => s.service_id);
  const serviceNames = props.services.filter((s) => serviceIds.includes(s.id)).map((s) => s.name);
  const field =
    <T extends Scalar>(f: ClientField): Saver<T> =>
    (base, next) =>
      ops.saveField(c.id, f, base, next) as Promise<SaveOutcome<T>>;
  const roles = props.roles.filter((r) => r.active || props.clientAssignments.some((a) => a.client_id === c.id && a.role_id === r.id));
  return (
    <details className="group py-2" data-client={c.name}>
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-1 py-1 hover:bg-panel-2">
        <span aria-hidden className="text-fg-3 transition-transform group-open:rotate-90">
          ›
        </span>
        <span className={`font-semibold ${c.active ? "" : "text-fg-3"}`}>{c.name}</span>
        <span className="text-fg-2">{serviceNames.join(", ") || "No services"}</span>
        <span className="text-fg-3 tabular-nums">
          {formatWholeCurrency(Number(c.mrr), currency)} a month{c.start_date ? ` · since ${c.start_date}` : ""}
        </span>
        {!c.active && <span className="rounded-lg bg-panel-2 px-1.5 text-xs text-fg-2">Inactive</span>}
      </summary>
      <div className="grid gap-4 px-1 pt-3 pb-2 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Name" value={c.name} save={field("name")} disabled={disabled} help={HELP.name} />
        <ToggleField label="Status" value={c.active} save={field("active")} onLabel="Active" offLabel="Inactive: hidden and left out of simulations" disabled={disabled} help={HELP.status} />
        <NumberField label="MRR" value={Number(c.mrr)} save={field("mrr")} unit={`${currency} a month`} min={0} max={MAX_MRR} step={50} disabled={disabled} help={HELP.mrr} />
        <DateField label="Start date" value={c.start_date} save={field("start_date")} disabled={disabled} help={HELP.start} />
        <div className="sm:col-span-2 lg:col-span-3">
          <ChecklistField
            label="Services"
            value={serviceIds}
            save={(base, next) => ops.saveServices(c.id, workspaceId, [...base], [...next])}
            options={props.services.filter((s) => s.active || serviceIds.includes(s.id)).map((s) => ({ id: s.id, label: s.name }))}
            emptyLabel="no services"
            disabled={disabled}
            help={HELP.services}
          />
        </div>
        {roles.length > 0 && (
          <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-3">
            <legend className="mb-2 text-xs font-medium text-fg-2">Looked after by</legend>
            {roles.map((r) => {
              const assigned = props.clientAssignments.find((a) => a.client_id === c.id && a.role_id === r.id)?.person_id ?? null;
              const holders = new Set(props.personRoles.filter((pr) => pr.role_id === r.id).map((pr) => pr.person_id));
              const options = props.people.filter((p) => (p.active && holders.has(p.id)) || p.id === assigned).map((p) => ({ value: p.id, label: p.name }));
              // A member reads only their own person: someone else's assignment still shows, as "A team member" (B1 2b).
              if (assigned && !options.some((o) => o.value === assigned)) options.push({ value: assigned, label: A_TEAM_MEMBER });
              return (
                <SelectField
                  key={r.id}
                  label={r.name}
                  value={assigned}
                  save={(base, next) => ops.saveAssignment(c.id, workspaceId, r.id, base, next)}
                  options={options}
                  noneLabel="Shared by the role"
                  disabled={disabled}
                  help={HELP.role}
                />
              );
            })}
          </fieldset>
        )}
      </div>
    </details>
  );
}
