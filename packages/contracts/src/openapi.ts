import { z } from 'zod';
import { HEALTH_LIVE_PATH } from './health';
import { PROBLEM_JSON_MEDIA_TYPE } from './problem-details';
import { contractSchemas } from './registry';

export const API_DOCUMENT_VERSION = '0.1.0';

type JsonObject = { [key: string]: unknown };

/**
 * Converts every registered contract schema to an OpenAPI 3.1 (JSON Schema 2020-12) component.
 * References between schemas point at `#/components/schemas/<id>`.
 */
function componentSchemas(): Record<string, JsonObject> {
  const { schemas } = z.toJSONSchema(contractSchemas, {
    io: 'output',
    uri: (id) => `#/components/schemas/${id}`,
  });
  const components: Record<string, JsonObject> = {};
  for (const id of Object.keys(schemas).sort()) {
    const { $schema: _dialect, $id: _id, ...rest } = schemas[id] as JsonObject;
    components[id] = rest;
  }
  return components;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Builds the OpenAPI document from the shared Zod contracts.
 * Each operation declares its required permission (`x-pbe-permission`) and
 * idempotency requirement (`x-pbe-idempotency`), as API_CONTRACT_STANDARDS §12 requires.
 */
export function buildOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PBE API',
      version: API_DOCUMENT_VERSION,
      description:
        'PBE — Predictive Bioequivalence Engine. Decision-support software; outputs do not establish bioequivalence.',
    },
    paths: {
      [HEALTH_LIVE_PATH]: {
        get: {
          operationId: 'getHealthLive',
          summary: 'Liveness check',
          description: 'Confirms that the API process is running. Returns no tenant data.',
          tags: ['health'],
          security: [],
          'x-pbe-permission': 'PUBLIC',
          'x-pbe-idempotency': 'NOT_APPLICABLE',
          responses: {
            '200': {
              description: 'The API process is running.',
              content: { 'application/json': { schema: ref('HealthLiveResponse') } },
            },
            default: {
              description: 'Unexpected error.',
              content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ref('ProblemDetails') } },
            },
          },
        },
      },
    },
    components: { schemas: componentSchemas() },
  };
}
