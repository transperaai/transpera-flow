"use client";

// Settings → Historical data, "Leads and invoices" (issue #40, C1): read a leads file or an invoices file with the import wizard and
// show what it says, as a check only. Leads show leads a week for each lead source beside what Settings has now; invoices show
// counts. Neither changes the model: leads a week is applied from a stage history or deals, and late payments wait for a cash model
// (D44). Saving records the import (its name, columns and counts, never the rows or the names in them). On the demo nothing is saved.

import { useMemo, useState, useTransition } from "react";
import {
  invoicesSummary,
  leadsSummary,
  storedInvoicesSummary,
  storedLeadsSummary,
  formatImportTime,
  type ImportKind,
  type InvoiceRow,
  type InvoicesSummary,
  type LeadRow,
  type LeadsSummary,
} from "@transpera-flow/db/csv-import";
import { ImportWizard, type ImportReady } from "@/components/calibration/import-wizard";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { recordDataset } from "@/app/w/[slug]/settings/calibration/actions";

export type OtherImportsMode = "live" | "readonly" | "demo";

export interface OtherImportsPanelProps {
  mode: OtherImportsMode;
  workspaceId: string | null;
  /** The workspace's lead sources: the names in a leads file are matched to them. */
  leadSources: { id: string; name: string; volumeWeek: number }[];
  previous: Partial<Record<ImportKind, Record<string, string>>>;
  sample?: Partial<Record<ImportKind, { name: string; text: string }>>;
  /** The date the files are true on (epoch ms): today when not given; the demo's sample is dated. */
  asOf?: number;
}

const KINDS = ["leads", "invoices"] as const;

type Summary = { kind: "leads"; value: LeadsSummary } | { kind: "invoices"; value: InvoicesSummary };
type Done = { tone: "ok" | "error"; message: string };

