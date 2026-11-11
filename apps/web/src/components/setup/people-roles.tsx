"use client";

// Set up, People & roles (capacity build P1; redesigned in Q14). Every person is one standard row (the same columns for everyone: name, role,
// department, hours a week, team time, salary, label), every role is one standard row, and a click opens a side panel with all the fields
// of that person or role. Nothing sideways: a row never grows past its card, and on a phone it shrinks to name, role and a chevron.
// A Viewer sees the same rows and panels as text; whoever can't see pay (`payHidden`) doesn't get the salary column or field at all.
// Per-person times (how fast one person is) stay under "More" in the panel, never in a column: they are never ranked or compared.

import { ChevronRight, Users } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { missingForCapacity, tierDiscrepancies, type CapacitySetup, type SetupPerson, type SetupRole } from "@transpera-flow/db";
import { ClearFilters, EmptyState, FilterMenu, Toolbar, ToolbarSearch } from "@/components/page-kit";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import { AddRole, RoleMore } from "@/app/w/[slug]/settings/roles-settings";
import { AddPerson, PersonMore } from "@/app/w/[slug]/settings/people-settings";
import { saveRoleField } from "@/app/w/[slug]/settings/actions";
import { savePersonTiers, savePortfolioCount, saveSetupField } from "@/app/w/[slug]/settings/setup-actions";
import { NumberField, SelectField, TextField, type FieldHelp } from "@/components/fields";
import { Help } from "@/components/help";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { WorkspaceSettingsData } from "@/lib/data";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { formatWholeCurrency } from "@/lib/format";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { DiscrepancyPill, Marks, Note } from "./cells";

type Scalar = string | number | boolean | null;

const field =
  <T extends Scalar>(table: Parameters<typeof saveSetupField>[0], key: Record<string, string>, name: string): Saver<T> =>
  (base, next) =>
    saveSetupField(table, key, name, base, next) as Promise<SaveOutcome<T>>;

/** Opening a panel or dialog lands focus on it, not on the first (i) inside (Escape would then close only that tip). */
const focusPanel = (e: Event) => {
  e.preventDefault();
  (e.currentTarget as HTMLElement).focus();
};


/** The words of the page header's meta line ("27 people · 10 roles"). */

// What each column / field is, in plain words (the (i) beside a column heading and beside the same field in the panel).
const HELP = {
  person: { label: "Person", description: "A member of the team. Modelled for capacity, not performance.", example: "Laura." },
  role: { label: "Role", description: "The kinds of work they do (change them in their panel).", example: "SEO Director." },
  department: { label: "Department", description: "The service line their role works in. It is read from the role, so change the role to change it.", example: "SEO Director: Organic (SEO)." },
  hours: { label: "Hours a week", description: "The hours they can work in a week. Blank: working time times the workspace week.", example: "38 for a full week." },
  teamTime: { label: "Team time", description: "The share of their hours kept for leading, mentoring and reviews. The rest is available for client work.", example: "Laura 35%: about 13 of her 38 hours go on leading the team." },
  salary: { label: "Salary a month", description: "What they cost each month. DLER (direct labour expense ratio) counts salaries; directors, managers and contractors are not counted.", example: "SEO Manager: 7,500 a month." },
  label: { label: "Label", description: "Contractor or offshore. Contractors aren't in DLER; offshore people are labelled in reports.", example: "Tonie: offshore." },
  servesTiers: { label: "Serves tiers", description: "The tiers this person can look after. New clients are placed with someone who serves the tier. Nothing ticked: every tier.", example: "Karl serves T1, T2 and T3; Khaselyn only T3." },
  named: { label: "Named clients", description: "Named clients this person looks after, from the Tiers & clients page. Read only.", example: "Laura: Harbourline Group, Meridian Finance." },
  roleName: { label: "Role", description: "A kind of work. A step that needs a role can be done by anyone who has it.", example: "SEO Director." },
  kind: { label: "Kind", description: "Client-facing roles own clients in a portfolio. Shared teams own none: they work in their own unit, and client demand turns into their hours.", example: "SEO Manager is client-facing; the Content team is a shared team." },
  line: { label: "Utilisation threshold %", description: "The utilisation threshold is how busy this role can be before it counts as full. Past it, more clients won't fit.", example: "85%: a person booked at 85% of their hours is at their utilisation threshold." },
  rule: { label: "Rule of thumb", description: "A rule of thumb: the most clients one person in this role holds. Shown as a line to compare the real counts against.", example: "SEO Manager: 10 clients." },
  unit: { label: "Unit of work", description: "What a shared team counts its work in. Rates for each unit come later.", example: "Content team: words. Link outreach: links." },
  headcount: { label: "People", description: "How many people have this role.", example: "SEO Manager: 3." },
} satisfies Record<string, FieldHelp & { label: string }>;

