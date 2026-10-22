// Arayuz dosyalari ve SPA geri donusu (OFF-7): `ts-node --transpile-only src/common/http/web-static.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { isAssetRequest, webStatic } from './web-static';

async function main() {
  assert.strictEqual(isAssetRequest('/assets/index-ABC.js'), true);
  assert.strictEqual(isAssetRequest('/assets/'), true);
  assert.strictEqual(isAssetRequest('/workbox-9c191d2f.js'), true);
  assert.strictEqual(isAssetRequest('/manifest.webmanifest'), true);
  assert.strictEqual(isAssetRequest('/'), false);
  assert.strictEqual(isAssetRequest('/orders/01M5J64XSH58HBW5MKESSX2RKX'), false);
  assert.strictEqual(isAssetRequest('/settings'), false);

  const dist = mkdtempSync(join(tmpdir(), 'ado-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>POS</title>');
  writeFileSync(join(dist, 'assets', 'index-NEW.js'), 'console.log(1)');
  const app = express();
  app.use(...webStatic(dist));
  app.use((_req, res) => res.status(418).send('sonraki'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, method = 'GET') => {
    const res = await fetch(base + path, { method });
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      body: await res.text(),
    };
  };
  try {
    const asset = await get('/assets/index-NEW.js');
    assert.strictEqual(asset.status, 200);
    assert.match(asset.type, /javascript/);
    // Eski surumun (ya da eksik) paket dosyasi: HTML degil 404.
    const missing = await get('/assets/index-OLD.js');
    assert.strictEqual(missing.status, 404);
    assert.match(missing.type, /text\/plain/);
    assert.strictEqual((await get('/workbox-eski.js')).status, 404);
    // SPA rotalari index.html alir.
    for (const path of ['/', '/settings', '/orders/01M5J64XSH58HBW5MKESSX2RKX']) {
      const page = await get(path);
      assert.strictEqual(page.status, 200, path);
      assert.match(page.type, /text\/html/, path);
    }
    // API ve GET disi istekler arayuze dusmez (Nest'e gecer).
    assert.strictEqual((await get('/api/v1/yok')).status, 418);
    assert.strictEqual((await get('/settings', 'POST')).status, 418);
  } finally {
    server.close();
    rmSync(dist, { recursive: true, force: true });
  }
  console.log('✓ web-static self-check');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
