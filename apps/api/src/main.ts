import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { LogLevel } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { configureApp } from './configure-app';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: LEVELS.slice(0, LEVELS.indexOf(config.LOG_LEVEL) + 1),
  });
  configureApp(app);
  await app.listen(config.PORT, config.HOST);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API failed to start.');
  process.exit(1);
});
