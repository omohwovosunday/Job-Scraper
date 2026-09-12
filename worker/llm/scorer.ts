/**
 * worker/llm/scorer.ts
 *
 * Scores listings for fit. High-volume filtering, not writing, so it runs on
 * Gemini Flash by default — see provider.ts. The stage never touches an SDK: which
 * model scores is an env var, because the two providers disagree about how JSON
 * comes back and that disagreement should not reach this file.
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
import { caseStudyKey, getKnowledge } from '../lib/knowledge.js';
import { scoringModel, scorerSchema, type JsonModel } from './provider.js';
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

/** Pulls one "## Heading" section out of a case study, without its heading. */
export function extractSection(markdown: string, heading: string): string | null {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const after = markdown.indexOf('\n', start);
  if (after === -1) return null;
  const next = markdown.indexOf('\n## ', after);
  const body = (next === -1 ? markdown.slice(after) : markdown.slice(after, next)).trim();
  return body.length === 0 ? null : body;
}

/**
 * A compact index of what each case study covers, for the scorer to match against.
 *
 * The prompt has always told the model to "consult the `Applies to` line of each
 * case study" — and never supplied one. It knew four slugs by name and nothing
 * about their contents, so it omitted suggested_case_study entirely, which would
 * have left the drafter with no project to open a letter with. Knowledge §7 is
 * explicit that the `Applies to` line is the matching surface, so that is what
 * goes in, plus the sector for context.
 *
 * Deliberately not the full text. The scorer needs to pick one from four; the
 * drafter gets the chosen study in full, which is where the detail earns its
 * tokens. This adds roughly 700 characters to a prompt sent once per batch.
 */
export async function buildCaseStudyIndex(): Promise<string> {
  const entries: string[] = [];
  for (const slug of CASE_STUDIES) {
    const md = await getKnowledge(caseStudyKey(slug));
    const appliesTo = extractSection(md, 'Applies to');
    const sector = /^\*\*Sector:\*\*\s*(.+)$/m.exec(md)?.[1]?.trim() ?? null;

    // A study with no Applies-to line cannot be matched on, and silently offering
    // it would be worse than leaving it out.
    if (appliesTo === null) {
      console.error(`  case study "${slug}" has no Applies to section; omitted from the index`);
      continue;
    }
    const oneLine = appliesTo.replace(/\s+/g, ' ').trim();
    entries.push(`- ${slug}${sector === null ? '' : ` (${sector})`}: ${oneLine}`);
  }
  if (entries.length === 0) throw new Error('No case studies have an Applies to section.');
  return entries.join('\n');
}

export async function buildSystemPrompt(): Promise<string> {
  const c = commercial();
  return interpolate(await loadSystemPromptTemplate(), {
    PROFILE_MD: await getKnowledge('profile'),
    CASE_STUDY_INDEX: await buildCaseStudyIndex(),
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
    juniorRateFloorHourlyUSD: String(c.juniorRateFloorHourlyUSD),
    juniorRateFloorMonthlyUSD: String(c.juniorRateFloorMonthlyUSD),
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

type BatchOutcome = {
  results: Map<string, ScoreResult> | null;
  truncated: boolean;
  calls: number;
};

/**
 * Scores a batch, halving it and retrying if the response runs out of tokens.
 *
 * A fixed batch size cannot be right for both ends of this corpus: descriptions
 * run from a couple of hundred characters to nearly 19,000, so ten short listings
 * fit comfortably in one response while ten long ones do not. Raising the ceiling
 * for everyone pays for the worst case on every call; halving on demand pays only
 * where it is needed. Recursion bottoms out at a single listing, which either fits
 * or is genuinely unscoreable.
 */
async function scoreWithSplit(
  model: JsonModel,
  systemPrompt: string,
  batch: Candidate[],
): Promise<BatchOutcome> {
  const outcome = await scoreBatch(model, systemPrompt, batch);
  if (!outcome.truncated || batch.length <= 1) return outcome;

  const mid = Math.ceil(batch.length / 2);
  console.log(`  splitting a truncated batch of ${batch.length} into ${mid} + ${batch.length - mid}`);

  const left = await scoreWithSplit(model, systemPrompt, batch.slice(0, mid));
  const right = await scoreWithSplit(model, systemPrompt, batch.slice(mid));

  const merged = new Map<string, ScoreResult>();
  for (const half of [left, right]) {
    for (const [k, v] of half.results ?? []) merged.set(k, v);
  }
  return {
    results: merged.size > 0 ? merged : null,
    truncated: false,
    calls: outcome.calls + left.calls + right.calls,
  };
}

async function scoreBatch(
  model: JsonModel,
  systemPrompt: string,
  batch: Candidate[],
): Promise<BatchOutcome> {
  const allowedIds = new Set(batch.map((r) => r.source_id ?? r.id));
  const schema = scorerSchema(ALL_FLAGS);
  let calls = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    calls += 1;
    const result = await model.completeJson({
      system: systemPrompt,
      user: buildUserMessage(batch),
      schema,
      // Ten objects of about seventy tokens each, plus reasoning, plus headroom.
      // 2048 was not enough once thinking tokens were counted against it.
      maxOutputTokens: 8192,
    });
    const parsed = result.value as RawScore[] | null;

    if (!Array.isArray(parsed)) {
      // Say which failure it was. "Parse failed" sent me looking at the JSON
      // parser when the response had actually been cut off at the token limit.
      if (result.truncated) {
        // Retrying with an identical budget reproduces the same truncation; the
        // caller splits the batch instead.
        return { results: null, truncated: true, calls };
      }
      console.error(`  batch parse failed (attempt ${attempt}, status=${result.status})`);
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
    if (results.size > 0) return { results, truncated: false, calls };
    console.error(`  batch produced no usable objects (attempt ${attempt})`);
  }
  return { results: null, truncated: false, calls };
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
  // Resolve the model before touching a single batch. Without this, a missing API
  // key surfaced once per batch and each failure quarantined ten perfectly good
  // rows as 'failed' — 37 rows written off over a misconfiguration. Fail here
  // instead, before anything is marked. Resolving also validates SCORER_PROVIDER.
  const model = scoringModel();
  console.log(`scoring with ${model.label}`);
  const systemPrompt = await buildSystemPrompt();

  for (const batch of chunk(survivors, SCORING_CONFIG.listingsPerCall)) {
    // Deliberately not wrapped. An exception here is a transport, auth or quota
    // problem, not the model returning nonsense, and those rows deserve a retry on
    // the next run rather than a status that excludes them for good. The SDK has
    // already retried three times by this point, so the stage aborting is right.
    const outcome = await scoreWithSplit(model, systemPrompt, batch);
    stats.apiCalls += outcome.calls;
    const results = outcome.results;

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
