// Derleme profili: apps/desktop/profiles/<profil>.json -> paketteki resources/app-config.json.
// Profil, kurulumun hangi buluta baglanacagini, hangi lisans ve guncelleme anahtarlarina
// guvenecegini ve guncelleme kanalini belirler; kullanici bunlari girmez. Electron'suz
// (selfcheck.mjs ile test edilir).
import { readFileSync } from 'node:fs';
import { UPDATE_CHANNELS } from './update-manifest.mjs';

export const PROFILES = ['test', 'prod'];

// Ed25519 acik anahtarinin SPKI DER on eki (12 bayt) + 32 bayt anahtar = 44 bayt.
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isEd25519PublicKey(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  const der = Buffer.from(b64, 'base64');
  return der.length === 44 && der.subarray(0, 12).toString('hex') === ED25519_SPKI_PREFIX;
}

/** Bulut adresini kok adrese (origin) indirger. https sart (yerel makine haric); yoksa null. */
export function cloudOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const local = LOCAL_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Profili dogrular; hatali alanlar bos birakilir (o ozellik kapali kalir).
 * strict (derleme): eksik zorunlu deger de hatadir; uretim profilinde lisans anahtari sarttir.
 */
const emptyConfig = () => ({
  profile: null,
  cloudUrl: '',
  licensePublicKey: '',
  channel: 'stable',
  updatePublicKeys: [],
});

export function validateAppConfig(raw, { strict = false } = {}) {
  const errors = [];
  const config = emptyConfig();
  if (!raw || typeof raw !== 'object')
    return { config, errors: ['profil bir JSON nesnesi olmali'] };

  if (PROFILES.includes(raw.profile)) config.profile = raw.profile;
  else errors.push(`profile: ${PROFILES.join(' | ')} olmali`);

  if (raw.cloudUrl) {
    const origin = cloudOrigin(raw.cloudUrl);
    if (origin) config.cloudUrl = origin;
    else errors.push('cloudUrl: https kok adresi olmali (yerel makine haric)');
  } else if (strict) {
    errors.push('cloudUrl: bos');
  }

  if (raw.licensePublicKey) {
    if (isEd25519PublicKey(raw.licensePublicKey)) config.licensePublicKey = raw.licensePublicKey;
    else errors.push('licensePublicKey: base64 Ed25519 SPKI olmali');
  } else if (strict && raw.profile === 'prod') {
    errors.push('licensePublicKey: uretim profilinde bos olamaz');
  }

  // Guncelleme: kanal (beta gizli/gelistirici; CONVENTIONS F2) ve imza anahtarlari (virgulle
  // birden cok: anahtar degisiminde eski ve yeni birlikte). Anahtar yoksa guncelleme denetlenmez.
  if (raw.channel !== undefined) {
    if (UPDATE_CHANNELS.includes(raw.channel)) config.channel = raw.channel;
    else errors.push(`channel: ${UPDATE_CHANNELS.join(' | ')} olmali`);
  }
  if (raw.updatePublicKey) {
    const keys = String(raw.updatePublicKey)
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length > 0 && keys.every(isEd25519PublicKey)) config.updatePublicKeys = keys;
    else errors.push('updatePublicKey: base64 Ed25519 SPKI olmali (virgulle birden cok)');
  } else if (strict && raw.profile === 'prod') {
    errors.push('updatePublicKey: uretim profilinde bos olamaz');
  }
  return { config, errors };
}

/** Paketteki app-config.json'u okur. Okunamaz/hataliysa acilis durmaz; bulut ozellikleri kapanir. */
export function loadAppConfig(path) {
  try {
    return validateAppConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return {
      config: emptyConfig(),
      errors: [`app-config okunamadi: ${error instanceof Error ? error.message : error}`],
    };
  }
}

/** Backend ortam degiskenleri. Miras alinan degerleri EZER: profil disi bir deger sizmasin. */
export function appConfigEnv(config) {
  return {
    CLOUD_API_URL: config.cloudUrl,
    ADO_LICENSE_PUBLIC_KEY: config.licensePublicKey,
    ADO_BUILD_PROFILE: config.profile ?? '',
  };
}
