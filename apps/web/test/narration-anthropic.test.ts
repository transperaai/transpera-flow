import { describe, expect, it, vi } from "vitest";
import { anthropicNarrator, NARRATION_MODEL } from "@/lib/narration/anthropic";
import { NarrationError, type DraftRequest } from "@/lib/narration/narrate";

vi.mock("server-only", () => ({}));

// The Claude client (issue #29) against a fake `fetch`: the request it sends
// (model, structured output, the cached facts block, the refusal fallback,
// no SDK retries) and how it reads answers and failures. No network: the
// real API is never called from tests or CI.

const req: DraftRequest = { purpose: "explain", system: "SYSTEM", facts: 'Facts (JSON):\n{"a":1}', instruction: "Write it.", timeoutMs: 45_000 };

function fakeFetch(respond: (body: Record<string, unknown>, headers: Headers) => Response) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url: String(input), body, headers });
    return respond(body, headers);
  }) as typeof fetch;
  return { f, seen };
}

const message = (text: string, extra: Record<string, unknown> = {}) =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: NARRATION_MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2500, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    ...extra,
  });

describe("anthropicNarrator", () => {
  it("is null without a key, so narration falls back without calling anything", () => {
    expect(anthropicNarrator(undefined)).toBeNull();
    expect(anthropicNarrator("")).toBeNull();
  });

  it("sends the latest Claude, structured output, the facts as a cached block and the refusal fallback; reads the paragraphs", async () => {
    const { f, seen } = fakeFetch(() => message(JSON.stringify({ paragraphs: ["One.", "Two."] })));
    const draft = await anthropicNarrator("sk-test", { fetch: f })!.draft(req);
    expect(draft).toEqual({ paragraphs: ["One.", "Two."], model: NARRATION_MODEL, usage: { inputTokens: 2500, outputTokens: 400, cacheReadTokens: 2000, cacheWriteTokens: 0 } });
    expect(seen).toHaveLength(1);
    const { url, body, headers } = seen[0]!;
    expect(url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect(body.system).toBe("SYSTEM");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: req.facts, cache_control: { type: "ephemeral" } },
          { type: "text", text: "Write it." },
        ],
      },
    ]);
    expect(body).not.toHaveProperty("temperature");
  });

  it("gives up at the per-draft timeout", async () => {
    const hang = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const err = await anthropicNarrator("sk-test", { fetch: hang })!.draft({ ...req, timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrationError);
    expect((err as NarrationError).kind).toBe("timeout");
  });

  it("turns refusals, length cut-offs, bad JSON and API errors into narration errors, without retrying", async () => {
    const cases: [Response, NarrationError["kind"]][] = [
      [message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }), "refused"],
      [message('{"paragraphs": ["cut', { stop_reason: "max_tokens" }), "error"],
      [message("not json"), "error"],
      [Response.json({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: 401 }), "unavailable"],
      [Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: 529 }), "error"],
    ];
    for (const [response, kind] of cases) {
      const { f, seen } = fakeFetch(() => response.clone());
      const err = await anthropicNarrator("sk-test", { fetch: f })!.draft(req).catch((e: unknown) => e);
      expect(err, kind).toBeInstanceOf(NarrationError);
      expect((err as NarrationError).kind).toBe(kind);
      expect(seen, kind).toHaveLength(1);
    }
  });
});
