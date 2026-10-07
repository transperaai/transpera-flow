"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { useParams } from "next/navigation";
import { ErrorState } from "@/components/shell/error-state";
import { ShellHeader } from "@/components/shell/shell-header";

/** A page of a workspace that failed (issue #44). It sits inside the workspace layout, so the sidebar stays. */
export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { slug } = useParams<{ slug: string }>();
  useEffect(() => {
    // An error with a digest came from the server, where `onRequestError` already reported it: reporting it again would count it twice.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return (
    <div>
      <ShellHeader title="Something went wrong" />
      <ErrorState digest={error.digest} onRetry={retry} homeHref={`/w/${slug}`} />
    </div>
  );
}
