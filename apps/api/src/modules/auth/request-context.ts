import type { PbeRequest } from '../../common/http';
import type { RequestContext } from './auth.service';
import { clientAddress, sessionTokenFrom } from './http-auth';

/** Dependency-injection token for the AuthService instance. */
export const AUTH_SERVICE = Symbol('AUTH_SERVICE');
/** Dependency-injection token for the TenancyService instance (Stage 7A). */
export const TENANCY_SERVICE = Symbol('TENANCY_SERVICE');

export function requestContext(req: PbeRequest): RequestContext {
  return { requestId: req.requestId, address: clientAddress(req), token: sessionTokenFrom(req) };
}
