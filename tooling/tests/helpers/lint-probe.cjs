'use strict';
// Lints code snippets as if they lived at given repository paths, using the real
// eslint.config.mjs. Runs in its own Node process (ESLint loads the ESM config with a
// dynamic import, which Jest's module sandbox does not support).
// stdin:  [{ "filePath": "packages/science-core/src/x.ts", "code": "..." }, ...]
// stdout: [{ "filePath": "...", "ruleIds": ["no-restricted-imports", ...] }, ...]
const path = require('node:path');
const { ESLint } = require('eslint');

async function main() {
  const rootDir = path.join(__dirname, '..', '..', '..');
  const cases = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  const eslint = new ESLint({ cwd: rootDir });
  const out = [];
  for (const c of cases) {
    const [result] = await eslint.lintText(c.code, { filePath: path.join(rootDir, c.filePath) });
    out.push({
      filePath: c.filePath,
      ruleIds: result.messages.map((m) => m.ruleId || 'parse-error'),
    });
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
