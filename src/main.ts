import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const config = AppConfig.fromEnv();
  const roles = [...config.roles].join(',');
  const summary = `${config.serviceName} ${config.version} (roles=${roles}, client=${config.client}, devAuth=${config.devAuth})`;

  if (config.isGateway) {
    // Buffer Nest's own startup logs until the JSON logger is ready.
    const app = await NestFactory.create(AppModule.forRoles(config), { bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.enableCors({ origin: config.corsOrigins, credentials: true });
    app.enableShutdownHooks();
    await app.listen(config.port);
    const logger = await app.resolve(PinoLogger);
    logger.setContext('Bootstrap');
    logger.info({ roles, port: config.port }, `${summary} listening on :${config.port}`);
  } else {
    // Worker only: no HTTP server, just the processors.
    const app = await NestFactory.createApplicationContext(AppModule.forRoles(config), {
      bufferLogs: true,
    });
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    const logger = await app.resolve(PinoLogger);
    logger.setContext('Bootstrap');
    logger.info({ roles }, `${summary} started`);
  }
}

await bootstrap();
