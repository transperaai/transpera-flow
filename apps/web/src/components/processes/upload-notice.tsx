"use client";

// What an upload had to say, shown once in the editor it landed in (issue #166). The upload ends in a redirect, so what it
// noticed on the way (steps left without a role, an activity-log entry that couldn't be written, graph warnings) is left in a
// short-lived cookie by the server action and shown here, then cleared. Nothing in it is secret.

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { NOTICE_COOKIE, parseNotice } from "@/lib/processes/upload-notice";

const NONE: string[] = [];
/** The notice for a process, read from the cookie once (and the cookie cleared), so every render sees the same answer. */
const taken = new Map<string, string[]>();

function take(processId: string): string[] {
  const have = taken.get(processId);
  if (have) return have;
  let warnings = NONE;
  try {
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${NOTICE_COOKIE}=`));
    if (raw) {
      document.cookie = `${NOTICE_COOKIE}=; path=/; max-age=0`;
      const notice = parseNotice(decodeURIComponent(raw.slice(NOTICE_COOKIE.length + 1)));
      if (notice && notice.processId === processId) warnings = notice.warnings;
    }
  } catch {
    // No cookie access: the notice is only a courtesy.
  }
  taken.set(processId, warnings);
  return warnings;
}

const never = () => () => undefined;

export function UploadNotice({ processId }: { processId: string }) {
  // On the server (and while hydrating) there is nothing to show; the browser reads the cookie.
  const warnings = useSyncExternalStore(never, () => take(processId), () => NONE);
  const [dismissed, setDismissed] = useState(false);
  if (!warnings.length || dismissed) return null;
  return (
    <aside role="status" data-upload-notice className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-xl rounded-lg border border-warn bg-warn-soft p-3 text-sm shadow-lg">
      <p className="font-medium">Uploaded as a draft. Worth a look:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {warnings.map((w, i) => (
          <li key={i} className="break-words">
            {w}
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setDismissed(true)}>
        Dismiss
      </Button>
    </aside>
  );
}
