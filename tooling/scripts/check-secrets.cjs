'use strict';
// Secret scan (Stage 1; API_CONTRACT_STANDARDS.md §10). Scans files that git would commit
// (tracked + untracked-not-ignored) for credentials. Reports rule, file and line only —
// never the matched value, so the scan output itself cannot leak a secret.
const fs = require('node:fs');
const path = require('node:path');
const { listRepoFiles } = require('./lib/repo-files.cjs');

const MAX_BYTES = 1024 * 1024;
const PLACEHOLDER =
  /^(<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|x+|\*+|changeme|change_me|change-me|replace[_-]?me|example|placeholder|password|secret|dummy|redacted)$/i;

const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'ai-provider-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    id: 'connection-string-password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:([^\s@/]+)@/,
    placeholderGroup: 1,
  },
  {
    id: 'hard-coded-credential',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    placeholderGroup: 1,
  },
  {
    // SQL: CREATE/ALTER ROLE … PASSWORD 'literal'
    id: 'sql-password-literal',
    re: /\bPASSWORD\s+'([^'\s]{8,})'/i,
    placeholderGroup: 1,
  },
];

// In .sql files, psql variable references such as PASSWORD :'name' refer to a value supplied
// at run time; they are not credentials.
const PSQL_VARIABLE = /:'[A-Za-z_][A-Za-z0-9_]*'/g;

function isEnvFile(file) {
  const base = path.posix.basename(file);
  return /^\.env(\..+)?$/.test(base) && base !== '.env.example';
}

function scanText(text, { sql = false } = {}) {
  const hits = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = sql ? raw.replace(PSQL_VARIABLE, ':psql_variable') : raw;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.placeholderGroup && PLACEHOLDER.test(m[rule.placeholderGroup])) continue;
      hits.push({ rule: rule.id, line: i + 1 });
    }
  });
  return hits;
}

function checkSecrets(rootDir) {
  const findings = [];
  for (const file of listRepoFiles(rootDir)) {
    if (isEnvFile(file)) {
      findings.push({ rule: 'env-file', file, line: 0 });
      continue;
    }
    const full = path.join(rootDir, file);
    const stat = fs.statSync(full);
    if (stat.size > MAX_BYTES) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue; // binary
    for (const hit of scanText(buf.toString('utf8'), { sql: file.endsWith('.sql') }))
      findings.push({ ...hit, file });
  }
  return findings;
}

function main() {
  const rootDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  const findings = checkSecrets(rootDir);
  if (findings.length === 0) {
    console.log('Secret scan: PASS — no credentials or committable .env files found.');
    return 0;
  }
  console.error(`Secret scan: FAIL — ${findings.length} finding(s) (values are not printed):`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''}`);
  }
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkSecrets, scanText };
