import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Secret, TOTP } from 'otpauth';
import { createApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config/config';
import { hashPassword } from '../../apps/api/src/modules/auth/password-hash';
import { throttleKey } from '../../apps/api/src/modules/auth/secrets';
import { createDatabase, identity, type Database } from '../../apps/api/src/modules/db';
import { migrationsDir } from '../../tooling/migrate/src/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { dbConfig, ROOT, withClient } from './helpers';

/*
 * Stage 6 sign-in, session and MFA tests (STAGE-06-PLAN.md §5, S6-1 … S6-16, S6-18) against the
 * real API and real PostgreSQL 18 (pbe_test, as pbe_app), over real HTTP. Fictional users only.
 * Every password, code and key is generated at run time; none is written in this file.
 */

const ORIGIN = 'http://localhost:3000';
const MFA_KEY = randomBytes(32).toString('base64');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: NestExpressApplication;
let base: string;
let db: Database;
const logs: string[] = [];
/** Every secret the tests create or receive; none may appear in logs, events or ordinary responses. */
const secrets = new Set<string>();
/** Bodies of responses that are not allowed to carry secrets (all except enrolment / confirmation). */
const ordinaryBodies: string[] = [];

const strongPassword = () => {
  const p = `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`;
  secrets.add(p);
  return p;
};
// A fresh documentation-range address per client, so throttle state from other tests or runs never applies.
const randomAddress = () =>
  `2001:db8::${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;

function config() {
  const app = dbConfig('app');
  return loadConfig({
    NODE_ENV: 'test',
    PBE_LOG_LEVEL: 'debug',
    PBE_PG_HOST: String(app.host),
    PBE_PG_PORT: String(app.port),
    PBE_PG_DEV_DATABASE: String(app.database),
    PBE_PG_APP_USER: String(app.user),
    PBE_PG_APP_PASSWORD: String(app.password),
    PBE_MFA_ENCRYPTION_KEY: MFA_KEY,
  });
}

/** SQL as the table owner, for test set-up and inspection only (never what the API can do). */
async function owner<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return withClient(dbConfig('migrator'), async (c) => (await c.query<T>(text, params)).rows, {
    asOwner: true,
  });
}

interface TestUser {
  id: string;
  email: string;
  password: string;
}

async function makeUser(options: { mfaRequired?: boolean } = {}): Promise<TestUser> {
  const email = `fictional.${randomBytes(4).toString('hex')}@example.test`;
  const password = strongPassword();
  const id = await identity.createUser(db, email, 'Fictional Test User');
  await identity.credentialSet(db, id, await hashPassword(password));
  if (options.mfaRequired) await identity.setMfaRequired(db, id, true);
  return { id, email, password };
}

/** A browser-like client: keeps the session cookie, sends the PBE Origin and a client address. */
class Client {
  token: string | undefined;
  constructor(readonly address: string = randomAddress()) {}

  async send(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
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
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const m = /^__Host-pbe_session=([^;]*)/.exec(c);
      if (m) {
        this.token = m[1] || undefined;
        if (m[1]) secrets.add(m[1]);
      }
    }
    const text = await res.text();
    if (!/\/account\/mfa\//.test(p)) ordinaryBodies.push(text);
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      setCookie,
      text,
    };
  }

  login(user: { email: string; password: string }) {
    return this.send('POST', '/auth/login', { email: user.email, password: user.password });
  }
}

const code = (manualKey: string, offsetSeconds = 0) => {
  const c = TOTP.generate({
    secret: Secret.fromBase32(manualKey),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: Date.now() + offsetSeconds * 1000,
  });
  secrets.add(c);
  return c;
};

async function enrol(client: Client): Promise<{ manualKey: string; recoveryCodes: string[] }> {
  const start = await client.send('POST', '/account/mfa/enrolment');
  expect(start.status).toBe(200);
  const manualKey = start.json.manualKey as string;
  secrets.add(manualKey);
  const confirm = await client.send('POST', '/account/mfa/confirmation', { code: code(manualKey) });
  expect(confirm.status).toBe(200);
  const recoveryCodes = confirm.json.recoveryCodes as string[];
  recoveryCodes.forEach((c) => secrets.add(c));
  return { manualKey, recoveryCodes };
}

const eventsFor = (userId: string) =>
  owner<{ event_type: string; outcome: string; actor: string; detail: Record<string, unknown> }>(
    'SELECT event_type, outcome, actor, detail FROM audit.security_event WHERE user_id = $1 ORDER BY occurred_at, id',
    [userId],
  );

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
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await app?.close();
});

describe('S6-1 correct sign-in', () => {
  it('signs in with any letter case in the email; new session; login_succeeded event', async () => {
    const user = await makeUser();
    const client = new Client();
    const res = await client.login({ ...user, email: user.email.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ next: 'done' });
    expect(client.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await client.send('GET', '/session');
    expect(me.status).toBe(200);
    expect(me.json).toEqual({
      user: { id: user.id, email: user.email, displayName: 'Fictional Test User' },
      mfa: { enrolled: false, required: false },
      activeTenant: null,
      breakGlass: null,
      platformRoles: [],
      permissions: [],
    });
    expect((await eventsFor(user.id)).map((e) => e.event_type)).toContain('login_succeeded');
  });
});

describe('S6-2 failed sign-in is indistinguishable', () => {
  it('wrong password, unknown email and deactivated user give the same 401 answer', async () => {
    const user = await makeUser();
    const inactive = await makeUser();
    await owner(`UPDATE platform.user_account SET status = 'deactivated' WHERE id = $1`, [
      inactive.id,
    ]);
    const answers = [];
    for (const attempt of [
      { email: user.email, password: strongPassword() },
      {
        email: `nobody.${randomBytes(4).toString('hex')}@example.test`,
        password: strongPassword(),
      },
      inactive,
    ]) {
      const r = await new Client().login(attempt);
      expect(r.status).toBe(401);
      expect(r.setCookie).toEqual([]);
      const rest = { ...r.json };
      delete rest.requestId;
      answers.push(JSON.stringify(rest));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toMatchObject({ code: 'AUTHENTICATION_FAILED', status: 401 });
    const ev = await eventsFor(user.id);
    expect(ev.at(-1)).toMatchObject({ event_type: 'login_failed', outcome: 'failure' });
  });

  it('an unknown email takes about as long as a wrong password (a hash is always computed)', async () => {
    // One wrong password per known user (so no account reaches the 5-failure limit), 5 samples
    // each, after a warm-up request. Both medians must show a real hash (tens of milliseconds)
    // and lie within a factor of two of each other.
    const users = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
    const time = async (email: string) => {
      const t = process.hrtime.bigint();
      const r = await new Client().login({ email, password: strongPassword() });
      expect(r.status).toBe(401);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    await time(`warmup.${randomBytes(4).toString('hex')}@example.test`);
    const known: number[] = [];
    const unknown: number[] = [];
    for (const u of users) {
      known.push(await time(u.email));
      unknown.push(await time(`nobody.${randomBytes(4).toString('hex')}@example.test`));
    }
    const [k, u] = [median(known), median(unknown)];
    expect(k).toBeGreaterThan(20);
    expect(u).toBeGreaterThan(20);
    expect(u).toBeGreaterThan(k * 0.5);
    expect(u).toBeLessThan(k * 2);
  });
});

describe('S6-3 lockout and back-off', () => {
  it('blocks after 5 failures (429 even with the right password), grows the delay, and expires', async () => {
    const user = await makeUser();
    const client = new Client();
    for (let i = 0; i < 5; i += 1) {
      expect((await client.login({ email: user.email, password: strongPassword() })).status).toBe(
        401,
      );
    }
    const blocked = await client.login(user);
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    const key = throttleKey('account', user.email);
    const delay = async () =>
      (
        await owner<{ s: number }>(
          'SELECT extract(epoch FROM blocked_until - now())::int AS s FROM platform.auth_throttle WHERE throttle_key = $1',
          [key],
        )
      )[0]!.s;
    expect(await delay()).toBeGreaterThan(50);
    expect(await delay()).toBeLessThanOrEqual(60);
    // Let the block expire (test clock control), then one more failure doubles the delay.
    const expire = () =>
      owner(
        `UPDATE platform.auth_throttle SET blocked_until = now() - interval '1 second' WHERE throttle_key = $1`,
        [key],
      );
    await expire();
    expect((await client.login({ email: user.email, password: strongPassword() })).status).toBe(
      401,
    );
    expect(await delay()).toBeGreaterThan(110);
    await expire();
    // After expiry the right password works again and the counter is cleared.
    expect((await client.login(user)).status).toBe(200);
    expect(
      (
        await owner<{ failures: number }>(
          'SELECT failures FROM platform.auth_throttle WHERE throttle_key = $1',
          [key],
        )
      )[0]!.failures,
    ).toBe(0);
    expect((await eventsFor(user.id)).map((e) => e.event_type)).toContain('login_failed');
  });

  it('the account block applies to unknown emails too (no enumeration through throttling)', async () => {
    const ghost = { email: `nobody.${randomBytes(4).toString('hex')}@example.test`, password: '' };
    const client = new Client();
    for (let i = 0; i < 5; i += 1) {
      await client.login({ ...ghost, password: strongPassword() });
    }
    expect((await client.login({ ...ghost, password: strongPassword() })).status).toBe(429);
  });
});

describe('S6-4 per-address limit (password spraying)', () => {
  it('20 failures across different accounts from one address trigger 429 for that address only', async () => {
    const user = await makeUser();
    const sprayer = new Client(randomAddress());
    for (let i = 0; i < 20; i += 1) {
      const r = await sprayer.login({
        email: `target${i}.${randomBytes(3).toString('hex')}@example.test`,
        password: strongPassword(),
      });
      expect(r.status).toBe(401);
    }
    expect((await sprayer.login(user)).status).toBe(429);
    expect((await new Client().login(user)).status).toBe(200);
  });
});

describe('S6-5 session fixation', () => {
  it('a new session id at sign-in; the previous one stops working', async () => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    const first = client.token!;
    await client.login(user);
    const second = client.token!;
    expect(second).not.toBe(first);
    expect((await client.send('GET', '/session')).status).toBe(200);
    client.token = first;
    expect((await client.send('GET', '/session')).status).toBe(401);
  });

  it('a planted token is never adopted', async () => {
    const user = await makeUser();
    const client = new Client();
    const planted = randomBytes(32).toString('base64url');
    client.token = planted;
    await client.login(user);
    expect(client.token).not.toBe(planted);
  });
});

describe('S6-6 expiry', () => {
  it.each([
    ['idle', 'idle_expires_at', 'expired_idle'],
    ['absolute', 'absolute_expires_at', 'expired_absolute'],
  ])('%s timeout ends the session (401) and is logged', async (_label, column, reason) => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    await owner(
      `UPDATE platform.user_session SET ${column} = now() - interval '1 second' WHERE user_id = $1 AND ended_at IS NULL`,
      [user.id],
    );
    expect((await client.send('GET', '/session')).status).toBe(401);
    const ended = await owner<{ end_reason: string }>(
      'SELECT end_reason FROM platform.user_session WHERE user_id = $1',
      [user.id],
    );
    expect(ended.map((r) => r.end_reason)).toEqual([reason]);
    expect((await eventsFor(user.id)).at(-1)).toMatchObject({
      event_type: 'session_ended',
      detail: { reason },
    });
  });

  it('activity extends the idle limit (30 minutes) but never past the absolute limit (12 hours)', async () => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    const [row] = await owner<{ idle: number; absolute: number }>(
      `SELECT extract(epoch FROM idle_expires_at - created_at)::int AS idle,
              extract(epoch FROM absolute_expires_at - created_at)::int AS absolute
         FROM platform.user_session WHERE user_id = $1`,
      [user.id],
    );
    expect(row!.idle).toBe(1800);
    expect(row!.absolute).toBe(43200);
  });
});

describe('S6-7 sign-out', () => {
  it('the same cookie is refused afterwards (server-side revocation)', async () => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    const token = client.token!;
    const out = await client.send('POST', '/auth/logout');
    expect(out.status).toBe(200);
    expect(out.setCookie[0]).toMatch(/Max-Age=0/);
    client.token = token;
    expect((await client.send('GET', '/session')).status).toBe(401);
    expect((await eventsFor(user.id)).map((e) => e.event_type)).toContain('logout');
  });
});

describe('S6-8 prompt revocation', () => {
  it('a password change ends every session; the changer gets a fresh one', async () => {
    const user = await makeUser();
    const a = new Client();
    const b = new Client();
    await a.login(user);
    await b.login(user);
    const before = a.token;
    const next = strongPassword();
    const r = await a.send('POST', '/account/password', {
      currentPassword: user.password,
      newPassword: next,
    });
    expect(r.status).toBe(200);
    expect(a.token).not.toBe(before);
    expect((await a.send('GET', '/session')).status).toBe(200);
    expect((await b.send('GET', '/session')).status).toBe(401);
    expect((await new Client().login(user)).status).toBe(401);
    expect((await new Client().login({ ...user, password: next })).status).toBe(200);
  });

  it('a wrong current password or a weak new one is refused', async () => {
    const user = await makeUser();
    const a = new Client();
    await a.login(user);
    const wrong = await a.send('POST', '/account/password', {
      currentPassword: strongPassword(),
      newPassword: strongPassword(),
    });
    expect(wrong.status).toBe(401);
    const weak = await a.send('POST', '/account/password', {
      currentPassword: user.password,
      newPassword: 'aaaaaaaaaaaaaaaaaaaa',
    });
    expect(weak.status).toBe(400);
    expect(weak.json).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'body.newPassword' }],
    });
    const same = await a.send('POST', '/account/password', {
      currentPassword: user.password,
      newPassword: user.password,
    });
    expect(same.status).toBe(400);
  });

  it('an operator reset (npm run user -- reset-password) ends all sessions and is logged as operator', async () => {
    const user = await makeUser();
    const a = new Client();
    await a.login(user);
    const next = strongPassword();
    const cli = path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js');
    expect(fs.existsSync(cli)).toBe(true); // built by `npm run build` (verify step 8)
    const run = spawnSync(
      process.execPath,
      ['--env-file=.env', cli, 'reset-password', '--email', user.email],
      {
        cwd: ROOT,
        input: `${next}\n${next}\n`,
        env: { ...process.env, PBE_PG_DEV_DATABASE: String(dbConfig('app').database) },
        encoding: 'utf8',
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Password reset\. 1 session\(s\) ended\./);
    expect(`${run.stdout}${run.stderr}`).not.toContain(next);
    logs.push(run.stdout, run.stderr);
    expect((await a.send('GET', '/session')).status).toBe(401);
    expect((await new Client().login({ ...user, password: next })).status).toBe(200);
    expect(await eventsFor(user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'password_reset', actor: 'operator' }),
      ]),
    );
  });

  it('the operator command refuses passwords given as arguments, and weak passwords', async () => {
    const user = await makeUser();
    const cli = path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js');
    const env = { ...process.env, PBE_PG_DEV_DATABASE: String(dbConfig('app').database) };
    const asArg = spawnSync(
      process.execPath,
      ['--env-file=.env', cli, 'reset-password', '--email', user.email, '--password', 'x'],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
    expect(asArg.status).toBe(1);
    expect(asArg.stderr).toMatch(/never accepted as arguments/);
    const weak = spawnSync(
      process.execPath,
      ['--env-file=.env', cli, 'reset-password', '--email', user.email],
      { cwd: ROOT, env, input: 'short\nshort\n', encoding: 'utf8' },
    );
    expect(weak.status).toBe(1);
    expect(weak.stderr).toMatch(/at least 15/);
  });

  it('a deactivated user’s session is refused at the next request', async () => {
    const user = await makeUser();
    const a = new Client();
    await a.login(user);
    await owner(`UPDATE platform.user_account SET status = 'deactivated' WHERE id = $1`, [user.id]);
    expect((await a.send('GET', '/session')).status).toBe(401);
    expect((await eventsFor(user.id)).at(-1)).toMatchObject({
      event_type: 'session_ended',
      detail: { reason: 'user_deactivated' },
    });
  });
});

describe('S6-9 MFA required and S6-10 TOTP', () => {
  it('a required user must enrol first; enrolment is confirmed only by a valid code', async () => {
    const user = await makeUser({ mfaRequired: true });
    const client = new Client();
    expect((await client.login(user)).json).toEqual({ next: 'enrol' });
    expect((await client.send('GET', '/session')).status).toBe(401);
    const start = await client.send('POST', '/account/mfa/enrolment');
    const manualKey = start.json.manualKey as string;
    secrets.add(manualKey);
    expect(manualKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.json.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(start.json.qrSvg).not.toMatch(/<script|on\w+=/i);
    // A wrong code does not confirm enrolment.
    const bad = await client.send('POST', '/account/mfa/confirmation', {
      code: '000000' === code(manualKey) ? '111111' : '000000',
    });
    expect(bad.status).toBe(401);
    expect(
      (
        await owner<{ c: boolean }>(
          'SELECT confirmed_at IS NOT NULL AS c FROM platform.mfa_totp_factor WHERE user_id = $1',
          [user.id],
        )
      )[0]!.c,
    ).toBe(false);
    const pending = client.token;
    const ok = await client.send('POST', '/account/mfa/confirmation', { code: code(manualKey) });
    expect(ok.status).toBe(200);
    expect(ok.json.next).toBe('done');
    expect(ok.json.recoveryCodes as string[]).toHaveLength(10);
    expect(client.token).not.toBe(pending);
    expect((await client.send('GET', '/session')).json.mfa).toEqual({
      enrolled: true,
      required: true,
    });
    // A second enrolment is refused while one is confirmed.
    expect((await client.send('POST', '/account/mfa/enrolment')).status).toBe(409);
  });

  it('an enrolled user cannot reach signed-in routes before a valid code; replay and reuse are refused', async () => {
    const user = await makeUser();
    const setup = new Client();
    await setup.login(user);
    const { manualKey, recoveryCodes } = await enrol(setup);

    const c1 = new Client();
    expect((await c1.login(user)).json).toEqual({ next: 'mfa' });
    expect((await c1.send('GET', '/session')).status).toBe(401);
    expect((await c1.send('POST', '/auth/mfa/verify', { code: code(manualKey, -90) })).status).toBe(
      401,
    );
    const nextStep = code(manualKey, 30); // the enrolment used the current step
    const pendingToken = c1.token;
    expect((await c1.send('POST', '/auth/mfa/verify', { code: nextStep })).status).toBe(200);
    expect(c1.token).not.toBe(pendingToken);
    expect((await c1.send('GET', '/session')).status).toBe(200);

    // Replay: the same code again, in a new sign-in, is refused.
    const c2 = new Client();
    await c2.login(user);
    const replay = await c2.send('POST', '/auth/mfa/verify', { code: nextStep });
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ code: 'AUTHENTICATION_FAILED' });

    // A recovery code works once.
    const rc = recoveryCodes[0]!;
    expect(
      (await c2.send('POST', '/auth/mfa/verify', { recoveryCode: rc.toLowerCase() })).status,
    ).toBe(200);
    const c3 = new Client();
    await c3.login(user);
    expect((await c3.send('POST', '/auth/mfa/verify', { recoveryCode: rc })).status).toBe(401);
    const types = (await eventsFor(user.id)).map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'mfa_enrolled',
        'mfa_verification_failed',
        'login_succeeded_recovery_code',
      ]),
    );
  });

  it('repeated wrong codes are throttled', async () => {
    const user = await makeUser();
    const setup = new Client();
    await setup.login(user);
    const { manualKey } = await enrol(setup);
    const c = new Client();
    await c.login(user);
    const wrong = code(manualKey, 300);
    for (let i = 0; i < 5; i += 1) await c.send('POST', '/auth/mfa/verify', { code: wrong });
    expect((await c.send('POST', '/auth/mfa/verify', { code: code(manualKey, 30) })).status).toBe(
      429,
    );
  });
});

describe('S6-11 cookie flags on real responses', () => {
  it('every session cookie: __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain', async () => {
    const user = await makeUser();
    const client = new Client();
    const res = await client.login(user);
    const out = await client.send('POST', '/auth/logout');
    for (const c of [...res.setCookie, ...out.setCookie]) {
      expect(c).toMatch(/^__Host-pbe_session=/);
      for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict'])
        expect(c).toContain(flag);
      expect(c).not.toMatch(/Domain=/i);
    }
  });
});

describe('S6-12 CSRF: state-changing requests must come from the PBE web origin', () => {
  it.each([
    ['no Origin', { origin: '' }],
    ['a foreign Origin', { origin: 'https://attacker.example' }],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['a form content type', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('%s → 403, nothing changes', async (_label, headers) => {
    const user = await makeUser();
    const client = new Client();
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': client.address,
        ...headers,
      },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(
      (await owner('SELECT 1 FROM platform.user_session WHERE user_id = $1', [user.id])).length,
    ).toBe(0);
  });
});

describe('S6-15 storage: nothing readable at rest', () => {
  it('Argon2id hashes, encrypted TOTP secret, hashed recovery codes and session tokens', async () => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    const token = client.token!;
    const { manualKey, recoveryCodes } = await enrol(client);
    const [cred] = await owner<{ password_hash: string }>(
      'SELECT password_hash FROM platform.password_credential WHERE user_id = $1',
      [user.id],
    );
    expect(cred!.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    const [factor] = await owner<{ secret_ciphertext: Buffer; key_id: string }>(
      'SELECT secret_ciphertext, key_id FROM platform.mfa_totp_factor WHERE user_id = $1',
      [user.id],
    );
    expect(factor!.secret_ciphertext.toString('latin1')).not.toContain(manualKey);
    expect(factor!.key_id).toMatch(/^k-[0-9a-f]{12}$/);
    const codes = await owner<{ code_hash: Buffer }>(
      'SELECT code_hash FROM platform.mfa_recovery_code WHERE user_id = $1',
      [user.id],
    );
    expect(codes).toHaveLength(10);
    for (const r of codes)
      for (const rc of recoveryCodes) expect(r.code_hash.toString('latin1')).not.toContain(rc);
    const sessions = await owner<{ token_hash: Buffer }>(
      'SELECT token_hash FROM platform.user_session WHERE user_id = $1',
      [user.id],
    );
    for (const s of sessions) expect(s.token_hash.toString('base64url')).not.toBe(token);
  });
});

describe('S6-16 unique, permanent user ids', () => {
  it('ids are UUIDv7; an email differing only in letter case is refused', async () => {
    const user = await makeUser();
    expect(user.id).toMatch(UUIDV7);
    await expect(
      identity.createUser(db, user.email.toUpperCase(), 'Duplicate'),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('S6-18 authentication grants no tenant or permission access', () => {
  it('a signed-in session carries no tenant and no permissions; tenant rows stay invisible', async () => {
    const user = await makeUser();
    const client = new Client();
    await client.login(user);
    const me = await client.send('GET', '/session');
    expect(me.json.permissions).toEqual([]);
    // Stage 7A: still no tenant, no break-glass, no platform role and no permission by default.
    expect(me.json).toMatchObject({
      activeTenant: null,
      breakGlass: null,
      platformRoles: [],
      permissions: [],
    });
    await owner(
      `INSERT INTO platform.tenant (slug, display_name) VALUES ($1, 'Fictional Tenant')`,
      [`t-${randomBytes(4).toString('hex')}`],
    );
    // The runtime role still sees no tenant rows without a tenant context (Stage 3 RLS).
    const visible = await withClient(
      dbConfig('app'),
      async (c) => (await c.query('SELECT count(*)::int AS n FROM platform.tenant')).rows[0].n,
    );
    expect(visible).toBe(0);
  });
});

describe('S6-13 secrets never logged, stored in events or returned', () => {
  it('no password, token, code, recovery code or MFA key appears in logs, events or ordinary responses', async () => {
    expect(secrets.size).toBeGreaterThan(30);
    const events = await owner<{ row: string }>(
      'SELECT row_to_json(e)::text AS row FROM audit.security_event e',
    );
    const haystacks = [
      logs.join('\n'),
      events.map((e) => e.row).join('\n'),
      ordinaryBodies.join('\n'),
    ];
    // 6-digit authenticator codes are short, so they are matched as whole numbers only (a plain
    // substring search would also hit unrelated digits, e.g. inside timestamps).
    const found = (h: string, secret: string) =>
      /^\d{6}$/.test(secret)
        ? new RegExp(`(?<![0-9A-Za-z])${secret}(?![0-9A-Za-z])`).test(h)
        : h.includes(secret);
    for (const secret of secrets) {
      for (const h of haystacks) expect(found(h, secret)).toBe(false);
    }
    expect(logs.join('\n')).not.toMatch(/\$argon2id\$/);
  });
});
