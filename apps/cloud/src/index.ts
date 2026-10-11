import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import { ApiError, errorBody } from './lib/http';
import { adminRoutes } from './routes/admin';
import { posRoutes } from './routes/pos';
import { publicRoutes } from './routes/public';
import { updateRoutes } from './routes/updates';

/**
 * QR menu bulutu. Musteri sayfasi statik varliktir (qr-web); bu Worker yalniz /api/*, /img/* ve
 * /updates/* isteklerini karsilar (wrangler.jsonc: run_worker_first). Menuyu Adisyon programi (POS)
 * lisansla baglanip yayinlar; isletme paneli yoktur. Program guncellemeleri de buradan dagitilir.
 */
const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

// Menu en fazla ~2000 urun; gorseller ayrica 1 MB ile sinirli.
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => c.json(errorBody('PAYLOAD_TOO_LARGE', 'İstek çok büyük.'), 413),
  }),
);

app.get('/api/health', (c) => c.json({ success: true, data: { ok: true } }));
app.route('/', publicRoutes);
app.route('/', updateRoutes);
app.route('/api/pos', posRoutes);
app.route('/api/admin', adminRoutes);

app.notFound((c) => {
  if (['/api/', '/img/', '/updates/'].some((prefix) => c.req.path.startsWith(prefix))) {
    return c.json(errorBody('NOT_FOUND', 'Kaynak bulunamadı.'), 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    const code = err.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR';
    return c.json(errorBody(code, err.message || 'İstek reddedildi.'), err.status);
  }
  console.error(err);
  return c.json(errorBody('INTERNAL_ERROR', 'Sunucu hatası.'), 500);
});

export default app;
