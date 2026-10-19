'use strict';
// `npm run openapi` — writes openapi/openapi.json from the shared contracts (ADR-022).
// `npm run openapi -- --check` — fails if the committed file differs (used by `verify`).
// Requires packages/contracts to be built (npm run build does this first).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'openapi', 'openapi.json');
const { API_ROUTES, API_VERSION, buildOpenApiDocument } = require(
  path.join(ROOT, 'packages', 'contracts', 'dist', 'index.js'),
);

const text = `${JSON.stringify(buildOpenApiDocument(API_ROUTES, { title: 'PBE API', version: API_VERSION }), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(
      'OpenAPI: FAIL — openapi/openapi.json is out of date with the contracts. Run: npm run openapi',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `OpenAPI: PASS — openapi/openapi.json matches the contracts (${API_ROUTES.length} routes).`,
    );
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`OpenAPI written: openapi/openapi.json (${API_ROUTES.length} routes).`);
}
