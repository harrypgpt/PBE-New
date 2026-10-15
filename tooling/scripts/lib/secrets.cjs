'use strict';

// Pattern-based secret scanner. It catches common credential formats; it is NOT exhaustive and
// does not replace review. A line can be exempted with the marker "pbe-secret-scan: allow".

const SECRET_PATTERNS = [
  { id: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'AWS_ACCESS_KEY_ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'GITHUB_FINE_GRAINED_TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { id: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'ANTHROPIC_API_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'OPENAI_STYLE_KEY', re: /\bsk-(?!ant-)(proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'STRIPE_LIVE_KEY', re: /\b[rs]k_live_[0-9A-Za-z]{16,}\b/ },
  { id: 'URL_WITH_PASSWORD', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@[^\s]+/i },
  {
    // A quoted literal assigned to a credential-like name, e.g. password = "...".
    id: 'HARDCODED_CREDENTIAL',
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
  {
    // Env-file style assignment with a real-looking value, e.g. DB_PASSWORD=...
    id: 'ENV_CREDENTIAL',
    re: /^\s*(export\s+)?[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|API_KEY|TOKEN|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*[^\s#]{8,}/,
  },
];

const ALLOW_MARKER = 'pbe-secret-scan: allow';

/** Files that must never be committed, whatever their content. */
function isForbiddenSecretFile(file) {
  const base = file.split('/').pop();
  if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  return false;
}

/** Returns findings ({ line, id }) for a file's text. Never returns the matched secret itself. */
function scanText(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const { id, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ line: index + 1, id });
    }
  });
  return findings;
}

module.exports = { scanText, isForbiddenSecretFile, SECRET_PATTERNS, ALLOW_MARKER };
