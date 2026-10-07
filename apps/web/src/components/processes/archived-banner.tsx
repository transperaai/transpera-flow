"use client";

// The banner on an archived process's page (issue #182, B19 2/2): when it was archived, that it is read only, and for editors
// Restore. While it is archived the database refuses every change to it (a draft, a publish, a restored version).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProcessAdminResult } from "@/lib/processes/admin";
import { shortDate } from "@/lib/processes/rows";
import { EDIT_ONLY } from "@/lib/phone";

export function ArchivedBanner({ name, archivedAt, restore }: { name: string; archivedAt: string; restore?: () => Promise<ProcessAdminResult> }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!restore) return;
    setWorking(true);
    setError(null);
    try {
      const r = await restore();
      if (r.status === "error") setError(r.message);
      else router.refresh();
    } finally {
      setWorking(false);
    }
  };
  return (
    <div role="status" data-archived-banner className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p>
        <span className="font-semibold">Archived on {shortDate(archivedAt)}.</span> {name} is off the company map, the lists and the simulation, and read only. Its history is kept.
      </p>
      {restore && (
        <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void run()} aria-label={`Restore ${name}`} className={`shrink-0 ${EDIT_ONLY}`} data-edit-entry>
          <ArchiveRestore aria-hidden /> {working ? "Restoring…" : "Restore"}
        </Button>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs sm:basis-full">
          {error}
        </p>
      )}
    </div>
  );
}
