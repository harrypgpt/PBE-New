import { Controller, HttpCode, Inject, Req, Res } from '@nestjs/common';
import {
  platformBreakGlassEnterRoute,
  platformBreakGlassListRoute,
  platformBreakGlassRequestRoute,
  platformBreakGlassRevokeRoute,
  platformTenantCreateRoute,
  platformTenantReactivateRoute,
  platformTenantsRoute,
  platformTenantSuspendRoute,
  sessionContextExitRoute,
  sessionTenantRoute,
  sessionTenantsRoute,
  tenantBreakGlassDecisionRoute,
  tenantBreakGlassListRoute,
  tenantBreakGlassRevokeRoute,
  tenantDepartmentCreateRoute,
  tenantDepartmentDeleteRoute,
  tenantDepartmentsRoute,
  tenantDepartmentUpdateRoute,
  tenantMemberAddRoute,
  tenantMemberDeactivateRoute,
  tenantMemberDepartmentsRoute,
  tenantMemberPasswordResetRoute,
  tenantMemberReactivateRoute,
  tenantMemberRolesRoute,
  tenantMembersRoute,
  tenantPermissionsRoute,
  tenantRoleCreateRoute,
  tenantRoleDeleteRoute,
  tenantRolesRoute,
  tenantRoleUpdateRoute,
  tenantSettingsRoute,
  tenantSettingsUpdateRoute,
  tokenPasswordRoute,
} from '@pbe/contracts';
import type { PbeRequest, PbeResponse } from '../../common/http';
import { ProblemException } from '../../common/problem';
import { Route, Validated } from '../../common/route';
import { signedIn } from '../auth/auth.controller';
import { sessionCookie, setSessionCookie } from '../auth/http-auth';
import { requestContext, TENANCY_SERVICE } from '../auth/request-context';
import type { AccessContext } from './access';
import type { TenancyService } from './tenancy.service';

/** The access the guard resolved for this permission route (never taken from the request). */
function access(req: PbeRequest): AccessContext {
  if (!req.pbeAccess) throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied');
  return req.pbeAccess;
}

type Body<T> = T;

/** Stage 7A: active tenant, organisation and platform administration, break-glass, tokens. */
@Controller()
export class TenancyController {
  constructor(@Inject(TENANCY_SERVICE) private readonly svc: TenancyService) {}

  // --- session -----------------------------------------------------------------------------
  @Route(sessionTenantsRoute)
  tenants(@Req() req: PbeRequest) {
    return this.svc.memberTenants(signedIn(req));
  }

