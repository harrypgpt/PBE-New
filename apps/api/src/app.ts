import 'reflect-metadata';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  DiscoveryModule,
  DiscoveryService,
  NestFactory,
} from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_ROUTES, permissionsForSchema, type RouteContract } from '@pbe/contracts';
import type { ApiConfig } from './config/config';
import { requestPipeline } from './common/http';
import { JsonLogger, type LogSink } from './common/logger';
import { ProblemFilter } from './common/problem.filter';
import {
  AccessGuard,
  AVAILABLE_PERMISSIONS,
  ContractInterceptor,
  GUARD_DATABASE,
  ROUTE_CONTRACT,
  WEB_ORIGINS,
} from './common/route';
import { AuthController } from './modules/auth/auth.controller';
import { ProjectsController, PROJECTS_SERVICE } from './modules/projects/projects.controller';
import { ProjectsService } from './modules/projects/projects.service';
import { TenancyController } from './modules/tenancy/tenancy.controller';
import { TenancyService } from './modules/tenancy/tenancy.service';
import { DevelopmentOutbox } from './modules/tenancy/token-outbox';
import { AUTH_SERVICE, TENANCY_SERVICE } from './modules/auth/request-context';
import { AuthService } from './modules/auth/auth.service';
import {
  assertSafeRuntimeRole,
  createDatabase,
  PROJECTS_SCHEMA_VERSION,
  resolveSchemaProfile,
  SCHEMA_PROFILES,
  type Database,
} from './modules/db';
import {
  DATABASE,
  EXPECTED_SCHEMA_VERSIONS,
  HealthController,
} from './modules/health/health.controller';

export const API_PREFIX = 'api/v1';

export interface CreateAppOptions {
  config: ApiConfig;
  /** Where JSON log lines go (default: stdout). */
  logSink?: LogSink;
  /**
   * The exact migration ledger the API requires. Default: any one of SCHEMA_PROFILES (the base
   * ledger the generated types come from, or that plus 0005 and 0006; ADR-030).
   */
  expectedSchemaVersions?: readonly number[];
  /** Route registry to enforce (default: API_ROUTES from @pbe/contracts). */
  routes?: readonly RouteContract[];
  /** Additional controllers (tests only; production passes none). */
  extraControllers?: Type[];
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

const METHOD_NAME: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

/**
 * Default deny at start-up (S4-8): every served handler must carry a contract (@Route) whose
 * method and path match what is served, and the set of served routes must equal the registry.
 */
export function verifyRouteDeclarations(
  discovery: DiscoveryService,
  registry: readonly RouteContract[],
): void {
  const problems: string[] = [];
  const served = new Set<RouteContract>();
  for (const wrapper of discovery.getControllers()) {
    const proto = wrapper.metatype?.prototype as Record<string, unknown> | undefined;
    if (!proto) continue;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue; // not a route handler
      const where = `${wrapper.name}.${name}`;
      const contract = Reflect.getMetadata(ROUTE_CONTRACT, handler) as RouteContract | undefined;
      if (!contract) {
        problems.push(`${where} has no route contract / access declaration (use @Route(contract))`);
        continue;
      }
      const method = METHOD_NAME[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      if (method !== contract.method || path !== contract.path) {
        problems.push(
          `${where} serves ${method} ${path} but its contract says ${contract.method} ${contract.path}`,
        );
      }
      if (!registry.includes(contract))
        problems.push(`${where}: contract ${contract.operationId} is not in the route registry`);
      served.add(contract);
    }
  }
  for (const contract of registry) {
    if (!served.has(contract))
      problems.push(`registry route ${contract.operationId} is not served by any controller`);
  }
  if (problems.length > 0)
    throw new StartupError(`Route declarations invalid:\n  - ${problems.join('\n  - ')}`);
}

/** Ends the database pool when the application closes (idempotent). */
const DATABASE_CLOSER = Symbol('DATABASE_CLOSER');

/**
 * NestJS shutdown hook for the database pool. (Assigning a new `app.close` does not work: the
 * NestJS application proxy silently ignores property assignments, so the pool stayed open.)
 */
@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CLOSER) private readonly closeDatabase: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.closeDatabase();
  }
}

