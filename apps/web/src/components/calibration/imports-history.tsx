// Settings → Historical data, "Imports" (issue #40, C1): every file imported here, newest first: its kind, name, rows and date, the
// columns that were matched, and what a leads or invoices file said. Earlier imports stay listed when a kind is imported again, and
// their columns are offered next time; their rows are never kept. Everyone in the workspace sees it, and no one is named (#30).

import { IMPORT_KINDS, type ImportDetails } from "@transpera-flow/db/csv-import";
import { Help } from "@/components/help";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ImportRecord } from "@/lib/calibration/import-data";
import { formatNumber, formatPercent } from "@/lib/format";

export interface ImportsHistoryProps {
  imports: ImportRecord[];
  /** The workspace's lead sources, to name the ones a leads file's summary counts. */
  leadSources: { id: string; name: string }[];
}

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "deal ← Record ID, stage ← Deal Stage": the matched columns in the kind's order. */
export function columnsText(kind: ImportRecord["kind"], map: Record<string, string>): string {
  return IMPORT_KINDS[kind].columns
    .filter((c) => map[c.id] !== undefined)
    .map((c) => `${c.id} ← ${map[c.id]}`)
    .join(", ");
}

function summaryText(details: ImportDetails | null, names: Map<string, string>): string | null {
  const s = details?.summary;
  if (!s) return null;
  if (s.kind === "leads") {
    if (s.blocked) return `${formatNumber(s.leads, 0)} leads over ${formatNumber(s.weeks, 1)} weeks: too short to compare.`;
    const per = s.sources
      .filter((x) => names.has(x.leadSourceId))
      .map((x) => `${names.get(x.leadSourceId)} ${formatNumber(x.perWeek, 1)} a week (Settings ${formatNumber(x.current, 1)})`)
      .join(", ");
    return `${formatNumber(s.leads, 0)} leads over ${formatNumber(s.weeks, 1)} weeks${per ? `: ${per}` : ""}.`;
  }
  return `${formatNumber(s.invoices, 0)} invoices from ${formatNumber(s.clients, 0)} clients${s.paidLate === null ? "" : `, ${formatPercent(s.paidLate)} paid late`}.`;
}

export function ImportsHistory({ imports, leadSources }: ImportsHistoryProps) {
  const names = new Map(leadSources.map((s) => [s.id, s.name]));
  return (
    <Card role="region" aria-labelledby="imports-heading">
      <CardHeader>
        <h2 id="imports-heading" className="flex items-center font-heading text-base font-medium">
          Imports
          <Help
            label="Imports"
            description="Every file imported here, newest first. Importing a kind again adds a record and the earlier ones stay listed. Their columns are offered again next time. The rows are never kept, so an earlier import can't be run again."
            example="Importing deals again in March lists both files; the March import starts from the columns you chose in February."
          />
        </h2>
      </CardHeader>
      <CardContent>
        {imports.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing imported yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {imports.map((r) => {
              const summary = summaryText(r.details, names);
              return (
                <li key={r.id} data-import-kind={r.kind} className="flex flex-col gap-1 py-2.5">
                  <span className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span className="min-w-0">
                      <span className="font-medium">{IMPORT_KINDS[r.kind].label}</span> <span className="break-words text-muted-foreground">{r.fileName}</span>
                    </span>
                    <span className="text-muted-foreground">
                      {formatNumber(r.rowCount, 0)} rows · {date(r.importedAt)}
                    </span>
                  </span>
                  {Object.keys(r.columnMap).length > 0 && <span className="text-xs break-words text-muted-foreground">Columns: {columnsText(r.kind, r.columnMap)}</span>}
                  {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
