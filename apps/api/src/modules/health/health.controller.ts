import { Controller, Inject } from '@nestjs/common';
import { healthRoute, type HealthResponse } from '@pbe/contracts';
import { ProblemException } from '../../common/problem';
import { Route } from '../../common/route';
import { checkDatabaseHealth, type Database } from '../db';

export const DATABASE = Symbol('DATABASE');
export const EXPECTED_SCHEMA_VERSIONS = Symbol('EXPECTED_SCHEMA_VERSIONS');

/** GET /api/v1/health — reveals only "ok"; the reason for a failure goes to the log, not the caller. */
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EXPECTED_SCHEMA_VERSIONS) private readonly expected: readonly number[],
  ) {}

  @Route(healthRoute)
  async get(): Promise<HealthResponse> {
    const result = await checkDatabaseHealth(this.db, this.expected);
    if (!result.ok) {
      throw new ProblemException(503, 'SERVICE_UNAVAILABLE', 'Service unavailable', {
        internal: result.reason,
      });
    }
    return { status: 'ok' };
  }
}
