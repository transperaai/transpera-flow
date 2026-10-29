"use client";

// "Where the time goes" (sandbox G, phase 4): the working time of the run on screen by what the steps achieve, for the team, a role or a person,
// as a 100% bar per month and a table of hours and shares. A Viewer sees their own row and "Everyone else", never another individual (B1).

import Link from "next/link";
import { useMemo, useState } from "react";
import type { MonthlyResult } from "@transpera-flow/engine";
import type { PurposeCategory, Viewer } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { TimeChart, TimeLegend } from "@/components/sandbox/time-chart";
import { formatNumber, formatPercent } from "@/lib/format";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import { timeView, type TimeScope } from "@/lib/sandbox/time";
import { cn } from "@/lib/utils";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

type Kind = "team" | "role" | "person";

export interface TimeByPurposeProps {
  monthly: MonthlyResult;
  months: TimelineMonth[];
  categories: readonly PurposeCategory[];
  /** Roles by id and name; people the viewer may see by name (others are "A team member" already). */
  roles: readonly { id: string; name: string }[];
  people: readonly { id: string; name: string }[];
  viewer: Viewer;
  /** "year" and so on, for the sentence under the title. */
  span: string;
  /** Settings → Purposes, for someone who may change the categories (null: they may not). */
  purposesHref?: string | null;
  /** A share link's visitor: the team and each role, never a person (what a person spends their time on is theirs). */
  noPeople?: boolean;
}

const hoursText = (h: number) => `${formatNumber(h, h < 10 ? 1 : 0)} h`;

