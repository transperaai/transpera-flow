"use client";

import type { ReactNode } from "react";
import type { ClientGroupRow, ServiceRow } from "@transpera-flow/db";
import { NumberField } from "@/components/fields";
import { Help, type HelpProps } from "@/components/help";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsSection } from "./section";
import type { WorkspaceSettingsData } from "@/lib/data";
import { newGroupDefaults, MAX_GROUP_COUNT, type ClientGroupField } from "@/lib/client-groups";
import { saveClientGroupField, saveClientHealthBenchmark } from "./actions";

// Settings, "Services and client groups" (issue #120; the prototype's Settings screen): the clients counted per
// service instead of named. The simulation creates unnamed clients from these numbers, so late work still lowers
// health and drives churn.

type HelpText = Omit<HelpProps, "className">;

const HELP: Record<"count" | "fee" | "churn" | "stay" | "health" | "benchmark", HelpText> = {
  count: {
    label: "Clients",
    description: "How many clients you have on this service today.",
    example: "15 clients on SEO.",
  },
  fee: {
    label: "Average fee",
    description: "What one client pays each month, on average.",
    example: "3,600 a month.",
  },
  churn: {
    label: "Normal churn",
    description: "The share of clients who leave each month when everything is going well. Late or missed work makes more of them leave.",
    example: "1.5% a month: about 1 of 15 SEO clients leaves every 4 months.",
  },
  stay: {
    label: "Typical stay",
    description: "How long a client usually stays with you, in months. A new client is worth their fee times this.",
    example: "22 months, so a 3,600 a month client is worth about 79,000.",
  },
  health: {
    label: "Starting health",
    description: "How happy these clients are today, from 0 to 100. Servicing that runs on time lifts it; late or missed work lowers it, and lower health makes clients leave sooner.",
    example: "SEO clients start at 80.",
  },
  benchmark: {
    label: "Client health benchmark",
    description: "The range of client health that is normal for a business like yours. The People page shows your simulated client health against it.",
    example: "70 to 80 is typical for a small SEO and PPC agency.",
  },
};

const GROUP_FIELD = {
  client_count: "count",
  fee: "fee",
  churn_monthly: "churn",
  stay_months: "stay",
  starting_health: "health",
} as const satisfies Record<ClientGroupField, keyof typeof HELP>;

function Heading({ children, help, align = "right" }: { children: ReactNode; help: HelpText; align?: "left" | "right" }) {
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <span className="inline-flex items-center whitespace-nowrap">
        {children}
        <Help {...help} />
      </span>
    </TableHead>
  );
}

/**
 * The counted-clients table. `onlyServiceIds` limits it to those services (Set up shows the tiers' groups beside each tier, and the
 * others here); the benchmark is its own block (`ClientHealthBenchmark`), shown once.
 */
