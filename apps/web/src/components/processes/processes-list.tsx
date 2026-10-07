"use client";

// The Processes page's list with its admin (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"): the processes in use, or
// the archived ones ("Archived" filter), and for editors a menu on each row to rename it, change its type (with what that changes
// for the simulation) or archive it, and Restore on an archived one. The server actions do the work as the signed-in user; the
// page is then refreshed with what the database says.

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Shuffle } from "lucide-react";
import { ProcessesTable } from "@/components/processes/processes-table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  ARCHIVE_EXPLAINED,
  MAX_PROCESS_NAME,
  PROCESS_KIND_CHOICES,
  PROCESS_KIND_LABELS,
  kindChangeWarning,
  type ArchivedProcess,
  type ProcessAdminOps,
  type ProcessAdminResult,
  type ProcessKind,
} from "@/lib/processes/admin";
import type { ProcessCardData } from "@/lib/processes/data";
import { shortDate, type ProcessRowData } from "@/lib/processes/rows";
import { cn } from "@/lib/utils";
import { EDIT_ONLY } from "@/lib/phone";

type Open = { mode: "rename" | "kind" | "archive"; row: ProcessRowData } | null;

export function ProcessesList({
  rows,
  hrefs,
  loadCard,
  archived = [],
  admin,
}: {
  rows: ProcessRowData[];
  hrefs: Record<string, string>;
  loadCard: (processId: string) => Promise<ProcessCardData | null>;
  /** The archived processes, for the Archived filter. */
  archived?: ArchivedProcess[];
  /** Rename, change type, archive and restore (owners and editors); absent for viewers and the demo. */
  admin?: ProcessAdminOps;
}) {
  const router = useRouter();
  const [view, setView] = useState<"active" | "archived">("active");
  const [open, setOpen] = useState<Open>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  // What each process holds (the rows inside it), so "Archive" can say why it can't before asking the database.
  const held = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const r of rows) {
      const parent = r.trail.at(-1);
      if (parent) by.set(parent.id, [...(by.get(parent.id) ?? []), r.name]);
    }
    return by;
  }, [rows]);

  const done = (message: string) => {
    setStatus(message);
    setOpen(null);
    router.refresh();
  };

  const restore = async (p: ArchivedProcess) => {
    if (!admin) return;
    setRestoring(p.id);
    setRestoreError(null);
    try {
      const r = await admin.restore(p.id);
      if (r.status === "error") setRestoreError(r.message);
      else done(`Restored ${p.name}. It is back on the company map.`);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5" data-process-view={view}>
        <ViewChip on={view === "active"} onPick={() => setView("active")}>
          In use ({rows.length})
        </ViewChip>
        <ViewChip on={view === "archived"} onPick={() => setView("archived")}>
          Archived ({archived.length})
        </ViewChip>
      </div>
      <p role="status" aria-live="polite" className={status ? "text-xs text-muted-foreground" : "sr-only"} data-process-status>
        {status}
      </p>
      {view === "active" ? (
        <ProcessesTable
          rows={rows}
          hrefs={hrefs}
          loadCard={loadCard}
          actions={admin ? (r) => <RowMenu row={r} onPick={(mode) => setOpen({ mode, row: r })} /> : undefined}
        />
      ) : (
        <ArchivedTable archived={archived} hrefs={hrefs} canRestore={!!admin} restoring={restoring} error={restoreError} onRestore={(p) => void restore(p)} />
      )}
      {admin && open && (
        <AdminDialog
          key={`${open.mode}:${open.row.id}`}
          open={open}
          holds={held.get(open.row.id) ?? []}
          admin={admin}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

function ViewChip({ on, onPick, children }: { on: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-allow-on-phone /* a view filter (Archived), not an edit */
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-accent bg-accent-soft font-semibold" : "bg-card hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function RowMenu({ row, onPick }: { row: ProcessRowData; onPick: (mode: "rename" | "kind" | "archive") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${row.name}`}
          data-process-menu={row.name}
          data-edit-entry
          className={`grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${EDIT_ONLY}`}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPick("rename")}>
          <Pencil /> Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("kind")}>
          <Shuffle /> Change type…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("archive")}>
          <Archive /> Archive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArchivedTable({
  archived,
  hrefs,
  canRestore,
  restoring,
  error,
  onRestore,
}: {
  archived: ArchivedProcess[];
  /** Where an archived process still opens (its history is kept). */
  hrefs: Record<string, string>;
  canRestore: boolean;
  restoring: string | null;
  error: string | null;
  onRestore: (p: ArchivedProcess) => void;
}) {
  if (archived.length === 0) {
    return (
      <p className="rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground" data-archived-empty>
        Nothing is archived. An archived process leaves the map, the lists and the simulation, and keeps its history.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-sm">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-token border bg-card">
        <table className="w-full border-collapse text-sm" aria-label="Archived processes">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Process</th>
              <th className="hidden px-2 py-2 font-medium sm:table-cell">Type</th>
              <th className="px-2 py-2 font-medium">Archived</th>
              {canRestore && <th className="w-28 px-2 py-2" aria-label="Restore" />}
            </tr>
          </thead>
          <tbody>
            {archived.map((p) => (
              <tr key={p.id} className="border-b last:border-b-0" data-archived-process={p.name}>
                <td className="px-3 py-2.5 font-semibold">
                  {hrefs[p.id] ? (
                    <Link href={hrefs[p.id]!} className="hover:underline">
                      {p.name}
                    </Link>
                  ) : (
                    p.name
                  )}
                </td>
                <td className="hidden px-2 py-2.5 text-xs sm:table-cell">{PROCESS_KIND_LABELS[p.kind]}</td>
                <td className="px-2 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{shortDate(p.archivedAt)}</td>
                {canRestore && (
                  <td className="px-2 py-2 text-right">
                    <Button type="button" size="sm" variant="outline" className={EDIT_ONLY} data-edit-entry disabled={restoring !== null} onClick={() => onRestore(p)} aria-label={`Restore ${p.name}`}>
                      <ArchiveRestore aria-hidden /> {restoring === p.id ? "Restoring…" : "Restore"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TITLES = { rename: "Rename process", kind: "Change type", archive: "Archive process" } as const;

function AdminDialog({
  open: { mode, row },
  holds,
  admin,
  onClose,
  onDone,
}: {
  open: NonNullable<Open>;
  /** The processes inside this one. */
  holds: string[];
  admin: ProcessAdminOps;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [name, setName] = useState(row.name);
  const other: ProcessKind = row.kind === "servicing" ? "pipeline" : "servicing";
  const [kind, setKind] = useState<ProcessKind>(other);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const holder = row.trail.at(-1);
  // Archiving is refused for a process inside another, or holding others (the database says the same).
  const blocked =
    mode !== "archive"
      ? null
      : holder
        ? `${row.name} sits inside ${holder.name}. Take it out of ${holder.name} and publish, then archive it.`
        : holds.length
          ? `${row.name} holds ${holds.join(", ")}. Take ${holds.length === 1 ? "it" : "them"} out of ${row.name} and publish, then archive it.`
          : null;

  const run = async (call: () => Promise<ProcessAdminResult>, message: string) => {
    setWorking(true);
    setError(null);
    try {
      const r = await call();
      if (r.status === "error") setError(r.message);
      else onDone(message);
    } finally {
      setWorking(false);
    }
  };

  const submit = () => {
    if (mode === "rename") {
      const next = name.trim();
      if (!next || next.length > MAX_PROCESS_NAME) return setError(`Give it a name (up to ${MAX_PROCESS_NAME} characters).`);
      return run(() => admin.rename(row.id, next), `Renamed ${row.name} to ${next}.`);
    }
    if (mode === "kind") return run(() => admin.changeKind(row.id, kind), `${row.name} is now ${kind === "servicing" ? "client work" : "a sales pipeline"}.`);
    return run(() => admin.archive(row.id), `Archived ${row.name}. Find it under Archived to restore it.`);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-md" data-process-dialog={mode}>
        <DialogHeader>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogDescription>
            {mode === "rename"
              ? "The new name shows everywhere at once, including its card on the company map. Its history keeps the old name."
              : mode === "kind"
                ? `${row.name} is ${row.kind === "servicing" ? "client work" : "a sales pipeline"} now. Changing it changes how it is simulated.`
                : `Archive ${row.name}?`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked) void submit();
          }}
        >
          {mode === "rename" && (
            <div className="flex flex-col gap-1">
              <label htmlFor="process-new-name" className="text-xs font-medium text-muted-foreground uppercase">
                Name
              </label>
              <Input id="process-new-name" value={name} maxLength={MAX_PROCESS_NAME} autoFocus onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {mode === "kind" && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Type</legend>
                {PROCESS_KIND_CHOICES.map((k) => (
                  <label key={k.value} className="flex cursor-pointer items-start gap-2 rounded-token border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="process-kind" value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} className="mt-1" />
                    <span>
                      <span className="font-semibold">
                        {k.label}
                        {k.value === row.kind && <span className="font-normal text-muted-foreground"> (now)</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{k.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {kind !== row.kind && (
                <div role="note" className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" data-kind-warning>
                  <p className="font-semibold">What changes in the simulation</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {kindChangeWarning(row.name, kind).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {mode === "archive" &&
            (blocked ? (
              <p role="alert" className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" data-archive-blocked>
                {blocked}
              </p>
            ) : (
              <p className="text-sm">{ARCHIVE_EXPLAINED}</p>
            ))}
          {error && (
            <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {blocked ? "Close" : "Cancel"}
            </Button>
            {!blocked && (
              <Button type="submit" disabled={working || (mode === "kind" && kind === row.kind)} variant={mode === "archive" ? "destructive" : "default"}>
                {working ? "Saving…" : mode === "rename" ? "Save" : mode === "kind" ? "Change type" : "Archive"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
