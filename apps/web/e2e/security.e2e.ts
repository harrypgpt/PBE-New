import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ROOT } from './api-server';

const STATIC_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

function nonceOf(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  if (!match) throw new Error('no nonce in CSP');
  return match[1]!;
}

async function firstStaticAsset(page: Page): Promise<string> {
  await page.goto('/');
  const src = await page.locator('script[src^="/_next/static/"]').first().getAttribute('src');
  if (!src) throw new Error('no static script found');
  return src;
}

test('S5-9 security headers on every web response from the production build', async ({
  page,
  request,
}) => {
  const asset = await firstStaticAsset(page);
  const urls = ['/', '/status', '/showcase', '/no-such-page', asset];
  for (const url of urls) {
    const res = await request.get(url);
    const headers = res.headers();
    for (const [name, value] of Object.entries(STATIC_HEADERS)) {
      expect(headers[name], `${name} on ${url}`).toBe(value);
    }
    expect(headers['x-powered-by'], `x-powered-by on ${url}`).toBeUndefined();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, `CSP on ${url}`).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic/);
  }
  expect((await request.get('/no-such-page')).status()).toBe(404);

  // A new nonce for every request, and the page's own scripts carry it.
  const a = await request.get('/');
  const b = await request.get('/');
  const nonceA = nonceOf(a.headers()['content-security-policy']!);
  expect(nonceA).not.toBe(nonceOf(b.headers()['content-security-policy']!));
  expect(await a.text()).toContain(`nonce="${nonceA}"`);
});

test('S5-10 the CSP is enforced: no violations on PBE pages; an injected inline script is blocked', async ({
  page,
}) => {
  const consoleCsp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  const violations = () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

  for (const url of ['/', '/status', '/showcase', '/no-such-page']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    expect(await violations(), `violations on ${url}`).toEqual([]);
  }
  // The showcase form is interactive: React hydrated despite the strict policy.
  await page.goto('/showcase');
  await page.getByRole('button', { name: 'Check form' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toBeFocused();
  expect(consoleCsp).toEqual([]);

  // Simulated injection 1: a script added to the page by other page code must not run.
  const ran = await page.evaluate(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true;';
    document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 100));
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
  expect((await violations()).some((v) => v.startsWith('script-src'))).toBe(true);
});

test('S5-10 the CSP blocks script injected into the page HTML (simulated stored/reflected XSS)', async ({
  page,
}) => {
  // The real /status response, with its real CSP header, plus attacker markup in the HTML.
  const attack =
    '<script>window.__xss1 = true</script>' +
    '<img src="/x.png" onerror="window.__xss2 = true">' +
    '<script src="https://attacker.example/x.js"></script>';
  await page.route('**/status', async (route) => {
    const real = await route.fetch();
    const html = (await real.text()).replace('<main', `${attack}<main`);
    await route.fulfill({ response: real, body: html });
  });
  const blocked: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });
  await page.goto('/status');
  await page.waitForLoadState('networkidle');
  const ran = await page.evaluate(() => {
    const w = window as unknown as { __xss1?: boolean; __xss2?: boolean };
    return { inline: w.__xss1 === true, handler: w.__xss2 === true };
  });
  expect(ran).toEqual({ inline: false, handler: false });
  expect(blocked.length).toBeGreaterThanOrEqual(2);
  // The real page still works under the same policy.
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'API and database: unavailable',
  );
});

test('S5-12 no secrets in the browser: bundle and HTML hold no database settings or passwords', async ({
  request,
}) => {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const secrets = [...env.matchAll(/^\s*([A-Z0-9_]*PASSWORD[A-Z0-9_]*)\s*=\s*(.+)\s*$/gm)]
    .map((m) => m[2]!.replace(/^['"]|['"]$/g, ''))
    .filter((v) => v.length >= 8);
  expect(secrets.length).toBeGreaterThan(0);

  const staticDir = path.join(__dirname, '..', '.next', 'static');
  const files = fs
    .readdirSync(staticDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);

  const bodies = files.map((f) => fs.readFileSync(f, 'utf8'));
  for (const url of ['/', '/status', '/showcase'])
    bodies.push(await (await request.get(url)).text());
  for (const body of bodies) {
    expect(body).not.toMatch(/PBE_PG_|DATABASE_URL|postgres(ql)?:\/\//);
    for (const secret of secrets) expect(body.includes(secret)).toBe(false);
  }
});
