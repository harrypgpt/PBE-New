'use strict';

// Toolchain policy check (ADR-021, ADR-022): fails if the project depends on Python or Prisma,
// or if any dependency would compile native code at install time without a documented reason.
const fs = require('node:fs');
const path = require('node:path');
const { listRepoFiles } = require('./lib/repo-files.cjs');
const {
  findPythonFiles,
  findPrismaFiles,
  findPrismaInManifest,
  analyzeLockfile,
} = require('./lib/toolchain.cjs');

const root = path.resolve(__dirname, '..', '..');
const files = listRepoFiles(root);
const failures = [];

const pythonFiles = findPythonFiles(files);
if (pythonFiles.length) failures.push(`Python files found:\n  ${pythonFiles.join('\n  ')}`);

const prismaFiles = findPrismaFiles(files);
if (prismaFiles.length) failures.push(`Prisma schema files found:\n  ${prismaFiles.join('\n  ')}`);

const manifests = files.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
for (const manifestPath of manifests) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  for (const problem of findPrismaInManifest(manifest))
    failures.push(`${manifestPath}: ${problem}`);
}

const lockPath = path.join(root, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
  failures.push('package-lock.json is missing; dependencies cannot be checked.');
} else {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'toolchain-allowlist.json'), 'utf8'),
  );
  const { prisma, nativeBuildTools, installScripts } = analyzeLockfile(lock, allowlist);
  if (prisma.length) failures.push(`Prisma packages in lockfile:\n  ${prisma.join('\n  ')}`);
  if (nativeBuildTools.length) {
    failures.push(
      `Native-build tools (need Python) in lockfile:\n  ${nativeBuildTools.join('\n  ')}`,
    );
  }
  if (installScripts.length) {
    failures.push(
      `Packages with install scripts not in tooling/toolchain-allowlist.json:\n  ${installScripts.join('\n  ')}`,
    );
  }
  console.log(
    `Checked ${files.length} repository files, ${manifests.length} package.json files and ${Object.keys(lock.packages || {}).length} lockfile entries.`,
  );
}

if (failures.length) {
  console.error(`Toolchain policy check FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'Toolchain policy check PASSED: no Python files, no Prisma, no native-build tools, no unapproved install scripts.',
);
