import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { RECOVERY_CODE_COUNT } from '@pbe/contracts';

/**
 * Small cryptographic helpers built only on Node's crypto module (no custom primitives).
 */

export const sha256 = (value: string | Buffer): Buffer =>
  createHash('sha256').update(value).digest();

/** Session tokens: 256 random bits, base64url (43 characters). Only their SHA-256 is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isSessionTokenFormat(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export const sessionTokenHash = (token: string): Buffer => sha256(`session:${token}`);

/** Throttle keys: digests, so the throttle table holds no plain email or address. */
export const throttleKey = (kind: string, value: string): Buffer =>
  sha256(`throttle:${kind}:${value}`);

/** Recovery codes: XXXXX-XXXXX from an unambiguous alphabet (about 49 bits each). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(
      { length: 10 },
      () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
    );
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  });
}

export const recoveryCodeHash = (code: string): Buffer =>
  sha256(`recovery:${code.trim().toUpperCase().replace(/-/g, '')}`);

/**
 * AES-256-GCM encryption of MFA secrets. The key comes from configuration (R-010: development
 * storage only). The user id is bound as additional authenticated data, so a ciphertext copied to
 * another user's row does not decrypt. Layout: iv (12) | tag (16) | ciphertext.
 */
export class SecretBox {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('MFA encryption key must be 32 bytes');
    this.key = key;
    this.keyId = `k-${sha256(key).toString('hex').slice(0, 12)}`;
  }

  seal(userId: string, plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(userId, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(userId: string, sealed: Buffer, keyId: string): string {
    if (keyId !== this.keyId) throw new Error('MFA secret was sealed with a different key');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
  }
}
