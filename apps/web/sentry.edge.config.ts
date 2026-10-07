import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "@/lib/monitoring/options";

// Sentry in the edge runtime (issue #44). No route runs there today; this is loaded only when `NEXT_RUNTIME` is "edge".
const options = sharedOptions();
if (options) Sentry.init({ ...options });
