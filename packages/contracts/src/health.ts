import { z } from 'zod';
import { ProblemDetailsSchema } from './problem-details';
import { defineRoute } from './route';

/** Health reports only "ok" — never versions, hostnames or error details (STAGE-04-PLAN.md §3). */
export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const healthRoute = defineRoute({
  operationId: 'getHealth',
  method: 'GET',
  path: '/health',
  summary: 'Service health: database reachable and at the expected migration version',
  access: {
    kind: 'public',
    reason: 'Liveness/readiness probe for operators and monitoring; returns no data.',
  },
  request: {},
  responses: {
    200: { description: 'The API and its database are healthy.', schema: HealthResponseSchema },
    503: {
      description: 'The database is unavailable or not at the expected version.',
      schema: ProblemDetailsSchema,
    },
  },
});