@Module({})
class AppModule {
  static register(
    db: Database,
    expected: readonly number[],
    extra: Type[],
    auth: AuthService,
    origins: readonly string[],
    tenancyService: TenancyService,
    projectsService: ProjectsService,
    available: ReadonlySet<string>,
    closeDatabase: () => Promise<void>,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [DiscoveryModule],
      controllers: [
        HealthController,
        AuthController,
        TenancyController,
        ProjectsController,
        ...extra,
      ],
      providers: [
        { provide: DATABASE, useValue: db },
        { provide: AUTH_SERVICE, useValue: auth },
        { provide: TENANCY_SERVICE, useValue: tenancyService },
        { provide: PROJECTS_SERVICE, useValue: projectsService },
        { provide: GUARD_DATABASE, useValue: db },
        { provide: WEB_ORIGINS, useValue: origins },
        { provide: AVAILABLE_PERMISSIONS, useValue: available },
        { provide: EXPECTED_SCHEMA_VERSIONS, useValue: expected },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
        { provide: DATABASE_CLOSER, useValue: closeDatabase },
        DatabaseShutdown,
      ],
    };
  }
}

/**
 * Builds the API. Refuses to start (StartupError) on an unsafe runtime role, a migration ledger that
 * differs from the expected versions, or any route without a valid contract (S4-8, S4-11).
 */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const { config } = options;
  const logger = new JsonLogger(options.logSink, config.PBE_LOG_LEVEL);
  const profiles = options.expectedSchemaVersions
    ? [options.expectedSchemaVersions]
    : SCHEMA_PROFILES;
  const db = createDatabase({
    host: config.PBE_PG_HOST,
    port: config.PBE_PG_PORT,
    database: config.PBE_PG_DEV_DATABASE,
    user: config.PBE_PG_APP_USER,
    password: config.PBE_PG_APP_PASSWORD,
  });
  let closing: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => (closing ??= db.destroy());
  let auth: AuthService;
  let expected: readonly number[];
  try {
    await assertSafeRuntimeRole(db);
    expected = await resolveSchemaProfile(db, profiles);
    auth = await AuthService.create(db, {
      idleSeconds: config.PBE_SESSION_IDLE_MINUTES * 60,
      absoluteSeconds: config.PBE_SESSION_ABSOLUTE_HOURS * 3600,
      mfaKey: config.PBE_MFA_ENCRYPTION_KEY,
    });
  } catch (err) {
    await closeDatabase();
    logger.event('error', 'startup_refused', { error: err });
    throw new StartupError(`Start-up refused: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The catalogue in force is the one seeded at this ledger (permissions carry their migration).
  const schemaVersion = expected[expected.length - 1] ?? 0;
  let app: NestExpressApplication;
  try {
    app = await NestFactory.create<NestExpressApplication>(
      AppModule.register(
        db,
        expected,
        options.extraControllers ?? [],
        auth,
        config.PBE_WEB_ORIGINS,
        new TenancyService(
          db,
          {
            idleSeconds: config.PBE_SESSION_IDLE_MINUTES * 60,
            absoluteSeconds: config.PBE_SESSION_ABSOLUTE_HOURS * 3600,
          },
          new DevelopmentOutbox(config.PBE_TOKEN_OUTBOX_DIR),
          undefined,
          permissionsForSchema(schemaVersion),
        ),
        new ProjectsService(db, schemaVersion >= PROJECTS_SCHEMA_VERSION),
        new Set(permissionsForSchema(schemaVersion).map((p) => p.code)),
        closeDatabase,
      ),
      // abortOnError false: a failure while building the application (for example a dependency
      // error) comes back here as an error instead of NestJS calling process.abort().
      { logger, bodyParser: true, abortOnError: false },
    );
  } catch (err) {
    await closeDatabase();
    logger.event('error', 'startup_refused', { error: err });
    throw new StartupError(`Start-up refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(requestPipeline(logger));
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks(); // app.close() and SIGTERM/SIGINT run DatabaseShutdown
  try {
    await app.init();
    verifyRouteDeclarations(app.get(DiscoveryService), options.routes ?? API_ROUTES);
  } catch (err) {
    try {
      await app.close();
    } finally {
      await closeDatabase(); // in case initialisation failed before the hook could run
    }
    logger.event('error', 'startup_refused', { error: err });
    throw err instanceof StartupError ? err : new StartupError(String(err));
  }
  return app;
}
