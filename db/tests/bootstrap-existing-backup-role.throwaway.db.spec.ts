import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { ENV, ROOT, ThrowawayCluster } from './helpers';

/*
 * Plan phase 3 (STAGE-08-INTEGRATION-PLAN.md): the real `npm run db:bootstrap` script run against
 * a server in TODAY'S real state — pbe_backup already exists (created by the interrupted run of
 * 2026-10-18 10:39) with a password nobody knows, CONNECT on both databases, no large-object
 * revoke, and no backup password in .env. PRIVATE throw-away server; temporary .env file only.
 */

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-boot-existing-'));
const envFile = path.join(tmp, 'bootstrap.env');
const VARS = {
  pbe_migrator: 'PBE_PG_MIGRATOR_PASSWORD',
  pbe_app: 'PBE_PG_APP_PASSWORD',
  pbe_restore_drill: 'PBE_PG_RESTORE_PASSWORD',
  pbe_backup: 'PBE_PG_BACKUP_PASSWORD',
} as const;
const HBA = [
  'local all throwaway_admin trust',
  'host all throwaway_admin 127.0.0.1/32 trust',
  'host all throwaway_admin ::1/128 trust',
  'host all all 127.0.0.1/32 scram-sha-256',
  'host all all ::1/128 scram-sha-256',
  'local all all scram-sha-256',
];

const readEnv = () =>
  parseEnv(fs.readFileSync(envFile, 'utf8')) as Record<string, string | undefined>;
function runBootstrap() {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tooling', 'scripts', 'db-bootstrap.cjs')],
    {
      input: 'yes\n',
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tmp,
        PBE_BOOTSTRAP_ENV_FILE: envFile,
        PBE_PG_HOST: '127.0.0.1',
        PBE_PG_PORT: String(cluster.port),
        PBE_PG_ADMIN_USER: 'throwaway_admin',
        PBE_PG_BIN: ENV.binDir,
      },
    },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}
async function login(user: string, password: string | undefined, db = 'pbe_dev'): Promise<string> {
  const c = new pg.Client({ host: '127.0.0.1', port: cluster.port, user, password, database: db });
  c.on('error', () => undefined);
  try {
    await c.connect();
    return 'ok';
  } catch (e) {
    return String(e);
  } finally {
    await c.end().catch(() => undefined);
  }
}

let before: Record<string, string | undefined> = {};
/** A password nobody knows (generated at run time; never written in this file). */
const UNKNOWN = randomBytes(24).toString('hex');

beforeAll(async () => {
  cluster = ThrowawayCluster.start({ tcp: true });
  await cluster.setHba(HBA);
  // A normal first set-up (gives .env passwords for the three older logins).
  const first = runBootstrap();
  if (first.status !== 0) throw new Error(`first bootstrap failed: ${first.output}`);
  // Recreate today's real state: backup password unknown and absent from .env; revoke step undone.
  await cluster.sql(`ALTER ROLE pbe_backup PASSWORD '${UNKNOWN}'`);
  for (const db of ['pbe_dev', 'pbe_test']) {
    await cluster.sql('GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC', [], db);
  }
  const kept = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('PBE_PG_BACKUP_PASSWORD='))
    .join('\n');
  fs.writeFileSync(envFile, kept, { mode: 0o600 });
  before = readEnv();
}, 180_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bootstrap on today’s real state (pbe_backup present, password unknown)', () => {
  it('the starting state matches the real server: role exists, no .env password, lo_create open', async () => {
    expect(before.PBE_PG_BACKUP_PASSWORD).toBeUndefined();
    const r = await cluster.sql(
      `SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'pbe_backup'`,
    );
    expect(r.rows).toEqual([{ rolbypassrls: true, rolcanlogin: true }]);
    const lo = await cluster.sql(
      `SELECT has_function_privilege('pbe_backup', 'lo_create(oid)', 'EXECUTE') AS e`,
      [],
      'pbe_dev',
    );
    expect(lo.rows[0].e).toBe(true);
  });

  it('the bootstrap succeeds, keeps the role, and gives it a NEW password stored only in .env', async () => {
    const r = runBootstrap();
    expect(r.status).toBe(0);
    expect(r.output.match(/authentication scram-sha-256/g)).toHaveLength(4);
    const after = readEnv();
    expect(after.PBE_PG_BACKUP_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.output).not.toContain(String(after.PBE_PG_BACKUP_PASSWORD));
    expect(await login('pbe_backup', after.PBE_PG_BACKUP_PASSWORD)).toBe('ok');
    expect(await login('pbe_backup', UNKNOWN)).toMatch(/password authentication failed/);
  });

  it('the three existing logins keep their passwords (nothing else changes for the application)', async () => {
    const after = readEnv();
    for (const role of ['pbe_migrator', 'pbe_app', 'pbe_restore_drill'] as const) {
      expect(after[VARS[role]]).toBe(before[VARS[role]]);
      expect(
        await login(role, after[VARS[role]], role === 'pbe_restore_drill' ? 'pbe_test' : 'pbe_dev'),
      ).toBe('ok');
    }
  });

  it('attributes are re-asserted and the large-object/WAL revoke is applied', async () => {
    const r = await cluster.sql(
      `SELECT rolsuper, rolinherit, rolreplication, rolbypassrls, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'pbe_backup'`,
    );
    expect(r.rows).toEqual([
      {
        rolsuper: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: true,
        rolconnlimit: 2,
        rolconfig: ['default_transaction_read_only=on'],
      },
    ]);
    for (const db of ['pbe_dev', 'pbe_test']) {
      const lo = await cluster.sql(
        `SELECT has_function_privilege('pbe_backup', 'lo_create(oid)', 'EXECUTE') AS e`,
        [],
        db,
      );
      expect([db, lo.rows[0].e]).toEqual([db, false]);
    }
  });
});
