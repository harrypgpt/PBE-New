import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { permissionsForSchema, roleTemplatesForSchema } from '@pbe/contracts';
import { Secret, TOTP } from 'otpauth';
import { createApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config/config';
import { hashPassword } from '../../apps/api/src/modules/auth/password-hash';
import { sessionTokenHash } from '../../apps/api/src/modules/auth/secrets';
import { resolveAccess } from '../../apps/api/src/modules/tenancy/access';
import {
  createDatabase,
  createOperatorDatabase,
  identity,
  SCHEMA_VERSIONS,
  tenancy,
  withTenantTransaction,
  type Database,
} from '../../apps/api/src/modules/db';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { dbConfig, ENV, ROOT, withClient } from './helpers';

/*
 * Stage 7A security tests (STAGE-07-PLAN.md §5; owner's mandatory list) against the real API and
 * real PostgreSQL 18 (pbe_test, as pbe_app) over real HTTP. Fictional organisations and users only.
 * Passwords, codes and tokens are generated at run time; none is written in this file.
 */

const ORIGIN = 'http://localhost:3000';
/** pbe_test is at the base schema profile; the catalogue and templates are compared at that version. */
const DB_VERSION = SCHEMA_VERSIONS[SCHEMA_VERSIONS.length - 1]!;
const TEMPLATES = roleTemplatesForSchema(DB_VERSION);
const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-outbox-'));
const logs: string[] = [];
const secrets = new Set<string>();
let app: NestExpressApplication;
let base: string;
let db: Database;

const pw = () => {
  const p = `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`;
  secrets.add(p);
  return p;
};
const unique = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;
const email = (prefix: string) => `${unique(prefix)}@example.test`;
const address = () =>
  `2001:db8::${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;

function config() {
  const c = dbConfig('app');
  return loadConfig({
    NODE_ENV: 'test',
    PBE_LOG_LEVEL: 'debug',
    PBE_PG_HOST: String(c.host),
    PBE_PG_PORT: String(c.port),
    PBE_PG_DEV_DATABASE: String(c.database),
    PBE_PG_APP_USER: String(c.user),
    PBE_PG_APP_PASSWORD: String(c.password),
    PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PBE_TOKEN_OUTBOX_DIR: OUTBOX,
  });
}

const owner = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withClient(dbConfig('migrator'), async (c) => (await c.query<T>(text, params)).rows, {
    asOwner: true,
  });

/** Raw SQL as the runtime role, optionally with a context set the way the gateway does. */
const asApp = <T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  ctx?: { tenant?: string; user?: string },
) =>
  withClient(dbConfig('app'), async (c) => {
    await c.query('BEGIN');
    try {
      if (ctx?.tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenant]);
      if (ctx?.user) await c.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.user]);
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.query('ROLLBACK');
    }
  });

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

class Client {
  token: string | undefined;
  readonly address = address();
  recovery: string[] = [];
  constructor(
    readonly email: string,
    public password: string,
  ) {}

  async send(
    method: string,
    p: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await fetch(`${base}/api/v1${p}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        'x-forwarded-for': this.address,
        ...(this.token ? { cookie: `__Host-pbe_session=${this.token}` } : {}),
        ...headers,
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
  del = (p: string) => this.send('DELETE', p);

  /** Signs in; enrols MFA if required; uses a recovery code for later MFA sign-ins. */
  async signIn(): Promise<void> {
    const r = await this.post('/auth/login', { email: this.email, password: this.password });
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${r.text}`);
    if (r.json.next === 'enrol') {
      const start = await this.post('/account/mfa/enrolment');
      const key = start.json.manualKey as string;
      secrets.add(key);
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
      this.recovery.forEach((c) => secrets.add(c));
    } else if (r.json.next === 'mfa') {
      const code = this.recovery.shift();
      if (!code) throw new Error('no recovery code left');
      const v = await this.post('/auth/mfa/verify', { recoveryCode: code });
      if (v.status !== 200) throw new Error(`mfa failed: ${v.text}`);
    }
  }

  async choose(tenantId: string): Promise<Reply> {
    return this.post('/session/tenant', { tenantId });
  }
}

/** Latest outbox message for an address (the separate delivery channel, R-011). */
function outboxToken(to: string, purpose: 'activation' | 'password_reset'): string {
  const files = fs.readdirSync(OUTBOX).sort().reverse();
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) as {
      to: string;
      purpose: string;
      token: string;
    };
    if (m.to === to && m.purpose === purpose) {
      secrets.add(m.token);
      return m.token;
    }
  }
  throw new Error(`no ${purpose} message for ${to}`);
}

async function userWithPassword(prefix: string): Promise<Client> {
  const e = email(prefix);
  const p = pw();
  const id = await identity.createUser(db, e, `Fictional ${prefix}`);
  await identity.credentialSet(db, id, await hashPassword(p));
  return new Client(e, p);
}

/** A fictional Super Admin, made with the OPERATOR function, signed in with MFA. */
async function superAdmin(): Promise<Client & { id: string }> {
  const sa = await userWithPassword('superadmin.');
  const id = (await identity.userIdByEmail(db, sa.email))!;
  const operator = createOperatorDatabase(
    {
      ...process.env,
      PBE_PG_HOST: String(dbConfig('migrator').host),
      PBE_PG_PORT: String(dbConfig('migrator').port),
      PBE_PG_MIGRATOR_USER: String(dbConfig('migrator').user),
      PBE_PG_MIGRATOR_PASSWORD: String(dbConfig('migrator').password),
    },
    String(dbConfig('migrator').database),
  );
  try {
    await tenancy.operatorSetPlatformRole(operator, id, 'platform_owner', true);
  } finally {
    await operator.destroy();
  }
  await sa.signIn();
  return Object.assign(sa, { id });
}

interface Org {
  id: string;
  slug: string;
  admin: Client;
}

/** Super Admin creates an organisation with a NEW first admin, who activates via the outbox link. */
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
    token: outboxToken(adminEmail, 'activation'),
    newPassword: admin.password,
  });
  if (set.status !== 200) throw new Error(`activate: ${set.text}`);
  await admin.signIn(); // admin permissions → MFA required → enrols here
  const chosen = await admin.choose(id);
  if (chosen.status !== 200) throw new Error(`choose: ${chosen.text}`);
  return { id, slug, admin };
}

/** Adds an existing-password user as a member (via the admin) holding the given role keys. */
async function member(org: Org, roleKeys: string[]): Promise<Client & { membershipId: string }> {
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
  const roleIds = roleKeys.map((k) => roles.find((r) => r.templateKey === k)!.id);
  const set = await org.admin.put(`/tenant/members/${membershipId}/roles`, { roleIds });
  if (set.status !== 200) throw new Error(`roles: ${set.text}`);
  await c.signIn();
  await c.choose(org.id);
  return Object.assign(c, { membershipId });
}

const auditFor = (tenantId: string) =>
  owner<{
    action: string;
    actor_kind: string;
    request_id: string | null;
    detail: Record<string, unknown>;
  }>(
    'SELECT action, actor_kind, request_id, detail FROM audit.audit_event WHERE tenant_id = $1 ORDER BY occurred_at, id',
    [tenantId],
  );

let sa: Client & { id: string };
let orgA: Org;
let orgB: Org;

beforeAll(async () => {
  await migrate({ connection: dbConfig('migrator'), migrationsDir: migrationsDir(ROOT) });
  app = await createApp({ config: config(), logSink: (l) => logs.push(l) });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const c = dbConfig('app');
  db = createDatabase({
    host: String(c.host),
    port: Number(c.port),
    database: String(c.database),
    user: String(c.user),
    password: String(c.password),
  });
  sa = await superAdmin();
  orgA = await organisation(sa);
  orgB = await organisation(sa);
}, 180_000);

afterAll(async () => {
  await db?.destroy();
  await app?.close();
  fs.rmSync(OUTBOX, { recursive: true, force: true });
});

describe('catalogue and templates (ADR-029)', () => {
  it('the database catalogue equals the code catalogue; templates match; platform permissions never in tenant roles', async () => {
    const rows = await owner<{
      code: string;
      scope: string;
      read_only: boolean;
      description: string;
    }>('SELECT code, scope, read_only, description FROM platform.permission ORDER BY code');
    expect(
      rows.map((r) => ({
        code: r.code,
        scope: r.scope,
        readOnly: r.read_only,
        description: r.description,
      })),
    ).toEqual(
      [...permissionsForSchema(DB_VERSION)]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((p) => ({
          code: p.code,
          scope: p.scope,
          readOnly: p.readOnly,
          description: p.description,
        })),
    );
    const t = await owner<{ key: string; name: string; perms: string[] | null }>(
      `SELECT t.key, t.name, array_agg(p.permission ORDER BY p.permission) FILTER (WHERE p.permission IS NOT NULL) AS perms
         FROM platform.role_template t LEFT JOIN platform.role_template_permission p ON p.template_key = t.key GROUP BY t.key, t.name, t.position ORDER BY t.position`,
    );
    expect(t.map((r) => ({ key: r.key, name: r.name, permissions: r.perms ?? [] }))).toEqual(
      TEMPLATES.map((r) => ({
        key: r.key,
        name: r.name,
        permissions: [...r.permissions].sort(),
      })),
    );
    await expect(
      asApp(
        `INSERT INTO app.role_permission (tenant_id, role_id, permission) SELECT tenant_id, id, 'platform.tenants.manage' FROM app.role LIMIT 1`,
        [],
        { tenant: orgA.id },
      ),
    ).rejects.toThrow(/role_permission_tenant_scope|violates/);
  });

  it('a new organisation starts with the six editable templates, seven departments and settings (self-approval off)', async () => {
    const roles = (await orgA.admin.get('/tenant/roles')).json.roles as Array<{
      templateKey: string | null;
    }>;
    expect(roles.map((r) => r.templateKey).sort()).toEqual(TEMPLATES.map((r) => r.key).sort());
    expect(
      ((await orgA.admin.get('/tenant/departments')).json.departments as unknown[]).length,
    ).toBe(7);
    expect((await orgA.admin.get('/tenant/settings')).json).toEqual({ selfApprovalAllowed: false });
  });
});

describe('S7-1 authorisation matrix (generated from the role templates)', () => {
  // One representative route per tenant permission.
  const probes: Record<string, (c: Client) => Promise<Reply>> = {
    'tenant.members.read': (c) => c.get('/tenant/members'),
    'tenant.members.manage': (c) =>
      c.post('/tenant/members', { email: email('probe.'), displayName: 'Probe' }),
    'tenant.roles.read': (c) => c.get('/tenant/roles'),
    'tenant.roles.manage': (c) =>
      c.post('/tenant/roles', { name: unique('Probe role '), permissions: [] }),
    'tenant.departments.read': (c) => c.get('/tenant/departments'),
    'tenant.departments.manage': (c) =>
      c.post('/tenant/departments', { name: unique('Probe dept ') }),
    'tenant.settings.read': (c) => c.get('/tenant/settings'),
    'tenant.settings.manage': (c) => c.put('/tenant/settings', { selfApprovalAllowed: false }),
    'tenant.breakglass.approve': (c) => c.get('/tenant/break-glass'),
  };

  it.each(TEMPLATES.map((t) => [t.key, t.permissions] as const))(
    'template %s: allowed exactly as the matrix says',
    async (key, permissions) => {
      const m = await member(orgA, [key]);
      for (const [perm, probe] of Object.entries(probes)) {
        const r = await probe(m);
        const allowed = permissions.includes(perm);
        expect([perm, allowed ? r.status < 300 : r.status]).toEqual([perm, allowed ? true : 403]);
      }
      // No tenant role reaches platform routes.
      expect((await m.get('/platform/tenants')).status).toBe(403);
    },
  );

  it('a member with no role at all is refused everywhere', async () => {
    const m = await member(orgA, []);
    for (const probe of Object.values(probes)) expect((await probe(m)).status).toBe(403);
  });
});

describe('S7-2 cross-organisation isolation (API and database)', () => {
  it('an admin of A cannot read or change anything of B by id', async () => {
    const bMember = await member(orgB, ['viewer']);
    const bRoles = (await orgB.admin.get('/tenant/roles')).json.roles as Array<{ id: string }>;
    const bDept = (
      (await orgB.admin.get('/tenant/departments')).json.departments as Array<{ id: string }>
    )[0]!;
    const a = orgA.admin;
    expect((await a.get('/tenant/members')).text).not.toContain(bMember.email);
    expect((await a.post(`/tenant/members/${bMember.membershipId}/deactivation`)).status).toBe(404);
    expect((await a.post(`/tenant/members/${bMember.membershipId}/password-reset`)).status).toBe(
      404,
    );
    expect((await a.put(`/tenant/departments/${bDept.id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await a.del(`/tenant/roles/${bRoles[0]!.id}`)).status).toBe(404);
    const aMember = await member(orgA, []);
    expect(
      (await a.put(`/tenant/members/${aMember.membershipId}/roles`, { roleIds: [bRoles[0]!.id] }))
        .status,
    ).toBe(400);
    // B's admin still sees B's data unchanged.
    expect(
      ((await orgB.admin.get('/tenant/members')).json.members as Array<{ status: string }>).every(
        (x) => x.status === 'active',
      ),
    ).toBe(true);
  });

  it('a user cannot choose an organisation they do not belong to (same answer as unknown)', async () => {
    expect((await orgA.admin.choose(orgB.id)).status).toBe(404);
    expect((await orgA.admin.choose('01234567-89ab-7def-8123-456789abcdef')).status).toBe(404);
  });

  it('database: with A context, B rows are invisible and cannot be written (RLS forced)', async () => {
    const seen = await asApp<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.membership WHERE tenant_id = $1',
      [orgB.id],
      { tenant: orgA.id },
    );
    expect(seen[0]!.n).toBe(0);
    await expect(
      asApp(`INSERT INTO app.department (tenant_id, name) VALUES ($1, 'Cross-tenant')`, [orgB.id], {
        tenant: orgA.id,
      }),
    ).rejects.toThrow(/row-level security/);
    const none = await asApp<{ n: number }>('SELECT count(*)::int AS n FROM app.role', [], {});
    expect(none[0]!.n).toBe(0);
  });
});

