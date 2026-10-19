import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Secret, TOTP } from 'otpauth';
import { createApp, StartupError } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config/config';
import { hashPassword } from '../../apps/api/src/modules/auth/password-hash';
import {
  createDatabase,
  createOperatorDatabase,
  identity,
  tenancy,
  type Database,
} from '../../apps/api/src/modules/db';
import { migrate } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ROOT, ThrowawayCluster, withClient } from './helpers';

/*
 * Stage 8 API tests (STAGE-08-PLAN.md §6: S8-1, S8-3 to S8-7) against the real API over real HTTP
 * and a PRIVATE throw-away PostgreSQL 18 server with migrations 0001–0004 plus the proposed 0005
 * and 0006. pbe_test and pbe_dev are never touched. Negative cases are direct API requests, as an
 * attacker would send them (no screen involved). Fictional organisations, people and products.
 */

const ORIGIN = 'http://localhost:3000';
const DB = 'pbe_test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-s8-api-'));
const OUTBOX = path.join(tmp, 'outbox');
const migrationsDir = path.join(tmp, 'migrations');
const logs: string[] = [];
let cluster: ThrowawayCluster;
let app: NestExpressApplication;
let base: string;
let db: Database;
let appPassword = '';

const unique = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;
const email = (prefix: string) => `${unique(prefix)}@example.test`;
const pw = () => `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`;

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PBE_LOG_LEVEL: 'debug',
    PBE_PG_HOST: cluster.dir,
    PBE_PG_PORT: String(cluster.port),
    PBE_PG_DEV_DATABASE: DB,
    PBE_PG_APP_USER: 'pbe_app',
    PBE_PG_APP_PASSWORD: appPassword,
    PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PBE_TOKEN_OUTBOX_DIR: OUTBOX,
    ...extra,
  });
}

type Row = Record<string, unknown>;
const owner = (text: string, params: unknown[] = []) =>
  withClient(
    cluster.config('pbe_migrator', DB),
    async (c) => (await c.query(text, params)).rows as Row[],
    {
      asOwner: true,
    },
  );

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

class Client {
  token: string | undefined;
  recovery: string[] = [];
  readonly address = `2001:db8::${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;
  constructor(
    readonly email: string,
    public password: string,
  ) {}

  async send(method: string, p: string, body?: unknown): Promise<Reply> {
    const res = await fetch(`${base}/api/v1${p}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        'x-forwarded-for': this.address,
        ...(this.token ? { cookie: `__Host-pbe_session=${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^__Host-pbe_session=([^;]*)/.exec(c);
      if (m) this.token = m[1] || undefined;
    }
    const text = await res.text();
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      text,
    };
  }

  get = (p: string) => this.send('GET', p);
  post = (p: string, body?: unknown) => this.send('POST', p, body);
  put = (p: string, body?: unknown) => this.send('PUT', p, body);

  async signIn(): Promise<void> {
    const r = await this.post('/auth/login', { email: this.email, password: this.password });
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${r.text}`);
    if (r.json.next === 'enrol') {
      const key = (await this.post('/account/mfa/enrolment')).json.manualKey as string;
      const code = TOTP.generate({
        secret: Secret.fromBase32(key),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        timestamp: Date.now(),
      });
      const confirm = await this.post('/account/mfa/confirmation', { code });
      if (confirm.status !== 200) throw new Error(`enrolment failed: ${confirm.text}`);
      this.recovery = confirm.json.recoveryCodes as string[];
    } else if (r.json.next === 'mfa') {
      const v = await this.post('/auth/mfa/verify', { recoveryCode: this.recovery.shift() });
      if (v.status !== 200) throw new Error(`mfa failed: ${v.text}`);
    }
  }
}

function outboxToken(to: string): string {
  for (const f of fs.readdirSync(OUTBOX).sort().reverse()) {
    const m = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) as {
      to: string;
      token: string;
    };
    if (m.to === to) return m.token;
  }
  throw new Error(`no message for ${to}`);
}

