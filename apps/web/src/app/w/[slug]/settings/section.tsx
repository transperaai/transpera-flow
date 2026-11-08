import type { ReactNode } from "react";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { SectionCard } from "@/components/page-kit";

/**
 * One block of a Settings or Set up page: a kit `SectionCard` with a heading (the sidebar's People item links to `#people-heading`) and a
 * plain sentence. `action` puts buttons at the right of the title. The region wrapper keeps the block a landmark named by its heading.
 */
export function SettingsSection({ id, title, description, action, phoneWrap = true, children }: { id: string; title: ReactNode; description?: ReactNode; action?: ReactNode; /** False: the section handles read-only-on-a-phone itself (a list with view controls, and a panel). */ phoneWrap?: boolean; children: ReactNode }) {
  return (
    <div role="region" aria-labelledby={`${id}-heading`}>
      <SectionCard id={id} title={title} description={description} action={action}>
        {/* A phone is read only (issue #44); the page shows one notice, so the sections show none. */}
        {phoneWrap ? <PhoneReadOnly notice={false}>{children}</PhoneReadOnly> : children}
      </SectionCard>
    </div>
  );
}