export function ClientGroupsSettings({ data, onlyServiceIds, benchmark = true }: { data: WorkspaceSettingsData; onlyServiceIds?: ReadonlySet<string>; benchmark?: boolean }) {
  const { clientGroups, canEdit, workspace } = data;
  const services = onlyServiceIds ? data.services.filter((s) => onlyServiceIds.has(s.id)) : data.services;
  const currency = workspace.settings.currency;
  const byService = new Map<string, ClientGroupRow>(clientGroups.map((g) => [g.service_id, g]));
  const total = clientGroups.reduce((a, g) => a + g.client_count, 0);
  const saver =
    (service: ServiceRow, field: ClientGroupField) => (base: number | null, next: number | null) =>
      saveClientGroupField(workspace.id, service.id, field, base, next);

  return (
    <SettingsSection
      id="client-groups"
      title="Services and client groups"
      description="Clients are counted per service rather than named. The simulation creates unnamed clients from these numbers, so late work still affects health and churn."
    >
      {services.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">Add a service above, then count its clients here.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <Heading align="left" help={{ label: "Service", description: "What you sell. Each row counts the clients on one service.", example: "SEO retainer." }}>
                  Service
                </Heading>
                <Heading help={HELP.count}>Clients</Heading>
                <Heading help={HELP.fee}>Average fee / month</Heading>
                <Heading help={HELP.churn}>Normal churn / month</Heading>
                <Heading help={HELP.stay}>Typical stay</Heading>
                <Heading help={HELP.health}>Starting health</Heading>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((sv) => {
                const group = byService.get(sv.id);
                const defaults = newGroupDefaults(sv);
                // A service with no group yet shows what a new one would start from, as placeholders; the first edit creates it.
                const field = (f: ClientGroupField, scale = 1, extra: { unit?: string; min: number; max: number; step: number }) => (
                  <NumberField
                    label={`${sv.name}: ${HELP[GROUP_FIELD[f]].label}`}
                    hideLabel
                    help={HELP[GROUP_FIELD[f]]}
                    value={group ? Number(group[f]) : null}
                    save={saver(sv, f)}
                    scale={scale}
                    placeholder={group ? undefined : String(Math.round(defaults[f] * scale * 100) / 100)}
                    disabled={!canEdit}
                    {...extra}
                  />
                );
                return (
                  <TableRow key={sv.id}>
                    <TableCell className="font-medium">
                      <span className={sv.active ? "" : "text-fg-3 line-through"}>{sv.name}</span>
                    </TableCell>
                    <TableCell className="min-w-24">{field("client_count", 1, { min: 0, max: MAX_GROUP_COUNT, step: 1 })}</TableCell>
                    <TableCell className="min-w-32">{field("fee", 1, { unit: currency, min: 0, max: 1e8, step: 50 })}</TableCell>
                    <TableCell className="min-w-28">{field("churn_monthly", 100, { unit: "%", min: 0, max: 100, step: 0.1 })}</TableCell>
                    <TableCell className="min-w-28">{field("stay_months", 1, { unit: "months", min: 0, max: 1200, step: 1 })}</TableCell>
                    <TableCell className="min-w-24">{field("starting_health", 1, { min: 0, max: 100, step: 1 })}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {total === 0
          ? "No clients counted yet: until you do, the simulation uses the interim client count in Simulation."
          : `${total} ${total === 1 ? "client" : "clients"} in all. Once any service has clients counted, only counted clients are simulated. A service with no numbers yet starts from its own price, base churn and expected tenure.`}
      </p>

      {benchmark && <ClientHealthBenchmark data={data} />}
    </SettingsSection>
  );
}

/** The range of client health that is normal for the business (the People page shows the simulated score against it). */
export function ClientHealthBenchmark({ data }: { data: WorkspaceSettingsData }) {
  const { canManage, workspace } = data;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex items-center text-xs font-medium text-fg-2">
        Client health benchmark
        <Help {...HELP.benchmark} />
      </legend>
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <NumberField
          label="From"
          help={{ description: "The low end of the client health that is normal for a business like yours.", example: "70 for a small SEO and PPC agency." }}
          value={workspace.settings.client_health_benchmark_low ?? null}
          save={(base, next) => saveClientHealthBenchmark(workspace.id, "low", base, next)}
          optional
          min={0}
          max={100}
          step={1}
          placeholder="70"
          disabled={!canManage}
        />
        <NumberField
          label="To"
          help={{ description: "The high end of the client health that is normal for a business like yours.", example: "80 for a small SEO and PPC agency." }}
          value={workspace.settings.client_health_benchmark_high ?? null}
          save={(base, next) => saveClientHealthBenchmark(workspace.id, "high", base, next)}
          optional
          min={0}
          max={100}
          step={1}
          placeholder="80"
          disabled={!canManage}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {canManage ? "The People page shows your client health against this range. Leave both blank for no benchmark." : "Only Agency admins can change this."}
      </p>
  </fieldset>
  );
}

/** One service's counted-clients numbers in a grid (Set up shows it under "More" for a tier). */
export function GroupFields({ service, data }: { service: ServiceRow; data: WorkspaceSettingsData }) {
  const group = data.clientGroups.find((g) => g.service_id === service.id);
  const defaults = newGroupDefaults(service);
  const currency = data.workspace.settings.currency;
  const field = (f: ClientGroupField, scale: number, label: string, extra: { unit?: string; min: number; max: number; step: number }) => (
    <NumberField
      label={label}
      help={HELP[GROUP_FIELD[f]]}
      value={group ? Number(group[f]) : null}
      save={(base, next) => saveClientGroupField(data.workspace.id, service.id, f, base, next)}
      scale={scale}
      placeholder={group ? undefined : String(Math.round(defaults[f] * scale * 100) / 100)}
      disabled={!data.canEdit}
      {...extra}
    />
  );
  return (
    <fieldset className="sm:col-span-2 lg:col-span-3">
      <legend className="mb-1 text-xs font-medium text-fg-2">Counted clients: the numbers the simulation uses for clients nobody is named for</legend>
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {field("client_count", 1, "Counted clients nobody's portfolio holds yet", { min: 0, max: MAX_GROUP_COUNT, step: 1 })}
        {field("fee", 1, "Average fee a month", { unit: currency, min: 0, max: 1e8, step: 50 })}
        {field("churn_monthly", 100, "Normal churn a month", { unit: "%", min: 0, max: 100, step: 0.1 })}
        {field("stay_months", 1, "Typical stay", { unit: "months", min: 0, max: 1200, step: 1 })}
        {field("starting_health", 1, "Starting health", { min: 0, max: 100, step: 1 })}
      </div>
    </fieldset>
  );
}
