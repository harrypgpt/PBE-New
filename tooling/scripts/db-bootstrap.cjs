'use strict';
// `npm run db:bootstrap` — one-time local set-up of PBE's PostgreSQL roles and databases.
// Run by the product owner in their own terminal. See db/bootstrap/README.md.
//
// Security properties:
//  - The administrator password is typed only into psql's own prompt (never stored or echoed).
//  - Existing role passwords in .env are reused, so nothing that already works stops working.
//    Missing ones are generated at random. Only SCRAM verifiers are sent to PostgreSQL.
//  - Plain role passwords are written only to the git-ignored .env file, mode 600, and never printed.
//  - Each verifier is checked before use: well formed (PostgreSQL would otherwise hash it again as
//    a plain password) and derived from the password that goes to .env.
//  - .env is replaced atomically: a new owner-only file is written, then renamed over the old one.
//  - The final login check requires that every login authenticated with SCRAM-SHA-256.
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { parseEnv } = require('node:util');
const { spawnSync } = require('node:child_process');
const { scramSha256Verifier, randomPassword, verifierMatchesPassword } = require('./lib/scram.cjs');

const ROOT = path.join(__dirname, '..', '..');
// PBE_BOOTSTRAP_ENV_FILE exists ONLY so the automated test can run this script end to end against
// a throw-away server without touching the real .env (db/tests/backup-credentials.throwaway.db.spec.ts).
const ENV_FILE = process.env.PBE_BOOTSTRAP_ENV_FILE
  ? path.resolve(process.env.PBE_BOOTSTRAP_ENV_FILE)
  : path.join(ROOT, '.env');
const SQL_FILE = path.join(ROOT, 'db', 'bootstrap', 'bootstrap-local.sql');

function readEnvFile() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
}

/** Sets KEY=value lines in .env text, keeping every unrelated line. */
function upsertEnv(text, values) {
  const lines = text.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx === -1) lines.push(line);
    else lines[idx] = line;
  }
  return `${lines.join('\n')}\n`;
}

const ROLES = [
  {
    key: 'migrator',
    user: 'pbe_migrator',
    userVar: 'PBE_PG_MIGRATOR_USER',
    passVar: 'PBE_PG_MIGRATOR_PASSWORD',
    verifierVar: 'PBE_MIGRATOR_VERIFIER',
  },
  {
    key: 'app',
    user: 'pbe_app',
    userVar: 'PBE_PG_APP_USER',
    passVar: 'PBE_PG_APP_PASSWORD',
    verifierVar: 'PBE_APP_VERIFIER',
  },
  {
    key: 'restore',
    user: 'pbe_restore_drill',
    userVar: 'PBE_PG_RESTORE_USER',
    passVar: 'PBE_PG_RESTORE_PASSWORD',
    verifierVar: 'PBE_RESTORE_VERIFIER',
  },
  {
    // Read-only backup login with BYPASSRLS (Stage 7A, STAGE-07A-BACKUP-REVIEW.md).
    key: 'backup',
    user: 'pbe_backup',
    userVar: 'PBE_PG_BACKUP_USER',
    passVar: 'PBE_PG_BACKUP_PASSWORD',
    verifierVar: 'PBE_BACKUP_VERIFIER',
  },
];

