import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_BACKUP_HEADERS,
  CLOUD_BACKUP_MIN_PART_BYTES,
  planCloudBackupRetention,
} from '@ado/shared/cloud-api';
import app from '../src/index';
import { licenseFeatureOverrides, planFromLicense, tenantFeatures } from '../src/lib/plans';
import {
  activatedBranch,
  ADMIN_TOKEN,
  call,
  licensePayload,
  ORIGIN,
  request,
  sha256Hex,
  signLicense,
  unique,
} from './helpers';

const H = CLOUD_BACKUP_HEADERS;
const MIB = 1024 * 1024;
const bucket = () => env.BACKUPS!;
const objectKey = (licenseId: string, posBackupId: string) =>
  `backups/${licenseId}/${posBackupId}.adobak`;

/** Hizli, tekrarlanabilir icerik (seed farkli dosya uretir). */
function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return out;
}

const backupId = () => unique('BK').replace(/[^A-Za-z0-9_-]/g, '');

/** Uzunlugu bilinmeyen govde (chunked gibi; sabit boylu govdeye calisma zamani uzunluk ekler). */
function unknownLength(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

interface UploadOpts {
  sha256?: string;
  type?: string;
  format?: string;
  createdAt?: string;
  /** Bildirilen boy (varsayilan govdenin gercek boyu). */
  contentLength?: string;
}

async function upload(token: string, posBackupId: string, body: Uint8Array, opts: UploadOpts = {}) {
  return call('PUT', `/api/pos/backups/${posBackupId}`, {
    token,
    body,
    headers: {
      'Content-Length': opts.contentLength ?? String(body.length),
      [H.sha256]: opts.sha256 ?? (await sha256Hex(body)),
      [H.type]: opts.type ?? 'auto',
      [H.format]: opts.format ?? '2',
      [H.createdAt]: opts.createdAt ?? new Date().toISOString(),
    },
  });
}

/** JSON govde + Content-Length (bulut yedegi uclari uzunluk ister). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postJson<T = any>(
  path: string,
  json: unknown,
  opts: { token?: string; ip?: string } = {},
) {
  const text = JSON.stringify(json);
  return call<T>('POST', path, {
    body: text,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.ip ? { ip: opts.ip } : {}),
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(text).length),
    },
  });
}

function putPart(
  token: string,
  posBackupId: string,
  partNumber: number | string,
  body: Uint8Array,
  uploadId: string,
) {
  return call('PUT', `/api/pos/backups/${posBackupId}/parts/${partNumber}`, {
    token,
    body,
    headers: { 'Content-Length': String(body.length), [H.uploadId]: uploadId },
  });
}

async function createMultipart(
  token: string,
  posBackupId: string,
  data: Uint8Array,
  partSize = CLOUD_BACKUP_MIN_PART_BYTES,
) {
  return postJson(
    `/api/pos/backups/${posBackupId}/multipart`,
    {
      sizeBytes: data.length,
      sha256: await sha256Hex(data),
      type: 'manual',
      format: 2,
      createdAt: new Date().toISOString(),
      partSize,
    },
    { token },
  );
}

/** Lisans kaydi (bu dalda etkinlestirme yazmaz): kota ya da iptal icin. */
async function setLicenseRow(
  licenseId: string,
  fields: { quota?: number | null; revokedAt?: string | null },
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO licenses (id, license_key, customer, exp, grace_days, expires_at, features, source,
       revoked_at, backup_quota_bytes, created_at, updated_at)
     VALUES (?1, 'ADO1.test.kaydi', 'Test', '2099-01-01', 0, '2099-01-01T00:00:00.000Z', '{}',
       'admin', ?2, ?3, ?4, ?4)
     ON CONFLICT (id) DO UPDATE SET revoked_at = excluded.revoked_at,
       backup_quota_bytes = excluded.backup_quota_bytes`,
  )
    .bind(licenseId, fields.revokedAt ?? null, fields.quota ?? null, now)
    .run();
}

/** Dogrudan D1 + R2'ye tamamlanmis yedek (saklama testi icin). */
async function seedBackup(licenseId: string, posBackupId: string, createdAt: string) {
  const key = objectKey(licenseId, posBackupId);
  await bucket().put(key, new Uint8Array(10));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO cloud_backups (id, license_id, pos_backup_id, r2_key, backup_type, format,
       size_bytes, sha256, pos_created_at, status, created_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, 'auto', 2, 10, ?5, ?6, 'complete', ?6, ?6)`,
  )
    .bind(id, licenseId, posBackupId, key, 'b'.repeat(64), createdAt)
    .run();
  return { id, createdAt, key };
}

