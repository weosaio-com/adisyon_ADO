import { z } from 'zod';

/**
 * Ortam degiskeni semasi (tek dogruluk kaynagi). Uygulama acilirken dogrulanir;
 * gecersizse net hata ile durur (fail-fast). CONVENTIONS.md / SECURITY.md.
 */
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADO_DATA_DIR: z.string().optional(),
  BACKUP_ENCRYPTION_KEY: z.string().min(16).optional(),

  API_PORT: z.coerce.number().int().positive().default(3001),
  // Tabletler icin yerel HTTPS portu (tanimsiz/bos = kapali). Paketli surum PORT+1 verir.
  API_TLS_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default(''),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Owner access kisa (ana makine hep bagli); Waiter access uzun (offline vardiya).
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_WAITER_ACCESS_TTL: z.string().default('12h'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  AUTH_FAILED_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  AUTH_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // QR menu bulutunun adresi; paketli surumde derleme profilinden gelir (apps/desktop/profiles).
  // Burada bilerek serbest metin: hatali bir deger acilisi durdurmaz, yalniz bulut
  // ozellikleri kapanir (adres kullanilirken dogrulanir).
  CLOUD_API_URL: z.string().default(''),
  // Bulut uzlastirma araligi (sn): kacan yayin, bekleyen kapatma/lisans/etkinlestirme, durum.
  CLOUD_RECONCILE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  // Heartbeat araligi (sn): son gorulme, surum, saglik ve uzak lisans durumu.
  CLOUD_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3600),
  // Bulut yedegi denetim araligi (sn): yuklenmemis en yeni yedek varsa gonderilir.
  CLOUD_BACKUP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3600),
  // Buyuk yedeklerde parca boyu (bayt). R2 alt siniri 5 MiB.
  CLOUD_BACKUP_PART_BYTES: z.coerce
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .max(95 * 1000 * 1000)
    .default(8 * 1024 * 1024),
  // Lisans zorunlulugu: '1' acik, '0' kapali, bos = ayar (license.enforce). Paketli surumde profil.
  ADO_LICENSE_ENFORCE: z.enum(['', '0', '1']).default(''),
  // Lisanssiz yeni kurulumun deneme suresi (gun). 0 = lisans girilmeden satis yok.
  ADO_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(0),
  // Lisans bitince yeni adisyonun durmasindan once taninan ek sure (gun; lisanstaki `g` onceliklidir).
  ADO_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  // Kilit ekraninda gosterilen destek iletisimi (telefon / e-posta).
  ADO_SUPPORT_CONTACT: z.string().max(200).default(''),
  // Bu kurulumun kalici kimligi. Bos = veri dizinindeki ado-install.json (common/util/install-id).
  ADO_INSTALL_ID: z.string().default(''),
  // Masaustu kabugunun verdigi bilgiler (gelistirmede bos).
  ADO_APP_VERSION: z.string().default(''),
  ADO_BUILD_PROFILE: z.string().default(''),

  SEED_OWNER_USERNAME: z.string().default('owner'),
  // Bos string = yok sayilir (paketleme kullanicisiz sablon DB icin '' gecer).
  SEED_OWNER_PASSWORD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(6).optional(),
  ),
  SEED_OWNER_DISPLAY_NAME: z.string().default('Yonetici'),
  SEED_WAITER_USERNAME: z.string().default('garson'),
  SEED_WAITER_DISPLAY_NAME: z.string().default('Garson'),
  SEED_WAITER_PIN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\d{4,6}$/)
      .optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

/** process.env'i dogrula. Hata durumunda okunur mesajla firlatir. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Ortam degiskenleri gecersiz:\n${issues}`);
  }
  return parsed.data;
}
