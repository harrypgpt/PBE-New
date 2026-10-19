'use strict';
// Licence summary for completion reports. Reads licences recorded in package-lock.json
// (all installed packages) and prints the direct development dependencies in detail.
// Informational only: it does not pass or fail anything.
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const counts = {};
let total = 0;
for (const [key, meta] of Object.entries(lock.packages || {})) {
  if (!key.includes('node_modules/')) continue;
  total += 1;
  const licence = meta.license || '(not declared)';
  counts[licence] = (counts[licence] || 0) + 1;
}

console.log('Direct development dependencies:');
for (const [name, version] of Object.entries(manifest.devDependencies || {})) {
  const meta = lock.packages[`node_modules/${name}`] || {};
  console.log(`  ${name}@${version} — ${meta.license || '(not declared)'}`);
}
console.log(`\nAll installed packages: ${total}`);
for (const [licence, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${licence}: ${n}`);
}
