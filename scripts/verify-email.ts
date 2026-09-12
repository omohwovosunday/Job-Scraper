/**
 * scripts/verify-email.ts
 *
 * Proves the Gmail transport works before anything is built on top of it.
 * Authenticates, then sends one plain-text message from the account to itself.
 *
 *   npm run verify:email
 *
 * Expected: "auth ok", then a message in the inbox — not in spam.
 *
 * On SMTP 535 the account address is the likelier fault, not the password. An app
 * password authenticates exactly one Google account, and with several signed in it
 * is easy to generate the password under one and set GMAIL_USER to another. Check
 * that pairing before regenerating anything.
 *
 * This is the only script that sends real mail. It writes nothing to the database
 * and ignores dry_run, because its whole purpose is to put a message on the wire.
 * It sends to the authenticated account itself, so nothing reaches a third party.
 */

import nodemailer from 'nodemailer';
import { requireString } from '../worker/lib/env.js';

async function main(): Promise<void> {
  const user = requireString(
    'GMAIL_USER',
    'The Gmail account the app password was created under.',
  );
  const rawPass = requireString(
    'GMAIL_APP_PASSWORD',
    'A Google app password, not the account password.',
  );

  // Google shows app passwords in four groups of four with spaces, and that is how
  // people paste them. SMTP wants the sixteen characters with nothing between.
  const pass = rawPass.replace(/\s/g, '');
  if (pass.length !== 16) {
    console.warn(
      `warning: app password is ${pass.length} characters after stripping spaces; ` +
        'Google issues 16. Continuing anyway.',
    );
  }

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS upgrades the connection
    auth: { user, pass },
  });

  console.log(`authenticating ${user} ...`);
  await transport.verify();
  console.log('auth ok');

  const info = await transport.sendMail({
    from: user,
    to: user,
    subject: 'job-scraper transport test',
    text:
      'Plain text test. If this is in the inbox and not spam, the transport works.\n',
  });

  console.log(`sent ${info.messageId}`);
  console.log(`accepted: ${JSON.stringify(info.accepted)}`);
  if (info.rejected.length > 0) console.log(`rejected: ${JSON.stringify(info.rejected)}`);
  console.log(
    '\nCheck the inbox. If it landed in spam, stop and report that — applications ' +
      'sent from this account would land there too.',
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nFAILED: ${message}`);

  if (/\b535\b|Username and Password not accepted|BadCredentials/i.test(message)) {
    console.error(
      '\nSMTP 535. In order of likelihood:\n' +
        '  1. GMAIL_USER is not the account the app password was generated under.\n' +
        '  2. The password was pasted with a character missing or altered.\n' +
        '  3. The app password was revoked.\n' +
        'Check 1 before regenerating anything.',
    );
  }
  process.exit(1);
});
