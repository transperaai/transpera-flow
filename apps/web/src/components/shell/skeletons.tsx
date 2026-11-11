import type { ReactNode } from "react";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Page, pageBodyClass, type PageVariant } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// What a workspace page shows while its server loaders run (issue #44): the page's own frame with grey shapes where its
// content goes, drawn from the same layout classes as the real page so nothing jumps when it arrives. No data, no client code.

/** The wrapper every skeleton shares: a status for a screen reader, and a hook for the browser checks to wait on. */
function Loading({ name, label, className, children }: { name: string; label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label} data-loading={name} className={className}>
      {children}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** A label line over a field box: one row of a form. */
function FieldRow() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * The frame of a page made with `Page`, under the page's real title (so the header doesn't jump), with `children` as the body.
 * `hideHeader` for a page whose content draws its own header (Forecast), as `Page` takes it.
 */
export function PageSkeleton({
  title,
  eyebrow,
  variant,
  hideHeader,
  children,
}: {
  title: string;
  eyebrow?: string;
  variant?: PageVariant;
  hideHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <Page title={title} eyebrow={eyebrow} variant={variant} hideHeader={hideHeader}>
      {children}
    </Page>
  );
}

/** Issues, processes, solutions, sources, blocks: the toolbar row (search, filters, count), then one bordered full-width table. */
export function ListSkeleton({ rows = 6, filters = true, columns = 6 }: { rows?: number; filters?: boolean; columns?: number }) {
  return (
    <Loading name="list" label="Loading the list" className="flex flex-col gap-3">
      {filters && (
        <div className="flex flex-wrap items-center gap-2" aria-hidden>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      )}
      <TableBox columns={columns} rows={rows} />
    </Loading>
  );
}

/** One bordered table: a shaded header row and `rows` lines (the layout of `ListTable`). */
function TableBox({ columns, rows }: { columns: number; rows: number }) {
  const grid = { gridTemplateColumns: `2fr repeat(${columns - 1}, minmax(0, 1fr))` };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card" aria-hidden>
      <div className="grid gap-4 bg-panel-2 px-4 py-2.5" style={grid}>
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className="h-3 w-2/3" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-4 border-t border-line px-4 py-3.5" style={grid}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={c === 0 ? "h-4 w-3/4" : "h-4 w-1/2"} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The flat page header every page starts with: an eyebrow, the title, one meta line, and buttons at the right. */
function HeaderShape({ eyebrow, title, pills = false, buttons = 2 }: { eyebrow?: string; title?: string; pills?: boolean; buttons?: number }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3" aria-hidden>
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
        {eyebrow && <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{eyebrow}</span>}
        {title ? <span className="font-display text-xl leading-tight font-semibold tracking-tight">{title}</span> : <Skeleton className="h-7 w-72 max-w-full" />}
        {pills && (
          <div className="flex flex-wrap gap-1.5">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        )}
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {buttons > 0 && (
        <div className="flex items-center gap-2">
          {Array.from({ length: buttons }, (_, i) => (
            <Skeleton key={i} className="h-9 w-24" />
          ))}
        </div>
      )}
    </header>
  );
}

/** A bordered panel with a title line and a few lines of content. */
function PanelShape({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <Card className={`gap-2 px-4 py-4 ${className}`} aria-hidden>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i % 2 ? "h-3 w-4/5" : "h-3 w-full"} />
      ))}
    </Card>
  );
}

/** The detail pages' rail: a card of term and value rows. */
function RailShape({ rows = 7 }: { rows?: number }) {
  return (
    <Card className="gap-3 px-4 py-4 max-xl:hidden" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex justify-between gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </Card>
  );
}

function CardGridCells({ cards, className }: { cards: number; className: string }) {
  return (
    <div className={`grid gap-3 ${className}`} aria-hidden>
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i} className="gap-2 px-4 py-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </Card>
      ))}
    </div>
  );
}

/** Solution cards, block cards, the Overview's health cards: a grid of cards with three lines each. `className` sets the columns. */
export function CardGridSkeleton({ cards = 4, className = "md:grid-cols-2" }: { cards?: number; className?: string }) {
  return (
    <Loading name="card-grid" label="Loading the cards">
      <CardGridCells cards={cards} className={className} />
    </Loading>
  );
}

function TableRows({ columns, rows }: { columns: number; rows: number }) {
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  return (
    <Card className="gap-0 py-0" aria-hidden>
      <div className="grid gap-4 px-4 py-3" style={grid}>
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className="h-3 w-3/4" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-4 border-t border-line px-4 py-3.5" style={grid}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className="h-4 w-full" />
          ))}
        </div>
      ))}
    </Card>
  );
}

/** People, version history, share links: a card with a header row and `rows` lines. */
export function TableSkeleton({ columns = 5, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <Loading name="table" label="Loading the table">
      <TableRows columns={columns} rows={rows} />
    </Loading>
  );
}

/** One card with four field rows: Restore, a share form, Levers, Access. */
export function FormSkeleton() {
  return (
    <Loading name="form" label="Loading the form">
      <Card className="gap-4 px-4 py-4" aria-hidden>
        <Skeleton className="h-5 w-40" />
        {Array.from({ length: 4 }, (_, i) => (
          <FieldRow key={i} />
        ))}
      </Card>
    </Loading>
  );
}

