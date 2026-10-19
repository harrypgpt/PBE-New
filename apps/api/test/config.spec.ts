import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig } from '../src/config/config';

// Fake value assembled at run time: the source must not contain a credential-shaped literal.
const SECRET = ['Sup3r', 'S3cret', 'Pa55word', 'xyz'].join('-');
const VALID = {
  PBE_PG_HOST: 'localhost',
  PBE_PG_PORT: '5432',
  PBE_PG_DEV_DATABASE: 'pbe_dev',
  PBE_PG_APP_USER: 'pbe_app',
  PBE_PG_APP_PASSWORD: SECRET,
  // A random MFA key per run (never a literal in source).
  PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).problems];
  }
}

describe('S4-1 configuration validation at start-up', () => {
  it('accepts a valid environment and applies safe defaults', () => {
    expect(loadConfig(VALID)).toMatchObject({
      PBE_API_HOST: '127.0.0.1',
      PBE_API_PORT: 3001,
      NODE_ENV: 'development',
      PBE_LOG_LEVEL: 'info',
      PBE_PG_PORT: 5432,
      PBE_WEB_ORIGINS: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      PBE_SESSION_IDLE_MINUTES: 30,
      PBE_SESSION_ABSOLUTE_HOURS: 12,
    });
  });

  it.each([
    'PBE_PG_HOST',
    'PBE_PG_PORT',
    'PBE_PG_APP_USER',
    'PBE_PG_APP_PASSWORD',
    'PBE_MFA_ENCRYPTION_KEY',
  ])('refuses when %s is missing and names it', (name) => {
    const env: Record<string, string | undefined> = { ...VALID, [name]: undefined };
    expect(problemsOf(env).join('\n')).toMatch(new RegExp(`^${name}:`, 'm'));
  });

  it.each([
    ['PBE_API_PORT', '70000'],
    ['PBE_API_PORT', 'eighty'],
    ['PBE_PG_PORT', '-1'],
    ['PBE_PG_DEV_DATABASE', 'pbe-dev; DROP DATABASE'],
    ['PBE_PG_APP_USER', 'Robert"); --'],
    ['PBE_PG_APP_PASSWORD', 'short'],
    ['PBE_LOG_LEVEL', 'verbose'],
    ['NODE_ENV', 'staging'],
    ['PBE_MFA_ENCRYPTION_KEY', randomBytes(16).toString('base64')],
    ['PBE_MFA_ENCRYPTION_KEY', 'not base64 at all, but long enough to look like a key!!'],
    ['PBE_WEB_ORIGINS', 'localhost:3000'],
    ['PBE_WEB_ORIGINS', 'http://localhost:3000/path'],
    ['PBE_SESSION_IDLE_MINUTES', '1'],
    ['PBE_SESSION_ABSOLUTE_HOURS', '1000'],
  ])('refuses an invalid %s', (name, value) => {
    expect(problemsOf({ ...VALID, [name]: value }).join('\n')).toMatch(
      new RegExp(`^${name}:`, 'm'),
    );
  });

  it('never prints a value in its messages', () => {
    const badKey = randomBytes(20).toString('base64');
    const problems = problemsOf({
      ...VALID,
      PBE_PG_APP_PASSWORD: 'tiny',
      PBE_PG_DEV_DATABASE: SECRET,
      PBE_MFA_ENCRYPTION_KEY: badKey,
    });
    const text = problems.join('\n');
    expect(problems).toHaveLength(3);
    expect(text).not.toContain(badKey);
    expect(text).not.toContain('tiny');
    expect(text).not.toContain(SECRET);
  });
});