async function userWithPassword(prefix: string): Promise<Client> {
  const c = new Client(email(prefix), pw());
  const id = await identity.createUser(db, c.email, `Fictional ${prefix}`);
  await identity.credentialSet(db, id, await hashPassword(c.password));
  return c;
}

interface Org {
  id: string;
  admin: Client;
}

async function organisation(sa: Client): Promise<Org> {
  const slug = unique('org-');
  const adminEmail = email('admin.');
  const created = await sa.post('/platform/tenants', {
    slug,
    displayName: `Fictional ${slug}`,
    firstAdmin: { email: adminEmail, displayName: 'First Admin' },
  });
  if (created.status !== 201) throw new Error(`create tenant: ${created.text}`);
  const id = (created.json.tenant as { id: string }).id;
  const admin = new Client(adminEmail, pw());
  const set = await admin.post('/account/token-password', {
    token: outboxToken(adminEmail),
    newPassword: admin.password,
  });
  if (set.status !== 200) throw new Error(`activate: ${set.text}`);
  await admin.signIn();
  if ((await admin.post('/session/tenant', { tenantId: id })).status !== 200)
    throw new Error('choose');
  return { id, admin };
}

/** A member holding template roles (by key) and/or extra role ids, in the given departments. */
async function member(
  org: Org,
  roleKeys: string[],
  opts: { departmentIds?: string[]; roleIds?: string[] } = {},
): Promise<Client & { membershipId: string }> {
  const c = await userWithPassword('member.');
  const added = await org.admin.post('/tenant/members', {
    email: c.email,
    displayName: 'Fictional Member',
  });
  if (added.status !== 201) throw new Error(`add member: ${added.text}`);
  const membershipId = (added.json.member as { id: string }).id;
  const roles = (await org.admin.get('/tenant/roles')).json.roles as Array<{
    id: string;
    templateKey: string | null;
  }>;
  const roleIds = [
    ...roleKeys.map((k) => roles.find((r) => r.templateKey === k)!.id),
    ...(opts.roleIds ?? []),
  ];
  if ((await org.admin.put(`/tenant/members/${membershipId}/roles`, { roleIds })).status !== 200)
    throw new Error('roles');
  if (opts.departmentIds) {
    const d = await org.admin.put(`/tenant/members/${membershipId}/departments`, {
      departmentIds: opts.departmentIds,
    });
    if (d.status !== 200) throw new Error(`departments: ${d.text}`);
  }
  await c.signIn();
  await c.post('/session/tenant', { tenantId: org.id });
  return Object.assign(c, { membershipId });
}

const auditActions = async (tenantId: string) =>
  (
    await owner(
      'SELECT action FROM audit.audit_event WHERE tenant_id = $1 ORDER BY occurred_at, id',
      [tenantId],
    )
  ).map((r) => String(r.action));

const PRODUCT = {
  name: 'Fictional IR tablet project',
  molecule: 'Fictionalol',
  strength: { value: 50, unit: 'mg' },
  dosageForm: 'tablet',
  route: 'oral',
  releaseType: 'immediate_release',
};

let sa: Client & { id: string };
let orgA: Org;
let orgB: Org;

beforeAll(async () => {
  cluster = ThrowawayCluster.start();
  const creds = bootstrapCredentials();
  appPassword = creds.passwords.app;
  const run = cluster.psqlFile(
    path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'),
    creds.env,
  );
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  fs.mkdirSync(migrationsDir);
  fs.mkdirSync(OUTBOX);
  for (const f of fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))) {
    fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrationsDir, f));
  }
  for (const f of ['0005_backup_read_access.sql', '0006_projects_scenarios.sql']) {
    fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrationsDir, f));
  }
  await migrate({ connection: cluster.config('pbe_migrator', DB), migrationsDir });

  app = await createApp({ config: config(), logSink: (l) => logs.push(l) });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  db = createDatabase({
    host: cluster.dir,
    port: cluster.port,
    database: DB,
    user: 'pbe_app',
    password: appPassword,
  });

  const s = await userWithPassword('superadmin.');
  const saId = (await identity.userIdByEmail(db, s.email))!;
  const operator = createOperatorDatabase(
    {
      PBE_PG_HOST: cluster.dir,
      PBE_PG_PORT: String(cluster.port),
      PBE_PG_MIGRATOR_USER: 'pbe_migrator',
      PBE_PG_MIGRATOR_PASSWORD: creds.passwords.migrator,
    },
    DB,
  );
  try {
    await tenancy.operatorSetPlatformRole(operator, saId, 'platform_owner', true);
  } finally {
    await operator.destroy();
  }
  await s.signIn();
  sa = Object.assign(s, { id: saId });
  orgA = await organisation(sa);
  orgB = await organisation(sa);
}, 240_000);

