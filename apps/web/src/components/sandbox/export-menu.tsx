"use client";

// The Sandbox's Export menu (docs/plans/sandbox-p5-brief.md §6): the numbers as a CSV, the changes and notes as a CSV, and the summary
// printed (or saved as a PDF from the browser's print dialog). Everything is made in the browser from the runs already on screen, so it
// is the same as the page shows; a Viewer's runs have no costs, so they export none. Disabled while a run is running.

import { Download } from "lucide-react";
import { useState } from "react";
import type { PurposeCategory } from "@transpera-flow/db";
import type { EffectiveChange } from "@transpera-flow/db/sandbox";
import type { EngineModel } from "@transpera-flow/engine";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { downloadBlob, exportFileName } from "@/lib/export/map-image";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import type { DescribeContext } from "@/lib/sandbox/describe";
import { changesCsv, sandboxCsv, type ExportColumn } from "@/lib/sandbox/export";
import { EDIT_ONLY } from "@/lib/phone";

export interface ExportData {
  /** Every column with its run; "No changes" first. */
  columns: (ExportColumn & { changes: readonly EffectiveChange[] })[];
  months: readonly TimelineMonth[];
  model: Pick<EngineModel, "roles" | "services">;
  categories: readonly PurposeCategory[];
  currency: string;
  ctx: Omit<DescribeContext, "changes">;
}

export interface SandboxExportMenuProps {
  /** What the files are called: "<workspace> <name>". */
  fileName: string;
  /** Null when the runs are ready; else why the menu can't export yet. */
  disabledReason: string | null;
  /** The runs to export; null while there are none. */
  data: ExportData | null;
  /** Whether the runs carry costs (an Agency admin's or the Owner's): the checkbox is offered. */
  hasCosts: boolean;
  includeCosts: boolean;
  onIncludeCosts: (v: boolean) => void;
  onPrint: () => void;
}

export function SandboxExportMenu({ fileName, disabledReason, data, hasCosts, includeCosts, onIncludeCosts, onPrint }: SandboxExportMenuProps) {
  const [error, setError] = useState<string | null>(null);
  const off = disabledReason !== null || data === null;
  const download = (kind: "numbers" | "changes") => {
    if (!data) return;
    setError(null);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const text =
        kind === "numbers"
          ? sandboxCsv(data.columns, data.months, data.model, { currency: data.currency, costs: includeCosts && hasCosts, categories: data.categories })
          : changesCsv(data.columns, data.ctx, includeCosts && hasCosts);
      downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), exportFileName(`${fileName} ${kind === "numbers" ? "numbers" : "changes"}`, "csv", date));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The export failed.");
    }
  };
  return (
    <div className="flex items-center gap-2" data-sandbox-export>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" data-export-menu disabled={off} title={disabledReason ?? undefined}>
            <Download aria-hidden />
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuLabel>The runs on screen</DropdownMenuLabel>
          <DropdownMenuItem data-export="numbers" onSelect={() => download("numbers")}>
            Numbers (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem data-export="changes" onSelect={() => download("changes")}>
            Changes and notes (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem data-export="print" className={EDIT_ONLY} onSelect={onPrint}>
            Print or save as PDF
          </DropdownMenuItem>
          {hasCosts ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem data-export="costs" checked={includeCosts} onCheckedChange={(v) => onIncludeCosts(v === true)} onSelect={(e) => e.preventDefault()}>
                Include costs and profit
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
          <p className="px-1.5 pb-1 text-xs text-muted-foreground">
            Averages with their 10–90% range, month by month, for “No changes” and the scenario. Never by person.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