async function remainingIds(licenseId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM cloud_backups WHERE license_id = ? AND status = 'complete'",
  )
    .bind(licenseId)
    .all<{ id: string }>();
  return results.map((row) => row.id).sort();
}

describe('bulut yedegi: tek parca yukleme', () => {
  it('sha256 dogruysa saklanir, listelenir, indirilir; ayni yedek ikinci kez ayni kaydi dondurur', async () => {
    const b = await activatedBranch();
    const id = backupId();
    const data = bytes(2048);
    const createdAt = '2026-10-14T09:00:00+03:00';

    const res = await upload(b.token, id, data, { createdAt });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      posBackupId: id,
      type: 'auto',
      format: 2,
      sizeBytes: 2048,
      sha256: await sha256Hex(data),
      createdAt: '2026-10-14T06:00:00.000Z',
    });
    expect(res.body.data.uploadedAt).toEqual(expect.any(String));
    const stored = await bucket().get(objectKey(b.licenseId, id));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(data);

    const again = await upload(b.token, id, data, { createdAt });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(res.body.data.id);

    const list = await call('GET', '/api/pos/backups', { token: b.token });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([res.body.data]);

    const download = await request('GET', `/api/pos/backups/${res.body.data.id}/download`, {
      token: b.token,
    });
    expect(download.status).toBe(200);
    expect(download.headers.get(H.sha256)).toBe(await sha256Hex(data));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(data);

    // Ayni kimlikle farkli icerik: ustune yazilmaz.
    const conflict = await upload(b.token, id, bytes(2048, 9));
    expect([conflict.status, conflict.body.error?.code]).toEqual([409, 'BACKUP_CONFLICT']);
  });

  it('sha256 uyusmazsa 400 BACKUP_CHECKSUM_MISMATCH ve hicbir sey saklanmaz', async () => {
    const b = await activatedBranch();
    const id = backupId();
    const res = await upload(b.token, id, bytes(4096), { sha256: 'a'.repeat(64) });
    expect([res.status, res.body.error?.code]).toEqual([400, 'BACKUP_CHECKSUM_MISMATCH']);
    expect(await bucket().head(objectKey(b.licenseId, id))).toBeNull();
    expect((await call('GET', '/api/pos/backups', { token: b.token })).body.data).toEqual([]);
  });

  it('eksik/gecersiz baslik, bos govde ve gecersiz kimlik 400', async () => {
    const b = await activatedBranch();
    const data = bytes(100);
    const cases: Array<[UploadOpts, string]> = [
      [{ type: 'imported' }, 'BACKUP_META_INVALID'],
      [{ format: '3' }, 'BACKUP_META_INVALID'],
      [{ createdAt: 'dun' }, 'BACKUP_META_INVALID'],
      [{ sha256: 'kisa' }, 'BACKUP_META_INVALID'],
    ];
    for (const [opts, code] of cases) {
      const res = await upload(b.token, backupId(), data, opts);
      expect([res.status, res.body.error?.code], JSON.stringify(opts)).toEqual([400, code]);
    }
    const empty = await upload(b.token, backupId(), new Uint8Array(0));
    expect([empty.status, empty.body.error?.code]).toEqual([400, 'BACKUP_EMPTY']);
    const badId = await upload(b.token, 'kotu.kimlik', data);
    expect([badId.status, badId.body.error?.code]).toEqual([400, 'BACKUP_ID_INVALID']);
  });
});

