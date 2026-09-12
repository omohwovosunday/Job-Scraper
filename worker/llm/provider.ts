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

export type JsonModel = {
  /** For logs and the score report, e.g. "gemini:gemini-3.5-flash". */
  readonly label: string;
  /** Parsed JSON, or null when the response could not be parsed at all. */
  completeJson(request: JsonRequest): Promise<unknown>;
};

// --- Gemini -----------------------------------------------------------------

/**
 * Default scoring model. Flash rather than Flash-Lite: the rubric has six weighted
 * dimensions and calibration anchors, which is judgement rather than lookup.
 * Flash-Lite is the cheaper swap if the scores hold up.
 */
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

function geminiModel(): JsonModel {
  const modelId = optionalString('GEMINI_MODEL') ?? GEMINI_DEFAULT_MODEL;
  let client: GoogleGenAI | undefined;

  return {
    label: `gemini:${modelId}`,
    async completeJson(request: JsonRequest): Promise<unknown> {
      client ??= new GoogleGenAI({
        apiKey: requireString('GEMINI_API_KEY', 'Required by the scorer when SCORER_PROVIDER=gemini.'),
      });

      const interaction = await client.interactions.create({
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
        // snake_case here; the interactions surface does not camelCase this one.
        generation_config: { max_output_tokens: request.maxOutputTokens },
      });

      // Still routed through the tolerant parser. Schema constraints do not save a
      // response that was cut off at the token limit.
      return parseJsonLoosely(interaction.output_text ?? '');
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
    async completeJson(request: JsonRequest): Promise<unknown> {
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
      return parseJsonLoosely(text);
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
