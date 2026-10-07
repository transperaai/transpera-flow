import type { NodeOptions } from "@sentry/nextjs";
import { sentryDsn, sentryEnvironment } from "./env";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

export type SharedOptions = Required<
  Pick<
    NodeOptions,
    "dsn" | "environment" | "enabled" | "sendDefaultPii" | "beforeSend" | "beforeBreadcrumb" | "beforeSendTransaction" | "maxBreadcrumbs" | "attachStacktrace" | "includeLocalVariables" | "sendClientReports"
  >
>;

/**
 * The options every runtime shares (ADR 0017). Null when there is no DSN.
 * Errors only: no tracing, replay, feedback, logs or profiling option is set, so each stays off. `release` is left unset:
 * `withSentryConfig` injects it at build. `includeLocalVariables` is Node-only; the browser's `init` ignores it.
 */
export function sharedOptions(): SharedOptions | null {
  const dsn = sentryDsn();
  if (!dsn) return null;
  return {
    dsn,
    environment: sentryEnvironment(),
    // A local `next dev` never sends, even with the DSN in .env.local.
    enabled: process.env.NODE_ENV === "production",
    sendDefaultPii: false,
    includeLocalVariables: false,
    attachStacktrace: false,
    sendClientReports: false,
    maxBreadcrumbs: 30,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendTransaction: () => null,
  };
}
