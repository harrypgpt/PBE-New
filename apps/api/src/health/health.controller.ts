import { Controller, Get } from '@nestjs/common';
import type { HealthLiveResponse } from '@pbe/contracts';

@Controller('health')
export class HealthController {
  /** Liveness only. Readiness (`/health/ready`, database check) arrives in Stage 2. */
  @Get('live')
  live(): HealthLiveResponse {
    return { status: 'ok', service: 'pbe-api' };
  }
}
