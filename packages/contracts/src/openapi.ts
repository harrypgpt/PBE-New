import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE, ProblemDetailsSchema } from './problem-details';
import type { RouteContract } from './route';

/**
 * In-house OpenAPI 3.1 generator (ADR-022). Pure and deterministic: same contracts → same
 * document. JSON Schemas come from Zod's native converter (draft 2020-12, the dialect of OpenAPI 3.1).
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as Record<string, Json>;
  delete out.$schema;
  return out;
}

function responseSchema(schema: z.ZodType): Json {
  return schema === ProblemDetailsSchema
    ? { $ref: '#/components/schemas/ProblemDetails' }
    : jsonSchema(schema, 'output');
}

function parameters(where: 'path' | 'query', schema: z.ZodObject | undefined): Json[] {
  if (!schema) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, field]) => ({
    name,
    in: where,
    required: where === 'path' || !field.safeParse(undefined).success,
    schema: jsonSchema(field, 'input'),
  }));
}

export function buildOpenApiDocument(
  routes: readonly RouteContract[],
  info: { title: string; version: string },
): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const sorted = [...routes].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
  for (const r of sorted) {
    const openApiPath = r.path.replace(/:([A-Za-z0-9]+)/g, '{$1}');
    const responses: Record<string, Json> = {};
    for (const status of Object.keys(r.responses)
      .map(Number)
      .sort((a, b) => a - b)) {
      const resp = r.responses[status]!;
      responses[String(status)] = {
        description: resp.description,
        content: {
          [status >= 400 ? PROBLEM_CONTENT_TYPE : 'application/json']: {
            schema: responseSchema(resp.schema),
          },
        },
      };
    }
    const operation: Record<string, Json> = {
      operationId: r.operationId,
      summary: r.summary,
      'x-pbe-access':
        r.access.kind === 'public'
          ? { kind: 'public', reason: r.access.reason }
          : r.access.kind === 'authenticated'
            ? { kind: 'authenticated' }
            : { kind: 'permission', permission: r.access.permission },
      parameters: [
        ...parameters('path', r.request.params),
        ...parameters('query', r.request.query),
      ],
      responses,
    };
    if (r.request.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(r.request.body, 'input') } },
      };
    }
    (paths[openApiPath] ??= {})[r.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: info.title, version: info.version },
    servers: [{ url: '/api/v1' }],
    paths,
    components: { schemas: { ProblemDetails: jsonSchema(ProblemDetailsSchema, 'output') } },
  };
}
