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
import { requireString } from '../lib/env.js';
import { isPlausibleApplicationEmail } from '../resolve/patterns.js';
import { RESUME_VARIANTS, type ResumeVariant } from '../llm/config.js';

/**
 * Where the resume PDFs live. Gitignored along with the rest of knowledge/, which
 * is correct for a public repo and is also the reason a GitHub Actions run cannot
 * attach one: the checkout has no copy. See assertResumeAvailable.
 */
const RESUME_DIR = 'knowledge/resumes';

export const DEFAULT_VARIANT: ResumeVariant = 'product-design';

export function resumePath(variant: string | null): string {
  const v = (RESUME_VARIANTS as readonly string[]).includes(variant ?? '')
    ? (variant as ResumeVariant)
    : DEFAULT_VARIANT;
  return path.join(RESUME_DIR, `Sunday-Omohwovo-${v}.pdf`);
}

export type Attachment = { filename: string; content: Buffer };

/**
 * Loads the resume, or throws.
 *
 * Deliberately not optional. An application email with no resume attached is worse
 * than no application: it reaches a real hiring manager, reads as careless, and
 * cannot be retracted. Failing the send is recoverable; sending a bare email is not.
 */
export async function loadResume(variant: string | null): Promise<Attachment> {
  const file = resumePath(variant);
  try {
    const content = await readFile(file);
    if (content.length === 0) throw new Error('file is empty');
    return { filename: path.basename(file), content };
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Resume not readable at ${file} (${why}). Nothing was sent. ` +
        'knowledge/ is gitignored, so a GitHub Actions checkout has no copy of these ' +
        'PDFs — a scheduled send needs them in Supabase Storage first.',
    );
  }
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
