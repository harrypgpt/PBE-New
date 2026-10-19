import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { redact } from '../src/common/logger';
import type { PbeRequest } from '../src/common/http';
import { ARGON2_PARAMETERS, hashPassword, verifyPassword } from '../src/modules/auth/password-hash';
import { Blocklist, passwordProblem } from '../src/modules/auth/password-policy';
import {
  clearedSessionCookie,
  clientAddress,
  sessionCookie,
  sessionTokenFrom,
} from '../src/modules/auth/http-auth';
import {
  newRecoveryCodes,
  newSessionToken,
  recoveryCodeHash,
  SecretBox,
} from '../src/modules/auth/secrets';
import { newTotpSecret, verifiedTimeStep } from '../src/modules/auth/totp';

// Test passwords are generated at run time; none is written in this file.
const strong = () => `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`;

describe('S6-14 password policy (15–128 characters, blocklist, context)', () => {
  const blocklist = Blocklist.load();
  const ctx = { email: 'dana.fictional@example.test' };

  it('loads the versioned compromised-password blocklist (thousands of entries of 15+ characters)', () => {
    expect(blocklist.size).toBeGreaterThan(10_000);
    expect(blocklist.version).toBe(1);
  });

  it('accepts a strong password', () => {
    expect(passwordProblem(strong(), ctx, blocklist)).toBeNull();
  });

  it.each([
    ['too short (14 characters)', 'x'.repeat(7) + 'y'.repeat(7), /at least 15/],
    ['too long (129 characters)', 'ab1'.repeat(43), /at most 128/],
    ['repetitive', 'abcabcabcabcabcabc', /repetitive/],
    ['containing the email name', 'dana.fictional-likes-tea-2026', /email/],
    ['based on the product name', 'pbe2026!!!!!!!!!!', /product name/],
    ['with a control character', 'correct horse\u0007battery staple', /control/],
  ])('refuses a password %s', (_label, password, message) => {
    expect(passwordProblem(password, ctx, blocklist)).toMatch(message);
  });

  it('refuses a compromised password from the list, in any letter case', () => {
    const entry = [...Array(1)].map(() => 'abcdefghijklmnop')[0]!;
    const list = Blocklist.fromEntries([entry]);
    expect(passwordProblem(entry.toUpperCase(), ctx, list)).toMatch(/data breach/);
  });

  it('counts characters after NFKC normalisation (code points, not bytes)', () => {
    // 15 full-width letters normalise to 15 ASCII letters: accepted length-wise.
    const fullWidth = 'ｍｙｌｏｎｇｐａｓｓｗｏｒｄｘ';
    expect([...fullWidth]).toHaveLength(15);
    expect(passwordProblem(fullWidth, ctx, Blocklist.fromEntries([]))).toBeNull();
  });
});

