"use client";

// The Processes page's list with its admin (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"): the processes in use, or
// the archived ones ("Archived" filter), and for editors a menu on each row to rename it, change its type (with what that changes
// for the simulation) or archive it, and Restore on an archived one. The server actions do the work as the signed-in user; the
// page is then refreshed with what the database says.

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Shuffle } from "lucide-react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS, type ProcessCategory } from "@transpera-flow/db";
import { ClearFilters, EmptyState, FilterMenu, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { ListCount, ListTable, ListTableHeader } from "@/components/processes/list-table";
import { ProcessesTable } from "@/components/processes/processes-table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ARCHIVE_EXPLAINED,
  MAX_PROCESS_NAME,
  PROCESS_KIND_CHOICES,
  PROCESS_KIND_LABELS,
  PROCESS_KIND_SIMULATED,
  kindChangeWarning,
  type ArchivedProcess,
  type ProcessAdminOps,
  type ProcessAdminResult,
  type ProcessKind,
} from "@/lib/processes/admin";
import type { ProcessCardData } from "@/lib/processes/data";
import { shortDate, type CompanyRowData, type ProcessRowData } from "@/lib/processes/rows";
import { EDIT_ONLY } from "@/lib/phone";

type Open = { mode: "rename" | "type" | "archive"; row: ProcessRowData } | null;

