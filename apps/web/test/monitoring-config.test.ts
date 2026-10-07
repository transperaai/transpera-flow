import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedOptions } from "@/lib/monitoring/options";
import { sentryDsn, sentryEnvironment, sourceMapsConfigured } from "@/lib/monitoring/env";
import { scrubBreadcrumb, scrubEvent } from "@/lib/monitoring/scrub";

// How Sentry is wired (issue #44, ADR 0017): off without a DSN, errors only, everything through the scrubber, and no source maps
// without all three build variables. Source text where the file can't be run here (the instrumentation hooks, the configs).

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const DSN = "https://public@o0.ingest.sentry.io/0";
const BUILD_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("env", () => {
  it("reads the DSN, treating empty and blank as none", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    expect(sentryDsn()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "   ");
    expect(sentryDsn()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", ` ${DSN} `);
    expect(sentryDsn()).toBe(DSN);
  });

  it("makes source maps only with all three build variables", () => {
    for (const v of BUILD_VARS) vi.stubEnv(v, "");
    expect(sourceMapsConfigured()).toBe(false);
    for (const missing of BUILD_VARS) {
      for (const v of BUILD_VARS) vi.stubEnv(v, v === missing ? "" : "x");
      expect(sourceMapsConfigured(), `without ${missing}`).toBe(false);
    }
    for (const v of BUILD_VARS) vi.stubEnv(v, "x");
    expect(sourceMapsConfigured()).toBe(true);
  });

  it("names the environment from Vercel's, else from NODE_ENV", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    expect(sentryEnvironment()).toBe("preview");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(sentryEnvironment()).toBe("production");
    vi.stubEnv("NODE_ENV", "development");
    expect(sentryEnvironment()).toBe("development");
  });
});

describe("sharedOptions", () => {
  it("is null with no DSN and with a blank one", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    expect(sharedOptions()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "  ");
    expect(sharedOptions()).toBeNull();
  });

  it("with a DSN: no PII, no local variables, the scrubber on events and breadcrumbs, and no tracing, replay, logs or profiling", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    const options = sharedOptions()!;
    expect(options).toMatchObject({ dsn: DSN, sendDefaultPii: false, includeLocalVariables: false, attachStacktrace: false, sendClientReports: false, maxBreadcrumbs: 30 });
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.beforeBreadcrumb).toBe(scrubBreadcrumb);
    expect(options.beforeSendTransaction?.({} as never, {})).toBeNull();
    for (const key of ["tracesSampleRate", "tracesSampler", "profilesSampleRate", "replaysSessionSampleRate", "replaysOnErrorSampleRate", "enableLogs", "_experiments", "release"]) {
      expect(options, key).not.toHaveProperty(key);
    }
  });

  it("sends only from a production build, so a local `next dev` never does", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    vi.stubEnv("NODE_ENV", "development");
    expect(sharedOptions()!.enabled).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(sharedOptions()!.enabled).toBe(true);
  });
});

