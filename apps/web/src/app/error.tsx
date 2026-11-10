"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { pageBodyClass } from "@/components/shell/page";
import { TransperaMark } from "@/components/shell/transpera-mark";
import { reportError } from "@/lib/monitoring/report";

/**
 * A page outside a workspace that failed (`/`, `/login`, `/settings/tokens`), or a workspace's own layout (issue #44). It sits
 * inside the root layout, so the document stays; `global-error.tsx` is left for errors in that layout itself.
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // An error with a digest came from the server, where `onRequestError` already reported it: reporting it again would count it twice.
    if (!error.digest) reportError(error);
  }, [error]);

  return (
    <main className={pageBodyClass()}>
      <p className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight">
        <TransperaMark />
        Transpera Flow
      </p>
      <ErrorState digest={error.digest} onRetry={retry} homeHref="/" />
    </main>
  );
}
