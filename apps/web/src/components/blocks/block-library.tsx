"use client";

// The Block library page (issue #116, as a list in Q15): one row for each saved block, like the Processes page. A row opens in place
// to the block's map (read-only, the same canvas as an opened row on Processes); "Edit" opens the Editor on the block, and the menu renames,
// copies or deletes it. "+ New block" opens the Editor in block mode on an empty map. On the demo the blocks live in this tab
// (lib/blocks/demo.ts), so a block saved from the Editor shows here at once.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Copy, Layers, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { isGroup, type BlockRow, type ProcessBundle } from "@transpera-flow/db";
import { deleteBlock, duplicateBlock, renameBlock, type BlockOpResult } from "@/app/w/[slug]/block-actions";
import { Help } from "@/components/help";
import { EditMarker, ListCount, ListTable, ListTableHeader } from "@/components/processes/list-table";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ClearFilters, EmptyState, FilterMenu, MetaLine, PageHeader, Toolbar, ToolbarSearch, type FilterOption } from "@/components/page-kit";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Page } from "@/components/shell/page";
import { Skeleton } from "@/components/ui/skeleton";
import { bundleFromBlock, readBlock } from "@/lib/blocks/blocks";
import { duplicateDemoBlock, removeDemoBlock, renameDemoBlock, useDemoBlocks } from "@/lib/blocks/demo";
import { blockListRow, blockUsers, filterBlockRows, formatBlockTime, relativeDate, usedInSentence, type BlockListRow } from "@/lib/blocks/rows";
import { MAX_NAME } from "@/lib/blocks/save";
import { EDIT_ONLY } from "@/lib/phone";
import { solutionHref } from "@/lib/solutions/cards";
import { BlockMap } from "./block-map";

// The map is heavy and only needed once a row is opened (as on the Processes page).
const ProcessCanvas = dynamic(() => import("@/components/process-canvas").then((m) => m.ProcessCanvas), {
  ssr: false,
  loading: () => <MapSkeleton height={256} />,
});

/** The process that lends its roles and people to every block's map: not asked for until a row is opened, then kept for all rows. */
type Base = { state: "idle" } | { state: "loading" } | { state: "error" } | { state: "none" } | { state: "ready"; bundle: ProcessBundle };

const MAX_PILLS = 3;

export interface BlockRole {
  id: string;
  name: string;
  color?: string | null;
}

type DialogState = { mode: "rename" | "delete"; row: BlockListRow } | null;