export function ProcessesList({
  rows,
  hrefs,
  loadCard,
  company,
  archived = [],
  admin,
  empty,
}: {
  rows: ProcessRowData[];
  hrefs: Record<string, string>;
  loadCard: (processId: string) => Promise<ProcessCardData | null>;
  /** The company map's pinned row (Q16). */
  company?: CompanyRowData;
  /** The archived processes, for the Archived filter. */
  archived?: ArchivedProcess[];
  /** Rename, change type, archive and restore (Agency admins); absent for viewers and the demo. */
  admin?: ProcessAdminOps;
  /** Shown in place of the table when there are no processes in use (issue #243). */
  empty?: ReactNode;
}) {
  const router = useRouter();
  const [view, setView] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  // The Type filter: any of the categories some process has (none ticked shows them all).
  const [categories, setCategories] = useState<string[]>([]);
  const present = useMemo(() => PROCESS_CATEGORIES.filter((c) => rows.some((r) => r.category === c)), [rows]);
  const q = search.trim().toLowerCase();
  const named = (name: string) => !q || name.toLowerCase().includes(q);
  const picked = categories.filter((c) => present.includes(c as ProcessCategory));
  const shown = rows.filter((r) => named(r.name) && (picked.length === 0 || picked.includes(r.category)));
  const archivedShown = archived.filter((p) => named(p.name));
  const typeOptions: FilterOption[] = present.map((c) => ({ value: c, label: PROCESS_CATEGORY_LABELS[c], count: rows.filter((r) => r.category === c && named(r.name)).length }));
  const filtered = Boolean(q) || picked.length > 0;
  const total = view === "active" ? rows.length : archived.length;
  const count = view === "active" ? shown.length : archivedShown.length;
  const noun = (n: number) => (n === 1 ? "process" : "processes");
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
      {(rows.length > 0 || archived.length > 0) && (
        <Toolbar label="Filter processes">
          <ToolbarSearch value={search} onChange={setSearch} label="Search processes" placeholder="Search processes" />
          {view === "active" && present.length > 1 && <FilterMenu name="Type" options={typeOptions} selected={picked} onChange={setCategories} />}
          {filtered && (
            <ClearFilters
              onClick={() => {
                setSearch("");
                setCategories([]);
              }}
            />
          )}
          <ListCount data-process-count>{count === total ? `${total} ${noun(total)}` : `${count} of ${total} ${noun(total)}`}</ListCount>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={view}
            onValueChange={(v) => v && setView(v as "active" | "archived")}
            aria-label="Show"
            data-process-view={view}
            data-allow-on-phone /* a view filter (Archived), not an edit */
          >
            <ToggleGroupItem value="active" data-allow-on-phone>
              In use ({rows.length})
            </ToggleGroupItem>
            <ToggleGroupItem value="archived" data-allow-on-phone>
              Archived ({archived.length})
            </ToggleGroupItem>
          </ToggleGroup>
        </Toolbar>
      )}
      <p role="status" aria-live="polite" className={status ? "text-xs text-muted-foreground" : "sr-only"} data-process-status>
        {status}
      </p>
      {view === "active" ? (
        <ProcessesTable
          company={company}
          rows={shown}
          hrefs={hrefs}
          loadCard={loadCard}
          empty={rows.length === 0 ? empty : undefined}
          filtered={filtered}
          actions={admin ? (r) => <RowMenu row={r} onPick={(mode) => setOpen({ mode, row: r })} /> : undefined}
        />
      ) : (
        <ArchivedTable archived={archivedShown} filtered={filtered} hrefs={hrefs} canRestore={!!admin} restoring={restoring} error={restoreError} onRestore={(p) => void restore(p)} />
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

function RowMenu({ row, onPick }: { row: ProcessRowData; onPick: (mode: "rename" | "type" | "archive") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Change ${row.name}`} data-process-menu={row.name} data-edit-entry className={`text-muted-foreground ${EDIT_ONLY}`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem onSelect={() => onPick("rename")} className="whitespace-nowrap">
          <Pencil /> Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("type")} className="whitespace-nowrap">
          <Shuffle /> Change type…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("archive")} className="whitespace-nowrap">
          <Archive /> Archive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArchivedTable({
  archived,
  filtered,
  hrefs,
  canRestore,
  restoring,
  error,
  onRestore,
}: {
  archived: ArchivedProcess[];
  /** A search is on, so an empty list means nothing matched. */
  filtered: boolean;
  /** Where an archived process still opens (its history is kept). */
  hrefs: Record<string, string>;
  canRestore: boolean;
  restoring: string | null;
  error: string | null;
  onRestore: (p: ArchivedProcess) => void;
}) {
  if (archived.length === 0) {
    return (
      <EmptyState icon={Archive} data-archived-empty>
        {filtered ? "No archived process matches." : "Nothing is archived. An archived process leaves the map, the lists and the simulation, and keeps its history."}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-sm">
          {error}
        </p>
      )}
      <ListTable aria-label="Archived processes">
        <ListTableHeader>
          <TableRow>
            <TableHead className="px-3">Process</TableHead>
            <TableHead className="hidden px-3 sm:table-cell">Type</TableHead>
            <TableHead className="px-3">Archived</TableHead>
            {canRestore && <TableHead className="w-28 px-3" aria-label="Restore" />}
          </TableRow>
        </ListTableHeader>
        <TableBody>
          {archived.map((p) => (
            <TableRow key={p.id} data-archived-process={p.name}>
              <TableCell className="px-3 py-2.5 font-semibold">
                {hrefs[p.id] ? (
                  <Link href={hrefs[p.id]!} className="hover:underline">
                    {p.name}
                  </Link>
                ) : (
                  p.name
                )}
              </TableCell>
              <TableCell className="hidden px-3 py-2.5 text-xs sm:table-cell">{PROCESS_KIND_LABELS[p.kind]}</TableCell>
              <TableCell className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{shortDate(p.archivedAt)}</TableCell>
              {canRestore && (
                <TableCell className="px-3 py-2 text-right">
                  <Button type="button" size="sm" variant="outline" className={EDIT_ONLY} data-edit-entry disabled={restoring !== null} onClick={() => onRestore(p)} aria-label={`Restore ${p.name}`}>
                    <ArchiveRestore aria-hidden /> {restoring === p.id ? "Restoring…" : "Restore"}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </ListTable>
    </div>
  );
}

/** What the line under the toolbar says after "Change type" saves. */
function typeDoneMessage(row: ProcessRowData, category: ProcessCategory, kind: ProcessKind): string {
  const parts: string[] = [];
  if (category !== row.category) parts.push(`${row.name} is now ${PROCESS_CATEGORY_LABELS[category]}.`);
  if (kind !== row.kind) parts.push(`It is now simulated as ${kind === "servicing" ? "client work" : "a sales pipeline"}.`);
  return parts.join(" ");
}

const TITLES = { rename: "Rename process", type: "Change type", archive: "Archive process" } as const;

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
  const [category, setCategory] = useState<ProcessCategory>(row.category);
  const [kind, setKind] = useState<ProcessKind>(row.kind);
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
    if (mode === "type") {
      // The simulation setting first: the database or the checks may refuse it, and then nothing is saved.
      return run(async (): Promise<ProcessAdminResult> => {
        if (kind !== row.kind) {
          const r = await admin.changeKind(row.id, kind);
          if (r.status === "error") return r;
        }
        if (category !== row.category) {
          const r = await admin.changeCategory(row.id, category);
          if (r.status === "error") return kind !== row.kind ? { status: "error", message: `${row.name} is now ${kind === "servicing" ? "client work" : "a sales pipeline"}, but its type didn't save: ${r.message}` } : r;
        }
        return { status: "ok" };
      }, typeDoneMessage(row, category, kind));
    }
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
              : mode === "type"
                ? `What is ${row.name} for? This is the word people see for it on the Processes page and the process page.`
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
          {mode === "type" && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Type</legend>
                {PROCESS_CATEGORIES.map((c) => (
                  <label key={c} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="process-category" value={c} checked={category === c} onChange={() => setCategory(c)} className="mt-1" />
                    <span>
                      <span className="font-semibold">
                        {PROCESS_CATEGORY_LABELS[c]}
                        {c === row.category && <span className="font-normal text-muted-foreground"> (now)</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{PROCESS_CATEGORY_HELP[c]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <details className="rounded-md border p-2 text-sm" data-how-simulated>
                <summary className="cursor-pointer font-medium">How it&apos;s simulated</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p data-simulated-as>{PROCESS_KIND_SIMULATED[row.kind]}.</p>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">Simulation</legend>
                    {PROCESS_KIND_CHOICES.map((k) => (
                      <label key={k.value} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
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
                </div>
              </details>
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
              <Button type="submit" disabled={working || (mode === "type" && kind === row.kind && category === row.category)} variant={mode === "archive" ? "destructive" : "default"}>
                {working ? "Saving…" : mode === "archive" ? "Archive" : "Save"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
