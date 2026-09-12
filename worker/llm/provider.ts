/**
 * worker/llm/provider.ts
 *
 * One small interface between the scorer and whichever model scores.
 *
 * The scorer is high-volume filtering — hundreds of listings, throwaway JSON — so
 * it runs on Gemini Flash, where the free tier can cover the whole load. The
 * drafter stays on Claude: it is a handful of calls a day and the one output a
 * human reads and judges.
 *
 * The two providers disagree about JSON in ways that would otherwise leak into the
 * stage. Gemini constrains the response to a schema server-side and returns the
 * text on `output_text`; Anthropic returns content blocks and is asked for JSON in
 * the prompt, so it occasionally wraps the array in a markdown fence. Keeping that
 * behind `completeJson` means switching provider is an env var, not a rewrite of
 * runScore.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { optionalString, requireString } from '../lib/env.js';
import { parseJsonLoosely } from './client.js';

/** A JSON Schema object, loose by design — each provider supports its own subset. */
export type JsonSchema = Record<string, unknown>;

export type JsonRequest = {
  system: string;
  user: string;
  /** Honoured where the provider can enforce it; advisory otherwise. */
  schema: JsonSchema;
  maxOutputTokens: number;
};

export type JsonResult = {
  /** Parsed JSON, or null when the response could not be parsed. */
  value: unknown | null;
  /** Provider status where it reports one: "completed", "incomplete", ... */
  status: string;
  /**
   * The response was cut short by the token budget. Worth separating from
   * "unparseable": retrying a truncated response with the same budget produces the
   * same truncation, and the first version of this cost two identical calls per
   * batch while reporting only "batch parse failed".
   */
  truncated: boolean;
};

export type JsonModel = {
  /** For logs and the score report, e.g. "gemini:gemini-3.5-flash". */
  readonly label: string;
  completeJson(request: JsonRequest): Promise<JsonResult>;
};

// --- Gemini -----------------------------------------------------------------

/**
 * Default scoring model. Flash rather than Flash-Lite: the rubric has six weighted
 * dimensions and calibration anchors, which is judgement rather than lookup.
 * Flash-Lite is the cheaper swap if the scores hold up.
 */
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

/**
 * The free tier allows 20 requests per minute. Six batches is comfortably inside
 * that, but a re-run after a failure, or a batch that splits, can cross it — and
 * the error is a 429 that aborts the stage. Two mitigations:
 *
 *   - a minimum interval between calls, so a normal run paces itself
 *   - bounded retry that honours the delay the API asks for
 *
 * Both are here rather than in the scorer because they are properties of this
 * provider's tier, not of scoring.
 */
const GEMINI_MIN_INTERVAL_MS = 3_200; // 20 rpm with headroom
const GEMINI_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err: unknown) {
      if (!isRateLimit(err) || attempt >= GEMINI_MAX_ATTEMPTS) throw err;
      const wait = retryDelayMs(err, attempt);
      console.log(`  rate limited; waiting ${(wait / 1000).toFixed(1)}s (attempt ${attempt})`);
      await sleep(wait);
    }
  }
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 429;
}

/** The message carries "Please retry in 28.4s"; prefer it over a guess. */
function retryDelayMs(err: unknown, attempt: number): number {
  const message = err instanceof Error ? err.message : String(err);
  const m = /retry in ([0-9.]+)s/i.exec(message);
  if (m?.[1] !== undefined) {
    const seconds = Number(m[1]);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000) + 500;
  }
  return Math.min(60_000, 5_000 * 2 ** (attempt - 1));
}

