import { join } from 'node:path';
import * as express from 'express';

/**
 * Paket dosyasi istegi mi: `/assets/` altinda ya da son parcasi uzantili (`/sw.js`,
 * `/workbox-x.js`, `/manifest.webmanifest`). Arayuz rotalarinda uzanti yok (`/orders/:id` ULID).
 */
export function isAssetRequest(path: string): boolean {
  if (path.startsWith('/assets/')) return true;
  return /\.[a-z0-9]+$/i.test(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Build edilmis arayuzu (frontend/dist) sunar: dosyalar; bulunamayan paket dosyasina 404; diger
 * GET isteklerine (SPA rotalari) index.html. Eskiden eksik paket dosyasi da 200 text/html ile
 * index.html donuyordu (OFF-7): guncellemeden sonra eski surumun dosyasini isteyen ya da onbellegi
 * yarim kalan tablet JS modulu yerine HTML alip beyaz ekranda kalabiliyordu.
 */
export function webStatic(webDist: string): express.RequestHandler[] {
  const index = join(webDist, 'index.html');
  return [
    express.static(webDist),
    (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      if (isAssetRequest(req.path)) {
        res.status(404).setHeader('Cache-Control', 'no-store');
        res.type('text/plain').send('Dosya bulunamadi.');
        return;
      }
      res.sendFile(index);
    },
  ];
}
