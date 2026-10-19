'use strict';
// Fake secrets are assembled at runtime from fragments so that this test file itself
// never contains a string that the scanner would flag.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkSecrets } = require('../scripts/check-secrets.cjs');
const { makeRepo, cleanupRepos } = require('./helpers/fixture-repo.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-secrets.cjs');

const FAKE = {
  privateKey: ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' '),
  awsKey: 'AKIA' + 'Q'.repeat(16),
  githubToken: 'ghp' + '_' + 'a1B2'.repeat(9),
  aiKey: 'sk-' + 'ant-' + 'z9'.repeat(15),
  dbPassword: 'Sup3r' + 'S3cret' + 'Value',
};

afterAll(cleanupRepos);

describe('secret scan — passing cases', () => {
  test('the real PBE repository passes', () => {
    expect(checkSecrets(REPO_ROOT)).toEqual([]);
  });

  test('placeholders and .env.example are allowed', () => {
    const dir = makeRepo({
      '.env.example':
        'DATABASE_URL=postgres://pbe_app:<password>@localhost:5432/pbe_dev\nAPI_KEY="${API_KEY}"\n',
      'src/config.ts': "const password = process.env.DB_PASSWORD;\nconst label = 'password';\n",
    });
    expect(checkSecrets(dir)).toEqual([]);
  });
});

describe('secret scan — failing cases', () => {
  test.each([
    ['private key block', FAKE.privateKey, 'private-key'],
    ['AWS access key id', `key = ${FAKE.awsKey}`, 'aws-access-key-id'],
    ['GitHub token', `token: ${FAKE.githubToken}`, 'github-token'],
    ['AI provider key', `const k = '${FAKE.aiKey}';`, 'ai-provider-key'],
    [
      'connection string with a real password',
      `postgres://pbe_app:${FAKE.dbPassword}@db.example:5432/pbe`,
      'connection-string-password',
    ],
    [
      'hard-coded password assignment',
      `const password = "${FAKE.dbPassword}";`,
      'hard-coded-credential',
    ],
  ])('%s is detected', (_name, content, rule) => {
    const dir = makeRepo({ 'src/leak.ts': `// line 1\n${content}\n` });
    const findings = checkSecrets(dir);
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule, file: 'src/leak.ts', line: 2 })]),
    );
  });

  test('a literal password in SQL is detected', () => {
    const dir = makeRepo({ 'db/x.sql': `ALTER ROLE pbe_app PASSWORD '${FAKE.dbPassword}';\n` });
    expect(checkSecrets(dir)).toEqual([
      { rule: 'sql-password-literal', file: 'db/x.sql', line: 1 },
    ]);
  });

  test('a psql variable reference in a .sql file is not a secret', () => {
    const dir = makeRepo({ 'db/x.sql': 'ALTER ROLE pbe_app PASSWORD :' + "'app_verifier';\n" });
    expect(checkSecrets(dir)).toEqual([]);
  });

  test('the psql-variable exemption does not apply outside .sql files', () => {
    const dir = makeRepo({
      'src/x.ts': "const o = { password:'${FAKE.dbPassword}' };\n".replace(
        '${FAKE.dbPassword}',
        FAKE.dbPassword,
      ),
    });
    expect(checkSecrets(dir).map((f) => f.rule)).toContain('hard-coded-credential');
  });

  test('a committable .env file is detected', () => {
    const dir = makeRepo({ '.env': 'NOTHING=here\n', 'apps/api/.env.local': 'X=1\n' });
    const files = checkSecrets(dir)
      .filter((f) => f.rule === 'env-file')
      .map((f) => f.file);
    expect(files.sort()).toEqual(['.env', 'apps/api/.env.local']);
  });

  test('the command fails and never prints the secret value', () => {
    const dir = makeRepo({ 'src/leak.ts': `const password = "${FAKE.dbPassword}";\n` });
    const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    const output = run.stdout + run.stderr;
    expect(output).toContain('[hard-coded-credential] src/leak.ts:1');
    expect(output).not.toContain(FAKE.dbPassword);
  });
});
