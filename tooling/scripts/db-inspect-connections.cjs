'use strict';
// `npm run db:inspect-connections` — READ-ONLY report of the server's connection rules
// (db/bootstrap/inspect-connection-rules.sql). Run by the product owner: psql asks for the
// administrator password in the terminal; PBE never sees it. Nothing on the server is changed.
// The report is written to backups/connection-rules-<time>.txt (git-ignored, owner-only).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SQL_FILE = path.join(ROOT, 'db', 'bootstrap', 'inspect-connection-rules.sql');

function main() {
  const host = process.env.PBE_PG_HOST || 'localhost';
  const port = process.env.PBE_PG_PORT || '5432';
  const admin = process.env.PBE_PG_ADMIN_USER || 'postgres';
  const binDir = process.env.PBE_PG_BIN || '/Library/PostgreSQL/18/bin';
  const psql = path.join(binDir, 'psql');
  if (!fs.existsSync(psql)) {
    console.error(`psql not found at ${psql}. Set PBE_PG_BIN to your PostgreSQL 18 bin folder.`);
    return 1;
  }
  const dir = path.join(ROOT, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = path.join(
    dir,
    `connection-rules-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
  );
  fs.closeSync(fs.openSync(out, 'wx', 0o600));
  console.log('PBE connection-rule inspection (read-only)');
  console.log(`  server: ${host}:${port}   administrator: ${admin} (psql asks for the password)`);
  const run = spawnSync(
    psql,
    ['-h', host, '-p', port, '-U', admin, '-d', 'postgres', '-X', '-f', SQL_FILE, '-o', out],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );
  if (run.status !== 0) {
    fs.rmSync(out, { force: true });
    console.error(`psql exited with code ${run.status}. Nothing was changed.`);
    return 1;
  }
  console.log(`Report written to ${path.relative(ROOT, out)} (owner-only). Nothing was changed.`);
  return 0;
}

if (require.main === module) process.exitCode = main();
