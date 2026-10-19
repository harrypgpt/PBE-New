import { z } from 'zod';

/**
 * Route contracts (ADR-022). Every API route is described here once: its path, request schemas,
 * every response schema and — mandatory — who may call it. The API validates every request and
 * response against the contract, and the OpenAPI document is generated from it.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Permission names look like "area.action" (e.g. "project.read"). Shared by the API and the web app. */
export const PERMISSION_PATTERN = /^[a-z]+(\.[a-z]+)+$/;

/**
 * Default deny: every route must declare access. "public" needs a written reason.
 * "authenticated" (ADR-022 amendment, Stage 6) means any fully signed-in user; it grants no role,
 * tenant or resource permission.
 */
export type RouteAccess =
  | { readonly kind: 'public'; readonly reason: string }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: string };

export interface RouteResponse {
  readonly description: string;
  readonly schema: z.ZodType;
}

export interface RouteContract {
  /** Unique, camelCase, e.g. "getHealth". */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Path below /api/v1, e.g. "/health" or "/projects/:projectId". */
  readonly path: string;
  readonly summary: string;
  readonly access: RouteAccess;
  readonly request: {
    readonly params?: z.ZodObject;
    readonly query?: z.ZodObject;
    readonly body?: z.ZodType;
  };
  /** Keyed by HTTP status. At least one 2xx entry. */
  readonly responses: Readonly<Record<number, RouteResponse>>;
}

export class RouteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteContractError';
  }
}

/** True when a Zod object rejects unknown keys (z.strictObject / .strict()). */
export function isStrictObject(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject && schema.def.catchall instanceof z.ZodNever;
}

/** Validates a contract's shape and returns it unchanged. Mistakes fail at load time, not in production. */
export function defineRoute<T extends RouteContract>(contract: T): T {
  const fail = (msg: string): never => {
    throw new RouteContractError(`Route contract ${contract.operationId || '(unnamed)'}: ${msg}`);
  };
  if (!/^[a-z][A-Za-z0-9]*$/.test(contract.operationId)) fail('operationId must be camelCase');
  if (!/^(\/(:[a-z][A-Za-z0-9]*|[a-z0-9-]+))+$/.test(contract.path)) {
    fail('path must look like /segment or /segment/:param (lower case, no trailing slash)');
  }
  if (contract.summary.trim().length === 0) fail('summary is required');
  if (contract.access.kind === 'public' && contract.access.reason.trim().length < 10) {
    fail('a public route needs a written reason (at least 10 characters)');
  }
  if (
    contract.access.kind === 'permission' &&
    !PERMISSION_PATTERN.test(contract.access.permission)
  ) {
    fail('permission must look like "area.action"');
  }
  for (const [part, schema] of Object.entries(contract.request)) {
    if (
      schema &&
      (part === 'params' || part === 'query' || schema instanceof z.ZodObject) &&
      !isStrictObject(schema)
    ) {
      fail(`request.${part} must be a strict object (unknown fields are rejected)`);
    }
  }
  const pathParams = [...contract.path.matchAll(/:([a-zA-Z0-9]+)/g)].map((m) => m[1]).sort();
  const declared = Object.keys(contract.request.params?.shape ?? {}).sort();
  if (pathParams.join() !== declared.join())
    fail('request.params must declare exactly the path parameters');
  const statuses = Object.keys(contract.responses).map(Number);
  if (!statuses.some((s) => s >= 200 && s < 300)) fail('at least one 2xx response is required');
  if (statuses.some((s) => !Number.isInteger(s) || s < 200 || s > 599))
    fail('invalid response status');
  return contract;
}
