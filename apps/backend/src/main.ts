import './bootstrap-env';
import { existsSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env.schema';
import { API_PREFIX } from './common/http/api-prefix';
import { resolveDataDir } from './common/util/data-dir';
import { currentTlsHosts, ensureTlsMaterial } from './tls/tls.certs';

// Ucuz kontrol (birkac kucuk dosya): acilista ag henuz yoksa LAN IP'si en gec 1 dk'da eklenir.
const TLS_RECHECK_MS = 60_000;

/**
 * Tabletler icin yerel HTTPS (ayni Express ornegi, ayri port). Tarayici LAN IP'sini
 * ancak HTTPS ile "guvenli baglam" sayar; Service Worker (cevrimdisi acilis) buna bagli.
 * Hata POS'u dusurmez: loglanir, yalniz HTTP ile devam edilir.
 */
async function startHttps(
  handler: express.Express,
  port: number,
  host: string,
  logger: Logger,
): Promise<void> {
  const dir = join(resolveDataDir(), 'tls');
  try {
    const tls = await ensureTlsMaterial(dir, currentTlsHosts());
    const server = createHttpsServer({ key: tls.key, cert: tls.cert }, handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    logger.log(`HTTPS hazir (garson tabletleri): https://${host}:${port}`);
    // Ag adresi degisirse (DHCP) sertifika yenilenir; CA ayni kalir -> tabletlerde yeniden kurulum yok.
    setInterval(() => {
      const hosts = currentTlsHosts();
      // Ag gecici olarak koptuysa (IP yok) LAN IP'sini sertifikadan dusurme: geri gelince hata olmasin.
      if (hosts.ips.length === 0) return;
      ensureTlsMaterial(dir, hosts)
        .then((next) => {
          if (!next.renewed) return;
          server.setSecureContext({ key: next.key, cert: next.cert });
          logger.log('HTTPS sertifikasi yenilendi (ag adresi degisti).');
        })
        .catch((err: unknown) => logger.error(`HTTPS sertifikasi yenilenemedi: ${String(err)}`));
    }, TLS_RECHECK_MS).unref();
  } catch (err) {
    logger.error(
      `HTTPS baslatilamadi, yalniz HTTP ile devam: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
  const logger = app.get(Logger);
  logger.log(`Backend hazir: http://${env.API_HOST}:${env.API_PORT}/api/v1`);
  if (env.API_TLS_PORT) {
    await startHttps(app.getHttpAdapter().getInstance(), env.API_TLS_PORT, env.API_HOST, logger);
  }
}

void bootstrap();
