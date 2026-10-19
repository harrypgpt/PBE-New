import { expect, test } from '@playwright/test';
import { startApi, type ApiServer } from './api-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let api: ApiServer;
test.beforeAll(async () => {
  api = await startApi();
});
test.afterAll(async () => {
  await api.stop();
});

test('S5-5 E2E smoke: browser → web → API → PostgreSQL shows "available"', async ({ page }) => {
  const health = page.waitForResponse((r) => r.url().endsWith('/api/v1/health'));
  await page.goto('/status');
  const response = await health;
  expect(response.status()).toBe(200);
  expect(response.headers()['x-request-id']).toMatch(UUID);
  expect(await response.json()).toEqual({ status: 'ok' });
  await expect(page.getByRole('status')).toContainText('API and database: available');
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
});

test('S5-11 same origin: /api/v1 is forwarded to the API; no CORS; Problem Details pass through', async ({
  request,
}) => {
  const requestId = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const viaWeb = await request.get('/api/v1/health', {
    headers: { Origin: 'https://attacker.example', 'X-Request-Id': requestId },
  });
  expect(viaWeb.status()).toBe(200);
  expect(viaWeb.headers()['x-request-id']).toBe(requestId);
  expect(viaWeb.headers()['access-control-allow-origin']).toBeUndefined();

  // A CORS preflight sent straight to the API is not granted either.
  const preflight = await request.fetch('http://127.0.0.1:3001/api/v1/health', {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'GET' },
  });
  expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
  expect(preflight.headers()['access-control-allow-methods']).toBeUndefined();

  const unknown = await request.get('/api/v1/no-such-route');
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['content-type']).toContain('application/problem+json');
  expect(await unknown.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
});

test('S5-19 the limitation statement is visible and non-empty on every page', async ({ page }) => {
  for (const url of ['/', '/status', '/showcase', '/no-such-page']) {
    await page.goto(url);
    const note = page.getByRole('note', { name: 'Limitation statement' });
    await expect(note).toBeVisible();
    expect(((await note.textContent()) ?? '').length).toBeGreaterThan(60);
  }
});

test('S5-18 permission-aware navigation in the browser (demo session on the showcase)', async ({
  page,
}) => {
  await page.goto('/');
  // Stage 5 has no session: no permission-declared entry is shown in the real navigation.
  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link')).toHaveText(['Home', 'System status', 'Sign in']);
  await expect(page.getByRole('banner')).toContainText('Not signed in');

  await page.goto('/showcase');
  await expect(page.getByRole('link', { name: 'Projects (needs project.read)' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Users (needs admin.users)' })).toHaveCount(0);
  await expect(page.getByText('This text must never appear')).toHaveCount(0);
});