/** Settings, one scrolling page: the sub-nav on the left, then section bands (a heading and a line over a rule) each over a card of rows. */
export function SettingsSkeleton() {
  return (
    <Loading name="settings" label="Loading the settings" className="grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
      <div className="flex flex-col gap-2 max-lg:hidden" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-32" />
        ))}
      </div>
      <div className="flex max-w-240 min-w-0 flex-col gap-6">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} data-skeleton-band className="flex flex-col gap-4 border-line-2 [&:not(:first-child)]:mt-8 [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-8" aria-hidden>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <Card className="gap-4 px-4 py-4">
              {Array.from({ length: 3 }, (_, j) => (
                <div key={j} className="grid gap-3 border-line pt-4 first:pt-0 sm:grid-cols-[13rem_minmax(0,1fr)] [&:not(:first-child)]:border-t">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-9 w-28" />
                </div>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** The Overview: header, the five stat cards on one line, the company map the full width, then the cards sized as the page sizes them. */
export function OverviewSkeleton() {
  return (
    <div>
      <ShellHeader title="Overview" />
      <Loading name="overview" label="Loading the Overview" className={pageBodyClass()}>
        <HeaderShape eyebrow="Overview" buttons={3} />
        <CardGridCells cards={5} className="grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]" />
        <div className="flex h-[78svh] min-h-[32rem] min-w-0 flex-col">
          <MapSkeleton nested height="fill" />
        </div>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <PanelShape lines={4} />
          <PanelShape lines={4} />
          <PanelShape lines={6} className="lg:col-span-2" />
          <PanelShape lines={5} />
          <PanelShape lines={5} />
          <PanelShape lines={4} className="lg:col-span-2" />
        </div>
        <PanelShape lines={4} />
      </Loading>
    </div>
  );
}

/** The process page, on the Issue page's template: breadcrumb, header with pills, then the map card and two section cards beside the 20rem rail from `xl`. */
export function ProcessPageSkeleton() {
  return (
    <Page title="Process" hideHeader>
      <Loading name="process-page" label="Loading the process" className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-4 w-40" aria-hidden />
        <HeaderShape pills buttons={3} />
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <div className="flex h-[60svh] min-h-[28rem] min-w-0 flex-col">
              <MapSkeleton nested height="fill" />
            </div>
            <PanelShape lines={4} />
            <PanelShape lines={3} />
          </div>
          <RailShape rows={10} />
        </div>
      </Loading>
    </Page>
  );
}

/** A process's History (`HistoryPage`): the process switcher, the header, then the list of versions beside the chosen version. */
export function HistorySkeleton() {
  return (
    <div>
      <ShellHeader title="Process history" />
      <Loading name="history" label="Loading the history" className={pageBodyClass()}>
        <Skeleton className="h-4 w-56" aria-hidden />
        <HeaderShape title="Process history" buttons={0} />
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[22.5rem_minmax(0,1fr)]">
          <Card className="gap-0 py-0" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-line px-4 py-3 not-first:border-t">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </Card>
          <PanelShape lines={5} className="max-lg:hidden" />
        </div>
      </Loading>
    </div>
  );
}

/** The Editor: the purple bar, the 240px palette, the map edge to edge, the 360px inspector (a label, a tinted hint, fields). */
export function EditorSkeleton() {
  return (
    <Loading name="editor" label="Loading the Editor" className="flex min-h-svh flex-col bg-bg text-fg lg:h-svh">
      <div className="flex h-12 items-center gap-3 bg-edit px-4 text-edit-fg" aria-hidden>
        <Skeleton className="h-5 w-40 bg-edit-fg/20" />
        <Skeleton className="ml-auto h-7 w-24 bg-edit-fg/20" />
        <Skeleton className="h-7 w-24 bg-edit-fg/20" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex flex-col gap-3 border-b border-line bg-panel p-3.5 lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </aside>
        <main className="flex min-h-[28rem] min-w-0 flex-1 flex-col bg-bg lg:min-h-0 [&>*]:rounded-none [&>*]:border-0">
          <MapSkeleton nested height="fill" />
        </main>
        <aside className="flex flex-col gap-3 border-line bg-panel p-3.5 max-lg:hidden lg:w-90 lg:shrink-0 lg:border-l" aria-hidden>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <FieldRow />
          <FieldRow />
        </aside>
      </div>
    </Loading>
  );
}

/** One issue: breadcrumb, header with pills, then the main column (map first, then cards) beside the 20rem rail from `xl`. */
export function IssuePageSkeleton() {
  return (
    <Page title="Issue" eyebrow="Improve" hideHeader>
      <Loading name="issue-page" label="Loading the issue" className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-4 w-40" aria-hidden />
        <HeaderShape pills buttons={2} />
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <MapSkeleton nested height={320} />
            <PanelShape lines={3} />
            <PanelShape lines={2} />
          </div>
          <RailShape rows={8} />
        </div>
      </Loading>
    </Page>
  );
}

/** One solution: breadcrumb, header, then notes and the two maps beside the 20rem rail from `xl`. */
export function SolutionPageSkeleton() {
  return (
    <Page title="Solution" eyebrow="Improve" hideHeader>
      <Loading name="solution-page" label="Loading the solution" className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-4 w-40" aria-hidden />
        <HeaderShape pills buttons={2} />
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <PanelShape lines={3} />
            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              <MapSkeleton nested height={256} />
              <MapSkeleton nested height={256} />
            </div>
          </div>
          <RailShape rows={6} />
        </div>
      </Loading>
    </Page>
  );
}

/** A chart block as tall as the forecast chart's own fallback. */
export function ChartSkeleton() {
  return (
    <Loading name="chart" label="Loading the chart">
      <Skeleton className="h-[320px] w-full" aria-hidden />
    </Loading>
  );
}

/** The Sandbox workbench (drawn next to its page, which owns its shape). */
export { SandboxSkeleton } from "@/components/sandbox/sandbox-skeleton";
