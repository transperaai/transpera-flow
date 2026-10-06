"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { RecurrenceJson, ServiceRow } from "@transpera-flow/db";
import { NumberField, SelectField } from "@/components/fields";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsSection } from "./section";
import type { WorkspaceSettingsData } from "@/lib/data";
import { HEALTH_SETTINGS, recurrenceFromValue, recurrenceOptions, type HealthSetting } from "@/lib/servicing";
import { linkServicingProcess, saveHealthSetting, saveServicingRecurrence, saveServicingSla, unlinkServicingProcess } from "./servicing-actions";


/**
 * The servicing processes a service's clients run (docs/PRD.md §5
 * `service_servicing`, §6.3.5; issue #19): how often each client gets a task
 * and the SLA it is measured against. Linking one replaces the service's
 * fallback load per client.
 */
export function ServicingLinks({ service: sv, data }: { service: ServiceRow; data: WorkspaceSettingsData }) {
  const links = data.servicingLinks.filter((l) => l.service_id === sv.id);
  const servicing = data.processes.filter((p) => p.kind === "servicing");
  const name = new Map(data.processes.map((p) => [p.id, p.name]));
  const unlinked = servicing.filter((p) => !links.some((l) => l.process_id === p.id));
  const hoursPerDay = data.workspace.settings.hours_per_week / 5;
  const disabled = !data.canEdit;
  const [adding, setAdding] = useState(unlinked[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const run = (f: () => Promise<{ error?: string }>) =>
    start(async () => {
      const r = await f();
      setError(r.error);
    });
  return (
    <fieldset className="sm:col-span-2 lg:col-span-3">
      <legend className="mb-1 text-xs font-medium text-fg-2">Servicing processes</legend>
      {links.length ? (
        <ul className="flex flex-col gap-3">
          {links.map((l) => (
            <li key={l.id} className="grid items-end gap-3 rounded-lg border border-line p-2 sm:grid-cols-[1fr_12rem_10rem_auto]">
              <p className="self-center font-medium">
                <Link href={`/w/${data.workspace.slug}/p/${l.process_id}`} className="underline">
                  {name.get(l.process_id) ?? "A process"}
                </Link>
              </p>
              <SelectField
                label="How often, per client"
                value={JSON.stringify(l.recurrence)}
                options={recurrenceOptions(l.recurrence as RecurrenceJson)}
                save={async (base, next) => {
                  const b = recurrenceFromValue(base);
                  const n = recurrenceFromValue(next);
                  if (!b || !n) return { status: "error", message: "Choose how often." };
                  return saveServicingRecurrence(l.id, b, n);
                }}
                disabled={disabled}
                help={{
                  description: "How often this process runs for each client of the service. Every run is a piece of client work that has to be done on time.",
                  example: "Monthly: a client on the SEO retainer gets one monthly report to produce, every month.",
                }}
              />
              <NumberField
                label="On time within"
                value={Number(l.sla_hours)}
                save={(base, next) => saveServicingSla(l.id, base, next)}
                scale={1 / hoursPerDay}
                unit="working days"
                min={0.05}
                max={250}
                step={0.5}
                disabled={disabled}
                help={{
                  description: "How many working days the work has to be done within. Done in time, it helps the client's health; later, it hurts it; not done within twice this, it hurts more.",
                  example: "5 working days: a report finished on day 4 is on time, day 7 is late, day 11 is missed.",
                }}
              />
              {!disabled && (
                <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground underline hover:text-destructive mb-1" type="button" disabled={pending} onClick={() => run(() => unlinkServicingProcess(l.id))}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-fg-2">None: each client needs the fallback load below instead.</p>
      )}
      {!disabled &&
        (unlinked.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`link-${sv.id}`}>
              Servicing process to link
            </label>
            <NativeSelect id={`link-${sv.id}`} value={adding} onChange={(e) => setAdding(e.target.value)} className="w-auto">
              {unlinked.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
            <Help
              label="Servicing process to link"
              description="The steps of the regular work you do for each client of this service. Linking it means each client's work follows those steps instead of a flat number of hours."
              example="Link Monthly SEO reporting to the SEO service, so every SEO client gets the reporting work."
              className="self-center"
            />
            <Button variant="outline" size="sm"
              type="button"
              disabled={pending || !adding}
              onClick={() => run(() => linkServicingProcess(data.workspace.id, sv.id, adding))}
            >
              {pending ? "Linking…" : "Link"}
            </Button>
          </div>
        ) : !servicing.length ? (
          <p className="mt-1 text-xs text-fg-3">
            No servicing processes yet: add one from the process page (+ Servicing process), then link it here.
          </p>
        ) : null)}
      {error && (
        <p role="alert" className="mt-1 text-crit">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-fg-3">
        Every client on this service gets a task from each linked process this often. A task goes to the client&apos;s assigned person
        for each step&apos;s role (the role&apos;s other people while they&apos;re on leave). Done within the SLA, the client&apos;s health
        recovers; late or not done within twice it, health drops, and churn rises.
      </p>
    </fieldset>
  );
}

const HEALTH_HELP: Record<HealthSetting, { description: string; example: string }> = {
  health_initial: {
    description: "How healthy a client is when you haven't entered a health for them, and when a new client is won. Health runs from 0 to 100.",
    example: "At 70, a client you've just won starts at 70 and moves up or down as work is done on time or late.",
  },
  health_recover: {
    description: "How many health points a client gains each time a piece of work is done on time. Health never goes above 100.",
    example: "At 2, five on-time reports lift a client from 70 to 80.",
  },
  health_late_penalty: {
    description: "How many health points a client loses each time work is done late, after its deadline.",
    example: "At 5, one late report takes a client from 70 to 65.",
  },
  health_missed_penalty: {
    description: "How many health points a client loses when work isn't done at all within twice its deadline. It should be more than the late penalty.",
    example: "At 12, a report that is never done takes a client from 70 to 58.",
  },
};

/** How servicing moves client health (docs/PRD.md §6.3.5): blank uses the estimated defaults. */
export function HealthSettings({ data }: { data: WorkspaceSettingsData }) {
  const { workspace, canEdit } = data;
  const settings = workspace.settings as unknown as Record<string, number | undefined>;
  return (
    <SettingsSection id="health" title="Client health" description={<>How servicing tasks move a client&apos;s health (0–100). Monthly churn = the service&apos;s base churn × (1 + sensitivity ×
          (100 − health) / 100); below 50 a client is at risk. Blank uses the estimated default.</>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(HEALTH_SETTINGS) as HealthSetting[]).map((key) => {
          const rule = HEALTH_SETTINGS[key];
          const value = settings[key];
          return (
            <NumberField
              key={key}
              label={rule.label}
              value={typeof value === "number" ? value : null}
              save={(base, next) => saveHealthSetting(workspace.id, key, base, next)}
              optional
              unit={rule.unit}
              min={0}
              max={rule.max}
              step={1}
              placeholder={`${rule.fallback} (estimated)`}
              disabled={!canEdit}
              hint={canEdit ? rule.hint : "You can view these; owners and editors can change them."}
              help={HEALTH_HELP[key]}
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}
