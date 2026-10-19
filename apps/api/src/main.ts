import 'reflect-metadata';
import { createApp, StartupError } from './app';
import { ConfigError, loadConfig } from './config/config';

/** Entry point: `npm run dev:api` (loads .env with node --env-file). */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(
        `PBE API not started — configuration problems:\n  - ${err.problems.join('\n  - ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  try {
    const app = await createApp({ config });
    await app.listen(config.PBE_API_PORT, config.PBE_API_HOST);
    process.stdout.write(
      `${JSON.stringify({ level: 'info', event: 'listening', url: `http://${config.PBE_API_HOST}:${config.PBE_API_PORT}/api/v1/health` })}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `PBE API not started — ${err instanceof StartupError ? err.message : 'unexpected error'}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
