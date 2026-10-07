// How an error screen reports what it caught (issue #44, ADR 0017). React error boundaries swallow their errors, so the
// browser's global handler never sees them: `error.tsx` and `global-error.tsx` hand them here. The browser's Sentry setup
// (`sentry.client.config.ts`, which next.config.ts injects only when a DSN is set) registers the reporter; without a DSN
// nothing registers, this does nothing, and the Sentry SDK is not in the browser bundle at all.

type Reporter = (error: unknown) => void;

let reporter: Reporter | null = null;

/** Called once by the browser's Sentry setup. */
export function setErrorReporter(next: Reporter): void {
  reporter = next;
}

/** Reports an error an error screen caught; a no-op until the browser's Sentry setup has run. */
export function reportError(error: unknown): void {
  reporter?.(error);
}