afterAll(async () => {
  try {
    await db?.destroy();
    await app?.close();
  } finally {
    cluster?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

describe('schema profile (ADR-030)', () => {
  it('the API runs on the projects profile [1–6]; health is ok', async () => {
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  });

  it('it refuses to start when the ledger is not exactly the required profile', async () => {
    await expect(
      createApp({
        config: config(),
        logSink: () => undefined,
        expectedSchemaVersions: [1, 2, 3, 4],
      }),
    ).rejects.toThrow(StartupError);
  });

  it('a new organisation’s Tenant Administrator holds the project permissions (seeded from the database)', async () => {
    const session = (await orgA.admin.get('/session')).json as { permissions: string[] };
    expect(session.permissions).toEqual(
      expect.arrayContaining([
        'tenant.projects.read',
        'tenant.allprojects.read',
        'tenant.projects.create',
        'tenant.projects.manage',
        'tenant.scenarios.manage',
      ]),
    );
    const catalogue = (await orgA.admin.get('/tenant/permissions')).json.permissions as Array<{
      code: string;
    }>;
    expect(catalogue.map((p) => p.code)).toContain('tenant.allprojects.read');
  });
});

describe('S8-1 / S8-2 create a project; the scope is computed by the server', () => {
  it('a supported product: 201, "supported", no reason, vocabulary version stored; audited', async () => {
    const before = (await auditActions(orgA.id)).length;
    const r = await orgA.admin.post('/projects', PRODUCT);
    expect(r.status).toBe(201);
    const p = r.json.project as {
      scope: { status: string; reasons: string[]; vocabularyVersion: string };
      scenarios: unknown[];
      status: string;
    };
    expect(p.scope).toEqual({
      status: 'supported',
      reasons: [],
      vocabularyVersion: 'draft-2026-10-18',
    });
    expect(p.status).toBe('active');
    expect(p.scenarios).toEqual([]);
    expect((await auditActions(orgA.id)).slice(before)).toEqual(['project.created']);
  });

  it('an unsupported product is recorded and MARKED, with every reason', async () => {
    const r = await orgA.admin.post('/projects', {
      ...PRODUCT,
      name: 'Fictional nasal ER project',
      route: 'nasal',
      releaseType: 'extended_release',
    });
    expect(r.status).toBe(201);
    const scope = (r.json.project as { scope: { status: string; reasons: string[] } }).scope;
    expect(scope.status).toBe('unsupported');
    expect(scope.reasons).toHaveLength(2);
    expect(scope.reasons.join(' ')).toMatch(/Nasal/);
    expect(scope.reasons.join(' ')).toMatch(/modified release/);
  });

  it('the client cannot set the scope itself, nor use free text or invalid values (400, nothing stored)', async () => {
    const before = (await auditActions(orgA.id)).length;
    for (const bad of [
      { ...PRODUCT, scopeStatus: 'supported' },
      { ...PRODUCT, dosageForm: 'Tablet (film-coated)' },
      { ...PRODUCT, strength: { value: 0, unit: 'mg' } },
      { ...PRODUCT, strength: { value: 5, unit: 'mmol' } },
      { ...PRODUCT, name: '' },
      { ...PRODUCT, departmentIds: ['not-a-uuid'] },
    ]) {
      expect((await orgA.admin.post('/projects', bad)).status).toBe(400);
    }
    expect((await auditActions(orgA.id)).length).toBe(before);
  });

  it('the live scope check: borderline terms are not supported and say they await the reviewer', async () => {
    const r = await orgA.admin.post('/projects/scope-check', {
      dosageForm: 'chewable_tablet',
      route: 'oral',
      releaseType: 'immediate_release',
      productFlags: [],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'unsupported', awaitingReviewer: true });
  });
});

describe('S8-3 scenarios: F001, F002 …, never reused, distinct under concurrency', () => {
  let projectId = '';
  beforeAll(async () => {
    projectId = (
      (await orgA.admin.post('/projects', { ...PRODUCT, name: 'Scenario codes' })).json.project as {
        id: string;
      }
    ).id;
  });

  it('codes are generated in order; the client cannot choose one; descriptions can change; audited', async () => {
    const one = await orgA.admin.post(`/projects/${projectId}/scenarios`, {
      description: 'Fictional reference formulation',
    });
    const two = await orgA.admin.post(`/projects/${projectId}/scenarios`, {});
    expect([one.status, two.status]).toEqual([201, 201]);
    expect([
      (one.json.scenario as { code: string }).code,
      (two.json.scenario as { code: string }).code,
    ]).toEqual(['F001', 'F002']);
    expect(
      (await orgA.admin.post(`/projects/${projectId}/scenarios`, { code: 'F009' })).status,
    ).toBe(400);
    const id = (two.json.scenario as { id: string }).id;
    const changed = await orgA.admin.put(`/projects/${projectId}/scenarios/${id}`, {
      description: 'Fictional test formulation',
    });
    expect(changed.status).toBe(200);
    expect(changed.json.scenario).toMatchObject({
      code: 'F002',
      description: 'Fictional test formulation',
    });
    const detail = (await orgA.admin.get(`/projects/${projectId}`)).json.project as {
      scenarios: Array<{ code: string }>;
      scenarioCount: number;
    };
    expect(detail.scenarios.map((s) => s.code)).toEqual(['F001', 'F002']);
    expect(detail.scenarioCount).toBe(2);
    expect((await auditActions(orgA.id)).filter((a) => a.startsWith('scenario.'))).toEqual(
      expect.arrayContaining(['scenario.created', 'scenario.created', 'scenario.changed']),
    );
  });

  it('eight simultaneous additions get eight different, consecutive codes', async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => orgA.admin.post(`/projects/${projectId}/scenarios`, {})),
    );
    expect(replies.map((r) => r.status)).toEqual(Array(8).fill(201));
    const codes = replies.map((r) => (r.json.scenario as { code: string }).code).sort();
    expect(codes).toEqual(['F003', 'F004', 'F005', 'F006', 'F007', 'F008', 'F009', 'F010']);
  });
});

