import { ProblemDetailsSchema } from '../src';

const valid = {
  type: 'https://pbe.local/problems/validation-error',
  title: 'Validation failed',
  status: 422,
  code: 'VALIDATION_FAILED',
  detail: '1 field is invalid.',
  requestId: 'req_123',
  errors: [{ path: 'name', code: 'REQUIRED', message: 'Name is required.' }],
};

describe('ProblemDetailsSchema', () => {
  it('accepts a complete problem-details body', () => {
    expect(ProblemDetailsSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a minimal body without optional fields', () => {
    const { detail: _detail, errors: _errors, ...minimal } = valid;
    expect(ProblemDetailsSchema.safeParse(minimal).success).toBe(true);
  });

  it.each([
    ['a non-error status (200)', { ...valid, status: 200 }],
    ['a status above 599', { ...valid, status: 600 }],
    ['a fractional status', { ...valid, status: 422.5 }],
    ['a lower-case code', { ...valid, code: 'validation_failed' }],
    ['a code with spaces', { ...valid, code: 'VALIDATION FAILED' }],
    ['a non-URL type', { ...valid, type: 'validation-error' }],
    ['an empty title', { ...valid, title: '' }],
    ['a missing requestId', { ...valid, requestId: undefined }],
    ['a field error without a path', { ...valid, errors: [{ code: 'REQUIRED', message: 'x' }] }],
  ])('rejects %s', (_label, input) => {
    expect(ProblemDetailsSchema.safeParse(input).success).toBe(false);
  });
});
