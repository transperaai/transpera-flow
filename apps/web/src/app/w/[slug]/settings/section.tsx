import type { ReactNode } from "react";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

/** One block of the settings page: a card with a heading (the sidebar's People item links to `#people-heading`) and a plain sentence. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card role="region" aria-labelledby={`${id}-heading`}>
      <CardHeader>
        <h2 id={`${id}-heading`} className="scroll-mt-20 font-heading text-base font-medium">
          {title}
        </h2>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* A phone is read only (issue #44); the page shows one notice, so the sections show none. */}
        <PhoneReadOnly notice={false}>{children}</PhoneReadOnly>
      </CardContent>
    </Card>
  );
}
