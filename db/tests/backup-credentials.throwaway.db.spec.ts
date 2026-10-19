import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { ClientConfig } from 'pg';
import { backupAccessMatrix, formatAccessMatrix } from '../../tooling/migrate/src/access-matrix';
import { backupDatabase, BACKUP_FILE_MODE, readArchive } from '../../tooling/migrate/src/backup';
import { migrate } from '../../tooling/migrate/src/runner';
import { ENV, ROOT, scram, ThrowawayCluster, withClient } from './helpers';

/*
 * Backup credential lifecycle and connection rules (STAGE-07A-BACKUP-REVIEW.md §15–§16), END TO
 * END on a PRIVATE throw-away PostgreSQL 18 server that listens on 127.0.0.1 and ::1 only, with
 * SCRAM-SHA-256 passwords and EVERY statement logged (worst case for leaks). The real
 * `npm run db:bootstrap` script runs against it, writing to a temporary .env file (never the
 * real one). The real local server is never contacted.
 */

let cluster: ThrowawayCluster;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-backup-cred-'));
const envFile = path.join(tmp, 'bootstrap.env');
const BOOTSTRAP_SQL = path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql');
const HBA_PROPOSAL = path.join(ROOT, 'db', 'bootstrap', 'pg_hba-pbe-backup.conf');
const ROLES = ['pbe_migrator', 'pbe_app', 'pbe_restore_drill', 'pbe_backup'] as const;
const PASS_VARS = {
  pbe_migrator: 'PBE_PG_MIGRATOR_PASSWORD',
  pbe_app: 'PBE_PG_APP_PASSWORD',
  pbe_restore_drill: 'PBE_PG_RESTORE_PASSWORD',
  pbe_backup: 'PBE_PG_BACKUP_PASSWORD',
} as const;

// Admin keeps password-less access (throw-away only); every PBE login must use SCRAM-SHA-256.
const BASE_HBA = [
  'local all throwaway_admin trust',
  'host all throwaway_admin 127.0.0.1/32 trust',
  'host all throwaway_admin ::1/128 trust',
  'host all all 127.0.0.1/32 scram-sha-256',
  'host all all ::1/128 scram-sha-256',
  'local all all scram-sha-256',
];
const proposedLines = () =>
  fs
    .readFileSync(HBA_PROPOSAL, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));

const passwords = (): Record<(typeof ROLES)[number], string> => {
  const e = parseEnv(fs.readFileSync(envFile, 'utf8'));
  return Object.fromEntries(ROLES.map((r) => [r, String(e[PASS_VARS[r]])])) as Record<
    (typeof ROLES)[number],
    string
  >;
};
const tcp = (user: string, db: string, password?: string, host = '127.0.0.1'): ClientConfig => ({
  host,
  port: cluster.port,
  user,
  database: db,
  password: password ?? passwords()[user as (typeof ROLES)[number]],
});
const storedSecrets = async (): Promise<Record<string, string>> => {
  const r = await cluster.sql(
    `SELECT rolname, rolpassword FROM pg_catalog.pg_authid WHERE rolname LIKE 'pbe\\_%' AND rolpassword IS NOT NULL ORDER BY 1`,
  );
  return Object.fromEntries(
    r.rows.map((x: { rolname: string; rolpassword: string }) => [x.rolname, x.rolpassword]),
  );
};

