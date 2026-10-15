import { checkApiHealth } from './api-health';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('checkApiHealth', () => {
  it('reports reachable when the reply matches the contract', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ status: 'ok', service: 'pbe-api' }));
    await expect(checkApiHealth('http://api.test', fetchImpl)).resolves.toEqual({
      state: 'reachable',
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/health/live', expect.any(Object));
  });

  it('reports an unexpected response when the body breaks the contract', async () => {
    const fetchImpl = async () => jsonResponse({ status: 'maybe' });
    await expect(checkApiHealth('http://api.test', fetchImpl)).resolves.toEqual({
      state: 'unexpected-response',
      httpStatus: 200,
    });
  });

  it('reports an unexpected response for non-JSON bodies', async () => {
    const fetchImpl = async () => new Response('<html></html>', { status: 200 });
    await expect(checkApiHealth('http://api.test', fetchImpl)).resolves.toMatchObject({
      state: 'unexpected-response',
    });
  });

  it('reports an unexpected response for HTTP errors', async () => {
    const fetchImpl = async () => jsonResponse({}, 503);
    await expect(checkApiHealth('http://api.test', fetchImpl)).resolves.toEqual({
      state: 'unexpected-response',
      httpStatus: 503,
    });
  });

  it('reports unreachable when the request fails', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(checkApiHealth('http://api.test', fetchImpl)).resolves.toEqual({
      state: 'unreachable',
    });
  });
});
