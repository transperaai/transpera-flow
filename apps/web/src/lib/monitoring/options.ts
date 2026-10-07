import type { NodeOptions } from "@sentry/nextjs";
import { sentryDsn, sentryEnvironment } from "./env";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

export type SharedOptions = Required<
  Pick<
    NodeOptions,
    | "dsn"
    | "environment"
    | "enabled"
    | "sendDefaultPii"
    | "dataCollection"
    | "tracePropagationTargets"
    | "enhanceFetchErrorMessages"
    | "beforeSend"
    | "beforeBreadcrumb"
    | "beforeSendTransaction"
    | "maxBreadcrumbs"
    | "attachStacktrace"
    | "includeLocalVariables"
    | "sendClientReports"
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
    // What the SDK collects in the first place (it replaces sendDefaultPii in 10.x; with only sendDefaultPii: false it still
    // collects filtered headers, cookies and query strings). Nothing personal is collected, so the scrubber is the second
    // layer, not the only one. Frame context lines are our own source code.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    // No `sentry-trace` or `baggage` header on the server's own requests (Supabase, Anthropic): tracing is off, and they would
    // carry the release and the DSN's public key to other companies.
    tracePropagationTargets: [],
    // By default the SDK rewrites "Failed to fetch" to name the host, in the app's own error too (which the UI may show).
    enhanceFetchErrorMessages: false,
    includeLocalVariables: false,
    attachStacktrace: false,
    sendClientReports: false,
    maxBreadcrumbs: 30,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendTransaction: () => null,
  };
}
