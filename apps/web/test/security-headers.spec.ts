/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { buildCsp, createNonce, STATIC_SECURITY_HEADERS } from '../src/security/headers';

describe('S5-9 (unit part) security header policy', () => {
  it('a production policy has a nonce and no unsafe-inline or unsafe-eval', () => {
    const nonce = createNonce();
    const csp = buildCsp(nonce, { development: false });
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic/);
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it("only development adds 'unsafe-eval' (needed by next dev), never 'unsafe-inline'", () => {
    const csp = buildCsp(createNonce(), { development: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('nonces are 128-bit, base64 and different every time', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => createNonce()));
    expect(nonces.size).toBe(200);
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('refuses a malformed nonce (no header injection)', () => {
    expect(() => buildCsp("abc'; script-src *", { development: false })).toThrow();
  });

  it('the static header set is complete', () => {
    expect(Object.fromEntries(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]))).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
  });
});

describe('S5-12 (static part) privacy and secrets in web configuration', () => {
  const root = path.join(__dirname, '..', '..', '..');
  it('every script that runs Next.js or Playwright disables Next.js telemetry', () => {
    const scripts = (
      JSON.parse(fs.readFileSync(path.join(root, 'apps', 'web', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const nextScripts = Object.entries(scripts).filter(([, cmd]) =>
      /\b(next|playwright)\b/.test(cmd),
    );
    expect(nextScripts.length).toBeGreaterThanOrEqual(4);
    for (const [, cmd] of nextScripts) expect(cmd).toMatch(/^NEXT_TELEMETRY_DISABLED=1 /);
    expect(fs.readFileSync(path.join(root, 'tooling', 'scripts', 'dev.cjs'), 'utf8')).toMatch(
      /NEXT_TELEMETRY_DISABLED: '1'/,
    );
  });

  it('the web app reads no database settings and exposes no NEXT_PUBLIC variables', () => {
    const files = ['app', 'src', 'proxy.ts', 'next.config.ts'].flatMap(function walk(
      p: string,
    ): string[] {
      const full = path.join(root, 'apps', 'web', p);
      if (fs.statSync(full).isDirectory())
        return fs
          .readdirSync(full)
          .map((e) => walk(path.join(p, e)))
          .flat();
      return [full];
    });
    const offenders = files.filter((f) =>
      /PBE_PG_|NEXT_PUBLIC_|DATABASE_URL/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
