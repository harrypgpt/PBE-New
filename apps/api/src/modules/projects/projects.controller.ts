import { Controller, HttpCode, Inject, Req } from '@nestjs/common';
import {
  projectArchiveRoute,
  projectCreateRoute,
  projectGetRoute,
  projectScopeCheckRoute,
  projectsListRoute,
  projectUpdateRoute,
  scenarioCreateRoute,
  scenarioUpdateRoute,
  type ProjectWrite,
} from '@pbe/contracts';
import type { PbeRequest } from '../../common/http';
import { ProblemException } from '../../common/problem';
import { Route, Validated } from '../../common/route';
import { requestContext } from '../auth/request-context';
import type { AccessContext } from '../tenancy/access';
import type { ProjectsService } from './projects.service';
import type { ScopeInput } from './scope';

export const PROJECTS_SERVICE = Symbol('PROJECTS_SERVICE');

/** The access the guard resolved for this permission route (never taken from the request). */
function access(req: PbeRequest): AccessContext {
  if (!req.pbeAccess) throw new ProblemException(403, 'ACCESS_DENIED', 'Access denied');
  return req.pbeAccess;
}

/** Stage 8: projects and scenarios of the ACTIVE organisation (ADR-030). */
@Controller()
export class ProjectsController {
  constructor(@Inject(PROJECTS_SERVICE) private readonly svc: ProjectsService) {}

  @Route(projectsListRoute)
  list(@Req() req: PbeRequest) {
    return this.svc.list(access(req));
  }

  @Route(projectScopeCheckRoute)
  @HttpCode(200)
  scopeCheck(@Validated('body') b: ScopeInput, @Req() req: PbeRequest) {
    access(req);
    return this.svc.checkScope(b);
  }

  @Route(projectCreateRoute)
  create(@Validated('body') b: ProjectWrite, @Req() req: PbeRequest) {
    return this.svc.create(requestContext(req), access(req), b);
  }

  @Route(projectGetRoute)
  get(@Validated('params') p: { projectId: string }, @Req() req: PbeRequest) {
    return this.svc.get(access(req), p.projectId);
  }

  @Route(projectUpdateRoute)
  update(
    @Validated('params') p: { projectId: string },
    @Validated('body') b: ProjectWrite,
    @Req() req: PbeRequest,
  ) {
    return this.svc.update(requestContext(req), access(req), p.projectId, b);
  }

  @Route(projectArchiveRoute)
  @HttpCode(200)
  archive(@Validated('params') p: { projectId: string }, @Req() req: PbeRequest) {
    return this.svc.archive(requestContext(req), access(req), p.projectId);
  }

  @Route(scenarioCreateRoute)
  addScenario(
    @Validated('params') p: { projectId: string },
    @Validated('body') b: { description: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.addScenario(requestContext(req), access(req), p.projectId, b);
  }

  @Route(scenarioUpdateRoute)
  updateScenario(
    @Validated('params') p: { projectId: string; scenarioId: string },
    @Validated('body') b: { description: string },
    @Req() req: PbeRequest,
  ) {
    return this.svc.updateScenario(requestContext(req), access(req), p.projectId, p.scenarioId, b);
  }
}
