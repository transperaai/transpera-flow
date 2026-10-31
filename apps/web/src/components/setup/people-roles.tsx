"use client";

// Set up, People & roles (capacity build P1; the prototype's "People & roles"): the roles with their department, kind, line and unit; how the
// shared teams work (units, no rates yet); and the people with their hours, team time, salary, tiers served, portfolio counts and label.
// A Viewer sees the same page as text, with no inputs; whoever can't see pay (`payHidden`) doesn't get the salary column at all.
// Per-person times (how fast one person is) stay under "More" on the person, never in a column: they are never ranked or compared.

import { Fragment, useState } from "react";
import { formatRamp, missingForCapacity, sourceLabel, type CapacitySetup, type SetupPerson, type SetupRole } from "@transpera-flow/db";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import { AddRole, RoleMore, RolesSettings } from "@/app/w/[slug]/settings/roles-settings";
import { AddPerson, PeopleSettings, PersonMore } from "@/app/w/[slug]/settings/people-settings";
import { saveRoleField, savePersonField } from "@/app/w/[slug]/settings/actions";
import { saveDlerIncludesLeadership, savePersonRamp, savePersonTiers, savePortfolioCount, saveRampDefault, saveSetupField } from "@/app/w/[slug]/setup/actions";
import { TextField, ToggleField } from "@/components/fields";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import type { WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { HeadHelp, Marks, NumberCell, Note, SelectCell, TextCell } from "./cells";

type Scalar = string | number | boolean | null;

const field =
  <T extends Scalar>(table: Parameters<typeof saveSetupField>[0], key: Record<string, string>, name: string): Saver<T> =>
  (base, next) =>
    saveSetupField(table, key, name, base, next) as Promise<SaveOutcome<T>>;

export function PeopleAndRoles({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-setup="people">
      <RolesTable setup={setup} data={data} />
      <SharedTeams setup={setup} />
      <PeopleTable setup={setup} data={data} />
      <WorkspaceDefaults setup={setup} />
      <SettingsSection id="more" title="More" description="Every role and person in full, as they were in Settings.">
        <details className="rounded-lg border border-line p-2">
          <summary className="cursor-pointer font-medium">All roles and all people, with every field</summary>
          <div className="mt-3 flex flex-col gap-6">
            <RolesSettings data={data} />
            <PeopleSettings data={data} />
          </div>
        </details>
      </SettingsSection>
    </div>
  );
}

function RolesTable({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = setup.canEdit;
  const dept = new Map(setup.departments.map((d) => [d.id, d.name]));
  const missing = missingForCapacity(setup, { salariesVisible: false });
  const noUnit = new Set(missing.filter((m) => m.kind === "shared_role_unit").map((m) => m.id));
  return (
    <SettingsSection id="roles" title="Roles" description="Kinds of work. Steps, people and client assignments name roles. A role that is in use can't be removed; make it inactive to hide it from pickers.">
      {canEdit && <AddRole workspaceId={setup.workspaceId} />}
      <Table>
        <TableHeader>
          <TableRow>
            <HeadHelp align="left" help={{ label: "Role", description: "A kind of work. A step that needs a role can be done by anyone who has it.", example: "SEO Director." }}>
              Role
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Department", description: "The service line the role works in.", example: "SEO Director: Organic (SEO)." }}>
              Department
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Kind", description: "Client-facing roles own clients in a portfolio. Shared teams own none: they work in their own unit, and client demand turns into their hours.", example: "SEO Manager is client-facing; the Content team is a shared team." }}>
              Kind
            </HeadHelp>
            <HeadHelp help={{ label: "Line (busy %)", description: "How busy this role can be before it counts as full. Past the line, more clients won't fit.", example: "85%: a person booked at 85% of their hours is at the line." }}>
              Line (busy %)
            </HeadHelp>
            <HeadHelp help={{ label: "Max-clients rule", description: "A rule of thumb: the most clients one person in this role holds. Shown as a line to compare the real counts against.", example: "SEO Manager: 10 clients." }}>
              Max-clients rule
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Unit of work", description: "What a shared team counts its work in. Rates for each unit come later.", example: "Content team: words. Link outreach: links." }}>
              Unit of work
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "More", description: "Status, name, and whether the role is used.", example: "Make a role inactive when you stop using it." }}>
              More
            </HeadHelp>
          </TableRow>
        </TableHeader>
        <TableBody>
          {setup.roles.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-fg-2">
                No roles yet. Add the kinds of work your team does.
              </TableCell>
            </TableRow>
          )}
          {setup.roles.map((r) => {
            const key = { id: r.id };
            const usage = data.roleUsage[r.id] ?? { steps: 0, people: 0, clients: 0, services: 0 };
            return (
              <Fragment key={r.id}>
                <TableRow data-role={r.name}>
                  <TableCell className="min-w-40">
                    <TextCell label={`${r.name}: name`} value={r.name} save={(base, next) => saveRoleField(r.id, "name", base, next) as Promise<SaveOutcome<string | null>>} canEdit={canEdit} />
                  </TableCell>
                  <TableCell>
                    <SelectCell
                      label={`${r.name}: department`}
                      value={r.department_id}
                      save={field("roles", key, "department_id")}
                      canEdit={canEdit}
                      noneLabel="No department"
                      options={setup.departments.map((d) => ({ value: d.id, label: d.name }))}
                    />
                    {!canEdit && r.department_id === null && <span className="text-fg-3">–</span>}
                    {r.department_id && !dept.has(r.department_id) && <span className="text-fg-3">A removed department</span>}
                  </TableCell>
                  <TableCell>
                    <SelectCell
                      label={`${r.name}: kind`}
                      value={r.kind}
                      save={field("roles", key, "kind")}
                      canEdit={canEdit}
                      options={[
                        { value: "client_facing", label: "Client-facing" },
                        { value: "shared", label: "Shared team" },
                      ]}
                    />
                  </TableCell>
                  <TableCell>
                    <NumberCell label={`${r.name}: line (busy %)`} value={r.line} save={field("roles", key, "line")} canEdit={canEdit} optional={false} scale={100} min={1} max={150} step={5} digits={0} provenance={r.provenance} column="line" />
                  </TableCell>
                  <TableCell>
                    {r.kind === "client_facing" ? (
                      <NumberCell label={`${r.name}: max-clients rule`} value={r.rule_of_thumb} save={field("roles", key, "rule_of_thumb")} canEdit={canEdit} min={1} step={1} digits={0} provenance={r.provenance} column="rule_of_thumb" />
                    ) : (
                      <span className="block text-right text-fg-3">–</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.kind === "shared" ? (
                      <div className="flex flex-col">
                        <TextCell label={`${r.name}: unit of work`} value={r.unit} save={field("roles", key, "unit")} canEdit={canEdit} optional />
                        <Marks provenance={r.provenance} column="unit" missing={noUnit.has(r.id)} value={r.unit} />
                      </div>
                    ) : (
                      <span className="text-fg-3">–</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button type="button" variant="link" size="xs" className="px-0" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? "Less" : "More"}
                    </Button>
                  </TableCell>
                </TableRow>
                {open === r.id && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-panel-2">
                      <RoleMore role={r} usage={usage} canEdit={canEdit} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

function SharedTeams({ setup }: { setup: CapacitySetup }) {
  const shared = setup.roles.filter((r) => r.kind === "shared" && r.active);
  return (
    <SettingsSection id="shared-teams" title="How the shared teams work" description="They own no clients. Each works in its own unit, and a rate for each unit will turn client demand into hours.">
      <Table>
        <TableHeader>
          <TableRow>
            <HeadHelp align="left" help={{ label: "Team", description: "A shared team: it works for many clients and owns none.", example: "Content team." }}>
              Team
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Unit of work", description: "What the team counts its work in. Set it in the Roles table above.", example: "Words, links, ticket hours, tasks, set-ups and incidents." }}>
              Unit of work
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Rates", description: "How fast the team works in its unit, which turns demand into hours. Not entered yet.", example: "Writing: 500 words an hour." }}>
              Rates
            </HeadHelp>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shared.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-fg-2">
                No shared teams yet. Set a role&apos;s kind to Shared team above.
              </TableCell>
            </TableRow>
          )}
          {shared.map((r) => (
            <TableRow key={r.id} data-shared-role={r.name}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.unit ?? <span className="text-fg-3">Unit not entered yet</span>}</TableCell>
              <TableCell>
                <span className="text-fg-2" data-rate-missing>
                  Rate not entered yet
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Note>To discuss: the full list of shared roles and their units (writers, editors, outreach, tech, specialists, tracking, anyone else).</Note>
    </SettingsSection>
  );
}

function PeopleTable({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = setup.canEdit;
  const showSalary = !setup.payHidden;
  const missing = missingForCapacity(setup, { salariesVisible: showSalary });
  const noSalary = new Set(missing.filter((m) => m.kind === "person_salary").map((m) => m.id));
  const noClients = new Set(missing.filter((m) => m.kind === "client_facing_portfolio").map((m) => m.id));
  const hoursPerWeek = data.workspace.settings.hours_per_week;
  const cols = 8 + setup.tiers.length + (showSalary ? 1 : 0);
  const detail = new Map(data.people.map((p) => [p.id, p]));
  const people = [...setup.people].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <SettingsSection
      id="people"
      title="People"
      description={showSalary ? "Salary counts toward DLER, directors and managers included. Contractors don't." : "Your record. Agency admins see the whole team."}
    >
      {canEdit && <AddPerson data={data} />}
      <Table>
        <TableHeader>
          <TableRow>
            <HeadHelp align="left" help={{ label: "Person", description: "A member of the team. Modelled for capacity, not performance.", example: "Laura." }}>
              Person
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Role", description: "The kinds of work they do (change them under More).", example: "SEO Director." }}>
              Role
            </HeadHelp>
            <HeadHelp help={{ label: "Hours a week", description: "The hours they can work in a week. Blank: working time times the workspace week.", example: "38 for a full week." }}>
              Hours a week
            </HeadHelp>
            <HeadHelp help={{ label: "Team time", description: "The share of their hours kept for leading, mentoring and reviews. The rest is available for client work.", example: "Laura 35%: about 13 of her 38 hours go on leading the team." }}>
              Team time %
            </HeadHelp>
            {showSalary && (
              <HeadHelp help={{ label: "Salary a month", description: "What they cost each month. DLER (direct labour expense ratio) counts salaries, directors and managers included; contractors are not counted.", example: "SEO Manager: 7,500 a month." }}>
                Salary a month
              </HeadHelp>
            )}
            <HeadHelp align="left" help={{ label: "Serves tiers", description: "The tiers this person can look after. New clients are placed with someone who serves the tier. Nothing ticked: every tier.", example: "Karl serves T1, T2 and T3; Khaselyn only T3." }}>
              Serves tiers
            </HeadHelp>
            {setup.tiers.map((t) => (
              <HeadHelp key={t.id} help={{ label: `${t.key} clients`, description: `How many ${t.key} clients this person looks after, counted (named clients are listed separately).`, example: "Nadiya: 6 clients on T2." }}>
                {t.key}
              </HeadHelp>
            ))}
            <HeadHelp align="left" help={{ label: "Named clients", description: "Named clients this person looks after, from the Tiers & clients page. Read only.", example: "Laura: Harbourline Group, Meridian Finance." }}>
              Named
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "Label", description: "Contractor or offshore. Contractors aren't in DLER; offshore people are labelled in reports.", example: "Tonie: offshore." }}>
              Label
            </HeadHelp>
            <HeadHelp align="left" help={{ label: "More", description: "Email, dates, roles, skills, leave, ramp-up and per-person times.", example: "Add leave for a holiday." }}>
              More
            </HeadHelp>
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.length === 0 && (
            <TableRow>
              <TableCell colSpan={cols} className="text-fg-2">
                No people yet. Until you add some, each role&apos;s head-count is used instead.
              </TableCell>
            </TableRow>
          )}
          {people.map((p) => (
            <Fragment key={p.id}>
              <PersonLine setup={setup} person={p} showSalary={showSalary} noSalary={noSalary.has(p.id)} noClients={noClients.has(p.id)} placeholderHours={hoursPerWeek * p.fte} onMore={() => setOpen(open === p.id ? null : p.id)} open={open === p.id} />
              {open === p.id && detail.get(p.id) && (
                <TableRow>
                  <TableCell colSpan={cols} className="bg-panel-2">
                    <PersonMore person={detail.get(p.id)!} data={data} />
                    <Ramp setup={setup} person={p} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
      <Note>
        Also on each person, under More: email, start and end dates, leave, skills (steps they can do), per-person times, overtime cap. Ramp-up for new starters (90 days to about 80%) and the offshore / contractor label are here. Roles marked as leadership (under More) aren&apos;t in clients or revenue per employee.
      </Note>
    </SettingsSection>
  );
}

function PersonLine({
  setup,
  person: p,
  showSalary,
  noSalary,
  noClients,
  placeholderHours,
  onMore,
  open,
}: {
  setup: CapacitySetup;
  person: SetupPerson;
  showSalary: boolean;
  noSalary: boolean;
  noClients: boolean;
  placeholderHours: number;
  onMore: () => void;
  open: boolean;
}) {
  const canEdit = setup.canEdit;
  const key = { id: p.id };
  const roles = p.role_ids.map((id) => setup.roles.find((r) => r.id === id)).filter((r): r is SetupRole => !!r);
  const facing = roles.filter((r) => r.kind === "client_facing" && r.active);
  const isFacing = facing.length > 0;
  const departmentId = facing.find((r) => r.department_id)?.department_id ?? null;
  const named = setup.clients.filter((c) => c.active && Object.values(c.assignments).includes(p.id)).map((c) => c.name);
  return (
    <TableRow data-person={p.name}>
      <TableCell className="min-w-36">
        <TextCell label={`${p.name}: name`} value={p.name} save={(base, next) => savePersonField(p.id, "name", base, next) as Promise<SaveOutcome<string | null>>} canEdit={canEdit} />
        {!p.active && <span className="text-xs text-fg-3">Inactive</span>}
        {noClients && <span data-missing className="block text-2xs font-medium text-warn">missing: no clients in their portfolio</span>}
      </TableCell>
      <TableCell className="text-sm">{roles.map((r) => r.name).join(", ") || <span className="text-fg-3">No role</span>}</TableCell>
      <TableCell>
        <NumberCell label={`${p.name}: hours a week`} value={p.capacity_hours_week} save={field("people", key, "capacity_hours_week")} canEdit={canEdit} min={0.5} max={168} step={0.5} placeholder={String(Math.round(placeholderHours * 10) / 10)} provenance={p.provenance} column="capacity_hours_week" />
      </TableCell>
      <TableCell>
        <NumberCell label={`${p.name}: team time %`} value={p.reserved_share} save={field("people", key, "reserved_share")} canEdit={canEdit} optional={false} scale={100} min={0} max={90} step={5} digits={0} provenance={p.provenance} column="reserved_share" />
      </TableCell>
      {showSalary && (
        <TableCell>
          <NumberCell label={`${p.name}: salary a month`} value={p.salary_monthly} save={field("people", key, "salary_monthly")} canEdit={canEdit} min={0} step={100} digits={0} provenance={p.provenance} column="salary_monthly" missing={noSalary} />
        </TableCell>
      )}
      <TableCell>
        {isFacing ? (
          <TierBoxes setup={setup} person={p} />
        ) : (
          <span className="text-xs text-fg-3">–</span>
        )}
      </TableCell>
      {setup.tiers.map((t) => {
        const svc = isFacing && departmentId ? setup.services.find((s) => s.department_id === departmentId && s.tier_id === t.id && s.active) : undefined;
        const row = svc ? setup.portfolio.find((r) => r.person_id === p.id && r.service_id === svc.id) : undefined;
        return (
          <TableCell key={t.id}>
            {svc ? (
              <NumberCell
                label={`${p.name}: ${t.key} clients`}
                value={row?.client_count ?? 0}
                save={(base, next) => savePortfolioCount(setup.workspaceId, p.id, svc.id, base ?? 0, next ?? 0) as Promise<SaveOutcome<number | null>>}
                canEdit={canEdit}
                optional={false}
                min={0}
                step={1}
                digits={0}
                provenance={row?.provenance}
                column="client_count"
              />
            ) : (
              <span className="block text-right text-fg-3">{isFacing ? "no service" : ""}</span>
            )}
          </TableCell>
        );
      })}
      <TableCell className="min-w-32 text-xs">{named.join(", ")}</TableCell>
      <TableCell>
        <SelectCell
          label={`${p.name}: label`}
          value={p.label}
          save={field("people", key, "label")}
          canEdit={canEdit}
          noneLabel="None"
          options={[
            { value: "contractor", label: "Contractor" },
            { value: "offshore", label: "Offshore" },
          ]}
        />
      </TableCell>
      <TableCell>
        <Button type="button" variant="link" size="xs" className="px-0" aria-expanded={open} onClick={onMore}>
          {open ? "Less" : "More"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** The tiers a person serves, as checkboxes (a Viewer sees the keys as text). */
function TierBoxes({ setup, person: p }: { setup: CapacitySetup; person: SetupPerson }) {
  const [ids, setIds] = useState<string[]>(p.tier_ids);
  const [error, setError] = useState<string>();
  if (!setup.canEdit) return <span>{setup.tiers.filter((t) => ids.includes(t.id)).map((t) => t.key).join(" ") || "All"}</span>;
  return (
    <div className="flex flex-wrap gap-x-2">
      {setup.tiers.map((t) => (
        <label key={t.id} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            aria-label={`${p.name}: serves ${t.key}`}
            className="size-4 accent-[var(--accent)]"
            checked={ids.includes(t.id)}
            onChange={async (e) => {
              const next = e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id);
              const out = await savePersonTiers(p.id, setup.workspaceId, ids, next);
              if (out.status === "saved") {
                setIds(out.value);
                setError(undefined);
              } else if (out.status === "conflict") {
                setIds([...out.theirs]);
                setError("Someone else changed this. Showing theirs.");
              } else setError(out.status === "error" ? out.message : "Couldn't save.");
            }}
          />
          {t.key}
        </label>
      ))}
      {error && (
        <span role="alert" className="w-full text-xs text-crit">
          {error}
        </span>
      )}
    </div>
  );
}

/** A person's own ramp-up (percent of full capacity in each month from their start date); blank uses the workspace default. */
function Ramp({ setup, person: p }: { setup: CapacitySetup; person: SetupPerson }) {
  const label = sourceLabel(p.provenance, "ramp");
  return (
    <div className="mt-3 max-w-md">
      <TextField
        label="Ramp-up for a new starter"
        value={formatRamp(p.ramp)}
        optional
        disabled={!setup.canEdit}
        save={(base, next) => savePersonRamp(p.id, base, next)}
        hint={`Percent of full capacity in each month from their start date, then full. Blank: the workspace default (${formatRamp(setup.rampDefault)}).${label ? ` ${label}.` : ""}`}
        help={{ description: "How quickly a new starter reaches full capacity, as the share of their hours that count in each month from their start date. After the last month they count in full.", example: "40, 60, 80: 40% in month 1, 60% in month 2, 80% in month 3, then 100%." }}
      />
    </div>
  );
}

function WorkspaceDefaults({ setup }: { setup: CapacitySetup }) {
  return (
    <SettingsSection id="defaults" title="Ramp-up and DLER" description="Two workspace-wide choices that the capacity figures use.">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Ramp-up default for new starters"
          value={formatRamp(setup.rampDefault)}
          disabled={!setup.canEdit}
          optional
          save={(base, next) => saveRampDefault(setup.workspaceId, base, next)}
          hint="Percent of full capacity in each month from the start date, then full. Blank: 40, 60, 80 (about 90 days to 80%)."
          help={{ description: "How quickly a new starter reaches full capacity, as the share of their hours that count in each month. A person's own ramp replaces this.", example: "40, 60, 80: 40% in month 1, 60% in month 2, 80% in month 3, then 100%." }}
        />
        <div className="flex flex-col gap-1">
          <ToggleField
            label="DLER includes leadership"
            value={setup.dlerIncludesLeadership}
            disabled={!setup.canEdit}
            save={(base, next) => saveDlerIncludesLeadership(setup.workspaceId, base, next)}
            onLabel="On: leadership's salaries are in DLER"
            offLabel="Off: leadership's salaries are left out of DLER"
            help={{ description: "Whether DLER (direct labour expense ratio) counts leadership's salaries: the Founder, Head of Client Services and Growth Strategy Lead.", example: "Off: DLER only counts the people who do client work." }}
          />
          <span data-to-confirm className="w-fit rounded-lg border border-warn bg-warn-soft px-1.5 text-xs">
            To confirm with the client
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}

