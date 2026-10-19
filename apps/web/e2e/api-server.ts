import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Starts the real, built API for browser tests: settings from .env, but connected to the TEST
 * database (pbe_test) as pbe_app. It listens on 127.0.0.1:3001, the address the website build
 * forwards /api/v1 to. Logs are kept in memory for the test (never printed).
 */
export const ROOT = path.join(__dirname, '..', '..', '..');
const HEALTH = 'http://127.0.0.1:3001/api/v1/health';

export interface ApiServer {
  readonly logs: string[];
  stop(): Promise<void>;
}

async function responds(): Promise<boolean> {
  try {
    await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** `extraEnv`: settings for this run only, e.g. a private token outbox folder (Stage 7B). */
export async function startApi(extraEnv: Record<string, string> = {}): Promise<ApiServer> {
  const main = path.join(ROOT, 'apps', 'api', 'dist', 'main.js');
  if (Object.keys(extraEnv).some((k) => k.startsWith('PBE_PG_'))) {
    throw new Error('Browser tests always use pbe_test; database settings cannot be overridden.');
  }
  if (!fs.existsSync(main)) throw new Error('API not built: run `npm run build` first.');
  if (!fs.existsSync(path.join(ROOT, '.env')))
    throw new Error('.env missing (npm run db:bootstrap).');
  if (await responds()) {
    throw new Error('Something already listens on 127.0.0.1:3001; stop it before the E2E tests.');
  }
  const logs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, ['--env-file=.env', main], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PBE_PG_DEV_DATABASE: 'pbe_test',
      PBE_API_HOST: '127.0.0.1',
      PBE_API_PORT: '3001',
      ...extraEnv,
    },
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
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}
