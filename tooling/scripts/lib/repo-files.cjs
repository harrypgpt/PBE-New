'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Lists files that belong to the repository: tracked files plus untracked files that are not
 * git-ignored. Ignored content (node_modules, build output, .env) is excluded by design.
 */
function listRepoFiles(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

module.exports = { listRepoFiles };
