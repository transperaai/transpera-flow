import type { ReactNode } from "react";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { Eyebrow, Page, type PageVariant } from "@/components/shell/page";

/**
 * The frame of every Set up and Settings page: the shell's top bar, then the kit's header (the group as a small line above the title,
 * one muted sentence, the buttons at the right as one group), then the sections.
 */
export function SettingsPage({
  title,
  eyebrow,
  description,
  actions,
  variant,
  children,
}: {
  title: string;
  eyebrow: string;
  description?: ReactNode;
  actions?: ReactNode;
  variant?: PageVariant;
  children: ReactNode;
}) {
  return (
    <Page title={title} hideHeader variant={variant}>
      <PageHeader
        label={title}
        title={title}
        eyebrow={<Eyebrow>{eyebrow}</Eyebrow>}
        meta={description ? <MetaLine>{description}</MetaLine> : undefined}
        actions={actions}
      />
      {children}
    </Page>
  );
}
