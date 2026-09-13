/**
 * worker/llm/drafter.ts
 *
 * Writes one application per listing that passed the scorer.
 *
 * The scorer's output is a number nobody reads. This stage's output is prose a
 * hiring manager judges the candidate on, which changes what "correct" means: a
 * wrong score costs one wasted call, a fabricated sentence costs an interview. So
 * everything here is built around not shipping a claim that is not true.
 *
 * Five checks run after the model returns, in code rather than in the prompt,
 * because a prompt constraint is a request and these are requirements:
 *
 *   1. the JSON parses at all
 *   2. the body is inside the format's word ceiling
 *   3. no banned construction appears
 *   4. no number appears that is not in the source material
 *   5. the model's own confidence clears the floor
 *
 * A failure on 2, 3 or 4 re-requests once with the specific problem named, then
 * downgrades to manual. Nothing is discarded: a draft that fails every check is
 * still stored, still visible, and still copyable. Manual is a routing decision,
 * not a delete.
 *
 * NOTHING IS SENT FROM HERE. This stage writes to draft_subject and draft_body and
 * sets status to 'drafted'. Sending is step 9 and does not exist yet.
 */

import { readFile } from 'node:fs/promises';
import { db, selectAllRowsWhere } from '../lib/db.js';
import { getKnowledge, caseStudyKey } from '../lib/knowledge.js';
import {
  CASE_STUDIES,
  DRAFTER_CONFIG,
  RESUME_CLAIMS,
  RESUME_VARIANTS,
  SCORING_CONFIG,
  type CaseStudy,
  type DraftFormat,
  type ResumeVariant,
} from './config.js';
import { interpolate, loadSystemPromptTemplate } from './scorer.js';
import { draftingModel } from './provider.js';
import type { JsonModel } from './provider.js';

const PROMPT_PATH = 'worker/llm/drafter.prompt.md';

type Candidate = {
  id: string;
  title: string;
  company: string | null;
  description: string | null;
  location: string | null;
  apply_method: string | null;
  score: number | null;
  case_study_used: string | null;
  resume_variant: string | null;
};

export type Tier = 'auto' | 'auto_flagged' | 'manual';

export type DrafterStats = {
  considered: number;
  drafted: number;
  auto: number;
  autoFlagged: number;
  manual: number;
  failed: number;
  apiCalls: number;
  downgradeReasons: Record<string, number>;
};

/**
 * Constructions that mark a letter as generated or as filler. Kept in code rather
 * than only in the prompt so the list can grow as patterns are spotted in real
 * drafts, and so a model that ignores the instruction is still caught.
 *
 * The em-dash entry is the one most likely to fire. The voice sample forbids
 * em-dashes and then uses them in five of its seven samples, so the model has a
 * strong demonstration pulling against the rule. This is the backstop.
 */
