import { buildOpenApiDocument, HEALTH_LIVE_PATH } from '../src';

type Operation = { [key: string]: unknown };

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument() as {
    openapi: string;
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, { [key: string]: unknown }> };
  };

  it('declares OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('documents the liveness endpoint', () => {
    expect(doc.paths[HEALTH_LIVE_PATH]?.['get']).toBeDefined();
  });

  it('declares a permission and an idempotency rule on every operation', () => {
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation['x-pbe-permission']).toEqual(expect.any(String));
        expect(operation['x-pbe-idempotency']).toEqual(expect.any(String));
      }
    }
  });

  it('generates component schemas from the Zod contracts', () => {
    expect(doc.components.schemas['HealthLiveResponse']).toMatchObject({
      type: 'object',
      required: ['status', 'service'],
    });
    expect(doc.components.schemas['ProblemDetails']).toMatchObject({ type: 'object' });
    expect(doc.components.schemas['HealthLiveResponse']).not.toHaveProperty('$schema');
    expect(doc.components.schemas['HealthLiveResponse']).not.toHaveProperty('$id');
    expect(doc.components.schemas['HealthLiveResponse']).not.toHaveProperty('$defs');
  });

  it('only references components that exist', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const target of refs) {
      expect(target).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas[String(target).split('/').pop() as string]).toBeDefined();
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});