describe('ADR-030 projects schema profile (pbe_test at 0001–0006 since 2026-10-18)', () => {
  it('project routes are available; the catalogue, session and role editing include the project permissions', async () => {
    expect((await orgA.admin.get('/projects')).status).toBe(200);
    const scope = await orgA.admin.post('/projects/scope-check', {
      dosageForm: 'tablet',
      route: 'oral',
      releaseType: 'immediate_release',
    });
    expect([scope.status, scope.json.status]).toEqual([200, 'supported']);
    const catalogue = (await orgA.admin.get('/tenant/permissions')).json.permissions as Array<{
      code: string;
    }>;
    expect(catalogue.map((p) => p.code).filter((c) => /projects|scenarios/.test(c))).toHaveLength(
      5,
    );
    const session = (await orgA.admin.get('/session')).json as { permissions: string[] };
    expect(session.permissions.filter((c) => /projects|scenarios/.test(c))).toHaveLength(5);
    expect(
      (
        await orgA.admin.post('/tenant/roles', {
          name: unique('Project readers '),
          permissions: ['tenant.projects.read'],
        })
      ).status,
    ).toBe(201);
  });

  it('signed out, a project route asks for sign-in first (401)', async () => {
    expect((await new Client('nobody@example.test', 'x').get('/projects')).status).toBe(401);
  });
});

