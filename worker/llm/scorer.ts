/**
 * worker/llm/scorer.ts
 *
 * Scores listings for fit. Model: Haiku — this is high-volume filtering, not
 * writing.
 *
 * The prompt lives in scorer.prompt.md and is read at run time rather than
 * duplicated here, so tuning the rubric is editing prose, not code. Numbers are
 * interpolated from config and the environment; none are written into the prompt
 * text.
 *
 * Order of operations per row:
 *   1. prefilter — excludes only what the employer stated explicitly
 *   2. the model scores what survives, in batches
 *   3. validation in code, including forcing score 0 on any hard zero, because
 *      models routinely flag a disqualifier and then score the listing anyway
 */

import { readFile } from 'node:fs/promises';
import { db, selectAllRowsWhere } from '../lib/db.js';
import { getKnowledge } from '../lib/knowledge.js';
import { anthropic, parseJsonLoosely, textOf } from './client.js';
import {
  ALL_FLAGS,
  CASE_STUDIES,
  HARD_ZEROS,
  RESUME_VARIANTS,
  SCORING_CONFIG,
  commercial,
  type AnyFlag,
} from './config.js';
import { prefilter, truncateForScoring } from './prefilter.js';

const PROMPT_PATH = 'worker/llm/scorer.prompt.md';
const DESCRIPTION_BUDGET = 4000;

type Candidate = {
  id: string;
  source_id: string | null;
  title: string;
  company: string | null;
  location: string | null;
  comp_raw: string | null;
  description: string | null;
  apply_method: string | null;
};

export type ScoreResult = {
  score: number;
  reason: string;
  redFlags: AnyFlag[];
  resumeVariant: string | null;
  caseStudy: string | null;
};

export type ScorerStats = {
  considered: number;
  prefiltered: number;
  scored: number;
  passed: number;
  skipped: number;
  failed: number;
  apiCalls: number;
  prefilterReasons: Record<string, number>;
};

/**
 * Pulls the system prompt out of the markdown template — the first fenced block
 * after the "## System prompt" heading.
 */
export async function loadSystemPromptTemplate(path = PROMPT_PATH): Promise<string> {
  const md = await readFile(path, 'utf8');
  const heading = md.indexOf('## System prompt');
  if (heading === -1) throw new Error(`${path} has no "## System prompt" section.`);
  const open = md.indexOf('```', heading);
  const close = md.indexOf('```', open + 3);
  if (open === -1 || close === -1) throw new Error(`${path} system prompt is not fenced.`);
  return md.slice(open + 3, close).replace(/^[a-z]*\n/, '').trim();
}