describe('D8-8 archived projects stay visible and become read-only', () => {
  it('archive → 200; later changes → 409 with nothing written; still readable', async () => {
    const p = (await orgA.admin.post('/projects', { ...PRODUCT, name: 'To archive' })).json
      .project as { id: string };
    const s = (await orgA.admin.post(`/projects/${p.id}/scenarios`, {})).json.scenario as {
      id: string;
    };
    const archived = await orgA.admin.post(`/projects/${p.id}/archive`);
    expect(archived.status).toBe(200);
    expect((archived.json.project as { status: string }).status).toBe('archived');
    const before = (await auditActions(orgA.id)).length;
    expect(
      (await orgA.admin.put(`/projects/${p.id}`, { ...PRODUCT, name: 'Changed' })).status,
    ).toBe(409);
    expect((await orgA.admin.post(`/projects/${p.id}/scenarios`, {})).status).toBe(409);
    expect(
      (await orgA.admin.put(`/projects/${p.id}/scenarios/${s.id}`, { description: 'x' })).status,
    ).toBe(409);
    expect((await orgA.admin.post(`/projects/${p.id}/archive`)).status).toBe(409);
    expect((await auditActions(orgA.id)).length).toBe(before);
    const still = await orgA.admin.get(`/projects/${p.id}`);
    expect(still.status).toBe(200);
    expect(still.json.project).toMatchObject({
      name: 'To archive',
      status: 'archived',
      scenarioCount: 1,
    });
  });
});

