/**
 * scripts/check-drafter.ts
 *
 * The drafter's validation logic, offline. No API key, no database.
 *
 * Everything here tests a guard rather than the writing, because the guards are
 * what stand between a plausible letter and a false one. The model's prose is
 * judged by reading it (the step 7 review gate), not by assertions.
 *
 *   npm run check:drafter
 */

import {
  BANNED,
  bannedHits,
  countWords,
  formatFor,
  inventedNumbers,
  tierFor,
  validateDraft,
  type Draft,
} from '../worker/llm/drafter.js';
import { DRAFTER_CONFIG, SCORING_CONFIG } from '../worker/llm/config.js';
import { loadSystemPromptTemplate, interpolate } from '../worker/llm/scorer.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const draft = (over: Partial<Draft> = {}): Draft => ({
  subject: null,
  body: 'I specified the landlord side of a Nigerian rental platform.',
  confidence: 0.9,
  confidenceReason: 'clear listing',
  ...over,
});

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r1', title: 'Product Designer', company: 'Acme', description: 'd',
    location: null, apply_method: 'email', score: 90, case_study_used: 'rentos',
    ...over,
  }) as Parameters<typeof tierFor>[0];

function parsing(): void {
  console.log('\nresponse parsing');
  check('a well-formed response validates',
    validateDraft({ body: 'x', confidence: 0.8, subject: 'S', confidence_reason: 'r' })?.body === 'x');
  check('a missing body is rejected', validateDraft({ confidence: 0.8 }) === null);
  check('an empty body is rejected', validateDraft({ body: '   ', confidence: 0.8 }) === null);
  check('a missing confidence is rejected', validateDraft({ body: 'x' }) === null);
  check('a non-object is rejected', validateDraft('nope') === null);
  check('null is rejected', validateDraft(null) === null);
  // Clamping rather than discarding: a good letter should not be thrown away over
  // a malformed float.
  check('confidence above 1 clamps to 1',
    validateDraft({ body: 'x', confidence: 1.4 })?.confidence === 1);
  check('negative confidence clamps to 0',
    validateDraft({ body: 'x', confidence: -0.2 })?.confidence === 0);
  check('a blank subject becomes null',
    validateDraft({ body: 'x', confidence: 0.8, subject: '  ' })?.subject === null);
}

function wordCounting(): void {
  console.log('\nword counting');
  check('counts words, not characters', countWords('one two three') === 3);
  check('collapses runs of whitespace', countWords('one   two\n\nthree') === 3);
  check('an empty string is zero words', countWords('   ') === 0);
}

function banned(): void {
  console.log('\nbanned constructions');
  const cases: [string, boolean][] = [
    ['I am writing to express my interest in the role.', true],
    ['I was excited to see this posting.', true],
    ["I'm passionate about design systems.", true],
    ['We can leverage the existing system.', true],
    ['I have a proven track record.', true],
    ['She thrives in a fast-paced environment.', true],
    ['Not just a designer, but an engineer too.', true],
    ['I hope this email finds you well.', true],
    // The one most likely to fire: the voice sample forbids em-dashes and then
    // demonstrates them five times.
    ['I designed the escrow flow — it was hard.', true],
    // Hyphenated compounds must survive. Flagging these would reject every letter
    // that says "first-match-wins" or "design-engineer".
    ['I built a first-match-wins routing contract.', false],
    ['I work as a design-engineer on B2B tools.', false],
    ['I specified the landlord side of a rental platform.', false],
  ];
  for (const [text, shouldHit] of cases) {
    const hits = bannedHits(text);
    check(`${shouldHit ? 'flags  ' : 'allows '} "${text.slice(0, 44)}"`,
      (hits.length > 0) === shouldHit, hits.join(', '));
  }
  check('every banned entry has a label', BANNED.every((b) => b.label.length > 0));
  // The first real draft put an em-dash in the subject line, which the body-only
  // check could not see. The subject is the one line that decides whether the mail
  // is opened, so it gets the same list.
  check('an em-dash in a subject line is caught',
    bannedHits('Senior Product Designer, Mobile — the daily-user split').length > 0);
}

function numbers(): void {
  console.log('\ninvented numbers');
  const sources = 'The platform served 4 user roles. Rentos had 62 screens.';

  check('a percentage not in the source is flagged',
    inventedNumbers('This increased retention by 30%.', sources).length > 0);
  check('a figure that IS in the source passes',
    inventedNumbers('I re-specified all 62 screens.', sources).length === 0);
  check('prose with no numeric claim passes',
    inventedNumbers('I specified the landlord side.', sources).length === 0);
  // The exact failure the spec names: every Outcome section is empty, so any
  // outcome figure is necessarily invented.
  check('"reduced ... by 40%" is flagged',
    inventedNumbers('This reduced support tickets by 40%.', sources).length > 0);
  check('a bare year is not treated as a claim',
    inventedNumbers('I have worked in fintech since 2021.', sources).length === 0);
}

