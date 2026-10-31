"use client";

// Set up, Tiers & clients (capacity build P1; the prototype's "Tiers & clients"): each department's tiers with their per-client numbers, the
// clients taking both services, and the named clients with their own values. Every cell saves on its own; a blank client cell uses its tier's
// value and shows it greyed. A Viewer sees the same page as text, with no inputs. Everything else the old Settings sections edited
// (pricing model, entry process, servicing links, path tags, counted-client numbers, start dates, who looks after a client ...)
// is under "More" on its row.

import { Fragment, useState, useTransition } from "react";
import {
  missingForCapacity,
  tierCount,
  tierFieldsFor,
  type CapacitySetup,
  type SetupClient,
  type SetupDepartment,
  type SetupPerson,
  type SetupService,
  type SetupTier,
  type TierField,
} from "@transpera-flow/db";
import type { ClientRow, ClientAssignmentRow, ClientServiceRow } from "@transpera-flow/db";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import { ServiceMore } from "@/app/w/[slug]/settings/services-settings";
import { ServicesSettings } from "@/app/w/[slug]/settings/services-settings";
import { ClientHealthBenchmark, ClientGroupsSettings, GroupFields } from "@/app/w/[slug]/settings/client-groups-settings";
import { ClientMore, ClientsSettings, type ClientOps, type ClientsSettingsProps } from "@/app/w/[slug]/settings/clients-settings";
import { addClient, saveClientAssignment, saveClientField, saveClientServices } from "@/app/w/[slug]/settings/client-actions";
import { addNamedClient, addTierAction, removeTierAction, saveClientLookedAfter, saveSetupField } from "@/app/w/[slug]/setup/actions";
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import type { WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { clientSources } from "@/lib/clients";
import { HeadHelp, NumberCell, Note, TextCell } from "./cells";

type Scalar = string | number | boolean | null;

const saver =
  <T extends Scalar>(table: Parameters<typeof saveSetupField>[0], key: Record<string, string>, field: string, map?: { to: (v: T) => Scalar; from: (v: Scalar) => T }): Saver<T> =>
  async (base, next) => {
    const out = (await saveSetupField(table, key, field, map ? map.to(base) : base, map ? map.to(next) : next)) as SaveOutcome<Scalar>;
    if (!map) return out as SaveOutcome<T>;
    if (out.status === "saved") return { status: "saved", value: map.from(out.value) };
    if (out.status === "conflict") return { status: "conflict", theirs: map.from(out.theirs) };
    return out;
  };

/** What each tier field is, in plain words, with an example from the prototype's data. */
const FIELD_HELP: Record<TierField | "fee" | "churn", { label: string; description: string; example: string; scale?: number; unit?: string; step: number; max?: number }> = {
  fee: { label: "Fee a month", description: "What one client of this tier pays each month.", example: "Organic Tier 1: 11,000 a month.", step: 100 },
  words: { label: "Words", description: "Words of content one client of this tier gets each month. The content team's work is worked out from this.", example: "Organic Tier 2: 1,500 words a month.", step: 250 },
  links: { label: "Links", description: "Links built for one client of this tier each month.", example: "Organic Tier 2: 5 links a month.", step: 1 },
  tech_hours: { label: "Tech hours", description: "Technical SEO ticket hours for one client of this tier each month.", example: "Organic Tier 1: 10 hours a month.", step: 1 },
  meetings: { label: "Meetings", description: "Client meetings a month for one client of this tier.", example: "Tier 1 has 4 a month; Tier 2 has 1.", step: 0.5 },
  channels: { label: "Channels", description: "Ad channels run for one client of this tier (search, social, shopping and so on). Hygiene tasks are done per channel.", example: "Performance Tier 1: 4 channels.", step: 0.1 },
  builds: { label: "Builds", description: "Campaign builds and changes for one client of this tier each month.", example: "Performance Tier 2: 3 builds a month.", step: 0.5 },
  creative_sets: { label: "Creative sets", description: "Creative sets made for one client of this tier each month.", example: "Performance Tier 1: 2 creative sets a month.", step: 0.5 },
  adhoc_chance: { label: "Chance of ad hoc", description: "The share of this tier's clients who send any ad hoc requests in a month. The size of each request is the step's time (Processes).", example: "90%: nine in ten Tier 1 Organic clients ask for something extra in a month.", scale: 100, unit: "%", step: 5, max: 100 },
  adhoc_requests: { label: "Requests if they ask", description: "How many ad hoc requests a client sends in a month when they do ask.", example: "6.5 for Organic Tier 1.", step: 0.5 },
  churn: { label: "Churn a month", description: "The share of this tier's clients who leave in a month when everything is going well.", example: "1% a month for Tier 1: about one client in a hundred.", scale: 100, unit: "%", step: 0.5, max: 100 },
};

const plainName = (n: string) => n.replace(/\s*\(.*\)\s*$/, "");

interface Props {
  setup: CapacitySetup;
  data: WorkspaceSettingsData;
  roster: { clients: ClientRow[]; clientServices: ClientServiceRow[]; clientAssignments: ClientAssignmentRow[] };
}

const OPS: ClientOps = { add: addClient, saveField: saveClientField, saveServices: saveClientServices, saveAssignment: saveClientAssignment };

function moreProps(setup: CapacitySetup, data: WorkspaceSettingsData, roster: Props["roster"]): ClientsSettingsProps {
  return {
    workspaceId: setup.workspaceId,
    currency: setup.currency,
    clients: roster.clients,
    clientServices: roster.clientServices,
    clientAssignments: roster.clientAssignments,
    services: data.services.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    roles: data.roles,
    people: data.people.map((p) => ({ id: p.id, name: p.name, active: p.active })),
    personRoles: data.personRoles,
    canEdit: setup.canEdit,
    sources: clientSources(data.processes, data.services, data.clientGroups),
    ops: OPS,
  };
}

export function TiersAndClients({ setup, data, roster }: Props) {
  const { canEdit } = setup;
  const tierServiceIds = new Set(setup.services.filter((s) => s.tier_id).map((s) => s.id));
  return (
    <div className="flex min-w-0 flex-col gap-6" data-setup="clients">
      <TierControls setup={setup} />
      {setup.departments.map((d) => (
        <DepartmentTable key={d.id} setup={setup} data={data} department={d} />
      ))}
      <BothServices setup={setup} />
      <NamedClients setup={setup} data={data} roster={roster} />
      <SettingsSection id="more" title="More" description="Everything else about services and counted clients that used to live in Settings.">
        <details className="rounded-lg border border-line p-2">
          <summary className="cursor-pointer font-medium">Other services, every named client in full, counted clients and the client health benchmark</summary>
          <div className="mt-3 flex flex-col gap-6">
            <ServicesSettings data={data} tierServiceIds={tierServiceIds} />
            <ClientGroupsSettings data={data} onlyServiceIds={new Set(data.services.filter((s) => !tierServiceIds.has(s.id)).map((s) => s.id))} benchmark={false} />
            <ClientsSettings {...moreProps(setup, data, roster)} />
            <ClientHealthBenchmark data={data} />
          </div>
        </details>
        {!canEdit && <p className="text-xs text-fg-2">Agency admins and the Owner can change these.</p>}
      </SettingsSection>
    </div>
  );
}

function TierControls({ setup }: { setup: CapacitySetup }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const last = setup.tiers[setup.tiers.length - 1];
  const run = (fn: () => Promise<{ error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.error);
    });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {setup.canEdit && (
          <Button type="button" size="sm" disabled={pending} onClick={() => run(() => addTierAction(setup.workspaceId))}>
            + Add a tier
          </Button>
        )}
        {setup.canEdit && setup.tiers.length > 3 && last && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => removeTierAction(last.id))}>
            Remove {last.key}
          </Button>
        )}
        <span className="text-xs text-fg-2">A new tier starts as a copy of the last one. Tiers are shared by both departments.</span>
      </div>
      {error && (
        <p role="alert" className="text-crit">
          {error}
        </p>
      )}
      {setup.tiers.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">No tiers yet. Add the first one, then fill in what a client of the tier gets.</p>}
    </div>
  );
}

