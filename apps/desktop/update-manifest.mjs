// Imzali guncelleme bildirimi (Electron'suz; selfcheck.mjs). Guncelleme sunucusunda kurulum
// dosyasinin yaninda `ado-update.json` durur: Ed25519 ile imzali surum, kanal, dosya adi, SHA-512 ve
// boyut. Program once bunu dogrular; indirilen dosya ancak imzali ozetle eslesirse kurulur (L143).
// Imzalama: scripts/update-manifest.mjs. Bicim: UPDATE_SYSTEM.md.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const UPDATE_MANIFEST_FILE = 'ado-update.json';
export const UPDATE_MANIFEST_FORMAT = 'ADOU1';
export const UPDATE_CHANNELS = ['stable', 'beta'];

const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** "1.2.3" -> [1, 2, 3]; gecersizse null (on surum etiketi kabul edilmez). */
export function parseVersion(text) {
  const match = VERSION.exec(typeof text === 'string' ? text : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** a > b ise pozitif, esitse 0, kucukse negatif. Gecersiz surum hata firlatir. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`Gecersiz surum: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Guncelleme dosyalarinin adresi: `<bulut>/updates/<kanal>/` (bulut Worker'i R2'den sunar). */
export function updateFeedUrl(cloudUrl, channel) {
  if (!cloudUrl || !UPDATE_CHANNELS.includes(channel)) return null;
  return `${cloudUrl.replace(/\/+$/, '')}/updates/${channel}`;
}

function fromBase64Url(text) {
  return Buffer.from(String(text), 'base64url');
}

function validPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { version, channel, file, sha512, size, releaseDate, notes } = value;
  if (!parseVersion(version)) return null;
  if (!UPDATE_CHANNELS.includes(channel)) return null;
  if (typeof file !== 'string' || !FILE_NAME.test(file) || !file.endsWith('.exe')) return null;
  if (typeof sha512 !== 'string' || !SHA512_B64.test(sha512)) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof releaseDate !== 'string' || Number.isNaN(Date.parse(releaseDate))) return null;
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) return null;
  return { version, channel, file, sha512, size, releaseDate, notes: notes ?? '' };
}

/**
 * Bildirimi dogrular: imza verilen anahtarlardan biriyle tutmali (anahtar degisiminde ikisi birden
 * gecerli), alanlar beklenen bicimde olmali. Gecerliyse icerik, degilse null.
 */
export function verifyUpdateManifest(text, publicKeys) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (!envelope || envelope.format !== UPDATE_MANIFEST_FORMAT) return null;
  const payload = fromBase64Url(envelope.payload);
  const signature = fromBase64Url(envelope.signature);
  if (payload.length === 0 || signature.length !== 64) return null;
  const signed = publicKeys.some((key) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return verify(null, payload, publicKey, signature);
    } catch {
      return false;
    }
  });
  if (!signed) return null;
  try {
    return validPayload(JSON.parse(payload.toString('utf8')));
  } catch {
    return null;
  }
}

/** Dosyanin SHA-512 ozeti (base64; electron-builder'in latest.yml bicimiyle ayni). */
export function sha512File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}