describe('S6-15 password hashing (Argon2id, recorded parameters)', () => {
  it('produces an Argon2id PHC string with 64 MiB, 3 passes, parallelism 1 and a 16-byte salt', async () => {
    const pw = strong();
    const phc = await hashPassword(pw);
    expect(phc).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(phc).not.toContain(pw);
    expect(ARGON2_PARAMETERS).toMatchObject({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  });

  it('verifies the right password, refuses a wrong one, and never throws on a broken hash', async () => {
    const pw = strong();
    const phc = await hashPassword(pw);
    expect(await verifyPassword(phc, pw)).toBe(true);
    expect(await verifyPassword(phc, `${pw}x`)).toBe(false);
    expect(await verifyPassword('not-a-hash', pw)).toBe(false);
  });

  it('salts every hash (same password, different hashes)', async () => {
    const pw = strong();
    expect(await hashPassword(pw)).not.toBe(await hashPassword(pw));
  });
});

describe('S6-10 TOTP (otpauth, RFC 6238)', () => {
  it('reproduces the RFC 6238 SHA-1 test vectors', () => {
    const secret = Secret.fromLatin1('12345678901234567890');
    const gen = (t: number) =>
      TOTP.generate({ secret, algorithm: 'SHA1', digits: 8, period: 30, timestamp: t * 1000 });
    expect(gen(59)).toBe('94287082');
    expect(gen(1111111109)).toBe('07081804');
    expect(gen(1234567890)).toBe('89005924');
  });

  it('accepts the current code and ±1 step, refuses others, and reports the time step', () => {
    const b32 = newTotpSecret();
    expect(b32).toMatch(/^[A-Z2-7]{32}$/);
    const now = Date.UTC(2026, 9, 17, 12, 0, 15);
    const at = (ms: number) =>
      TOTP.generate({
        secret: Secret.fromBase32(b32),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        timestamp: ms,
      });
    const step = Math.floor(now / 30_000);
    expect(verifiedTimeStep(b32, at(now), now)).toBe(step);
    expect(verifiedTimeStep(b32, at(now - 30_000), now)).toBe(step - 1);
    expect(verifiedTimeStep(b32, at(now + 30_000), now)).toBe(step + 1);
    expect(verifiedTimeStep(b32, at(now - 90_000), now)).toBeNull();
  });
});

describe('MFA secret encryption (AES-256-GCM, user-bound)', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const user = '01927f5e-0000-7000-8000-000000000001';

  it('round-trips, and the ciphertext does not contain the secret', () => {
    const secret = newTotpSecret();
    const sealed = box.seal(user, secret);
    expect(sealed.toString('latin1')).not.toContain(secret);
    expect(box.open(user, sealed, box.keyId)).toBe(secret);
  });

  it('refuses another user, a tampered ciphertext and another key', () => {
    const sealed = box.seal(user, newTotpSecret());
    expect(() => box.open('01927f5e-0000-7000-8000-000000000002', sealed, box.keyId)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(user, tampered, box.keyId)).toThrow();
    const other = new SecretBox(randomBytes(32).toString('base64'));
    expect(() => other.open(user, sealed, box.keyId)).toThrow(/different key/);
  });
});

describe('recovery codes and session tokens', () => {
  it('issues 10 distinct XXXXX-XXXXX codes; hashing ignores case and the dash', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    const c = codes[0]!;
    expect(recoveryCodeHash(c.toLowerCase().replace('-', ''))).toEqual(recoveryCodeHash(c));
  });

  it('session tokens are 256-bit, URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 100 }, newSessionToken));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('S6-11 session cookie', () => {
  it('has the __Host- prefix, HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain', () => {
    const cookie = sessionCookie(newSessionToken());
    expect(cookie).toMatch(/^__Host-pbe_session=[A-Za-z0-9_-]{43}; /);
    for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict'])
      expect(cookie).toContain(flag);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });

  it('reads only a well-formed session token from the Cookie header', () => {
    const token = newSessionToken();
    const req = (cookie?: string) =>
      ({ headers: cookie ? { cookie } : {} }) as unknown as PbeRequest;
    expect(sessionTokenFrom(req(`a=b; __Host-pbe_session=${token}; c=d`))).toBe(token);
    expect(sessionTokenFrom(req('__Host-pbe_session=short'))).toBeNull();
    expect(sessionTokenFrom(req('pbe_session=' + token))).toBeNull();
    expect(sessionTokenFrom(req())).toBeNull();
  });
});

describe('client address for throttling', () => {
  const req = (peer: string, xff?: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: xff ? { 'x-forwarded-for': xff } : {},
    }) as unknown as PbeRequest;

  it('trusts X-Forwarded-For (right-most entry) only from the local web server', () => {
    expect(clientAddress(req('127.0.0.1', '203.0.113.9, 198.51.100.7'))).toBe('198.51.100.7');
    expect(clientAddress(req('::ffff:127.0.0.1', '198.51.100.7'))).toBe('198.51.100.7');
    expect(clientAddress(req('192.0.2.10', '198.51.100.7'))).toBe('192.0.2.10');
    expect(clientAddress(req('127.0.0.1', 'not-an-ip'))).toBe('127.0.0.1');
  });
});

describe('S6-13 (unit part) redaction covers MFA and recovery fields', () => {
  it('redacts codes, recovery codes, manual keys and QR content by key name', () => {
    const out = JSON.stringify(
      redact({
        code: 'x',
        totpCode: '123456',
        recoveryCode: 'AAAAA-BBBBB',
        manualKey: 'K',
        qrSvg: '<svg/>',
      }),
    );
    expect(out).not.toMatch(/123456|AAAAA-BBBBB|"K"|<svg/);
  });
});
