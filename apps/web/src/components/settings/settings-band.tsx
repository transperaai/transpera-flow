import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One top-level section of the Settings page (Workspace, Simulation, … Access): a heading band, then its cards. Each band after the
 * first starts with a rule and generous space, so the eight sections read as clear breaks in one scrolling page; the cards inside keep
 * their own, lighter headings. The band's id is the sub-nav's anchor (`/settings#people-roles`); its heading is `<id>-heading`, as a
 * SettingsSection's is, so older links to `#workspace-heading` land on it. `scroll-mt` keeps a jump to it below the 48px top bar.
 */
export function SettingsBand({ id, title, description, action, className, children }: { id: string; title: ReactNode; description?: ReactNode; /** Buttons or a status at the right of the heading. */ action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section
      id={id}
      // Explicit so the band is a landmark named by its heading (a section is only a region when named; this states it).
      role="region"
      aria-labelledby={`${id}-heading`}
      data-settings-band={id}
      className={cn("flex min-w-0 scroll-mt-16 flex-col gap-4 border-t border-line-2 pt-8 mt-8 first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={`${id}-heading`} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description && <p className="max-w-prose text-sm text-fg-2">{description}</p>}
        </div>
        {action && <div className="flex flex-wrap items-center justify-end gap-2">{action}</div>}
      </header>
      {children}
    </section>
  );
}
