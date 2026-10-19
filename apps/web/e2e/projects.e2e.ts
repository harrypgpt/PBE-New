import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { startThrowawayStack, type ThrowawayStack } from './throwaway-stack';

/**
 * Stage 8 browser tests (STAGE-08-PLAN.md S8-9, S8-10) against the production web build and the
 * real API, connected to a PRIVATE throw-away PostgreSQL 18 server with migration 0006
 * (throwaway-stack.ts); pbe_test and pbe_dev are not used. Everyone and everything is fictional.
 */
test.describe.configure({ mode: 'serial' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BASE = 'http://127.0.0.1:3000';
const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-e2e-s8-outbox-'));
const RUN = randomBytes(3).toString('hex');
const ORG = { name: `Fictional Org P ${RUN}`, slug: `org-p-${RUN}` };

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

const totp = (key: string, offsetSeconds = 0) =>
  TOTP.generate({
    secret: Secret.fromBase32(key),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: Date.now() + offsetSeconds * 1000,
  });

async function axeViolations(page: Page): Promise<string[]> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.length} (${page.url()})`);
}

function activationHash(email: string): string {
  for (const f of fs.readdirSync(OUTBOX).sort().reverse()) {
    const m = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')) as {
      to: string;
      purpose: string;
      link: string;
    };
    if (m.to === email && m.purpose === 'activation') return new URL(m.link).hash;
  }
  throw new Error(`no activation message for ${email}`);
}

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

const superAdmin = person('s8-superadmin', 'Fictional Super Admin');
const lead = person('s8-admin', 'Fictional Project Lead');
let stack: ThrowawayStack;
let context: BrowserContext;
let saContext: BrowserContext;
let page: Page;
let sa: Page;
let projectUrl = '';

test.beforeAll(async ({ browser }) => {
  stack = await startThrowawayStack(OUTBOX);
  stack.cli(
    ['create', '--email', superAdmin.email, '--name', superAdmin.name],
    `${superAdmin.password}\n${superAdmin.password}\n`,
  );
  stack.cli(['grant-platform-role', '--email', superAdmin.email]);
  saContext = await browser.newContext({ baseURL: BASE });
  context = await browser.newContext({ baseURL: BASE });
  sa = await saContext.newPage();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await saContext?.close();
  await stack?.stop();
  fs.rmSync(OUTBOX, { recursive: true, force: true });
});

test('set-up: an organisation and its first administrator (who holds the project permissions)', async () => {
  await signIn(sa, superAdmin);
  await sa.goto('/platform/organisations');
  await sa.getByLabel(/^Organisation name/).fill(ORG.name);
  await sa.getByLabel(/^Short name/).fill(ORG.slug);
  await sa.getByLabel(/^First administrator's email address/).fill(lead.email);
  await sa.getByLabel(/^First administrator's name/).fill(lead.name);
  await sa.getByRole('button', { name: 'Create organisation' }).click();
  await expect(sa.getByText('Organisation created')).toBeVisible();

  await page.goto(`/account/set-password${activationHash(lead.email)}`);
  await page.getByLabel(/^New password/).fill(lead.password);
  await page.getByLabel(/^Repeat the new password/).fill(lead.password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password set')).toBeVisible();
  await signIn(page, lead);
  await page.goto('/organisation');
  await page.getByRole('button', { name: `Work in ${ORG.name}` }).click();
  await expect(page.getByRole('banner')).toContainText(`Organisation: ${ORG.name}`);
});

test('S8-9 dashboard: identity, organisation, honest placeholders, quick action; accessible', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(`Welcome, ${lead.name}.`)).toBeVisible();
  await expect(page.getByText(`You are working in ${ORG.name}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending tasks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent runs' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recently changed active projects' })).toContainText(
    'No projects yet.',
  );
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('S8-10 keyboard only: create a supported project with the wizard; the scope check is live', async () => {
  await page.goto('/projects/new');
  // The empty form lists every problem.
  await page.getByRole('button', { name: 'Continue to review' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'There is a problem' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel(/^Project name/).focus();
  await page.keyboard.type('Fictional IR tablet project');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Fictionalol');
  await page.keyboard.press('Tab');
  await page.keyboard.type('50');
  await page.keyboard.press('Tab'); // unit: mg (default)
  await page.keyboard.press('Tab');
  await page.keyboard.type('Tablet');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Oral');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Immediate');
  await expect(page.getByLabel(/^Dosage form/)).toHaveValue('tablet');
  await expect(page.getByLabel(/^Route/)).toHaveValue('oral');
  await expect(page.getByLabel(/^Release type/)).toHaveValue('immediate_release');
  await expect(
    page.getByRole('region', { name: 'Supported scope' }).getByText('Supported', { exact: true }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // Tab on to the button (through characteristics and departments) and press it.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    if ((await page.evaluate(() => document.activeElement?.textContent)) === 'Continue to review')
      break;
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Review and create' })).toBeFocused();
  await expect(page.getByText('50 mg')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press('Tab');
  for (let i = 0; i < 10; i += 1) {
    if ((await page.evaluate(() => document.activeElement?.textContent)) === 'Create project')
      break;
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}\?created=1$/);
  projectUrl = new URL(page.url()).pathname;
  await expect(page.getByText('Project created')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Fictional IR tablet project' }),
  ).toBeVisible();
  await expect(page.getByText('Supported', { exact: true })).toBeVisible();
});

test('S8-9 add two scenarios: F001 and F002', async () => {
  await page.goto(projectUrl);
  for (const description of ['Fictional reference formulation', 'Fictional test formulation']) {
    await page
      .getByLabel(/^Description/)
      .last()
      .fill(description);
    await page.getByRole('button', { name: 'Add scenario' }).click();
    await expect(page.getByText(/^F00[12] was added\.$/)).toBeVisible();
  }
  const table = page.getByRole('table', { name: 'Scenarios of Fictional IR tablet project' });
  await expect(table).toContainText('F001');
  await expect(table).toContainText('Fictional reference formulation');
  await expect(table).toContainText('F002');
  await expect(table).toContainText('Fictional test formulation');
  expect(await axeViolations(page)).toEqual([]);
});

test('S8-9 the dashboard shows the project with its scenarios and scope', async () => {
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Recently changed active projects' });
  const row = table.getByRole('row').filter({ hasText: 'Fictional IR tablet project' });
  await expect(row).toContainText('Supported');
  await expect(row.getByRole('cell').nth(4)).toHaveText('2');
});

test('S8-9 an unsupported product shows the reason in the wizard and on its page', async () => {
  await page.goto('/projects/new');
  await page.getByLabel(/^Project name/).fill('Fictional nasal spray project');
  await page.getByLabel(/^Molecule/).fill('Fictionalol');
  await page.getByLabel(/^Strength( \*)?$/).fill('10');
  await page.getByLabel(/^Dosage form/).selectOption('tablet');
  await page.getByLabel(/^Route/).selectOption('nasal');
  await page.getByLabel(/^Release type/).selectOption('extended_release');
  const live = page.getByRole('region', { name: 'Supported scope' });
  await expect(live.getByText('Unsupported scope')).toBeVisible();
  await expect(live).toContainText('Nasal');
  await expect(live).toContainText('modified release');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue to review' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  await expect(page.getByText('Unsupported scope')).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Why this is outside the supported scope' })
      .getByRole('listitem'),
  ).toHaveCount(2);
  await page.goto('/projects');
  await expect(
    page.getByRole('table', { name: 'Projects you can see in this organisation' }),
  ).toContainText('Unsupported scope');
  expect(await axeViolations(page)).toEqual([]);
});

