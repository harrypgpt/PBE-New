import ShowcasePage from '../app/showcase/page';

describe('test-only showcase page', () => {
  const saved = process.env.PBE_WEB_SHOWCASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PBE_WEB_SHOWCASE;
    else process.env.PBE_WEB_SHOWCASE = saved;
  });

  it('is "page not found" unless the server was started with PBE_WEB_SHOWCASE=1', () => {
    delete process.env.PBE_WEB_SHOWCASE;
    expect(() => ShowcasePage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    process.env.PBE_WEB_SHOWCASE = 'true';
    expect(() => ShowcasePage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it('renders when the flag is exactly "1"', () => {
    process.env.PBE_WEB_SHOWCASE = '1';
    expect(ShowcasePage()).toBeTruthy();
  });
});
