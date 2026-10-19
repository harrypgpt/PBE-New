import fs from 'node:fs';
import path from 'node:path';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@pbe/contracts';

/**
 * Password policy (ADR-026, owner-approved): 15–128 characters after Unicode NFKC normalisation;
 * any characters except control characters; no forced character mixes; refused if on the
 * versioned compromised-password blocklist, if it contains the user's email name, or if it is
 * highly repetitive. Candidate passwords are never sent anywhere.
 */

/** apps/api/data, from both src/ (tests) and dist/ (runtime): the same depth below apps/api. */
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
export const BLOCKLIST_FILE = path.join(DATA_DIR, 'compromised-passwords-v1.txt');

export class Blocklist {
  private constructor(
    private readonly entries: ReadonlySet<string>,
    readonly version: number,
  ) {}

  static load(file: string = BLOCKLIST_FILE): Blocklist {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    if (lines.length < 1000)
      throw new Error('compromised-password blocklist is missing or too small');
    return new Blocklist(new Set(lines), 1);
  }

  static fromEntries(entries: readonly string[]): Blocklist {
    return new Blocklist(new Set(entries.map((e) => normalisePassword(e).toLowerCase())), 0);
  }

  has(normalisedLowerCase: string): boolean {
    return this.entries.has(normalisedLowerCase);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The form that is hashed and checked: Unicode NFKC (so look-alike forms compare equal). */
export function normalisePassword(password: string): string {
  return password.normalize('NFKC');
}

const CONTEXT_WORDS = [
  'predictive bioequivalence',
  'predictivebioequivalence',
  'bioequivalence engine',
];

/** Returns a plain-language reason the password is not acceptable, or null if it is. */
export function passwordProblem(
  password: string,
  context: { email: string },
  blocklist: Blocklist,
): string | null {
  const value = normalisePassword(password);
  const length = [...value].length;
  if (length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Remove control characters.';
  const lower = value.toLowerCase();
  if (blocklist.has(lower)) {
    return 'This password is too common or has appeared in a data breach. Choose another.';
  }
  const local = context.email.trim().toLowerCase().split('@')[0] ?? '';
  if (local.length >= 3 && lower.includes(local)) return 'Do not include your email address.';
  if (CONTEXT_WORDS.some((w) => lower.includes(w)) || /^pbe[\W\d_]*$/.test(lower)) {
    return 'Do not base the password on the product name.';
  }
  if (new Set(lower).size <= 3) return 'Use a less repetitive password.';
  return null;
}
