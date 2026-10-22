import type { IncomingMessage, ServerResponse } from 'node:http';
import { startTime } from 'pino-http';

/** Bu sureden uzun suren istek basarili da olsa kayda yazilir (donma izi, PLT-14). */
export const SLOW_REQUEST_MS = 1_500;

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Istek kaydi seviyesi. Paketli surumde basarili istekler `debug` (dosyaya yazilmaz): her istek
 * (tabletlerin yoklamalari dahil) ~1 KB yaziyor, 20 MB'lik kayit birkac saatte donuyor, sabahki
 * donmanin izi aksama silinmis oluyordu. Yavas istekler ve veritabani mesgul (503) `warn`, diger
 * 5xx `error` (masaustu bunlari ayrica uzun omurlu olaylar kaydina yazar); 4xx `info`.
 */
export function requestLogLevel(
  statusCode: number,
  durationMs: number,
  failed: boolean,
  quietSuccess: boolean,
): Level {
  if (statusCode === 503) return 'warn';
  if (failed || statusCode >= 500) return 'error';
  if (durationMs >= SLOW_REQUEST_MS) return 'warn';
  if (statusCode >= 400) return 'info';
  return quietSuccess ? 'debug' : 'info';
}

/** pino-http `customLogLevel` kancasi. */
export function pinoRequestLevel(quietSuccess: boolean) {
  return (_req: IncomingMessage, res: ServerResponse, err?: Error): Level => {
    const started = (res as ServerResponse & { [startTime]?: number })[startTime];
    const duration = typeof started === 'number' ? Date.now() - started : 0;
    return requestLogLevel(res.statusCode, duration, Boolean(err), quietSuccess);
  };
}
