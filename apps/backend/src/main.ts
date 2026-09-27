import './bootstrap-env';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env.schema';
import { API_PREFIX } from './common/http/api-prefix';

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // fail-fast: gecersiz .env ile baslamaz.

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    next();
  });

  // LAN tarayicilari icin build edilmis frontend'i ayni porttan sun (varsa).
  // Hem src/ (ts-node) hem dist/ (build) ayni derinlikte -> ../../frontend/dist.
  const webDist = join(__dirname, '..', '..', 'frontend', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback: /api disindaki GET istekleri index.html'e duser.
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(join(webDist, 'index.html'));
      } else {
        next();
      }
    });
    app.get(Logger).log(`Frontend sunuluyor: ${webDist}`);
  }

  await app.listen(env.API_PORT, env.API_HOST);
  app.get(Logger).log(`Backend hazir: http://${env.API_HOST}:${env.API_PORT}/api/v1`);
}

void bootstrap();
