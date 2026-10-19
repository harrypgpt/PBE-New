import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, Scratch } from './helpers';

// Roadmap Stage 2: "concurrent runners (two processes) apply once". This test starts two
// separate Node.js processes running the compiled runner against the same ledger.

const RUNNER = path.join(ROOT, 'tooling', 'migrate', 'dist', 'runner.js');
const CHILD = `
const { migrate } = require(process.env.PBE_RUNNER);
const started = Date.now();
migrate(JSON.parse(process.env.PBE_RUNNER_OPTIONS)).then(
  (r) => console.log(JSON.stringify({ ok: true, applied: r.applied.map((a) => a.version), started, ended: Date.now() })),
  (e) => console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })),
);`;

interface ChildResult {
  ok: boolean;
  applied?: number[];
  started?: number;
  ended?: number;
  code?: string;
}

function runChild(options: object): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    // The options (including the test password) travel in the child's environment, not argv.
    const child = spawn(process.execPath, ['-e', CHILD], {
      env: { ...process.env, PBE_RUNNER: RUNNER, PBE_RUNNER_OPTIONS: JSON.stringify(options) },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()) as ChildResult);
      } catch {
        reject(new Error(`child produced no result: ${out}`));
      }
    });
  });
}

let scratch: Scratch;
beforeAll(() => {
  const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
  const build = spawnSync(
    tsc,
    ['-p', path.join(ROOT, 'tooling', 'migrate', 'tsconfig.build.json')],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`runner build failed: ${build.stdout}${build.stderr}`);
  scratch = new Scratch();
}, 120_000);
afterAll(() => scratch.cleanup());

it('two separate processes started together apply each migration exactly once', async () => {
  scratch.write(1, 'create_schema', 'CREATE SCHEMA {s};');
  scratch.write(
    2,
    'slow_table',
    'SELECT pg_catalog.pg_sleep(1.5);\nCREATE TABLE {s}.t (id integer);',
  );
  scratch.write(3, 'more', 'CREATE TABLE {s}.u (id integer);');
  const options = scratch.options();

  const [a, b] = await Promise.all([runChild(options), runChild(options)]);
  expect(a.ok && b.ok).toBe(true);
  const [winner, waiter] = (a.applied?.length ?? 0) > 0 ? [a, b] : [b, a];
  expect(winner.applied).toEqual([1, 2, 3]);
  expect(waiter.applied).toEqual([]);
  // The waiter really overlapped: it started before the winner finished and ended after it.
  expect(waiter.started ?? Infinity).toBeLessThan(winner.ended ?? 0);
  expect(waiter.ended ?? 0).toBeGreaterThanOrEqual(winner.ended ?? Infinity);

  const ledger = await scratch.ledger();
  expect(ledger.map((r) => r.version)).toEqual([1, 2, 3]);
});