export const BANNED: { re: RegExp; label: string }[] = [
  // Both the contraction and the expanded form. Matching only "I'm writing to"
  // let "I am writing to express my interest" through, which is the single most
  // common opening this list exists to stop.
  { re: /\bI(?:['’]m| am) writing to\b/i, label: "'I'm writing to...'" },
  { re: /\bI was excited to see\b/i, label: "'I was excited to see'" },
  { re: /\bpassionate\b|\bpassion for\b/i, label: "'passionate'" },
  { re: /\bI believe I would be\b|\bgreat fit\b/i, label: "'I believe I would be a great fit'" },
  { re: /\bproven track record\b/i, label: "'proven track record'" },
  { re: /\bresults[- ]driven\b/i, label: "'results-driven'" },
  { re: /\bfast[- ]paced environment/i, label: "'fast-paced environment'" },
  { re: /\bleverage\b/i, label: "'leverage'" },
  { re: /\butilize\b|\butilise\b/i, label: "'utilize'" },
  { re: /\bspearhead/i, label: "'spearheaded'" },
  { re: /\bnot just\b[^.]{0,60}\bbut\b/i, label: "'not just X but Y'" },
  { re: /\bI hope this (?:email )?finds you well\b/i, label: "'hope this finds you well'" },
  { re: /\blooking forward to hearing from you\b/i, label: "'looking forward to hearing from you'" },
  { re: /\bdeep dive\b|\bcircle back\b|\btouch base\b|\bmove the needle\b/i, label: 'consultant filler' },
  { re: /\bthrilled\b|\bdelighted\b/i, label: "'thrilled'/'delighted'" },
  { re: /\bas you can see from my resume\b/i, label: "'as you can see from my resume'" },
  { re: /\bI['’]m reaching out because\b/i, label: "'I'm reaching out because'" },
  // An em-dash used as an aside. Hyphens in compounds are fine; these are not.
  { re: /\s[—–]\s/, label: 'em-dash aside (use a full stop)' },
];

/** Digits that would need to come from somewhere. */
const NUMERIC_CLAIM = /\b\d+(?:\.\d+)?\s?%|\b(?:increased|reduced|improved|grew|cut|boosted|drove)\b[^.]{0,40}?\b\d/i;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Which format this listing needs.
 *
 * free_text_answer is never chosen here. It answers a specific question asked by a
 * form ("why us?"), and nothing in the pipeline captures that question, so picking
 * it automatically would mean answering a question we never read. It stays in the
 * config because the sender will need it once forms are parsed.
 */
export function formatFor(applyMethod: string | null): DraftFormat {
  return applyMethod === 'email' ? 'email' : 'ats_cover_letter';
}

export function bannedHits(body: string): string[] {
  return BANNED.filter((b) => b.re.test(body)).map((b) => b.label);
}

/**
 * Any number in the letter that does not appear in the source material.
 *
 * This guards the failure the spec calls out: every case study's Outcome section is
 * currently empty, so a model inclined to round off a letter with "which increased
 * retention 30%" has nothing to draw on and would be inventing it. Checking the
 * digits against the source is cheaper and more reliable than trusting the
 * instruction not to.
 */
export function inventedNumbers(body: string, sources: string): string[] {
  if (!NUMERIC_CLAIM.test(body)) return [];
  const found = body.match(/\b\d+(?:\.\d+)?%?/g) ?? [];
  return [...new Set(found)].filter((n) => !sources.includes(n));
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: ['string', 'null'] },
    body: { type: 'string' },
    word_count: { type: 'integer' },
    confidence: { type: 'number' },
    confidence_reason: { type: 'string' },
  },
  required: ['body', 'confidence'],
};

export type Draft = {
  subject: string | null;
  body: string;
  confidence: number;
  confidenceReason: string;
};

export function validateDraft(raw: unknown): Draft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.body !== 'string' || r.body.trim().length === 0) return null;
  if (typeof r.confidence !== 'number' || Number.isNaN(r.confidence)) return null;

  return {
    subject: typeof r.subject === 'string' && r.subject.trim().length > 0 ? r.subject.trim() : null,
    body: r.body.trim(),
    // A model that reports 1.4 or -0.2 is not reporting confidence, but clamping is
    // kinder than discarding an otherwise good letter over a malformed float.
    confidence: Math.min(1, Math.max(0, r.confidence)),
    confidenceReason:
      typeof r.confidence_reason === 'string' ? r.confidence_reason.slice(0, 300) : '',
  };
}

function isCaseStudy(slug: string | null): slug is CaseStudy {
  return slug !== null && (CASE_STUDIES as readonly string[]).includes(slug);
}

export async function buildSystemPrompt(
  row: Candidate,
  format: DraftFormat,
  caseStudy: CaseStudy,
): Promise<{ system: string; sources: string }> {
  const template = await loadSystemPromptTemplate(PROMPT_PATH);
  const [profile, voice, study] = await Promise.all([
    getKnowledge('profile'),
    getKnowledge('voice-sample'),
    getKnowledge(caseStudyKey(caseStudy)),
  ]);

  // Which PDF the sender will staple to this letter. The drafter used to have no
  // idea, which is how a letter came to disclaim something its own attachment
  // claimed. Falls back to the sender's default so the two always agree.
  const variant = (RESUME_VARIANTS as readonly string[]).includes(row.resume_variant ?? '')
    ? (row.resume_variant as ResumeVariant)
    : 'product-design';

  const system = interpolate(template, {
    PROFILE_MD: profile,
    FULL_TEXT_OF_SELECTED_CASE_STUDY: study,
    VOICE_SAMPLE: voice,
    RESUME_CLAIMS: RESUME_CLAIMS[variant],
    TITLE: row.title,
    COMPANY: row.company ?? 'the company',
    DESCRIPTION: row.description ?? '(no description was published)',
    FORMAT: format,
    MAX_WORDS: String(DRAFTER_CONFIG.maxWords[format]),
  });

  // What the numeric check is allowed to draw on. The listing is included because
  // a salary or team size quoted back from the posting is not invented.
  const sources = [profile, study, row.description ?? '', row.title].join('\n');
  return { system, sources };
}

type Attempt = {
  draft: Draft | null;
  problems: string[];
  calls: number;
};

async function requestDraft(
  model: JsonModel,
  system: string,
  user: string,
  sources: string,
  format: DraftFormat,
): Promise<Attempt> {
  const result = await model.completeJson({
    system,
    user,
    schema: RESPONSE_SCHEMA,
    maxOutputTokens: DRAFTER_CONFIG.maxOutputTokens,
  });

  const parsed = validateDraft(result.value);
  if (parsed === null) {
    return { draft: null, problems: [result.truncated ? 'response truncated' : 'unparseable JSON'], calls: 1 };
  }

  // Only email has a subject line. The prompt says so, and the model still
  // supplied one on three of five cover letters and omitted it on the other two —
  // not a judgement call it gets to make inconsistently, since an ATS form has no
  // field to put it in and it would end up prepended to the letter body or lost.
  const draft: Draft = format === 'email' ? parsed : { ...parsed, subject: null };

  const problems: string[] = [];
  const limit = DRAFTER_CONFIG.maxWords[format];
  const words = countWords(draft.body);
  if (words > limit) problems.push(`${words} words against a ${limit} ceiling`);
  for (const hit of bannedHits(draft.body)) problems.push(`banned: ${hit}`);
  for (const n of inventedNumbers(draft.body, sources)) problems.push(`unsourced figure: ${n}`);

  // The subject gets the same treatment as the body. Checking only the body let
  // through "Senior Product Designer, Mobile — the daily-user vs occasional-user
  // split" on the first real draft: an em-dash aside in the one line a hiring
  // manager reads before deciding whether to open the mail at all.
  if (draft.subject !== null) {
    for (const hit of bannedHits(draft.subject)) problems.push(`banned in subject: ${hit}`);
  }

  return { draft, problems, calls: 1 };
}

/** One listing, with a single corrective retry when the first attempt has problems. */
export async function draftOne(
  model: JsonModel,
  row: Candidate,
  format: DraftFormat,
  caseStudy: CaseStudy,
): Promise<{ draft: Draft | null; problems: string[]; calls: number }> {
  const { system, sources } = await buildSystemPrompt(row, format, caseStudy);
  const user = `Write the ${format} for this listing. Return JSON only.`;

  const first = await requestDraft(model, system, user, sources, format);
  if (first.draft !== null && first.problems.length === 0) return first;

  // Name the specific problem. A bare "try again" produces the same letter, and the
  // first version of the scorer's retry proved that at two calls per batch.
  const correction =
    `${user}\n\nYour previous attempt was rejected for: ${first.problems.join('; ')}. ` +
    `Fix exactly those problems and return the full JSON again. Do not truncate mid-sentence ` +
    `to meet the word limit: rewrite shorter.`;

  const second = await requestDraft(model, system, correction, sources, format);
  const calls = first.calls + second.calls;

  // Keep whichever attempt is cleaner rather than blindly preferring the retry.
  if (second.draft !== null && second.problems.length === 0) return { ...second, calls };
  if (second.draft !== null && first.draft === null) return { ...second, calls };
  if (first.draft !== null && second.draft !== null) {
    const better = second.problems.length < first.problems.length ? second : first;
    return { ...better, calls };
  }
  return { draft: first.draft ?? second.draft, problems: second.problems, calls };
}

/**
 * Review tier.
 *
 * `auto` means send with no human looking first, so it requires an apply path that
 * can actually be sent: only email qualifies. An ATS or form row marked auto would
 * be a promise the pipeline cannot keep, since a person has to open the browser
 * either way. Those cap at auto_flagged no matter how strong the letter is.
 */
export function tierFor(
  row: Candidate,
  draft: Draft,
  problems: string[],
  format: DraftFormat,
): { tier: Tier; reason: string | null } {
  if (problems.length > 0) return { tier: 'manual', reason: problems[0] ?? 'validation' };
  if (draft.confidence < DRAFTER_CONFIG.minConfidence) {
    return { tier: 'manual', reason: `confidence ${draft.confidence.toFixed(2)}` };
  }
  if (format === 'free_text_answer') return { tier: 'auto_flagged', reason: 'free-text answer' };
  if (row.apply_method !== 'email') return { tier: 'auto_flagged', reason: 'no sendable apply path' };
  if ((row.score ?? 0) < SCORING_CONFIG.autoTierThreshold) {
    return { tier: 'auto_flagged', reason: `score below ${SCORING_CONFIG.autoTierThreshold}` };
  }
  return { tier: 'auto', reason: null };
}

export async function runDraft(limit?: number): Promise<DrafterStats> {
  const rows = await selectAllRowsWhere<Candidate>(
    'opportunities',
    'id, title, company, description, location, apply_method, score, case_study_used, resume_variant',
    'status',
    'scored',
  );
  const pending = limit === undefined ? rows : rows.slice(0, limit);

  const stats: DrafterStats = {
    considered: pending.length,
    drafted: 0,
    auto: 0,
    autoFlagged: 0,
    manual: 0,
    failed: 0,
    apiCalls: 0,
    downgradeReasons: {},
  };
  if (pending.length === 0) return stats;

  const model = draftingModel();
  console.log(`drafting with ${model.label}`);

  for (const row of pending) {
    const format = formatFor(row.apply_method);

    // The scorer picks the case study; falling back to the first one would open a
    // letter with a project the scorer judged irrelevant, which is worse than not
    // drafting. Send it to manual with the reason instead.
    if (!isCaseStudy(row.case_study_used)) {
      await db().from('opportunities')
        .update({ tier: 'manual', error: 'no case study selected by the scorer' })
        .eq('id', row.id);
      stats.manual += 1;
      stats.downgradeReasons['no case study'] = (stats.downgradeReasons['no case study'] ?? 0) + 1;
      continue;
    }

    const { draft, problems, calls } = await draftOne(model, row, format, row.case_study_used);
    stats.apiCalls += calls;

    if (draft === null) {
      await db().from('opportunities')
        .update({ status: 'failed', error: `drafter: ${problems.join('; ')}` })
        .eq('id', row.id);
      stats.failed += 1;
      console.log(`  FAIL ${row.company} — ${row.title}: ${problems.join('; ')}`);
      continue;
    }

    const { tier, reason } = tierFor(row, draft, problems, format);
    const { error } = await db()
      .from('opportunities')
      .update({
        draft_subject: draft.subject,
        draft_body: draft.body,
        status: 'drafted',
        tier,
        // Clearing a stale error matters: a row that failed a previous run and
        // drafted cleanly this one would otherwise keep showing the old reason.
        error: reason,
      })
      .eq('id', row.id);
    if (error) console.error(`  draft update failed for ${row.id}: ${error.message}`);

    stats.drafted += 1;
    if (tier === 'auto') stats.auto += 1;
    else if (tier === 'auto_flagged') stats.autoFlagged += 1;
    else stats.manual += 1;
    if (reason !== null) {
      stats.downgradeReasons[reason] = (stats.downgradeReasons[reason] ?? 0) + 1;
    }

    console.log(
      `  [${tier}] ${row.company} — ${String(row.title).slice(0, 46)} ` +
        `(${countWords(draft.body)}w, conf ${draft.confidence.toFixed(2)})`,
    );
  }

  return stats;
}
