import { healthRoute } from '@pbe/contracts';
import { ApiError, callRoute, type CallOptions } from './client';

export type HealthResult =
  | { readonly available: true; readonly requestId: string | undefined }
  | { readonly available: false; readonly requestId: string | undefined };

/** Asks the API (and through it, the database) whether the system is available. */
export async function checkHealth(options: CallOptions = {}): Promise<HealthResult> {
  try {
    const result = await callRoute(healthRoute, {}, options);
    return { available: result.data.status === 'ok', requestId: result.requestId };
  } catch (error) {
    if (error instanceof ApiError) return { available: false, requestId: error.requestId };
    throw error;
  }
}