export function OtherImportsPanel(props: OtherImportsPanelProps) {
  const { mode } = props;
  const [ready, setReady] = useState<ImportReady | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const targets = useMemo(() => ({ label: "Lead sources", names: props.leadSources.map((s) => s.name) }), [props.leadSources]);

  const summary = useMemo<Summary | null>(() => {
    if (!ready || asOf === null) return null;
    if (ready.kind === "leads") return { kind: "leads", value: leadsSummary(ready.rows as LeadRow[], props.leadSources, asOf) };
    if (ready.kind === "invoices") return { kind: "invoices", value: invoicesSummary(ready.rows as InvoiceRow[], asOf) };
    return null;
  }, [ready, asOf, props.leadSources]);

  const save = () => {
    if (!ready || !summary) return;
    if (mode === "demo") {
      setSaved(true);
      setDone({ tone: "ok", message: "Demo: nothing is saved." });
      return;
    }
    start(async () => {
      const out = await recordDataset({
        workspaceId: props.workspaceId,
        kind: ready.kind,
        fileName: ready.fileName,
        columnMap: ready.columnMap,
        rowCount: ready.rows.length,
        details: { ...ready.details, summary: summary.kind === "leads" ? storedLeadsSummary(summary.value) : storedInvoicesSummary(summary.value) },
      });
      if (out.status === "error") {
        setDone({ tone: "error", message: out.message });
        return;
      }
      setSaved(true);
      setDone({ tone: "ok", message: "Saved. It is listed under Imports." });
    });
  };

  return (
    <Card role="region" aria-labelledby="co-heading">
      <CardHeader>
        <h2 id="co-heading" className="font-heading text-base font-medium">
          Leads and invoices
        </h2>
        <CardDescription>
          A leads file shows how many leads a week each lead source brings, beside what Settings has. An invoices file shows counts. Both are checks only: nothing
          in the model changes. They are read in your browser. Only the file&apos;s name, its columns and counts are kept, not the rows.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ImportWizard
          id="cal-other"
          kinds={KINDS}
          targets={targets}
          previous={props.previous}
          sample={props.sample}
          mode={mode}
          onReady={(r) => {
            setReady(r);
            setAsOf(r ? (props.asOf ?? Date.now()) : null);
            setDone(null);
            setSaved(false);
          }}
        />

        {summary?.kind === "leads" && <LeadsCheck summary={summary.value} />}
        {summary?.kind === "invoices" && <InvoicesCheck summary={summary.value} />}

        {ready && summary && mode !== "readonly" && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2">
            <Button type="button" disabled={pending || saved} onClick={save}>
              {pending ? "Saving…" : saved ? "Saved" : "Save the import"}
            </Button>
            <Help
              label="Save the import"
              description="Keeps a record of this import: the file's name, which columns were matched, how many rows, and counts. The rows, and the clients and amounts in them, are never kept. It is listed under Imports, and its columns are offered next time."
              example="Save leads-2026.csv with 212 rows, so next time its columns are matched for you."
            />
            {mode === "demo" && <span className="text-sm text-muted-foreground">Demo: nothing is saved.</span>}
          </div>
        )}
        {ready && mode === "readonly" && <p className="text-sm text-muted-foreground">You can see what the file says here; owners and editors can save an import.</p>}
        {done && (
          <div role="status" className={cn("rounded-lg border p-3 text-sm", done.tone === "ok" ? "border-good bg-good-soft" : "border-crit bg-crit-soft")}>
            {done.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CheckBadge() {
  return <span className="inline-block rounded-token border border-line bg-panel-2 px-1.5 text-[11px] leading-4 text-fg-2">Check only</span>;
}

function LeadsCheck({ summary }: { summary: LeadsSummary }) {
  return (
    <section aria-labelledby="co-leads" className="flex flex-col gap-2">
      <h3 id="co-leads" className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
        Leads a week
        <CheckBadge />
        <Help
          label="Leads a week"
          description="How many leads a week each lead source brought over the file's dates, beside what Settings has now. It is a check: nothing is changed. Under 4 weeks, or under 10 leads from a source, is too little to compare."
          example="Google Ads: 31 leads over 8 weeks is 3.9 a week, beside the 4 in Settings."
        />
      </h3>
      <p className="text-sm text-muted-foreground">
        {formatNumber(summary.leads, 0)} leads over {formatNumber(summary.weeks, 1)} weeks (to {formatImportTime(summary.to)}).
        {summary.unmatched > 0 && ` ${formatNumber(summary.unmatched, 0)} came from a source that isn't in Settings.`}
      </p>
      {summary.blocked ? (
        <p className="text-sm text-muted-foreground">{summary.blocked}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                <th scope="col" className="px-3 py-1.5">Lead source</th>
                <th scope="col" className="px-3 py-1.5">Leads a week in the file</th>
                <th scope="col" className="px-3 py-1.5">In Settings now</th>
                <th scope="col" className="px-3 py-1.5 text-right">Leads</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {summary.sources.map((s) => (
                <tr key={s.leadSourceId}>
                  <td className="px-3 py-1.5 font-medium">{s.name}</td>
                  <td className="px-3 py-1.5 tabular-nums">{s.enough ? formatNumber(s.perWeek, 1) : <span className="text-muted-foreground">Too few to compare</span>}</td>
                  <td className="px-3 py-1.5 tabular-nums">{formatNumber(s.current, 1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s.leads, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted-foreground">To change leads a week, read a stage history or deals in the card above.</p>
    </section>
  );
}

function InvoicesCheck({ summary }: { summary: InvoicesSummary }) {
  return (
    <section aria-labelledby="co-invoices" className="flex flex-col gap-2">
      <h3 id="co-invoices" className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
        Invoices
        <CheckBadge />
        <Help
          label="Invoices"
          description="Counts from the file: how many invoices and clients, how many were paid after their due date, and how many are unpaid past it. Amounts are never added up or kept."
          example="212 invoices from 38 clients, 14% paid late, 6 unpaid past their due date."
        />
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        <li>
          <span className="tabular-nums font-medium">{formatNumber(summary.invoices, 0)}</span> invoices from{" "}
          <span className="tabular-nums font-medium">{formatNumber(summary.clients, 0)}</span> clients
          {summary.from !== null && summary.to !== null && `, issued ${formatImportTime(summary.from)} to ${formatImportTime(summary.to)}`}.
        </li>
        <li>
          {summary.paidLate === null ? "No invoice has both a due date and a paid date, so late payments can't be counted." : `${formatPercent(summary.paidLate)} of the invoices with a due date and a paid date were paid late.`}
        </li>
        <li>{formatNumber(summary.unpaidPastDue, 0)} are unpaid past their due date.</li>
      </ul>
      <p className="text-sm text-muted-foreground">Late payments aren&apos;t simulated yet, so nothing is changed.</p>
    </section>
  );
}
