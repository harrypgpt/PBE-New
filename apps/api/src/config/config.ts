import { z } from 'zod';

/** Environment variables the API reads. Validated once at startup (API_CONTRACT_STANDARDS §14). */
export const ApiConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']).default('log'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export class InvalidConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid API configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Parses configuration from environment variables. The app refuses to start when it is invalid.
 * Error messages name the variable and the rule, never the supplied value, which could be a secret.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const result = ApiConfigSchema.safeParse(env);
  if (!result.success) {
    throw new InvalidConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
