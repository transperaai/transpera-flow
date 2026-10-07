import type { ReactNode } from "react";
import { MapSkeleton } from "@/components/map/map-placeholder";
import { Page } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
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
  width,
  hideHeader,
  children,
}: {
  title: string;
  eyebrow?: string;
  width?: "max-w-3xl" | "max-w-5xl" | "max-w-6xl";
  hideHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <Page title={title} eyebrow={eyebrow} description="Loading…" width={width} hideHeader={hideHeader}>
      {children}
    </Page>
  );
}

/** Issues, processes, solutions, suggestions: a row of filter pills, then a bordered list of rows (the Sources pattern). */
export function ListSkeleton({ rows = 5, filters = true }: { rows?: number; filters?: boolean }) {
  return (
    <Loading name="list" label="Loading the list" className="flex flex-col gap-3">
      {filters && (
        <div className="flex flex-wrap gap-2" aria-hidden>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-32" />
        </div>
      )}
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-12 rounded-none" />
        ))}
      </div>
    </Loading>
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

/** One card with four field rows: Restore, a share form, AI analysis, Branding, Levers, Calibration, Access. */
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

/** Settings: three cards, each a heading line and four field rows. */
export function SettingsSkeleton() {
  return (
    <Loading name="settings" label="Loading the settings" className="flex flex-col gap-6">
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="gap-4 px-4 py-4" aria-hidden>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          {Array.from({ length: 4 }, (_, j) => (
            <FieldRow key={j} />
          ))}
        </Card>
      ))}
    </Loading>
  );
}

/** A section heading line and, under it, what the section holds. */
function SectionShape({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Skeleton className="h-5 w-40" aria-hidden />
      {children}
    </div>
  );
}

/** The Overview: its own header, the company map, a row of four health cards, then the findings. */
export function OverviewSkeleton() {
  return (
    <div>
      <ShellHeader title="Overview" />
      <Loading name="overview" label="Loading the Overview" className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-4 pb-14 pt-6 sm:px-6">
        <header className="flex flex-col gap-1" aria-hidden>
          <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Overview</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </header>
        <SectionShape>
          <MapSkeleton nested height={360} />
        </SectionShape>
        <CardGridCells cards={4} className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" />
        <SectionShape>
          <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12 rounded-none" />
            ))}
          </div>
        </SectionShape>
      </Loading>
    </div>
  );
}

/** The process page: the sticky top bar, the pill row, About, the First principles card and the map. */
export function ProcessPageSkeleton() {
  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <ProcessTopBar />
      <Loading name="process-page" label="Loading the process" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3" aria-hidden>
          <Skeleton className="h-6 w-44 rounded-full" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
        </header>
        <div className="min-w-0" aria-hidden>
          <Skeleton className="mb-1.5 h-3 w-28" />
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
        <SectionShape>
          <Card className="gap-2 px-4 py-3" aria-hidden>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </Card>
        </SectionShape>
        <SectionShape>
          <MapSkeleton nested height={360} />
        </SectionShape>
      </Loading>
    </div>
  );
}

/** The top bar of a page outside `Page` (the process page, First principles): the sidebar toggle and a line for the process picker. */
function ProcessTopBar() {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-x-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
      <Skeleton className="h-6 w-48" aria-hidden />
    </div>
  );
}

/** A process's History (`HistoryPage`): its own top bar and heading under the process switcher, then the versions table. */
export function HistorySkeleton() {
  return (
    <div>
      <ShellHeader title="Process history" />
      <Loading name="history" label="Loading the history" className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5 px-4 pt-6 pb-12 sm:px-6">
        <header className="flex flex-col gap-1" aria-hidden>
          <Skeleton className="h-4 w-56" />
          <h2 className="font-heading text-2xl leading-tight font-semibold tracking-tight">Process history</h2>
        </header>
        <TableRows columns={4} rows={6} />
      </Loading>
    </div>
  );
}

/** A process's First principles flow: the process page's top bar, the breadcrumb and title, then the form. */
export function FirstPrinciplesSkeleton() {
  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <ProcessTopBar />
      <Loading name="first-principles" label="Loading the first principles" className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5">
        <header className="flex flex-col gap-1.5" aria-hidden>
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full max-w-3xl" />
        </header>
        <Card className="gap-4 px-4 py-4" aria-hidden>
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 4 }, (_, i) => (
            <FieldRow key={i} />
          ))}
        </Card>
      </Loading>
    </div>
  );
}

/** The Editor: the purple bar, the palette on the left, the map filling the middle, the inspector on the right. */
export function EditorSkeleton() {
  return (
    <Loading name="editor" label="Loading the Editor" className="flex min-h-svh flex-col bg-bg text-fg lg:h-svh">
      <div className="flex h-12 items-center gap-3 bg-edit px-4 text-edit-fg" aria-hidden>
        <Skeleton className="h-5 w-40 bg-edit-fg/20" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[264px_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)]">
        <aside className="flex flex-col gap-3 border-b border-line bg-panel p-3.5 lg:border-r lg:border-b-0" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </aside>
        <main className="flex min-h-[28rem] min-w-0 flex-col gap-2 bg-bg p-3 lg:min-h-0">
          <MapSkeleton nested height="fill" />
        </main>
        <aside className="flex flex-col gap-3 border-line bg-panel p-3.5 max-lg:hidden lg:border-l" aria-hidden>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </aside>
      </div>
    </Loading>
  );
}

/** One issue: breadcrumb, title and pills, the map beside a side column, then its cards. */
export function IssuePageSkeleton() {
  return (
    <Page title="Issue" eyebrow="Improve" width="max-w-6xl" hideHeader>
      <Loading name="issue-page" label="Loading the issue" className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-2/3" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        </header>
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <MapSkeleton nested height={256} />
            <Card className="gap-2 px-4 py-3" aria-hidden>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </Card>
            <Card className="gap-2 px-4 py-3" aria-hidden>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
            </Card>
          </div>
          <Card className="gap-2 px-4 py-3 max-lg:hidden" aria-hidden>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </Card>
        </div>
      </Loading>
    </Page>
  );
}

/** One solution: breadcrumb and title, the verdict card, then the two maps side by side from `lg`. */
export function SolutionPageSkeleton() {
  return (
    <Page title="Solution" eyebrow="Improve" width="max-w-6xl" hideHeader>
      <Loading name="solution-page" label="Loading the solution" className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-2/3" />
        </header>
        <Card className="gap-2 px-4 py-3" aria-hidden>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </Card>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <MapSkeleton nested height={256} />
          <MapSkeleton nested height={256} />
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
