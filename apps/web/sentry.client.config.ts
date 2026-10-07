import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "@/lib/monitoring/options";
import { setErrorReporter } from "@/lib/monitoring/report";

// Sentry in the browser (issue #44, ADR 0017). next.config.ts injects this file (`instrumentationClientInject`) only when a DSN is set
// at build, so it runs before React hydrates, and without a DSN none of the SDK is in the browser bundle.
// Errors only: the defaults that add tracing, replay, feedback or profiling are removed, and so is the session tracking
// (BrowserSession), which would send the visitor's browser details on every page view, error or not.
const NOT_WANTED = ["BrowserTracing", "Replay", "ReplayCanvas", "Feedback", "BrowserProfiling", "BrowserSession"];

/** The SDK's default integrations without the ones ADR 0017 rules out. */
export const withoutExtras = <T extends { name: string }>(defaults: T[]): T[] => defaults.filter((i) => !NOT_WANTED.includes(i.name));

const options = sharedOptions();
if (options) Sentry.init({ ...options, integrations: withoutExtras });
// The error screens report through lib/monitoring/report.ts, so none of them imports the SDK.
if (options) setErrorReporter((error) => Sentry.captureException(error));
