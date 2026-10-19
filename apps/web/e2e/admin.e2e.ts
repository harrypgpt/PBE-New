import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { ROOT, startApi, type ApiServer } from './api-server';

/**
 * Stage 7B browser tests (STAGE-07-PLAN.md S7-14, S7-15), against the production web build, the
 * real API and PostgreSQL (pbe_test). Everyone is fictional; passwords are generated at run time
 * and never written anywhere. One-time links are read from a private outbox folder for this run,
 * the way a person would open the message they received.
 */
test.describe.configure({ mode: 'serial' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BASE = 'http://127.0.0.1:3000';
const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-e2e-outbox-'));
const RUN = randomBytes(3).toString('hex');
const ORG_A = { name: `Fictional Org A ${RUN}`, slug: `org-a-${RUN}` };
const ORG_B = { name: `Fictional Org B ${RUN}`, slug: `org-b-${RUN}` };
const ROLE = 'Fictional reviewers';

interface Person {
  email: string;
  password: string;
  name: string;
  key?: string;
}

const person = (prefix: string, name: string): Person => ({
  email: `e2e.${prefix}.${randomBytes(4).toString('hex')}@example.test`,
  password: `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`,
  name,
});

function cli(args: string[], input?: string): string {
  const run = spawnSync(
    process.execPath,
    ['--env-file=.env', path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js'), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, PBE_PG_DEV_DATABASE: 'pbe_test' },
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    },
  );
  if (run.status !== 0) throw new Error(`user ${args[0]} failed: ${run.stderr}`);
  return `${run.stdout}${run.stderr}`;
}

function createAccount(p: Person): void {
  const out = cli(
    ['create', '--email', p.email, '--name', p.name],
    `${p.password}\n${p.password}\n`,
  );
  if (out.includes(p.password)) throw new Error('password was printed');
}

const totp = (key: string, offsetSeconds = 0) =>
  TOTP.generate({
    secret: Secret.fromBase32(key),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: Date.now() + offsetSeconds * 1000,
  });

async function axeViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.length} (${page.url()})`);
}

/** Newest one-time link for an address, as delivered to the separate channel. */
function oneTimeLink(email: string, purpose: 'activation' | 'password_reset'): string {
  for (const f of fs.readdirSync(OUTBOX).sort().reverse()) {
    const m = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) as {
      to: string;
      purpose: string;
      link: string;
    };
    if (m.to === email && m.purpose === purpose) return new URL(m.link).hash;
  }
  throw new Error(`no ${purpose} message for ${email}`);
}

const csp: string[] = [];
async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text());
  });
  return { context, page };
}

/** Signs in; enrols an authenticator app when the account requires one, or uses it. */
async function signIn(page: Page, p: Person): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/Email address/).fill(p.email);
  await page.getByLabel(/^Password/).fill(p.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  const where = new URL(page.url()).pathname;
  if (where === '/account/mfa') {
    await page.getByRole('button', { name: 'Set up authenticator app' }).click();
    p.key = ((await page.locator('main code').first().textContent()) ?? '').replace(/\s/g, '');
    await page.getByLabel(/Code shown in the app/).fill(totp(p.key));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Authenticator app set up')).toBeVisible();
    await page.getByRole('button', { name: /I have saved my codes/ }).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');
  } else if (where === '/login/mfa') {
    await page.getByLabel(/Code from your authenticator app/).fill(totp(p.key ?? '', 30));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');
  }
}

async function choose(page: Page, orgName: string): Promise<void> {
  await page.goto('/organisation');
  await page.getByRole('button', { name: `Work in ${orgName}` }).click();
  await expect(page.getByRole('banner')).toContainText(`Organisation: ${orgName}`);
}

async function addMember(page: Page, p: Person): Promise<void> {
  await page.goto('/admin/members');
  await page.getByLabel(/^Email address/).fill(p.email);
  await page.getByLabel(/^Name/).fill(p.name);
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByText('Member added')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Members of this organisation' })).toContainText(
    p.email,
  );
}

async function giveRole(page: Page, p: Person, role: string): Promise<void> {
  await page.getByRole('button', { name: `Manage ${p.name}` }).click();
  const panel = page.getByRole('region', { name: `Manage ${p.name}` });
  await panel.getByRole('checkbox', { name: role, exact: true }).check();
  await panel.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByText('Roles saved')).toBeVisible();
}

const superAdmin = person('superadmin', 'Fictional Super Admin');
const adminA = person('admin-a', 'Fictional Admin A');
const adminB = person('admin-b', 'Fictional Admin B');
const memberA = person('member-a', 'Fictional Member A');
const both = person('both', 'Fictional Two-Org Member');
let api: ApiServer;
let sa: Page;
let a: Page;
let b: Page;
const contexts: BrowserContext[] = [];

test.beforeAll(async ({ browser }) => {
  api = await startApi({ PBE_TOKEN_OUTBOX_DIR: OUTBOX });
  createAccount(superAdmin);
  createAccount(memberA);
  createAccount(both);
  cli(['grant-platform-role', '--email', superAdmin.email]);
  for (const target of ['sa', 'a', 'b'] as const) {
    const { context, page } = await newPage(browser);
    contexts.push(context);
    if (target === 'sa') sa = page;
    else if (target === 'a') a = page;
    else b = page;
  }
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await api?.stop();
  fs.rmSync(OUTBOX, { recursive: true, force: true });
});

test('S7-14 the Super Admin creates two organisations, each with its first administrator', async () => {
  await signIn(sa, superAdmin);
  await sa.goto('/platform/organisations');
  // Error state first (S7-15): the empty form lists every problem.
  await sa.getByRole('button', { name: 'Create organisation' }).click();
  await expect(sa.getByRole('alert').filter({ hasText: 'There is a problem' })).toBeVisible();
  expect(await axeViolations(sa)).toEqual([]);
  for (const [org, admin] of [
    [ORG_A, adminA],
    [ORG_B, adminB],
  ] as const) {
    await sa.getByLabel(/^Organisation name/).fill(org.name);
    await sa.getByLabel(/^Short name/).fill(org.slug);
    await sa.getByLabel(/^First administrator's email address/).fill(admin.email);
    await sa.getByLabel(/^First administrator's name/).fill(admin.name);
    await sa.getByRole('button', { name: 'Create organisation' }).click();
    await expect(sa.getByText('Organisation created')).toBeVisible();
    await expect(sa.getByRole('table', { name: 'All organisations' })).toContainText(org.name);
  }
  expect(await axeViolations(sa)).toEqual([]);
  // The Super Admin has no organisation data: no membership, no organisation pages.
  await sa.goto('/organisation');
  await expect(sa.getByText('You are not a member of any organisation yet.')).toBeVisible();
  expect(await axeViolations(sa)).toEqual([]);
  await sa.goto('/admin/members');
  await expect(sa.getByText('Choose an organisation first')).toBeVisible();
});

test('S7-14 first administrators set their own password with the one-time link, then choose their organisation', async () => {
  for (const [page, admin, org] of [
    [a, adminA, ORG_A],
    [b, adminB, ORG_B],
  ] as const) {
    await page.goto(`/account/set-password${oneTimeLink(admin.email, 'activation')}`);
    await expect(page.getByLabel(/^New password/)).toBeVisible();
    expect(page.url()).not.toContain('token='); // removed from the address bar at once
    expect(await axeViolations(page)).toEqual([]);
    await page.getByLabel(/^New password/).fill(admin.password);
    await page.getByLabel(/^Repeat the new password/).fill(admin.password);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password set')).toBeVisible();
    await signIn(page, admin); // administrators must set up an authenticator app
    await choose(page, org.name);
    expect(await axeViolations(page)).toEqual([]);
  }
  // A used link cannot be used again.
  await a.goto(`/account/set-password${oneTimeLink(adminA.email, 'activation')}`);
  await a.getByLabel(/^New password/).fill(`${adminA.password}-again`);
  await a.getByLabel(/^Repeat the new password/).fill(`${adminA.password}-again`);
  await a.getByRole('button', { name: 'Set password' }).click();
  await expect(a.getByText('Password not set')).toBeVisible();
});

test('S7-14 each administrator creates a role and adds members', async () => {
  for (const [page, members] of [
    [a, [memberA, both]],
    [b, [both]],
  ] as const) {
    await page.goto('/admin/roles');
    await page.getByLabel(/^Role name/).fill(ROLE);
    await page.locator('input[name="new-role-permissions"][value="tenant.members.read"]').check();
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByText('Role created')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    for (const m of members) {
      await addMember(page, m);
      await giveRole(page, m, ROLE);
    }
    // S7-15 with a member panel open, and on departments and settings.
    await page.getByRole('button', { name: `Manage ${members[0].name}` }).click();
    expect(await axeViolations(page)).toEqual([]);
    for (const url of ['/admin/departments', '/admin/settings']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    }
  }
});

test('S7-14 a member sees only their own organisation', async ({ browser }) => {
  const { context, page } = await newPage(browser);
  contexts.push(context);
  await signIn(page, memberA);
  await page.goto('/organisation');
  await expect(page.getByRole('button', { name: `Work in ${ORG_A.name}` })).toBeVisible();
  await expect(page.getByText(ORG_B.name)).toHaveCount(0);
  await choose(page, ORG_A.name);
  await page.goto('/admin/members');
  const table = page.getByRole('table', { name: 'Members of this organisation' });
  await expect(table).toContainText(memberA.email);
  await expect(table).toContainText(adminA.email);
  await expect(table).not.toContainText(adminB.email);
  // Read-only role: no management controls; roles page is not available.
  await expect(page.getByRole('heading', { name: 'Add a member' })).toHaveCount(0);
  await page.goto('/admin/roles');
  await expect(page.getByText('You do not have access to this page')).toBeVisible();

  // Bypassing the screens: the BACKEND refuses too (not only hidden in the UI).
  const orgs = (await (await sa.request.get('/api/v1/platform/tenants')).json()) as {
    tenants: Array<{ id: string; displayName: string }>;
  };
  const orgB = orgs.tenants.find((t) => t.displayName === ORG_B.name)!;
  const sneak = await page.request.post('/api/v1/session/tenant', {
    data: { tenantId: orgB.id },
    headers: { origin: BASE },
  });
  expect(sneak.status()).toBe(404); // same answer as an unknown organisation
  const roles = await page.request.get('/api/v1/tenant/roles');
  expect(roles.status()).toBe(403); // no tenant.roles.read
  const add = await page.request.post('/api/v1/tenant/members', {
    data: { email: 'intruder@example.test', displayName: 'Intruder' },
    headers: { origin: BASE },
  });
  expect(add.status()).toBe(403); // no tenant.members.manage
});

test('S7-14 the organisation switcher works for a member of both organisations', async ({
  browser,
}) => {
  const { context, page } = await newPage(browser);
  contexts.push(context);
  await signIn(page, both);
  await choose(page, ORG_A.name);
  await page.goto('/admin/members');
  await expect(page.getByRole('table', { name: 'Members of this organisation' })).toContainText(
    memberA.email,
  );
  await choose(page, ORG_B.name);
  await page.goto('/admin/members');
  const table = page.getByRole('table', { name: 'Members of this organisation' });
  await expect(table).toContainText(adminB.email);
  await expect(table).not.toContainText(memberA.email);
  await page.goto('/organisation');
  await page.getByRole('button', { name: 'Leave this organisation' }).click();
  await expect(
    page.getByText('You are not working in an organisation at the moment.'),
  ).toBeVisible();
  await expect(page.getByRole('banner')).not.toContainText('Organisation:');
});

test('S7-7 break-glass in the browser: request, approval, read-only access with a warning, end', async () => {
  await sa.goto('/platform/break-glass');
  await sa.getByLabel(/^Organisation/).selectOption({ label: ORG_A.name });
  await sa
    .getByLabel(/^Purpose/)
    .fill('Fictional support case: investigate a reported display error.');
  await sa.getByRole('button', { name: 'Send request' }).click();
  await expect(sa.getByText('Request sent')).toBeVisible();
  expect(await axeViolations(sa)).toEqual([]);

  await a.goto('/admin/settings');
  await a.getByRole('button', { name: 'Approve request' }).click();
  await a.getByRole('button', { name: 'Yes, approve' }).click();
  await expect(a.getByText('Request approved')).toBeVisible();

  await sa.goto('/platform/break-glass');
  await sa.getByRole('button', { name: `Start read-only access to ${ORG_A.name}` }).click();
  await sa.waitForURL(/\/organisation$/);
  await expect(sa.getByText('Break-glass access: read-only')).toBeVisible();
  await sa.goto('/admin/members');
  await expect(sa.getByRole('table', { name: 'Members of this organisation' })).toContainText(
    adminA.email,
  );
  await expect(sa.getByRole('heading', { name: 'Add a member' })).toHaveCount(0); // read-only
  // Bypassing the screens: the BACKEND refuses writes under break-glass.
  const write = await sa.request.post('/api/v1/tenant/departments', {
    data: { name: 'Should never exist' },
    headers: { origin: BASE },
  });
  expect(write.status()).toBe(403);
  expect(((await write.json()) as { detail?: string }).detail).toBe(
    'Break-glass access is read-only.',
  );
  expect(await axeViolations(sa)).toEqual([]);
  await sa.goto('/organisation');
  await sa.getByRole('button', { name: 'End break-glass access' }).click();
  await expect(sa.getByText('Break-glass access: read-only')).toHaveCount(0);
});

test('S7-15 keyboard only: add a member and give a role without a mouse', async () => {
  const extra = person('keyboard', 'Fictional Keyboard Member');
  createAccount(extra);
  await a.goto('/admin/members');
  await expect(a.locator('[aria-busy="true"]')).toHaveCount(0);
  const tabTo = async (matches: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 120; i += 1) {
      if (await matches()) return;
      await a.keyboard.press('Tab');
    }
    throw new Error(`could not reach ${what} with the Tab key`);
  };
  const focusedId = () => a.evaluate(() => document.activeElement?.id ?? '');
  const focusedText = () => a.evaluate(() => document.activeElement?.textContent ?? '');
  await tabTo(async () => (await focusedId()) === 'member-email', 'the email field');
  await a.keyboard.type(extra.email);
  await a.keyboard.press('Tab');
  await a.keyboard.type(extra.name);
  await a.keyboard.press('Enter');
  await expect(a.getByText('Member added')).toBeVisible();
  await tabTo(async () => (await focusedText()) === `Manage ${extra.name}`, 'the manage button');
  await a.keyboard.press('Enter');
  await expect(a.getByRole('heading', { name: `Manage ${extra.name}` })).toBeFocused();
  await tabTo(
    async () =>
      a.evaluate(
        (role) =>
          document.activeElement instanceof HTMLInputElement &&
          document.activeElement.labels?.[0]?.textContent === role,
        ROLE,
      ),
    'the role checkbox',
  );
  await a.keyboard.press('Space');
  await tabTo(async () => (await focusedText()) === 'Save roles', 'the save button');
  await a.keyboard.press('Enter');
  await expect(a.getByText('Roles saved')).toBeVisible();
  await expect(a.getByRole('table', { name: 'Members of this organisation' })).toContainText(ROLE);
});

test('one-time tokens never appear in the API logs', () => {
  const tokens = fs
    .readdirSync(OUTBOX)
    .map(
      (f) => (JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) as { token: string }).token,
    );
  expect(tokens.length).toBeGreaterThanOrEqual(2); // both first administrators' links
  const logs = api.logs.join('');
  expect(logs.length).toBeGreaterThan(0);
  for (const t of tokens) expect(logs).not.toContain(t);
});

test('S7-15 no Content Security Policy violations on any administration page', () => {
  expect(csp).toEqual([]);
});
