import type { ReactNode } from "react";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { Page } from "@/components/shell/page";

/**
 * The frame of every Set up and Settings page: the shell's top bar, then the kit's header card (the group as a small line above the title,
 * one muted sentence, the buttons at the right as one group), then the sections.
 */
export function SettingsPage({
  title,
  eyebrow,
  description,
  actions,
  width = "max-w-5xl",
  children,
}: {
  title: string;
  eyebrow: string;
  description?: ReactNode;
  actions?: ReactNode;
  width?: "max-w-3xl" | "max-w-5xl" | "max-w-6xl";
  children: ReactNode;
}) {
  return (
    <Page title={title} hideHeader width={width}>
      <PageHeader
        label={title}
        title={title}
        eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{eyebrow}</span>}
        meta={description ? <MetaLine>{description}</MetaLine> : undefined}
        actions={actions}
      />
      {children}
    </Page>
  );
}
