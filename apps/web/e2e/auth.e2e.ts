import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { ROOT, startApi, type ApiServer } from './api-server';

/**
 * S6-19 and S6-20: sign-in, MFA, sign-out and password change in a real browser, against the
 * production web build, the real API and PostgreSQL (pbe_test). Users are fictional and created
 * with the operator command; passwords are generated at run time and never written anywhere.
 */
test.describe.configure({ mode: 'serial' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
let api: ApiServer;

interface User {
  email: string;
  password: string;
  name: string;
}

function createUser(): User {
  const user = {
    email: `e2e.${randomBytes(4).toString('hex')}@example.test`,
    password: `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`,
    name: 'Fictional E2E User',
  };
  const run = spawnSync(
    process.execPath,
    [
      '--env-file=.env',
      path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js'),
      'create',
      '--email',
      user.email,
      '--name',
      user.name,
    ],
    {
      cwd: ROOT,
      input: `${user.password}\n${user.password}\n`,
      env: { ...process.env, PBE_PG_DEV_DATABASE: 'pbe_test' },
      encoding: 'utf8',
    },
  );
  if (run.status !== 0) throw new Error(`user create failed: ${run.stderr}`);
  if (`${run.stdout}${run.stderr}`.includes(user.password)) throw new Error('password was printed');
  return user;
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
  return result.violations.map((v) => `${v.id}: ${v.nodes.length}`);
}

async function signIn(
  page: Page,
  user: { email: string; password: string },
  options: { expectSuccess?: boolean } = {},
) {
  await page.goto('/login');
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the sign-in answer before doing anything else (the page leaves /login on success).
  if (options.expectSuccess !== false) await page.waitForURL((url) => url.pathname !== '/login');
}

let alice: User;
let bob: User;
let manualKey = '';
let recoveryCodes: string[] = [];

test.beforeAll(async () => {
  api = await startApi();
  alice = createUser();
  bob = createUser();
});
test.afterAll(async () => {
  await api.stop();
});

test('S6-19 signed-out users are sent to sign-in; sign-in shows the user; cookie flags are strict', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('banner')).toContainText('Not signed in');

  await signIn(page, alice);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('banner')).toContainText(alice.name);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account security' }),
  ).toBeVisible();

  const cookie = (await context.cookies()).find((c) => c.name === '__Host-pbe_session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  // Page scripts cannot read the session cookie.
  expect(await page.evaluate(() => document.cookie)).not.toContain('pbe_session');
});

test('S6-19 MFA enrolment: QR and key shown, confirmed with a real code, 10 recovery codes', async ({
  page,
}) => {
  await signIn(page, alice);
  await page.goto('/account/mfa');
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  manualKey = ((await page.locator('main code').first().textContent()) ?? '').replace(/\s/g, '');
  expect(manualKey).toMatch(/^[A-Z2-7]{32}$/);
  // The key never appears in the address bar.
  expect(page.url()).not.toContain(manualKey);
  await page.getByLabel(/Code shown in the app/).fill(totp(manualKey));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Authenticator app set up')).toBeVisible();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).locator('code');
  await expect(codes).toHaveCount(10);
  recoveryCodes = await codes.allTextContents();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: /I have saved my codes/ }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('S6-19 sign out, then sign in again with the authenticator code', async ({ page }) => {
  await signIn(page, alice);
  // Already enrolled: the sign-in continues on the verification page.
  await expect(page).toHaveURL(/\/login\/mfa$/);
  await expect(page.getByRole('banner')).toContainText('Not signed in');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByLabel(/Code from your authenticator app/).fill(totp(manualKey, 30));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('banner')).toContainText(alice.name);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login$/);
});

test('S6-19 change password, then sign in with the new password and a recovery code', async ({
  page,
}) => {
  await signIn(page, alice);
  await page.getByLabel(/Recovery code|Code from your authenticator app/).waitFor();
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel(/Recovery code/).fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/$/);

  const next = `${randomBytes(12).toString('base64url')}-${randomBytes(6).toString('hex')}`;
  await page.goto('/account/password');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByLabel(/Current password/).fill(alice.password);
  await page.getByLabel(/^New password/).fill(next);
  await page.getByLabel(/Repeat the new password/).fill(next);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();
  // This browser received a fresh session and is still signed in.
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
  alice = { ...alice, password: next };

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, alice);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel(/Recovery code/).fill(recoveryCodes[1]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('banner')).toContainText(alice.name);
});

test('S6-19 a wrong password shows the generic message; a used recovery code is refused', async ({
  page,
}) => {
  await signIn(page, { email: bob.email, password: `${bob.password}x` }, { expectSuccess: false });
  const alert = page.locator('main').getByRole('alert');
  await expect(alert).toContainText('The email address or password is not correct.');
  expect(await axeViolations(page)).toEqual([]);

  await signIn(page, alice);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel(/Recovery code/).fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('already been used');
});

test('S6-20 accessibility: sign-in (empty and error states) and signed-in pages have 0 violations', async ({
  page,
}) => {
  await page.goto('/login');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toBeFocused();
  expect(await axeViolations(page)).toEqual([]);

  await signIn(page, bob);
  await expect(page.getByRole('banner')).toContainText(bob.name);
  for (const url of ['/account', '/account/password', '/account/mfa']) {
    await page.goto(url);
    expect(await axeViolations(page), url).toEqual([]);
  }
});

test('S6-20 keyboard only: sign in without a mouse', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/Email address/).focus();
  await page.keyboard.type(bob.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Password/)).toBeFocused();
  await page.keyboard.type(bob.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('banner')).toContainText(bob.name);
});

test('S6-19 no CSP violations on the sign-in pages', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  for (const url of ['/login', '/login/mfa', '/account/mfa']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
  }
  await signIn(page, bob);
  await page.goto('/account/mfa');
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  expect(violations).toEqual([]);
});
