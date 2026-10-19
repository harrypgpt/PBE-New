import { expect, test } from '@playwright/test';

/** S5-20: phone width (360 px) to desktop (1280 px), no sideways page scroll or clipped controls. */
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 1280, height: 800 },
];

for (const viewport of VIEWPORTS) {
  for (const url of ['/', '/status', '/showcase']) {
    test(`S5-20 ${url} at ${viewport.width} px: no horizontal page scroll, no clipped controls`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const result = await page.evaluate(() => {
        const doc = document.documentElement;
        const width = doc.clientWidth;
        const clipped = [
          ...document.querySelectorAll<HTMLElement>('a, button, input, select, label, h1, h2, p'),
        ]
          // Content inside a table's own scroll region may extend; the region itself must fit.
          .filter((el) => !el.closest('[role="region"]'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < -1 || r.right > width + 1);
          })
          .map((el) => el.outerHTML.slice(0, 60));
        const regions = [...document.querySelectorAll<HTMLElement>('[role="region"]')].filter(
          (el) => el.getBoundingClientRect().right > width + 1,
        ).length;
        return { scrollWidth: doc.scrollWidth, width, clipped, regions };
      });
      expect(result.scrollWidth).toBeLessThanOrEqual(result.width);
      expect(result.clipped).toEqual([]);
      expect(result.regions).toBe(0);
    });
  }
}