function serviceOf(setup: CapacitySetup, deptId: string, tierId: string): SetupService | undefined {
  return setup.services.find((s) => s.department_id === deptId && s.tier_id === tierId && s.active);
}

function DepartmentTable({ setup, data, department }: { setup: CapacitySetup; data: WorkspaceSettingsData; department: SetupDepartment }) {
  const fields = tierFieldsFor(department.name);
  const missing = new Set(missingForCapacity(setup, { salariesVisible: !setup.payHidden }).filter((m) => m.kind === "tier_deliverable").map((m) => `${m.id}:${m.field}`));
  const [open, setOpen] = useState<string | null>(null);
  const tiers = setup.tiers;
  const namedOn = (id: string) => setup.clients.filter((c) => c.active && c.service_ids.includes(id)).length;
  const cols = 5 + fields.length;
  return (
    <SettingsSection id={`tiers-${department.id}`} title={`${department.name} tiers`} description="Per client, a month. The defaults every client of the tier uses.">
      <Table>
        <TableHeader>
          <TableRow>
            <HeadHelp align="left" help={{ label: "Tier", description: "A level of service. The same tiers apply to both departments; each department has its own numbers for a tier.", example: "T1 gets the most effort and T3 the least." }}>
              Tier
            </HeadHelp>
            <HeadHelp help={{ label: "Clients", description: "How many clients the tier has: the named clients on it, plus everyone's portfolio count, plus counted clients nobody's portfolio holds yet.", example: "Organic T2: 27 clients, the sum of the portfolios of everyone who looks after T2." }}>
              Clients
            </HeadHelp>
            <HeadHelp help={FIELD_HELP.fee}>Fee a month</HeadHelp>
            {fields.map((f) => (
              <HeadHelp key={f} help={FIELD_HELP[f]}>
                {FIELD_HELP[f].label}
                {FIELD_HELP[f].unit ? ` ${FIELD_HELP[f].unit}` : ""}
              </HeadHelp>
            ))}
            <HeadHelp help={FIELD_HELP.churn}>Churn a month %</HeadHelp>
            {/* A slot for "Hours a month": it needs the engine (P5). */}
            <HeadHelp align="left" help={{ label: "More", description: "The rest of this tier's service: pricing model, entry process, servicing steps, path tags and counted clients.", example: "Open More to set the servicing steps for Organic T1." }}>
              More
            </HeadHelp>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((t, i) => {
            const svc = serviceOf(setup, department.id, t.id);
            if (!svc) {
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-semibold">{t.key}</TableCell>
                  <TableCell colSpan={cols - 1} className="text-fg-2">
                    No service for this tier in {department.name}.
                  </TableCell>
                </TableRow>
              );
            }
            const dataSvc = data.services.find((s) => s.id === svc.id);
            const key = { id: svc.id };
            const named = namedOn(svc.id);
            return (
              <Fragment key={t.id}>
                <TableRow data-tier={t.key} data-department={department.name}>
                  <TableCell>
                    <b>{t.key}</b>
                    <div className="text-xs text-fg-3">{i === 0 ? "Most effort" : i === tiers.length - 1 && tiers.length > 1 ? "Least effort" : ""}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-tier-count={svc.id}>
                    {tierCount(svc.id, setup)}
                    {named > 0 && <div className="text-xs text-fg-3">{named} named</div>}
                  </TableCell>
                  <TableCell>
                    <NumberCell label={`${department.name} ${t.key}: Fee a month`} value={svc.price} save={saver("services", key, "price")} canEdit={setup.canEdit} optional={false} min={0} step={FIELD_HELP.fee.step} provenance={svc.provenance} column="price" digits={0} />
                  </TableCell>
                  {fields.map((f) => {
                    const h = FIELD_HELP[f];
                    return (
                      <TableCell key={f}>
                        <NumberCell
                          label={`${department.name} ${t.key}: ${h.label}`}
                          value={svc[f]}
                          save={saver("services", key, f)}
                          canEdit={setup.canEdit}
                          scale={h.scale}
                          min={0}
                          max={h.max}
                          step={h.step}
                          provenance={svc.provenance}
                          column={f}
                          missing={missing.has(`${svc.id}:${f}`)}
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    <NumberCell label={`${department.name} ${t.key}: Churn a month`} value={svc.churn_monthly_base} save={saver("services", key, "churn_monthly_base")} canEdit={setup.canEdit} optional={false} scale={100} unit="" min={0} max={100} step={0.5} provenance={svc.provenance} column="churn_monthly_base" />
                  </TableCell>
                  <TableCell>
                    {dataSvc && (
                      <Button type="button" variant="link" size="xs" className="px-0" aria-expanded={open === svc.id} onClick={() => setOpen(open === svc.id ? null : svc.id)}>
                        {open === svc.id ? "Less" : "More"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
                {open === svc.id && dataSvc && (
                  <TableRow>
                    <TableCell colSpan={cols} className="bg-panel-2">
                      <p className="mb-2 text-xs text-fg-2">
                        {plainName(department.name)} {t.key}: price rise churn and the rest. Price-rise churn is the extra churn for each 10% rise, for 3 months, as a share (0.5 means churn x 1.5); it is stored for the Sandbox.
                      </p>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <NumberCell label={`${department.name} ${t.key}: Price-rise churn`} value={svc.price_rise_churn} save={saver("services", key, "price_rise_churn")} canEdit={setup.canEdit} optional={false} min={0} max={10} step={0.1} provenance={svc.provenance} column="price_rise_churn" help={{ description: "Extra churn for each 10% price rise, lasting 3 months, as a share of normal churn.", example: "0.5: a 10% rise lifts churn by half for 3 months (churn x 1.5)." }} />
                      </div>
                      <div className="grid gap-4">
                        <GroupFields service={dataSvc} data={data} />
                      </div>
                      <ServiceMore service={dataSvc} data={data} removable={false} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      <Note>
        Ad hoc: <b>chance of ad hoc</b> is the share of the tier&apos;s clients who send any requests in a month; <b>requests if they ask</b> is how many those clients send. The size of each request is the step&apos;s time (Processes). Client counts are the sum of everyone&apos;s portfolio (People &amp; roles).
      </Note>
    </SettingsSection>
  );
}

function BothServices({ setup }: { setup: CapacitySetup }) {
  return (
    <SettingsSection id="both" title="Clients taking both services" description='Counted clients who appear in both an Organic and a Performance portfolio. Named clients use the "Also takes" box below.'>
      <div className="flex flex-wrap gap-4">
        {setup.tiers.map((t) => (
          <div key={t.id} className="flex flex-col" data-both={t.key}>
            <span className="mb-1 flex items-center text-xs font-medium text-fg-2">
              {t.key}
              <HelpLabelDot />
            </span>
            <NumberCell
              label={`${t.key}: clients taking both services`}
              value={t.both_count}
              save={saver("tiers", { id: t.id }, "both_count")}
              canEdit={setup.canEdit}
              optional={false}
              min={0}
              step={1}
              digits={0}
              provenance={t.provenance}
              column="both_count"
            />
          </div>
        ))}
        {setup.tiers.length === 0 && <p className="text-fg-2">Add a tier first.</p>}
      </div>
    </SettingsSection>
  );
}

/** The (i) for the "taking both" counts, once. */
function HelpLabelDot() {
  return <HelpLabel label="Clients taking both services" description="Counted clients in this tier who buy both Organic and Performance. They are counted once in the unique-clients figure." example="Tier 2: 5 of the 27 Organic clients also take Performance." className="sr-only" />;
}

type ClientView = SetupClient & { departmentId: string | null; tierId: string | null; primary: string | null };

function NamedClients({ setup, data, roster }: { setup: CapacitySetup; data: WorkspaceSettingsData; roster: Props["roster"] }) {
  const [showInactive, setShowInactive] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const tierService = new Map(setup.services.filter((s) => s.tier_id).map((s) => [s.id, s]));
  const view = (c: SetupClient): ClientView => {
    const primary = c.service_ids.find((id) => tierService.has(id)) ?? null;
    const svc = primary ? tierService.get(primary)! : null;
    return { ...c, departmentId: svc?.department_id ?? null, tierId: svc?.tier_id ?? null, primary };
  };
  const clients = setup.clients.filter((c) => c.active || showInactive).map(view);
  const inactive = setup.clients.filter((c) => !c.active).length;
  const props = moreProps(setup, data, roster);
  const cols = 14;
  return (
    <SettingsSection
      id="clients"
      title="Named clients"
      description={'Blank = use the tier\'s value. Hand-holding is unplanned time each month: reassurance, extra calls, same-day turnarounds. Any tier can have named clients.'}
    >
      {setup.canEdit && <AddNamedClient setup={setup} />}
      <Table>
        <TableHeader>
          <TableRow>
            <HeadHelp align="left" help={{ label: "Client", description: "A named client, kept apart from the tier counts.", example: "Harbourline Group." }}>
              Client
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Department", description: "Which service line the client is in.", example: "Organic (SEO)." }}>
              Dept
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Tier", description: "Which tier the client is on. Their blank cells use this tier's values.", example: "T1." }}>
              Tier
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Also takes", description: "The client also takes the other department's service on the same tier, so they are counted once in the unique-clients figure.", example: "Harbourline takes SEO and Performance." }}>
              Also takes
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Looked after by", description: "The client-facing person in the client's department who looks after them. Only people who serve the tier are offered.", example: "Laura, for Harbourline." }}>
              Looked after by
            </HeadHelp>
            <HeadHelp help={FIELD_HELP.fee}>Fee</HeadHelp>
            <HeadHelp help={FIELD_HELP.channels}>Channels</HeadHelp>
            <HeadHelp help={{ label: "Hand-holding hours", description: "Unplanned hours a month for this client: reassurance, extra calls, same-day turnarounds. Blank: none.", example: "Kestrel Motors: 4 hours a month." }}>
              Hand-holding h
            </HeadHelp>
            <HeadHelp help={{ ...FIELD_HELP.adhoc_chance, label: "Chance of ad hoc" }}>Chance of ad hoc %</HeadHelp>
            <HeadHelp help={FIELD_HELP.adhoc_requests}>Requests if they ask</HeadHelp>
            <HeadHelp help={{ label: "Request size", description: "Minutes of hands-on work in one ad hoc request from this client. Blank: the ad hoc step's time.", example: "Kestrel Motors: 60 minutes for same-day turnarounds." }}>
              Request size (min)
            </HeadHelp>
            <HeadHelp help={FIELD_HELP.meetings}>Meetings a month</HeadHelp>
            <HeadHelp align="left" help={{ label: "More", description: "The rest of a client's record: status, start date, services and who looks after them in each role.", example: "Mark a client who has left as inactive." }}>
              More
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Remove", description: "A client who has left is made inactive: hidden and left out of simulations, but never deleted.", example: "Harbour Lane Dental left in March." }}>
              <span className="sr-only">Remove</span>
            </HeadHelp>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.length === 0 && (
            <TableRow>
              <TableCell colSpan={cols} className="text-fg-2" data-empty="clients">
                No named clients yet.
              </TableCell>
            </TableRow>
          )}
          {clients.map((c) => (
            <Fragment key={c.id}>
              <ClientLine setup={setup} client={c} tierService={tierService} open={open === c.id} onMore={() => setOpen(open === c.id ? null : c.id)} />
              {open === c.id && roster.clients.some((r) => r.id === c.id) && (
                <TableRow>
                  <TableCell colSpan={cols} className="bg-panel-2">
                    <ClientMore client={roster.clients.find((r) => r.id === c.id)!} {...props} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      {inactive > 0 && (
        <Button type="button" variant="link" size="sm" className="self-start px-0" aria-expanded={showInactive} onClick={() => setShowInactive((s) => !s)}>
          {showInactive ? "Hide inactive clients" : `Show ${inactive} inactive ${inactive === 1 ? "client" : "clients"}`}
        </Button>
      )}
      <Note>
        &quot;Also takes&quot; counts the client in both service lines; the client also appears in the other department&apos;s tier count. Later (not v1): bespoke recurring tasks per client, such as weekly localisation work.
      </Note>
    </SettingsSection>
  );
}

function AddNamedClient({ setup }: { setup: CapacitySetup }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [dept, setDept] = useState(setup.departments[0]?.id ?? "");
  const [tier, setTier] = useState(setup.tiers[0]?.id ?? "");
  const service = setup.services.find((s) => s.department_id === dept && s.tier_id === tier && s.active);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-add-named-client
      onSubmit={(e) => {
        e.preventDefault();
        if (!service) return setError("Add a tier first.");
        start(async () => {
          const r = await addNamedClient(setup.workspaceId, service.id, name);
          setError(r.error);
          if (!r.error) setName("");
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <HelpLabel label="New client name" description="The client's name, as you call them." example="Harbourline Group." />
        <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} aria-label="New client name" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-2">Department</span>
        <NativeSelect value={dept} onChange={(e) => setDept(e.target.value)} aria-label="New client department">
          {setup.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {plainName(d.name)}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-2">Tier</span>
        <NativeSelect value={tier} onChange={(e) => setTier(e.target.value)} aria-label="New client tier">
          {setup.tiers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Button type="submit" disabled={pending || !service}>
        + Add a client
      </Button>
      {error && (
        <p role="alert" className="w-full text-crit">
          {error}
        </p>
      )}
    </form>
  );
}

/** The client-facing people of a department who serve a tier. A person with no tiers entered yet serves every tier. */
export function managersFor(setup: CapacitySetup, departmentId: string | null, tierId: string | null): { person: SetupPerson; roleId: string }[] {
  if (!departmentId) return [];
  const out: { person: SetupPerson; roleId: string }[] = [];
  for (const p of setup.people) {
    if (!p.active) continue;
    if (p.tier_ids.length > 0 && tierId && !p.tier_ids.includes(tierId)) continue;
    const role = setup.roles.find((r) => p.role_ids.includes(r.id) && r.kind === "client_facing" && r.department_id === departmentId);
    if (role) out.push({ person: p, roleId: role.id });
  }
  return out;
}

function ClientLine({ setup, client: c, tierService, open, onMore }: { setup: CapacitySetup; client: ClientView; tierService: Map<string, SetupService>; open: boolean; onMore: () => void }) {
  const canEdit = setup.canEdit;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const key = { id: c.id };
  const svc = c.primary ? tierService.get(c.primary) : undefined;
  const dept = setup.departments.find((d) => d.id === c.departmentId);
  const tier = setup.tiers.find((t) => t.id === c.tierId);
  const performance = dept ? tierFieldsFor(dept.name).includes("channels") : false;
  const other = setup.departments.find((d) => d.id !== c.departmentId);
  const alsoService = other && c.tierId ? setup.services.find((s) => s.department_id === other.id && s.tier_id === c.tierId && s.active) : undefined;
  const also = alsoService ? c.service_ids.includes(alsoService.id) : false;
  const managers = managersFor(setup, c.departmentId, c.tierId);
  const roleIdsOfDept = new Set(setup.roles.filter((r) => r.department_id === c.departmentId && r.kind === "client_facing").map((r) => r.id));
  const current = Object.entries(c.assignments).find(([roleId]) => roleIdsOfDept.has(roleId));
  const currentName = current ? setup.people.find((p) => p.id === current[1])?.name : undefined;
  const ph = (v: number | null, scale = 1) => (v === null ? undefined : String(Math.round(v * scale * 100) / 100));
  const tierPlaceholder = (field: "channels" | "adhoc_chance" | "adhoc_requests" | "meetings", scale = 1) => ph(svc ? (svc[field] ?? null) : null, scale);
  const num = (field: "channels" | "hand_holding_hours" | "adhoc_chance" | "adhoc_requests" | "meetings", label: string, opts: { scale?: number; step: number; max?: number; placeholder?: string }) => (
    <NumberCell
      label={`${c.name}: ${label}`}
      value={c[field]}
      save={saver("clients", key, field)}
      canEdit={canEdit}
      scale={opts.scale}
      min={0}
      max={opts.max}
      step={opts.step}
      placeholder={opts.placeholder}
      provenance={c.provenance}
      column={field}
    />
  );
  const changeServices = (next: string[]) =>
    start(async () => {
      const r = await saveClientServices(c.id, setup.workspaceId, c.service_ids, next);
      setError(r.status === "error" ? r.message : r.status === "conflict" ? "Someone else changed this client's services. Reload to see them." : undefined);
    });
  const move = (departmentId: string, tierId: string) => {
    const target = setup.services.find((s) => s.department_id === departmentId && s.tier_id === tierId && s.active);
    if (!target) return;
    const keepOther = also && alsoService ? setup.services.find((s) => s.department_id === (departmentId === c.departmentId ? other?.id : c.departmentId) && s.tier_id === tierId && s.active) : undefined;
    const rest = c.service_ids.filter((id) => !tierService.has(id));
    changeServices([...rest, target.id, ...(keepOther ? [keepOther.id] : [])]);
  };
  return (
    <TableRow data-client={c.name}>
      <TableCell className="min-w-40">
        <TextCell label={`${c.name}: name`} value={c.name} save={saver("clients", key, "name")} canEdit={canEdit} />
        {error && (
          <p role="alert" className="text-xs text-crit">
            {error}
          </p>
        )}
      </TableCell>
      <TableCell>
        {canEdit ? (
          <NativeSelect aria-label={`${c.name}: department`} value={c.departmentId ?? ""} disabled={pending} onChange={(e) => c.tierId && move(e.target.value, c.tierId)}>
            {!c.departmentId && <option value="">Not on a tier</option>}
            {setup.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {plainName(d.name)}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <span>{dept ? plainName(dept.name) : "–"}</span>
        )}
      </TableCell>
      <TableCell>
        {canEdit ? (
          <NativeSelect aria-label={`${c.name}: tier`} value={c.tierId ?? ""} disabled={pending} onChange={(e) => c.departmentId && move(c.departmentId, e.target.value)}>
            {!c.tierId && <option value="">–</option>}
            {setup.tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.key}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <span>{tier?.key ?? "–"}</span>
        )}
      </TableCell>
      <TableCell>
        {alsoService && other && !canEdit ? (
          <span>{also ? plainName(other.name) : "–"}</span>
        ) : alsoService && other ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={`${c.name}: also takes ${plainName(other.name)}`}
              checked={also}
              disabled={!canEdit || pending}
              onChange={(e) => changeServices(e.target.checked ? [...c.service_ids, alsoService.id] : c.service_ids.filter((id) => id !== alsoService.id))}
              className="size-4 accent-[var(--accent)]"
            />
            {plainName(other.name)}
          </label>
        ) : (
          <span className="text-fg-3">–</span>
        )}
      </TableCell>
      <TableCell className="min-w-36">
        {canEdit ? (
          <NativeSelect
            aria-label={`${c.name}: looked after by`}
            disabled={pending}
            value={current?.[1] ?? ""}
            onChange={(e) => {
              const person = managers.find((m) => m.person.id === e.target.value);
              start(async () => {
                const r = await saveClientLookedAfter(c.id, setup.workspaceId, current ? { roleId: current[0], personId: current[1] } : null, person ? { roleId: person.roleId, personId: person.person.id } : null);
                setError(r.status === "error" ? r.message : r.status === "conflict" ? "Someone else changed who looks after this client. Reload to see it." : undefined);
              });
            }}
          >
            <option value="">Shared by the role</option>
            {managers.map((m) => (
              <option key={m.person.id} value={m.person.id}>
                {m.person.name}
              </option>
            ))}
            {current && !managers.some((m) => m.person.id === current[1]) && <option value={current[1]}>{currentName ?? "A team member"}</option>}
          </NativeSelect>
        ) : (
          <span>{currentName ?? "Shared by the role"}</span>
        )}
      </TableCell>
      <TableCell>
        <NumberCell
          label={`${c.name}: Fee`}
          value={c.mrr > 0 ? c.mrr : null}
          save={saver<number | null>("clients", key, "mrr", { to: (v) => v ?? 0, from: (v) => (typeof v === "number" && v > 0 ? v : null) })}
          canEdit={canEdit}
          min={0}
          step={100}
          digits={0}
          placeholder={ph(svc?.price ?? null)}
          provenance={c.provenance}
          column="mrr"
        />
      </TableCell>
      <TableCell>{performance ? num("channels", "Channels", { step: 0.1, placeholder: tierPlaceholder("channels") }) : <span className="text-fg-3">–</span>}</TableCell>
      <TableCell>{num("hand_holding_hours", "Hand-holding h", { step: 0.5, placeholder: "0" })}</TableCell>
      <TableCell>{num("adhoc_chance", "Chance of ad hoc %", { scale: 100, step: 5, max: 100, placeholder: tierPlaceholder("adhoc_chance", 100) })}</TableCell>
      <TableCell>{num("adhoc_requests", "Requests if they ask", { step: 0.5, placeholder: tierPlaceholder("adhoc_requests") })}</TableCell>
      <TableCell>
        <NumberCell label={`${c.name}: Request size (min)`} value={c.adhoc_hours} save={saver("clients", key, "adhoc_hours")} canEdit={canEdit} scale={60} min={0} max={1000} step={5} placeholder="the step's time" provenance={c.provenance} column="adhoc_hours" />
      </TableCell>
      <TableCell>{num("meetings", "Meetings a month", { step: 0.5, placeholder: tierPlaceholder("meetings") })}</TableCell>
      <TableCell>
        <Button type="button" variant="link" size="xs" className="px-0" aria-expanded={open} onClick={onMore}>
          {open ? "Less" : "More"}
        </Button>
      </TableCell>
      <TableCell>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Remove ${c.name}`}
            title="Make inactive: hidden and left out of simulations, never deleted"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await saveClientField(c.id, "active", c.active, !c.active);
                setError(r.status === "error" ? r.message : undefined);
              })
            }
          >
            {c.active ? "✕" : "Restore"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

// `SetupTier` is part of the props' vocabulary; re-exported for the page.
export type { SetupTier };
