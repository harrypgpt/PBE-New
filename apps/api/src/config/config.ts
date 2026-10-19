import { z } from 'zod';

/**
 * API configuration, validated at start-up (API_CONTRACT_STANDARDS.md §10). Invalid or missing
 * values stop the process with messages that name the variable but NEVER print its value.
 */
const identifier = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a plain lower-case identifier');
const port = z.coerce.number().int().min(1).max(65535);

/** 32 random bytes, base64 (R-010: development storage in .env only). */
const mfaKey = z
  .string()
  .refine((v) => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 random bytes, base64-encoded (run npm run auth:init-key)',
  });

/** Comma-separated web origins allowed to send state-changing requests (CSRF check, ADR-026). */
const origins = z
  .string()
  .transform((v) => v.split(',').map((o) => o.trim()))
  .refine(
    (list) => list.length > 0 && list.every((o) => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o)),
    {
      message: 'must be a comma-separated list of origins like http://localhost:3000',
    },
  );

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PBE_API_HOST: z.string().min(1).default('127.0.0.1'),
    PBE_API_PORT: port.default(3001),
    PBE_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    PBE_PG_HOST: z.string().min(1),
    PBE_PG_PORT: port,
    PBE_PG_DEV_DATABASE: identifier.default('pbe_dev'),
    PBE_PG_APP_USER: identifier,
    PBE_PG_APP_PASSWORD: z.string().min(16, 'must be at least 16 characters'),
    PBE_MFA_ENCRYPTION_KEY: mfaKey,
    PBE_WEB_ORIGINS: origins.default(['http://localhost:3000', 'http://127.0.0.1:3000']),
    PBE_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    PBE_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    /**
     * DEVELOPMENT token outbox (R-011): activation and reset links are written here for the local
     * operator, never returned to administrators. Refused in production.
     */
    PBE_TOKEN_OUTBOX_DIR: z.string().min(1).default('.data/outbox'),
  })
  .refine((c) => c.NODE_ENV !== 'production', {
    message:
      'production needs an approved verified delivery channel for one-time tokens (R-011); the development outbox is not allowed',
    path: ['PBE_TOKEN_OUTBOX_DIR'],
  });
export type ApiConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Reads only the variables above from `env`; everything else is ignored. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Zod issue messages describe the rule, not the input; the value is never included.
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
