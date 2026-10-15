import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_V1_PREFIX, HEALTH_LIVE_PATH } from '@pbe/contracts';

/** HTTP setup shared by the real server and the tests, so tests exercise the same configuration. */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  // Business endpoints live under /api/v1; health endpoints sit outside versioning.
  app.setGlobalPrefix(API_V1_PREFIX.slice(1), {
    exclude: [{ path: HEALTH_LIVE_PATH.slice(1), method: RequestMethod.GET }],
  });
  app.enableShutdownHooks();
}
