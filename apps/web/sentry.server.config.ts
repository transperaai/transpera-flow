import * as Sentry from "@sentry/nextjs";
import { sharedOptions } from "@/lib/monitoring/options";

// Sentry on the Node server (issue #44, ADR 0017). Local variables stay off (in the shared options): they would carry names and pay.
const options = sharedOptions();
if (options) Sentry.init({ ...options });