describe('S8-4 cross-tenant: direct requests for another organisation’s project', () => {
  it('B cannot list, read, change, archive or add scenarios to A’s project (404), and nothing changes', async () => {
    const p = (await orgA.admin.post('/projects', { ...PRODUCT, name: 'A only' })).json.project as {
      id: string;
    };
    const sc = (await orgA.admin.post(`/projects/${p.id}/scenarios`, {})).json.scenario as {
      id: string;
    };
    const listed = (await orgB.admin.get('/projects')).json.projects as Array<{ id: string }>;
    expect(listed.map((x) => x.id)).not.toContain(p.id);
    expect((await orgB.admin.get(`/projects/${p.id}`)).status).toBe(404);
    expect((await orgB.admin.put(`/projects/${p.id}`, { ...PRODUCT, name: 'Taken' })).status).toBe(
      404,
    );
    expect((await orgB.admin.post(`/projects/${p.id}/archive`)).status).toBe(404);
    expect((await orgB.admin.post(`/projects/${p.id}/scenarios`, {})).status).toBe(404);
    expect(
      (await orgB.admin.put(`/projects/${p.id}/scenarios/${sc.id}`, { description: 'x' })).status,
    ).toBe(404);
    const after = (await orgA.admin.get(`/projects/${p.id}`)).json.project as {
      name: string;
      status: string;
      scenarioCount: number;
    };
    expect(after).toMatchObject({ name: 'A only', status: 'active', scenarioCount: 1 });
    expect(await auditActions(orgB.id)).not.toEqual(expect.arrayContaining(['project.changed']));
  });

  it('an organisation id in the body is refused (no field for it): the active organisation is used', async () => {
    expect((await orgB.admin.post('/projects', { ...PRODUCT, tenantId: orgA.id })).status).toBe(
      400,
    );
  });
});

