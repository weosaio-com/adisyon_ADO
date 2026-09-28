import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  MENU_IMAGE_MAX_BYTES,
  menuImageKey,
  menuImageKeySchema,
  sniffImageType,
} from '@ado/shared';
import { resolveDataDir } from '../common/util/data-dir';

/**
 * Urun gorselleri: `<veri dizini>/images/<sha256>.<uzanti>`. Dosya adi icerikten turedigi icin
 * ayni gorsel bir kez saklanir, dosya hic degismez (suresiz onbellek) ve bulutla ayni anahtari
 * kullanir. Tur, uzantiya degil dosya imzasina bakilarak belirlenir.
 */
export function imagesDir(): string {
  // Mutlak yol: res.sendFile goreli yolu reddeder (DATABASE_URL goreli olabilir).
  return resolve(resolveDataDir(), 'images');
}

const tooLarge = () =>
  new PayloadTooLargeException({
    code: 'IMAGE_TOO_LARGE',
    message: 'Görsel en fazla 1 MB olabilir.',
  });

/** Istek govdesini en fazla `limit` bayt okur; asarsa 413. */
export async function readLimited(
  body: Readable & { headers?: Record<string, string | string[] | undefined> },
  limit: number,
): Promise<Buffer> {
  const declared = Number(body.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > limit) throw tooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Gorseli dogrulayip saklar; gorsel anahtarini dondurur. */
export async function storeMenuImage(body: Readable): Promise<string> {
  const bytes = await readLimited(body, MENU_IMAGE_MAX_BYTES);
  const ext = sniffImageType(bytes);
  if (!ext) {
    throw new BadRequestException({
      code: 'IMAGE_TYPE_INVALID',
      message: 'Görsel JPEG, PNG ya da WebP olmalı.',
    });
  }
  const key = menuImageKey(createHash('sha256').update(bytes).digest('hex'), ext);
  const dir = imagesDir();
  const path = join(dir, key);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    // Once gecici dosyaya yaz, sonra tasi: yarim kalan yazma bozuk gorsel birakmaz.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
  return key;
}

/** Gecerli anahtarin dosya yolu; anahtar gecersizse ya da dosya yoksa null. */
export function menuImagePath(key: string): string | null {
  if (!menuImageKeySchema.safeParse(key).success) return null;
  const path = join(imagesDir(), key);
  return existsSync(path) ? path : null;
}
