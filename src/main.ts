import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const config = AppConfig.fromEnv();
  const logger = new Logger('Bootstrap');
  const roles = [...config.roles].join(',');
  const summary = `${config.serviceName} ${config.version} (roles=${roles}, client=${config.client}, devAuth=${config.devAuth})`;

  if (config.isGateway) {
    const app = await NestFactory.create(AppModule.forRoles(config));
    app.enableCors({ origin: config.corsOrigins, credentials: true });
    app.enableShutdownHooks();
    await app.listen(config.port);
    logger.log(`${summary} listening on :${config.port}`);
  } else {
    // Worker only: no HTTP server, just the processors.
    const app = await NestFactory.createApplicationContext(AppModule.forRoles(config));
    app.enableShutdownHooks();
    logger.log(`${summary} started`);
  }
}

await bootstrap();