export function PeopleAndRoles({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-setup="people">
      <PeopleList setup={setup} data={data} />
      <RolesList setup={setup} data={data} />
      <SharedTeams setup={setup} />
    </div>
  );
}

/**
 * Formerly the page header's "+ Add person" and "+ Add role". They now sit with their lists (the people toolbar, the Roles section's
 * title), so this draws nothing; it stays for the screenshot harnesses that still pass it as the header's actions.
 * @deprecated
 */
export function PeopleHeaderActions(props: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  void props;
  return null;
}

/** "+ Add person": a small dialog with the form. Nothing for a reader, or on a phone. */
function AddPersonButton({ data }: { data: WorkspaceSettingsData }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className={EDIT_ONLY} data-edit-entry data-add-person>
          + Add person
        </Button>
      </DialogTrigger>
      <DialogContent onOpenAutoFocus={focusPanel}>
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>Their name and, if you know it, their role. Everything else is in their panel.</DialogDescription>
        </DialogHeader>
        <AddPerson data={data} className="items-end" onAdded={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** "+ Add role": a small dialog with the form, at the right of the Roles title. */
function AddRoleButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className={EDIT_ONLY} data-edit-entry data-add-role>
          + Add role
        </Button>
      </DialogTrigger>
      <DialogContent onOpenAutoFocus={focusPanel}>
        <DialogHeader>
          <DialogTitle>Add a role</DialogTitle>
          <DialogDescription>A kind of work. Its kind, department and utilisation threshold are in its panel.</DialogDescription>
        </DialogHeader>
        <AddRole workspaceId={workspaceId} className="items-end" onAdded={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

// ---- Rows ------------------------------------------------------------------------------------------------------------------------------

/** A column heading with its (i): the name first (a test reads it as `th > span:first-child`). */
function ColHead({ children, help, className }: { children: ReactNode; help: FieldHelp & { label: string }; className?: string }) {
  return (
    <TableHead className={cn("px-3", className)}>
      <span>{children}</span>
      <Help label={help.label} description={help.description} example={help.example} />
    </TableHead>
  );
}

/**
 * The list's surface: one bordered table, no card inside the card. A table too wide for a narrow window scrolls inside it, never the
 * page; the overflow is also set inline so that holds without the stylesheet (the browser tests' harness has none).
 */
const SURFACE = "overflow-x-auto rounded-lg border border-line [&_[data-slot=table-header]]:bg-panel-2";
const SURFACE_STYLE = { overflowX: "auto" } as const;
const CELL = "px-3 py-2.5";

/**
 * A row that opens its panel: a click anywhere on it, or its name (a real button, for the keyboard and a screen reader, named
 * "Open <name>"). The People and Roles lists are not wrapped in the phone's read-only fieldset, so a reader on a phone can open it.
 */
function OpenRow({ onOpen, label, name, sub, children, ...rest }: { onOpen: () => void; label: string; name: string; sub?: ReactNode; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <TableRow className="cursor-pointer border-line hover:bg-panel-2" onClick={onOpen} {...rest}>
      <TableCell className={CELL}>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={label}
          className="block max-w-full text-left text-sm font-semibold break-words outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {name}
        </button>
        {sub}
      </TableCell>
      {children}
      <TableCell className={cn(CELL, "w-8")}>
        <ChevronRight aria-hidden className="size-4 text-fg-3" />
      </TableCell>
    </TableRow>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-fg-3">{children}</span>;

function departmentIdOf(roles: SetupRole[]): string | null {
  const facing = roles.filter((r) => r.kind === "client_facing" && r.active);
  return (facing.find((r) => r.department_id) ?? roles.find((r) => r.department_id))?.department_id ?? null;
}

function rolesOf(setup: CapacitySetup, p: SetupPerson): SetupRole[] {
  return p.role_ids.map((id) => setup.roles.find((r) => r.id === id)).filter((r): r is SetupRole => !!r);
}

// ---- People ----------------------------------------------------------------------------------------------------------------------------

function PeopleList({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const showSalary = !setup.payHidden;
  const missing = missingForCapacity(setup, { salariesVisible: showSalary });
  const noSalary = new Set(missing.filter((m) => m.kind === "person_salary").map((m) => m.id));
  const noClients = new Set(missing.filter((m) => m.kind === "client_facing_portfolio").map((m) => m.id));
  const hoursPerWeek = data.workspace.settings.hours_per_week;
  const dept = new Map(setup.departments.map((d) => [d.id, d.name]));
  const all = [...setup.people].sort((a, b) => Number(b.active) - Number(a.active));
  const info = new Map(all.map((p) => [p.id, { roles: rolesOf(setup, p), dept: departmentIdOf(rolesOf(setup, p)) }]));
  const q = search.trim().toLowerCase();
  const shown = all.filter((p) => {
    const i = info.get(p.id)!;
    if (q && !`${p.name} ${p.email ?? ""} ${i.roles.map((r) => r.name).join(" ")}`.toLowerCase().includes(q)) return false;
    if (roleIds.length && !p.role_ids.some((r) => roleIds.includes(r))) return false;
    if (deptIds.length && !(i.dept && deptIds.includes(i.dept))) return false;
    return true;
  });
  const filtered = !!q || roleIds.length > 0 || deptIds.length > 0;
  const roleOptions = setup.roles.map((r) => ({ value: r.id, label: r.name, count: all.filter((p) => p.role_ids.includes(r.id)).length }));
  const deptOptions = setup.departments.map((d) => ({ value: d.id, label: d.name, count: all.filter((p) => info.get(p.id)!.dept === d.id).length }));
  const person = open ? all.find((p) => p.id === open) : undefined;

  return (
    <SettingsSection
      id="people"
      title="People"
      phoneWrap={false}
      description={showSalary ? "Salary counts toward DLER. Directors, managers and contractors don't count. Click a person for everything about them." : "Your record. Agency admins see the whole team."}
    >
      {all.length > 0 && setup.tiers.length > 0 && <PortfolioTotals setup={setup} />}
      {(all.length > 0 || setup.canEdit) && (
        <Toolbar label="Filter the people">
          {all.length > 0 && (
            <>
              <ToolbarSearch value={search} onChange={setSearch} label="Search people" placeholder="Search people" />
              <FilterMenu name="Role" options={roleOptions} selected={roleIds} onChange={setRoleIds} />
              <FilterMenu name="Department" options={deptOptions} selected={deptIds} onChange={setDeptIds} />
              {filtered && (
                <ClearFilters
                  onClick={() => {
                    setSearch("");
                    setRoleIds([]);
                    setDeptIds([]);
                  }}
                />
              )}
            </>
          )}
          {setup.canEdit && (
            <span className="ml-auto">
              <AddPersonButton data={data} />
            </span>
          )}
        </Toolbar>
      )}
      {all.length === 0 ? (
        <EmptyState icon={Users} data-empty="people">
          No people yet. Until you add some, each role&apos;s head-count is used instead.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState data-empty="no-match">No one matches. Clear the filters to see everyone.</EmptyState>
      ) : (
        <div className={SURFACE} style={SURFACE_STYLE} data-people-list>
          {/* A phone: name, role, chevron. A tablet drops the department and the label; a desktop shows every column. */}
          <Table>
            <TableHeader>
              <TableRow className="border-line hover:bg-transparent">
                <ColHead help={HELP.person}>Person</ColHead>
                <ColHead help={HELP.role}>Role</ColHead>
                <ColHead help={HELP.department} className="max-xl:hidden">
                  Department
                </ColHead>
                <ColHead help={HELP.hours} className="text-right max-sm:hidden">
                  Hours a week
                </ColHead>
                <ColHead help={HELP.teamTime} className="text-right max-sm:hidden">
                  Team time
                </ColHead>
                {showSalary && (
                  <ColHead help={HELP.salary} className="text-right max-sm:hidden">
                    Salary a month
                  </ColHead>
                )}
                <ColHead help={HELP.label} className="max-xl:hidden">
                  Label
                </ColHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => {
                const i = info.get(p.id)!;
                const placeholderHours = hoursPerWeek * p.fte;
                const sub = [!p.active && "Inactive", p.email].filter(Boolean).join(" · ");
                return (
                  <OpenRow
                    key={p.id}
                    onOpen={() => setOpen(p.id)}
                    label={`Open ${p.name}`}
                    name={p.name}
                    data-person={p.name}
                    data-active={String(p.active)}
                    sub={
                      <>
                        {sub && <span className="block truncate text-xs text-fg-2">{sub}</span>}
                        {noClients.has(p.id) && (
                          <span data-missing className="block text-2xs font-medium text-warn">
                            missing: no clients in their portfolio
                          </span>
                        )}
                      </>
                    }
                  >
                    <TableCell className={cn(CELL, "whitespace-normal")}>{i.roles.map((r) => r.name).join(", ") || <Muted>No role</Muted>}</TableCell>
                    <TableCell className={cn(CELL, "max-xl:hidden")} data-cell="department">
                      {i.dept ? (dept.get(i.dept) ?? <Muted>A removed department</Muted>) : <Muted>–</Muted>}
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums max-sm:hidden")} data-cell="hours">
                      {p.capacity_hours_week !== null ? p.capacity_hours_week : <Muted>{Math.round(placeholderHours * 10) / 10}</Muted>}
                    </TableCell>
                    <TableCell className={cn(CELL, "text-right tabular-nums max-sm:hidden")} data-cell="team-time">
                      {Math.round(p.reserved_share * 100)}%
                    </TableCell>
                    {showSalary && (
                      <TableCell className={cn(CELL, "text-right tabular-nums max-sm:hidden")} data-cell="salary">
                        {p.salary_monthly !== null ? formatWholeCurrency(p.salary_monthly, setup.currency) : noSalary.has(p.id) ? <span data-missing className="text-xs font-medium text-warn">missing</span> : <Muted>–</Muted>}
                      </TableCell>
                    )}
                    <TableCell className={cn(CELL, "max-xl:hidden")} data-cell="label">
                      {p.label ? (p.label === "contractor" ? "Contractor" : "Offshore") : <Muted>–</Muted>}
                    </TableCell>
                  </OpenRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <Panel open={!!person} onClose={() => setOpen(null)} testId="person-panel">
        {person && <PersonPanel key={person.id} setup={setup} data={data} person={person} showSalary={showSalary} noSalary={noSalary.has(person.id)} noClients={noClients.has(person.id)} placeholderHours={hoursPerWeek * person.fte} />}
      </Panel>
    </SettingsSection>
  );
}

/**
 * The total of each tier's portfolios, with the tier's discrepancy pill beside it (Q13): only for a tier service whose total is typed in.
 * One compact line above the list. A pill names its department in the tooltip, because a tier spans both departments.
 */
function PortfolioTotals({ setup }: { setup: CapacitySetup }) {
  const discrepancies = tierDiscrepancies(setup);
  const deptName = new Map(setup.departments.map((d) => [d.id, d.name]));
  return (
    <div data-portfolio-totals className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
      <span className="text-xs font-medium text-fg-2">Clients in portfolios, by tier</span>
      {setup.tiers.map((t) => {
        const ids = new Set(setup.services.filter((s) => s.tier_id === t.id && s.active).map((s) => s.id));
        const total = setup.portfolio.filter((r) => ids.has(r.service_id)).reduce((sum, r) => sum + r.client_count, 0);
        return (
          <span key={t.id} className="flex items-center gap-1.5 tabular-nums" data-portfolio-total={t.key}>
            {t.key} <b>{total}</b>
            {discrepancies
              .filter((d) => d.tierId === t.id)
              .map((d) => (
                <DiscrepancyPill key={d.serviceId} discrepancy={d} prefix={deptName.get(d.departmentId)} />
              ))}
          </span>
        );
      })}
    </div>
  );
}

/** The side sheet (a full screen on a phone) both panels sit in. Everything inside is read only on a phone. */
function Panel({ open, onClose, testId, children }: { open: boolean; onClose: () => void; testId: string; children: ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl" aria-describedby={undefined} data-panel={testId} onOpenAutoFocus={focusPanel}>
        <PhoneReadOnly notice={false}>{children}</PhoneReadOnly>
      </SheetContent>
    </Sheet>
  );
}

function PanelHead({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <SheetHeader className="border-b border-line p-4 pr-12">
      <SheetTitle className="font-display text-lg font-bold">{title}</SheetTitle>
      <SheetDescription asChild>
        <div>{subtitle}</div>
      </SheetDescription>
    </SheetHeader>
  );
}

function Group({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section data-panel-group={id} aria-labelledby={`panel-${id}`} className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <h3 id={`panel-${id}`} className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
        {title}
      </h3>
      {note && <p className="text-xs text-fg-2">{note}</p>}
      {children}
    </section>
  );
}

function ReadOnlyValue({ label, help, children, ...rest }: { label: string; help?: FieldHelp; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex flex-col gap-1" {...rest}>
      <span className="flex items-center text-xs font-medium text-fg-2">
        {label}
        {help && <Help label={label} {...help} />}
      </span>
      <span className="py-1.5 text-sm">{children}</span>
    </div>
  );
}

function PersonPanel({
  setup,
  data,
  person: p,
  showSalary,
  noSalary,
  noClients,
  placeholderHours,
}: {
  setup: CapacitySetup;
  data: WorkspaceSettingsData;
  person: SetupPerson;
  showSalary: boolean;
  noSalary: boolean;
  noClients: boolean;
  placeholderHours: number;
}) {
  const canEdit = setup.canEdit;
  const key = { id: p.id };
  const roles = rolesOf(setup, p);
  const isFacing = roles.some((r) => r.kind === "client_facing" && r.active);
  const deptId = departmentIdOf(roles);
  const deptName = setup.departments.find((d) => d.id === deptId)?.name;
  const detail = data.people.find((x) => x.id === p.id);
  const named = setup.clients.filter((c) => c.active && Object.values(c.assignments).includes(p.id));
  const facingDeptId = roles.filter((r) => r.kind === "client_facing" && r.active).find((r) => r.department_id)?.department_id ?? null;

  return (
    <div data-person-panel={p.name}>
      <PanelHead
        title={p.name}
        subtitle={[roles.map((r) => r.name).join(", ") || "No role", deptName, !p.active && "Inactive"].filter(Boolean).join(" · ")}
      />
      <Group id="basics" title="Basics">
        {detail && <PersonMore person={detail} data={data} part="basics" compact />}
        <div className="grid gap-4 sm:grid-cols-2">
          <ReadOnlyValue label="Department" help={HELP.department} data-field="department">
            {deptName ?? <Muted>–</Muted>}
          </ReadOnlyValue>
          <div className="flex flex-col">
            <NumberField label="Hours a week" value={p.capacity_hours_week} save={field("people", key, "capacity_hours_week")} optional min={0.5} max={168} step={0.5} placeholder={String(Math.round(placeholderHours * 10) / 10)} disabled={!canEdit} help={HELP.hours} />
            <Marks provenance={p.provenance} column="capacity_hours_week" value={p.capacity_hours_week} />
          </div>
          <div className="flex flex-col">
            <NumberField label="Team time %" value={p.reserved_share} save={field("people", key, "reserved_share")} scale={100} min={0} max={90} step={5} disabled={!canEdit} help={HELP.teamTime} />
            <Marks provenance={p.provenance} column="reserved_share" value={p.reserved_share} />
          </div>
          {showSalary && (
            <div className="flex flex-col">
              <NumberField label="Salary a month" value={p.salary_monthly} save={field("people", key, "salary_monthly")} optional min={0} step={100} disabled={!canEdit} help={HELP.salary} />
              <Marks provenance={p.provenance} column="salary_monthly" value={p.salary_monthly} missing={noSalary && p.salary_monthly === null} />
            </div>
          )}
          <SelectField
            label="Label"
            value={p.label}
            save={field("people", key, "label")}
            disabled={!canEdit}
            noneLabel="None"
            help={HELP.label}
            options={[
              { value: "contractor", label: "Contractor" },
              { value: "offshore", label: "Offshore" },
            ]}
          />
        </div>
      </Group>

      {isFacing && (
        <Group id="clients" title="Clients" note="Only people in client-facing roles look after clients.">
          {noClients && (
            <p data-missing className="text-xs font-medium text-warn">
              missing: no clients in their portfolio
            </p>
          )}
          <TierBoxes setup={setup} person={p} />
          <div className="grid gap-4 sm:grid-cols-3" data-portfolio>
            {setup.tiers.map((t) => {
              const svc = facingDeptId ? setup.services.find((s) => s.department_id === facingDeptId && s.tier_id === t.id && s.active) : undefined;
              const row = svc ? setup.portfolio.find((r) => r.person_id === p.id && r.service_id === svc.id) : undefined;
              return svc ? (
                <div key={t.id} className="flex flex-col">
                  <NumberField
                    label={`${t.key} clients`}
                    value={row?.client_count ?? 0}
                    save={(base, next) => savePortfolioCount(setup.workspaceId, p.id, svc.id, base ?? 0, next ?? 0) as Promise<SaveOutcome<number | null>>}
                    min={0}
                    step={1}
                    disabled={!canEdit}
                    help={{ description: `How many ${t.key} clients this person looks after, counted (named clients are listed below).`, example: "Nadiya: 6 clients on T2." }}
                  />
                  <Marks provenance={row?.provenance} column="client_count" value={row ? row.client_count : null} />
                </div>
              ) : (
                <ReadOnlyValue key={t.id} label={`${t.key} clients`}>
                  <Muted>No service</Muted>
                </ReadOnlyValue>
              );
            })}
          </div>
          <div className="flex flex-col gap-1" data-named-clients>
            <span className="flex items-center text-xs font-medium text-fg-2">
              Named clients
              <Help label={HELP.named.label} description={HELP.named.description} example={HELP.named.example} />
            </span>
            {named.length === 0 ? (
              <span className="text-sm text-fg-3">None named. Name clients on Tiers &amp; clients.</span>
            ) : (
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {named.map((c) => (
                  <li key={c.id}>
                    <Link href={`/w/${data.workspace.slug}/settings#tiers-clients`} className="text-accent hover:underline">
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Group>
      )}

      <Group id="time" title="Time">
        {detail && <PersonMore person={detail} data={data} part="time" compact />}
      </Group>

      <Group id="more" title="More">
        {detail ? <PersonMore person={detail} data={data} part="more" compact /> : <p className="text-sm text-fg-3">Nothing more to show.</p>}
      </Group>
    </div>
  );
}

/** The tiers a person serves, as checkboxes (a Viewer sees them greyed). */
function TierBoxes({ setup, person: p }: { setup: CapacitySetup; person: SetupPerson }) {
  const [ids, setIds] = useState<string[]>(p.tier_ids);
  const [error, setError] = useState<string>();
  return (
    <fieldset className="flex flex-col gap-1" data-serves-tiers>
      <legend className="mb-1 flex items-center text-xs font-medium text-fg-2">
        Serves tiers
        <Help label={HELP.servesTiers.label} description={HELP.servesTiers.description} example={HELP.servesTiers.example} />
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {setup.tiers.map((t) => (
          <label key={t.id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              aria-label={`${p.name}: serves ${t.key}`}
              className="size-4 accent-[var(--accent)]"
              disabled={!setup.canEdit}
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
      </div>
      {ids.length === 0 && <p className="text-xs text-muted-foreground">None ticked: every tier.</p>}
      {error && (
        <p role="alert" className="text-xs text-crit">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// ---- Roles -----------------------------------------------------------------------------------------------------------------------------

const KIND_WORDS = { client_facing: "Client-facing", shared: "Shared team" } as const;

function RolesList({ setup, data }: { setup: CapacitySetup; data: WorkspaceSettingsData }) {
  const [open, setOpen] = useState<string | null>(null);
  const dept = new Map(setup.departments.map((d) => [d.id, d.name]));
  const missing = missingForCapacity(setup, { salariesVisible: false });
  const noUnit = new Set(missing.filter((m) => m.kind === "shared_role_unit").map((m) => m.id));
  // The loader counts everyone with the role; fall back to the people on this page where it has no count.
  const headcount = (r: SetupRole) => data.roleUsage[r.id]?.people ?? setup.people.filter((p) => p.role_ids.includes(r.id)).length;
  const role = open ? setup.roles.find((r) => r.id === open) : undefined;
  return (
    <SettingsSection
      id="roles"
      title="Roles"
      phoneWrap={false}
      action={setup.canEdit ? <AddRoleButton workspaceId={setup.workspaceId} /> : undefined}
      description="Kinds of work. Steps, people and client assignments name roles. Click a role for the rest. A role that is in use can't be removed; make it inactive to hide it from pickers."
    >
      {setup.roles.length === 0 ? (
        <EmptyState data-empty="roles">No roles yet. Add the kinds of work your team does.</EmptyState>
      ) : (
        <div className={SURFACE} style={SURFACE_STYLE} data-roles-list>
          <Table>
            <TableHeader>
              <TableRow className="border-line hover:bg-transparent">
                <ColHead help={HELP.roleName}>Role</ColHead>
                <ColHead help={HELP.department} className="max-sm:hidden">
                  Department
                </ColHead>
                <ColHead help={HELP.kind}>Kind</ColHead>
                <ColHead help={HELP.line} className="text-right max-sm:hidden">
                  Utilisation threshold %
                </ColHead>
                <ColHead help={HELP.headcount} className="text-right max-sm:hidden">
                  People
                </ColHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {setup.roles.map((r) => (
                <OpenRow
                  key={r.id}
                  onOpen={() => setOpen(r.id)}
                  label={`Open ${r.name}`}
                  name={r.name}
                  data-role={r.name}
                  sub={
                    <>
                      {!r.active && <span className="block text-xs text-fg-3">Inactive</span>}
                      {r.kind === "shared" && noUnit.has(r.id) && (
                        <span data-missing className="block text-2xs font-medium text-warn">
                          missing: unit of work
                        </span>
                      )}
                    </>
                  }
                >
                  <TableCell className={cn(CELL, "max-sm:hidden")} data-cell="department">
                    {r.department_id ? (dept.get(r.department_id) ?? <Muted>A removed department</Muted>) : <Muted>–</Muted>}
                  </TableCell>
                  <TableCell className={CELL} data-cell="kind">
                    {KIND_WORDS[r.kind]}
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums max-sm:hidden")} data-cell="line">
                    {Math.round(r.line * 100)}%
                  </TableCell>
                  <TableCell className={cn(CELL, "text-right tabular-nums max-sm:hidden")} data-cell="people">
                    {headcount(r)}
                  </TableCell>
                </OpenRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Panel open={!!role} onClose={() => setOpen(null)} testId="role-panel">
        {role && <RolePanel key={role.id} setup={setup} data={data} role={role} missingUnit={noUnit.has(role.id)} />}
      </Panel>
    </SettingsSection>
  );
}

function RolePanel({ setup, data, role: r, missingUnit }: { setup: CapacitySetup; data: WorkspaceSettingsData; role: SetupRole; missingUnit: boolean }) {
  const canEdit = setup.canEdit;
  const key = { id: r.id };
  const usage = data.roleUsage[r.id] ?? { steps: 0, people: 0, clients: 0, services: 0 };
  const deptName = setup.departments.find((d) => d.id === r.department_id)?.name;
  return (
    <div data-role-panel={r.name}>
      <PanelHead title={r.name} subtitle={[KIND_WORDS[r.kind], deptName, !r.active && "Inactive"].filter(Boolean).join(" · ")} />
      <Group id="basics" title="Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" value={r.name} save={(base, next) => saveRoleField(r.id, "name", base, next) as Promise<SaveOutcome<string | null>>} disabled={!canEdit} help={{ description: "The kind of work, as your team says it. Steps and people name roles.", example: "Strategist" }} />
          <SelectField
            label="Department"
            value={r.department_id}
            save={field("roles", key, "department_id")}
            disabled={!canEdit}
            noneLabel="No department"
            help={HELP.department}
            options={setup.departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            label="Kind"
            value={r.kind}
            save={field("roles", key, "kind")}
            disabled={!canEdit}
            help={HELP.kind}
            options={[
              { value: "client_facing", label: "Client-facing" },
              { value: "shared", label: "Shared team" },
            ]}
          />
          <div className="flex flex-col">
            <NumberField label="Utilisation threshold %" value={r.line} save={field("roles", key, "line")} scale={100} min={1} max={150} step={5} disabled={!canEdit} help={HELP.line} />
            <Marks provenance={r.provenance} column="line" value={r.line} />
          </div>
          {r.kind === "client_facing" && (
            <div className="flex flex-col">
              <NumberField label="Rule of thumb: most clients" value={r.rule_of_thumb} save={field("roles", key, "rule_of_thumb")} optional min={1} step={1} disabled={!canEdit} help={HELP.rule} />
              <Marks provenance={r.provenance} column="rule_of_thumb" value={r.rule_of_thumb} />
            </div>
          )}
          {r.kind === "shared" && (
            <div className="flex flex-col">
              <TextField label="Unit of work" value={r.unit} save={field("roles", key, "unit")} optional disabled={!canEdit} help={HELP.unit} />
              <Marks provenance={r.provenance} column="unit" missing={missingUnit} value={r.unit} />
            </div>
          )}
        </div>
      </Group>
      <Group id="more" title="More">
        <RoleMore role={r} usage={usage} canEdit={canEdit} hideName />
      </Group>
    </div>
  );
}

// ---- Shared teams ----------------------------------------------------------------------------------------------------------

function SharedTeams({ setup }: { setup: CapacitySetup }) {
  const shared = setup.roles.filter((r) => r.kind === "shared" && r.active);
  return (
    <SettingsSection id="shared-teams" title="How the shared teams work" description="They own no clients. Each works in its own unit, and a rate for each unit will turn client demand into hours.">
      {shared.length === 0 ? (
        <EmptyState data-empty="shared">No shared teams yet. Set a role&apos;s kind to Shared team.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shared.map((r) => (
            <li key={r.id} data-shared-role={r.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <span className="font-semibold">{r.name}</span>
              <span className="text-fg-2">
                {r.unit ?? <span className="text-fg-3">Unit not entered yet</span>}
                {" · "}
                <span data-rate-missing>Rate not entered yet</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Note>To discuss: the full list of shared roles and their units (writers, editors, outreach, tech, specialists, tracking, anyone else).</Note>
    </SettingsSection>
  );
}
