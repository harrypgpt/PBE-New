/**
 * @pbe/contracts — shared API contracts (ADR-022). Zod schemas only; no I/O.
 */
export const WORKSPACE_NAME = '@pbe/contracts';
export const FOUNDATION_STAGE = 1;

export * from './auth';
export * from './authorisation';
export * from './tenancy';
export * from './vocabulary';
export * from './projects';
export * from './health';
export * from './openapi';
export * from './problem-details';
export * from './request-id';
export * from './route';
export * from './routes';

/** Version stamped into the generated OpenAPI document. */
export const API_VERSION = '0.7.0';
