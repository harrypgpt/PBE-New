import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_ROUTES,
  API_VERSION,
  buildOpenApiDocument,
  defineRoute,
  healthRoute,
  isStrictObject,
  PERMISSION_CODES,
  ProblemDetailsSchema,
  RouteContractError,
} from '@pbe/contracts';
import { z } from 'zod';
import { ProblemException } from '../src/common/problem';
import { AccessGuard } from '../src/common/route';
import type { AuthService } from '../src/modules/auth/auth.service';

const OPENAPI = path.join(__dirname, '..', '..', '..', 'openapi', 'openapi.json');
const generate = () =>
  `${JSON.stringify(buildOpenApiDocument(API_ROUTES, { title: 'PBE API', version: API_VERSION }), null, 2)}\n`;

const base = {
  operationId: 'getThing',
  method: 'GET' as const,
  path: '/things',
  summary: 'Thing',
  access: { kind: 'public' as const, reason: 'a public test route' },
  request: {},
  responses: { 200: { description: 'ok', schema: z.strictObject({}) } },
};

describe('route contracts (ADR-022)', () => {
  it.each([
    ['a non-camelCase operationId', { operationId: 'Get-Thing' }],
    ['a path with a trailing slash', { path: '/things/' }],
    ['a public route without a real reason', { access: { kind: 'public', reason: 'x' } }],
    ['a malformed permission', { access: { kind: 'permission', permission: 'READ' } }],
    ['a non-strict query object', { request: { query: z.object({ q: z.string() }) } }],
    ['path parameters not declared', { path: '/things/:thingId' }],
    ['no 2xx response', { responses: { 404: { description: 'x', schema: ProblemDetailsSchema } } }],
  ])('rejects %s', (_label, change) => {
    expect(() => defineRoute({ ...base, ...change } as never)).toThrow(RouteContractError);
  });

  it('accepts a valid contract and recognises strict objects', () => {
    expect(defineRoute(base)).toBe(base);
    expect(isStrictObject(z.strictObject({ a: z.string() }))).toBe(true);
    expect(isStrictObject(z.object({ a: z.string() }))).toBe(false);
  });

  it('every public route has a written reason; every permission is in the fixed catalogue (ADR-029)', () => {
    expect(API_ROUTES.map((r) => r.operationId).slice(0, 8)).toEqual([
      'getHealth',
      'postAuthLogin',
      'postAuthMfaVerify',
      'postAuthLogout',
      'getSession',
      'postAccountPassword',
      'postAccountMfaEnrolment',
      'postAccountMfaConfirmation',
    ]);
    expect(healthRoute.access).toMatchObject({ kind: 'public' });
    for (const r of API_ROUTES) {
      if (r.access.kind === 'public') expect(r.access.reason.length).toBeGreaterThan(20);
      if (r.access.kind === 'permission')
        expect(PERMISSION_CODES.has(r.access.permission)).toBe(true);
    }
    // Tenant routes never take a tenant id from the request (no path, query or body field).
    for (const r of API_ROUTES.filter((x) => x.path.startsWith('/tenant/'))) {
      expect(r.path).not.toMatch(/tenantId/);
      const body = r.request.body as { shape?: Record<string, unknown> } | undefined;
      expect(Object.keys(body?.shape ?? {})).not.toContain('tenantId');
    }
  });
});

