import { z } from 'zod';
import { contractSchemas } from './registry';

/** Liveness path. Health endpoints sit outside API versioning (API_CONTRACT_STANDARDS §1). */
export const HEALTH_LIVE_PATH = '/health/live';

/**
 * Response of `GET /health/live`. It confirms only that the API process is running.
 * It deliberately contains no tenant data, configuration or version details.
 */
export const HealthLiveResponseSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('pbe-api'),
  })
  .meta({ description: 'Liveness status of the PBE API process.' })
  .register(contractSchemas, { id: 'HealthLiveResponse' });

export type HealthLiveResponse = z.infer<typeof HealthLiveResponseSchema>;
