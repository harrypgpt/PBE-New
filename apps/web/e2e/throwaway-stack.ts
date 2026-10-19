import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, type ApiServer } from './api-server';

/**
 * Stage 8 browser tests need migration 0006, which is NOT applied to pbe_test or pbe_dev (the
 * backup prerequisites are unresolved; STAGE-08-PLAN.md §8). This starts a PRIVATE throw-away
 * PostgreSQL 18 server (Unix socket in a temporary folder, no TCP), runs the real bootstrap and
 * migrations 0001–0004 plus the proposed 0005 and 0006, and starts the built API against it
 * with a CLEAN environment: no .env file is read, so no setting can point at the real server.
 */
const HEALTH = 'http://127.0.0.1:3001/api/v1/health';

export interface ThrowawayStack extends ApiServer {
  /** Runs the built user CLI against the throw-away database. */
  cli(args: string[], input?: string): string;
}

async function responds(): Promise<boolean> {
  try {
    await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Built tooling, loaded at run time (outside this app's TypeScript project).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scram = require(path.join(ROOT, 'tooling', 'scripts', 'lib', 'scram.cjs')) as {
  scramSha256Verifier(password: string): string;
  randomPassword(): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tooling = require(path.join(ROOT, 'tooling', 'migrate', 'dist', 'runner.js')) as {
  migrate(o: { connection: Record<string, unknown>; migrationsDir: string }): Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require(path.join(ROOT, 'tooling', 'migrate', 'dist', 'config.js')) as {
  loadDbEnv(root: string): { binDir: string };
};

/** A private PostgreSQL 18 server: initdb in a temporary folder, Unix socket only, no TCP. */
class Cluster {
  private constructor(
    readonly dir: string,
    readonly port: number,
    private readonly bin: string,
  ) {}

  static start(): Cluster {
    const bin = dbConfig.loadDbEnv(ROOT).binDir;
    const dir = fs.mkdtempSync('/tmp/pbe-pg-');
    const data = path.join(dir, 'data');
    const init = spawnSync(
      path.join(bin, 'initdb'),
      ['-D', data, '-U', 'throwaway_admin', '--auth=trust', '-E', 'UTF8', '--no-instructions'],
      { encoding: 'utf8' },
    );
    if (init.status !== 0) throw new Error('initdb failed');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = 55000 + Math.floor(Math.random() * 4000);
      const run = spawnSync(
        path.join(bin, 'pg_ctl'),
        [
          '-D',
          data,
          '-o',
          `-c listen_addresses='' -c unix_socket_directories='${dir}' -p ${port} -c fsync=off`,
          '-l',
          path.join(dir, 'server.log'),
          '-w',
          'start',
        ],
        { encoding: 'utf8' },
      );
      if (run.status === 0) return new Cluster(dir, port, bin);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('could not start the throw-away PostgreSQL server');
  }

  psqlFile(file: string, env: Record<string, string>): number | null {
    return spawnSync(
      path.join(this.bin, 'psql'),
      [
        '-h',
        this.dir,
        '-p',
        String(this.port),
        '-U',
        'throwaway_admin',
        '-d',
        'postgres',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        file,
      ],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    ).status;
  }

  stop(): void {
    spawnSync(path.join(this.bin, 'pg_ctl'), [
      '-D',
      path.join(this.dir, 'data'),
      '-m',
      'immediate',
      '-w',
      'stop',
    ]);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function startThrowawayStack(outbox: string): Promise<ThrowawayStack> {
  const main = path.join(ROOT, 'apps', 'api', 'dist', 'main.js');
  if (!fs.existsSync(main)) throw new Error('API not built: run `npm run build` first.');
  if (await responds()) {
    throw new Error('Something already listens on 127.0.0.1:3001; stop it before the E2E tests.');
  }
  const cluster = Cluster.start();
  const migrations = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-e2e-migrations-'));
  try {
    const passwords = {
      migrator: scram.randomPassword(),
      app: scram.randomPassword(),
      restore: scram.randomPassword(),
      backup: scram.randomPassword(),
    };
    const status = cluster.psqlFile(path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql'), {
      PBE_MIGRATOR_VERIFIER: scram.scramSha256Verifier(passwords.migrator),
      PBE_APP_VERIFIER: scram.scramSha256Verifier(passwords.app),
      PBE_RESTORE_VERIFIER: scram.scramSha256Verifier(passwords.restore),
      PBE_BACKUP_VERIFIER: scram.scramSha256Verifier(passwords.backup),
    });
    if (status !== 0) throw new Error('bootstrap of the throw-away server failed');
    for (const f of fs.readdirSync(path.join(ROOT, 'db', 'migrations'))) {
      if (f.endsWith('.sql'))
        fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrations, f));
    }
    for (const f of ['0005_backup_read_access.sql', '0006_projects_scenarios.sql']) {
      fs.copyFileSync(path.join(ROOT, 'db', 'migrations', f), path.join(migrations, f));
    }
    await tooling.migrate({
      connection: {
        host: cluster.dir,
        port: cluster.port,
        user: 'pbe_migrator',
        database: 'pbe_test',
      },
      migrationsDir: migrations,
    });

    // Guard: the throw-away server only (a socket folder under /tmp, never port 5432).
    if (!cluster.dir.startsWith('/tmp/pbe-pg-') || cluster.port === 5432) {
      throw new Error('refusing: not a throw-away server');
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'test',
      PBE_API_HOST: '127.0.0.1',
      PBE_API_PORT: '3001',
      PBE_PG_HOST: cluster.dir,
      PBE_PG_PORT: String(cluster.port),
      PBE_PG_DEV_DATABASE: 'pbe_test',
      PBE_PG_APP_USER: 'pbe_app',
      PBE_PG_APP_PASSWORD: passwords.app,
      PBE_PG_MIGRATOR_USER: 'pbe_migrator',
      PBE_PG_MIGRATOR_PASSWORD: passwords.migrator,
      PBE_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      PBE_TOKEN_OUTBOX_DIR: outbox,
    };
    const logs: string[] = [];
    const child: ChildProcess = spawn(process.execPath, [main], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error('The API exited during start-up.');
      try {
        const res = await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('The API did not become healthy within 30 s.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      logs,
      cli(args, input) {
        const r = spawnSync(
          process.execPath,
          [path.join(ROOT, 'apps', 'api', 'dist', 'cli', 'user.js'), ...args],
          { cwd: ROOT, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) },
        );
        if (r.status !== 0) throw new Error(`user ${args[0]} failed`);
        return `${r.stdout}${r.stderr}`;
      },
      async stop() {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await exited;
        } finally {
          cluster.stop();
          fs.rmSync(migrations, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    cluster.stop();
    fs.rmSync(migrations, { recursive: true, force: true });
    throw err;
  }
}
