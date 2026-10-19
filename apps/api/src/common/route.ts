import {
  applyDecorators,
  type CallHandler,
  type CanActivate,
  createParamDecorator,
  Delete,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  Optional,
  type NestInterceptor,
  Patch,
  Post,
  Put,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { permissionScope, type RouteContract } from '@pbe/contracts';
import type { Database } from '../modules/db';
import { resolveAccess } from '../modules/tenancy/access';
import { z } from 'zod';
import { map, type Observable } from 'rxjs';
import type { PbeRequest } from './http';
import type { AuthService } from '../modules/auth/auth.service';
import { AUTH_SERVICE, requestContext } from '../modules/auth/request-context';
import { crossSiteRefusal } from '../modules/auth/http-auth';

export const WEB_ORIGINS = Symbol('WEB_ORIGINS');
export const GUARD_DATABASE = Symbol('GUARD_DATABASE');
/** Permission codes seeded in the connected database (its schema profile, ADR-030). */
export const AVAILABLE_PERMISSIONS = Symbol('AVAILABLE_PERMISSIONS');
import { ProblemException, ResponseContractViolation } from './problem';

export const ROUTE_CONTRACT = 'pbe:route-contract';

const METHOD = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Delete } as const;

/**
 * Declares a handler from its shared contract (ADR-022): HTTP method, path and access come from
 * the contract, so the served route and its documentation can never disagree.
 */
export function Route(contract: RouteContract): MethodDecorator {
  return applyDecorators(
    SetMetadata(ROUTE_CONTRACT, contract),
    METHOD[contract.method](contract.path),
  );
}

/** Handler parameter: the request part as validated by the contract. */
export const Validated = createParamDecorator(
  (part: 'params' | 'query' | 'body', ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<PbeRequest>().pbeValidated?.[part],
);

export function contractOf(reflector: Reflector, ctx: ExecutionContext): RouteContract | undefined {
  return reflector.get<RouteContract | undefined>(ROUTE_CONTRACT, ctx.getHandler());
}

/**
 * Default deny (S4-8) and access kinds (ADR-022 amendment, ADR-026):
 *  - no contract (no access declaration) → 403;
 *  - any state-changing request not from a PBE web origin → 403 (CSRF defence);
 *  - "public" → allowed;
 *  - "authenticated" → a complete, valid session is required (401 otherwise). It grants no role,
 *    tenant or resource permission;
 *  - "permission" → decided from the database on every request (Stage 7). A permission that the
 *    connected database does not have yet (its migration is not applied, ADR-030) answers
 *    404 "not available": the capability does not exist there, whoever asks.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(WEB_ORIGINS) private readonly origins: readonly string[],
    @Inject(GUARD_DATABASE) private readonly db: Database,
    @Optional()
    @Inject(AVAILABLE_PERMISSIONS)
    private readonly available?: ReadonlySet<string>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const contract = contractOf(this.reflector, ctx);
    if (!contract) {
      throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied', {
        internal: 'route has no access declaration (default deny)',
      });
    }
    const req = ctx.switchToHttp().getRequest<PbeRequest>();
    const refusal = crossSiteRefusal(req, this.origins);
    if (refusal) {
      throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied', {
        internal: `cross-site request refused: ${refusal}`,
      });
    }
    if (contract.access.kind === 'public') return true;
    // Permission routes: the permission must be in the fixed catalogue (ADR-029).
    if (
      contract.access.kind === 'permission' &&
      permissionScope(contract.access.permission) === null
    ) {
      throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied', {
        internal: `permission ${contract.access.permission} is not in the catalogue`,
      });
    }
    const session = await this.auth.resolve(requestContext(req));
    if (!session || session.state !== 'active') {
      throw new ProblemException(401, 'AUTHENTICATION_REQUIRED', 'Sign-in required', {
        detail: 'Please sign in.',
      });
    }
    req.pbeSession = session;
    if (contract.access.kind === 'authenticated') return true;
    if (this.available && !this.available.has(contract.access.permission)) {
      throw new ProblemException(404, 'NOT_FOUND', 'Not available', {
        detail: 'This feature is not available on this database yet.',
        internal: `permission ${contract.access.permission} not seeded at this schema profile`,
      });
    }
    // Decided from the database on every request (Stage 7A): revocation is immediate.
    req.pbeAccess = await resolveAccess(
      this.db,
      session,
      contract.access.permission,
      req.method ?? '',
      req.requestId ?? null,
    );
    return true;
  }
}

const EMPTY = z.strictObject({});

function issues(part: string, error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({
    path: [part, ...i.path.map(String)].join('.'),
    message: i.message,
  }));
}

/**
 * Validates every request part and every response against the route's contract (ADR-022).
 * Unknown fields are rejected. A response that does not match its contract is never sent.
 */
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contract = contractOf(this.reflector, ctx);
    if (!contract) throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied');
    const req = ctx.switchToHttp().getRequest<PbeRequest>();

    const errors: Array<{ path: string; message: string }> = [];
    const parse = (part: string, schema: z.ZodType, value: unknown): unknown => {
      const r = schema.safeParse(value);
      if (!r.success) errors.push(...issues(part, r.error));
      return r.success ? r.data : undefined;
    };
    const params = parse('params', contract.request.params ?? EMPTY, { ...req.params });
    const query = parse('query', contract.request.query ?? EMPTY, { ...(req.query as object) });
    const hasBody =
      req.body !== undefined &&
      !(typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length === 0);
    let body: unknown;
    if (contract.request.body) body = parse('body', contract.request.body, req.body);
    else if (hasBody)
      errors.push({ path: 'body', message: 'This route does not accept a request body' });
    if (errors.length > 0) {
      throw new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', {
        detail: `${errors.length} problem(s) in the request.`,
        errors,
      });
    }
    req.pbeValidated = { params, query, body };

    return next.handle().pipe(
      map((result: unknown) => {
        const status = ctx.switchToHttp().getResponse<{ statusCode: number }>().statusCode;
        const spec = contract.responses[status];
        if (!spec) throw new ResponseContractViolation([`status ${status} is not declared`]);
        const checked = spec.schema.safeParse(result);
        if (!checked.success) {
          throw new ResponseContractViolation(
            checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
          );
        }
        return checked.data;
      }),
    );
  }
}