describe("the three config files", () => {
  for (const runtime of ["client", "server", "edge"]) {
    const source = read(`sentry.${runtime}.config.ts`);

    it(`${runtime}: calls Sentry.init only inside if (options), with the shared options`, () => {
      expect(source).toContain("const options = sharedOptions();");
      expect(source.match(/Sentry\.init\(/g)).toHaveLength(1);
      expect(source).toMatch(/if \(options\) Sentry\.init\(\{ \.\.\.options\b/);
    });

    it(`${runtime}: names none of replay, feedback, tracing or profiling`, () => {
      const code = source.replace(/\/\/.*$/gm, "");
      for (const word of ["replayIntegration", "feedbackIntegration", "browserTracingIntegration", "tracesSampleRate", "tracesSampler", "profilesSampleRate", "replaysSessionSampleRate", "enableLogs"]) {
        expect(code, word).not.toContain(word);
      }
    });
  }

  it("the client's integration filter removes tracing, replay, feedback and profiling and keeps the rest", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const { withoutExtras } = await import("../sentry.client.config");
    const names = ["Breadcrumbs", "BrowserTracing", "Replay", "ReplayCanvas", "Feedback", "BrowserProfiling", "GlobalHandlers", "LinkedErrors"];
    expect(withoutExtras(names.map((name) => ({ name }))).map((i) => i.name)).toEqual(["Breadcrumbs", "GlobalHandlers", "LinkedErrors"]);
  });

  it("the client config passes the filter to init", () => {
    expect(read("sentry.client.config.ts")).toContain("integrations: withoutExtras");
  });
});

describe("instrumentation", () => {
  const source = read("src/instrumentation.ts");

  it("returns early without the DSN, loads the server config only for nodejs and the edge config only for edge", () => {
    expect(source).toMatch(/export async function register\(\) \{\s*if \(!process\.env\.NEXT_PUBLIC_SENTRY_DSN\) return;/);
    expect(source).toMatch(/NEXT_RUNTIME === "nodejs"\) await import\("\.\.\/sentry\.server\.config"\)/);
    expect(source).toMatch(/NEXT_RUNTIME === "edge"\) await import\("\.\.\/sentry\.edge\.config"\)/);
  });

  it("exports onRequestError, which does nothing without the DSN", () => {
    expect(source).toMatch(/export const onRequestError: Instrumentation\.onRequestError = async \(\.\.\.args\) => \{\s*if \(!process\.env\.NEXT_PUBLIC_SENTRY_DSN\) return;/);
  });

  it("register and onRequestError do nothing without a DSN", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register, onRequestError } = await import("@/instrumentation");
    await expect(register()).resolves.toBeUndefined();
    await expect(onRequestError(new Error("x"), { path: "/", method: "GET", headers: {} }, {} as never)).resolves.toBeUndefined();
  });

  it("the browser file imports the client config statically, before hydration", () => {
    expect(read("src/instrumentation-client.ts")).toMatch(/^import "\.\.\/sentry\.client\.config";$/m);
    expect(read("src/instrumentation-client.ts")).not.toContain("onRouterTransitionStart");
  });
});

describe("next.config.ts", () => {
  const source = read("next.config.ts");
  const FIELDS = ["headers", "outputFileTracingIncludes", "outputFileTracingRoot", "redirects", "serverExternalPackages", "transpilePackages"];

  it("is not wrapped without a DSN: today's fields only, and no source maps for the browser", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const config = (await import("../next.config")).default as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(FIELDS);
    expect(config).not.toHaveProperty("productionBrowserSourceMaps");
    expect(config.transpilePackages).toEqual(["@transpera-flow/engine", "@transpera-flow/db", "@transpera-flow/mcp"]);
    expect(config.serverExternalPackages).toEqual(["unpdf"]);
  });

  it("wraps with Sentry only when the DSN is set", () => {
    expect(source).toMatch(/export default process\.env\.NEXT_PUBLIC_SENTRY_DSN\?\.trim\(\)\s*\? withSentryConfig\(nextConfig,/);
    expect(source).toMatch(/:\s*nextConfig;/);
  });

  it("disables source maps unless all three build variables are set, and deletes them after upload", () => {
    expect(source).toContain("process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT");
    expect(source).toContain("sourcemaps: { disable: !sourceMaps, deleteSourcemapsAfterUpload: true }");
    expect(source).toContain("telemetry: false");
  });

  it("warns, rather than fails the build, when an upload fails", () => {
    expect(source).toMatch(/errorHandler: \(err\) => console\.warn\(/);
  });

  it("sets none of the options ADR 0017 rules out", () => {
    const code = source.replace(/\/\/.*$/gm, "");
    for (const word of ["tunnelRoute", "reactComponentAnnotation", "automaticVercelMonitors", "_experimental"]) expect(code, word).not.toContain(word);
  });

  it("with a DSN and no token the wrapped config does not turn browser source maps on", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    for (const v of BUILD_VARS) vi.stubEnv(v, "");
    const exported = (await import("../next.config")).default as unknown;
    const config = typeof exported === "function" ? await (exported as (phase: string) => unknown)("phase-production-build") : exported;
    expect((config as Record<string, unknown>).productionBrowserSourceMaps).not.toBe(true);
  });
});

describe("the money patterns", () => {
  it("packages/db exports ./money, and the scrubber imports it from there, not from the whole package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../packages/db/package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["./money"]).toBe("./src/money.ts");
    const scrub = read("src/lib/monitoring/scrub.ts");
    expect(scrub).toContain('from "@transpera-flow/db/money"');
    expect(scrub).not.toMatch(/from "@transpera-flow\/db"/);
  });
});
