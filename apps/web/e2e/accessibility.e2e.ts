import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startApi, type ApiServer } from './api-server';

/** STAGE-05-PLAN.md S5-7: WCAG 2.1 A and AA rules, 0 violations. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

let api: ApiServer;
test.beforeAll(async () => {
  api = await startApi();
});
test.afterAll(async () => {
  await api.stop();
});

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return {
    violations: result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`),
    passes: result.passes.length,
  };
}

const PAGES: ReadonlyArray<[string, string, (page: Page) => Promise<void>]> = [
  ['/', 'home', async () => undefined],
  [
    '/status',
    'status: available',
    async (page) => {
      await expect(page.getByRole('status')).toContainText('API and database: available');
    },
  ],
  ['/showcase', 'showcase: initial', async () => undefined],
  [
    '/showcase',
    'showcase: form errors',
    async (page) => {
      // Error state of the form: summary, invalid fields and messages.
      await page.getByRole('button', { name: 'Check form' }).click();
      await expect(page.getByRole('alert', { name: 'There is a problem' })).toBeVisible();
    },
  ],
  ['/no-such-page', 'page not found', async () => undefined],
];

for (const [url, label, prepare] of PAGES) {
  test(`S5-7 axe-core WCAG 2.1 A/AA: 0 violations on ${label} (${url})`, async ({ page }) => {
    await page.goto(url);
    await prepare(page);
    const { violations, passes } = await axe(page);
    expect(violations).toEqual([]);
    expect(passes).toBeGreaterThan(10);
  });
}

test('S5-8 keyboard: skip link first, focus moves to main, every control reachable in order with a visible focus indicator', async ({
  page,
}) => {
  await page.goto('/showcase');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();

  // Tab through the whole page from the top and compare with the DOM order of focusable elements.
  const expected = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]',
      ),
    ].map((el) => el.outerHTML.slice(0, 80)),
  );
  await page.goto('/showcase');
  const seen: string[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const visibleRing =
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2) ||
        style.boxShadow !== 'none';
      return { html: el.outerHTML.slice(0, 80), visibleRing };
    });
    expect(info, `tab stop ${i + 1}`).not.toBeNull();
    expect(info!.visibleRing, `visible focus on ${info!.html}`).toBe(true);
    seen.push(info!.html);
  }
  expect(seen).toEqual(expected);
});
