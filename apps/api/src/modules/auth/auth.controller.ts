import { Controller, HttpCode, Inject, Req, Res } from '@nestjs/common';
import {
  accountMfaConfirmRoute,
  accountMfaEnrolRoute,
  accountPasswordRoute,
  loginRoute,
  logoutRoute,
  mfaVerifyRoute,
  sessionRoute,
} from '@pbe/contracts';
import type { PbeRequest, PbeResponse } from '../../common/http';
import { ProblemException } from '../../common/problem';
import { Route, Validated } from '../../common/route';
import type { AuthService } from './auth.service';
import { clearedSessionCookie, sessionCookie, setSessionCookie } from './http-auth';
import { AUTH_SERVICE, requestContext, TENANCY_SERVICE } from './request-context';
import type { TenancyService } from '../tenancy/tenancy.service';

/** Sign-in, sign-out, session and own-account routes (Stage 6, ADR-026). */
@Controller()
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(TENANCY_SERVICE) private readonly tenancy: TenancyService,
  ) {}

  @Route(loginRoute)
  @HttpCode(200)
  async login(
    @Validated('body') body: { email: string; password: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    const issued = await this.auth.login(requestContext(req), body.email, body.password);
    setSessionCookie(res, sessionCookie(issued.token));
    return { next: issued.next };
  }

  @Route(mfaVerifyRoute)
  @HttpCode(200)
  async verifyMfa(
    @Validated('body') body: { code: string } | { recoveryCode: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    const issued = await this.auth.verifyMfa(requestContext(req), body);
    setSessionCookie(res, sessionCookie(issued.token));
    return { next: issued.next };
  }

  @Route(logoutRoute)
  @HttpCode(200)
  async logout(@Req() req: PbeRequest, @Res({ passthrough: true }) res: PbeResponse) {
    await this.auth.logout(requestContext(req));
    setSessionCookie(res, clearedSessionCookie());
    return { status: 'signed-out' as const };
  }

  @Route(sessionRoute)
  async session(@Req() req: PbeRequest) {
    return this.tenancy.sessionInfo(signedIn(req));
  }

  @Route(accountPasswordRoute)
  @HttpCode(200)
  async changePassword(
    @Validated('body') body: { currentPassword: string; newPassword: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    const token = await this.auth.changePassword(
      requestContext(req),
      signedIn(req),
      body.currentPassword,
      body.newPassword,
    );
    setSessionCookie(res, sessionCookie(token));
    return { status: 'changed' as const };
  }

  @Route(accountMfaEnrolRoute)
  @HttpCode(200)
  async startEnrolment(@Req() req: PbeRequest) {
    return this.auth.startEnrolment(requestContext(req));
  }

  @Route(accountMfaConfirmRoute)
  @HttpCode(200)
  async confirmEnrolment(
    @Validated('body') body: { code: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    const result = await this.auth.confirmEnrolment(requestContext(req), body.code);
    setSessionCookie(res, sessionCookie(result.token));
    return { recoveryCodes: result.recoveryCodes, next: 'done' as const };
  }
}

/** The session the guard attached for an "authenticated" route. */
export function signedIn(req: PbeRequest) {
  const session = req.pbeSession;
  if (!session) throw new ProblemException(401, 'AUTHENTICATION_REQUIRED', 'Sign-in required');
  return session;
}
