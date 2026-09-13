/**
 * scripts/verify-storage.ts
 *
 * The resume bucket, against the live project. Needs credentials, which is why it
 * is separate from check:sender.
 *
 *   npm run verify:storage
 *
 * Two invariants, both of which fail quietly if broken:
 *
 *   1. A run with no local knowledge/ directory can still attach a resume. That is
 *      exactly a GitHub Actions checkout, and the failure mode without this is an
 *      application that refuses to send at 3am with nobody watching.
 *
 *   2. The bucket is not readable without credentials. These PDFs carry a real
 *      name, email, employer history and city. A public bucket would put them on a
 *      guessable URL for anyone who learns the project id.
 */

import { tmpdir } from 'node:os';
import { db } from '../worker/lib/db.js';
import { requireString } from '../worker/lib/env.js';
import { RESUME_VARIANTS } from '../worker/llm/config.js';
import { loadResume, RESUME_BUCKET, storageKey } from '../worker/submit/email.js';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

async function bucketIsPrivate(): Promise<void> {
  console.log('\nbucket visibility');
  const { data: buckets, error } = await db().storage.listBuckets();
  check('the bucket exists', error === null && (buckets ?? []).some((b) => b.name === RESUME_BUCKET),
    error?.message ?? 'not found');

  const bucket = (buckets ?? []).find((b) => b.name === RESUME_BUCKET);
  check('the bucket is private', bucket !== undefined && bucket.public === false,
    bucket === undefined ? 'missing' : `public=${bucket.public}`);

  // The strongest available statement: ask the internet, with no credentials.
  const url = requireString('SUPABASE_URL', 'storage check');
  const key = storageKey('product-design');
  const response = await fetch(`${url}/storage/v1/object/public/${RESUME_BUCKET}/${key}`);
  check(`an unauthenticated request is refused (HTTP ${response.status})`, response.status >= 400,
    'the resume is readable by anyone with the project URL');
}

async function everyVariantPresent(): Promise<void> {
  console.log('\nevery variant is in the bucket');
  const store = db().storage.from(RESUME_BUCKET);
  for (const variant of RESUME_VARIANTS) {
    const key = storageKey(variant);
    const { data, error } = await store.download(key);
    if (error !== null || data === null) {
      check(`${key}`, false, error?.message ?? 'no data');
      continue;
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    check(`${key} (${Math.round(bytes.length / 1024)} KB)`,
      bytes.subarray(0, 4).toString('latin1') === '%PDF',
      `starts with ${JSON.stringify(bytes.subarray(0, 8).toString('latin1'))}`);
  }
}

async function actionsSimulation(): Promise<void> {
  console.log('\nwith no local knowledge/ directory (a GitHub Actions checkout)');
  const original = process.cwd();
  process.chdir(tmpdir());
  try {
    for (const variant of RESUME_VARIANTS) {
      try {
        const attachment = await loadResume(variant);
        check(`${variant} falls back to Storage`,
          attachment.content.subarray(0, 4).toString('latin1') === '%PDF');
      } catch (err: unknown) {
        check(`${variant} falls back to Storage`, false,
          err instanceof Error ? err.message.slice(0, 90) : String(err));
      }
    }
  } finally {
    process.chdir(original);
  }
}

async function main(): Promise<void> {
  await bucketIsPrivate();
  await everyVariantPresent();
  await actionsSimulation();

  console.log('');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('Storage is ready for a scheduled send. Nothing was sent.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
