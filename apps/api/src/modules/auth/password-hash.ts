import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { normalisePassword } from './password-policy';

/**
 * Argon2id password hashing (ADR-026) via @node-rs/argon2. The PHC string stores the algorithm,
 * parameters and a random 16-byte salt, so parameters can be raised later without breaking
 * existing hashes. Passwords are NFKC-normalised before hashing and verifying.
 */
export const ARGON2_PARAMETERS = {
  algorithm: 2 as Algorithm, // Argon2id
  memoryCost: 65_536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(normalisePassword(password), { ...ARGON2_PARAMETERS, salt: randomBytes(16) });
}

/** Never throws for a wrong or malformed hash: returns false. */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, normalisePassword(password));
  } catch {
    return false;
  }
}

/**
 * A hash of a random value, verified when an email is unknown, so unknown emails take as long
 * as wrong passwords (account-enumeration resistance).
 */
export function createDummyHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64'));
}
