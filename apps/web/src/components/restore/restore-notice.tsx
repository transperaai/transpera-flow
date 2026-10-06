"use client";

// What a restore had to say, shown once on the Overview it lands on (issue #39, B10 2b): "Restored 5 processes as drafts. Publish
// each one to see its numbers." Left in a short-lived cookie by the restore page, read here once and cleared (the pattern of
// components/processes/upload-notice.tsx).

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { parseRestoreNotice, RESTORE_NOTICE_COOKIE } from "@/lib/restore/notice";

let taken: string | null | undefined;

function take(): string | null {
  if (taken !== undefined) return taken;
  taken = null;
  try {
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${RESTORE_NOTICE_COOKIE}=`));
    if (raw) {
      document.cookie = `${RESTORE_NOTICE_COOKIE}=; path=/; max-age=0`;
      taken = parseRestoreNotice(raw.slice(RESTORE_NOTICE_COOKIE.length + 1));
    }
  } catch {
    // No cookie access: the notice is only a courtesy.
  }
  return taken;
}

const never = () => () => undefined;

export function RestoreNotice() {
  // On the server (and while hydrating) there is nothing to show; the browser reads the cookie.
  const message = useSyncExternalStore(never, take, () => null);
  const [dismissed, setDismissed] = useState(false);
  if (!message || dismissed) return null;
  return (
    <aside role="status" data-restore-notice className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl rounded-lg border border-border bg-background p-3 text-sm shadow-lg">
      <p>{message}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setDismissed(true)}>
        Dismiss
      </Button>
    </aside>
  );
}
