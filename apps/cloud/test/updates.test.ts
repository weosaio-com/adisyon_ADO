import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { request } from './helpers';

const exe = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);

describe('program guncellemeleri /updates/:kanal/:dosya', () => {
  it('bildirim onbelleksiz, kurulum dosyasi suresiz; aralik istegi 206', async () => {
    const bucket = env.UPDATES!;
    await bucket.put('stable/ado-update.json', '{"format":"ADOU1"}');
    await bucket.put('stable/latest.yml', 'version: 0.3.1\n');
    await bucket.put('stable/Adisyon-POS-Setup-0.3.1.exe', exe);

    const manifest = await request('GET', '/updates/stable/ado-update.json');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('Cache-Control')).toBe('no-cache');
    expect(manifest.headers.get('Content-Type')).toContain('application/json');
    expect(await manifest.text()).toContain('ADOU1');

    const yml = await request('GET', '/updates/stable/latest.yml');
    expect(yml.headers.get('Cache-Control')).toBe('no-cache');
    const etag = yml.headers.get('ETag') ?? '';
    await yml.arrayBuffer();
    const cached = await request('GET', '/updates/stable/latest.yml', {
      headers: { 'If-None-Match': etag },
    });
    expect(cached.status).toBe(304);

    const full = await request('GET', '/updates/stable/Adisyon-POS-Setup-0.3.1.exe');
    expect(full.status).toBe(200);
    expect(full.headers.get('Cache-Control')).toContain('immutable');
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(exe);

    const part = await request('GET', '/updates/stable/Adisyon-POS-Setup-0.3.1.exe', {
      headers: { Range: 'bytes=100-199' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(exe.slice(100, 200));

    const tail = await request('GET', '/updates/stable/Adisyon-POS-Setup-0.3.1.exe', {
      headers: { Range: 'bytes=-10' },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(exe.slice(990));
  });

  it('bilinmeyen kanal, dosya ya da tur 404 (JSON)', async () => {
    for (const path of [
      '/updates/nightly/latest.yml',
      '/updates/stable/yok.exe',
      '/updates/stable/kurulum.sh',
      '/updates/stable/..%2Fsecret.json',
      '/updates/stable',
    ]) {
      const res = await request('GET', path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type'), path).toContain('application/json');
    }
  });
});
