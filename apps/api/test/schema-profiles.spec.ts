import {
  BASE_SCHEMA_VERSIONS,
  PROJECTS_SCHEMA_VERSIONS,
  SCHEMA_PROFILES,
  SCHEMA_VERSIONS,
} from '../src/modules/db';

/* ADR-030: the accepted ledgers are explicit and the generated types always match one of them. */

describe('schema profiles', () => {
  it('are exactly 0001–0004 and 0001–0006', () => {
    expect(SCHEMA_PROFILES).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4, 5, 6],
    ]);
    expect(BASE_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4]);
    expect(PROJECTS_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('the generated database types come from one accepted profile (fails if typegen moves elsewhere)', () => {
    expect(SCHEMA_PROFILES.map((p) => p.join(','))).toContain(SCHEMA_VERSIONS.join(','));
  });
});
