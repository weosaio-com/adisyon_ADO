/**
 * ApplicationSetting anahtarlarinin tek listesi (sube bazli key-value, value = JSON).
 * Yeni anahtar buraya eklenir; moduller sabiti buradan alir. Kullaniciya acik olanlar
 * yalniz SettingsService'in izin listesindekilerdir (backup.cloudDir, backup.autoDaily).
 */
export const SettingKeys = {
  // Yedek
  backupAutoDaily: 'backup.autoDaily',
  backupCloudDir: 'backup.cloudDir',
  // Bulut baglantisi ve QR menu
  cloudConnection: 'cloud.connection',
  cloudState: 'cloud.state',
  /** QR menu yayini acik mi (baglantidan ayri; A2). */
  cloudQrPublish: 'cloud.qrPublish',
  // Bulut yedegi (A3)
  cloudBackupEnabled: 'cloudBackup.enabled',
  cloudBackupState: 'cloudBackup.state',
  // Depolama ve temizlik (A1)
  storageLastCleanup: 'storage.lastCleanup',
  // Lisans (A4)
  licenseEnforce: 'license.enforce',
  licenseTrialStartedAt: 'license.trialStartedAt',
  /** Saat geri alinmasina karsi gorulen en gec an. */
  licenseClock: 'license.clock',
  /** Bulutun son bildirdigi lisans durumu (license.remote olayindan). */
  licenseRemote: 'license.remote',
  // Kimlik
  authRecoveryEnabled: 'auth.recovery.enabled',
  authRecoveryCodeHash: 'auth.recovery.codeHash',
} as const;

export type SettingKey = (typeof SettingKeys)[keyof typeof SettingKeys];

/**
 * Isletme verisi degismeden kendiliginden degisen anahtarlar (durum, saat, son calisma).
 * Yedegin "degisiklik var mi" parmak izi bunlari saymaz; yoksa her gun yeni yedek alinirdi.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  SettingKeys.cloudConnection,
  SettingKeys.cloudState,
  SettingKeys.cloudBackupState,
  SettingKeys.storageLastCleanup,
  SettingKeys.licenseClock,
  SettingKeys.licenseRemote,
]);

export function isVolatileSettingKey(key: string): boolean {
  return VOLATILE_KEYS.has(key);
}
