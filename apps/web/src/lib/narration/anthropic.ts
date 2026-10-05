import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AiDraft, AiDraftRequest, AiModel } from "@/lib/ai/analyse";
import { NarrationError, type Draft, type DraftRequest, type NarrationModel } from "./narrate";
import { OUTPUT_SCHEMA } from "./prompt";

// Claude as the narrator (issue #29; docs/PRD.md §7.3, §10 "LLM calls:
// Anthropic API from server routes only, on demand, cached"). Server-only:
// the key is read from the server's environment (`ANTHROPIC_API_KEY`, set on
// Vercel for Production and Preview) and never reaches a browser. One request
// per draft, no SDK retries (the caller redrafts at most once and falls back
// to the template), structured output for the paragraphs, and the facts
// block cached so a redraft reuses it. Opus 5.5 always thinks; effort
// "medium" keeps a draft to well under the per-attempt timeout.
//
// The AI analysis (issue #111, A46) is a second caller of the same request, with its own schema. This is the one
// module that holds the key (a test enforces that), so the analyst's model lives here too.

/** The model narration and AI analysis use: the latest Claude per the repo's claude-api guidance. */
export const NARRATION_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 8000;

export function narrationConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface Request {
  system: string;
  facts: string;
  instruction: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
}

/** One structured request: the text Claude wrote, the model that wrote it and the tokens used. Failures become NarrationErrors. */
async function ask(client: Anthropic, req: Request): Promise<{ text: string; model: string; usage: NonNullable<Draft["usage"]> }> {
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model: NARRATION_MODEL,
        max_tokens: MAX_TOKENS,
        // A request declined by a safety classifier is re-run on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
        system: req.system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.facts, cache_control: { type: "ephemeral" } },
              { type: "text", text: req.instruction },
            ],
          },
        ],
      },
      { timeout: req.timeoutMs },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new NarrationError("timeout", "timed out");
    if (err instanceof Anthropic.AuthenticationError) throw new NarrationError("unavailable", "the server's Anthropic API key was refused");
    if (err instanceof Anthropic.RateLimitError) throw new NarrationError("error", "rate limited");
    if (err instanceof Anthropic.APIError) throw new NarrationError("error", `API error ${err.status ?? ""}`.trim());
    throw new NarrationError("error", err instanceof Error ? err.message : String(err));
  }
  if (response.stop_reason === "refusal") throw new NarrationError("refused", "declined");
  if (response.stop_reason === "max_tokens") throw new NarrationError("error", "the draft ran past its length limit");
  return {
    text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Claude, or null when the server has no key (narration then falls back to the template, saying why). */
export function anthropicNarrator(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY, options: { fetch?: typeof fetch } = {}): NarrationModel | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, maxRetries: 0, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    name: NARRATION_MODEL,
    async draft(req: DraftRequest): Promise<Draft> {
      const { text, model, usage } = await ask(client, {
        system: req.system,
        facts: req.facts,
        instruction: req.instruction,
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        timeoutMs: req.timeoutMs,
      });
      let paragraphs: string[] = [];
      try {
        const parsed = JSON.parse(text) as { paragraphs?: unknown };
        if (Array.isArray(parsed.paragraphs)) paragraphs = parsed.paragraphs.filter((p): p is string => typeof p === "string");
      } catch {
        throw new NarrationError("error", "the draft wasn't valid JSON");
      }
      return { paragraphs, model, usage };
    },
  };
}

/** Claude as the AI analyst (issue #111, A46), or null when the server has no key. The same request, with the analysis schema. */
export function anthropicAnalyst(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY, options: { fetch?: typeof fetch } = {}): AiModel | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, maxRetries: 0, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return {
    name: NARRATION_MODEL,
    async draft(req: AiDraftRequest): Promise<AiDraft> {
      const { text, model, usage } = await ask(client, { ...req, schema: req.schema as unknown as Record<string, unknown> });
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new NarrationError("error", "the draft wasn't valid JSON");
      }
      return { output, model, usage };
    },
  };
}
