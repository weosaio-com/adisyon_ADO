// Derleme profili: apps/desktop/profiles/<profil>.json -> paketteki resources/app-config.json.
// Profil, kurulumun hangi buluta baglanacagini, hangi lisans ve guncelleme anahtarlarina
// guvenecegini, guncelleme kanalini ve lisans politikasini (zorunluluk, deneme/ek sure, destek
// iletisimi; LICENSING.md §8) belirler; kullanici bunlari girmez. Electron'suz
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
  // Lisans politikasi: paketli surumde zorunluluk varsayilan ACIK (acik anahtar yoksa yine de
  // hicbir sey kilitlenmez). Deneme 0 gun: lisans girilmeden satis yok. Ek sure 7 gun.
  licenseEnforce: true,
  trialDays: 0,
  graceDays: 7,
  supportContact: '',
});

// Backend env semasiyla ayni sinirlar (ADO_TRIAL_DAYS / ADO_GRACE_DAYS / ADO_SUPPORT_CONTACT).
const MAX_POLICY_DAYS = 90;
const MAX_SUPPORT_CONTACT = 200;
const isPolicyDays = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_POLICY_DAYS;

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
  // Profil virgullu metin (updatePublicKey) tasir; build-bundle'in yazdigi paketteki
  // app-config.json ise dogrulanmis bicimi (updatePublicKeys dizisi). Ikisi de okunur: aksi halde
  // paketli surum acilista anahtarlari kaybeder ve guncelleme kapali kalirdi.
  const updateKeys =
    raw.updatePublicKey ||
    (Array.isArray(raw.updatePublicKeys) ? raw.updatePublicKeys.join(',') : '');
  if (updateKeys) {
    const keys = String(updateKeys)
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length > 0 && keys.every(isEd25519PublicKey)) config.updatePublicKeys = keys;
    else errors.push('updatePublicKey: base64 Ed25519 SPKI olmali (virgulle birden cok)');
  } else if (strict && raw.profile === 'prod') {
    errors.push('updatePublicKey: uretim profilinde bos olamaz');
  }

  // Lisans politikasi (istege bagli; hataliysa varsayilan kalir).
  if (raw.licenseEnforce !== undefined) {
    if (typeof raw.licenseEnforce === 'boolean') config.licenseEnforce = raw.licenseEnforce;
    else errors.push('licenseEnforce: true | false olmali');
  }
  for (const field of ['trialDays', 'graceDays']) {
    if (raw[field] === undefined) continue;
    if (isPolicyDays(raw[field])) config[field] = raw[field];
    else errors.push(`${field}: 0-${MAX_POLICY_DAYS} arasi tam sayi olmali`);
  }
  if (raw.supportContact !== undefined) {
    const contact = typeof raw.supportContact === 'string' ? raw.supportContact.trim() : null;
    if (contact !== null && contact.length <= MAX_SUPPORT_CONTACT) config.supportContact = contact;
    else errors.push(`supportContact: en fazla ${MAX_SUPPORT_CONTACT} karakterlik metin olmali`);
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
    // Paketli surumde zorunluluk acik; yalniz profil acikca false derse kapali.
    ADO_LICENSE_ENFORCE: config.licenseEnforce === false ? '0' : '1',
    // Bos metin backend'de 0 gun sayilirdi: varsayilanlar acikca yazilir.
    ADO_TRIAL_DAYS: String(config.trialDays ?? 0),
    ADO_GRACE_DAYS: String(config.graceDays ?? 7),
    ADO_SUPPORT_CONTACT: config.supportContact ?? '',
  };
}
