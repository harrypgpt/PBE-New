import { MigrationError } from '../src/errors';
import type { MigrationFile } from '../src/migration-files';
import {
  advisoryLockKey,
  assertSafeSession,
  compareLedger,
  type LedgerRow,
  type SessionFacts,
} from '../src/runner';

const file = (version: number, name: string, checksum: string): MigrationFile => ({
  version,
  name,
  fileName: `${String(version).padStart(4, '0')}_${name}.sql`,
  sql: 'SELECT 1;',
  checksum: checksum.repeat(64).slice(0, 64),
  phase: 'expand',
  transactional: true,
});
const row = (version: number, name: string, checksum: string): LedgerRow => ({
  version,
  name,
  checksum_sha256: checksum.repeat(64).slice(0, 64),
  phase: 'expand',
  transactional: true,
  applied_at: new Date('2026-10-17T00:00:00Z'),
  applied_by: 'pbe_migrator',
  execution_ms: 1,
  runner_version: '1.0.0',
});

describe('compareLedger', () => {
  const files = [file(1, 'a', 'a'), file(2, 'b', 'b'), file(3, 'c', 'c')];

  it('reports everything pending on an empty ledger', () => {
    const r = compareLedger(files, []);
    expect(r.problems).toEqual([]);
    expect(r.pending.map((f) => f.version)).toEqual([1, 2, 3]);
  });

  it('reports applied and pending', () => {
    const r = compareLedger(files, [row(1, 'a', 'a'), row(2, 'b', 'b')]);
    expect(r.entries.map((e) => e.state)).toEqual(['applied', 'applied', 'pending']);
    expect(r.pending.map((f) => f.version)).toEqual([3]);
  });

  it.each([
    ['modified file', [row(1, 'a', 'a'), row(2, 'b', 'X')], 'CHECKSUM_MISMATCH', 'modified'],
    ['renamed file', [row(1, 'a', 'a'), row(2, 'old', 'b')], 'NAME_MISMATCH', 'name-mismatch'],
    [
      'missing file',
      [row(1, 'a', 'a'), row(2, 'b', 'b'), row(3, 'c', 'c'), row(4, 'd', 'd')],
      'MISSING_FILE',
      'missing-file',
    ],
    ['ledger gap', [row(1, 'a', 'a'), row(3, 'c', 'c')], 'LEDGER_INCONSISTENT', 'applied'],
  ])('detects a %s', (_label, ledger, code, state) => {
    const r = compareLedger(files, ledger);
    expect(r.problems[0]?.code).toBe(code);
    expect(r.entries.map((e) => e.state)).toContain(state);
  });
});

describe('assertSafeSession', () => {
  const ok: SessionFacts = {
    serverVersionNum: 180006,
    isSuperuser: false,
    bypassRls: false,
    user: 'pbe_migrator',
    database: 'pbe_dev',
  };
  const code = (facts: SessionFacts): string | undefined => {
    try {
      assertSafeSession(facts);
      return undefined;
    } catch (err) {
      return (err as MigrationError).code;
    }
  };

  it('accepts a non-superuser session on PostgreSQL 18', () => {
    expect(code(ok)).toBeUndefined();
  });
  it('refuses a superuser (unit level: no superuser credentials are available to the tests)', () => {
    expect(code({ ...ok, isSuperuser: true, user: 'postgres' })).toBe('UNSAFE_SESSION');
  });
  it('refuses a role with BYPASSRLS', () => {
    expect(code({ ...ok, bypassRls: true })).toBe('UNSAFE_SESSION');
  });
  it.each([170005, 190000])('refuses server version %i', (v) => {
    expect(code({ ...ok, serverVersionNum: v })).toBe('UNSUPPORTED_SERVER');
  });
});

describe('advisoryLockKey', () => {
  it('is a stable signed 64-bit integer per ledger schema', () => {
    const key = advisoryLockKey('pbe_meta');
    expect(key).toBe(advisoryLockKey('pbe_meta'));
    expect(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n).toBe(true);
    expect(advisoryLockKey('t_other_meta')).not.toBe(key);
  });
});
