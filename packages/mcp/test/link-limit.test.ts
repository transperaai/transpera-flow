import { afterEach, describe, expect, it, vi } from "vitest";
import { takeLinkFetch } from "../src";

// The link limit's answers, with a stand-in for the database call (the real counter is tested in packages/db and over PostgREST).

const ctxReturning = (result: { data: unknown; error: { code?: string; message?: string } | null }) => ({ db: { rpc: async () => result } }) as never;

afterEach(() => vi.restoreAllMocks());

describe("takeLinkFetch", () => {
  it("allows a fetch the database counts, and says how long to wait otherwise", async () => {
    expect(await takeLinkFetch(ctxReturning({ data: 0, error: null }))).toEqual({ allowed: true });
    expect(await takeLinkFetch(ctxReturning({ data: 1, error: null }))).toEqual({ allowed: false, message: "You've opened 10 links in the last minute. Try again in 1 second." });
    expect(await takeLinkFetch(ctxReturning({ data: 42, error: null }))).toMatchObject({ allowed: false, message: expect.stringContaining("42 seconds") });
  });

  it("fails open when the function is missing, and logs a tagged warning so it is visible", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const code of ["PGRST202", "42883"]) {
      expect(await takeLinkFetch(ctxReturning({ data: null, error: { code, message: "missing" } }))).toEqual({ allowed: true });
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[link-limit\] take_link_fetch is missing/);
  });

  it("fails closed on any other error, without logging a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await takeLinkFetch(ctxReturning({ data: null, error: { code: "XX000", message: "boom" } }))).toMatchObject({ allowed: false });
    expect(warn).not.toHaveBeenCalled();
  });
});
