import {
  parseTenantContext,
  TenantContextError,
  withTenantTransaction,
  type Database,
} from '../src/modules/db';

const A = '5f0c7a3e-1b2d-4c8e-9a1f-0e2d3c4b5a69';
const U = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('parseTenantContext (B4: invalid ids rejected before any SQL)', () => {
  it('accepts a valid context and normalises case', () => {
    expect(parseTenantContext({ tenantId: A.toUpperCase(), userId: U })).toEqual({
      tenantId: A,
      userId: U,
    });
  });

  it.each([
    ['null', null],
    ['a string', A],
    ['an array', [A, U]],
    ['missing userId', { tenantId: A }],
    ['missing tenantId', { userId: U }],
    ['an extra field', { tenantId: A, userId: U, role: 'admin' }],
    ['empty tenantId', { tenantId: '', userId: U }],
    ['non-UUID tenantId', { tenantId: 'tenant-a', userId: U }],
    ['SQL in tenantId', { tenantId: `${A}'; SELECT 1; --`, userId: U }],
    ['nil UUID', { tenantId: '00000000-0000-0000-0000-000000000000', userId: U }],
    ['numeric tenantId', { tenantId: 42, userId: U }],
    ['non-UUID userId', { tenantId: A, userId: 'someone' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseTenantContext(input)).toThrow(TenantContextError);
  });

  it('withTenantTransaction rejects before asking the database for a transaction', async () => {
    let touched = false;
    const db = new Proxy({} as Database, {
      get() {
        touched = true;
        throw new Error('database must not be used');
      },
    });
    await expect(
      withTenantTransaction(db, { tenantId: 'bad', userId: U }, async () => 1),
    ).rejects.toThrow(TenantContextError);
    expect(touched).toBe(false);
  });
});
