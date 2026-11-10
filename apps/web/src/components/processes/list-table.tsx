import type { ComponentProps, ReactNode } from "react";
import { Table, TableHeader } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// The one table surface every list page uses (docs/plans/ui-cleanup.md, ListPage): a single bordered surface, no card around it, built on
// ui/table. From 1280 px up the table stops scrolling sideways in its own box (every column fits), so its header row can stick under the
// bar at the top of the page while the page scrolls; below that it scrolls sideways inside the surface. `overflow-clip` (not hidden) keeps
// the rounded corners without making the surface a scroll box, which would stop the header sticking. Inline-size containment keeps a
// wide table from widening the page on a phone: the table scrolls inside the surface instead.
// Processes, Issues, Solutions, Sources, Blocks, Home and Tokens share it. It belongs in the page kit once that is open for changes.

/** Where the sticky header row stops: under the shell's 48 px bar inside a workspace, or at the top of a page outside one. */
export type StickyTop = "shell" | "page";

export function ListTable({ children, className, ...rest }: ComponentProps<"table">) {
  return (
    <div data-list-surface className="w-full min-w-0 overflow-clip [contain:inline-size] rounded-xl border border-line bg-card xl:[&>[data-slot=table-container]]:overflow-visible">
      <Table className={cn("border-collapse", className)} {...rest}>
        {children}
      </Table>
    </div>
  );
}

/** The table's header row: sticky, on the soft panel colour, small muted labels. */
export function ListTableHeader({ children, stickyTop = "shell", className }: { children: ReactNode; stickyTop?: StickyTop; className?: string }) {
  return <TableHeader className={cn("sticky z-10 bg-panel-2 [&_tr]:border-line [&_tr]:hover:bg-transparent", stickyTop === "shell" ? "top-12" : "top-0", className)}>{children}</TableHeader>;
}

/** The muted line beside a toolbar's filters: how many rows show. */
export function ListCount({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <span role="status" aria-live="polite" className="ml-auto text-xs whitespace-nowrap text-muted-foreground tabular-nums" {...rest}>
      {children}
    </span>
  );
}

export { EditMarker } from "@/components/page-kit/edit-marker";
