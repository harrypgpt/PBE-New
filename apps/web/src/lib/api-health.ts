import { HEALTH_LIVE_PATH, HealthLiveResponseSchema } from '@pbe/contracts';

export type ApiHealth =
  | { state: 'reachable' }
  | { state: 'unexpected-response'; httpStatus: number }
  | { state: 'unreachable' };

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Checks the API liveness endpoint and validates the reply against the shared contract. */
export async function checkApiHealth(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 2000,
): Promise<ApiHealth> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(HEALTH_LIVE_PATH, baseUrl).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { state: 'unreachable' };
  }
  if (!response.ok) return { state: 'unexpected-response', httpStatus: response.status };
  const body: unknown = await response.json().catch(() => undefined);
  return HealthLiveResponseSchema.safeParse(body).success
    ? { state: 'reachable' }
    : { state: 'unexpected-response', httpStatus: response.status };
}
