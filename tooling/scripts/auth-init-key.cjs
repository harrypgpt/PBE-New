'use strict';
// `npm run auth:init-key` — adds a random PBE_MFA_ENCRYPTION_KEY (32 bytes, base64) to the
// git-ignored .env file if it is missing (Stage 6, ADR-026). An existing key is never replaced:
// replacing it would make every enrolled authenticator unreadable. The key is never printed.
// DEVELOPMENT STORAGE ONLY (R-010): production needs an approved key-management solution (OD-28).
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');
const NAME = 'PBE_MFA_ENCRYPTION_KEY';

if (!fs.existsSync(ENV_FILE)) {
  console.error('.env is missing. Run `npm run db:bootstrap` first.');
  process.exit(1);
}
const text = fs.readFileSync(ENV_FILE, 'utf8');
if (new RegExp(`^${NAME}=.+$`, 'm').test(text)) {
  console.log(`${NAME} already present in .env (kept; not displayed).`);
  process.exit(0);
}
const line = `${NAME}=${randomBytes(32).toString('base64')}`;
fs.writeFileSync(ENV_FILE, `${text.replace(/\n*$/, '\n')}${line}\n`, { mode: 0o600 });
fs.chmodSync(ENV_FILE, 0o600);
console.log(`${NAME} added to .env (permissions 600). The key was not displayed.`);
