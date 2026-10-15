import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HEALTH_LIVE_PATH, HealthLiveResponseSchema } from '@pbe/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

describe('GET /health/live (HTTP integration)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a body that matches the shared contract', async () => {
    const response = await fetch(`${baseUrl}${HEALTH_LIVE_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const parsed = HealthLiveResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
  });

  it('does not reveal the framework in response headers', async () => {
    const response = await fetch(`${baseUrl}${HEALTH_LIVE_PATH}`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('keeps health outside the versioned prefix', async () => {
    const response = await fetch(`${baseUrl}/api/v1${HEALTH_LIVE_PATH}`);
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(response.status).toBe(404);
  });
});
