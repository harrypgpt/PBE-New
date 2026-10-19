'use strict';
// Creates throw-away fixture repositories in the OS temp folder for guard self-tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];

/** files: { 'relative/path': string | object } — objects are written as JSON. */
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-guard-'));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

function cleanupRepos() {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
}

module.exports = { makeRepo, cleanupRepos };
