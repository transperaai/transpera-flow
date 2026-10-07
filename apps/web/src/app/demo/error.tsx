"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { ShellHeader } from "@/components/shell/shell-header";
import { reportError } from "@/lib/monitoring/report";

/** A page of the demo that failed (issue #44). It sits inside the demo layout, so the sidebar stays. */
export default function DemoError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // An error with a digest came from the server, where `onRequestError` already reported it: reporting it again would count it twice.
    if (!error.digest) reportError(error);
  }, [error]);

  return (
    <div>
      <ShellHeader title="Something went wrong" />
      <ErrorState digest={error.digest} onRetry={retry} homeHref="/demo" />
    </div>
  );
}