function geminiModel(): JsonModel {
  const modelId = optionalString('GEMINI_MODEL') ?? GEMINI_DEFAULT_MODEL;
  let client: GoogleGenAI | undefined;
  let lastCallAt = 0;

  return {
    label: `gemini:${modelId}`,
    async completeJson(request: JsonRequest): Promise<JsonResult> {
      client ??= new GoogleGenAI({
        apiKey: requireString('GEMINI_API_KEY', 'Required by the scorer when SCORER_PROVIDER=gemini.'),
      });

      const since = Date.now() - lastCallAt;
      if (lastCallAt !== 0 && since < GEMINI_MIN_INTERVAL_MS) {
        await sleep(GEMINI_MIN_INTERVAL_MS - since);
      }

      const interaction = await withRateLimitRetry(() => {
        lastCallAt = Date.now();
        return client!.interactions.create({
        model: modelId,
        input: request.user,
        system_instruction: request.system,
        // Schema-constrained output. This is why Gemini is a good fit for the
        // scorer specifically: the shape is enforced rather than requested.
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: request.schema,
        },
        generation_config: {
          // snake_case here; the interactions surface does not camelCase this one.
          max_output_tokens: request.maxOutputTokens,
          /**
           * Thinking tokens are charged against max_output_tokens, and the default
           * depth is generous: one trivial listing burned 465 thought tokens
           * against a 512 budget and returned JSON truncated mid-string, with
           * status "incomplete". Scoring against a fixed rubric needs some
           * reasoning but not that much, so the depth is pinned low and the ceiling
           * raised. Gemini 3.5 rejects the older thinking_budget outright.
           *
           * Lowercase. The SDK's ThinkingLevel enum spells these upper case, but
           * the API rejects 'LOW' with a 400 and asks for 'low'.
           */
          thinking_level: 'low',
        },
        });
      });

      const status = interaction.status ?? 'unknown';
      // Still routed through the tolerant parser: a schema does not save a response
      // that ran out of budget mid-object.
      return {
        value: parseJsonLoosely(interaction.output_text ?? ''),
        status,
        truncated: status === 'incomplete' || status === 'budget_exceeded',
      };
    },
  };
}

// --- Anthropic --------------------------------------------------------------

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';

function anthropicModel(): JsonModel {
  const modelId = optionalString('ANTHROPIC_SCORER_MODEL') ?? ANTHROPIC_DEFAULT_MODEL;
  let client: Anthropic | undefined;

  return {
    label: `anthropic:${modelId}`,
    async completeJson(request: JsonRequest): Promise<JsonResult> {
      client ??= new Anthropic({
        apiKey: requireString('ANTHROPIC_API_KEY', 'Required by the scorer when SCORER_PROVIDER=anthropic.'),
        maxRetries: 3,
      });

      const message = await client.messages.create({
        model: modelId,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      });

      // No server-side schema here; the shape is asked for in the prompt, so the
      // fence-stripping in parseJsonLoosely is load-bearing on this path.
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const stop = message.stop_reason ?? 'unknown';
      return {
        value: parseJsonLoosely(text),
        status: stop,
        truncated: stop === 'max_tokens',
      };
    },
  };
}

// --- Selection --------------------------------------------------------------

export type ProviderName = 'gemini' | 'anthropic';

let cached: JsonModel | undefined;

/**
 * Which model scores. Defaults to Gemini; set SCORER_PROVIDER=anthropic to switch
 * back without touching the stage.
 */
export function scoringModel(): JsonModel {
  if (cached) return cached;

  const requested = (optionalString('SCORER_PROVIDER') ?? 'gemini').toLowerCase();
  if (requested !== 'gemini' && requested !== 'anthropic') {
    throw new Error(
      `SCORER_PROVIDER must be "gemini" or "anthropic", got ${JSON.stringify(requested)}.`,
    );
  }

  cached = requested === 'gemini' ? geminiModel() : anthropicModel();
  return cached;
}

/** Test seam. */
export function resetScoringModel(): void {
  cached = undefined;
}

/**
 * Response shape for the scorer.
 *
 * Deliberately permissive: only the three fields that must exist are required, and
 * the two suggestion fields are plain strings rather than nullable enums. Gemini
 * supports a subset of JSON Schema and rejects schemas it cannot represent, and a
 * rejected schema fails the whole batch. validateScore already drops unknown flags,
 * out-of-range scores and case studies that are not in the allowed list, so the
 * schema's job here is to get well-formed JSON back, not to be the validator.
 */
export function scorerSchema(flags: readonly string[]): JsonSchema {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        score: { type: 'integer' },
        reason: { type: 'string' },
        red_flags: { type: 'array', items: { type: 'string', enum: [...flags] } },
        suggested_resume_variant: { type: 'string' },
        suggested_case_study: { type: 'string' },
      },
      required: ['source_id', 'score', 'reason'],
    },
  };
}
