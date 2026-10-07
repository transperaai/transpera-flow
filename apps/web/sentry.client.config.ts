import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "@/lib/monitoring/options";

// Sentry in the browser (issue #44, ADR 0017). Errors only: the defaults that add tracing, replay, feedback or profiling are removed.
const NOT_WANTED = ["BrowserTracing", "Replay", "ReplayCanvas", "Feedback", "BrowserProfiling"];

/** The SDK's default integrations without the ones ADR 0017 rules out. */
export const withoutExtras = <T extends { name: string }>(defaults: T[]): T[] => defaults.filter((i) => !NOT_WANTED.includes(i.name));

const options = sharedOptions();
if (options) Sentry.init({ ...options, integrations: withoutExtras });
