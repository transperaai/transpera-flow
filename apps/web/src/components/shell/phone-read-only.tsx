"use client";

import type { ReactNode } from "react";
import { useIsPhone } from "@/hooks/use-mobile";

/** The one line a phone sees where it can't make changes (issue #44). */
export function PhoneNotice() {
  const isPhone = useIsPhone();
  if (!isPhone) return null;
  return (
    <p className="rounded-token border border-line bg-panel-2 px-3 py-2 text-xs text-fg-2" data-phone-notice>
      Read only on a phone. Open this on a tablet or computer to make changes.
    </p>
  );
}

/**
 * Disables every control inside on a phone (issue #44), with one line saying why. Wrap form bodies, not whole pages.
 * `notice={false}` leaves the line out, for a page whose sections share one `PhoneNotice`.
 */
export function PhoneReadOnly({ children, notice = true }: { children: ReactNode; notice?: boolean }) {
  const isPhone = useIsPhone();
  return (
    <>
      {notice && <PhoneNotice />}
      <fieldset disabled={isPhone} className="contents" data-phone-read-only={isPhone || undefined}>
        {children}
      </fieldset>
    </>
  );
}
