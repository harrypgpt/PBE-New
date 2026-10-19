import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { bootstrapCredentials, ROOT, ThrowawayCluster } from './helpers';

/*
 * Rehearsal of the proposed connection-rule change (STAGE-08-INTEGRATION-PLAN.md, phase 4) on a
 * PRIVATE throw-away PostgreSQL 18 server with TCP: db/bootstrap/apply-pg-hba-pbe-backup.sql and
 * revert-pg-hba-pbe-backup.sql, run by the administrator with psql, against a pg_hba.conf shaped
 * like the real server's (its 6 rules, from the 2026-10-18 11:16 read-only inspection), plus one
 * test-only line that lets this test's administrator in through the socket. The real server's
 * file is never read or written here.
 */

let cluster: ThrowawayCluster;
let pw: Record<'migrator' | 'app' | 'restore' | 'backup', string>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-hba-change-'));
const APPLY = path.join(ROOT, 'db', 'bootstrap', 'apply-pg-hba-pbe-backup.sql');
const REVERT = path.join(ROOT, 'db', 'bootstrap', 'revert-pg-hba-pbe-backup.sql');
const LINES = path.join(ROOT, 'db', 'bootstrap', 'pg_hba-pbe-backup.conf');

// Shaped like the real file: comments, blank lines, TABS between fields, a quote and a backslash
// in comments (to prove the file is written byte for byte), then the six real rules.
const ORIGINAL = [
  '# PostgreSQL Client Authentication Configuration File',
  '# "quoted" comment with a back\\slash',
  '',
  'local\tall\tthrowaway_admin\t\ttrust',
  '# TYPE  DATABASE        USER            ADDRESS                 METHOD',
  '',
  '# "local" is for Unix domain socket connections only',
  'local   all             all                                     scram-sha-256',
  '# IPv4 local connections:',
  'host\tall\t\tall\t\t127.0.0.1/32\t\tscram-sha-256',
  '# IPv6 local connections:',
  'host    all             all             ::1/128                 scram-sha-256',
  '# Allow replication connections from localhost, by a user with the',
  '# replication privilege.',
  'local   replication     all                                     scram-sha-256',
  'host    replication     all             127.0.0.1/32            scram-sha-256',
  'host    replication     all             ::1/128                 scram-sha-256',
  '',
].join('\n');

const hbaPath = () => path.join(cluster.dir, 'data', 'pg_hba.conf');
const copyPath = (stamp: string) => `${hbaPath()}.pre-pbe-backup-${stamp}`;

function runScript(
  script: string,
  vars: Record<string, string>,
): { status: number | null; output: string } {
  const wrapper = path.join(tmp, `run-${Math.random().toString(16).slice(2)}.sql`);
  fs.writeFileSync(
    wrapper,
    `${Object.entries(vars)
      .map(([k, v]) => `\\set ${k} '${v}'`)
      .join('\n')}\n\\i ${script}\n`,
  );
  return cluster.psqlFile(wrapper);
}

/** One real TCP login with SCRAM; returns "ok" or the server's refusal. */
async function login(user: string, password: string, database: string): Promise<string> {
  const c = new pg.Client({
    host: '127.0.0.1',
    port: cluster.port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5000,
  });
  c.on('error', () => undefined);
  try {
    await c.connect();
    return 'ok';
  } catch (e) {
    return /pg_hba\.conf rejects/.test(String(e)) ? 'rejected by pg_hba.conf' : String(e);
  } finally {
    await c.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  cluster = ThrowawayCluster.start({ tcp: true });
  const creds = bootstrapCredentials();
  pw = creds.passwords;
  const run = cluster.psqlFile(
    path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'),
    creds.env,
  );
  if (run.status !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  fs.writeFileSync(hbaPath(), ORIGINAL);
  await cluster.sql('SELECT pg_reload_conf()');
  await new Promise((r) => setTimeout(r, 300));
}, 120_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('connection-rule change by the administrator (no sudo), with verified copy and undo', () => {
  it('before: the backup login can reach "postgres" (why the change is needed); others log in normally', async () => {
    expect(await login('pbe_backup', pw.backup, 'postgres')).toBe('ok');
    expect(await login('pbe_app', pw.app, 'pbe_dev')).toBe('ok');
  });

  it('apply: dated copy equals the original byte for byte; new file = reviewed lines + original; reloaded', async () => {
    const r = runScript(APPLY, { stamp: '20261019-0930', lines_file: LINES });
    expect([r.status, r.output]).toEqual([0, expect.stringContaining('configuration reloaded')]);
    expect(fs.readFileSync(copyPath('20261019-0930'), 'utf8')).toBe(ORIGINAL);
    expect(fs.readFileSync(hbaPath(), 'utf8')).toBe(
      `${fs.readFileSync(LINES, 'utf8').replace(/\n$/, '')}\n${ORIGINAL}`,
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(await login('pbe_backup', pw.backup, 'pbe_dev')).toBe('ok');
    expect(await login('pbe_backup', pw.backup, 'pbe_test')).toBe('ok');
    for (const db of ['postgres', 'template1']) {
      expect(await login('pbe_backup', pw.backup, db)).toBe('rejected by pg_hba.conf');
    }
    expect(await login('pbe_app', pw.app, 'pbe_dev')).toBe('ok');
    expect(await login('pbe_migrator', pw.migrator, 'pbe_dev')).toBe('ok');
    expect(await login('pbe_app', 'wrong-password-123456', 'pbe_dev')).toMatch(
      /password authentication failed/,
    );
  });

  it('a second apply is refused and changes nothing', async () => {
    const before = fs.readFileSync(hbaPath(), 'utf8');
    const r = runScript(APPLY, { stamp: '20261019-0931', lines_file: LINES });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/already has pbe_backup lines; nothing changed/);
    expect(fs.readFileSync(hbaPath(), 'utf8')).toBe(before);
    expect(fs.existsSync(copyPath('20261019-0931'))).toBe(false);
  });

  it('revert: the original file is back, byte for byte, and in force (backup login reaches "postgres" again)', async () => {
    const r = runScript(REVERT, { stamp: '20261019-0930' });
    expect([r.status, r.output]).toEqual([0, expect.stringContaining('restored from')]);
    expect(fs.readFileSync(hbaPath(), 'utf8')).toBe(ORIGINAL);
    await new Promise((res) => setTimeout(res, 300));
    expect(await login('pbe_backup', pw.backup, 'postgres')).toBe('ok');
    expect(fs.existsSync(copyPath('20261019-0930'))).toBe(true); // the copy is kept
  });

  it('a faulty proposal is caught BEFORE reload: the original is written back and the running rules are unchanged', async () => {
    const bad = path.join(tmp, 'bad.conf');
    fs.writeFileSync(bad, 'host    pbe_dev    pbe_backup    999.0.0.1/32    scram-sha-256\n');
    const r = runScript(APPLY, { stamp: '20261019-0932', lines_file: bad });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(
      /did not parse as expected .*the original was written back, nothing reloaded/s,
    );
    expect(fs.readFileSync(hbaPath(), 'utf8')).toBe(ORIGINAL);
    expect(await login('pbe_backup', pw.backup, 'postgres')).toBe('ok');
    expect(
      (
        await cluster.sql(
          'SELECT count(*)::int AS n FROM pg_hba_file_rules WHERE error IS NOT NULL',
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
