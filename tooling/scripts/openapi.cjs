'use strict';

// Generates the OpenAPI document from the shared Zod contracts (packages/contracts must be built).
//   --write  regenerate openapi/openapi.json
//   --check  fail if the committed file differs from what the code generates
const fs = require('node:fs');
const path = require('node:path');
const { buildOpenApiDocument } = require('@pbe/contracts');

const file = path.resolve(__dirname, '..', '..', 'openapi', 'openapi.json');
const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
const mode = process.argv[2];

if (mode === '--write') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated);
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
} else if (mode === '--check') {
  const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (committed !== generated) {
    console.error(
      'OpenAPI check FAILED: openapi/openapi.json is out of date. Run "npm run openapi:generate".',
    );
    process.exit(1);
  }
  console.log('OpenAPI check PASSED: openapi/openapi.json matches the contracts.');
} else {
  console.error('Usage: openapi.cjs --write | --check');
  process.exit(2);
}
