import { InvalidConfigError, loadConfig } from '../src/config/config';

describe('loadConfig', () => {
  it('applies safe defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 4000,
      LOG_LEVEL: 'log',
    });
  });

  it('accepts valid values and converts PORT to a number', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'warn',
    });
    expect(config).toEqual({ NODE_ENV: 'test', HOST: '0.0.0.0', PORT: 8080, LOG_LEVEL: 'warn' });
  });

  it.each([
    ['an unknown NODE_ENV', { NODE_ENV: 'staging-ish' }, 'NODE_ENV'],
    ['a non-numeric PORT', { PORT: 'abc' }, 'PORT'],
    ['PORT 0', { PORT: '0' }, 'PORT'],
    ['PORT above 65535', { PORT: '70000' }, 'PORT'],
    ['a fractional PORT', { PORT: '4000.5' }, 'PORT'],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'chatty' }, 'LOG_LEVEL'],
    ['an empty HOST', { HOST: '' }, 'HOST'],
  ])('rejects %s and names the variable', (_label, env, variable) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError);
    expect(() => loadConfig(env)).toThrow(new RegExp(`${variable}:`));
  });

  it('never echoes the supplied value in the error message', () => {
    const secretLooking = 'not-a-port-but-maybe-a-secret-1234';
    expect(() => loadConfig({ PORT: secretLooking })).toThrow(InvalidConfigError);
    try {
      loadConfig({ PORT: secretLooking });
    } catch (error) {
      expect((error as Error).message).not.toContain(secretLooking);
    }
  });
});
