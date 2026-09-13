/**
 * scripts/check-sender.ts
 *
 * The send gates, offline. No SMTP connection, no database, no API key.
 *
 * These are the tests that matter most in the repo. Everything else here can be
 * re-run when it is wrong; an email cannot be recalled. So each check below asserts
 * that a specific mistake results in nothing being sent.
 *
 *   npm run check:sender
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildMessage, loadResume, resumePath, UnsendableError, DEFAULT_VARIANT } from '../worker/submit/email.js';
import { RESUME_VARIANTS } from '../worker/llm/config.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const good = {
  apply_target: 'job.ygtpm@hostaway.recruitee.com',
  draft_subject: 'Senior Product Designer, Mobile: the daily vs occasional split',
  draft_body: 'I designed the landlord side of a Nigerian rental platform.',
  resume_variant: 'product-design',
};

async function refuses(label: string, row: Record<string, unknown>): Promise<void> {
  try {
    await buildMessage(row as Parameters<typeof buildMessage>[0]);
    check(label, false, 'built a message instead of refusing');
  } catch (err: unknown) {
    check(label, err instanceof UnsendableError, err instanceof Error ? err.message : String(err));
  }
}

async function messageBuilding(): Promise<void> {
  console.log('\nrefusing to build a message that should not be sent');
  await refuses('no apply_target', { ...good, apply_target: null });
  await refuses('blank apply_target', { ...good, apply_target: '   ' });
  await refuses('no subject', { ...good, draft_subject: null });
  await refuses('blank subject', { ...good, draft_subject: '' });
  await refuses('no body', { ...good, draft_body: null });
  await refuses('blank body', { ...good, draft_body: '  \n ' });
  // apply_target has held an asset URL that merely looked like an address before.
  await refuses('a no-reply mailbox', { ...good, apply_target: 'no-reply@hostaway.com' });
  await refuses('an address with no domain dot', { ...good, apply_target: 'someone@localhost' });
  await refuses('an image path that looks like an address',
    { ...good, apply_target: 'logo@2x.png' });

  console.log('\nbuilding a valid message');
  const m = await buildMessage(good);
  check('a complete row builds', m.to === good.apply_target && m.subject.length > 0);
  check('the resume is attached', m.attachment.content.length > 0);
  check('the attachment is a PDF',
    m.attachment.content.subarray(0, 4).toString('latin1') === '%PDF',
    m.attachment.content.subarray(0, 8).toString('latin1'));
  check('the attachment is named for a person, not a variant slug',
    /^Sunday-Omohwovo-/.test(m.attachment.filename), m.attachment.filename);
}

async function resumes(): Promise<void> {
  console.log('\nresume selection');
  for (const v of RESUME_VARIANTS) {
    check(`${v} resolves to its own file`, resumePath(v).includes(v));
  }
  check('an unknown variant falls back to the default',
    resumePath('nonsense') === resumePath(DEFAULT_VARIANT));
  check('a null variant falls back to the default',
    resumePath(null) === resumePath(DEFAULT_VARIANT));

  // The attachment is not optional. An application email with no resume reaches a
  // real hiring manager, reads as careless, and cannot be retracted; failing the
  // send is recoverable, sending a bare email is not.
  let threw = false;
  let message = '';
  try {
    await loadResume('product-design');
  } catch {
    threw = true;
  }
  check('the real resume loads (it is on disk)', !threw);

  // Both sources have to be unavailable to reach the throw, since Storage is now
  // the fallback and it works. Moving out of the project removes the local files;
  // blanking the credentials stops the Storage leg the way an unconfigured
  // environment would. db() is lazy and nothing here has built a client yet.
  //
  // The Actions case — no local files but Storage reachable — is the opposite
  // assertion and needs real credentials, so it lives in `npm run verify:storage`.
  const original = process.cwd();
  const url = process.env.SUPABASE_URL;
  process.chdir(tmpdir());
  process.env.SUPABASE_URL = '';
  try {
    await loadResume('product-design');
  } catch (err: unknown) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    process.chdir(original);
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
  }
  check('with neither disk nor Storage, it throws rather than sending without one',
    message.length > 0);
  check('the error names both sources it tried',
    /disk/i.test(message) && /Storage/i.test(message), message.slice(0, 90));
  check('the error says how to fix it',
    /sync:resumes/.test(message), message.slice(0, 90));
}

function gateOrdering(): void {
  console.log('\ngate documentation');
  // Not a behavioural test — a guard against the ordering being quietly changed.
  // dry_run must be evaluated before any message is constructed, so that a run with
  // the flag on cannot send even if every other gate is misconfigured.
  const source = readFileSync('worker/submit/index.ts', 'utf8');
  const dryRunAt = source.indexOf('if (settings.dryRun)');
  const sendAt = source.indexOf('await sendApplication(');
  check('dry_run is checked before any send call', dryRunAt !== -1 && dryRunAt < sendAt);
  check('only tier=auto is eligible', /r\.tier === 'auto'/.test(source));
  check('only the email apply path is eligible', /r\.apply_method === 'email'/.test(source));
  check('the cap is counted from sent_log, not memory',
    /from\('sent_log'\)/.test(source) && /sentToday/.test(source));
  check('sent_log is written before the status flips',
    source.indexOf("from('sent_log').insert") < source.indexOf("status: 'sent'"));
}

async function main(): Promise<void> {
  await messageBuilding();
  await resumes();
  gateOrdering();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All sender checks passed. No message was sent.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
