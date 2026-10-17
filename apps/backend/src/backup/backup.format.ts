import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { aesKey, BACKUP_HEADER_BYTES, decryptBackup } from './backup.keys';

/**
 * Yedek dosya bicimi v2 (akis):
 *   baslik = MAGIC(8: "ADOBAK2\0") + surum(1: 2) + bayraklar(1: bit0 = gzip) + IV(12)
 *   govde  = AES-256-GCM( gzip(sqlite dosyasi) ), baslik GCM'e AAD olarak baglanir
 *   etiket = 16 bayt GCM dogrulama etiketi, dosyanin SONUNDA
 * Node etiketi ancak final()'dan sonra verir; v1'deki "etiket basta" bicimi akisla yazilamaz,
 * bu yuzden etiket sona alindi. Bellek kullanimi veritabani boyutuyla buyumez.
 * Anahtar turetme v1 ile ayni (aesKey): kurtarma anahtari iki bicimi de acar.
 */
const ALGORITHM = 'aes-256-gcm';
export const BACKUP_MAGIC = Buffer.from('ADOBAK2\0', 'latin1');
/** Ayni ailenin (gelecek surumler dahil) ortak oneki: taninmayan surum "eski bicim" sanilmasin. */
const MAGIC_FAMILY = Buffer.from('ADOBAK', 'latin1');
export const BACKUP_FORMAT_V2 = 2;
export const FLAG_GZIP = 0x01;
const KNOWN_FLAGS = FLAG_GZIP;
const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const V2_HEADER_BYTES = BACKUP_MAGIC.length + 1 + 1 + IV_BYTES;
/** Akis parcasi: buyuk okumalar hizli, bellek yine sabit. */
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Eski (v1) bicim tamamen bellekte cozulur; bundan buyugu acilamaz (eski yedekler kucuktur). */
export const V1_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

export type BackupFormat = 1 | 2;

/** Dosya yedek bicimine uymuyor (BACKUP_INVALID) ya da daha yeni surumun bicimi (BACKUP_UNSUPPORTED). */
export class BackupFormatError extends Error {
  constructor(
    readonly code: 'BACKUP_INVALID' | 'BACKUP_UNSUPPORTED',
    message: string,
  ) {
    super(message);
  }
}

const invalid = () => new BackupFormatError('BACKUP_INVALID', 'Geçerli bir yedek dosyası değil.');

export function buildV2Header(iv: Buffer, flags = FLAG_GZIP): Buffer {
  return Buffer.concat([BACKUP_MAGIC, Buffer.from([BACKUP_FORMAT_V2, flags]), iv]);
}

export interface V2Header {
  header: Buffer;
  iv: Buffer;
  gzip: boolean;
}

/**
 * Dosya basindan v2 basligini cozer. Onek yoksa null (v1: ilk 12 bayt rastgele IV). Onek var ama
 * surum/bayrak taninmiyorsa BACKUP_UNSUPPORTED (daha yeni program surumu).
 */
export function parseV2Header(head: Buffer): V2Header | null {
  if (head.length < MAGIC_FAMILY.length) return null;
  if (!head.subarray(0, MAGIC_FAMILY.length).equals(MAGIC_FAMILY)) return null;
  if (head.length < V2_HEADER_BYTES) throw invalid();
  const flags = head.readUInt8(BACKUP_MAGIC.length + 1);
  if (
    !head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC) ||
    head.readUInt8(BACKUP_MAGIC.length) !== BACKUP_FORMAT_V2 ||
    (flags & ~KNOWN_FLAGS) !== 0
  ) {
    throw new BackupFormatError(
      'BACKUP_UNSUPPORTED',
      'Bu yedek daha yeni bir program sürümüyle alınmış; açmak için programı güncelleyin.',
    );
  }
  return {
    header: Buffer.from(head.subarray(0, V2_HEADER_BYTES)),
    iv: Buffer.from(head.subarray(BACKUP_MAGIC.length + 2, V2_HEADER_BYTES)),
    gzip: (flags & FLAG_GZIP) !== 0,
  };
}

/** Dosyanin ilk `bytes` baytini okur (dosya daha kisaysa olani). */
async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Bicim ve boyut; yedek olamayacak kadar kisa ya da bilinmeyen surumse BackupFormatError. */
export async function inspectBackupFile(
  path: string,
): Promise<{ format: BackupFormat; sizeBytes: number }> {
  const { size } = await stat(path);
  const parsed = parseV2Header(await readHead(path, V2_HEADER_BYTES));
  if (parsed) {
    if (size <= V2_HEADER_BYTES + TAG_BYTES) throw invalid();
    return { format: 2, sizeBytes: size };
  }
  if (size <= BACKUP_HEADER_BYTES) throw invalid();
  return { format: 1, sizeBytes: size };
}