describe('S7-4 active organisation', () => {
  it('no organisation routes without an active one; choosing or switching rotates the session; leaving ends the context', async () => {
    // A fictional user who is a Project Lead (members.read, departments.read) in BOTH A and B.
    const u = await userWithPassword('two-orgs.');
    for (const org of [orgA, orgB]) {
      const added = await org.admin.post('/tenant/members', {
        email: u.email,
        displayName: 'Fictional Two-Org Member',
      });
      expect(added.status).toBe(201);
      const roles = (await org.admin.get('/tenant/roles')).json.roles as Array<{
        id: string;
        templateKey: string | null;
      }>;
      const lead = roles.find((r) => r.templateKey === 'project_lead')!.id;
      const id = (added.json.member as { id: string }).id;
      expect((await org.admin.put(`/tenant/members/${id}/roles`, { roleIds: [lead] })).status).toBe(
        200,
      );
    }
    await u.signIn();

    // After sign-in no organisation is active: organisation routes are refused.
    expect((await u.get('/session')).json.activeTenant).toBeNull();
    const ids = ((await u.get('/session/tenants')).json.tenants as Array<{ id: string }>).map(
      (t) => t.id,
    );
    expect(ids).toEqual(expect.arrayContaining([orgA.id, orgB.id]));
    const before = await u.get('/tenant/departments');
    expect(before.status).toBe(403);
    expect(before.text).toContain('Choose an organisation first.');

    // Choosing A issues a NEW session; the old one stops working at once.
    const signInToken = u.token;
    expect((await u.choose(orgA.id)).status).toBe(200);
    expect(u.token).toBeDefined();
    expect(u.token).not.toBe(signInToken);
    const stale = new Client(u.email, u.password);
    stale.token = signInToken;
    expect((await stale.get('/session')).status).toBe(401);
    expect(((await u.get('/session')).json.activeTenant as { id: string }).id).toBe(orgA.id);
    expect((await u.get('/tenant/departments')).status).toBe(200);

    // Switching to B rotates again; the A session cannot be reused to stay in A.
    const tokenInA = u.token;
    expect((await u.choose(orgB.id)).status).toBe(200);
    expect(u.token).not.toBe(tokenInA);
    stale.token = tokenInA;
    expect((await stale.get('/tenant/departments')).status).toBe(401);
    expect(((await u.get('/session')).json.activeTenant as { id: string }).id).toBe(orgB.id);
    const membersB = (await u.get('/tenant/members')).json.members as Array<{ email: string }>;
    expect(membersB.map((m) => m.email)).toContain(orgB.admin.email);
    expect(membersB.map((m) => m.email)).not.toContain(orgA.admin.email);

    // Leaving the organisation rotates the session and removes the context.
    const tokenInB = u.token;
    expect((await u.post('/session/context/exit')).status).toBe(200);
    expect(u.token).not.toBe(tokenInB);
    expect((await u.get('/session')).json.activeTenant).toBeNull();
    expect((await u.get('/tenant/departments')).status).toBe(403);
    stale.token = tokenInB;
    expect((await stale.get('/session')).status).toBe(401);
  });
});