describe('S8-5 permission matrix and break-glass (direct requests)', () => {
  let projectId = '';
  beforeAll(async () => {
    projectId = (
      (await orgA.admin.post('/projects', { ...PRODUCT, name: 'Matrix' })).json.project as {
        id: string;
      }
    ).id;
  });

  const probes = (c: Client) => ({
    read: async () => (await c.get('/projects')).status,
    create: async () => (await c.post('/projects', { ...PRODUCT, name: unique('Probe ') })).status,
    manage: async () =>
      (await c.put(`/projects/${projectId}`, { ...PRODUCT, name: 'Matrix' })).status,
    scenarios: async () => (await c.post(`/projects/${projectId}/scenarios`, {})).status,
  });

  it.each([
    ['project_lead', { read: 200, create: 201, manage: 200, scenarios: 201 }],
    ['scientist', { read: 200, create: 403, manage: 403, scenarios: 201 }],
    ['qa_qc_reviewer', { read: 200, create: 403, manage: 403, scenarios: 403 }],
    ['scientific_reviewer', { read: 200, create: 403, manage: 403, scenarios: 403 }],
    ['viewer', { read: 200, create: 403, manage: 403, scenarios: 403 }],
  ])('template %s', async (key, expected) => {
    const m = await member(orgA, [key]);
    const p = probes(m);
    expect({
      read: await p.read(),
      create: await p.create(),
      manage: await p.manage(),
      scenarios: await p.scenarios(),
    }).toEqual(expected);
  });

  it('a member with no role is refused everything (403)', async () => {
    const m = await member(orgA, []);
    const p = probes(m);
    expect([await p.read(), await p.create(), await p.manage(), await p.scenarios()]).toEqual([
      403, 403, 403, 403,
    ]);
  });

  it('holders of a project-changing permission must use MFA (administrative permission rule)', async () => {
    const m = await member(orgA, ['scientist']);
    expect(m.recovery.length).toBeGreaterThan(0); // they were made to enrol at sign-in
  });

  it('break-glass: the Super Admin may READ projects (all of them) and nothing else; every use is audited', async () => {
    expect((await sa.get('/projects')).status).toBe(403); // no default access
    const req = await sa.post('/platform/break-glass', {
      tenantId: orgA.id,
      purpose: 'Investigate fictional support ticket 8',
    });
    const grantId = (req.json.grant as { id: string }).id;
    expect(
      (await orgA.admin.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' }))
        .status,
    ).toBe(200);
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(200);
    const list = await sa.get('/projects');
    expect(list.status).toBe(200);
    expect((list.json.projects as unknown[]).length).toBeGreaterThan(0);
    expect((await sa.get(`/projects/${projectId}`)).status).toBe(200);
    expect((await sa.post('/projects', PRODUCT)).status).toBe(403);
    expect((await sa.put(`/projects/${projectId}`, PRODUCT)).status).toBe(403);
    expect((await sa.post(`/projects/${projectId}/archive`)).status).toBe(403);
    expect((await sa.post(`/projects/${projectId}/scenarios`, {})).status).toBe(403);
    expect(
      (
        await sa.post('/projects/scope-check', {
          dosageForm: 'tablet',
          route: 'oral',
          releaseType: 'immediate_release',
        })
      ).status,
    ).toBe(403);
    expect(await auditActions(orgA.id)).toContain('breakglass.used');
    expect((await orgA.admin.post(`/tenant/break-glass/${grantId}/revocation`)).status).toBe(200);
    expect((await sa.get('/projects')).status).toBe(403);
  });
});

describe('S8-6 department-based visibility through the API (D8-6)', () => {
  let d1 = '';
  let d2 = '';
  let restricted = '';

  beforeAll(async () => {
    d1 = (
      (await orgA.admin.post('/tenant/departments', { name: unique('Fictional D1 ') })).json
        .department as { id: string }
    ).id;
    d2 = (
      (await orgA.admin.post('/tenant/departments', { name: unique('Fictional D2 ') })).json
        .department as { id: string }
    ).id;
    const r = await orgA.admin.post('/projects', {
      ...PRODUCT,
      name: 'D1 only',
      departmentIds: [d1],
    });
    expect(r.status).toBe(201);
    restricted = (r.json.project as { id: string }).id;
  });

  it('a member of the department sees it; a member of another department or of none gets 404 and no listing', async () => {
    const inside = await member(orgA, ['scientist'], { departmentIds: [d1] });
    const other = await member(orgA, ['scientist'], { departmentIds: [d2] });
    const none = await member(orgA, ['scientist']);
    expect((await inside.get(`/projects/${restricted}`)).status).toBe(200);
    expect((await inside.post(`/projects/${restricted}/scenarios`, {})).status).toBe(201);
    for (const c of [other, none]) {
      expect((await c.get(`/projects/${restricted}`)).status).toBe(404);
      expect(
        ((await c.get('/projects')).json.projects as Array<{ id: string }>).map((p) => p.id),
      ).not.toContain(restricted);
      expect((await c.post(`/projects/${restricted}/scenarios`, {})).status).toBe(404);
    }
  });

  it('tenant.allprojects.read (a custom role) sees every project', async () => {
    const role = await orgA.admin.post('/tenant/roles', {
      name: unique('Fictional oversight '),
      permissions: ['tenant.projects.read', 'tenant.allprojects.read'],
    });
    expect(role.status).toBe(201);
    const o = await member(orgA, [], { roleIds: [(role.json.role as { id: string }).id] });
    expect((await o.get(`/projects/${restricted}`)).status).toBe(200);
  });

  it('nobody can hide a project from themselves: a creator outside the chosen departments is refused (400)', async () => {
    const lead = await member(orgA, ['project_lead'], { departmentIds: [d2] });
    const r = await lead.post('/projects', {
      ...PRODUCT,
      name: 'Hidden from me',
      departmentIds: [d1],
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/department you belong to/);
    expect(
      (await lead.post('/projects', { ...PRODUCT, name: 'Visible to me', departmentIds: [d2] }))
        .status,
    ).toBe(201);
  });

  it('a department of ANOTHER organisation cannot be used (400)', async () => {
    const foreign = (
      (await orgB.admin.post('/tenant/departments', { name: unique('B dept ') })).json
        .department as { id: string }
    ).id;
    expect(
      (await orgA.admin.post('/projects', { ...PRODUCT, departmentIds: [foreign] })).status,
    ).toBe(400);
  });
});

describe('Decision 1: delegation of the project permissions (escalation rule unchanged)', () => {
  it('the Tenant Administrator can delegate a project permission through a custom role', async () => {
    const role = await orgA.admin.post('/tenant/roles', {
      name: unique('Fictional creators '),
      permissions: ['tenant.projects.read', 'tenant.projects.create'],
    });
    expect(role.status).toBe(201);
    const m = await member(orgA, [], { roleIds: [(role.json.role as { id: string }).id] });
    expect((await m.post('/projects', { ...PRODUCT, name: unique('Delegated ') })).status).toBe(
      201,
    );
  });

  it('a role manager WITHOUT project permissions cannot grant them (403), even to a new role', async () => {
    const managers = await orgA.admin.post('/tenant/roles', {
      name: unique('Fictional role managers '),
      permissions: ['tenant.roles.read', 'tenant.roles.manage', 'tenant.members.read'],
    });
    expect(managers.status).toBe(201);
    const rm = await member(orgA, [], { roleIds: [(managers.json.role as { id: string }).id] });
    for (const p of ['tenant.projects.read', 'tenant.allprojects.read', 'tenant.projects.manage']) {
      const r = await rm.post('/tenant/roles', { name: unique('Escalation '), permissions: [p] });
      expect([p, r.status]).toEqual([p, 403]);
    }
    expect((await rm.get('/projects')).status).toBe(403);
  });

  it('a Project Lead cannot manage roles at all (403)', async () => {
    const lead = await member(orgA, ['project_lead']);
    expect(
      (
        await lead.post('/tenant/roles', {
          name: unique('Lead role '),
          permissions: ['tenant.projects.read'],
        })
      ).status,
    ).toBe(403);
  });

  it('organisation B’s administrator cannot assign A’s roles or reach A’s projects', async () => {
    const roles = (await orgA.admin.get('/tenant/roles')).json.roles as Array<{ id: string }>;
    const bMember = (await orgB.admin.get('/tenant/members')).json.members as Array<{ id: string }>;
    expect(
      (await orgB.admin.put(`/tenant/members/${bMember[0]!.id}/roles`, { roleIds: [roles[0]!.id] }))
        .status,
    ).toBe(400);
  });
});

describe('Decision 2: the permission identifier', () => {
  it('only the catalogue name is accepted; the plan’s draft name tenant.projects.read_all is refused', async () => {
    const r = await orgA.admin.post('/tenant/roles', {
      name: unique('Draft name '),
      permissions: ['tenant.projects.read_all'],
    });
    expect(r.status).toBe(400);
    const session = (await orgA.admin.get('/session')).json as { permissions: string[] };
    expect(session.permissions).toContain('tenant.allprojects.read');
    expect(session.permissions.filter((p) => /read_all/.test(p))).toEqual([]);
  });
});

describe('S8-7 audit: one row per change, in the same transaction; none on refusal', () => {
  it('rows hold digests and identifiers only, never the product data', async () => {
    const rows = await owner(
      `SELECT action, actor_kind, request_id, detail, before_digest IS NOT NULL AS has_before, after_digest IS NOT NULL AS has_after
         FROM audit.audit_event WHERE tenant_id = $1 AND (action LIKE 'project.%' OR action LIKE 'scenario.%')`,
      [orgA.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor_kind).toBe('member');
      expect(r.request_id).toEqual(expect.any(String));
      expect(r.has_after).toBe(true);
      expect(JSON.stringify(r.detail)).not.toMatch(/Fictionalol|Fictional IR tablet/);
    }
  });

  it('the logs never contain a session token', () => {
    const joined = logs.join('\n');
    for (const c of [orgA.admin, orgB.admin, sa])
      if (c.token) expect(joined).not.toContain(c.token);
  });
});