/** Hedef dosya akisa baslamadan acilir: hata halinde silinecek dosya kesin vardir. */
async function openSink(path: string): Promise<WriteStream> {
  const sink = createWriteStream(path);
  await once(sink, 'open');
  return sink;
}

/** Basarisiz akistan sonra: hedef kapanana kadar beklenir (Windows), sonra silinir. */
async function discardSink(sink: WriteStream, path: string): Promise<void> {
  if (!sink.destroyed) sink.destroy();
  if (!sink.closed) await new Promise<void>((resolve) => sink.once('close', () => resolve()));
  await rm(path, { force: true });
}

/** Dosyanin tamaminin sha256'si (hex), akisla. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: STREAM_CHUNK_BYTES })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * SQLite dosyasini v2 bicimiyle sifreler: okuma -> gzip -> AES-256-GCM -> dosya (once baslik,
 * en son etiket). Yazilan her bayt sha256'ya girer: donen ozet diskteki dosyanin tamaminin
 * ozetidir (Backup.checksum; bulut yedegi bu degerle dogrular). Hata olursa hedef silinir.
 */
export async function encryptFileV2(
  srcPath: string,
  destPath: string,
  rawKey: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  await stat(srcPath); // kaynak yoksa hedef hic olusmasin
  const iv = randomBytes(IV_BYTES);
  const header = buildV2Header(iv);
  const cipher = createCipheriv(ALGORITHM, aesKey(rawKey), iv);
  cipher.setAAD(header);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const emit = (chunk: Buffer): Buffer => {
    hash.update(chunk);
    sizeBytes += chunk.length;
    return chunk;
  };
  const sink = await openSink(destPath);
  try {
    await pipeline(
      createReadStream(srcPath, { highWaterMark: STREAM_CHUNK_BYTES }),
      createGzip(),
      async function* (source: AsyncIterable<Buffer>) {
        yield emit(header);
        for await (const chunk of source) {
          const out = cipher.update(chunk);
          if (out.length > 0) yield emit(out);
        }
        const last = cipher.final();
        if (last.length > 0) yield emit(last);
        yield emit(cipher.getAuthTag());
      },
      sink,
    );
  } catch (err) {
    await discardSink(sink, destPath);
    throw err;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * v2 dosyasini akisla cozer: etiket son 16 bayttan okunur, govde cozulup gzip acilarak hedefe
 * yazilir. Duz metin dogrulamadan ONCE akar; anahtar yanlis, dosya bozuk/kesik ya da etiket
 * tutmuyorsa hedef silinir ve false doner (yanlis anahtar genelde ilk parcada gzip basliginda
 * yakalanir, yoksa final()'da GCM etiketinde).
 */
export async function decryptFileV2(
  srcPath: string,
  destPath: string,
  rawKey: string,
): Promise<boolean> {
  const { size } = await stat(srcPath);
  if (size <= V2_HEADER_BYTES + TAG_BYTES) return false;
  const handle = await open(srcPath, 'r');
  const head = Buffer.alloc(V2_HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(head, 0, V2_HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const parsed = parseV2Header(head);
  if (!parsed) return false;
  const decipher = createDecipheriv(ALGORITHM, aesKey(rawKey), parsed.iv);
  decipher.setAAD(parsed.header);
  decipher.setAuthTag(tag);
  const sink = await openSink(destPath);
  const body = createReadStream(srcPath, {
    start: V2_HEADER_BYTES,
    end: size - TAG_BYTES - 1,
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  try {
    if (parsed.gzip) await pipeline(body, decipher, createGunzip(), sink);
    else await pipeline(body, decipher, sink);
    return true;
  } catch {
    await discardSink(sink, destPath);
    return false;
  }
}

/** Dosyanin bicimi (bastaki onekten). Bilinmeyen surumde BackupFormatError. */
export async function detectFileFormat(path: string): Promise<BackupFormat> {
  return parseV2Header(await readHead(path, V2_HEADER_BYTES)) ? 2 : 1;
}

/**
 * Yedegi (v1 ya da v2) `destPath`'e cozer; acilmazsa false (yanlis anahtar ya da bozuk dosya).
 * v1 eski yol: bellekte cozulur (eski dosyalar kucuktur). v2 akisla.
 */
export async function decryptBackupFile(
  srcPath: string,
  destPath: string,
  rawKey: string,
): Promise<boolean> {
  if ((await detectFileFormat(srcPath)) === 2) return decryptFileV2(srcPath, destPath, rawKey);
  const { size } = await stat(srcPath);
  if (size > V1_MAX_BYTES) {
    throw new BackupFormatError(
      'BACKUP_INVALID',
      'Eski biçimli yedek bu boyutta açılamıyor (en fazla 2 GB).',
    );
  }
  const plain = decryptBackup(await readFile(srcPath), rawKey);
  if (!plain) return false;
  await writeFile(destPath, plain);
  return true;
}
