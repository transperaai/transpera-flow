import type { ReactNode } from "react";
import { MetaLine, PageHeader as KitPageHeader } from "@/components/page-kit";
import { cn } from "@/lib/utils";
import { ShellHeader } from "./shell-header";

/**
 * How wide a page's body runs (docs/plans/ui-cleanup.md):
 * - `fluid` (the default): the full width of the main area, with the shared gutter. Lists, dashboards, detail pages.
 * - `narrow`: a reading column, for a page that is one form or one text (Restore, Privacy).
 * Paragraphs keep `max-w-prose` themselves; cards, tables and grids fill the width.
 */
export type PageVariant = "fluid" | "narrow";

/** The body of a page: the one place that owns the page gutter and the gap between sections. Pages that draw their own frame use it too. */
export function pageBodyClass(variant: PageVariant = "fluid") {
  return cn("flex w-full min-w-0 flex-col gap-5 px-4 pt-5 pb-12 sm:px-6 lg:px-8", variant === "narrow" && "mx-auto max-w-3xl");
}

/**
 * The frame of every page inside the shell but the map (issue #98): the top bar with the sidebar toggle, then the page's header (small
 * group name, title, one plain sentence, actions on the right) and the content. `eyebrow` is the sidebar group the page lives in
 * ("Improve", "Company").
 */
export function Page({
  title,
  eyebrow,
  description,
  actions,
  variant = "fluid",
  hideHeader = false,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  variant?: PageVariant;
  /** The content draws its own header (the Issue page's has breadcrumbs, a rating and the buttons). */
  hideHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <ShellHeader title={title} />
      <div className={pageBodyClass(variant)}>
        {!hideHeader && <PageHeader title={title} eyebrow={eyebrow} description={description} actions={actions} />}
        {children}
      </div>
    </div>
  );
}

/** The small group name above a page title. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</span>;
}

/** A simple page header: the kit's header with a group name, title, one sentence and the buttons. Every page header looks the same. */
export function PageHeader({ title, eyebrow, description, actions }: { title: string; eyebrow?: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <KitPageHeader
      label={title}
      title={title}
      eyebrow={eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : undefined}
      meta={description ? <MetaLine className="max-w-prose text-xs">{description}</MetaLine> : undefined}
      actions={actions}
    />
  );
}
