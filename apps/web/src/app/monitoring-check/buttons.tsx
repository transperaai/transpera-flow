"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { throwServerTestError } from "./actions";

/** The two test buttons of the monitoring check page (issue #44). */
export function MonitoringCheckButtons() {
  const [sent, setSent] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const browser = () => {
    // Thrown from a timer, so nothing here catches it: the page's global handler reports it, as it would a real bug.
    setTimeout(() => {
      throw new Error("Sentry check from the browser");
    }, 0);
    setSent("A browser test error was thrown. It should be in Sentry within a minute.");
  };

  const server = () =>
    start(async () => {
      try {
        await throwServerTestError();
      } catch {
        // The server reports its own error (onRequestError); the browser only sees a generic failure, which is expected here.
        setSent("A server test error was thrown. It should be in Sentry within a minute.");
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={browser}>Send a browser test error</Button>
        <Button variant="outline" onClick={server} disabled={pending}>
          Send a server test error
        </Button>
      </div>
      {sent && (
        <p role="status" className="text-sm text-muted-foreground">
          {sent}
        </p>
      )}
    </div>
  );
}