  @Route(sessionTenantRoute)
  @HttpCode(200)
  async chooseTenant(
    @Validated('body') b: { tenantId: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    const r = await this.svc.chooseTenant(requestContext(req), signedIn(req), b.tenantId);
    setSessionCookie(res, sessionCookie(r.token));
    return { activeTenant: r.activeTenant };
  }

  @Route(sessionContextExitRoute)
  @HttpCode(200)
  async exit(@Req() req: PbeRequest, @Res({ passthrough: true }) res: PbeResponse) {
    setSessionCookie(
      res,
      sessionCookie(await this.svc.exitContext(requestContext(req), signedIn(req))),
    );
    return { status: 'left' as const };
  }

  // --- members -----------------------------------------------------------------------------
  @Route(tenantMembersRoute)
  members(@Req() req: PbeRequest) {
    return this.svc.listMembers(access(req));
  }

  @Route(tenantMemberAddRoute)
  addMember(
    @Validated('body') b: Body<{ email: string; displayName: string }>,
    @Req() req: PbeRequest,
  ) {
    return this.svc.addMember(requestContext(req), access(req), b);
  }

  @Route(tenantMemberDeactivateRoute)
  @HttpCode(200)
  deactivate(@Validated('params') p: { membershipId: string }, @Req() req: PbeRequest) {
    return this.svc.setMemberStatus(
      requestContext(req),
      access(req),
      p.membershipId,
      'deactivated',
    );
  }

  @Route(tenantMemberReactivateRoute)
  @HttpCode(200)
  reactivate(@Validated('params') p: { membershipId: string }, @Req() req: PbeRequest) {
    return this.svc.setMemberStatus(requestContext(req), access(req), p.membershipId, 'active');
  }

  @Route(tenantMemberPasswordResetRoute)
  @HttpCode(200)
  passwordReset(@Validated('params') p: { membershipId: string }, @Req() req: PbeRequest) {
    return this.svc.startPasswordReset(requestContext(req), access(req), p.membershipId);
  }

  @Route(tenantMemberRolesRoute)
  memberRoles(
    @Validated('params') p: { membershipId: string },
    @Validated('body') b: { roleIds: string[] },
    @Req() req: PbeRequest,
  ) {
    return this.svc.setMemberRoles(requestContext(req), access(req), p.membershipId, b.roleIds);
  }

  @Route(tenantMemberDepartmentsRoute)
  memberDepartments(
    @Validated('params') p: { membershipId: string },
    @Validated('body') b: { departmentIds: string[] },
    @Req() req: PbeRequest,
  ) {
    return this.svc.setMemberDepartments(
      requestContext(req),
      access(req),
      p.membershipId,
      b.departmentIds,
    );
  }

  // --- roles -------------------------------------------------------------------------------
  @Route(tenantRolesRoute)
  roles(@Req() req: PbeRequest) {
    return this.svc.listRoles(access(req));
  }

  @Route(tenantPermissionsRoute)
  permissions() {
    return this.svc.permissionCatalogue();
  }

  @Route(tenantRoleCreateRoute)
  createRole(
    @Validated('body') b: { name: string; description: string; permissions: string[] },
    @Req() req: PbeRequest,
  ) {
    return this.svc.createRole(requestContext(req), access(req), b);
  }

  @Route(tenantRoleUpdateRoute)
  updateRole(
    @Validated('params') p: { roleId: string },
    @Validated('body') b: { name: string; description: string; permissions: string[] },
    @Req() req: PbeRequest,
  ) {
    return this.svc.updateRole(requestContext(req), access(req), p.roleId, b);
  }

  @Route(tenantRoleDeleteRoute)
  deleteRole(@Validated('params') p: { roleId: string }, @Req() req: PbeRequest) {
    return this.svc.deleteRole(requestContext(req), access(req), p.roleId);
  }

  // --- departments -------------------------------------------------------------------------
  @Route(tenantDepartmentsRoute)
  departments(@Req() req: PbeRequest) {
    return this.svc.listDepartments(access(req));
  }

  @Route(tenantDepartmentCreateRoute)
  createDepartment(
    @Validated('body') b: { name: string; description: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.saveDepartment(requestContext(req), access(req), null, b);
  }

  @Route(tenantDepartmentUpdateRoute)
  updateDepartment(
    @Validated('params') p: { departmentId: string },
    @Validated('body') b: { name: string; description: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.saveDepartment(requestContext(req), access(req), p.departmentId, b);
  }

  @Route(tenantDepartmentDeleteRoute)
  deleteDepartment(@Validated('params') p: { departmentId: string }, @Req() req: PbeRequest) {
    return this.svc.deleteDepartment(requestContext(req), access(req), p.departmentId);
  }

  // --- settings ----------------------------------------------------------------------------
  @Route(tenantSettingsRoute)
  settings(@Req() req: PbeRequest) {
    return this.svc.getSettings(access(req));
  }

  @Route(tenantSettingsUpdateRoute)
  updateSettings(@Validated('body') b: { selfApprovalAllowed: boolean }, @Req() req: PbeRequest) {
    return this.svc.updateSettings(requestContext(req), access(req), b);
  }

  // --- break-glass (tenant side) -----------------------------------------------------------
  @Route(tenantBreakGlassListRoute)
  tenantGrants(@Req() req: PbeRequest) {
    return this.svc.tenantGrants(access(req));
  }

  @Route(tenantBreakGlassDecisionRoute)
  @HttpCode(200)
  decide(
    @Validated('params') p: { grantId: string },
    @Validated('body') b: { decision: 'approve' | 'reject' },
    @Req() req: PbeRequest,
  ) {
    return this.svc.decideGrant(
      requestContext(req),
      access(req),
      p.grantId,
      b.decision === 'approve',
    );
  }

  @Route(tenantBreakGlassRevokeRoute)
  @HttpCode(200)
  tenantRevoke(@Validated('params') p: { grantId: string }, @Req() req: PbeRequest) {
    return this.svc.revokeGrant(requestContext(req), access(req), p.grantId);
  }

  // --- platform ----------------------------------------------------------------------------
  @Route(platformTenantsRoute)
  platformTenants(@Req() req: PbeRequest) {
    return this.svc.listTenants(access(req));
  }

  @Route(platformTenantCreateRoute)
  createTenant(
    @Validated('body')
    b: { slug: string; displayName: string; firstAdmin: { email: string; displayName: string } },
    @Req() req: PbeRequest,
  ) {
    return this.svc.createTenant(requestContext(req), access(req), b);
  }

  @Route(platformTenantSuspendRoute)
  @HttpCode(200)
  suspend(@Validated('params') p: { tenantId: string }, @Req() req: PbeRequest) {
    return this.svc.setTenantStatus(requestContext(req), access(req), p.tenantId, 'suspended');
  }

  @Route(platformTenantReactivateRoute)
  @HttpCode(200)
  reactivateTenant(@Validated('params') p: { tenantId: string }, @Req() req: PbeRequest) {
    return this.svc.setTenantStatus(requestContext(req), access(req), p.tenantId, 'active');
  }

  @Route(platformBreakGlassRequestRoute)
  requestGrant(
    @Validated('body') b: { tenantId: string; purpose: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.requestGrant(requestContext(req), access(req), b.tenantId, b.purpose);
  }

  @Route(platformBreakGlassListRoute)
  ownGrants(@Req() req: PbeRequest) {
    return this.svc.ownGrants(access(req));
  }

  @Route(platformBreakGlassEnterRoute)
  @HttpCode(200)
  async enter(
    @Validated('params') p: { grantId: string },
    @Req() req: PbeRequest,
    @Res({ passthrough: true }) res: PbeResponse,
  ) {
    access(req);
    const r = await this.svc.enterGrant(requestContext(req), signedIn(req), p.grantId);
    setSessionCookie(res, sessionCookie(r.token));
    return { grant: r.grant };
  }

  @Route(platformBreakGlassRevokeRoute)
  @HttpCode(200)
  platformRevoke(@Validated('params') p: { grantId: string }, @Req() req: PbeRequest) {
    return this.svc.revokeGrant(requestContext(req), access(req), p.grantId);
  }

  // --- one-time tokens ---------------------------------------------------------------------
  @Route(tokenPasswordRoute)
  @HttpCode(200)
  tokenPassword(
    @Validated('body') b: { token: string; newPassword: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.setPasswordWithToken(requestContext(req), b.token, b.newPassword);
  }
}
