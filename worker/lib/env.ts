/**
 * worker/lib/env.ts
 *
 * Environment access. Commercial figures have no committed defaults by design
 * (CLAUDE-CODE-INSTRUCTIONS.md 2.3) — the repo is public. Anything missing fails
 * at startup with a named error rather than silently defaulting to a number that
 * would send applications for work the candidate would turn down.
 */

import { config as loadDotenv } from 'dotenv';

// Local development only. In GitHub Actions the values arrive as real env vars
// and no .env.local exists, which is fine — dotenv is a no-op when the file is absent.
loadDotenv({ path: '.env.local' });

class MissingEnvError extends Error {
  constructor(key: string, why: string) {
    super(`Required environment variable ${key} is not set. ${why}`);
    this.name = 'MissingEnvError';
  }
}

export function requireString(key: string, why: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') throw new MissingEnvError(key, why);
  return raw.trim();
}

export function requireNumber(key: string, why: string): number {
  const raw = requireString(key, why);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${key} must be a number, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function optionalString(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}
