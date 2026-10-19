import { expect, test } from '@playwright/test';

/**
 * S5-6 failure path. No API is running during this file (the other files stop theirs in
 * afterAll), so the website's forwarding to 127.0.0.1:3001 really fails.
 */
const LEAKS =
  /127\.0\.0\.1|localhost|3001|5432|ECONNREFUSED|Internal Server Error|stack|SELECT|pbe_/i;

test('S5-6 API not running (real): /status shows "unavailable" in plain language, no internals', async ({
  page,
  request,
}) => {
  const direct = await fetch('http://127.0.0.1:3001/api/v1/health').then(
    () => 'listening',
    () => 'not listening',
  );
  expect(direct).toBe('not listening');

  const forwarded = await request.get('/api/v1/health');
  expect(forwarded.status()).toBeGreaterThanOrEqual(500);

  await page.goto('/status');
  const alert = page.locator('main').getByRole('alert');
  await expect(alert).toContainText('API and database: unavailable');
  const text = (await page.locator('main').textContent()) ?? '';
  expect(text).not.toMatch(LEAKS);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
});

test('S5-6 API reports 503 Problem Details (simulated in the browser): "unavailable" with the reference only', async ({
  page,
}) => {
  const requestId = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
  await page.route('**/api/v1/health', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      headers: { 'x-request-id': requestId },
      body: JSON.stringify({
        type: 'https://pbe.local/problems/service-unavailable',
        title: 'Service unavailable',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        requestId,
      }),
    }),
  );
  await page.goto('/status');
  const alert = page.locator('main').getByRole('alert');
  await expect(alert).toContainText('API and database: unavailable');
  await expect(alert).toContainText(requestId);
  expect((await page.locator('main').textContent()) ?? '').not.toMatch(LEAKS);
});
