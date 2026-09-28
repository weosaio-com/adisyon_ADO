import { z } from 'zod';

// Kurtarma anahtarini gostermek icin yonetici sifresi (kritik islem onayi).
export const recoveryKeySchema = z.object({ password: z.string().min(1).max(200) });
export type RecoveryKeyDto = z.infer<typeof recoveryKeySchema>;

// Geri yukleme: yedek baska bilgisayarin anahtariyla sifrelendiyse kurtarma anahtari.
// Govde bos gelebilir (eski istemci) -> {}.
export const restoreBackupSchema = z
  .object({ recoveryKey: z.string().trim().min(16).max(200).optional() })
  .default({});
export type RestoreBackupDto = z.infer<typeof restoreBackupSchema>;