function tiers(): void {
  console.log('\nreview tier');
  const t = (r: Parameters<typeof tierFor>[0], d: Draft, p: string[] = []) =>
    tierFor(r, d, p, 'email').tier;

  check('a clean high-scoring email draft is auto', t(row(), draft()) === 'auto');
  check('any validation problem forces manual',
    t(row(), draft(), ['banned: leverage']) === 'manual');
  check('confidence below the floor forces manual',
    t(row(), draft({ confidence: DRAFTER_CONFIG.minConfidence - 0.01 })) === 'manual');
  check('confidence exactly at the floor is allowed',
    t(row(), draft({ confidence: DRAFTER_CONFIG.minConfidence })) === 'auto');
  // auto means "send with no human looking", so it needs a path that can be sent.
  // Only email qualifies; an ats row marked auto would be a promise the pipeline
  // cannot keep, because a person has to open a browser either way.
  check('an ats row cannot be auto however good the letter',
    t(row({ apply_method: 'ats' }), draft()) === 'auto_flagged');
  check('a form row cannot be auto',
    t(row({ apply_method: 'form' }), draft()) === 'auto_flagged');
  check(`a score below ${SCORING_CONFIG.autoTierThreshold} caps at auto_flagged`,
    t(row({ score: SCORING_CONFIG.autoTierThreshold - 1 }), draft()) === 'auto_flagged');
  check('a free-text answer never exceeds auto_flagged',
    tierFor(row(), draft(), [], 'free_text_answer').tier === 'auto_flagged');
}

function formats(): void {
  console.log('\nformat selection');
  check('email apply path gets the email format', formatFor('email') === 'email');
  check('ats gets a cover letter', formatFor('ats') === 'ats_cover_letter');
  check('form gets a cover letter', formatFor('form') === 'ats_cover_letter');
  check('an unknown path still gets a cover letter', formatFor(null) === 'ats_cover_letter');
  // Never selected automatically: it answers a question the pipeline does not
  // capture, so choosing it would mean answering something nobody read.
  check('free_text_answer is never selected automatically',
    (['email', 'ats', 'form', 'unresolved', null] as (string | null)[])
      .every((m) => formatFor(m) !== 'free_text_answer'));
  check('every format has a word ceiling',
    Object.values(DRAFTER_CONFIG.maxWords).every((n) => n > 0));
  // Only email carries a subject. The model supplied one on three of five cover
  // letters and omitted it on the other two, so the stage decides rather than
  // leaving it to a coin flip: an ATS form has nowhere to put it.
  check('only the email format keeps a subject line', formatFor('email') === 'email'
    && formatFor('ats') !== 'email' && formatFor('form') !== 'email');
}

async function prompt(): Promise<void> {
  console.log('\nprompt template');
  const template = await loadSystemPromptTemplate('worker/llm/drafter.prompt.md');
  check('the system prompt loads', template.length > 500);
  check('it is the prompt, not the config block above it',
    !template.includes('DRAFTER_CONFIG') && template.includes('You write job applications'));

  const placeholders = [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
  const supplied = ['PROFILE_MD', 'FULL_TEXT_OF_SELECTED_CASE_STUDY', 'VOICE_SAMPLE',
    'TITLE', 'COMPANY', 'DESCRIPTION', 'FORMAT', 'MAX_WORDS'];
  const unsupplied = placeholders.filter((p) => p !== undefined && !supplied.includes(p));
  check(`every placeholder is supplied by the stage (${placeholders.length} found)`,
    unsupplied.length === 0, unsupplied.join(', '));

  // A missing value would otherwise reach the model as literal braces and quietly
  // degrade the letter rather than failing.
  let threw = false;
  try {
    interpolate(template, { PROFILE_MD: 'p' });
  } catch {
    threw = true;
  }
  check('a missing placeholder throws instead of shipping literal braces', threw);

  check('the prompt still forbids em-dash asides',
    /Em-dash asides/i.test(await loadSystemPromptTemplate('worker/llm/drafter.prompt.md')));
}

async function main(): Promise<void> {
  parsing();
  wordCounting();
  banned();
  numbers();
  tiers();
  formats();
  await prompt();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All drafter checks passed. Live drafting needs ANTHROPIC_API_KEY.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