/** Writes .env as a new 0600 file and renames it into place (never briefly readable by others). */
function writeEnvFile(text) {
  const tmp = `${ENV_FILE}.tmp-${nodeCrypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, ENV_FILE);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(ENV_FILE, 0o600);
}

/** One verifier per role; refuses to continue if any is malformed or does not match. */
function makeVerifiers(passwords) {
  const verifiers = {};
  for (const r of ROLES) {
    const v = scramSha256Verifier(passwords[r.key].password);
    if (!verifierMatchesPassword(passwords[r.key].password, v)) {
      throw new Error(`internal check failed: SCRAM verifier for ${r.user} is not valid`);
    }
    verifiers[r.verifierVar] = v;
  }
  return verifiers;
}

/** Reuses each password already in .env (if usable); generates the missing ones. */
function choosePasswords(existingEnvText) {
  const existing = existingEnvText ? parseEnv(existingEnvText) : {};
  const chosen = {};
  for (const r of ROLES) {
    const old = existing[r.passVar];
    const reusable = typeof old === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(old);
    chosen[r.key] = { password: reusable ? old : randomPassword(), reused: reusable };
  }
  return chosen;
}

async function main() {
  const host = process.env.PBE_PG_HOST || 'localhost';
  const port = process.env.PBE_PG_PORT || '5432';
  const admin = process.env.PBE_PG_ADMIN_USER || 'postgres';
  const binDir = process.env.PBE_PG_BIN || '/Library/PostgreSQL/18/bin';
  const psql = path.join(binDir, 'psql');
  if (!fs.existsSync(psql)) {
    console.error(`psql not found at ${psql}. Set PBE_PG_BIN to your PostgreSQL 18 bin folder.`);
    return 1;
  }

  console.log('PBE local database bootstrap');
  console.log(`  server:        ${host}:${port}`);
  console.log(`  administrator: ${admin} (psql will ask for this password; PBE never sees it)`);
  console.log(`  SQL to run:    ${path.relative(ROOT, SQL_FILE)}`);
  console.log(
    '  creates/updates roles pbe_owner, pbe_migrator, pbe_app, pbe_restore_drill, pbe_backup and the',
  );
  console.log(
    '  databases pbe_dev and pbe_test (ADR-020). Nothing is dropped; existing data is kept.',
  );
  const passwords = choosePasswords(readEnvFile());
  for (const r of ROLES) {
    console.log(
      `  ${r.user}: ${passwords[r.key].reused ? 'existing password kept' : 'new random password → .env'}`,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "yes" to continue: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Cancelled. Nothing was changed.');
    return 1;
  }

  const verifiers = makeVerifiers(passwords);
  const run = spawnSync(
    psql,
    [
      '-h',
      host,
      '-p',
      port,
      '-U',
      admin,
      '-d',
      'postgres',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      SQL_FILE,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, ...verifiers },
    },
  );
  if (run.status !== 0) {
    console.error(`\npsql exited with code ${run.status}. .env was not changed.`);
    return 1;
  }

  const values = { PBE_PG_HOST: host, PBE_PG_PORT: port, PBE_PG_BIN: binDir };
  for (const r of ROLES) {
    values[r.userVar] = r.user;
    values[r.passVar] = passwords[r.key].password;
  }
  writeEnvFile(upsertEnv(readEnvFile(), values));
  console.log('\n.env updated (permissions 600). Passwords were not displayed.');

  // Prove every login works, and that it authenticated with SCRAM-SHA-256 (system_user shows the
  // method the server actually used, e.g. "scram-sha-256:pbe_backup").
  const { Client } = require('pg');
  let failed = 0;
  for (const [user, password] of ROLES.map((r) => [r.user, passwords[r.key].password])) {
    const client = new Client({ host, port: Number(port), user, password, database: 'pbe_test' });
    await client.connect();
    const { rows } = await client.query(
      "SELECT session_user AS u, system_user AS s, current_setting('server_version') AS v",
    );
    await client.end();
    const method = String(rows[0].s ?? '').split(':')[0];
    const ok = method === 'scram-sha-256';
    if (!ok) failed += 1;
    console.log(
      `  login check: ${rows[0].u} connected to pbe_test (PostgreSQL ${rows[0].v}), authentication ${method}${ok ? '' : ' — NOT SCRAM-SHA-256: check pg_hba.conf'}`,
    );
  }
  if (failed > 0) {
    console.error('\nBootstrap finished, but some logins did not use SCRAM-SHA-256 (see above).');
    return 1;
  }
  console.log('\nBootstrap complete.');
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`Bootstrap failed: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { upsertEnv, choosePasswords, makeVerifiers };
