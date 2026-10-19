import '../zod-config';
import {
  isRequestId,
  ProblemDetailsSchema,
  REQUEST_ID_HEADER,
  type ProblemDetails,
  type RouteContract,
} from '@pbe/contracts';
import type { z } from 'zod';

/**
 * Typed API client (ADR-022, STAGE-05-PLAN.md §3). It uses the SAME route contracts as the API:
 * the request is validated before it is sent, and the response is validated before anything
 * uses it. Anything unexpected becomes an ApiError with a plain-language message; raw server
 * text, stack traces and status internals never reach the screen.
 */

export const API_BASE_PATH = '/api/v1';

type SuccessStatus<C extends RouteContract> = Extract<
  keyof C['responses'],
  200 | 201 | 202 | 203 | 204 | 205 | 206
>;

export type RouteSuccess<C extends RouteContract> = {
  [S in SuccessStatus<C>]: {
    readonly status: S;
    readonly data: z.output<C['responses'][S]['schema']>;
    readonly requestId: string | undefined;
  };
}[SuccessStatus<C>];

export interface RouteInput {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface CallOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type ApiErrorKind = 'invalid-request' | 'problem' | 'unexpected-response' | 'network';

/** Messages written for people. They never include server text. */
const MESSAGES: Record<ApiErrorKind, string> = {
  'invalid-request':
    'The request could not be sent because some information is missing or invalid.',
  problem: 'The service could not complete the request.',
  'unexpected-response': 'The service returned a response this page could not use.',
  network: 'The service could not be reached.',
};

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | undefined,
    readonly requestId: string | undefined,
    readonly problem: ProblemDetails | undefined = undefined,
  ) {
    super(MESSAGES[kind]);
    this.name = 'ApiError';
  }
}

function validatePart(schema: z.ZodType | undefined, value: unknown, required: boolean): unknown {
  if (schema === undefined) {
    if (value !== undefined) throw new ApiError('invalid-request', undefined, undefined);
    return undefined;
  }
  if (value === undefined && !required) return undefined;
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new ApiError('invalid-request', undefined, undefined);
  return parsed.data;
}

function buildUrl(
  route: RouteContract,
  params: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  const path = route.path.replace(/:([A-Za-z0-9]+)/g, (_m, name: string) =>
    encodeURIComponent(String(params?.[name])),
  );
  const search = new URLSearchParams();
  for (const key of Object.keys(query ?? {}).sort()) {
    const value = query?.[key];
    if (value !== undefined) search.append(key, String(value));
  }
  const qs = search.toString();
  return `${API_BASE_PATH}${path}${qs ? `?${qs}` : ''}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function callRoute<C extends RouteContract>(
  route: C,
  input: RouteInput = {},
  options: CallOptions = {},
): Promise<RouteSuccess<C>> {
  const params = validatePart(route.request.params, input.params, true) as
    Record<string, unknown> | undefined;
  const query = validatePart(route.request.query, input.query, false) as
    Record<string, unknown> | undefined;
  const body = validatePart(route.request.body, input.body, route.request.body !== undefined);

  const headers: Record<string, string> = { accept: 'application/json, application/problem+json' };
  const init: RequestInit = {
    method: route.method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (options.signal) init.signal = options.signal;

  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(buildUrl(route, params, query), init);
  } catch {
    throw new ApiError('network', undefined, undefined);
  }

  const headerId = response.headers.get(REQUEST_ID_HEADER);
  const requestId = headerId !== null && isRequestId(headerId) ? headerId : undefined;
  const payload = await readJson(response);

  if (response.status >= 200 && response.status < 300) {
    const declared = route.responses[response.status];
    const parsed = declared?.schema.safeParse(payload);
    if (!parsed?.success) throw new ApiError('unexpected-response', response.status, requestId);
    return { status: response.status, data: parsed.data, requestId } as RouteSuccess<C>;
  }

  const problem = ProblemDetailsSchema.safeParse(payload);
  if (problem.success) {
    throw new ApiError('problem', response.status, problem.data.requestId, problem.data);
  }
  throw new ApiError('unexpected-response', response.status, requestId);
}
