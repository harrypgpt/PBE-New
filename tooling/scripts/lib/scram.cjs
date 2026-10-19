'use strict';
// SCRAM-SHA-256 password verifier in PostgreSQL's stored format (RFC 5802 / RFC 7677):
//   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
// Computing it locally means the plain password is never sent to the database server.
// Passwords used here are random base64url strings, so no SASLprep normalisation is needed.
const nodeCrypto = require('node:crypto');

function scramSha256Verifier(
  password,
  { iterations = 4096, salt = nodeCrypto.randomBytes(16) } = {},
) {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error('Only base64url passwords are supported (no SASLprep).');
  }
  const salted = nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key, text) => nodeCrypto.createHmac('sha256', key).update(text).digest();
  const storedKey = nodeCrypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  const b64 = (buf) => buf.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

function randomPassword() {
  return nodeCrypto.randomBytes(32).toString('base64url');
}

// PostgreSQL stores a pre-computed secret AS GIVEN only if it parses as one (parse_scram_secret:
// SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, keys 32 bytes). Anything else is
// treated as a PLAIN password and hashed again, which would silently break the login.
const VERIFIER =
  /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/;

/** Parses a SCRAM-SHA-256 secret in PostgreSQL's stored format; null if malformed. */
function parseScramVerifier(verifier) {
  const m = VERIFIER.exec(String(verifier));
  if (!m) return null;
  const iterations = Number(m[1]);
  const salt = Buffer.from(m[2], 'base64');
  if (!Number.isSafeInteger(iterations) || iterations < 4096 || salt.length < 16) return null;
  return {
    iterations,
    salt,
    storedKey: Buffer.from(m[3], 'base64'),
    serverKey: Buffer.from(m[4], 'base64'),
  };
}

/** True only if `verifier` is well formed AND was derived from `password`. */
function verifierMatchesPassword(password, verifier) {
  const parsed = parseScramVerifier(verifier);
  if (!parsed) return false;
  const again = scramSha256Verifier(password, { iterations: parsed.iterations, salt: parsed.salt });
  const a = Buffer.from(again);
  const b = Buffer.from(String(verifier));
  return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}

module.exports = {
  scramSha256Verifier,
  randomPassword,
  parseScramVerifier,
  verifierMatchesPassword,
};