describe('bulut yedegi: govde siniri', () => {
  it('5 MB ustu yedek kabul edilir ama baska /api uclarinda 413; uzunluksuz 411, 95 MB ustu 413', async () => {
    const b = await activatedBranch();
    const big = bytes(6 * MIB);
    const res = await upload(b.token, backupId(), big);
    expect(res.status).toBe(201);
    expect(res.body.data.sizeBytes).toBe(6 * MIB);

    const menu = await call('PUT', '/api/pos/menu', {
      token: b.token,
      body: big,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(big.length) },
    });
    expect([menu.status, menu.body.error?.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    // Uzunlugu bilinmeyen akis (chunked): R2 kabul etmez, 411.
    const data = bytes(100);
    const chunked = await call('PUT', `/api/pos/backups/${backupId()}`, {
      token: b.token,
      body: unknownLength(data),
      headers: {
        [H.sha256]: await sha256Hex(data),
        [H.type]: 'auto',
        [H.format]: '2',
        [H.createdAt]: new Date().toISOString(),
      },
    });
    expect([chunked.status, chunked.body.error?.code]).toEqual([411, 'LENGTH_REQUIRED']);

    const tooBig = await upload(b.token, backupId(), bytes(100), { contentLength: '95000001' });
    expect([tooBig.status, tooBig.body.error?.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    const jsonNoLength = await call('POST', `/api/pos/backups/${backupId()}/multipart`, {
      token: b.token,
      body: unknownLength(new TextEncoder().encode('{"sizeBytes":10}')),
      headers: { 'Content-Type': 'application/json' },
    });
    expect([jsonNoLength.status, jsonNoLength.body.error?.code]).toEqual([411, 'LENGTH_REQUIRED']);
  });
});

describe('bulut yedegi: multipart', () => {
  it('5 MiB + 1 KiB: parcalar yuklenir, tamamlaninca listede; indirilen dosya ayni', async () => {
    const b = await activatedBranch();
    const id = backupId();
    const data = bytes(CLOUD_BACKUP_MIN_PART_BYTES + 1024, 3);

    const created = await createMultipart(b.token, id, data);
    expect(created.status).toBe(201);
    const { uploadId, partSize } = created.body.data;
    expect(partSize).toBe(CLOUD_BACKUP_MIN_PART_BYTES);
    const row = await env.DB.prepare(
      'SELECT status, upload_id FROM cloud_backups WHERE license_id = ? AND pos_backup_id = ?',
    )
      .bind(b.licenseId, id)
      .first();
    expect(row).toEqual({ status: 'uploading', upload_id: uploadId });
    // Tamamlanmayan yukleme listede gorunmez.
    expect((await call('GET', '/api/pos/backups', { token: b.token })).body.data).toEqual([]);

    const p1 = await putPart(b.token, id, 1, data.slice(0, partSize), uploadId);
    expect(p1.status).toBe(200);
    expect(p1.body.data).toMatchObject({ partNumber: 1, etag: expect.any(String) });
    const p2 = await putPart(b.token, id, 2, data.slice(partSize), uploadId);
    expect(p2.status).toBe(200);

    const done = await postJson(
      `/api/pos/backups/${id}/complete`,
      { uploadId, parts: [p2.body.data, p1.body.data] },
      { token: b.token },
    );
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      posBackupId: id,
      type: 'manual',
      sizeBytes: data.length,
      sha256: await sha256Hex(data),
      uploadedAt: expect.any(String),
    });
    const stored = await bucket().get(objectKey(b.licenseId, id));
    expect(await sha256Hex(new Uint8Array(await stored!.arrayBuffer()))).toBe(
      await sha256Hex(data),
    );
    const list = await call('GET', '/api/pos/backups', { token: b.token });
    expect(list.body.data).toEqual([done.body.data]);

    // Tamamlanmis yedek yeniden baslatilamaz: POS bunu "zaten bulutta" sayar.
    const again = await createMultipart(b.token, id, data);
    expect([again.status, again.body.error?.code]).toEqual([409, 'BACKUP_ALREADY_UPLOADED']);
    expect((again.body.error?.details as { id: string }).id).toBe(done.body.data.id);
  });

  it('esit olmayan parca, gecersiz numara, eski kimlik ve eksik/hatali parca listesi reddedilir', async () => {
    const b = await activatedBranch();
    const id = backupId();
    const size = 2 * CLOUD_BACKUP_MIN_PART_BYTES + 10;
    const data = bytes(size, 5);
    const created = await createMultipart(b.token, id, data);
    const { uploadId, partSize } = created.body.data;

    const short = await putPart(b.token, id, 1, data.slice(0, partSize - 1), uploadId);
    expect([short.status, short.body.error?.code]).toEqual([400, 'PART_SIZE_INVALID']);
    const lastTooBig = await putPart(b.token, id, 3, data.slice(0, 11), uploadId);
    expect([lastTooBig.status, lastTooBig.body.error?.code]).toEqual([400, 'PART_SIZE_INVALID']);
    for (const n of [0, 4, 'x']) {
      const res = await putPart(b.token, id, n, data.slice(0, 10), uploadId);
      expect([res.status, res.body.error?.code], String(n)).toEqual([400, 'PART_NUMBER_INVALID']);
    }
    const wrongUpload = await putPart(b.token, id, 1, data.slice(0, partSize), 'baska-yukleme');
    expect([wrongUpload.status, wrongUpload.body.error?.code]).toEqual([409, 'UPLOAD_ID_MISMATCH']);

    const parts = [];
    for (const [n, start, end] of [
      [1, 0, partSize],
      [2, partSize, 2 * partSize],
      [3, 2 * partSize, size],
    ] as const) {
      const res = await putPart(b.token, id, n, data.slice(start, end), uploadId);
      expect(res.status).toBe(200);
      parts.push(res.body.data);
    }
    const missing = await postJson(
      `/api/pos/backups/${id}/complete`,
      { uploadId, parts: parts.slice(0, 2) },
      { token: b.token },
    );
    expect([missing.status, missing.body.error?.code]).toEqual([400, 'PARTS_INVALID']);
    const badEtag = await postJson(
      `/api/pos/backups/${id}/complete`,
      { uploadId, parts: [parts[0], { partNumber: 2, etag: 'uydurma' }, parts[2]] },
      { token: b.token },
    );
    expect([badEtag.status, badEtag.body.error?.code]).toEqual([400, 'PARTS_INVALID']);

    const done = await postJson(
      `/api/pos/backups/${id}/complete`,
      { uploadId, parts },
      { token: b.token },
    );
    expect(done.status).toBe(200);
    expect(done.body.data.sizeBytes).toBe(size);
  });

  it('yeniden baslatma eski yarim yuklemeyi iptal eder (ayni lisansin diger yarim yuklemeleri de)', async () => {
    const b = await activatedBranch();
    const id = backupId();
    const data = bytes(CLOUD_BACKUP_MIN_PART_BYTES + 100, 7);
    const first = (await createMultipart(b.token, id, data)).body.data;
    expect(
      (await putPart(b.token, id, 1, data.slice(0, first.partSize), first.uploadId)).status,
    ).toBe(200);
    const second = (await createMultipart(b.token, id, data)).body.data;
    expect(second.uploadId).not.toBe(first.uploadId);

    const stale = await putPart(b.token, id, 1, data.slice(0, first.partSize), first.uploadId);
    expect([stale.status, stale.body.error?.code]).toEqual([409, 'UPLOAD_ID_MISMATCH']);
    // R2'deki eski yukleme de iptal edildi.
    await expect(
      bucket().resumeMultipartUpload(objectKey(b.licenseId, id), first.uploadId).uploadPart(1, 'x'),
    ).rejects.toThrow();

    // Baska yedegin yuklemesi baslayinca bu yarim yukleme de iptal edilir.
    const other = backupId();
    expect((await createMultipart(b.token, other, data)).status).toBe(201);
    const orphan = await putPart(b.token, id, 1, data.slice(0, second.partSize), second.uploadId);
    expect([orphan.status, orphan.body.error?.code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
  });
});

describe('bulut yedegi: saklama ve kota', () => {
  it('en yeni 30 + son 12 ayin her birinin en yenisi kalir; gerisi R2 ve kayitlardan silinir', async () => {
    const b = await activatedBranch();
    const now = Date.now();
    const seeded = [];
    // 31 yeni yedek (milisaniye arayla) + 14 ay boyunca ayin 15'inde birer yedek.
    for (let k = 1; k <= 31; k++) {
      seeded.push(await seedBackup(b.licenseId, `R${k}`, new Date(now - k).toISOString()));
    }
    const today = new Date(now);
    for (let m = 1; m <= 14; m++) {
      const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 15, 12));
      seeded.push(await seedBackup(b.licenseId, `M${m}`, date.toISOString()));
    }

    const res = await upload(b.token, 'YENI', bytes(50));
    expect(res.status).toBe(201);

    const all = [...seeded, { id: res.body.data.id, createdAt: res.body.data.createdAt, key: '' }];
    const expected = planCloudBackupRetention(all, new Date());
    expect(await remainingIds(b.licenseId)).toEqual([...expected].sort());
    // Yeni yedek + 29 yeni + 11 aylik (son 12 ay: bu ay ve onceki 11).
    expect(expected.size).toBe(41);
    for (const item of seeded) {
      const head = await bucket().head(item.key);
      expect(head === null, item.key).toBe(!expected.has(item.id));
    }
    expect(expected.has(seeded.find((s) => s.key.endsWith('/M11.adobak'))!.id)).toBe(true);
    expect(expected.has(seeded.find((s) => s.key.endsWith('/M12.adobak'))!.id)).toBe(false);
  });

  it('kota: saklamadan sonra toplam kotayi asacaksa 413 BACKUP_QUOTA_EXCEEDED (yuklemeden once)', async () => {
    const b = await activatedBranch();
    await setLicenseRow(b.licenseId, { quota: 3000 });
    expect((await upload(b.token, backupId(), bytes(2000))).status).toBe(201);
    const over = await upload(b.token, backupId(), bytes(2000, 2));
    expect([over.status, over.body.error?.code]).toEqual([413, 'BACKUP_QUOTA_EXCEEDED']);
    expect(over.body.error?.details).toEqual({ quotaBytes: 3000, requiredBytes: 4000 });
    const big = await createMultipart(b.token, backupId(), bytes(CLOUD_BACKUP_MIN_PART_BYTES + 1));
    expect([big.status, big.body.error?.code]).toEqual([413, 'BACKUP_QUOTA_EXCEEDED']);
    // Kota kaldirilinca (varsayilan 10 GB) yeniden yuklenir.
    await setLicenseRow(b.licenseId, { quota: null });
    expect((await upload(b.token, backupId(), bytes(2000, 2))).status).toBe(201);
  });
});

describe('bulut yedegi: yeni bilgisayar (lisansla liste ve indirme)', () => {
  async function branchWithBackup() {
    const payload = licensePayload();
    const b = await activatedBranch(payload);
    const data = bytes(3000, 11);
    const res = await upload(b.token, backupId(), data);
    expect(res.status).toBe(201);
    return { b, payload, data, meta: res.body.data };
  }

  it('imzali lisansla liste ve 15 dk indirme baglantisi; suresi dolan 410, bilinmeyen 404', async () => {
    const { payload, data, meta } = await branchWithBackup();
    const licenseKey = await signLicense(payload);
    const res = await postJson(
      '/api/pos/backups/by-license',
      { licenseKey, installId: unique('inst') },
      { ip: unique('ip') },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.backups).toHaveLength(1);
    const item = res.body.data.backups[0];
    expect(item).toMatchObject({ ...meta, expiresAt: expect.any(String) });
    expect(item.downloadUrl).toMatch(/^\/api\/pos\/backups\/download\/[A-Za-z0-9_-]{40,}$/);
    const ttl = Date.parse(item.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
    // Jetonun kendisi saklanmaz, yalniz ozeti.
    const token = item.downloadUrl.split('/').pop();
    const stored = await env.DB.prepare(
      'SELECT token_hash FROM cloud_backup_downloads WHERE backup_id = ?',
    )
      .bind(meta.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(await sha256Hex(new TextEncoder().encode(token)));
    expect(stored?.token_hash).not.toBe(token);

    const download = await request('GET', item.downloadUrl);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(data);

    await env.DB.prepare('UPDATE cloud_backup_downloads SET expires_at = ? WHERE backup_id = ?')
      .bind('2000-01-01T00:00:00.000Z', meta.id)
      .run();
    const expired = await call('GET', item.downloadUrl);
    expect([expired.status, expired.body.error?.code]).toEqual([410, 'DOWNLOAD_EXPIRED']);
    const unknown = await call('GET', '/api/pos/backups/download/bilinmeyen-jeton-0123456789abc');
    expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'DOWNLOAD_NOT_FOUND']);

    // Sonraki liste istegi suresi dolan jetonlari temizler.
    await postJson(
      '/api/pos/backups/by-license',
      { licenseKey, installId: unique('inst') },
      { ip: unique('ip') },
    );
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM cloud_backup_downloads WHERE expires_at < ?',
    )
      .bind(new Date().toISOString())
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('suresi dolmus lisans da listeler (veri rehin tutulmaz); gecersiz lisans reddedilir', async () => {
    const { payload, meta } = await branchWithBackup();
    const expiredKey = await signLicense({ ...payload, exp: '2020-01-01', g: 0 });
    const res = await postJson(
      '/api/pos/backups/by-license',
      { licenseKey: expiredKey, installId: unique('inst') },
      { ip: unique('ip') },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.backups.map((item: { id: string }) => item.id)).toEqual([meta.id]);

    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    );
    const foreign = await signLicense(payload, btoa(String.fromCharCode(...pkcs8)));
    const cases: Array<[unknown, number, string]> = [
      [{ licenseKey: foreign, installId: unique('inst') }, 400, 'LICENSE_INVALID'],
      [
        { licenseKey: await signLicense({ ...payload, id: undefined }), installId: unique('inst') },
        400,
        'LICENSE_ID_REQUIRED',
      ],
      [{ licenseKey: expiredKey, installId: 'kisa' }, 422, 'VALIDATION_ERROR'],
    ];
    for (const [json, status, code] of cases) {
      const r = await postJson('/api/pos/backups/by-license', json, { ip: unique('ip') });
      expect([r.status, r.body.error?.code]).toEqual([status, code]);
    }
  });

  it('iptal edilen lisans: lisansla liste, yukleme ve liste 403 LICENSE_REVOKED', async () => {
    const { b, payload } = await branchWithBackup();
    await setLicenseRow(b.licenseId, { revokedAt: new Date().toISOString() });
    const list = await postJson(
      '/api/pos/backups/by-license',
      { licenseKey: await signLicense(payload), installId: unique('inst') },
      { ip: unique('ip') },
    );
    expect([list.status, list.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    const up = await upload(b.token, backupId(), bytes(10));
    expect([up.status, up.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    const own = await call('GET', '/api/pos/backups', { token: b.token });
    expect([own.status, own.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
  });

  it("ayni IP'den lisansla liste denemeleri sinirlanir (429)", async () => {
    const ip = unique('ip');
    const json = { licenseKey: 'ADO1.x.yeterince-uzun-deneme', installId: unique('inst') };
    for (let i = 0; i < 10; i++) {
      const res = await postJson('/api/pos/backups/by-license', json, { ip });
      expect(res.status).toBe(400);
    }
    const limited = await postJson('/api/pos/backups/by-license', json, { ip });
    expect([limited.status, limited.body.error?.code]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
  });
});

describe('bulut yedegi: kapi', () => {
  it('belirtecsiz ya da gecersiz belirtecle her POS ucu 401', async () => {
    const body = bytes(16);
    const len = { 'Content-Length': String(body.length) };
    const routes: Array<[string, string, Record<string, string>]> = [
      ['GET', '/api/pos/backups', {}],
      ['GET', '/api/pos/backups/herhangi/download', {}],
      ['PUT', '/api/pos/backups/BK1', len],
      ['POST', '/api/pos/backups/BK1/multipart', len],
      ['PUT', '/api/pos/backups/BK1/parts/1', len],
      ['POST', '/api/pos/backups/BK1/complete', len],
    ];
    for (const token of [undefined, 'adoqr_pos_yanlis-belirtec']) {
      for (const [method, path, headers] of routes) {
        const res = await call(method, path, {
          ...(token ? { token } : {}),
          headers,
          ...(method === 'GET' ? {} : { body }),
        });
        expect([res.status, res.body.error?.code], `${method} ${path}`).toEqual([
          401,
          'POS_TOKEN_INVALID',
        ]);
      }
    }
  });

  it('lisansta cloud.backup: false ise yukleme ve liste 403 CLOUD_BACKUP_NOT_LICENSED', async () => {
    const b = await activatedBranch({ f: { 'qr.menu': true, 'cloud.backup': false } });
    const up = await upload(b.token, backupId(), bytes(10));
    expect([up.status, up.body.error?.code]).toEqual([403, 'CLOUD_BACKUP_NOT_LICENSED']);
    const list = await call('GET', '/api/pos/backups', { token: b.token });
    expect([list.status, list.body.error?.code]).toEqual([403, 'CLOUD_BACKUP_NOT_LICENSED']);
    const status = await call('GET', '/api/pos/status', { token: b.token });
    expect(status.body.data.tenant.features['cloud.backup']).toBe(false);
  });

  it('askiya alinan isletme ve suresi dolan lisans 403', async () => {
    const suspended = await activatedBranch();
    await call('PATCH', `/api/admin/tenants/${suspended.tenantId}`, {
      admin: true,
      json: { status: 'suspended' },
    });
    const a = await upload(suspended.token, backupId(), bytes(10));
    expect([a.status, a.body.error?.code]).toEqual([403, 'TENANT_SUSPENDED']);

    const expired = await activatedBranch();
    await env.DB.prepare('UPDATE tenants SET license_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', expired.tenantId)
      .run();
    const e = await upload(expired.token, backupId(), bytes(10));
    expect([e.status, e.body.error?.code]).toEqual([403, 'LICENSE_EXPIRED']);
  });

  it('BACKUPS baglantisi yoksa 503 BACKUPS_DISABLED', async () => {
    const noBucket = { ...env, BACKUPS: undefined };
    const routes: Array<[string, string]> = [
      ['GET', '/api/pos/backups'],
      ['POST', '/api/pos/backups/by-license'],
      ['GET', '/api/pos/backups/download/bilinmeyen-jeton-0123456789abc'],
    ];
    for (const [method, path] of routes) {
      const res = await app.fetch(
        new Request(ORIGIN + path, {
          method,
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Length': '0' },
        }),
        noBucket,
      );
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'BACKUPS_DISABLED',
      );
    }
  });
});

describe('paketler: cloud.backup varsayilan acik', () => {
  it('anahtarsiz eski kiraci ve QR menusuz (none) paket acik; acikca false kapali', async () => {
    const active = { status: 'active', license_expires_at: '2099-01-15T00:00:00.000Z' };
    const old = JSON.stringify({ 'qr.menu': true, 'qr.order': false, 'qr.games': false });
    expect(tenantFeatures({ ...active, plan: 'menu', features: old })['cloud.backup']).toBe(true);
    expect(tenantFeatures({ ...active, plan: 'none', features: '{}' })['cloud.backup']).toBe(true);
    expect(
      tenantFeatures({ ...active, plan: 'menu', features: '{"cloud.backup":false}' })[
        'cloud.backup'
      ],
    ).toBe(false);
    expect(
      tenantFeatures({ ...active, status: 'suspended', plan: 'menu', features: old })[
        'cloud.backup'
      ],
    ).toBe(false);

    expect(licenseFeatureOverrides(undefined)['cloud.backup']).toBe(true);
    expect(licenseFeatureOverrides({ 'qr.menu': true })).toMatchObject({
      'qr.menu': true,
      'qr.order': false,
      'cloud.backup': true,
    });
    expect(licenseFeatureOverrides({ 'cloud.backup': false })['cloud.backup']).toBe(false);
    const allQr = { 'qr.menu': true, 'qr.order': true, 'qr.pay': true, 'qr.split': true };
    expect(planFromLicense({ ...allQr, 'qr.games': true })).toBe('full');
    expect(planFromLicense({ 'cloud.backup': true })).toBe('none');
  });

  it('etkinlestirilen isletmede acik; ozellikleri eski bicimde olan kiraci da yukleyebilir', async () => {
    const b = await activatedBranch();
    const status = await call('GET', '/api/pos/status', { token: b.token });
    expect(status.body.data.tenant.features['cloud.backup']).toBe(true);
    await env.DB.prepare('UPDATE tenants SET features = ? WHERE id = ?')
      .bind('{"qr.menu":true,"qr.order":false}', b.tenantId)
      .run();
    expect((await upload(b.token, backupId(), bytes(10))).status).toBe(201);
  });
});

describe('saklama kurali (planCloudBackupRetention)', () => {
  it('en yeni 30 + son 12 takvim ayinin en yenisi; 12 aydan eski aylar ve gelecek ay sayilmaz', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const items: Array<{ id: string; createdAt: string }> = [];
    // 40 gunluk yedek: 2026-10-14'ten geriye (en yeni 30'u 2026-09-15..2026-10-14).
    for (let d = 0; d < 40; d++) {
      items.push({
        id: `gun-${d}`,
        createdAt: new Date(Date.UTC(2026, 9, 14 - d, 6)).toISOString(),
      });
    }
    // 2024-11 .. 2026-08 arasi her ay iki yedek (ayin 3'u ve 20'si).
    for (let m = 0; m < 22; m++) {
      const year = 2024 + Math.floor((10 + m) / 12);
      const month = (10 + m) % 12;
      items.push({
        id: `ay-${year}-${month + 1}-a`,
        createdAt: new Date(Date.UTC(year, month, 3)).toISOString(),
      });
      items.push({
        id: `ay-${year}-${month + 1}-b`,
        createdAt: new Date(Date.UTC(year, month, 20)).toISOString(),
      });
    }
    items.push({ id: 'bozuk', createdAt: 'tarih-degil' });

    const keep = planCloudBackupRetention(items, now);
    for (let d = 0; d < 30; d++) expect(keep.has(`gun-${d}`), `gun-${d}`).toBe(true);
    // gun-30..39 (2026-09-05..14): Eylul'un en yenisi zaten en yeni 30'da (gun-29 = 09-15).
    for (let d = 30; d < 40; d++) expect(keep.has(`gun-${d}`), `gun-${d}`).toBe(false);
    // Son 12 ay: 2025-11 .. 2026-10. Agustos 2026'ya kadar her ayin en yenisi (20'si) kalir.
    for (const [year, month] of [
      [2025, 11],
      [2025, 12],
      [2026, 1],
      [2026, 8],
    ]) {
      expect(keep.has(`ay-${year}-${month}-b`), `${year}-${month}-b`).toBe(true);
      expect(keep.has(`ay-${year}-${month}-a`), `${year}-${month}-a`).toBe(false);
    }
    // 2025-10 ve oncesi 12 ayin disinda.
    expect(keep.has('ay-2025-10-b')).toBe(false);
    expect(keep.has('ay-2024-11-b')).toBe(false);
    expect(keep.has('bozuk')).toBe(false);
    // 30 gunluk + 10 aylik (2025-11..2026-08).
    expect(keep.size).toBe(40);

    // Gelecek tarihli yedek (yanlis saat) en yeni sayilir.
    const future = planCloudBackupRetention(
      [
        { id: 'gelecek', createdAt: '2026-11-02T00:00:00.000Z' },
        { id: 'simdi', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
      now,
    );
    expect([...future].sort()).toEqual(['gelecek', 'simdi']);
  });
});
