'use strict';

const { scanText, isForbiddenSecretFile, ALLOW_MARKER } = require('../scripts/lib/secrets.cjs');

// Fake secrets are assembled at runtime so this file itself never matches the scanner.
const join = (...parts) => parts.join('');

describe('scanText', () => {
  test.each([
    ['a private key block', join('-----BEGIN ', 'RSA PRIVATE KEY-----'), 'PRIVATE_KEY_BLOCK'],
    ['an AWS access key ID', join('AKIA', 'ABCDEFGHIJKLMNOP'), 'AWS_ACCESS_KEY_ID'],
    ['a GitHub token', join('ghp_', 'a'.repeat(36)), 'GITHUB_TOKEN'],
    ['an Anthropic key', join('sk-', 'ant-', 'x'.repeat(30)), 'ANTHROPIC_API_KEY'],
    [
      'a URL with a password',
      join('postgres://user:', 'hunter22', '@db.example:5432/pbe'),
      'URL_WITH_PASSWORD',
    ],
    [
      'a hard-coded password',
      join('pass', 'word = "', 'S3cretValue!', '"'),
      'HARDCODED_CREDENTIAL',
    ],
    ['an env-file secret', join('DB_PASS', 'WORD=', 'S3cretValue!'), 'ENV_CREDENTIAL'],
  ])('detects %s', (_label, line, id) => {
    expect(scanText(`first line\n${line}\n`)).toEqual([{ line: 2, id }]);
  });

  test('ignores ordinary code and configuration', () => {
    const text = [
      "const port = Number(process.env.PORT ?? '4000');",
      'PBE_API_BASE_URL=http://127.0.0.1:4000',
      'password: z.string().min(12)',
      '"integrity": "sha512-abc"',
      'DB_PASSWORD=',
      '# API_TOKEN=<set in your local .env>',
    ].join('\n');
    expect(scanText(text)).toEqual([]);
  });

  test('honours the explicit allow marker', () => {
    expect(scanText(join('pass', 'word = "', 'S3cretValue!', '" // ', ALLOW_MARKER))).toEqual([]);
  });

  test('never returns the secret value', () => {
    const secret = join('AKIA', 'ZYXWVUTSRQPONMLK');
    expect(JSON.stringify(scanText(secret))).not.toContain(secret);
  });
});

describe('isForbiddenSecretFile', () => {
  test.each([
    '.env',
    'apps/api/.env',
    'apps/web/.env.local',
    'certs/server.pem',
    'keys/id_rsa',
    'tls.key',
  ])('forbids %s', (file) => expect(isForbiddenSecretFile(file)).toBe(true));

  test.each(['apps/api/.env.example', 'src/environment.ts', 'docs/keys.md'])('allows %s', (file) =>
    expect(isForbiddenSecretFile(file)).toBe(false),
  );
});
