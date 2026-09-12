/**
 * scripts/check-scorer.ts
 *
 * Pre-filter and response validation, checked with no API calls and no database.
 *
 *   npm run check:scorer
 */

import { prefilter, truncateForScoring } from '../worker/llm/prefilter.js';
import { validateScore, interpolate } from '../worker/llm/scorer.js';
import { parseJsonLoosely } from '../worker/llm/client.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const DESIGN = 'Senior Product Designer';

function prefilterExclusions(): void {
  console.log('\npre-filter: excludes what the employer stated');

  const cases: [string, string][] = [
    ['Remote - United States', 'region_restricted'],
    ['US / Canada', 'region_restricted'],
    ['Remote, North America', 'region_restricted'],
    ['Remote-NORAM', 'region_restricted'],
    ['Remote - US', 'region_restricted'],
    ['Remote-US', 'region_restricted'],
    ['Remote — US', 'region_restricted'],
    ['Hybrid - London', 'onsite_or_hybrid'],
    ['San Francisco, CA (On-site)', 'onsite_or_hybrid'],
  ];
  for (const [location, flag] of cases) {
    const v = prefilter({ title: DESIGN, location, applyMethod: 'ats' });
    check(`${location.padEnd(30)} -> ${flag}`,
      !v.pass && v.flag === flag,
      v.pass ? 'passed through' : `got ${v.flag}`);
  }
}

function prefilterPassThrough(): void {
  console.log('\npre-filter: lets through anything not explicitly excluded');

  for (const location of [
    'Remote - Worldwide', 'EMEA', 'Remote, EMEA; Remote, Germany',
    'Anywhere', 'Africa', 'Remote (Global)',
  ]) {
    const v = prefilter({ title: DESIGN, location, applyMethod: 'ats' });
    check(`${location.padEnd(30)} passes`, v.pass, v.pass ? '' : `excluded as ${v.flag}`);
  }

  // The most important case. An empty or unfamiliar location must NEVER be
  // excluded here — a pre-filter mistake is invisible, and the scorer has
  // region_ambiguous for exactly this.
  //
  // A bare city name belongs in this list, not in the exclusions. "Toronto" does
  // imply Canada, but recognising every city on earth is not something a regex can
  // do, and a half-complete city list would exclude the cities it knows while
  // letting the rest through — inconsistency with no upside. The scorer reads the
  // location field and zeroes it there.
  for (const location of [null, '', 'Somewhere unusual', 'Toronto', 'Bengaluru']) {
    const v = prefilter({ title: DESIGN, location, applyMethod: 'ats' });
    check(`location ${JSON.stringify(location)} passes to the scorer`, v.pass,
      v.pass ? '' : `excluded as ${v.flag}`);
  }

  // A region that includes Nigeria wins over other region words in the same field.
  const mixed = prefilter({
    title: DESIGN,
    location: 'Remote, EMEA; Remote, United Kingdom; Remote, Netherlands',
    applyMethod: 'ats',
  });
  check('EMEA overrides a co-listed UK restriction', mixed.pass,
    mixed.pass ? '' : `excluded as ${mixed.flag}`);
}

function prefilterRoles(): void {
  console.log('\npre-filter: role signal');

  for (const title of [
    'Account Executive, Commercial', 'Payroll Specialist Lead - US',
    'Senior Support Engineer', 'Business Development Representative',
    'Staff Backend Engineer - Platform', 'Senior Mechanical Engineer',
  ]) {
    const v = prefilter({ title, location: 'Remote - Worldwide', applyMethod: 'ats' });
    check(`excluded: ${title}`, !v.pass && v.flag === 'role_mismatch',
      v.pass ? 'passed through' : `got ${v.flag}`);
  }

  for (const title of [
    'Senior Product Designer', 'Product Designer, Design Systems',
    'Design Engineer', 'UX/UI Designer', 'Staff Visual Designer',
    'Front-end Developer (Design Systems)', 'Brand Designer',
  ]) {
    const v = prefilter({ title, location: 'Remote - Worldwide', applyMethod: 'ats' });
    check(`kept: ${title}`, v.pass, v.pass ? '' : `excluded as ${v.flag}`);
  }
}

