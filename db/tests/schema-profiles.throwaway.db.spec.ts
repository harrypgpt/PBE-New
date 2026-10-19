import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, StartupError } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config/config';
import { migrate } from '../../tooling/migrate/src/runner';
import { bootstrapCredentials, ROOT, ThrowawayCluster, withClient } from './helpers';

/*
 * ADR-030 schema profiles: the API starts ONLY on an exact accepted migration ledger — 0001–0004
 * (base) or 0001–0006 (projects) — and refuses every other state. PRIVATE throw-away
 * PostgreSQL 18 server only; pbe_test and pbe_dev are never touched.
 */

let cluster: ThrowawayCluster;
let appPassword = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-profiles-'));
const migrationsDir = path.join(tmp, 'migrations');
const DB = 'pbe_test';

const config = () =>
  loadConfig({
    NODE_ENV: 'test',
    PBE_PG_HOST: cluster.dir,
    PBE_PG_PORT: String(cluster.port),
    PBE_PG_DEV_DATABASE: DB,
    PBE_PG_APP_USER: 'pbe_app',
    PBE_PG_APP_PASSWORD: appPassword,
    PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PBE_TOKEN_OUTBOX_DIR: path.join(tmp, 'outbox'),
  });

const copy = (from: string, file: string) =>
  fs.copyFileSync(path.join(ROOT, 'db', from, file), path.join(migrationsDir, file));
const applyTo = async () =>
  (await migrate({ connection: cluster.config('pbe_migrator', DB), migrationsDir })).applied.map(
    (a) => a.version,
  );
const owner = (sql: string) =>
  withClient(cluster.config('pbe_migrator', DB), (c) => c.query(sql), { asOwner: true });

/** Starts the API and returns the health status, or the start-up error message. */
async function start(): Promise<{ health: number } | { refused: string }> {
  try {
    const app = await createApp({ config: config(), logSink: () => undefined });
    try {
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      return { health: (await fetch(`${base}/api/v1/health`)).status };
    } finally {
      await app.close();
    }
  } catch (err) {
    if (err instanceof StartupError) return { refused: err.message };
    throw err;
  }
}

beforeAll(() => {
  cluster = ThrowawayCluster.start();
  const creds = bootstrapCredentials();
  appPassword = creds.passwords.app;
  const run = cluster.psqlFile(
    path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'),
    creds.env,
  );
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  fs.mkdirSync(migrationsDir);
  for (const f of fs
    .readdirSync(path.join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql') && f < '0005'))
    copy('migrations', f);
}, 120_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ADR-030 start-up on supported and unsupported migration ledgers', () => {
  it('0001–0004 (base profile): starts; health ok', async () => {
    expect(await applyTo()).toEqual([1, 2, 3, 4]);
    expect(await start()).toEqual({ health: 200 });
  });

  it('0001–0005 (incomplete): refused at start-up', async () => {
    copy('migrations', '0005_backup_read_access.sql');
    expect(await applyTo()).toEqual([5]);
    const r = await start();
    expect(r).toEqual({
      refused: expect.stringMatching(/ledger \[1, 2, 3, 4, 5\] does not match/),
    });
  });

  it('0001–0006 (projects profile): starts; health ok', async () => {
    copy('migrations', '0006_projects_scenarios.sql');
    expect(await applyTo()).toEqual([6]);
    expect(await start()).toEqual({ health: 200 });
  });

  it('an unknown later version (0007) is refused at start-up', async () => {
    await owner(
      `INSERT INTO pbe_meta.schema_migration (version, name, checksum_sha256, phase, transactional, execution_ms, runner_version)
       VALUES (7, 'unknown_future', repeat('0', 64), 'expand', true, 0, 'test')`,
    );
    expect(await start()).toEqual({ refused: expect.stringMatching(/does not match/) });
    await owner('DELETE FROM pbe_meta.schema_migration WHERE version = 7');
  });

  it('a ledger that changes AFTER start-up makes health report unavailable (503)', async () => {
    const app = await createApp({ config: config(), logSink: () => undefined });
    try {
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
      await owner(
        `INSERT INTO pbe_meta.schema_migration (version, name, checksum_sha256, phase, transactional, execution_ms, runner_version)
         VALUES (7, 'unknown_future', repeat('0', 64), 'expand', true, 0, 'test')`,
      );
      expect((await fetch(`${base}/api/v1/health`)).status).toBe(503);
    } finally {
      await app.close();
      await owner('DELETE FROM pbe_meta.schema_migration WHERE version = 7');
    }
  });
});
