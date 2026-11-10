import type { ReactNode } from "react";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { Eyebrow, Page } from "@/components/shell/page";
import { cn } from "@/lib/utils";
import { SettingsNav } from "./settings-nav";

/**
 * The frame of every Settings page (docs/plans/ui-cleanup.md, SettingsLayout): the shell's top bar, the kit's header (the "Settings"
 * eyebrow, the title, one muted sentence, the buttons at the right), then the sticky sub-nav at the left and the form column, capped at
 * about 60rem, at the right. Every Settings page has the same width and the same eyebrow. Without `slug` (a test harness) there is no
 * sub-nav.
 */
export function SettingsPage({
  title,
  description,
  actions,
  slug,
  canManage = false,
  children,
}: {
  title: string;
  /** Ignored: every Settings page has the eyebrow "Settings". Kept so older callers still build. */
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The workspace, for the sub-nav's links. */
  slug?: string;
  /** Owners and Agency admins: the sub-nav lists Access. */
  canManage?: boolean;
  children: ReactNode;
}) {
  const column = (
    // A link to `#<section>-heading` lands on the heading below the sticky top bar.
    <div data-settings-column className="flex w-full max-w-240 min-w-0 flex-col gap-6 [&_[id$=-heading]]:scroll-mt-20">
      {children}
    </div>
  );
  return (
    <Page title={title} hideHeader>
      <PageHeader
        label={title}
        title={title}
        eyebrow={<Eyebrow>Settings</Eyebrow>}
        meta={description ? <MetaLine className="max-w-prose">{description}</MetaLine> : undefined}
        actions={actions}
      />
      {slug ? (
        <div data-settings-layout className="grid min-w-0 items-start gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
          <SettingsNav slug={slug} canManage={canManage} />
          {column}
        </div>
      ) : (
        column
      )}
    </Page>
  );
}

/** A subheading inside a settings section (Lead sources, Seasonality, Growth): one style everywhere. */
export function SettingsSubheading({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h3 id={id} className={cn("flex items-center text-sm font-semibold text-foreground", className)}>
      {children}
    </h3>
  );
}