function truncation(): void {
  console.log('\ndescription truncation keeps the tail');

  // Eligibility lines sit at the foot of long listings, after the benefits and the
  // EEO boilerplate. A head-only cut discards the sentence that decides everything.
  const body = 'X'.repeat(18_000);
  const description = `Intro about the role.\n${body}\nYou must be authorised to work in the United States.`;
  const out = truncateForScoring(description, 4000);

  check(`result respects the budget (${out.length} chars)`, out.length <= 4200, `${out.length}`);
  check('the opening survives', out.includes('Intro about the role.'));
  check('the eligibility line at the foot survives',
    out.includes('authorised to work in the United States'));
  check('omission is marked', out.includes('characters omitted'));
  check('a short description is untouched',
    truncateForScoring('short', 4000) === 'short');
  check('null becomes empty string', truncateForScoring(null) === '');
}

function responseValidation(): void {
  console.log('\nresponse validation');
  const allowed = new Set(['a1', 'a2']);

  const good = validateScore(
    { source_id: 'a1', score: 82, reason: 'strong fit', red_flags: ['comp_unstated'],
      suggested_resume_variant: 'design-engineer', suggested_case_study: 'rentos' }, allowed);
  check('a well-formed object validates',
    good?.result.score === 82 && good?.result.caseStudy === 'rentos');

  // The invariant the prompt cannot enforce. Models flag and then score anyway.
  const zeroed = validateScore(
    { source_id: 'a1', score: 88, reason: 'great role', red_flags: ['region_restricted'] }, allowed);
  check('a hard zero forces score 0 regardless of the number returned',
    zeroed?.result.score === 0, `got ${zeroed?.result.score}`);
  for (const flag of ['onsite_or_hybrid', 'unpaid_or_exposure', 'equity_only', 'takehome_over_4h']) {
    const z = validateScore({ source_id: 'a1', score: 90, reason: 'x', red_flags: [flag] }, allowed);
    check(`${flag} forces 0`, z?.result.score === 0);
  }

  check('an invented source_id is dropped',
    validateScore({ source_id: 'not-in-batch', score: 70, reason: 'x' }, allowed) === null);
  check('a missing source_id is dropped',
    validateScore({ score: 70, reason: 'x' }, allowed) === null);
  check('an out-of-range score is dropped',
    validateScore({ source_id: 'a1', score: 140, reason: 'x' }, allowed) === null);
  check('a non-numeric score is dropped',
    validateScore({ source_id: 'a1', score: 'high', reason: 'x' }, allowed) === null);
  check('a numeric string score is accepted',
    validateScore({ source_id: 'a1', score: '80', reason: 'x' }, allowed)?.result.score === 80);
  check('an invented flag is stripped',
    validateScore({ source_id: 'a1', score: 80, reason: 'x', red_flags: ['made_up_flag'] }, allowed)
      ?.result.redFlags.length === 0);
  check('a dropped case study is not accepted',
    validateScore({ source_id: 'a1', score: 80, reason: 'x', suggested_case_study: 'gettranzport' }, allowed)
      ?.result.caseStudy === null);
  check('an unknown resume variant becomes null',
    validateScore({ source_id: 'a1', score: 80, reason: 'x', suggested_resume_variant: 'nonsense' }, allowed)
      ?.result.resumeVariant === null);
}

function jsonParsing(): void {
  console.log('\nJSON parsing');
  check('plain array', Array.isArray(parseJsonLoosely('[{"a":1}]')));
  check('fenced with json tag', Array.isArray(parseJsonLoosely('```json\n[{"a":1}]\n```')));
  check('fenced without tag', Array.isArray(parseJsonLoosely('```\n[{"a":1}]\n```')));
  check('prose before the array',
    Array.isArray(parseJsonLoosely('Here are the scores:\n[{"a":1}]')));
  check('prose after the array',
    Array.isArray(parseJsonLoosely('[{"a":1}]\nLet me know if you need more.')));
  check('unparseable returns null', parseJsonLoosely('not json at all') === null);
  check('empty returns null', parseJsonLoosely('') === null);
}

function promptInterpolation(): void {
  console.log('\nprompt interpolation');
  check('placeholders are filled',
    interpolate('rate {{rate}} in {{place}}', { rate: '25', place: 'Lagos' }) === 'rate 25 in Lagos');

  // A placeholder reaching the model as literal braces would silently degrade
  // every score in the batch, so this must throw rather than pass it through.
  let threw = false;
  try { interpolate('rate {{rate}} and {{missing}}', { rate: '25' }); } catch { threw = true; }
  check('a missing placeholder throws instead of shipping literal braces', threw);
}

function main(): void {
  prefilterExclusions();
  prefilterPassThrough();
  prefilterRoles();
  truncation();
  responseValidation();
  jsonParsing();
  promptInterpolation();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All scorer checks passed. Live scoring needs ANTHROPIC_API_KEY.');
}

main();
