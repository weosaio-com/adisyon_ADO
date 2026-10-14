import { z } from 'zod';

// Bu bilgisayarda otomatik bulut yedegini ac/kapat (varsayilan acik).
export const cloudBackupSwitchSchema = z.object({ enabled: z.boolean() });
export type CloudBackupSwitchDto = z.infer<typeof cloudBackupSwitchSchema>;

// Yeni bilgisayar (ilk kurulum): lisans anahtariyla buluttaki yedekler.
export const cloudSetupListSchema = z.object({
  licenseKey: z.string().trim().min(20).max(4096),
});
export type CloudSetupListDto = z.infer<typeof cloudSetupListSchema>;

// Secilen yedegi indir + geri yukle. Kurtarma anahtari: yedek baska kurulumun anahtariyla
// sifreliyse gerekir (yeni bilgisayarda hep oyle); yoksa BACKUP_KEY_REQUIRED doner.
export const cloudSetupRestoreSchema = cloudSetupListSchema.extend({
  cloudBackupId: z.string().trim().min(1).max(64),
  recoveryKey: z.string().trim().min(16).max(200).optional(),
});
export type CloudSetupRestoreDto = z.infer<typeof cloudSetupRestoreSchema>;
