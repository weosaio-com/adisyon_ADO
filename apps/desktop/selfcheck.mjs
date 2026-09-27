// Masaustu kabugunun Electron'suz yardimcilari icin self-check: `node selfcheck.mjs`
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatingLog } from './rotating-log.mjs';

const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// --- rotatingLog: sinir asilinca .1'e doner ---
{
  const dir = tempDir('ado-log-');
  const path = join(dir, 'backend.log');
  const write = rotatingLog(path, 100);
  write(Buffer.from('a'.repeat(60)));
  write(Buffer.from('b'.repeat(60))); // 120 > 100 -> doner
  write(Buffer.from('c'.repeat(30))); // 90 <= 100 -> ayni dosya
  await write.close();
  assert.strictEqual(readFileSync(`${path}.1`, 'utf8'), 'a'.repeat(60), 'eski kisim .1de');
  assert.strictEqual(readFileSync(path, 'utf8'), 'b'.repeat(60) + 'c'.repeat(30), 'yeni kisim');
  rmSync(dir, { recursive: true, force: true });
}

// --- rotatingLog: eski surumden kalan dev log acilista kirpilir ---
{
  const dir = tempDir('ado-log-');
  const path = join(dir, 'backend.log');
  writeFileSync(path, 'x'.repeat(500) + 'SON-KAYIT');
  const write = rotatingLog(path, 100);
  await write.close();
  const tail = readFileSync(`${path}.1`, 'utf8');
  assert.strictEqual(tail.length, 100, 'yalniz son maxBytes tutulur');
  assert.ok(tail.endsWith('SON-KAYIT'), 'en yeni kayitlar korunur');
  assert.ok(!existsSync(path) || readFileSync(path).length === 0, 'dev dosya silinir');
  rmSync(dir, { recursive: true, force: true });
}

console.log('desktop selfcheck OK');
