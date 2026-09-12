/**
 * worker/llm/client.ts
 *
 * Anthropic client, plus the defensive JSON parsing every call needs.
 *
 * A malformed response must never take down a run. The spec is explicit: quarantine
 * the batch to status 'failed' and carry on, because a stage that crashes on one bad
 * response stops processing everything behind it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { requireString } from '../lib/env.js';

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (client) return client;
  client = new Anthropic({
    apiKey: requireString('ANTHROPIC_API_KEY', 'Required by the scorer and the drafter.'),
    maxRetries: 3,
  });
  return client;
}

/** Concatenates the text blocks of a response, ignoring any other block type. */
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Strips the markdown fence the model is told not to add and sometimes adds
 * anyway, then parses. Returns null rather than throwing — the caller decides
 * whether to retry or quarantine.
 */
export function parseJsonLoosely<T = unknown>(raw: string): T | null {
  let text = raw.trim();

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // Occasionally a sentence precedes or follows the JSON. Take the outermost
    // bracketed span and try that before giving up.
    const firstArray = text.indexOf('[');
    const firstObject = text.indexOf('{');
    const start =
      firstArray === -1 ? firstObject : firstObject === -1 ? firstArray : Math.min(firstArray, firstObject);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
