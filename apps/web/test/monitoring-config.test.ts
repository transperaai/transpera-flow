import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    // sendDefaultPii: false alone still collects filtered headers, cookies, query strings and frame variables in 10.x: every
    // category is turned off at collection, not only removed by the scrubber.
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.enhanceFetchErrorMessages).toBe(false);
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

  it("the client's integration filter removes tracing, replay, feedback, profiling and sessions and keeps the rest", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const { withoutExtras } = await import("../sentry.client.config");
    const names = ["Breadcrumbs", "BrowserTracing", "Replay", "ReplayCanvas", "Feedback", "BrowserProfiling", "BrowserSession", "GlobalHandlers", "LinkedErrors"];
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

  it("has no instrumentation-client file, which every build would bundle: the client config is injected only with a DSN", () => {
    for (const file of ["src/instrumentation-client.ts", "src/instrumentation-client.js", "instrumentation-client.ts", "instrumentation-client.js"]) {
      expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(false);
    }
  });
});

describe("the browser bundle without a DSN", () => {
  // Every file under src/ that a page could bundle. Only sentry.client.config.ts (outside src/, injected with a DSN) loads the SDK;
  // src/ may name it in types (`import type`) and on the server (instrumentation.ts loads it only with a DSN).
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
  const src = fileURLToPath(new URL("../src", import.meta.url));

  it("no file under src/ imports the Sentry SDK at the top level, except as types", () => {
    for (const file of files(src)) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/^import (?!type )[^;]*from "@sentry\//m);
      expect(code, file).not.toMatch(/^import "@sentry\//m);
    }
  });

  it("the error screens report through lib/monitoring/report.ts, which the client config fills in", async () => {
    for (const file of ["src/app/global-error.tsx", "src/app/w/[slug]/error.tsx", "src/app/demo/error.tsx"]) {
      expect(read(file), file).toContain('import { reportError } from "@/lib/monitoring/report";');
    }
    expect(read("sentry.client.config.ts")).toMatch(/if \(options\) setErrorReporter\(\(error\) => Sentry\.captureException\(error\)\);/);
    const { reportError, setErrorReporter } = await import("@/lib/monitoring/report");
    expect(() => reportError(new Error("x"))).not.toThrow();
    const seen: unknown[] = [];
    setErrorReporter((e) => seen.push(e));
    const error = new Error("y");
    reportError(error);
    expect(seen).toEqual([error]);
  });
});

describe("next.config.ts", () => {
  const source = read("next.config.ts");
  const FIELDS = ["headers", "outputFileTracingIncludes", "outputFileTracingRoot", "redirects", "serverExternalPackages", "transpilePackages"];

  it("is not wrapped without a DSN: today's fields only, no source maps for the browser, and no client config injected", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const config = (await import("../next.config")).default as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(FIELDS);
    expect(config).not.toHaveProperty("productionBrowserSourceMaps");
    expect(config).not.toHaveProperty("instrumentationClientInject");
    expect(config.transpilePackages).toEqual(["@transpera-flow/engine", "@transpera-flow/db", "@transpera-flow/mcp"]);
    expect(config.serverExternalPackages).toEqual(["unpdf"]);
  });

  it("wraps with Sentry only when the DSN is set", () => {
    expect(source).toMatch(/export default process\.env\.NEXT_PUBLIC_SENTRY_DSN\?\.trim\(\) \? withSentry\(nextConfig\) : nextConfig;/);
  });

  it("with a DSN: injects the client config before hydration, drops the trace meta tags and the route list", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    for (const v of BUILD_VARS) vi.stubEnv(v, "");
    const config = (await import("../next.config")).default as { instrumentationClientInject?: string[]; experimental?: Record<string, unknown> };
    expect(config.instrumentationClientInject).toEqual(["./sentry.client.config.ts"]);
    expect(existsSync(new URL("../sentry.client.config.ts", import.meta.url))).toBe(true);
    expect(config.experimental ?? {}).not.toHaveProperty("clientTraceMetadata");
    expect(source).toContain("routeManifestInjection: false");
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
