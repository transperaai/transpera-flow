import { describe, expect, it, vi } from "vitest";

// Global security headers (security review): no framing, no sniffing, an origin-only cross-site Referer; /s/* keeps its own.

describe("next.config.ts headers", () => {
  it("sends the security headers on every path, and /s/* still sends no Referer, no cache and noindex", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const config = (await import("../next.config")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = await config.headers();
    // What a path gets: every matching rule in order, a later key overriding an earlier one (Next's rule).
    const matches = (source: string, path: string) => new RegExp(`^${source.replace(/\/:path\*$/, "(?:/.*)?")}$`).test(path) || (source === "/:path*" && path === "/");
    const headersFor = (path: string) => Object.fromEntries(rules.filter((r) => matches(r.source, path)).flatMap((r) => r.headers.map((h) => [h.key, h.value])));
    for (const path of ["/", "/login", "/w/northbeam/p/x", "/api/mcp"]) {
      expect(headersFor(path), path).toEqual({
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
    }
    expect(headersFor("/s/abc")).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    // The /s/* rule comes after the global one, so its Referrer-Policy wins.
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/s/:path*"]);
  });
});
