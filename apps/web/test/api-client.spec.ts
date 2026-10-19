/** @jest-environment node */
import { defineRoute, healthRoute } from '@pbe/contracts';
import { z } from 'zod';
import { ApiError, callRoute } from '../src/api-client/client';
import { checkHealth } from '../src/api-client/health';

const REQUEST_ID = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': contentType, 'x-request-id': REQUEST_ID },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function expectApiError(promise: Promise<unknown>, kind: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe(kind);
  return error as ApiError;
}

const problem = {
  type: 'https://pbe.local/problems/service-unavailable',
  title: 'Service unavailable',
  status: 503,
  code: 'SERVICE_UNAVAILABLE',
  requestId: REQUEST_ID,
};

// A route with params, query and body, to exercise request validation.
const echoRoute = defineRoute({
  operationId: 'postThing',
  method: 'POST',
  path: '/things/:thingId',
  summary: 'Test only',
  access: { kind: 'permission', permission: 'thing.write' },
  request: {
    params: z.strictObject({ thingId: z.string().regex(/^[a-z]+$/) }),
    query: z.strictObject({ dryRun: z.enum(['yes', 'no']).optional() }),
    body: z.strictObject({ name: z.string().min(1) }),
  },
  responses: { 201: { description: 'Created', schema: z.strictObject({ id: z.string() }) } },
});

describe('S5-3 typed API client (shared contracts)', () => {
  it('accepts a valid health response and returns typed data with the request id', async () => {
    const { impl, calls } = fakeFetch(200, { status: 'ok' });
    const result = await callRoute(healthRoute, {}, { fetch: impl });
    expect(result).toEqual({ status: 200, data: { status: 'ok' }, requestId: REQUEST_ID });
    expect(calls[0]!.url).toBe('/api/v1/health');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });

  it('rejects an unexpected extra field', async () => {
    const { impl } = fakeFetch(200, { status: 'ok', version: '1.2.3' });
    await expectApiError(callRoute(healthRoute, {}, { fetch: impl }), 'unexpected-response');
  });

  it('rejects a wrong shape, a non-JSON body and an undeclared success status', async () => {
    await expectApiError(
      callRoute(healthRoute, {}, { fetch: fakeFetch(200, { status: 'down' }).impl }),
      'unexpected-response',
    );
    await expectApiError(
      callRoute(healthRoute, {}, { fetch: fakeFetch(200, '<html>', 'text/html').impl }),
      'unexpected-response',
    );
    await expectApiError(
      callRoute(healthRoute, {}, { fetch: fakeFetch(202, { status: 'ok' }).impl }),
      'unexpected-response',
    );
  });

  it('maps Problem Details to a typed error with the request id; message is plain language', async () => {
    const error = await expectApiError(
      callRoute(
        healthRoute,
        {},
        { fetch: fakeFetch(503, problem, 'application/problem+json').impl },
      ),
      'problem',
    );
    expect(error.status).toBe(503);
    expect(error.requestId).toBe(REQUEST_ID);
    expect(error.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.message).toBe('The service could not complete the request.');
  });

  it('a non-Problem error body (e.g. proxy error page) is "unexpected", and its text is not used', async () => {
    const error = await expectApiError(
      callRoute(
        healthRoute,
        {},
        {
          fetch: fakeFetch(500, 'Internal Server Error: ECONNREFUSED 127.0.0.1:3001', 'text/plain')
            .impl,
        },
      ),
      'unexpected-response',
    );
    expect(error.message).not.toMatch(/ECONNREFUSED|3001/);
  });

  it('a network failure gives a safe error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:3001');
    }) as unknown as typeof fetch;
    const error = await expectApiError(callRoute(healthRoute, {}, { fetch: failing }), 'network');
    expect(error.message).toBe('The service could not be reached.');
  });

  it('invalid request input is never sent', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'x' });
    await expectApiError(
      callRoute(echoRoute, { params: { thingId: 'BAD1' }, body: { name: 'a' } }, { fetch: impl }),
      'invalid-request',
    );
    await expectApiError(
      callRoute(echoRoute, { params: { thingId: 'ok' }, body: { name: '' } }, { fetch: impl }),
      'invalid-request',
    );
    await expectApiError(
      callRoute(
        echoRoute,
        { params: { thingId: 'ok' }, body: { name: 'a', admin: true } },
        { fetch: impl },
      ),
      'invalid-request',
    );
    await expectApiError(
      callRoute(
        echoRoute,
        { params: { thingId: 'ok' }, query: { other: '1' }, body: { name: 'a' } },
        { fetch: impl },
      ),
      'invalid-request',
    );
    await expectApiError(
      callRoute(healthRoute, { body: { x: 1 } }, { fetch: impl }),
      'invalid-request',
    );
    expect(calls).toHaveLength(0);
  });

  it('a valid request is sent with encoded path, sorted query and a JSON body', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'x' });
    const result = await callRoute(
      echoRoute,
      { params: { thingId: 'abc' }, query: { dryRun: 'yes' }, body: { name: 'A' } },
      { fetch: impl },
    );
    expect(result.data).toEqual({ id: 'x' });
    expect(calls[0]!.url).toBe('/api/v1/things/abc?dryRun=yes');
    expect(calls[0]!.init.body).toBe('{"name":"A"}');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('checkHealth reports available / unavailable without exposing errors', async () => {
    expect(await checkHealth({ fetch: fakeFetch(200, { status: 'ok' }).impl })).toEqual({
      available: true,
      requestId: REQUEST_ID,
    });
    expect(
      await checkHealth({ fetch: fakeFetch(503, problem, 'application/problem+json').impl }),
    ).toEqual({
      available: false,
      requestId: REQUEST_ID,
    });
  });
});
