'use strict';
// Dependency guard (Stage 1). Enforces ADR-003, ADR-005, ADR-006 and ADR-008:
//  - no Python runtime, bridges, tooling, project files or scripts;
//  - no Prisma (incl. Prisma Migrate) and no ORM schema-sync tools;
//  - no SQLite or in-memory database substitutes;
//  - no Redis / queue / microservice infrastructure without an approved ADR;
//  - every package with an install script has an explicit allow/deny decision in
//    package.json "allowScripts", and none that builds with node-gyp (which needs Python) is allowed.
// Checks package.json manifests, the full package-lock.json tree and the project files.
const fs = require('node:fs');
const path = require('node:path');
const { listRepoFiles } = require('./lib/repo-files.cjs');

const FORBIDDEN_PACKAGES = [
  {
    rule: 'python',
    test: (n) =>
      /(^|[-/@.])(python|pyodide|pythonia|pyright-python)([-/.]|$)/i.test(n) ||
      ['node-calls-python', 'python-shell', 'python-bridge', 'node-gyp'].includes(n),
    why: 'Python runtimes, bridges and Python-based build tools are prohibited (ADR-005).',
  },
  {
    rule: 'prisma',
    test: (n) => n === 'prisma' || n.startsWith('@prisma/'),
    why: 'Prisma and Prisma Migrate are prohibited (ADR-006).',
  },
  {
    rule: 'schema-sync',
    test: (n) => n === 'drizzle-kit',
    why: 'ORM schema generation/synchronisation tools are prohibited (ADR-006).',
  },
  {
    rule: 'sqlite-or-in-memory-db',
    test: (n) =>
      [
        'sqlite',
        'sqlite3',
        'better-sqlite3',
        'sql.js',
        'libsql',
        'node-sqlite3-wasm',
        'wa-sqlite',
        'pg-mem',
        '@electric-sql/pglite',
      ].includes(n) ||
      n.startsWith('@libsql/') ||
      n.startsWith('@sqlite.org/'),
    why: 'PostgreSQL is the only database; SQLite and in-memory substitutes are prohibited (ADR-003).',
  },
  {
    rule: 'unapproved-infrastructure',
    test: (n) =>
      [
        'redis',
        'ioredis',
        'bull',
        'bullmq',
        'kafkajs',
        'amqplib',
        '@nestjs/microservices',
      ].includes(n),
    why: 'Redis, queues and microservice transports need a documented, approved ADR (ADR-007, ADR-008).',
  },
];

const PYTHON_FILE =
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|setup\.py|setup\.cfg|poetry\.lock|environment\.ya?ml|tox\.ini|\.python-version|[^/]+\.(py|pyc|pyw|pyi|ipynb))$/;
const PYTHON_COMMAND =
  /(^|[\s;&|(`'"])(python[0-9.]*|pip[0-9.]*|pipx|poetry|conda|pyenv|uvx?)(\s|$)/;
const PRISMA_OR_SYNC_COMMAND = /(^|[\s;&|(`'"])(prisma|drizzle-kit)(\s|$)/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function workspaceManifests(rootDir, rootManifest) {
  const dirs = [];
  for (const entry of rootManifest.workspaces || []) {
    if (entry.endsWith('/*')) {
      const parent = path.join(rootDir, entry.slice(0, -2));
      if (fs.existsSync(parent)) {
        for (const d of fs.readdirSync(parent)) dirs.push(path.join(entry.slice(0, -2), d));
      }
    } else {
      dirs.push(entry);
    }
  }
  return dirs
    .map((d) => path.join(d, 'package.json'))
    .filter((f) => fs.existsSync(path.join(rootDir, f)));
}

function checkPackageName(name, location, findings) {
  for (const f of FORBIDDEN_PACKAGES) {
    if (f.test(name)) findings.push({ rule: f.rule, location, detail: `${name}: ${f.why}` });
  }
}

function checkDependencies(rootDir) {
  const findings = [];
  const rootManifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(rootManifestPath)) {
    return [{ rule: 'manifest', location: 'package.json', detail: 'Root package.json not found.' }];
  }
  const rootManifest = readJson(rootManifestPath);

  // 1. Direct dependencies and scripts in every manifest.
  for (const rel of ['package.json', ...workspaceManifests(rootDir, rootManifest)]) {
    const manifest = rel === 'package.json' ? rootManifest : readJson(path.join(rootDir, rel));
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest[field] || {})) {
        checkPackageName(name, `${rel} ${field}`, findings);
      }
    }
    for (const [script, command] of Object.entries(manifest.scripts || {})) {
      if (PYTHON_COMMAND.test(command)) {
        findings.push({
          rule: 'python',
          location: `${rel} scripts.${script}`,
          detail: 'Script invokes Python tooling (ADR-005).',
        });
      }
      if (PRISMA_OR_SYNC_COMMAND.test(command)) {
        findings.push({
          rule: 'schema-sync',
          location: `${rel} scripts.${script}`,
          detail: 'Script invokes Prisma or Drizzle Kit (ADR-006).',
        });
      }
    }
  }

  // 2. Full installed tree from the lockfile (includes transitive dependencies).
  const lockPath = path.join(rootDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    findings.push({
      rule: 'lockfile',
      location: 'package-lock.json',
      detail: 'Lockfile missing; installs are not reproducible.',
    });
  } else {
    const lock = readJson(lockPath);
    const allowScripts = rootManifest.allowScripts || {};
    for (const [key, meta] of Object.entries(lock.packages || {})) {
      if (!key.includes('node_modules/')) continue; // root and workspace links
      const name =
        meta.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      checkPackageName(name, `package-lock.json ${key}`, findings);
      if (meta.hasInstallScript) {
        if (!(name in allowScripts)) {
          findings.push({
            rule: 'install-script',
            location: `package-lock.json ${key}`,
            detail: `${name} has an install script with no explicit allowScripts decision in package.json.`,
          });
        } else if (allowScripts[name] !== false) {
          const pkgJson = path.join(rootDir, key, 'package.json');
          const scripts = fs.existsSync(pkgJson) ? readJson(pkgJson).scripts || {} : {};
          const install = ['preinstall', 'install', 'postinstall']
            .map((s) => scripts[s] || '')
            .join(' ');
          if (
            /node-gyp/.test(install) ||
            (fs.existsSync(path.join(rootDir, key, 'binding.gyp')) && !install.trim())
          ) {
            findings.push({
              rule: 'python',
              location: `package-lock.json ${key}`,
              detail: `${name} is allowed to run a node-gyp build, which requires Python (ADR-005).`,
            });
          }
        }
      }
    }
  }

  // 3. Python project files anywhere in the repository.
  for (const file of listRepoFiles(rootDir)) {
    if (PYTHON_FILE.test(file)) {
      findings.push({
        rule: 'python',
        location: file,
        detail: 'Python source or project file (ADR-005).',
      });
    }
  }
  return findings;
}

function main() {
  const rootDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  const findings = checkDependencies(rootDir);
  if (findings.length === 0) {
    console.log(
      'Dependency guard: PASS — no prohibited packages, scripts, Python files or unreviewed install scripts.',
    );
    return 0;
  }
  console.error(`Dependency guard: FAIL — ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.location} — ${f.detail}`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkDependencies };
