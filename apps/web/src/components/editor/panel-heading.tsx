import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small uppercase label over each part of the Editor's side panels (Add, Groups, Blocks, Inspector, Branches...). One
 * style for all of them, from the type scale (`text-2xs`), so the panels read as one tool.
 */
export function PanelHeading({ as: Tag = "h2", className, children }: { as?: "h2" | "h3" | "span"; className?: string; children: ReactNode }) {
  return <Tag className={cn("flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase", className)}>{children}</Tag>;
}
