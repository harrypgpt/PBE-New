import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller, Get, Inject } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  API_ROUTES,
  defineRoute,
  HealthResponseSchema,
  ProblemDetailsSchema,
  type RouteContract,
} from '@pbe/contracts';
import pg from 'pg';
import { z } from 'zod';
import { createApp, StartupError } from '../../apps/api/src/app';
import { loadConfig, type ApiConfig } from '../../apps/api/src/config/config';
import { Route, Validated } from '../../apps/api/src/common/route';
import {
  checkDatabaseHealth,
  createDatabase,
  SCHEMA_VERSIONS,
  type Database,
} from '../../apps/api/src/modules/db';
import { DATABASE } from '../../apps/api/src/modules/health/health.controller';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { dbConfig, ENV, ROOT } from './helpers';

/*
 * Stage 4 HTTP tests (STAGE-04-PLAN.md §5). The real API runs against real PostgreSQL 18
 * (pbe_test, as pbe_app) and is called over real HTTP on a random local port.
 * Test-only routes below exist only in this file.
 */

// Fake secrets assembled at run time: the source must not contain credential-shaped literals.
const SECRET_PASSWORD = ['Sup3r', 'S3cret', 'Pa55word', 'in', 'request'].join('-');
const SECRET_CONN = ['postgres://pbe_app:', 'Sup3rS3cretConnPw', '@db.internal:5432/pbe_dev'].join(
  '',
);
const CONFIDENTIAL = 'confidential formulation: 42.7 mg API per tablet';

const echoRoute = defineRoute({
  operationId: 'postTestEcho',
  method: 'POST',
  path: '/test/echo',
  summary: 'Test only: echoes a validated body',
  access: { kind: 'public', reason: 'test-only route used by the Stage 4 tests' },
  request: {
    query: z.strictObject({ mode: z.enum(['a', 'b']).optional() }),
    body: z.strictObject({
      name: z.string().min(1),
      count: z.number().int(),
      note: z.string().optional(),
    }),
  },
  responses: {
    201: { description: 'echo', schema: z.strictObject({ name: z.string(), count: z.number() }) },
  },
});
const boomRoute = defineRoute({
  operationId: 'getTestBoom',
  method: 'GET',
  path: '/test/boom',
  summary: 'Test only: throws an unexpected error',
  access: { kind: 'public', reason: 'test-only route used by the Stage 4 tests' },
  request: {},
  responses: { 200: { description: 'never', schema: z.strictObject({}) } },
});
const leakyRoute = defineRoute({
  operationId: 'getTestLeaky',
  method: 'GET',
  path: '/test/leaky',
  summary: 'Test only: returns more than its contract allows',
  access: { kind: 'public', reason: 'test-only route used by the Stage 4 tests' },
  request: {},
  responses: { 200: { description: 'status only', schema: HealthResponseSchema } },
});
const lockedRoute = defineRoute({
  operationId: 'getTestLocked',
  method: 'GET',
  path: '/test/locked',
  summary: 'Test only: needs a permission',
  access: { kind: 'permission', permission: 'project.read' },
  request: {},
  responses: { 200: { description: 'never reached', schema: z.strictObject({}) } },
});
const slowRoute = defineRoute({
  operationId: 'getTestSlow',
  method: 'GET',
  path: '/test/slow',
  summary: 'Test only: two database queries, the second starting after half a second',
  access: { kind: 'public', reason: 'test-only route used by the shutdown tests' },
  request: {},
  responses: { 200: { description: 'done', schema: z.strictObject({ done: z.boolean() }) } },
});
const TEST_ROUTES: RouteContract[] = [
  ...API_ROUTES,
  echoRoute,
  boomRoute,
  leakyRoute,
  lockedRoute,
  slowRoute,
];

