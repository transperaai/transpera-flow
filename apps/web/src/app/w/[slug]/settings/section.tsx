import type { ReactNode } from "react";
import { FieldLayoutProvider } from "@/components/fields";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { SectionCard } from "@/components/page-kit";
import { SettingsBand } from "@/components/settings/settings-band";
import { Card, CardContent } from "@/components/ui/card";

/**
 * One block of a Settings page: a kit `SectionCard` with a heading (the overview's checklist links to `#people-heading`) and a
 * plain sentence. `action` puts buttons at the right of the title. The region wrapper keeps the block a landmark named by its heading.
 * Every field inside says "Not saved" while it holds a change and "Saved" once it has stored it (they save on blur or on change).
 *
 * `band`: the block is a whole top-level section of the Settings page (Workspace, Simulation, Churn drivers, Demand). Its title and
 * sentence become the section's heading band (`SettingsBand`, the same `<id>` and `<id>-heading`) over a card holding the fields, so the
 * page doesn't say the same title twice.
 */
export function SettingsSection({ id, title, description, action, phoneWrap = true, band = false, children }: { id: string; title: ReactNode; description?: ReactNode; action?: ReactNode; /** False: the section handles read-only-on-a-phone itself (a list with view controls, and a panel). */ phoneWrap?: boolean; band?: boolean; children: ReactNode }) {
  const body = (
    <FieldLayoutProvider value={{ status: true }}>
      {/* A phone is read only (issue #44); the page shows one notice, so the sections show none. */}
      {phoneWrap ? <PhoneReadOnly notice={false}>{children}</PhoneReadOnly> : children}
    </FieldLayoutProvider>
  );
  if (band) {
    return (
      <SettingsBand id={id} title={title} description={description} action={action}>
        <Card className="gap-3">
          <CardContent className="flex flex-col gap-3">{body}</CardContent>
        </Card>
      </SettingsBand>
    );
  }
  return (
    <div role="region" aria-labelledby={`${id}-heading`}>
      {/* Inside a band (the page's h2), a card's title is the next level down. */}
      <SectionCard id={id} title={title} description={description} action={action} level={3}>
        {body}
      </SectionCard>
    </div>
  );
}
