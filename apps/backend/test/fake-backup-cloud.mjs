// Bulut yedegi uclarini taklit eden sahte sunucu (apps/cloud src/routes/backups.ts ile ayni
// sozlesme; R2 kurallari: tek parcada SHA-256 denetimi, multipart'ta esit parca, son parca kalan).
// POS'un bulut baglantisiyla yaptigi diger cagrilara (durum, lisans, yayin, heartbeat) zararsiz
// yanit verir ki baglanti dusmesin. Durum `state` uzerinden yonetilir (or. state.failNext = 1).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { verifyLicense } from '../../../scripts/license.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const BACKUP_TYPES = new Set(['auto', 'manual', 'pre_update']);

/**
 * `publicKey`: lisansla listede imza dogrulamasi (base64 SPKI). `tokens`: [posBelirteci, lisansId].
 */
export async function startFakeBackupCloud(cloudUrl, { publicKey, tokens = [] }) {
  const state = {
    tokens: new Map(tokens),
    /** `${lisans}/${posYedekId}` -> { licenseId, meta, bytes } */
    backups: new Map(),
    /** uploadId -> { licenseId, posBackupId, meta, partSize, parts: Map<no, {etag, bytes}> } */
    uploads: new Map(),
    /** Her yedek istegi: { method, kind, posBackupId, partNumber?, status, headers } */
    requests: [],
    /** Indirme jetonu -> anahtar; indirme sayaci. */
    downloads: new Map(),
    downloadCount: 0,
    /** Sonraki N yukleme istegi (tek parca ya da parca) 503 doner. */
    failNext: 0,
    /** { partNumber, times }: o parcanin yuklemesi `times` kez 503 doner. */
    failPart: null,
  };
  let seq = 0;
  const info = () => ({
    branch: { id: 'bulut-sube-yedek', name: 'Yedek Lokanta' },
    tenant: {
      name: 'Yedek Lokanta',
      status: 'active',
      plan: 'menu',
      planLabel: 'QR Menü',
      features: { 'qr.menu': true },
    },
    license: { id: [...state.tokens.values()][0] ?? null, expiresAt: '2099-01-15T00:00:00.000Z' },
  });
  const listFor = (licenseId) =>
    [...state.backups.values()]
      .filter((item) => item.licenseId === licenseId)
      .map((item) => item.meta)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const handle = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const ok = (data, status = 200) => send(status, { success: true, data });
    const fail = (status, code, message, details) =>
      send(status, { success: false, error: { code, message, ...(details ? { details } : {}) } });
    const json = () => JSON.parse(raw.toString() || '{}');
    const path = new URL(req.url, 'http://fake').pathname;

    // --- Belirtecsiz: yeni bilgisayar (lisansla liste ve kisa omurlu indirme) ---
    if (req.method === 'POST' && path === '/api/pos/backups/by-license') {
      const payload = verifyLicense(json().licenseKey, publicKey);
      if (!payload?.id)
        return fail(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      return ok({
        backups: listFor(payload.id).map((meta) => {
          const token = randomBytes(24).toString('base64url');
          state.downloads.set(token, `${payload.id}/${meta.posBackupId}`);
          return { ...meta, downloadUrl: `/api/pos/backups/download/${token}`, expiresAt };
        }),
      });
    }
    const download = /^\/api\/pos\/backups\/download\/([A-Za-z0-9_-]+)$/.exec(path);
    if (req.method === 'GET' && download) {
      const item = state.backups.get(state.downloads.get(download[1]));
      if (!item) return fail(404, 'DOWNLOAD_NOT_FOUND', 'İndirme bağlantısı geçersiz.');
      state.downloadCount++;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(item.bytes.length),
      });
      return res.end(item.bytes);
    }

    // --- POS belirteci ---
    const auth = req.headers.authorization ?? '';
    const licenseId = state.tokens.get(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!licenseId) return fail(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz.');

    // Bulut baglantisinin diger cagrilari: baglanti canli kalsin.
    if (req.method === 'GET' && path === '/api/pos/status') {
      return ok({ ...info(), menu: { version: seq }, tableCount: 0 });
    }
    if (req.method === 'PUT' && path === '/api/pos/license') return ok(info());
    if (req.method === 'POST' && path === '/api/pos/images/check') return ok({ missing: [] });
    if (req.method === 'PUT' && path === '/api/pos/menu') {
      return ok({ version: ++seq, updatedAt: new Date().toISOString() });
    }
    if (req.method === 'PUT' && path === '/api/pos/tables') return ok({ count: 0 });
    if (req.method === 'POST' && path === '/api/pos/heartbeat') {
      return ok({
        ...info(),
        remote: { state: 'active' },
        serverTime: new Date().toISOString(),
        menu: null,
      });
    }
    if (req.method === 'GET' && path === '/api/pos/backups') return ok(listFor(licenseId));

    const match =
      /^\/api\/pos\/backups\/([A-Za-z0-9_-]+)(?:\/(multipart|complete|parts\/(\d+)))?$/.exec(path);
    if (!match) return fail(404, 'NOT_FOUND', 'Kaynak bulunamadı.');
    const [, posBackupId, action, partText] = match;
    const key = `${licenseId}/${posBackupId}`;
    const existing = state.backups.get(key);
    const record = (kind, status, extra = {}) =>
      state.requests.push({
        method: req.method,
        kind,
        posBackupId,
        status,
        headers: req.headers,
        ...extra,
      });

    // Tek parca yukleme
    if (req.method === 'PUT' && !action) {
      if (state.failNext > 0) {
        state.failNext--;
        record('single', 503);
        return fail(503, 'UNAVAILABLE', 'Bulut bakımda.');
      }
      const meta = {
        id: `cb-${++seq}`,
        posBackupId,
        type: req.headers['x-ado-backup-type'],
        format: Number(req.headers['x-ado-backup-format']),
        sizeBytes: raw.length,
        sha256: String(req.headers['x-ado-sha256'] ?? ''),
        createdAt: new Date(String(req.headers['x-ado-created-at'])).toISOString(),
        uploadedAt: new Date().toISOString(),
      };
      if (!BACKUP_TYPES.has(meta.type) || ![1, 2].includes(meta.format)) {
        record('single', 400);
        return fail(400, 'BACKUP_META_INVALID', 'Yedek bilgileri eksik ya da geçersiz.');
      }
      if (sha256(raw) !== meta.sha256) {
        record('single', 400);
        return fail(400, 'BACKUP_CHECKSUM_MISMATCH', 'Özet eşleşmiyor.');
      }
      if (existing) {
        record('single', 200);
        return ok(existing.meta);
      }
      state.backups.set(key, { licenseId, meta, bytes: raw });
      record('single', 201);
      return ok(meta, 201);
    }

    // Multipart baslat
    if (req.method === 'POST' && action === 'multipart') {
      if (existing) {
        record('create', 409);
        return fail(409, 'BACKUP_ALREADY_UPLOADED', 'Bu yedek zaten bulutta.', existing.meta);
      }
      const body = json();
      const uploadId = `up-${++seq}`;
      state.uploads.set(uploadId, {
        licenseId,
        posBackupId,
        partSize: body.partSize,
        parts: new Map(),
        meta: {
          id: `cb-${seq}`,
          posBackupId,
          type: body.type,
          format: body.format,
          sizeBytes: body.sizeBytes,
          sha256: body.sha256,
          createdAt: new Date(body.createdAt).toISOString(),
          uploadedAt: null,
        },
      });
      record('create', 201);
      return ok({ uploadId, partSize: body.partSize }, 201);
    }

    const uploadIdOf = () => {
      if (req.headers['x-ado-upload-id']) return String(req.headers['x-ado-upload-id']);
      try {
        return String(json().uploadId ?? '');
      } catch {
        return '';
      }
    };
    const upload = state.uploads.get(uploadIdOf());
    // Parca yukle
    if (req.method === 'PUT' && action?.startsWith('parts/')) {
      const partNumber = Number(partText);
      if (
        state.failNext > 0 ||
        (state.failPart?.partNumber === partNumber && state.failPart.times > 0)
      ) {
        if (state.failNext > 0) state.failNext--;
        else state.failPart.times--;
        record('part', 503, { partNumber });
        return fail(503, 'UNAVAILABLE', 'Bulut bakımda.');
      }
      if (!upload || upload.licenseId !== licenseId || upload.posBackupId !== posBackupId) {
        record('part', 409, { partNumber });
        return fail(409, 'UPLOAD_ID_MISMATCH', 'Yükleme yenilenmiş.');
      }
      const count = Math.ceil(upload.meta.sizeBytes / upload.partSize);
      const expected =
        partNumber < count
          ? upload.partSize
          : upload.meta.sizeBytes - (count - 1) * upload.partSize;
      if (partNumber < 1 || partNumber > count || raw.length !== expected) {
        record('part', 400, { partNumber });
        return fail(400, 'PART_SIZE_INVALID', 'Parça boyu beklenenden farklı.');
      }
      const etag = md5(raw);
      upload.parts.set(partNumber, { etag, bytes: raw });
      record('part', 200, { partNumber });
      return ok({ partNumber, etag });
    }

    // Tamamla
    if (req.method === 'POST' && action === 'complete') {
      if (!upload) {
        record('complete', 404);
        return fail(404, 'UPLOAD_NOT_FOUND', 'Yükleme bulunamadı.');
      }
      const parts = [...json().parts].sort((a, b) => a.partNumber - b.partNumber);
      const count = Math.ceil(upload.meta.sizeBytes / upload.partSize);
      const valid =
        parts.length === count &&
        parts.every((p, i) => p.partNumber === i + 1 && upload.parts.get(i + 1)?.etag === p.etag);
      if (!valid) {
        record('complete', 400);
        return fail(400, 'PARTS_INVALID', 'Parça listesi eksik ya da hatalı.');
      }
      const bytes = Buffer.concat(parts.map((p) => upload.parts.get(p.partNumber).bytes));
      // Gercek bulut butun dosyanin ozetini dogrulayamaz; sahte bulut test icin dogrular.
      if (bytes.length !== upload.meta.sizeBytes || sha256(bytes) !== upload.meta.sha256) {
        record('complete', 400);
        return fail(400, 'BACKUP_SIZE_MISMATCH', 'Dosya bildirilenden farklı.');
      }
      const meta = { ...upload.meta, uploadedAt: new Date().toISOString() };
      state.backups.set(key, { licenseId, meta, bytes });
      state.uploads.delete(uploadIdOf());
      record('complete', 200);
      return ok(meta);
    }
    return fail(404, 'NOT_FOUND', 'Kaynak bulunamadı.');
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ success: false, error: { code: 'FAKE_ERROR', message: String(err) } }),
      );
    });
  });
  const { hostname, port } = new URL(cloudUrl);
  await new Promise((resolve) => server.listen(Number(port), hostname, resolve));
  return {
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