@Controller()
class TestRoutesController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Route(slowRoute)
  async slow() {
    // First query holds a connection for 0.5 s; the SECOND needs the pool again afterwards, i.e.
    // after a shutdown has begun. It only succeeds if the pool is ended after requests finish.
    await this.db.selectNoFrom((eb) => eb.fn('pg_sleep', [eb.val(0.5)]).as('slept')).execute();
    await this.db.selectNoFrom((eb) => eb.val(1).as('one')).execute();
    return { done: true };
  }
  @Route(echoRoute)
  echo(@Validated('body') body: { name: string; count: number }) {
    return { name: body.name, count: body.count };
  }
  @Route(boomRoute)
  boom(): never {
    throw new Error(`query failed: SELECT password FROM users; ${SECRET_CONN}`);
  }
  @Route(leakyRoute)
  leaky() {
    return { status: 'ok', internalNote: CONFIDENTIAL };
  }
  @Route(lockedRoute)
  locked() {
    return {};
  }
}

/** Needs a dependency nobody provides: building the application fails. */
@Controller()
class MissingDependencyController {
  constructor(@Inject('PBE_TEST_NOT_PROVIDED') readonly missing: unknown) {}
}

@Controller()
class UndeclaredController {
  @Get('test/undeclared')
  undeclared() {
    return { leaked: true };
  }
}

function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  const app = dbConfig('app');
  return loadConfig({
    NODE_ENV: 'test',
    PBE_LOG_LEVEL: 'debug',
    PBE_PG_HOST: String(app.host),
    PBE_PG_PORT: String(app.port),
    PBE_PG_DEV_DATABASE: String(app.database),
    PBE_PG_APP_USER: String(app.user),
    PBE_PG_APP_PASSWORD: String(app.password),
    PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ...overrides,
  });
}