function runBootstrap(): { status: number | null; output: string } {
  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tooling', 'scripts', 'db-bootstrap.cjs')],
    {
      input: 'yes\n',
      encoding: 'utf8',
      // A clean environment: only what the script needs, pointed at the throw-away server.
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
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

let firstRun: { status: number | null; output: string };

beforeAll(async () => {
  cluster = ThrowawayCluster.start({
    tcp: true,
    settings: ['log_statement=all', 'log_connections=on', 'log_min_error_statement=error'],
  });
  await cluster.setHba(BASE_HBA);
  firstRun = runBootstrap();
}, 120_000);

afterAll(() => {
  cluster?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('credential lifecycle: generate → verifier → server → .env → client', () => {
  it('the real bootstrap script succeeds and every login authenticated with SCRAM-SHA-256', () => {
    expect(firstRun.status).toBe(0);
    for (const role of ROLES) {
      expect(firstRun.output).toContain(`login check: ${role} connected to pbe_test`);
    }
    expect(firstRun.output.match(/authentication scram-sha-256/g)).toHaveLength(4);
  });

  it('passwords are random (32 bytes, base64url) and stored only in the owner-only env file', () => {
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    const p = passwords();
    for (const role of ROLES) expect(p[role]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Object.values(p)).size).toBe(4);
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'))).toEqual([]); // atomic write left nothing
  });

  it('PostgreSQL stored each verifier AS GIVEN: SCRAM-SHA-256, 4096 iterations, derived from the .env password', async () => {
    const stored = await storedSecrets();
    const p = passwords();
    for (const role of ROLES) {
      const secret = stored[role]!;
      expect(scram.parseScramVerifier(secret)?.iterations).toBe(4096);
      expect(scram.verifierMatchesPassword(p[role], secret)).toBe(true);
    }
    const [settings] = (
      await cluster.sql(
        `SELECT current_setting('password_encryption') AS enc, current_setting('scram_iterations') AS it`,
      )
    ).rows;
    expect(settings).toEqual({ enc: 'scram-sha-256', it: '4096' });
  });

  it('neither a password nor a verifier appears in the script output or the server log (log_statement=all)', async () => {
    const stored = await storedSecrets();
    const log = cluster.serverLog();
    for (const role of ROLES) {
      for (const secret of [passwords()[role], stored[role]!]) {
        expect(firstRun.output).not.toContain(secret);
        expect(log).not.toContain(secret);
      }
    }
    expect(firstRun.output).not.toContain('SCRAM-SHA-256$');
    expect(log).not.toContain('SCRAM-SHA-256$');
    expect(log).not.toMatch(/ALTER ROLE pbe_\w+\s+PASSWORD/);
    // Statement logging WAS active for the rest of the script: proof that the suppression is local.
    expect(log).toContain('GRANT CONNECT ON DATABASE pbe_dev, pbe_test TO pbe_backup');
  });

  it('the backup login authenticates over TCP IPv4 and IPv6 with SCRAM; a wrong password is refused', async () => {
    for (const host of ['127.0.0.1', '::1']) {
      const r = await withClient(tcp('pbe_backup', 'pbe_dev', undefined, host), (c) =>
        c.query<{ s: string; ro: string }>(
          `SELECT system_user AS s, current_setting('default_transaction_read_only') AS ro`,
        ),
      );
      expect(r.rows[0]).toEqual({ s: 'scram-sha-256:pbe_backup', ro: 'on' });
    }
    await expect(
      withClient(tcp('pbe_backup', 'pbe_dev', 'not-the-password-0000000000000000000000000'), (c) =>
        c.query('SELECT 1'),
      ),
    ).rejects.toThrow(/password authentication failed for user "pbe_backup"/);
  });

  it('pg_dump receives the password through an owner-only temporary file and SCRAM only (with real data)', async () => {
    const migrationsDir = path.join(tmp, 'migrations');
    fs.mkdirSync(migrationsDir);
    for (const f of fs
      .readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql') && f < '0006')) {
      fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrationsDir, f));
    }
    fs.copyFileSync(
      path.join(ROOT, 'db', 'migrations', '0005_backup_read_access.sql'),
      path.join(migrationsDir, '0005_backup_read_access.sql'),
    );
    await migrate({ connection: tcp('pbe_migrator', 'pbe_dev'), migrationsDir });
    const out = path.join(tmp, 'dumps', 'pbe_dev.dump');
    backupDatabase(ENV.binDir, tcp('pbe_backup', 'pbe_dev'), out, null);
    expect(fs.statSync(out).mode & 0o777).toBe(BACKUP_FILE_MODE);
    expect(readArchive(ENV.binDir, out).ledger).toHaveLength(5);
    expect(cluster.serverLog()).not.toContain(passwords().pbe_backup);
  });

  it('if the server asks for a clear-text password, the backup tool refuses BEFORE sending it', async () => {
    await cluster.setHba(['host all pbe_backup 127.0.0.1/32 password', ...BASE_HBA]);
    try {
      const out = path.join(tmp, 'cleartext', 'pbe_dev.dump');
      expect(() => backupDatabase(ENV.binDir, tcp('pbe_backup', 'pbe_dev'), out, null)).toThrow(
        /pg_dump failed/,
      );
      expect(fs.readdirSync(path.dirname(out))).toEqual([]);
      let details = '';
      try {
        backupDatabase(ENV.binDir, tcp('pbe_backup', 'pbe_dev'), out, null);
      } catch (e) {
        details = ((e as { details?: string[] }).details ?? []).join(' ');
      }
      expect(details).toMatch(
        /server requested a cleartext password|authentication method requirement/,
      );
      expect(cluster.serverLog()).not.toContain(passwords().pbe_backup);
    } finally {
      await cluster.setHba(BASE_HBA);
    }
  });

  it('re-running the bootstrap keeps the passwords (new salts) and logins keep working', async () => {
    const before = passwords();
    const secretsBefore = await storedSecrets();
    const again = runBootstrap();
    expect(again.status).toBe(0);
    expect(again.output.match(/existing password kept/g)).toHaveLength(4);
    expect(passwords()).toEqual(before);
    const after = await storedSecrets();
    for (const role of ROLES) {
      expect(after[role]).not.toBe(secretsBefore[role]); // fresh salt each time
      expect(scram.verifierMatchesPassword(before[role], after[role]!)).toBe(true);
    }
  });

  it('a malformed verifier is refused and NO password changes (one transaction, checked)', async () => {
    const before = await storedSecrets();
    const good = (pw: string) => scram.scramSha256Verifier(pw);
    const p = passwords();
    const run = cluster.psqlFile(BOOTSTRAP_SQL, {
      PBE_MIGRATOR_VERIFIER: good(p.pbe_migrator),
      PBE_APP_VERIFIER: good(p.pbe_app),
      PBE_RESTORE_VERIFIER: good(p.pbe_restore_drill),
      PBE_BACKUP_VERIFIER: 'SCRAM-SHA-256$4096:short$bad:bad',
    });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(
      'did not store the SCRAM verifiers as given; no password was changed',
    );
    expect(run.output).not.toContain(p.pbe_migrator);
    expect(await storedSecrets()).toEqual(before);
  });

  it('a missing verifier stops the script before any change', async () => {
    const before = await storedSecrets();
    const run = cluster.psqlFile(BOOTSTRAP_SQL, {});
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('PBE_MIGRATOR_VERIFIER not set');
    expect(await storedSecrets()).toEqual(before);
  });
});

describe('PostgreSQL lets a login change its OWN password (known limitation)', () => {
  it('then backups fail closed (no file), and re-running the bootstrap restores the login', async () => {
    await withClient(tcp('pbe_backup', 'pbe_dev'), async (c) => {
      await c.query('SET default_transaction_read_only = off');
      await c.query(
        `ALTER ROLE pbe_backup PASSWORD '${scram.scramSha256Verifier(scram.randomPassword())}'`,
      );
    });
    const out = path.join(tmp, 'own-password', 'pbe_dev.dump');
    expect(() => backupDatabase(ENV.binDir, tcp('pbe_backup', 'pbe_dev'), out, null)).toThrow(
      /pg_dump failed/,
    );
    expect(fs.readdirSync(path.dirname(out))).toEqual([]);
    expect(runBootstrap().status).toBe(0); // keeps the .env password, re-sets the verifier
    backupDatabase(ENV.binDir, tcp('pbe_backup', 'pbe_dev'), out, null);
    expect(fs.existsSync(out)).toBe(true);
  });
});

describe('connection matrix with the proposed pg_hba.conf lines (verbatim) at the top', () => {
  beforeAll(async () => {
    await cluster.sql('CREATE DATABASE zz_other');
  });

  const matrix = () =>
    backupAccessMatrix({
      port: cluster.port,
      socketDirs: [cluster.dir],
      user: 'pbe_backup',
      password: passwords().pbe_backup,
      allowed: ['pbe_dev', 'pbe_test'],
      otherDatabases: ['zz_other'],
    });

  it('WITHOUT the rule, the backup login reaches "postgres" and "template1" (why the rule is needed)', async () => {
    const cells = await matrix();
    const leaks = cells.filter(
      (c) => c.replication === 'none' && c.observed === 'allowed' && c.expected === 'rejected',
    );
    expect(leaks.map((c) => `${c.transport} ${c.database}`)).toEqual(
      expect.arrayContaining([
        'tcp-ipv4 postgres',
        'tcp-ipv4 template1',
        'tcp-ipv6 postgres',
        'tcp-ipv6 template1',
      ]),
    );
  });

  it('WITH the rule: allowed only TCP IPv4/IPv6 → pbe_dev/pbe_test (SCRAM); everything else refused by pg_hba.conf', async () => {
    await cluster.setHba([...proposedLines(), ...BASE_HBA]);
    const cells = await matrix();
    const report = formatAccessMatrix(cells);
    fs.writeFileSync(path.join(tmp, 'matrix.txt'), report);
    expect(
      cells
        .filter((c) => !c.ok)
        .map((c) => `${c.transport} ${c.database} ${c.replication}: ${c.detail}`),
    ).toEqual([]);
    expect(
      cells.filter((c) => c.observed === 'allowed').map((c) => `${c.transport} ${c.database}`),
    ).toEqual(['tcp-ipv4 pbe_dev', 'tcp-ipv4 pbe_test', 'tcp-ipv6 pbe_dev', 'tcp-ipv6 pbe_test']);
    // 3 transports × (2 allowed + postgres, template1, template0, zz_other, missing + physical + 2 logical)
    expect(cells).toHaveLength(3 * 10);
    // Print the matrix into the test log for the stage report.
    console.log(`connection matrix (throw-away server):\n${report}`);
  });

  it('other logins are unaffected by the rule', async () => {
    const r = await withClient(tcp('pbe_app', 'pbe_dev'), (c) =>
      c.query<{ s: string }>('SELECT system_user AS s'),
    );
    expect(r.rows[0]?.s).toBe('scram-sha-256:pbe_app');
  });

  it('the read-only inspection script shows the active rules in order, with their files and lines', () => {
    const run = cluster.psqlFile(
      path.join(ROOT, 'db', 'bootstrap', 'inspect-connection-rules.sql'),
    );
    expect(run.status).toBe(0);
    expect(run.output).toMatch(
      /1 \| .*pg_hba\.conf \|\s+\d+ \| host\s+\| \{pbe_dev,pbe_test\} \| \{pbe_backup\}/,
    );
    expect(run.output).toContain('reject');
  });
});
