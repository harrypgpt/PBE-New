'use strict';

// Secret scan over repository files (tracked + untracked-but-not-ignored). Reports file, line and
// pattern ID only; it never prints the matched value.
const fs = require('node:fs');
const path = require('node:path');
const { listRepoFiles } = require('./lib/repo-files.cjs');
const { scanText, isForbiddenSecretFile } = require('./lib/secrets.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const root = path.resolve(__dirname, '..', '..');
const files = listRepoFiles(root);
const problems = [];
let scanned = 0;

for (const file of files) {
  if (isForbiddenSecretFile(file)) {
    problems.push(`${file}: file type must never be committed`);
    continue;
  }
  const abs = path.join(root, file);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > MAX_BYTES) continue;
  const buffer = fs.readFileSync(abs);
  if (buffer.includes(0)) continue; // binary
  scanned += 1;
  for (const { line, id } of scanText(buffer.toString('utf8')))
    problems.push(`${file}:${line}: ${id}`);
}

console.log(`Scanned ${scanned} text files (${files.length} repository files).`);
if (problems.length) {
  console.error(`Secret scan FAILED (${problems.length} finding(s)):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Secret scan PASSED: no known secret patterns or forbidden files.');