describe('S7-5 immediate revocation', () => {
  it('removing a role, deactivating a membership and suspending the organisation take effect at the next request', async () => {
    const m = await member(orgA, ['project_lead']);
    expect((await m.get('/tenant/members')).status).toBe(200);
    expect(
      (await orgA.admin.put(`/tenant/members/${m.membershipId}/roles`, { roleIds: [] })).status,
    ).toBe(200);
    expect((await m.get('/tenant/members')).status).toBe(403);

    const n = await member(orgA, ['project_lead']);
    expect((await orgA.admin.post(`/tenant/members/${n.membershipId}/deactivation`)).status).toBe(
      200,
    );
    expect((await n.get('/tenant/members')).status).toBe(403);
    expect((await n.choose(orgA.id)).status).toBe(404);
    expect((await orgA.admin.post(`/tenant/members/${n.membershipId}/reactivation`)).status).toBe(
      200,
    );
    expect((await n.choose(orgA.id)).status).toBe(200);

    const orgC = await organisation(sa);
    const c = await member(orgC, ['project_lead']);
    expect((await c.get('/tenant/members')).status).toBe(200);
    expect((await sa.post(`/platform/tenants/${orgC.id}/suspension`)).status).toBe(200);
    expect((await c.get('/tenant/members')).status).toBe(403);
    expect((await orgC.admin.get('/tenant/members')).status).toBe(403);
    expect(((await c.get('/session/tenants')).json.tenants as unknown[]).length).toBe(0);
    expect((await sa.post(`/platform/tenants/${orgC.id}/reactivation`)).status).toBe(200);
    expect((await c.get('/tenant/members')).status).toBe(200);
  });

  it('an admin-initiated password reset ends the member’s sessions; the link reaches only the outbox', async () => {
    const m = await member(orgA, ['viewer']);
    expect((await m.get('/session')).status).toBe(200);
    const r = await orgA.admin.post(`/tenant/members/${m.membershipId}/password-reset`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['expiresAt', 'status']);
    expect((await m.get('/session')).status).toBe(401);
    const token = outboxToken(m.email, 'password_reset');
    expect(r.text).not.toContain(token);
    const next = pw();
    expect((await m.post('/account/token-password', { token, newPassword: next })).status).toBe(
      200,
    );
    expect((await m.post('/account/token-password', { token, newPassword: pw() })).status).toBe(
      400,
    ); // single use
    m.password = next;
    await m.signIn();
    expect((await m.get('/session')).status).toBe(200);
  });
});