export function BlockLibrary({
  blocks,
  mode,
  newHref,
  editBase = null,
  libraryHref = "",
  workspaceId = "",
  solutionsBase = "",
  users = {},
  roles = [],
  slug = "",
  baseProcessId = null,
  openBase = null,
}: {
  blocks: BlockRow[];
  mode: "live" | "readonly" | "demo";
  newHref: string | null;
  /** The Editor's address on a process of the workspace ("/w/x/p/<id>/edit"), which an edit of a block opens in block mode; null: no Edit. */
  editBase?: string | null;
  /** Where Cancel and a save in the Editor come back to. */
  libraryHref?: string;
  workspaceId?: string;
  /** "/w/<slug>": where a solution's page is. */
  solutionsBase?: string;
  /** The solutions that use each block, by block id (lib/blocks/rows.ts `blockUsers`). */
  users?: ReturnType<typeof blockUsers>;
  roles?: BlockRole[];
  /** The workspace's slug, for `openBase`. */
  slug?: string;
  /** The process whose live bundle draws the maps (the workspace's first); null: no process, so the small picture of the steps is drawn instead. */
  baseProcessId?: string | null;
  /** Loads that bundle (a Server Action; the browser harness stubs it). */
  openBase?: ((slug: string, processId: string) => Promise<ProcessBundle | null>) | null;
}) {
  const router = useRouter();
  const demo = useDemoBlocks();
  const list = mode === "demo" ? demo : blocks;
  const canEdit = mode !== "readonly";
  const rows = useMemo(() => list.map((b) => blockListRow(b, users)), [list, users]);
  const roleName = useMemo(() => new Map(roles.map((r) => [r.id, r] as const)), [roles]);
  const [search, setSearch] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [base, setBase] = useState<Base>({ state: "idle" });
  const wantsBase = !!baseProcessId && !!openBase;
  // The first row to open loads the base for every row.
  const loadBase = () => {
    // A failed load is tried again the next time a row opens ("Close the row and open it again").
    if (!wantsBase || (base.state !== "idle" && base.state !== "error")) return;
    setBase({ state: "loading" });
    openBase!(slug, baseProcessId!).then(
      (bundle) => setBase(bundle ? { state: "ready", bundle } : { state: "none" }),
      () => setBase({ state: "error" }),
    );
  };

  const roleOptions: FilterOption[] = useMemo(
    () =>
      roles
        .map((r) => ({ value: r.id, label: r.name, count: rows.filter((x) => x.roleIds.includes(r.id)).length, ...(r.color ? { dot: r.color } : {}) }))
        .filter((o) => o.count > 0),
    [roles, rows],
  );
  const shown = useMemo(() => filterBlockRows(rows, search, roleIds), [rows, search, roleIds]);
  const filtering = search.trim() !== "" || roleIds.length > 0;
  const clear = () => {
    setSearch("");
    setRoleIds([]);
  };
  const toggle = (id: string) => {
    if (!open.has(id)) loadBase();
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const editHref = (id: string) => (editBase ? `${editBase}?mode=block&block=${id}&from=${encodeURIComponent(libraryHref)}` : null);

  const done = (message: string) => {
    setStatus(message);
    setDialog(null);
    if (mode !== "demo") router.refresh();
  };
  const duplicate = async (row: BlockListRow) => {
    setStatus(null);
    if (mode === "demo") {
      duplicateDemoBlock(row.id);
      return done(`Copied ${row.name}.`);
    }
    const r = await duplicateBlock(workspaceId, row.id);
    if (r.status === "error") return setStatus(r.message);
    done(`Copied ${row.name} as “${r.block?.name ?? `${row.name} (copy)`}”.`);
  };
  const rename = async (row: BlockListRow, name: string): Promise<BlockOpResult> => {
    if (mode === "demo") {
      renameDemoBlock(row.id, name);
      done(`Renamed ${row.name} to ${name}.`);
      return { status: "ok" };
    }
    const r = await renameBlock(workspaceId, row.id, name);
    if (r.status === "ok") done(`Renamed ${row.name} to ${name}.`);
    return r;
  };
  const remove = async (row: BlockListRow): Promise<BlockOpResult> => {
    if (mode === "demo") {
      removeDemoBlock(row.id);
      done(`Deleted ${row.name}.`);
      return { status: "ok" };
    }
    const r = await deleteBlock(workspaceId, row.id);
    if (r.status === "ok") done(`Deleted ${row.name}.`);
    return r;
  };

  const newLink = newHref ? (
    <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
      <Button asChild>
        <Link href={newHref} data-new-block>
          <EditMarker />+ New block
        </Link>
      </Button>
      <Help
        label="New block"
        description="Opens the Editor on an empty map. Build a few steps, name the block, and save it to the library to reuse it."
        example="Build “Client sign-off” once (send the summary, chase, record the decision), then insert it into any process."
      />
    </span>
  ) : null;

  return (
    <Page title="Block library" hideHeader>
      <PageHeader
        label="Block library"
        testId="blocks-header"
        eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Improve</span>}
        title="Block library"
        meta={
          <MetaLine>
            <span>Saved bundles of steps. Drop one into a solution, or into a process in the Editor.</span>
            <span data-blocks-count>{list.length === 1 ? "1 block" : `${list.length} blocks`}</span>
            {mode === "readonly" ? <span>You can look at the library but not change it. Ask an Agency admin to add blocks.</span> : ""}
          </MetaLine>
        }
        actions={newLink ?? undefined}
        actionsLabel="Block library actions"
      />
      {list.length === 0 ? (
        <EmptyState
          icon={Layers}
          data-testid="blocks-empty"
          action={
            newHref ? (
              <span className={`inline-flex items-center ${EDIT_ONLY}`} data-edit-entry>
                <Button asChild>
                  <Link href={newHref}>
                    <EditMarker />+ New block
                  </Link>
                </Button>
              </span>
            ) : undefined
          }
        >
          No blocks yet. In the Editor, select a group and press “Save this group as a block”, or press “New block” to build one from scratch.
        </EmptyState>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <Toolbar label="Filter blocks">
            <ToolbarSearch value={search} onChange={setSearch} label="Search blocks" placeholder="Search blocks" />
            {roleOptions.length > 0 && <FilterMenu name="Who does it" options={roleOptions} selected={roleIds} onChange={setRoleIds} />}
            {filtering && <ClearFilters onClick={clear} />}
            <ListCount data-blocks-shown>{shown.length === list.length ? `${list.length} ${list.length === 1 ? "block" : "blocks"}` : `${shown.length} of ${list.length} blocks`}</ListCount>
          </Toolbar>
          <p role="status" aria-live="polite" className={status ? "text-xs text-muted-foreground" : "sr-only"} data-block-status>
            {status}
          </p>
          {shown.length === 0 ? (
            <EmptyState icon={Layers} data-testid="blocks-no-match" data-filtered action={<ClearFilters onClick={clear} />}>
              No blocks match. Clear the search or the filter to see them all.
            </EmptyState>
          ) : (
            <ListTable aria-label="Blocks">
              <ListTableHeader>
                <TableRow>
                    <TableHead className="w-9 p-0" aria-label="Open or close" />
                    <TableHead className="px-3">Block</TableHead>
                    <TableHead className="hidden px-3 text-right md:table-cell">
                      Steps
                      <Help label="Steps" description="How many steps do work in this block. Boxes that only group steps are not counted." example="A block of three steps in one group shows 3." />
                    </TableHead>
                    <TableHead className="hidden px-3 lg:table-cell">
                      Who does it
                      <Help label="Who does it" description="The roles its steps are given to. Steps with no role aren't listed." example="Account manager, Specialist." />
                    </TableHead>
                    <TableHead className="hidden px-3 text-right md:table-cell">
                      Time per run
                      <Help label="Time per run" description="The hands-on time of its steps added up, using each step's most likely time. Waiting isn't counted." example="Three steps of 30, 15 and 15 minutes show 1 h." />
                    </TableHead>
                    <TableHead className="hidden px-3 text-right lg:table-cell">
                      Automatable
                      <Help
                        label="Automatable"
                        description="The share of that hands-on time that sits in the steps' automatable part of their work split. A dash when no step has a split."
                        example="A 1 h block where half the time is automatable reads 50%."
                      />
                    </TableHead>
                    <TableHead className="px-3 text-right">
                      Used in
                      <Help
                        label="Used in"
                        description="How many saved solutions have this block in their map. A block put into one solution twice counts once. Click the number to see which."
                        example="Once “Client sign-off” sits in two solutions, this reads “2 solutions”."
                      />
                    </TableHead>
                    <TableHead className="hidden px-3 sm:table-cell">Updated</TableHead>
                    <TableHead className="px-3" aria-label="Open, edit or change the block" />
                </TableRow>
              </ListTableHeader>
              <TableBody>
                  {shown.map((r) => {
                    const isOpen = open.has(r.id);
                    const panel = `block-card-${r.id}`;
                    const href = canEdit ? editHref(r.id) : null;
                    return (
                      <Fragment key={r.id}>
                        <TableRow data-block={r.id} data-state={isOpen ? "open" : undefined} className="cursor-pointer data-[state=open]:bg-muted/40" onClick={() => toggle(r.id)}>
                          <TableCell className="p-0 pl-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-expanded={isOpen}
                              aria-controls={panel}
                              aria-label={`${isOpen ? "Close" : "Open"} ${r.name}`}
                              data-block-chevron
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(r.id);
                              }}
                              className="text-muted-foreground"
                            >
                              <ChevronRight aria-hidden className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                            </Button>
                          </TableCell>
                          <TableCell className="w-full max-w-0 min-w-28 px-3 py-2.5 sm:min-w-44">
                            <span className="block min-w-0 truncate font-semibold" data-block-name>
                              {r.name}
                            </span>
                            {r.line && (
                              <span className="block truncate text-xs text-muted-foreground" data-block-line>
                                {r.line}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell" data-block-steps-count>
                            {r.steps}
                          </TableCell>
                          <TableCell className="hidden px-3 py-2.5 lg:table-cell" data-block-roles>
                            <RolePills ids={r.roleIds} roles={roleName} />
                          </TableCell>
                          <TableCell className="hidden px-3 py-2.5 text-right whitespace-nowrap tabular-nums md:table-cell" data-block-time>
                            {formatBlockTime(r.hours)}
                          </TableCell>
                          <TableCell className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell" data-block-auto>
                            {r.automatable === null ? <span className="text-muted-foreground">–</span> : `${Math.round(r.automatable * 100)}%`}
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums" data-block-used onClick={(e) => e.stopPropagation()}>
                            <UsedIn row={r} base={solutionsBase} />
                          </TableCell>
                          <TableCell className="hidden px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground sm:table-cell" data-block-updated>
                            {relativeDate(r.updatedAt)}
                          </TableCell>
                          <TableCell className="px-3 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            <span className="inline-flex items-center gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-expanded={isOpen}
                                aria-controls={panel}
                                aria-label={`Open ${r.name}`}
                                data-block-open
                                onClick={() => toggle(r.id)}
                              >
                                {isOpen ? "Close" : "Open"}
                              </Button>
                              {href && (
                                <Button variant="outline" size="sm" asChild className={EDIT_ONLY}>
                                  <Link href={href} aria-label={`Edit ${r.name}`} data-block-edit data-edit-entry>
                                    <EditMarker /> Edit
                                  </Link>
                                </Button>
                              )}
                              {canEdit && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Change ${r.name}`} data-block-menu={r.name} data-edit-entry className={`text-muted-foreground ${EDIT_ONLY}`}>
                                      <MoreHorizontal aria-hidden />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-auto min-w-44">
                                    <DropdownMenuItem onSelect={() => setDialog({ mode: "rename", row: r })} className="whitespace-nowrap">
                                      <Pencil /> Rename…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void duplicate(r)} className="whitespace-nowrap">
                                      <Copy /> Duplicate
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => setDialog({ mode: "delete", row: r })} className="whitespace-nowrap">
                                      <Trash2 /> Delete…
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow id={panel} className="bg-muted/20 hover:bg-muted/20" data-block-panel={r.id}>
                            <TableCell colSpan={9} className="p-3 sm:p-4">
                              <BlockCard block={list.find((b) => b.id === r.id)!} base={wantsBase ? base : { state: "none" }} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
              </TableBody>
            </ListTable>
          )}
        </div>
      )}
      {dialog?.mode === "rename" && <RenameDialog key={dialog.row.id} row={dialog.row} onClose={() => setDialog(null)} onSave={(name) => rename(dialog.row, name)} />}
      {dialog?.mode === "delete" && <DeleteDialog key={dialog.row.id} row={dialog.row} onClose={() => setDialog(null)} onDelete={() => remove(dialog.row)} />}
    </Page>
  );
}

function RolePills({ ids, roles }: { ids: string[]; roles: Map<string, BlockRole> }) {
  const known = ids.map((id) => roles.get(id)).filter((r): r is BlockRole => !!r);
  if (!known.length) return <span className="text-muted-foreground">–</span>;
  const extra = known.length - MAX_PILLS;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {known.slice(0, MAX_PILLS).map((r) => (
        <span key={r.id} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs whitespace-nowrap" data-role-pill>
          {r.color && <i aria-hidden className="size-1.5 rounded-full" style={{ background: r.color }} />}
          {r.name}
        </span>
      ))}
      {extra > 0 && (
        <span className="text-xs text-muted-foreground" data-role-more title={known.slice(MAX_PILLS).map((r) => r.name).join(", ")}>
          +{extra}
        </span>
      )}
    </span>
  );
}

/** "2 solutions": a button listing them, with links, when there are any. */
function UsedIn({ row, base }: { row: BlockListRow; base: string }) {
  const n = row.usedIn.length;
  const text = `${n} ${n === 1 ? "solution" : "solutions"}`;
  if (n === 0) return <span className="text-muted-foreground">{text}</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-used-in={row.id} className="rounded-md px-1 font-medium text-accent underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {text}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 gap-1 p-2" data-used-in-list={row.id}>
        <div className="px-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Used in</div>
        <ul className="flex flex-col">
          {row.usedIn.map((s) => (
            <li key={s.id}>
              <Link href={solutionHref(base, s.id)} className="block rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function BlockCard({ block, base }: { block: BlockRow; base: Base }) {
  const bundle = useMemo(() => readBlock(block.steps), [block.steps]);
  const steps = bundle.steps.filter((s) => !isGroup(s)).length;
  const map = useMemo(() => (base.state === "ready" ? bundleFromBlock(base.bundle, bundle, block.name) : null), [base, bundle, block.name]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {bundle.steps.length === 0 || base.state === "none" ? (
        // No steps to draw, or no process to draw them on: the small picture (which says "No steps in this block yet.").
        <div className="overflow-x-auto rounded-lg border border-line bg-card p-2">
          <BlockMap block={bundle} label={`Map of ${block.name}: ${steps} ${steps === 1 ? "step" : "steps"}`} />
        </div>
      ) : base.state === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load the map. Close the row and open it again.
        </p>
      ) : map ? (
        <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-card" data-block-canvas>
          <ProcessCanvas bundle={map} showPlayback={false} showLanes={false} height="auto" legend zoomControls />
        </div>
      ) : (
        <Skeleton className="h-64 w-full" role="status" aria-label="Loading the map" />
      )}
    </div>
  );
}

function RenameDialog({ row, onClose, onSave }: { row: BlockListRow; onClose: () => void; onSave: (name: string) => Promise<BlockOpResult> }) {
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const next = name.trim();
    if (!next || next.length > MAX_NAME) return setError(`Give it a name (up to ${MAX_NAME} characters).`);
    setBusy(true);
    setError(null);
    try {
      const r = await onSave(next);
      if (r.status === "error") setError(r.message);
    } catch {
      setError("Couldn't rename. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-block-dialog="rename">
        <DialogHeader>
          <DialogTitle>Rename block</DialogTitle>
          <DialogDescription>The new name shows in the library and in the Editor&apos;s block list. Groups already put into solutions keep the name they had.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input aria-label="Block name" value={name} maxLength={MAX_NAME} autoFocus onChange={(e) => setName(e.target.value)} />
          {error && (
            <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ row, onClose, onDelete }: { row: BlockListRow; onClose: () => void; onDelete: () => Promise<BlockOpResult> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const used = row.usedIn.length > 0;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await onDelete();
      if (r.status === "error") setError(r.message);
    } catch {
      setError("Couldn't delete. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-block-dialog="delete">
        <DialogHeader>
          <DialogTitle>Delete “{row.name}”?</DialogTitle>
          <DialogDescription>{used ? "This block can't be deleted while a solution uses it." : "The block is removed from the library. This can't be undone."}</DialogDescription>
        </DialogHeader>
        {used && (
          <p role="alert" className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" data-delete-refused>
            {usedInSentence(row.usedIn)} Delete {row.usedIn.length === 1 ? "that solution" : "those solutions"} first, or keep the block.
          </p>
        )}
        {error && !used && (
          <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {used ? "Close" : "Keep it"}
          </Button>
          {!used && (
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
