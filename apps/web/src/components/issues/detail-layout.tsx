// The detail-page template the Issue and Solution pages share (docs/plans/ui-cleanup.md, "DetailPage"): the breadcrumb above the header,
// the header (the kit's PageHeader: title, pills, meta line, actions), then the metadata strip, then
// the main column across the full width.
//
// Candidate for components/page-kit once the History and Block detail pages use it too.

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Help, type HelpProps } from "@/components/help";
import { cn } from "@/lib/utils";

/** The trail above a detail page's header: each crumb but the last is a link. */
export function DetailBreadcrumb({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      {items.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>/</span>}
          {c.href ? (
            <Link href={c.href} className="hover:text-foreground hover:underline">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page" className="min-w-0 break-words text-foreground">
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** The page: breadcrumb, header, anything between (an error, a resolved bar), then the main column and the rail. */
export function DetailLayout({
  breadcrumb,
  header,
  notices,
  rail,
  children,
  className,
  ...rest
}: {
  breadcrumb: ReactNode;
  header: ReactNode;
  /** Lines between the header and the columns: an error, the resolved bar. */
  notices?: ReactNode;
  /** The metadata rail: a `MetaRail`. */
  rail?: ReactNode;
  /** The main column's sections. */
  children?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} {...rest}>
      {breadcrumb}
      {header}
      {notices}
      {rail}
      {children && <div className="flex min-w-0 flex-col gap-6">{children}</div>}
    </div>
  );
}

/** The metadata strip: one slim surface of terms and values in a row, under the header. */
export function MetaRail({ label, children, ...rest }: { label: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <aside aria-label={label} className="min-w-0 rounded-xl bg-card px-4 py-2.5 text-sm ring-1 ring-foreground/10" {...rest}>
      <dl className="flex flex-wrap items-start gap-x-7 gap-y-2">{children}</dl>
    </aside>
  );
}

/** One item of the strip: what it is (small, above), then its value. */
export function RailItem({ term, children, ...rest }: { term: ReactNode; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex min-w-0 max-w-[24rem] flex-col gap-0.5">
      <dt className="text-2xs font-medium tracking-wide text-fg-2 uppercase">{term}</dt>
      <dd className="min-w-0 font-medium break-words" {...rest}>
        {children}
      </dd>
    </div>
  );
}

/**
 * One (i) for a header's button group, instead of an (i) hand-wrapped beside each button: it says what each action does, so the help
 * stays one press away without crowding the buttons.
 */
export function ActionsHelp({ label, items }: { label: string; items: { help: Pick<HelpProps, "label" | "description" | "example"> }[] }) {
  if (!items.length) return null;
  return (
    <Help
      label={label}
      description={items.map(({ help }) => `${help.label}: ${help.description}`).join(" ")}
      example={items.map(({ help }) => help.example).join(" ")}
    />
  );
}

export { EditMarker } from "@/components/page-kit/edit-marker";