let app: NestExpressApplication;
let base: string;
const logs: string[] = [];

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/v1${path}`, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json: json as Record<string, unknown> };
}
// Stage 6: state-changing requests must come from a PBE web origin (CSRF defence, ADR-026).
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
  });

beforeAll(async () => {
  await migrate({ connection: dbConfig('migrator'), migrationsDir: migrationsDir(ROOT) });
  app = await createApp({
    config: testConfig(),
    logSink: (l) => logs.push(l),
    routes: TEST_ROUTES,
    extraControllers: [TestRoutesController],
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('S4-9 health against real PostgreSQL (pbe_test, as pbe_app)', () => {
  it('returns 200 {"status":"ok"} matching the contract, with safe headers', async () => {
    const { res, json } = await call('/health');
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(json)).toEqual({ status: 'ok' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('S4-2 invalid requests → 400 Problem Details', () => {
  it.each([
    ['a wrong type', '{"name":"n","count":"three"}', ['body.count']],
    ['a missing field', '{"count":3}', ['body.name']],
    ['an unknown extra field (mass assignment)', '{"name":"n","count":3,"isAdmin":true}', ['body']],
  ])('%s', async (_label, body, paths) => {
    const { res, json } = await post('/test/echo', body);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const problem = ProblemDetailsSchema.parse(json);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.path)).toEqual(paths);
  });

  it('an unknown query parameter and an invalid query value', async () => {
    expect(ProblemDetailsSchema.parse((await call('/health?debug=1')).json).code).toBe(
      'VALIDATION_FAILED',
    );
    const r = await post('/test/echo?mode=z', '{"name":"n","count":1}');
    expect(ProblemDetailsSchema.parse(r.json).errors?.[0]?.path).toBe('query.mode');
  });

  it('malformed JSON → MALFORMED_REQUEST; oversized body → PAYLOAD_TOO_LARGE', async () => {
    expect(ProblemDetailsSchema.parse((await post('/test/echo', '{bad json')).json).code).toBe(
      'MALFORMED_REQUEST',
    );
    const big = await post('/test/echo', JSON.stringify({ name: 'x'.repeat(200_000), count: 1 }));
    expect(big.res.status).toBe(413);
    expect(ProblemDetailsSchema.parse(big.json).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('control: a valid request passes and is echoed (201, as declared)', async () => {
    const { res, json } = await post('/test/echo?mode=a', '{"name":"n","count":3}');
    expect(res.status).toBe(201);
    expect(json).toEqual({ name: 'n', count: 3 });
  });
});

describe('S4-3 unknown route / wrong method → 404 Problem Details', () => {
  it.each([
    ['GET', '/does-not-exist'],
    ['DELETE', '/health'],
    ['GET', '/../../etc/passwd'],
  ])('%s %s', async (method, path) => {
    const { res, json } = await call(path, { method });
    expect(res.status).toBe(404);
    expect(ProblemDetailsSchema.parse(json).code).toBe('NOT_FOUND');
  });
});

describe('S4-4 unexpected error → generic 500, internals only in the log', () => {
  it('reveals nothing about the failure to the caller', async () => {
    const { res, text, json } = await call('/test/boom');
    expect(res.status).toBe(500);
    const problem = ProblemDetailsSchema.parse(json);
    expect(problem).toMatchObject({ code: 'INTERNAL_ERROR', title: 'Internal server error' });
    expect(problem.detail).toBeUndefined();
    for (const leak of [
      'SELECT',
      'password',
      'Sup3rS3cret',
      'db.internal',
      '    at ',
      '.ts:',
      'Error:',
    ]) {
      expect(text).not.toContain(leak);
    }
    const logged = logs.filter(
      (l) => l.includes(problem.requestId) && l.includes('unhandled_exception'),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('query failed');
    expect(logged[0]).not.toContain('Sup3rS3cretConnPw');
  });
});

describe('S4-5 logs never contain secrets or bodies', () => {
  it('passwords, tokens, cookies, connection strings, the API password and request bodies never appear', async () => {
    logs.length = 0;
    await post(
      '/test/echo',
      JSON.stringify({ name: SECRET_PASSWORD, count: 1, note: CONFIDENTIAL }),
      {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-token-value',
        cookie: 'session=cookie-secret-value',
        'x-api-key': ['api', 'key', 'secret', 'value'].join('-'),
      },
    );
    await call('/test/boom');
    await post('/test/echo', '{"name":"n","count":"bad"}');
    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      SECRET_PASSWORD,
      CONFIDENTIAL,
      'secret-token-value',
      'cookie-secret-value',
      'api-key-secret-value',
      'Sup3rS3cretConnPw',
      String(dbConfig('app').password),
      String(ENV.passwords.migrator),
    ]) {
      expect([secret.slice(0, 12), all.includes(secret)]).toEqual([secret.slice(0, 12), false]);
    }
    expect(all).toMatch(/"event":"request".*"path":"\/api\/v1\/test\/echo"/);
  });
});

describe('S4-6 request ids', () => {
  it('echoes a valid incoming id in the header, the Problem Details body and the log', async () => {
    const id = randomUUID();
    const { res, json } = await call('/nowhere', { headers: { 'x-request-id': id } });
    expect(res.headers.get('x-request-id')).toBe(id);
    expect(ProblemDetailsSchema.parse(json).requestId).toBe(id);
    expect(logs.some((l) => l.includes(id) && l.includes('"event":"request"'))).toBe(true);
  });

  it('replaces a malformed incoming id with a new UUID', async () => {
    const { res } = await call('/health', {
      headers: { 'x-request-id': 'not-a-uuid; DROP TABLE x' },
    });
    const got = res.headers.get('x-request-id');
    expect(got).not.toContain('DROP');
    expect(got).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('S4-8 default deny', () => {
  it('a route that needs a permission is refused (403) — no authentication exists before Stage 6', async () => {
    const { res, json } = await call('/test/locked');
    expect(res.status).toBe(403);
    expect(ProblemDetailsSchema.parse(json).code).toBe('ACCESS_DENIED');
  });

  it('the API refuses to START when any route lacks an access declaration', async () => {
    await expect(
      createApp({
        config: testConfig(),
        logSink: () => undefined,
        extraControllers: [UndeclaredController],
      }),
    ).rejects.toThrow(/UndeclaredController\.undeclared has no route contract/);
  });

  it('the API refuses to start when a served route is missing from the registry', async () => {
    await expect(
      createApp({
        config: testConfig(),
        logSink: () => undefined,
        extraControllers: [TestRoutesController],
      }),
    ).rejects.toThrow(/not in the route registry/);
  });
});

describe('shutdown releases every database connection (Stage 7A §13 fix)', () => {
  /** API connections (application_name pbe-api) opened after `since`, as PostgreSQL sees them. */
  const apiBackendsSince = async (since: Date): Promise<number> => {
    const c = new pg.Client(dbConfig('app'));
    await c.connect();
    try {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
          WHERE application_name = 'pbe-api' AND backend_start >= $1 AND pid <> pg_backend_pid()`,
        [since],
      );
      return r.rows[0]!.n;
    } finally {
      await c.end();
    }
  };
  const settledToZero = async (since: Date): Promise<number> => {
    let n = await apiBackendsSince(since);
    for (let i = 0; i < 30 && n > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      n = await apiBackendsSince(since);
    }
    return n;
  };
  /** Starts an extra API that is ALWAYS closed afterwards, even when an assertion fails. */
  const withOwnApp = async (
    fn: (url: string, close: () => Promise<void>) => Promise<void>,
  ): Promise<void> => {
    const own = await createApp({
      config: testConfig(),
      logSink: () => undefined,
      routes: TEST_ROUTES,
      extraControllers: [TestRoutesController],
    });
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await own.close();
      }
    };
    try {
      await own.listen(0, '127.0.0.1');
      await fn((await own.getUrl()).replace('[::1]', '127.0.0.1'), close);
    } finally {
      await close();
    }
  };

  it('app.close() ends the API connection pool (the old close override was silently ignored by the NestJS proxy)', async () => {
    const since = new Date();
    await withOwnApp(async (url, close) => {
      expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
      expect(await apiBackendsSince(since)).toBeGreaterThan(0);
      await close();
    });
    expect(await settledToZero(since)).toBe(0);
  });

  it('a request in progress completes normally; then the server stops and the pool is ended', async () => {
    const since = new Date();
    await withOwnApp(async (url, close) => {
      const inFlight = fetch(`${url}/api/v1/test/slow`);
      await new Promise((r) => setTimeout(r, 150)); // the request now waits on PostgreSQL
      const closing = close();
      const res = await inFlight;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: true });
      await closing;
      await expect(fetch(`${url}/api/v1/health`)).rejects.toThrow(); // no new requests accepted
    });
    expect(await settledToZero(since)).toBe(0);
  });

  it('closing twice is harmless (the pool is ended once)', async () => {
    const since = new Date();
    const own = await createApp({ config: testConfig(), logSink: () => undefined });
    await own.close();
    await expect(own.close()).resolves.toBeUndefined();
    expect(await settledToZero(since)).toBe(0);
  });

  it('a refused start-up (route without a contract) ends the pool', async () => {
    const since = new Date();
    await expect(
      createApp({
        config: testConfig(),
        logSink: () => undefined,
        extraControllers: [UndeclaredController],
      }),
    ).rejects.toThrow(/has no route contract/);
    expect(await settledToZero(since)).toBe(0);
  });

  it('a failure while building the application is a StartupError (no process abort) and ends the pool', async () => {
    const since = new Date();
    await expect(
      createApp({
        config: testConfig(),
        logSink: () => undefined,
        extraControllers: [MissingDependencyController],
      }),
    ).rejects.toThrow(StartupError);
    expect(await settledToZero(since)).toBe(0);
  });

  it('the real API process (dist/main.js, pbe_test) exits by itself on SIGTERM and leaves no connection', async () => {
    const dist = path.join(ROOT, 'apps', 'api', 'dist');
    const main = path.join(dist, 'main.js');
    const builtApp = path.join(dist, 'app.js');
    const source = path.join(ROOT, 'apps', 'api', 'src', 'app.ts');
    if (!fs.existsSync(main) || fs.statSync(builtApp).mtimeMs < fs.statSync(source).mtimeMs) {
      throw new Error(
        'apps/api/dist is missing or older than src/app.ts: run `npm run build` first.',
      );
    }
    const c = dbConfig('app');
    const port = 40000 + Math.floor(Math.random() * 9000);
    const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-outbox-'));
    const since = new Date();
    // A clean environment pointed at pbe_test: .env (pbe_dev) is NOT loaded.
    const child = spawn(process.execPath, [main], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        PBE_LOG_LEVEL: 'info',
        PBE_PG_HOST: String(c.host),
        PBE_PG_PORT: String(c.port),
        PBE_PG_DEV_DATABASE: String(c.database),
        PBE_PG_APP_USER: String(c.user),
        PBE_PG_APP_PASSWORD: String(c.password),
        PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        PBE_TOKEN_OUTBOX_DIR: outbox,
        PBE_API_HOST: '127.0.0.1',
        PBE_API_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout.on('data', (d: Buffer) => output.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => output.push(d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      for (let i = 0; i < 150 && !output.join('').includes('"event":"listening"'); i += 1) {
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(output.join('')).toContain('"event":"listening"');
      expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
      expect(await apiBackendsSince(since)).toBeGreaterThan(0);
      const stoppedAt = Date.now();
      child.kill('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect(result).not.toBe('timeout'); // it stopped by itself, nothing left running
      expect(Date.now() - stoppedAt).toBeLessThan(10_000);
      expect(await settledToZero(since)).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(outbox, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('S4-12 response contract enforcement', () => {
  it('a handler returning an undeclared field is never sent; the caller gets a generic 500', async () => {
    const { res, text, json } = await call('/test/leaky');
    expect(res.status).toBe(500);
    expect(ProblemDetailsSchema.parse(json).code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain('confidential');
    const problem = ProblemDetailsSchema.parse(json);
    expect(
      logs.some((l) => l.includes(problem.requestId) && l.includes('response_contract_violation')),
    ).toBe(true);
  });
});

describe('S4-10 health when the database is unavailable or at the wrong version', () => {
  it('returns 503 Problem Details without internal detail when the database is unreachable', async () => {
    const own = await createApp({ config: testConfig(), logSink: (l) => logs.push(l) });
    await own.listen(0, '127.0.0.1');
    const url = (await own.getUrl()).replace('[::1]', '127.0.0.1');
    try {
      await own.get<Database>(DATABASE).destroy(); // the database becomes unreachable for this app
      const res = await fetch(`${url}/api/v1/health`);
      const text = await res.text();
      expect(res.status).toBe(503);
      const problem = ProblemDetailsSchema.parse(JSON.parse(text));
      expect(problem).toMatchObject({ code: 'SERVICE_UNAVAILABLE', title: 'Service unavailable' });
      expect(problem.detail).toBeUndefined();
      expect(text).not.toMatch(/pool|ended|pbe_test|5432|Error/i);
      expect(
        logs.some((l) => l.includes(problem.requestId) && l.includes('"event":"problem"')),
      ).toBe(true);
    } finally {
      await own.close().catch(() => undefined);
    }
  });

  it('the health check reports a ledger that differs from the expected versions', async () => {
    const db = createDatabase({
      host: String(dbConfig('app').host),
      port: Number(dbConfig('app').port),
      database: String(dbConfig('app').database),
      user: String(dbConfig('app').user),
      password: String(dbConfig('app').password),
    });
    try {
      expect(await checkDatabaseHealth(db, SCHEMA_VERSIONS)).toEqual({ ok: true });
      const mismatch = await checkDatabaseHealth(db, [...SCHEMA_VERSIONS, 999]);
      expect(mismatch).toMatchObject({ ok: false });
    } finally {
      await db.destroy();
    }
  });
});

describe('S4-11 start-up refusal', () => {
  it('refuses to start when the migration ledger differs from the expected versions', async () => {
    await expect(
      createApp({
        config: testConfig(),
        logSink: () => undefined,
        expectedSchemaVersions: [...SCHEMA_VERSIONS, 999],
      }),
    ).rejects.toThrow(StartupError);
  });

  it('refuses to start when connected as an unsafe role (pbe_migrator is a member of pbe_owner)', async () => {
    const migrator = dbConfig('migrator');
    await expect(
      createApp({
        config: testConfig({
          PBE_PG_APP_USER: String(migrator.user),
          PBE_PG_APP_PASSWORD: String(migrator.password),
        }),
        logSink: () => undefined,
      }),
    ).rejects.toThrow(/member of another role|owns database objects/);
  });
});
