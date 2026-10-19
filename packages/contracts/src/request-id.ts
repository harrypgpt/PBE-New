/** Request correlation (API_CONTRACT_STANDARDS.md §9). Only well-formed UUIDs are accepted from callers. */
export const REQUEST_ID_HEADER = 'x-request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
