/**
 * worker/submit/email.ts
 *
 * Building and sending one application email.
 *
 * Separated from the stage loop so the message can be constructed and inspected
 * without a transport existing. Everything here is pure except sendApplication,
 * which is the only function in this codebase that talks to an employer.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { db } from '../lib/db.js';
import { requireString } from '../lib/env.js';
import { isPlausibleApplicationEmail } from '../resolve/patterns.js';
import { RESUME_VARIANTS, type ResumeVariant } from '../llm/config.js';

/**
 * Where the resume PDFs live locally. Gitignored along with the rest of knowledge/,
 * which is correct for a public repo and is also why a GitHub Actions checkout has
 * no copy. Storage is the fallback that a scheduled run can actually reach.
 */
const RESUME_DIR = 'knowledge/resumes';

/** Private bucket. Never make it public: these carry a real name and history. */
export const RESUME_BUCKET = 'resumes';

export const DEFAULT_VARIANT: ResumeVariant = 'product-design';

function resolveVariant(variant: string | null): ResumeVariant {
  return (RESUME_VARIANTS as readonly string[]).includes(variant ?? '')
    ? (variant as ResumeVariant)
    : DEFAULT_VARIANT;
}

export function resumeFilename(variant: string | null): string {
  return `Sunday-Omohwovo-${resolveVariant(variant)}.pdf`;
}

export function resumePath(variant: string | null): string {
  return path.join(RESUME_DIR, resumeFilename(variant));
}

export function storageKey(variant: string | null): string {
  return resumeFilename(variant);
}

export type Attachment = { filename: string; content: Buffer };

function assertPdf(content: Buffer, where: string): Buffer {
  if (content.length === 0) throw new Error(`${where} is empty`);
  // A Supabase download of a missing object can return an error page rather than
  // failing outright, and a 400-byte "not found" attached to an application would
  // be worse than no send at all.
  if (content.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`${where} is not a PDF (starts with ${JSON.stringify(content.subarray(0, 8).toString('latin1'))})`);
  }
  return content;
}

/** The local copy, which is the source of truth when it exists. */
async function fromDisk(variant: string | null): Promise<Attachment | null> {
  try {
    const file = resumePath(variant);
    return { filename: path.basename(file), content: assertPdf(await readFile(file), file) };
  } catch {
    return null;
  }
}

/** The copy a GitHub Actions run can reach. Populated by `npm run sync:resumes`. */
async function fromStorage(variant: string | null): Promise<Attachment | null> {
  try {
    const key = storageKey(variant);
    const { data, error } = await db().storage.from(RESUME_BUCKET).download(key);
    if (error !== null || data === null) return null;
    const content = Buffer.from(await data.arrayBuffer());
    return { filename: key, content: assertPdf(content, `${RESUME_BUCKET}/${key}`) };
  } catch {
    return null;
  }
}

/**
 * Loads the resume, or throws.
 *
 * Deliberately not optional. An application email with no resume attached is worse
 * than no application: it reaches a real hiring manager, reads as careless, and
 * cannot be retracted. Failing the send is recoverable; sending a bare email is not.
 *
 * Disk first, then Storage. Disk is where the generator writes, so preferring it
 * means a locally regenerated PDF is used immediately rather than silently losing
 * to a stale upload. Actions has no disk copy and falls through to Storage, which
 * is the whole reason the bucket exists.
 */
export async function loadResume(variant: string | null): Promise<Attachment> {
  const found = (await fromDisk(variant)) ?? (await fromStorage(variant));
  if (found !== null) return found;

  throw new Error(
    `Resume "${resumeFilename(variant)}" is readable neither on disk (${resumePath(variant)}) ` +
      `nor in Supabase Storage (${RESUME_BUCKET}/${storageKey(variant)}). Nothing was sent. ` +
      'knowledge/ is gitignored, so a GitHub Actions checkout has no local copy: run ' +
      '`npm run sync:resumes` to publish them to the bucket.',
  );
}

export type Outgoing = {
  to: string;
  subject: string;
  text: string;
  attachment: Attachment;
};

export class UnsendableError extends Error {}

/**
 * Assembles the message, refusing anything that would embarrass the sender.
 *
 * Each check here is a thing that has actually gone wrong somewhere in this
 * pipeline: a null draft from a stage that had not run, an apply_target holding an
 * asset URL that merely looked like an address, a subject left null because the
 * format was a cover letter rather than an email.
 */
export async function buildMessage(row: {
  apply_target: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  resume_variant: string | null;
}): Promise<Outgoing> {
  const to = (row.apply_target ?? '').trim();
  if (to === '') throw new UnsendableError('no apply_target');
  if (!isPlausibleApplicationEmail(to)) {
    throw new UnsendableError(`apply_target is not a plausible application address: ${to}`);
  }

  const subject = (row.draft_subject ?? '').trim();
  if (subject === '') throw new UnsendableError('no draft_subject');

  const text = (row.draft_body ?? '').trim();
  if (text === '') throw new UnsendableError('no draft_body');

  return { to, subject, text, attachment: await loadResume(row.resume_variant) };
}

let transport: Transporter | undefined;

/**
 * The same Gmail SMTP path the alerting uses. Applications and alerts leaving by
 * one identity is intentional for now: replies land in the single inbox the
 * pipeline reads, and a second sending domain is the outreach track's problem.
 */
function gmailTransport(): Transporter {
  if (transport) return transport;
  const user = requireString('GMAIL_USER', 'Required to send applications.');
  const pass = requireString('GMAIL_APP_PASSWORD', 'Required to send applications.');
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user, pass: pass.replace(/\s/g, '') },
  });
  return transport;
}

/** Sends. The only call in this repo that reaches an employer. */
export async function sendApplication(message: Outgoing): Promise<string> {
  const from = requireString('GMAIL_USER', 'application sender');
  const info = await gmailTransport().sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    attachments: [{ filename: message.attachment.filename, content: message.attachment.content }],
  });
  return info.messageId ?? '';
}

/** Test seam. */
export function resetTransport(): void {
  transport = undefined;
}
