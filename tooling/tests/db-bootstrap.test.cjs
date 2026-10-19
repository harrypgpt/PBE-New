'use strict';
const nodeCrypto = require('node:crypto');
const {
  scramSha256Verifier,
  randomPassword,
  parseScramVerifier,
  verifierMatchesPassword,
} = require('../scripts/lib/scram.cjs');
const { upsertEnv, choosePasswords, makeVerifiers } = require('../scripts/db-bootstrap.cjs');

describe('SCRAM-SHA-256 verifier', () => {
  test('has PostgreSQL stored format and never contains the password', () => {
    const pw = randomPassword();
    const v = scramSha256Verifier(pw);
    expect(v).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(v).not.toContain(pw);
  });

  test('is deterministic for a given salt and differs for another password', () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramSha256Verifier('abc', { salt })).toBe(scramSha256Verifier('abc', { salt }));
    expect(scramSha256Verifier('abd', { salt })).not.toBe(scramSha256Verifier('abc', { salt }));
  });

  test('follows the RFC 5802 key derivation written out step by step (the real proof is the login check)', () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const salted = nodeCrypto.pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
    const clientKey = nodeCrypto.createHmac('sha256', salted).update('Client Key').digest();
    const stored = nodeCrypto.createHash('sha256').update(clientKey).digest('base64');
    const server = nodeCrypto.createHmac('sha256', salted).update('Server Key').digest('base64');
    expect(scramSha256Verifier('pencil', { salt })).toBe(
      `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`,
    );
  });

  test('random passwords are 43 base64url characters and unique', () => {
    const a = randomPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomPassword()).not.toBe(a);
  });
});

describe('.env update', () => {
  test('replaces PBE keys and keeps unrelated lines', () => {
    const before = '# mine\nOTHER=1\nPBE_PG_APP_PASSWORD=old\n';
    expect(upsertEnv(before, { PBE_PG_APP_PASSWORD: 'new', PBE_PG_HOST: 'localhost' })).toBe(
      '# mine\nOTHER=1\nPBE_PG_APP_PASSWORD=new\nPBE_PG_HOST=localhost\n',
    );
  });
  test('works on an empty file', () => {
    expect(upsertEnv('', { A: '1' })).toBe('A=1\n');
  });
});

describe('password reuse on re-run', () => {
  test('keeps existing usable passwords and generates only the missing ones', () => {
    const keepM = randomPassword();
    const keepA = randomPassword();
    const chosen = choosePasswords(
      `PBE_PG_MIGRATOR_PASSWORD=${keepM}\nPBE_PG_APP_PASSWORD=${keepA}\n`,
    );
    expect(chosen.migrator).toEqual({ password: keepM, reused: true });
    expect(chosen.app).toEqual({ password: keepA, reused: true });
    expect(chosen.restore.reused).toBe(false);
    expect(chosen.restore.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('replaces a placeholder or unusable value', () => {
    const chosen = choosePasswords('PBE_PG_APP_PASSWORD=<generated-by-db-bootstrap>\n');
    expect(chosen.app.reused).toBe(false);
  });
});

describe('verifier validation before anything is sent to PostgreSQL', () => {
  test('a generated verifier parses and matches only its own password', () => {
    const pw = randomPassword();
    const v = scramSha256Verifier(pw);
    expect(parseScramVerifier(v)).toMatchObject({ iterations: 4096 });
    expect(verifierMatchesPassword(pw, v)).toBe(true);
    expect(verifierMatchesPassword(randomPassword(), v)).toBe(false);
  });

  test('malformed or weak secrets are rejected (PostgreSQL would hash them again as a plain password)', () => {
    const v = scramSha256Verifier(randomPassword());
    for (const bad of [
      '',
      'plain-password',
      v.replace('SCRAM-SHA-256', 'SCRAM-SHA-1'),
      v.replace('$4096:', '$1000:'),
      v.replace(/:[^$]+\$/, ':c2FsdA==$'),
      v.slice(0, -2),
      `${v}x`,
      `md5${'0'.repeat(32)}`,
    ]) {
      expect(parseScramVerifier(bad)).toBeNull();
    }
  });

  test('makeVerifiers gives one valid verifier per role (four, including pbe_backup)', () => {
    const chosen = choosePasswords('');
    const verifiers = makeVerifiers(chosen);
    expect(Object.keys(verifiers).sort()).toEqual([
      'PBE_APP_VERIFIER',
      'PBE_BACKUP_VERIFIER',
      'PBE_MIGRATOR_VERIFIER',
      'PBE_RESTORE_VERIFIER',
    ]);
    expect(verifierMatchesPassword(chosen.backup.password, verifiers.PBE_BACKUP_VERIFIER)).toBe(
      true,
    );
    for (const v of Object.values(verifiers)) {
      for (const { password } of Object.values(chosen)) expect(v).not.toContain(password);
    }
  });
});
