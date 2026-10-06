"use client";

import { useActionState, useState, useTransition } from "react";
import { DEFAULT_AVAILABILITY_FLOOR } from "@transpera-flow/engine";
import { ChecklistField, DateField, NumberField, TextField, ToggleField } from "@/components/fields";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsSection } from "./section";
import { CapacityFactors } from "./capacity-factors-field";
import type { PersonDetail, WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { formatNumber } from "@/lib/format";
import { selectableRoles } from "@/lib/roles";
import {
  addLeave,
  createPerson,
  removeLeave,
  saveAvailabilityFloor,
  saveCapacityFactorsEnabled,
  saveOvertimeCap,
  savePersonField,
  savePersonSet,
  type ActionResult,
  type PersonField,
} from "./actions";

type Scalar = string | number | boolean | null;

/** A saver for one column of one person. */
const personSaver =
  <T extends Scalar>(personId: string, field: PersonField): Saver<T> =>
  (base, next) =>
    savePersonField(personId, field, base, next) as Promise<SaveOutcome<T>>;


export function SimulationSettings({ data }: { data: WorkspaceSettingsData }) {
  const { workspace, canManage } = data;
  const floor = workspace.settings.availability_floor ?? null;
  const overtime = workspace.settings.overtime_cap ?? null;
  const ownersOnly = canManage ? undefined : "Only workspace owners can change this.";
  return (
    <SettingsSection id="simulation" title="Simulation" description="Limits on how the simulation treats people's time.">
      <div className="grid gap-4 sm:grid-cols-2">
        <ToggleField
          label="Per-person times"
          value={workspace.settings.capacity_factor_enabled === true}
          save={(base, next) => saveCapacityFactorsEnabled(workspace.id, base, next)}
          onLabel="On: people can have their own times"
          offLabel="Off: everyone works at their role's normal time"
          disabled={!data.canEdit}
          hint={data.canEdit ? undefined : "Only owners and editors can change this."}
          help={{
            description:
              "Let owners and editors say that one person takes more or less time than their role's normal time on some steps. Off: everyone in a role works at the role's normal time. Each person sees only their own times; they are never ranked or compared across people. Members' and viewers' simulations always use the role's normal time.",
            example: "Maya has run kickoffs for years and takes about 0.8 of the normal time on Kickoff, 20% faster. Switch this on and set 0.8 on Kickoff in her detail under People.",
          }}
        />
        <NumberField
          label="Availability floor"
          value={floor}
          save={(base, next) => saveAvailabilityFloor(workspace.id, base, next)}
          optional
          scale={100}
          unit="%"
          min={0}
          max={50}
          step={1}
          placeholder={`${DEFAULT_AVAILABILITY_FLOOR * 100} (default)`}
          disabled={!canManage}
          hint={ownersOnly ?? "Leave blank to use the default."}
          help={{
            description: "The share of each person's week that is always left for sales work, however busy client work gets. This stops client work from squeezing the sales process to a standstill.",
            example: "At 8%, someone with a 40-hour week always has about 3 hours for sales work, even in a month when client work would fill the rest.",
          }}
        />
        <NumberField
          label="Overtime cap"
          value={overtime}
          save={(base, next) => saveOvertimeCap(workspace.id, base, next)}
          optional
          scale={100}
          unit="% of a week"
          min={0}
          max={100}
          step={5}
          placeholder="0 (default: none)"
          disabled={!canManage}
          hint={ownersOnly ?? "Leave blank for no overtime."}
          help={{
            description: "How much extra, beyond a normal week, people work to keep up when their client work is more than their week. The simulation counts the extra hours and their cost. Past this limit, people show as too busy and an Operational risk is raised.",
            example: "At 10%, someone with a 40-hour week can work up to 4 hours extra before they count as overloaded.",
          }}
        />
      </div>
    </SettingsSection>
  );
}

export function PeopleSettings({ data }: { data: WorkspaceSettingsData }) {
  const active = data.people.filter((p) => p.active);
  const inactive = data.people.filter((p) => !p.active);
  return (
    <SettingsSection id="people" title="People" description={
      data.canEdit ? (
        <>
          {active.length} active{inactive.length ? `, ${inactive.length} inactive` : ""}. Modelled for capacity, not performance.
        </>
      ) : (
        <>Your record. Owners and editors see the whole team. Modelled for capacity, not performance.</>
      )
    }>
      {data.canEdit ? (
        <AddPerson data={data} />
      ) : (
        <p className="mb-3 text-fg-2">You can view people here; owners and editors can change them.</p>
      )}
      {data.people.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">
          No people yet. Until you add some, each role&apos;s head-count is used instead.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {[...active, ...inactive].map((p) => (
            <li key={p.id}>
              <PersonRow person={p} data={data} />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function AddPerson({ data }: { data: WorkspaceSettingsData }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(createPerson.bind(null, data.workspace.id), {});
  return (
    <form action={action} className="mb-4 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <HelpLabel label="Name" description="The person's name, as it appears across the app." example="Maya Collins" />
        <Input name="name" required maxLength={200} />
      </label>
      <label className="flex flex-col gap-1">
        <HelpLabel label="Role" description="The kind of work they do. A step that needs a role can be done by anyone who has it. You can add more roles later." example="Strategist, if Maya runs the strategy steps." />
        <NativeSelect name="role_id">
          <option value="">No role yet</option>
          {selectableRoles(data.roles).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Button
        type="submit"
        disabled={pending}
      >
        {pending ? "Adding…" : "Add person"}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-crit">
          {state.error}
        </p>
      )}
    </form>
  );
}

function PersonRow({ person: p, data }: { person: PersonDetail; data: WorkspaceSettingsData }) {
  const roleIds = data.personRoles.filter((r) => r.person_id === p.id).map((r) => r.role_id);
  const skillIds = data.personSkills.filter((s) => s.person_id === p.id).map((s) => s.step_id);
  const leave = data.personLeave.filter((l) => l.person_id === p.id);
  const roleNames = data.roles.filter((r) => roleIds.includes(r.id)).map((r) => r.name);
  const hoursPerWeek = data.workspace.settings.hours_per_week;
  const capacity = p.capacity_hours_week ?? Number(p.fte) * hoursPerWeek;
  const disabled = !data.canEdit;
  const roleName = new Map(data.roles.map((r) => [r.id, r.name]));
  const factorsOn = data.workspace.settings.capacity_factor_enabled === true;
  const hasStoredFactors = data.personCapacityFactors.some((f) => f.person_id === p.id);

  return (
    <details className="group py-2">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-1 py-1 hover:bg-panel-2">
        <span aria-hidden className="text-fg-3 transition-transform group-open:rotate-90">
          ›
        </span>
        <span className={`font-semibold ${p.active ? "" : "text-fg-3 line-through"}`}>{p.name}</span>
        <span className="text-fg-2">{roleNames.join(", ") || "No role"}</span>
        <span className="text-fg-3 tabular-nums">
          {formatNumber(Number(p.fte), 2)} of full time · {formatNumber(Number(capacity), 1)} h/week
        </span>
        {leave.length > 0 && <span className="text-fg-3">{leave.length} leave</span>}
        {!p.active && <span className="rounded-lg bg-panel-2 px-1.5 text-xs text-fg-2">Inactive</span>}
      </summary>

      <div className="grid gap-4 px-1 pt-3 pb-2 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Name" value={p.name} save={personSaver(p.id, "name")} disabled={disabled} help={{ description: "The person's name, as it appears across the app.", example: "Maya Collins" }} />
        <TextField label="Email" type="email" value={p.email} save={personSaver(p.id, "email")} optional disabled={disabled} help={{ description: "Their work email. Optional, and not used by the simulation.", example: "maya@northbeam.example" }} />
        <ToggleField
          label="Status"
          value={p.active}
          save={personSaver(p.id, "active")}
          onLabel="Active"
          offLabel="Inactive: left out of simulations"
          disabled={disabled} help={{ description: "Inactive people are left out of simulations, but their record is kept.", example: "Mark someone inactive when they leave. Past data stays; future runs no longer count their time." }} />
        <NumberField
          label="Working time (1 = full time)"
          value={Number(p.fte)}
          save={personSaver(p.id, "fte")}
          min={0.05}
          max={1.5}
          step={0.1}
          disabled={disabled} help={{ description: "How much of a full week they work: 1 is full time, 0.5 is half time. It sets how many hours they have each week, unless you type the hours yourself.", example: "At 0.8 with a 40-hour week, they have 32 hours a week." }} />
        <NumberField
          label="Capacity"
          value={p.capacity_hours_week === null ? null : Number(p.capacity_hours_week)}
          save={personSaver(p.id, "capacity_hours_week")}
          optional
          unit="h/week"
          min={0.5}
          max={80}
          step={0.5}
          placeholder={`${formatNumber(Number(p.fte) * hoursPerWeek, 1)} from working time`}
          hint="Blank: working time × the workspace week."
          disabled={disabled} help={{ description: "The hours they can work each week, when that isn't simply their working time times the working week. Leave blank to use working time.", example: "A full-time person who works four 7.5-hour days: enter 30." }} />
        <NumberField
          label="Cost rate"
          value={p.cost_rate === null ? null : Number(p.cost_rate)}
          save={personSaver(p.id, "cost_rate")}
          optional
          unit={`${data.workspace.settings.currency}/h`}
          min={0}
          step={1}
          placeholder="Role default"
          disabled={disabled} help={{ description: "What an hour of this person's time costs. Leave blank to use the role's rate. The simulation uses it to cost overtime.", example: "35 means each overtime hour costs 35." }} />
        <DateField label="Start date" value={p.start_date} save={personSaver(p.id, "start_date")} disabled={disabled} help={{ description: "The first day they work here. Runs that start before it leave them out.", example: "A new hire starting on 3 November is not counted in runs that start in October." }} />
        <DateField label="End date" value={p.end_date} save={personSaver(p.id, "end_date")} disabled={disabled} help={{ description: "Their last day. Runs that start after it leave them out. Leave blank if they are staying.", example: "Someone leaving at the end of March: enter 31 March." }} />
        <TextField label="Notes" value={p.notes} save={personSaver(p.id, "notes")} optional multiline disabled={disabled} help={{ description: "Anything worth remembering about this person's time. Not used by the simulation.", example: "Does school pick-ups on Fridays, so unavailable after 2pm." }} />

        <div className="sm:col-span-2 lg:col-span-3">
          <ChecklistField
            label="Roles"
            value={roleIds}
            save={(base, next) => savePersonSet(p.id, p.workspace_id, "roles", [...base], [...next])}
            options={selectableRoles(data.roles, roleIds).map((r) => ({ id: r.id, label: r.name }))}
            emptyLabel="no roles"
            disabled={disabled} help={{ description: "The kinds of work they do. A step that needs a role can be done by anyone who has it.", example: "Tick Strategist and Account manager if Maya does both." }} />
        </div>
        {data.steps.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3">
            <ChecklistField
              label="Skills: steps they can do"
              value={skillIds}
              save={(base, next) => savePersonSet(p.id, p.workspace_id, "skills", [...base], [...next])}
              options={data.steps.map((s) => ({
                id: s.id,
                label: s.name,
                sublabel: s.role_id ? roleName.get(s.role_id) : undefined,
              }))}
              hint="None ticked: every step of their roles."
              emptyLabel="every step of their roles"
              disabled={disabled} help={{ description: "Limit this person to particular steps within their roles. If nothing is ticked, they can do every step of their roles.", example: "Tick only Kickoff and strategy if Tom does kickoffs but not audits." }} />
          </div>
        )}
        {factorsOn ? (
          <div className="sm:col-span-2 lg:col-span-3">
            <CapacityFactors person={p} data={data} />
          </div>
        ) : hasStoredFactors ? (
          <p className="text-fg-3 sm:col-span-2 lg:col-span-3" data-factors-off>
            Per-person times are off, so these aren&apos;t used.
          </p>
        ) : null}
        <div className="sm:col-span-2 lg:col-span-3">
          <Leave personId={p.id} workspaceId={p.workspace_id} leave={leave} disabled={disabled} />
        </div>
      </div>
    </details>
  );
}

function Leave({
  personId,
  workspaceId,
  leave,
  disabled,
}: {
  personId: string;
  workspaceId: string;
  leave: WorkspaceSettingsData["personLeave"];
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(addLeave.bind(null, personId, workspaceId), {});
  const [removing, startRemoving] = useTransition();
  const [removeError, setRemoveError] = useState<string>();
  return (
    <fieldset>
      <legend className="mb-1 flex items-center text-xs font-medium text-fg-2">
        Leave
        <Help
          label="Leave"
          description="Days when this person is away. The simulation takes those working days off their hours."
          example="Add 4 to 15 August, holiday, and Maya has no hours in those two weeks."
        />
      </legend>
      {leave.length === 0 ? (
        <p className="text-fg-3">No leave booked.</p>
      ) : (
        <ul className="mb-2 flex flex-col gap-1">
          {leave.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-3">
              <span className="tabular-nums">
                {l.start_date === l.end_date ? l.start_date : `${l.start_date} to ${l.end_date}`}
              </span>
              {l.note && <span className="text-fg-2">{l.note}</span>}
              {!disabled && (
                <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground underline hover:text-destructive"
                  type="button"
                  disabled={removing}
                  onClick={() =>
                    startRemoving(async () => {
                      const r = await removeLeave(l.id);
                      setRemoveError(r.error);
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {removeError && (
        <p role="alert" className="text-crit">
          {removeError}
        </p>
      )}
      {!disabled && (
        <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <HelpLabel label="First day" description="The first day of the leave." example="Monday 14 July." />
            <Input type="date" name="start_date" required />
          </label>
          <label className="flex flex-col gap-1">
            <HelpLabel label="Last day" description="The last day of the leave. Leave blank for a single day." example="Friday 25 July, for a two-week holiday." />
            <Input type="date" name="end_date" />
          </label>
          <label className="flex flex-col gap-1">
            <HelpLabel label="Note" description="Anything worth remembering about this leave. Not used by the simulation." example="Annual leave." />
            <Input name="note" maxLength={200} />
          </label>
          <Button variant="outline" size="sm"
            type="submit"
            disabled={pending}
          >
            {pending ? "Adding…" : "Add leave"}
          </Button>
          {state.error && (
            <p role="alert" className="w-full text-crit">
              {state.error}
            </p>
          )}
        </form>
      )}
    </fieldset>
  );
}
