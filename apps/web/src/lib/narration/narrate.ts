// Drafting narration and checking it (issue #29; docs/PRD.md §7.3, D15):
// ask the model for a draft, check every number against the facts, redraft
// once naming the numbers that failed, and otherwise fall back to the
// templated text with the reason. Pure apart from the injected model and
// clock, so tests run it with deterministic fakes and never call the API.

import { restoreNames, type NarrationInput, type NarrationPurpose } from "./facts";
import { checkNumbers, type CheckContext, type NumberProblem } from "./numbers";
import { factsMessage, instruction, systemPrompt } from "./prompt";

export interface DraftRequest {
  purpose: NarrationPurpose;
  system: string;
  /** The facts block (the cached prefix). */
  facts: string;
  instruction: string;
  timeoutMs: number;
}

export interface Draft {
  paragraphs: string[];
  /** The model that wrote it (a server-side fallback may name another). */
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number } | null;
}

/** A model that drafts narration: Claude in production (anthropic.ts), fakes in tests, the stand-in on /demo. */
export interface NarrationModel {
  readonly name: string;
  draft(request: DraftRequest): Promise<Draft>;
}

/** Why a draft couldn't be had; the templated text prints instead. */
export class NarrationError extends Error {
  constructor(
    readonly kind: "refused" | "timeout" | "error" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Time for one draft, and for the drafts together (under the narrate route's 120 s). */
export const NARRATION_ATTEMPT_MS = 45_000;
export const NARRATION_BUDGET_MS = 75_000;
const MAX_PARAGRAPHS = 8;
const MAX_CHARS = 6000;

export type FallbackKind = "invalid" | "refused" | "timeout" | "error" | "unavailable";

export interface NarrationOutcome {
  source: "narration" | "template";
  /** The text to print (real names). */
  paragraphs: string[];
  /** The narration passed the number check (false when the template printed). */
  validated: boolean;
  fallback: boolean;
  fallbackKind: FallbackKind | null;
  /** In words, for the appendix and the UI. */
  reason: string | null;
  /** The model that wrote the printed narration (or the last one tried). */
  model: string | null;
  /** Drafts rejected by the check, with the numbers that failed. */
  rejected: { paragraphs: string[]; problems: NumberProblem[] }[];
  /** Numbers in the printed text, each matched to a fact. */
  checked: number;
  usage: NonNullable<Draft["usage"]>[];
}

/** Shape problems: an empty draft, or one too long for a summary. */
function shapeProblems(paragraphs: unknown): NumberProblem[] {
  if (!Array.isArray(paragraphs) || !paragraphs.length || !paragraphs.every((p) => typeof p === "string" && p.trim())) {
    return [{ text: "(the draft)", reason: "it wasn't a list of paragraphs" }];
  }
  if (paragraphs.length > MAX_PARAGRAPHS) return [{ text: "(the draft)", reason: `it had more than ${MAX_PARAGRAPHS} paragraphs` }];
  if (paragraphs.join("").length > MAX_CHARS) return [{ text: "(the draft)", reason: `it was longer than ${MAX_CHARS} characters` }];
  return [];
}

/** Check text against a context: shape and every number. */
export function checkText(paragraphs: string[], ctx: CheckContext) {
  const shape = shapeProblems(paragraphs);
  if (shape.length) return { ok: false, numbers: [], problems: shape };
  return checkNumbers(paragraphs.join("\n\n"), ctx);
}

const listProblems = (p: NumberProblem[]) =>
  p
    .slice(0, 4)
    .map((x) => `“${x.text}” (${x.reason})`)
    .join(", ") + (p.length > 4 ? ` and ${p.length - 4} more` : "");

/** Draft, check, redraft once, or fall back to the template. Never throws. */
export async function narrate(
  input: NarrationInput,
  model: NarrationModel | null,
  { budgetMs = NARRATION_BUDGET_MS, attemptMs = NARRATION_ATTEMPT_MS, now = () => Date.now() }: { budgetMs?: number; attemptMs?: number; now?: () => number } = {},
): Promise<NarrationOutcome> {
  const fallback = (kind: FallbackKind, reason: string, extra: Partial<NarrationOutcome> = {}): NarrationOutcome => ({
    source: "template",
    paragraphs: input.template,
    validated: false,
    fallback: true,
    fallbackKind: kind,
    reason,
    model: model?.name ?? null,
    rejected: [],
    checked: 0,
    usage: [],
    ...extra,
  });
  if (!model) return fallback("unavailable", "narration isn't configured on this server (no Anthropic API key)");

  const started = now();
  const rejected: NarrationOutcome["rejected"] = [];
  const usage: NarrationOutcome["usage"] = [];
  let lastModel = model.name;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budgetMs - (now() - started);
    if (left < 5_000) return fallback("timeout", "there wasn't time to redraft within the request's limit", { rejected, usage, model: lastModel });
    let draft: Draft;
    try {
      draft = await model.draft({
        purpose: input.purpose,
        system: systemPrompt(input.purpose),
        facts: factsMessage(input.payload),
        instruction: instruction(input.purpose, rejected[rejected.length - 1]),
        timeoutMs: Math.min(attemptMs, left),
      });
    } catch (err) {
      const e = err instanceof NarrationError ? err : new NarrationError("error", err instanceof Error ? err.message : String(err));
      const reason =
        e.kind === "refused"
          ? "the model declined to write it"
          : e.kind === "timeout"
            ? "the model didn't answer in time"
            : e.kind === "unavailable"
              ? e.message
              : `the model couldn't be reached (${e.message})`;
      return fallback(e.kind, reason, { rejected, usage, model: lastModel });
    }
    lastModel = draft.model;
    if (draft.usage) usage.push(draft.usage);
    const result = checkText(draft.paragraphs, input.check);
    if (result.ok) {
      return {
        source: "narration",
        paragraphs: draft.paragraphs.map((p) => restoreNames(p.trim(), input.aliases)),
        validated: true,
        fallback: false,
        fallbackKind: null,
        reason: null,
        model: draft.model,
        rejected,
        checked: result.numbers.length,
        usage,
      };
    }
    rejected.push({ paragraphs: Array.isArray(draft.paragraphs) ? draft.paragraphs : [], problems: result.problems });
  }
  const last = rejected[rejected.length - 1]!;
  return fallback("invalid", `both drafts cited figures not in the run: ${listProblems(last.problems)}`, { rejected, usage, model: lastModel });
}
