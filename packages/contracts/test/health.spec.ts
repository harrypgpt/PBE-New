import { HealthLiveResponseSchema } from '../src';

describe('HealthLiveResponseSchema', () => {
  it('accepts a valid liveness response', () => {
    const result = HealthLiveResponseSchema.safeParse({ status: 'ok', service: 'pbe-api' });
    expect(result.success).toBe(true);
  });

  it.each([
    ['wrong status', { status: 'down', service: 'pbe-api' }],
    ['wrong service', { status: 'ok', service: 'other' }],
    ['missing status', { service: 'pbe-api' }],
    ['missing service', { status: 'ok' }],
    ['non-object', 'ok'],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(HealthLiveResponseSchema.safeParse(input).success).toBe(false);
  });

  it('reports which field is invalid', () => {
    const result = HealthLiveResponseSchema.safeParse({ status: 'down', service: 'pbe-api' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['status']);
  });
});