describe('S4-7 OpenAPI document in sync', () => {
  it('the committed openapi/openapi.json equals a fresh generation from the contracts', () => {
    expect(fs.readFileSync(OPENAPI, 'utf8')).toBe(generate());
  });

  it('is deterministic, OpenAPI 3.1, and documents access and the Problem Details schema', () => {
    const doc = JSON.parse(generate()) as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            'x-pbe-access': unknown;
            responses: Record<string, { content: Record<string, { schema: unknown }> }>;
          }
        >
      >;
      components: { schemas: Record<string, { additionalProperties?: boolean }> };
    };
    expect(generate()).toBe(generate());
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/health']!.get!['x-pbe-access']).toEqual(healthRoute.access);
    expect(
      doc.paths['/health']!.get!.responses['503']!.content['application/problem+json']!.schema,
    ).toEqual({
      $ref: '#/components/schemas/ProblemDetails',
    });
    expect(doc.components.schemas.ProblemDetails!.additionalProperties).toBe(false);
  });

  it('a stale copy is detected (a changed contract changes the document)', () => {
    const changed = defineRoute({ ...base, operationId: 'getExtra', path: '/extra' });
    const other = `${JSON.stringify(buildOpenApiDocument([...API_ROUTES, changed], { title: 'PBE API', version: API_VERSION }), null, 2)}\n`;
    expect(other).not.toBe(fs.readFileSync(OPENAPI, 'utf8'));
  });
});

describe('S4-8 / S6 default deny and access kinds (guard, unit level)', () => {
  const ORIGIN = 'http://localhost:3000';
  const ctx = (req: Record<string, unknown>) =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, socket: {}, ...req }) }),
    }) as unknown as ExecutionContext;
  const guard = (
    contract: unknown,
    req: Record<string, unknown> = { method: 'GET' },
    session: unknown = null,
  ) => {
    const reflector = { get: () => contract } as unknown as Reflector;
    const auth = { resolve: async () => session } as unknown as AuthService;
    // No database is reached in these unit cases (they end before permission resolution).
    return new AccessGuard(reflector, auth, [ORIGIN], {} as never).canActivate(ctx(req));
  };

  it('refuses a route with no access declaration (403)', async () => {
    await expect(guard(undefined)).rejects.toMatchObject({ status: 403, code: 'ACCESS_DENIED' });
  });

  it('refuses a permission that is not in the fixed catalogue (403), even when signed in', async () => {
    const locked = { ...base, access: { kind: 'permission', permission: 'project.read' } };
    await expect(guard(locked)).rejects.toBeInstanceOf(ProblemException);
    await expect(guard(locked, { method: 'GET' }, { state: 'active' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a catalogue permission route needs a complete session first (401 without)', async () => {
    const route = { ...base, access: { kind: 'permission', permission: 'tenant.members.read' } };
    await expect(guard(route)).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('ADR-030: a permission the connected database does not have answers 404 "not available" (after sign-in)', async () => {
    const reflector = { get: () => route } as unknown as Reflector;
    const route = { ...base, access: { kind: 'permission', permission: 'tenant.projects.read' } };
    const withSession = (session: unknown) =>
      new AccessGuard(
        reflector,
        { resolve: async () => session } as unknown as AuthService,
        [ORIGIN],
        {} as never,
        new Set(['tenant.members.read']), // the base profile: no project permissions
      ).canActivate(ctx({ method: 'GET' }));
    await expect(withSession(null)).rejects.toMatchObject({ status: 401 });
    await expect(withSession({ state: 'active' })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      options: expect.objectContaining({
        detail: 'This feature is not available on this database yet.',
      }),
    });
  });

  it('allows a declared public route', async () => {
    await expect(guard(base)).resolves.toBe(true);
  });

  it('"authenticated" needs a complete session (401 without, or while MFA is pending)', async () => {
    const signedIn = { ...base, access: { kind: 'authenticated' } };
    await expect(guard(signedIn)).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
    await expect(
      guard(signedIn, { method: 'GET' }, { state: 'pending_mfa' }),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(guard(signedIn, { method: 'GET' }, { state: 'active' })).resolves.toBe(true);
  });

  it('S6-12 refuses state-changing requests not from a PBE web origin', async () => {
    const post = (headers: Record<string, string>) => guard(base, { method: 'POST', headers });
    await expect(post({})).rejects.toMatchObject({ status: 403 });
    await expect(post({ origin: 'https://attacker.example' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(post({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      post({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      post({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
    ).resolves.toBe(true);
  });
});
