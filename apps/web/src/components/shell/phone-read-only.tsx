"use client";

import type { ReactNode } from "react";
import { useIsPhone } from "@/hooks/use-mobile";

/**
 * The one line a phone sees where it can't make changes (issue #44). The server can't know the width, so the line appears
 * right after hydration: it is written into a status region that is always there (empty, and with no box, off a phone), so a
 * screen reader announces it when it appears.
 */
export function PhoneNotice() {
  const isPhone = useIsPhone();
  return (
    <div role="status" className="contents">
      {isPhone && (
        <p className="rounded-token border border-line bg-panel-2 px-3 py-2 text-xs text-fg-2" data-phone-notice>
          Read only on a phone. Open this on a tablet or computer to make changes.
        </p>
      )}
    </div>
  );
}

/**
 * Disables every control inside on a phone (issue #44), with one line saying why. Wrap form bodies, not whole pages.
 * `notice={false}` leaves the line out, for a page whose sections share one `PhoneNotice`.
 * A disabled fieldset takes its controls out of the tab order, so focus moves past them; links inside stay usable.
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
