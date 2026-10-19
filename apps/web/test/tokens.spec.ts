/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

/**
 * S5-17 design tokens (baseline B5-2, ADR-024): visual values live only in tokens.css, so the
 * TechyPharma-inspired values can replace the placeholders without touching components.
 */
const WEB = path.join(__dirname, '..');
const TOKENS = path.join(WEB, 'src', 'ui', 'tokens.css');

function filesUnder(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });
}

const STYLE_FILES = [
  ...filesUnder(path.join(WEB, 'src'), /\.css$/),
  ...filesUnder(path.join(WEB, 'app'), /\.css$/),
];
const COMPONENT_FILES = [
  ...filesUnder(path.join(WEB, 'src'), /\.tsx$/),
  ...filesUnder(path.join(WEB, 'app'), /\.tsx$/),
];

const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![-\w])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|navy|silver)(?![-\w])/;

function tokenValues(): Map<string, string> {
  const css = fs.readFileSync(TOKENS, 'utf8');
  return new Map(
    [...css.matchAll(/(--pbe-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('S5-17 design tokens', () => {
  it('tokens.css is clearly marked as placeholder values pending the design system (D-1)', () => {
    const css = fs.readFileSync(TOKENS, 'utf8');
    expect(css).toMatch(/PLACEHOLDER VALUES/);
    expect(css).toMatch(/TechyPharma-inspired design system/);
    expect(tokenValues().get('--pbe-tokens-status')).toBe("'placeholder'");
  });

  it('no stylesheet other than tokens.css contains a colour value', () => {
    const offenders = STYLE_FILES.filter((f) => f !== TOKENS)
      .flatMap((f) =>
        fs
          .readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .map((line, i) => ({ f, line, i }))
          .filter(({ line }) => COLOUR_LITERAL.test(line)),
      )
      .map(({ f, i }) => `${path.relative(WEB, f)}:${i + 1}`);
    expect(offenders).toEqual([]);
    expect(STYLE_FILES.length).toBeGreaterThan(4);
  });

  it('every var(--pbe-…) used in styles is defined in tokens.css', () => {
    const defined = tokenValues();
    const used = new Set(
      STYLE_FILES.flatMap((f) =>
        [...fs.readFileSync(f, 'utf8').matchAll(/var\((--pbe-[a-z0-9-]+)\)/g)].map((m) => m[1]!),
      ),
    );
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('components have no inline style attributes (tokens only; also required by the CSP)', () => {
    const offenders = COMPONENT_FILES.filter((f) => /\bstyle=\{/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(WEB, f))).toEqual([]);
  });

  it.each([
    ['--pbe-color-text', '--pbe-color-surface'],
    ['--pbe-color-text-muted', '--pbe-color-surface'],
    ['--pbe-color-text-muted', '--pbe-color-surface-subtle'],
    ['--pbe-color-link', '--pbe-color-surface'],
    ['--pbe-color-brand-contrast', '--pbe-color-brand'],
    ['--pbe-color-brand', '--pbe-color-surface'],
    ['--pbe-color-text', '--pbe-color-warning-surface'],
    ['--pbe-color-neutral-text', '--pbe-color-neutral-surface'],
    ['--pbe-color-info-text', '--pbe-color-info-surface'],
    ['--pbe-color-success-text', '--pbe-color-success-surface'],
    ['--pbe-color-warning-text', '--pbe-color-warning-surface'],
    ['--pbe-color-error-text', '--pbe-color-error-surface'],
    ['--pbe-color-error-text', '--pbe-color-surface'],
  ])('text %s on %s meets WCAG AA (4.5:1)', (fg, bg) => {
    const tokens = tokenValues();
    expect(contrast(tokens.get(fg)!, tokens.get(bg)!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['--pbe-color-border', '--pbe-color-surface'],
    ['--pbe-color-focus', '--pbe-color-surface'],
  ])('control boundary %s on %s meets WCAG non-text contrast (3:1)', (fg, bg) => {
    const tokens = tokenValues();
    expect(contrast(tokens.get(fg)!, tokens.get(bg)!)).toBeGreaterThanOrEqual(3);
  });
});
