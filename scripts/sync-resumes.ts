/**
 * scripts/sync-resumes.ts
 *
 * Pushes the resume PDFs into Supabase Storage.
 *
 *   npm run sync:resumes
 *
 * The sender needs the PDFs and a GitHub Actions checkout does not have them:
 * knowledge/ is gitignored, correctly, because the repo is public and those files
 * carry a home address-adjacent amount of personal detail. Storage is the copy that
 * a scheduled run can actually reach.
 *
 * The local files stay the source of truth. Regenerate them with
 * `node knowledge/resumes/build-resumes.mjs`, then run this to publish. Nothing
 * reads Storage back into the repo, so a divergence resolves in favour of disk.
 *
 * The bucket is PRIVATE. A public bucket would put a resume carrying a real name,
 * email and work history on a guessable URL with no authentication, indexed by
 * anyone who finds the project id. Reads go through the service role.
 */

import { readFile } from 'node:fs/promises';
import { db } from '../worker/lib/db.js';
import { RESUME_VARIANTS } from '../worker/llm/config.js';
import { RESUME_BUCKET, storageKey, resumePath } from '../worker/submit/email.js';

async function ensureBucket(): Promise<void> {
  const storage = db().storage;
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`Could not list buckets: ${error.message}`);

  const existing = (buckets ?? []).find((b) => b.name === RESUME_BUCKET);
  if (existing !== undefined) {
    if (existing.public) {
      throw new Error(
        `Bucket "${RESUME_BUCKET}" is PUBLIC. These are personal documents and must not ` +
          'be on an unauthenticated URL. Set it to private in the Supabase dashboard ' +
          '(Storage, then the bucket settings) before syncing.',
      );
    }
    console.log(`bucket "${RESUME_BUCKET}" exists and is private`);
    return;
  }

  const { error: createError } = await storage.createBucket(RESUME_BUCKET, {
    public: false,
    allowedMimeTypes: ['application/pdf'],
    fileSizeLimit: 5 * 1024 * 1024,
  });
  if (createError) throw new Error(`Could not create bucket: ${createError.message}`);
  console.log(`created private bucket "${RESUME_BUCKET}"`);
}

async function main(): Promise<void> {
  await ensureBucket();
  const storage = db().storage.from(RESUME_BUCKET);

  for (const variant of RESUME_VARIANTS) {
    const local = resumePath(variant);
    const key = storageKey(variant);

    let content: Buffer;
    try {
      content = await readFile(local);
    } catch {
      console.log(`  skip  ${variant} — no file at ${local}`);
      continue;
    }
    if (content.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`${local} is not a PDF. Refusing to upload it as one.`);
    }

    const { error } = await storage.upload(key, content, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) throw new Error(`Upload of ${key} failed: ${error.message}`);

    // Read it straight back. An upload that reports success and stores nothing
    // would only surface at the moment an application failed to send.
    const { data: check, error: readError } = await storage.download(key);
    if (readError) throw new Error(`Uploaded ${key} but could not read it back: ${readError.message}`);
    const size = (await check.arrayBuffer()).byteLength;
    if (size !== content.length) {
      throw new Error(`${key} read back as ${size} bytes, expected ${content.length}`);
    }
    console.log(`  ok    ${key}  (${Math.round(size / 1024)} KB, verified)`);
  }

  console.log('\nThe sender reads from Storage when the local file is absent, which is');
  console.log('what a GitHub Actions run will do. Re-run this after regenerating the PDFs.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