test('D8-8 archive: the project becomes read-only in the screen', async () => {
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Archive Fictional IR tablet project' }).click();
  await page.getByRole('button', { name: 'Yes, archive project' }).click();
  await expect(page.getByText('Project archived')).toBeVisible();
  await expect(page.getByText('Archived (read-only)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add scenario' })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test('backend bypass: direct API requests the screens never make are refused', async () => {
  // The Super Admin has no organisation data (no break-glass): 403.
  expect((await sa.request.get('/api/v1/projects')).status()).toBe(403);
  // The archived project refuses a scenario sent directly (409), whatever the screen shows.
  const id = projectUrl.split('/').pop();
  const r = await page.request.post(`/api/v1/projects/${id}/scenarios`, {
    data: {},
    headers: { origin: BASE },
  });
  expect(r.status()).toBe(409);
  // A scope status cannot be supplied by the client.
  const forged = await page.request.post('/api/v1/projects', {
    data: {
      name: 'Forged',
      molecule: 'Fictionalol',
      strength: { value: 1, unit: 'mg' },
      dosageForm: 'tablet',
      route: 'nasal',
      releaseType: 'immediate_release',
      scopeStatus: 'supported',
    },
    headers: { origin: BASE },
  });
  expect(forged.status()).toBe(400);
});

test('session tokens and passwords never appear in the API logs', async () => {
  const logs = stack.logs.join('');
  expect(logs.length).toBeGreaterThan(0);
  for (const c of [...(await context.cookies()), ...(await saContext.cookies())]) {
    if (c.value.length > 10) expect(logs).not.toContain(c.value);
  }
  for (const p of [superAdmin, lead]) expect(logs).not.toContain(p.password);
});