describe('S7-10 last-administrator lock-out protection', () => {
  it('the only role manager cannot remove their own admin role, deactivate themselves, or delete/weaken the role', async () => {
    const org = await organisation(sa);
    const admin = org.admin;
    const me = (
      (await admin.get('/tenant/members')).json.members as Array<{ id: string; roleIds: string[] }>
    )[0]!;
    const adminRoleId = me.roleIds[0]!;
    expect((await admin.put(`/tenant/members/${me.id}/roles`, { roleIds: [] })).status).toBe(409);
    expect((await admin.post(`/tenant/members/${me.id}/deactivation`)).status).toBe(409);
    expect((await admin.del(`/tenant/roles/${adminRoleId}`)).status).toBe(409);
    expect(
      (
        await admin.put(`/tenant/roles/${adminRoleId}`, {
          name: 'Tenant Administrator',
          permissions: ['tenant.members.read'],
        })
      ).status,
    ).toBe(409);
    // Nothing changed and nothing was audited for the refused attempts.
    expect(
      (
        (await admin.get('/tenant/members')).json.members as Array<{
          roleIds: string[];
          status: string;
        }>
      )[0],
    ).toMatchObject({ roleIds: [adminRoleId], status: 'active' });
    expect(
      (await auditFor(org.id)).filter((a) =>
        /member\.(roles_set|deactivated)|role\.(deleted|changed)/.test(a.action),
      ),
    ).toEqual([]);
  });

  it('two admins removing each other at the same time: exactly one succeeds (serialised)', async () => {
    const org = await organisation(sa);
    const second = await member(org, ['tenant_administrator']);
    const first = (
      (await org.admin.get('/tenant/members')).json.members as Array<{ id: string; email: string }>
    ).find((x) => x.email === org.admin.email)!;
    const [r1, r2] = await Promise.all([
      org.admin.put(`/tenant/members/${second.membershipId}/roles`, { roleIds: [] }),
      second.put(`/tenant/members/${first.id}/roles`, { roleIds: [] }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // Exactly one wins; the other is refused (409 lock-out, or 403 because it lost its own rights).
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect([403, 409]).toContain(statuses.find((x) => x !== 200));
    const holders = await withTenantTransaction(db, { tenantId: org.id, userId: sa.id }, (trx) =>
      tenancy.activeHoldersOf(trx, 'tenant.roles.manage'),
    );
    expect(holders).toBeGreaterThanOrEqual(1);
  });
});

describe('S7-6 / S7-7 break-glass (ADR-028)', () => {
  it('no default access: a Super Admin sees no organisation data and cannot select one', async () => {
    expect((await sa.get('/tenant/members')).status).toBe(403);
    expect((await sa.choose(orgA.id)).status).toBe(404);
    const rows = await asApp<{ n: number }>('SELECT count(*)::int AS n FROM app.membership', [], {
      user: sa.id,
    });
    expect(rows[0]!.n).toBe(0);
  });

  it('request needs a purpose; only the organisation’s approver decides; read-only; one organisation; audited', async () => {
    expect(
      (await sa.post('/platform/break-glass', { tenantId: orgA.id, purpose: 'short' })).status,
    ).toBe(400);
    const req = await sa.post('/platform/break-glass', {
      tenantId: orgA.id,
      purpose: 'Investigate fictional support ticket 42',
    });
    expect(req.status).toBe(201);
    const grantId = (req.json.grant as { id: string }).id;
    // Not yet approved: no entry.
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(409);
    // B's admin cannot see or decide A's request.
    expect(
      (await orgB.admin.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' }))
        .status,
    ).toBe(404);
    const viewer = await member(orgA, ['viewer']);
    expect(
      (await viewer.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    const ok = await orgA.admin.post(`/tenant/break-glass/${grantId}/decision`, {
      decision: 'approve',
    });
    expect(ok.status).toBe(200);
    const g = ok.json.grant as { decidedAt: string; expiresAt: string };
    expect(Date.parse(g.expiresAt) - Date.parse(g.decidedAt)).toBe(3_600_000);

    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(200);
    const session = (await sa.get('/session')).json as {
      breakGlass: { grantId: string } | null;
      permissions: string[];
    };
    expect(session.breakGlass?.grantId).toBe(grantId);
    expect((await sa.get('/tenant/members')).status).toBe(200);
    // Read-only: every change is refused, including ones the Super Admin "could" do as a member.
    expect((await sa.post('/tenant/departments', { name: 'Break-glass write' })).status).toBe(403);
    expect((await sa.put('/tenant/settings', { selfApprovalAllowed: true })).status).toBe(403);
    expect((await sa.get('/tenant/break-glass')).status).toBe(403);
    // Scope: only organisation A.
    expect((await sa.choose(orgB.id)).status).toBe(404);
    const audit = (await auditFor(orgA.id)).map((a) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining(['breakglass.requested', 'breakglass.approved', 'breakglass.used']),
    );

    // Revocation by the organisation: the next request is refused.
    expect((await orgA.admin.post(`/tenant/break-glass/${grantId}/revocation`)).status).toBe(200);
    expect((await sa.get('/tenant/members')).status).toBe(403);
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(409);
    expect((await auditFor(orgA.id)).map((a) => a.action)).toContain('breakglass.revoked');
  });

  it('expiry after one hour (clock control): refused, marked expired, audited; no automatic renewal', async () => {
    const req = await sa.post('/platform/break-glass', {
      tenantId: orgB.id,
      purpose: 'Investigate fictional support ticket 77',
    });
    const grantId = (req.json.grant as { id: string }).id;
    await orgB.admin.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' });
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(200);
    expect((await sa.get('/tenant/roles')).status).toBe(200);
    await owner(
      `UPDATE platform.break_glass_grant SET decided_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [grantId],
    );
    expect((await sa.get('/tenant/roles')).status).toBe(403);
    const [row] = await owner<{ status: string }>(
      'SELECT status FROM platform.break_glass_grant WHERE id = $1',
      [grantId],
    );
    expect(row!.status).toBe('expired');
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(409);
    expect((await auditFor(orgB.id)).map((a) => a.action)).toContain('breakglass.expired');
    // The database refuses a grant longer than one hour.
    await expect(
      owner(
        `UPDATE platform.break_glass_grant SET expires_at = decided_at + interval '2 hours' WHERE id = $1`,
        [grantId],
      ),
    ).rejects.toThrow(/break_glass_max_one_hour/);
  });

  it('each layer refuses on its own: the access check rejects writes and expired grants; the database refuses use of an expired grant', async () => {
    const req = await sa.post('/platform/break-glass', {
      tenantId: orgA.id,
      purpose: 'Layer-by-layer check of break-glass controls',
    });
    const grantId = (req.json.grant as { id: string }).id;
    await orgA.admin.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' });
    expect((await sa.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(200);
    const session = (await identity.sessionResolve(db, sessionTokenHash(sa.token!), 1800))!;
    // API layer alone (service and database layers not reached): a write permission is refused.
    await expect(
      resolveAccess(db, session, 'tenant.departments.manage', 'POST', null),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveAccess(db, session, 'tenant.members.read', 'GET', null),
    ).resolves.toMatchObject({ kind: 'break_glass' });
    // Expiry: the API check ends the grant AND clears it from the session.
    await owner(
      `UPDATE platform.break_glass_grant SET decided_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [grantId],
    );
    await expect(
      resolveAccess(db, session, 'tenant.members.read', 'GET', null),
    ).rejects.toMatchObject({ status: 403 });
    const [ctx] = await owner<{ g: string | null }>(
      'SELECT break_glass_grant_id AS g FROM platform.user_session WHERE id = $1',
      [session.sessionId],
    );
    expect(ctx!.g).toBeNull();
    // Database layer alone: recording a use of an expired grant is refused.
    const used = await asApp<{ ok: boolean }>(
      'SELECT platform.breakglass_record_use($1, $2, $3, NULL) AS ok',
      [grantId, sa.id, 'probe'],
    );
    expect(used[0]!.ok).toBe(false);
  });

  it('a read-only transaction is enforced by PostgreSQL itself', async () => {
    await expect(
      withTenantTransaction(
        db,
        { tenantId: orgA.id, userId: sa.id },
        (trx) => tenancy.createDepartment(trx, orgA.id, { name: 'RO', description: '' }),
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);
  });
});

describe('S7-8 audit trail: atomic and protected', () => {
  it('each change writes exactly one audit row with its request id; a refused change writes none', async () => {
    const reqId = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const before = (await auditFor(orgA.id)).length;
    const name = unique('Audited ');
    const r = await orgA.admin.send(
      'POST',
      '/tenant/departments',
      { name },
      { 'x-request-id': reqId },
    );
    expect(r.status).toBe(201);
    const rows = (await auditFor(orgA.id)).slice(before);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'department.created',
        actor_kind: 'member',
        request_id: reqId,
      }),
    ]);
    // Duplicate name → 409; the department count and the audit trail are unchanged (one transaction).
    const dup = await orgA.admin.post('/tenant/departments', { name });
    expect(dup.status).toBe(409);
    expect((await auditFor(orgA.id)).length).toBe(before + 1);
  });

  it('pbe_app cannot read, change or delete the audit trail, nor write rows for another organisation; the owner is stopped by the trigger', async () => {
    const priv = await owner<Record<string, boolean>>(
      `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((p) => `has_table_privilege('pbe_app', 'audit.audit_event', '${p}') AS "${p}"`).join(', ')}`,
    );
    expect(priv[0]).toEqual({
      SELECT: false,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
    for (const sql of [
      'SELECT * FROM audit.audit_event',
      `UPDATE audit.audit_event SET action = 'x.y'`,
      'DELETE FROM audit.audit_event',
      'TRUNCATE audit.audit_event',
    ]) {
      await expect(asApp(sql, [], { tenant: orgA.id })).rejects.toThrow(/permission denied/);
    }
    await expect(
      asApp(
        `INSERT INTO audit.audit_event (tenant_id, actor_kind, action, target_type) VALUES ($1, 'member', 'forged.event', 'x')`,
        [orgB.id],
        { tenant: orgA.id },
      ),
    ).rejects.toThrow(/row-level security/);
    for (const sql of [
      `UPDATE audit.audit_event SET action = 'x.y'`,
      'DELETE FROM audit.audit_event',
      'TRUNCATE audit.audit_event',
    ]) {
      await expect(owner(sql)).rejects.toThrow(/append-only/);
    }
  });
});

describe('impersonation attempts (user and tenant context)', () => {
  it('tenant or user ids in headers, query or body are never used', async () => {
    const m = await member(orgA, ['project_lead']);
    const r = await m.send('GET', '/tenant/members', undefined, {
      'x-tenant-id': orgB.id,
      'x-user-id': sa.id,
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(orgB.admin.email);
    expect((await m.send('GET', `/tenant/members?tenantId=${orgB.id}`)).status).toBe(400);
    expect(
      (await orgA.admin.post('/tenant/departments', { name: unique('X '), tenantId: orgB.id }))
        .status,
    ).toBe(400);
  });

  it('a forged or another user’s grant cannot be used; a forged session token is refused', async () => {
    const other = await userWithPassword('other.');
    await other.signIn();
    const fake = new Client('nobody@example.test', 'x');
    fake.token = randomBytes(32).toString('base64url');
    expect((await fake.get('/session')).status).toBe(401);
    const req = await sa.post('/platform/break-glass', {
      tenantId: orgA.id,
      purpose: 'Grant that belongs to the Super Admin only',
    });
    const grantId = (req.json.grant as { id: string }).id;
    await orgA.admin.post(`/tenant/break-glass/${grantId}/decision`, { decision: 'approve' });
    expect((await other.post(`/platform/break-glass/${grantId}/entry`)).status).toBe(403);
    const session = await owner<{ id: string }>(
      'SELECT id FROM platform.user_session WHERE user_id = (SELECT id FROM platform.user_account WHERE email_normalized = $1) AND ended_at IS NULL',
      [other.email],
    );
    const ok = await asApp<{ ok: boolean }>(
      'SELECT platform.auth_session_set_context($1, NULL, $2) AS ok',
      [session[0]!.id, grantId],
    );
    expect(ok[0]!.ok).toBe(false);
    await orgA.admin.post(`/tenant/break-glass/${grantId}/revocation`);
  });

  it('LIMITATION (R-007, documented): the runtime role can still set app.tenant_id itself in raw SQL', async () => {
    const rows = await asApp<{ n: number }>('SELECT count(*)::int AS n FROM app.role', [], {
      tenant: orgB.id,
    });
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('escalation attempts', () => {
  it('a role manager cannot grant permissions they do not hold; platform or unknown permissions are refused', async () => {
    const org = await organisation(sa);
    const roles = (await org.admin.get('/tenant/roles')).json.roles as Array<{
      id: string;
      templateKey: string | null;
    }>;
    const limited = await org.admin.post('/tenant/roles', {
      name: 'Role manager only',
      permissions: ['tenant.roles.read', 'tenant.roles.manage'],
    });
    expect(limited.status).toBe(201);
    const limitedId = (limited.json.role as { id: string }).id;
    const m = await member(org, []);
    await org.admin.put(`/tenant/members/${m.membershipId}/roles`, { roleIds: [limitedId] });
    await m.signIn(); // admin permission → MFA required → enrols
    await m.choose(org.id);
    expect(
      (
        await m.post('/tenant/roles', {
          name: 'Grab members',
          permissions: ['tenant.members.manage'],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await m.put(`/tenant/roles/${limitedId}`, {
          name: 'Role manager only',
          permissions: ['tenant.roles.read', 'tenant.roles.manage', 'tenant.members.manage'],
        })
      ).status,
    ).toBe(403);
    const adminRole = roles.find((r) => r.templateKey === 'tenant_administrator')!.id;
    expect(
      (await m.put(`/tenant/members/${m.membershipId}/roles`, { roleIds: [limitedId, adminRole] }))
        .status,
    ).toBe(403);
    expect(
      (
        await org.admin.post('/tenant/roles', {
          name: 'Platform grab',
          permissions: ['platform.tenants.manage'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await org.admin.post('/tenant/roles', {
          name: 'Unknown',
          permissions: ['tenant.everything.do'],
        })
      ).status,
    ).toBe(400);
    expect((await org.admin.get('/platform/tenants')).status).toBe(403);
  });
});

describe('S7-11 MFA for administrative roles', () => {
  it('assigning an administrative role makes MFA mandatory and ends unenrolled sessions', async () => {
    const m = await member(orgA, ['viewer']);
    const [before] = await owner<{ r: boolean }>(
      'SELECT mfa_required AS r FROM platform.user_account WHERE email_normalized = $1',
      [m.email],
    );
    expect(before!.r).toBe(false);
    const roles = (await orgA.admin.get('/tenant/roles')).json.roles as Array<{
      id: string;
      templateKey: string | null;
    }>;
    await orgA.admin.put(`/tenant/members/${m.membershipId}/roles`, {
      roleIds: [roles.find((r) => r.templateKey === 'tenant_administrator')!.id],
    });
    const [after] = await owner<{ r: boolean }>(
      'SELECT mfa_required AS r FROM platform.user_account WHERE email_normalized = $1',
      [m.email],
    );
    expect(after!.r).toBe(true);
    expect((await m.get('/session')).status).toBe(401);
    expect((await m.post('/auth/login', { email: m.email, password: m.password })).json).toEqual({
      next: 'enrol',
    });
  });
});

describe('S7-9 configurable roles and departments; S7-13 separation-of-duties setting', () => {
  it('roles and departments can be renamed, added and removed; names carry no power', async () => {
    const roles = (await orgA.admin.get('/tenant/roles')).json.roles as Array<{
      id: string;
      templateKey: string | null;
      permissions: string[];
    }>;
    const viewer = roles.find((r) => r.templateKey === 'viewer')!;
    expect(
      (
        await orgA.admin.put(`/tenant/roles/${viewer.id}`, {
          name: 'Tenant Administrator copy',
          permissions: [],
        })
      ).status,
    ).toBe(200);
    const m = await member(orgA, ['viewer']);
    expect((await m.get('/tenant/members')).status).toBe(403); // the name says admin; the permissions do not
    const custom = await orgA.admin.post('/tenant/roles', {
      name: unique('Lab manager '),
      permissions: ['tenant.members.read'],
    });
    await orgA.admin.put(`/tenant/members/${m.membershipId}/roles`, {
      roleIds: [(custom.json.role as { id: string }).id],
    });
    expect((await m.get('/tenant/members')).status).toBe(200);
    const dept = await orgA.admin.post('/tenant/departments', { name: unique('Stability lab ') });
    expect(
      (await orgA.admin.del(`/tenant/departments/${(dept.json.department as { id: string }).id}`))
        .status,
    ).toBe(200);
  });

  it('decisions follow permissions only: the exact "Tenant Administrator" role and template key grant nothing once emptied', async () => {
    const org = await organisation(sa);
    const roles = (await org.admin.get('/tenant/roles')).json.roles as Array<{
      id: string;
      name: string;
      templateKey: string | null;
      permissions: string[];
    }>;
    const adminRole = roles.find((r) => r.templateKey === 'tenant_administrator')!;
    expect(adminRole.name).toBe('Tenant Administrator');
    // The admin moves every power to a role with an unrelated name ...
    const custodian = await org.admin.post('/tenant/roles', {
      name: unique('Custodian '),
      permissions: adminRole.permissions,
    });
    expect(custodian.status).toBe(201);
    const members = (await org.admin.get('/tenant/members')).json.members as Array<{
      id: string;
      email: string;
    }>;
    const self = members.find((x) => x.email === org.admin.email)!;
    expect(
      (
        await org.admin.put(`/tenant/members/${self.id}/roles`, {
          roleIds: [adminRole.id, (custodian.json.role as { id: string }).id],
        })
      ).status,
    ).toBe(200);
    // ... and empties the built-in role, which KEEPS its exact name and template key.
    expect(
      (
        await org.admin.put(`/tenant/roles/${adminRole.id}`, {
          name: 'Tenant Administrator',
          permissions: [],
        })
      ).status,
    ).toBe(200);
    const after = ((await org.admin.get('/tenant/roles')).json.roles as typeof roles).find(
      (r) => r.id === adminRole.id,
    )!;
    expect([after.name, after.templateKey, after.permissions]).toEqual([
      'Tenant Administrator',
      'tenant_administrator',
      [],
    ]);
    // A member holding ONLY that role is refused everywhere ...
    const m = await member(org, ['tenant_administrator']);
    for (const p of [
      '/tenant/members',
      '/tenant/roles',
      '/tenant/departments',
      '/tenant/settings',
    ]) {
      expect((await m.get(p)).status).toBe(403);
    }
    expect((await m.post('/tenant/departments', { name: unique('Dept ') })).status).toBe(403);
    // ... while the admin keeps full access through the role with the unrelated name.
    expect((await org.admin.get('/tenant/members')).status).toBe(200);
    expect((await org.admin.post('/tenant/departments', { name: unique('Dept ') })).status).toBe(
      201,
    );
  });

  it('separation of duties: default "not allowed", change audited', async () => {
    expect((await orgB.admin.get('/tenant/settings')).json).toEqual({ selfApprovalAllowed: false });
    expect((await orgB.admin.put('/tenant/settings', { selfApprovalAllowed: true })).json).toEqual({
      selfApprovalAllowed: true,
    });
    expect((await auditFor(orgB.id)).map((a) => a.action)).toContain('settings.changed');
    await orgB.admin.put('/tenant/settings', { selfApprovalAllowed: false });
  });
});

describe('one-time tokens (ADR-029)', () => {
  it('stored only as hashes, at most four hours, newest only, refused once expired', async () => {
    const m = await member(orgA, ['viewer']);
    await orgA.admin.post(`/tenant/members/${m.membershipId}/password-reset`);
    const first = outboxToken(m.email, 'password_reset');
    await orgA.admin.post(`/tenant/members/${m.membershipId}/password-reset`);
    const second = outboxToken(m.email, 'password_reset');
    expect(
      (await m.post('/account/token-password', { token: first, newPassword: pw() })).status,
    ).toBe(400); // superseded
    const rows = await owner<{ token_hash: Buffer; lifetime: number }>(
      `SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS lifetime FROM platform.user_token
        WHERE user_id = (SELECT id FROM platform.user_account WHERE email_normalized = $1)`,
      [m.email],
    );
    for (const r of rows) {
      expect(r.lifetime).toBe(14_400);
      expect(r.token_hash.toString('base64url')).not.toBe(second);
    }
    await owner(
      `UPDATE platform.user_token SET created_at = now() - interval '5 hours', expires_at = now() - interval '1 hour' WHERE token_hash = (SELECT token_hash FROM platform.user_token ORDER BY created_at DESC LIMIT 1)`,
    );
    expect(
      (await m.post('/account/token-password', { token: second, newPassword: pw() })).status,
    ).toBe(400);
    await expect(
      owner(
        `UPDATE platform.user_token SET expires_at = created_at + interval '5 hours' WHERE user_id = (SELECT id FROM platform.user_account WHERE email_normalized = $1)`,
        [m.email],
      ),
    ).rejects.toThrow(/user_token_max_four_hours/);
  });

  it('a weak password does not use up the token', async () => {
    const m = await member(orgA, ['viewer']);
    await orgA.admin.post(`/tenant/members/${m.membershipId}/password-reset`);
    const token = outboxToken(m.email, 'password_reset');
    expect(
      (await m.post('/account/token-password', { token, newPassword: 'aaaaaaaaaaaaaaaaaaaa' }))
        .status,
    ).toBe(400);
    expect((await m.post('/account/token-password', { token, newPassword: pw() })).status).toBe(
      200,
    );
  });
});

describe('Super Admin bootstrap (operator command)', () => {
  it('npm run user -- grant-platform-role: audited, MFA required, sessions ended; pbe_app cannot do it', async () => {
    const u = await userWithPassword('bootstrap.');
    await u.signIn();
    const cli = path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js');
    expect(fs.existsSync(cli)).toBe(true);
    const run = spawnSync(
      process.execPath,
      ['--env-file=.env', cli, 'grant-platform-role', '--email', u.email],
      {
        cwd: ROOT,
        env: { ...process.env, PBE_PG_DEV_DATABASE: String(dbConfig('app').database) },
        encoding: 'utf8',
      },
    );
    expect(run.stderr).toBe('');
    expect(run.stdout).toMatch(
      /Super Admin role granted\. 1 session\(s\) ended\. An authenticator app is required/,
    );
    expect((await u.get('/session')).status).toBe(401);
    const audit = await owner<{ action: string; actor_kind: string }>(
      `SELECT action, actor_kind FROM audit.audit_event WHERE target_id = (SELECT id FROM platform.user_account WHERE email_normalized = $1)`,
      [u.email],
    );
    expect(audit).toEqual([{ action: 'platform.role_granted', actor_kind: 'operator' }]);
    await expect(
      asApp(`SELECT platform.operator_platform_role_set($1, 'platform_owner', true)`, [sa.id]),
    ).rejects.toThrow(/permission denied/);
    expect(ENV.users.app).toBe('pbe_app');
  });
});

describe('S7-16 hygiene: no secrets in logs, audit, security events or responses', () => {
  it('no password, token, recovery code or MFA key appears anywhere it should not', async () => {
    const audit = await owner<{ row: string }>(
      'SELECT row_to_json(a)::text AS row FROM audit.audit_event a',
    );
    const events = await owner<{ row: string }>(
      'SELECT row_to_json(e)::text AS row FROM audit.security_event e',
    );
    const haystacks = [
      logs.join('\n'),
      audit.map((a) => a.row).join('\n'),
      events.map((e) => e.row).join('\n'),
    ];
    expect(secrets.size).toBeGreaterThan(20);
    for (const s of secrets) for (const h of haystacks) expect(h.includes(s)).toBe(false);
  });
});
