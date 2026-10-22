import './bootstrap-env';
import { existsSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env.schema';
import { API_PREFIX } from './common/http/api-prefix';
import { resolveDataDir } from './common/util/data-dir';
import { currentTlsHosts, ensureTlsMaterial } from './tls/tls.certs';
import { DesktopBridgeService } from './desktop/desktop-bridge.service';

// Ucuz kontrol (birkac kucuk dosya): acilista ag henuz yoksa LAN IP'si en gec 1 dk'da eklenir.
const TLS_RECHECK_MS = 60_000;

/**
 * Tabletler icin yerel HTTPS (ayni Express ornegi, ayri port). Tarayici LAN IP'sini
 * ancak HTTPS ile "guvenli baglam" sayar; Service Worker (cevrimdisi acilis) buna bagli.
 * Hata POS'u dusurmez: loglanir, yalniz HTTP ile devam edilir (null doner).
 */
async function startHttps(
  handler: express.Express,
  port: number,
  host: string,
  logger: Logger,
): Promise<HttpsServer | null> {
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
    return server;
  } catch (err) {
    logger.error(
      `HTTPS baslatilamadi, yalniz HTTP ile devam: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // fail-fast: gecersiz .env ile baslamaz.

  // forceCloseConnections: kapanista acik baglantilar (SSE, keep-alive) beklenmeden kesilir.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    forceCloseConnections: true,
  });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Prisma BigInt alanlari (yedek boyutu) yanitlarda sayi olur; aksi halde res.json hata verir.
  app
    .getHttpAdapter()
    .getInstance()
    .set('json replacer', (_key: string, value: unknown) =>
      typeof value === 'bigint' ? Number(value) : value,
    );
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

  // Canlilik (masaustu bekcisi, PLT-12): veritabanina dokunmaz, yalniz surecin ve olay dongusunun
  // yanit verdigini gosterir. Uzun yedek/rapor sirasinda veritabani mesgul olsa da hemen 200 doner;
  // bekci yalniz gercekten askida kalan backend'i yeniden baslatir. Nest yonlendiricisinden once:
  // kimlik denetimi ve istek kaydi yok.
  app.use(
    `/${API_PREFIX}/health/live`,
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: { status: 'ok', uptimeSec: Math.round(process.uptime()) } });
    },
  );

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
  const https = env.API_TLS_PORT
    ? await startHttps(app.getHttpAdapter().getInstance(), env.API_TLS_PORT, env.API_HOST, logger)
    : null;

  // Masaustu kabugu kapanirken `shutdown` mesaji yollar; kabuk coker ve IPC kanali koparsa da
  // ayni sekilde kapanilir: baglantilar kesilir, Nest kapanis kancalari (Prisma) calisir. Boylece
  // port ve veritabani bir sonraki acilisa kilitli kalmaz.
  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    logger.log(`Kapaniyor: ${reason}`);
    https?.close();
    https?.closeAllConnections();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error(`Kapanis hatasi: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
  };
  app.get(DesktopBridgeService).onMessage((message) => {
    if (message.type === 'shutdown') shutdown('masaustu kabugu kapaniyor');
  });
  process.once('disconnect', () => shutdown('masaustu kabugu ile baglanti koptu'));
}

void bootstrap();