export function TimeByPurpose({ monthly, months, categories, roles, people, viewer, span, purposesHref = null, noPeople = false }: TimeByPurposeProps) {
  const [kind, setKind] = useState<Kind>("team");
  const withWork = useMemo(() => roles.filter((r) => monthly.time.roles[r.id]?.hours.some((h) => h.mean > 0)), [roles, monthly]);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const own = viewer.seesEveryone ? null : viewer.ownPersonId;
  // A Viewer: their own row, and everyone else together. An Agency admin or the Owner: each person.
  const personOptions = useMemo(
    () => (viewer.seesEveryone ? people.map((p) => ({ value: p.id, label: p.name })) : [...(own && monthly.time.people[own] ? [{ value: own, label: "You" }] : []), { value: "others", label: "Everyone else" }]),
    [viewer.seesEveryone, people, own, monthly],
  );
  const role = roleId && withWork.some((r) => r.id === roleId) ? roleId : (withWork[0]?.id ?? null);
  const person = personKey && personOptions.some((o) => o.value === personKey) ? personKey : (personOptions[0]?.value ?? null);
  const scope: TimeScope =
    kind === "role" && role
      ? { kind: "role", id: role }
      : kind === "person" && person
        ? person === "others"
          ? own
            ? { kind: "others", except: own }
            : { kind: "team" }
          : { kind: "person", id: person }
        : { kind: "team" };
  const scopeKey = JSON.stringify(scope);
  const view = useMemo(() => timeView(monthly, months, categories, JSON.parse(scopeKey) as TimeScope), [monthly, months, categories, scopeKey]);
  const who = scope.kind === "team" ? "the team" : scope.kind === "role" ? (roles.find((r) => r.id === scope.id)?.name ?? "the role") : scope.kind === "person" ? (people.find((p) => p.id === scope.id)?.name ?? "this person") : "everyone else";
  const empty = !view.total.some((t) => t.mean > 0);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-time-section aria-label="Where the time goes">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={cn(SECTION_TITLE, "flex items-center")}>
            Where the time goes
            <Help {...SANDBOX_HELP.time} />
          </h2>
          <p className="text-sm text-muted-foreground">What {who} {scope.kind === "team" || scope.kind === "others" ? "spend" : "spends"} working time on over the next {span}, as hours and as a share of all the hours available.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Show" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
            {(noPeople ? (["team", "role"] as const) : (["team", "role", "person"] as const)).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                // The Month by month section has its own "By role" and "By person": this one says which it is.
                aria-label={k === "team" ? "Where the time goes, team" : `Where the time goes, ${k === "role" ? "by role" : "by person"}`}
                onClick={() => setKind(k)}
                className={cn("rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", kind === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {k === "team" ? "Team" : k === "role" ? "By role" : "By person"}
              </button>
            ))}
          </div>
          {kind === "role" && withWork.length > 0 ? (
            <NativeSelect aria-label="Role" value={role ?? ""} onChange={(e) => setRoleId(e.target.value)} className="h-8 w-auto text-xs" data-time-pick="role">
              {withWork.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          {kind === "person" && personOptions.length > 0 ? (
            <NativeSelect aria-label="Person" value={person ?? ""} onChange={(e) => setPersonKey(e.target.value)} className="h-8 w-auto text-xs" data-time-pick="person">
              {personOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          ) : null}
        </div>
      </div>
      <Card className="gap-3 px-4 py-4" data-chart="time">
        {empty ? (
          <p className="text-sm text-muted-foreground" data-empty>
            {kind === "role" && !withWork.length ? "No role has any hours in this run." : "There are no hours to show for this in this run."}
          </p>
        ) : (
          <>
            <TimeLegend rows={view.rows} />
            <TimeChart view={view} label={`Where ${who} spend working time each month over the next ${span}: ${view.rows.filter((r) => r.runShare > 0).map((r) => `${r.name} ${formatPercent(r.runShare)}`).join(", ")}.`} />
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-xs tabular-nums" data-time-table>
                <caption className="sr-only">Hours and share of the hours available, by purpose and month</caption>
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th scope="col" className="sticky left-0 bg-card py-1 pr-3 font-medium">
                      Purpose
                    </th>
                    {view.months.map((mo) => (
                      <th key={mo.index} scope="col" className="px-2 py-1 text-right font-medium" title={mo.label}>
                        {mo.short}
                      </th>
                    ))}
                    <th scope="col" className="border-l border-line px-2 py-1 text-right font-medium">
                      Whole run
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r) => (
                    <tr key={r.id} className="border-t border-line" data-time-row={r.id}>
                      <th scope="row" className="sticky left-0 bg-card py-1 pr-3 text-left font-normal">
                        {r.name}
                      </th>
                      {r.hours.map((h, i) => (
                        <td key={i} className="px-2 py-1 text-right" title={`${view.months[i]!.label}: ${hoursText(h.mean)} (10–90%: ${hoursText(h.p10)} to ${hoursText(h.p90)})`}>
                          {hoursText(h.mean)}
                          {r.kind === "uncovered" ? null : <span className="block text-muted-foreground">{formatPercent(r.share[i]!)}</span>}
                        </td>
                      ))}
                      <td className="border-l border-line px-2 py-1 text-right font-medium">
                        {hoursText(r.runHours)}
                        {r.kind === "uncovered" ? null : <span className="block font-normal text-muted-foreground">{formatPercent(r.runShare)}</span>}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-line text-muted-foreground" data-time-row="hours">
                    <th scope="row" className="sticky left-0 bg-card py-1 pr-3 text-left font-normal">
                      Hours available
                    </th>
                    {view.total.map((h, i) => (
                      <td key={i} className="px-2 py-1 text-right">
                        {hoursText(h.mean)}
                      </td>
                    ))}
                    <td className="border-l border-line px-2 py-1 text-right">{hoursText(view.total.reduce((a, h) => a + h.mean, 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-time-notes>
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {!viewer.seesEveryone ? <li>Your own hours and everyone else&apos;s together: you don&apos;t see other people one by one. Numbers use the standard speed for everyone.</li> : null}
        </ul>
        <p className="text-xs text-muted-foreground">
          {purposesHref ? (
            <>
              <Link href={purposesHref} className="underline">
                Change categories
              </Link>
              .{" "}
            </>
          ) : null}
          A step&apos;s purpose is set in the editor, under “What it achieves”; steps with none use Automatic.
        </p>
      </Card>
    </section>
  );
}
