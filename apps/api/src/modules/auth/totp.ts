import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';

/**
 * Authenticator-app codes (RFC 6238) via the established `otpauth` library (ADR-026): SHA-1,
 * 6 digits, 30-second steps, ±1 step tolerance — the settings authenticator apps support.
 * Replay protection lives in the database (one use per time step, auth_totp_use_step).
 */
export const TOTP_PERIOD_SECONDS = 30;
const ISSUER = 'PBE';

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totp(base32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(base32),
  });
}

/** The time step a valid code belongs to, or null if the code is not valid now (±1 step). */
export function verifiedTimeStep(
  base32: string,
  code: string,
  now: number = Date.now(),
): number | null {
  const delta = totp(base32, 'user').validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 1000 / TOTP_PERIOD_SECONDS) + delta;
}

/** QR code (SVG, no scripts) of the otpauth:// enrolment URI. The URI itself is never returned. */
export function enrolmentQrSvg(base32: string, email: string): Promise<string> {
  return QRCode.toString(totp(base32, email).toString(), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
  });
}