export function interpolate(template: string, values: Record<string, string>): string {
  const missing: string[] = [];
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.push(key);
      return `{{${key}}}`;
    }
    return value;
  });
  // An un-substituted placeholder would reach the model as literal braces and
  // quietly degrade every score in the batch.
  if (missing.length > 0) {
    throw new Error(`Prompt placeholders were not supplied: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

export async function buildSystemPrompt(): Promise<string> {
  const c = commercial();
  return interpolate(await loadSystemPromptTemplate(), {
    PROFILE_MD: await getKnowledge('profile'),
    location: SCORING_CONFIG.location,
    timezone: SCORING_CONFIG.timezone,
    usEasternOverlapHours: String(SCORING_CONFIG.usEasternOverlapHours),
    europeOverlap: SCORING_CONFIG.europeOverlap,
    hoursPerWeek: String(SCORING_CONFIG.hoursPerWeek),
    earliestStartWeeks: String(SCORING_CONFIG.earliestStartWeeks),
    preferredContractTypes: SCORING_CONFIG.preferredContractTypes.join(', '),
    contractTypes: SCORING_CONFIG.contractTypes.join(', '),
    rateFloorHourlyUSD: String(c.rateFloorHourlyUSD),
    rateFloorMonthlyUSD: String(c.rateFloorMonthlyUSD),
    scoreThreshold: String(c.scoreThreshold),
  });
}

export function buildUserMessage(batch: Candidate[]): string {
  const blocks = batch.map((row) => {
    const id = row.source_id ?? row.id;
    return [
      `<listing id="${id}">`,
      `Title: ${row.title}`,
      `Company: ${row.company ?? 'unstated'}`,
      `Location field: ${row.location ?? 'empty'}`,
      `Comp field: ${row.comp_raw ?? 'not stated'}`,
      'Description:',
      truncateForScoring(row.description, DESCRIPTION_BUDGET),
      '</listing>',
    ].join('\n');
  });
  return `Score these ${batch.length} listings.\n\n${blocks.join('\n\n')}`;
}

const FLAG_SET = new Set<string>(ALL_FLAGS);
const HARD_ZERO_SET = new Set<string>(HARD_ZEROS);
const VARIANT_SET = new Set<string>(RESUME_VARIANTS);
const CASE_STUDY_SET = new Set<string>(CASE_STUDIES);

type RawScore = {
  source_id?: unknown;
  score?: unknown;
  reason?: unknown;
  red_flags?: unknown;
  suggested_resume_variant?: unknown;
  suggested_case_study?: unknown;
};

/**
 * Validates one returned object. Returns null when it cannot be trusted, which
 * quarantines that row rather than writing a number nobody can account for.
 */
export function validateScore(raw: RawScore, allowedIds: Set<string>): { id: string; result: ScoreResult } | null {
  const id = typeof raw.source_id === 'string' ? raw.source_id : null;
  if (id === null || !allowedIds.has(id)) return null;

  const scoreNumber = typeof raw.score === 'number' ? raw.score : Number(raw.score);
  if (!Number.isFinite(scoreNumber)) return null;
  let score = Math.round(scoreNumber);
  if (score < 0 || score > 100) return null;

  const flags: AnyFlag[] = Array.isArray(raw.red_flags)
    ? raw.red_flags.filter((f): f is AnyFlag => typeof f === 'string' && FLAG_SET.has(f))
    : [];

  // The invariant the prompt cannot enforce on its own. A listing flagged
  // region_restricted and scored 82 is scored 0.
  if (flags.some((f) => HARD_ZERO_SET.has(f))) score = 0;

  const variant =
    typeof raw.suggested_resume_variant === 'string' && VARIANT_SET.has(raw.suggested_resume_variant)
      ? raw.suggested_resume_variant
      : null;
  const caseStudy =
    typeof raw.suggested_case_study === 'string' && CASE_STUDY_SET.has(raw.suggested_case_study)
      ? raw.suggested_case_study
      : null;

  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 400) : '';

  return { id, result: { score, reason, redFlags: flags, resumeVariant: variant, caseStudy } };
}

async function scoreBatch(
  systemPrompt: string,
  batch: Candidate[],
): Promise<Map<string, ScoreResult> | null> {
  const allowedIds = new Set(batch.map((r) => r.source_id ?? r.id));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const message = await anthropic().messages.create({
      model: SCORING_CONFIG.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserMessage(batch) }],
    });

    const parsed = parseJsonLoosely<RawScore[]>(textOf(message));
    if (!Array.isArray(parsed)) {
      console.error(`  batch parse failed (attempt ${attempt})`);
      continue;
    }

    const results = new Map<string, ScoreResult>();
    let dropped = 0;
    for (const raw of parsed) {
      const validated = validateScore(raw, allowedIds);
      if (validated === null) dropped += 1;
      else results.set(validated.id, validated.result);
    }
    if (dropped > 0) console.error(`  dropped ${dropped} invalid object(s) from batch`);
    if (results.size > 0) return results;
    console.error(`  batch produced no usable objects (attempt ${attempt})`);
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runScore(limit?: number): Promise<ScorerStats> {
  const threshold = commercial().scoreThreshold;

  const rows = await selectAllRowsWhere<Candidate>(
    'opportunities',
    'id, source_id, title, company, location, comp_raw, description, apply_method',
    'status',
    'resolved',
  );
  const pending = limit === undefined ? rows : rows.slice(0, limit);

  const stats: ScorerStats = {
    considered: pending.length,
    prefiltered: 0,
    scored: 0,
    passed: 0,
    skipped: 0,
    failed: 0,
    apiCalls: 0,
    prefilterReasons: {},
  };

  // --- Stage 1: the pre-filter, which costs nothing -----------------------
  const survivors: Candidate[] = [];
  const excluded: { row: Candidate; flag: string; reason: string }[] = [];

  for (const row of pending) {
    const verdict = prefilter({ title: row.title, location: row.location, applyMethod: row.apply_method });
    if (verdict.pass) survivors.push(row);
    else {
      excluded.push({ row, flag: verdict.flag, reason: verdict.reason });
      stats.prefilterReasons[verdict.flag] = (stats.prefilterReasons[verdict.flag] ?? 0) + 1;
    }
  }
  stats.prefiltered = excluded.length;

  // Excluded rows share an outcome per flag, so they update in one statement each.
  const byFlag = new Map<string, string[]>();
  for (const e of excluded) {
    const ids = byFlag.get(e.flag) ?? [];
    ids.push(e.row.id);
    byFlag.set(e.flag, ids);
  }
  for (const [flag, ids] of byFlag) {
    for (const part of chunk(ids, 200)) {
      const { error } = await db()
        .from('opportunities')
        .update({
          score: 0,
          score_reason: `excluded before scoring: ${flag}`,
          red_flags: flag === 'role_mismatch' ? [] : [flag],
          status: 'skipped',
        })
        .in('id', part);
      if (error) console.error(`  prefilter update failed: ${error.message}`);
      else stats.skipped += part.length;
    }
  }

  if (survivors.length === 0) return stats;

  // --- Stage 2: score what is left ---------------------------------------
  //
  // Construct the client before touching a single batch. Without this, a missing
  // API key surfaced once per batch and each failure quarantined ten perfectly
  // good rows as 'failed' — 37 rows written off over a misconfiguration. Fail
  // here instead, before anything is marked.
  anthropic();
  const systemPrompt = await buildSystemPrompt();

  for (const batch of chunk(survivors, SCORING_CONFIG.listingsPerCall)) {
    stats.apiCalls += 1;
    // Deliberately not wrapped. An exception here is a transport, auth or quota
    // problem, not the model returning nonsense, and those rows deserve a retry on
    // the next run rather than a status that excludes them for good. The SDK has
    // already retried three times by this point, so the stage aborting is right.
    const results = await scoreBatch(systemPrompt, batch);

    if (results === null) {
      // Quarantine the batch and keep going. Never crash the run.
      const ids = batch.map((r) => r.id);
      await db().from('opportunities').update({ status: 'failed', error: 'scorer returned unusable output' }).in('id', ids);
      stats.failed += ids.length;
      continue;
    }

    for (const row of batch) {
      const key = row.source_id ?? row.id;
      const result = results.get(key);
      if (result === undefined) {
        await db().from('opportunities')
          .update({ status: 'failed', error: 'scorer omitted this listing from its response' })
          .eq('id', row.id);
        stats.failed += 1;
        continue;
      }

      const passes = result.score >= threshold;
      const { error } = await db()
        .from('opportunities')
        .update({
          score: result.score,
          score_reason: result.reason,
          red_flags: result.redFlags,
          resume_variant: passes ? result.resumeVariant : null,
          case_study_used: passes ? result.caseStudy : null,
          status: passes ? 'scored' : 'skipped',
        })
        .eq('id', row.id);
      if (error) console.error(`  score update failed for ${row.id}: ${error.message}`);

      stats.scored += 1;
      if (passes) stats.passed += 1;
      else stats.skipped += 1;
    }
  }

  return stats;
}
