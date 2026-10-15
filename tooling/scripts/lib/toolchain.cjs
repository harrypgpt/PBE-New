'use strict';

// Detection logic for the toolchain policy (ADR-021, ADR-022): no Python, no Prisma.
const PYTHON_FILE_PATTERNS = [
  /\.py$/i,
  /\.pyc$/i,
  /\.ipynb$/i,
  /(^|\/)requirements[^/]*\.txt$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)Pipfile(\.lock)?$/,
  /(^|\/)setup\.(py|cfg)$/i,
  /(^|\/)\.python-version$/,
  /(^|\/)(poetry|uv)\.lock$/,
  /(^|\/)environment\.ya?ml$/i,
  /(^|\/)tox\.ini$/i,
];

/** Repository files that indicate Python tooling. */
function findPythonFiles(files) {
  return files.filter((file) => PYTHON_FILE_PATTERNS.some((re) => re.test(file)));
}

/** Prisma schema files anywhere in the repository. */
function findPrismaFiles(files) {
  return files.filter((file) => /\.prisma$/i.test(file));
}

const isPrismaName = (name) => name === 'prisma' || name.startsWith('@prisma/');

/** Prisma dependencies or scripts declared in a package.json object. */
function findPrismaInManifest(manifest) {
  const problems = [];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const name of Object.keys(manifest[field] || {})) {
      if (isPrismaName(name)) problems.push(`${field}: ${name}`);
    }
  }
  for (const [script, command] of Object.entries(manifest.scripts || {})) {
    if (/\bprisma\b/i.test(command)) problems.push(`script "${script}" runs prisma`);
  }
  return problems;
}

/** Name of the package installed at a lockfile key such as "node_modules/@scope/name". */
function packageNameFromLockKey(key) {
  const idx = key.lastIndexOf('node_modules/');
  return idx === -1 ? undefined : key.slice(idx + 'node_modules/'.length);
}

// Packages whose job is to compile native code at install time (they need Python via node-gyp).
const NATIVE_BUILD_TOOLS = new Set([
  'node-gyp',
  'node-gyp-build',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'prebuild-install',
  'cmake-js',
]);

/**
 * Inspects package-lock.json (v3). Reports Prisma packages, native-build tools, and packages that
 * run install scripts unless the allow-list documents why they are safe.
 */
function analyzeLockfile(lock, allowlist) {
  const allowedInstallScripts = (allowlist && allowlist.installScripts) || {};
  const prisma = [];
  const nativeBuildTools = [];
  const installScripts = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    const name = packageNameFromLockKey(key);
    if (!name) continue;
    if (isPrismaName(name)) prisma.push(key);
    if (NATIVE_BUILD_TOOLS.has(name)) nativeBuildTools.push(key);
    if (
      entry.hasInstallScript &&
      !Object.prototype.hasOwnProperty.call(allowedInstallScripts, name)
    ) {
      installScripts.push(key);
    }
  }
  return { prisma, nativeBuildTools, installScripts };
}

module.exports = {
  findPythonFiles,
  findPrismaFiles,
  findPrismaInManifest,
  analyzeLockfile,
  packageNameFromLockKey,
};
