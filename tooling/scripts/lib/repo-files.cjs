'use strict';
// Lists the project files that guard scripts should inspect.
// In a git work tree: tracked files plus untracked files that are not git-ignored
// (so a `.env` that is correctly ignored is not reported, but one that would be committed is).
// Outside git (e.g. test fixtures): walks the folder, skipping generated directories.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'out']);

function walk(rootDir, dir = rootDir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rootDir, path.join(dir, entry.name), found);
    } else if (entry.isFile()) {
      found.push(path.relative(rootDir, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return found;
}

function listRepoFiles(rootDir) {
  if (fs.existsSync(path.join(rootDir, '.git'))) {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: rootDir,
        encoding: 'utf8',
      },
    );
    return out
      .split('\0')
      .filter(Boolean)
      .filter((f) => fs.existsSync(path.join(rootDir, f)));
  }
  return walk(rootDir);
}

module.exports = { listRepoFiles };
