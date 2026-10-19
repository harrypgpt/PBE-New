import { JsonLogger, redact } from '../src/common/logger';

// Fake values assembled at run time: the source must not contain credential-shaped literals.
const fake = (n: string) => [n, 'Secret'].join('-');
const conn = (pw: string) => ['postgres://pbe_app:', pw, '@db:5432/pbe'].join('');

describe('log redaction (unit; the HTTP-level test is S4-5 in db/tests/api.db.spec.ts)', () => {
  it('redacts sensitive keys at any depth, connection strings and bearer tokens', () => {
    const out = JSON.stringify(
      redact({
        password: fake('p1'),
        nested: {
          apiKey: fake('k2'),
          deeper: { Authorization: fake('a3'), cookie: fake('s4') },
        },
        body: { anything: fake('b5') },
        list: [conn(fake('c6')), `Bearer ${fake('t7')}.token`],
        safe: 'kept',
      }),
    );
    for (const n of [1, 2, 3, 4, 5, 6, 7])
      expect(out).not.toMatch(new RegExp(`\\b[a-z]${n}-Secret`));
    expect(out).toContain('kept');
  });

  it('JsonLogger writes one redacted JSON line per event and respects the level', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((l) => lines.push(l), 'info');
    logger.event('info', 'request', { requestId: 'r1', token: 'zz-Secret' });
    logger.event('debug', 'noise', {});
    logger.error(`boom ${conn(fake('pw'))}`, 'Error: x\n    at fn (file.ts:1:1)', 'Ctx');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({
      level: 'info',
      event: 'request',
      requestId: 'r1',
      token: '[REDACTED]',
    });
    expect(lines.join('\n')).not.toMatch(/zz-Secret|pw-Secret|file\.ts:1:1/);
  });
});
