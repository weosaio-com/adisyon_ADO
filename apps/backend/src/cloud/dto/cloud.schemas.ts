import { z } from 'zod';

// "Simdi baglan": adres ve kod girilmez (bulut programa gomulu, baglanti lisansla).
// takeover: lisans baska bilgisayarda bagliysa sahibin onayiyla bu bilgisayara alinir.
export const cloudActivateSchema = z.object({
  takeover: z.boolean().optional(),
});
export type CloudActivateDto = z.infer<typeof cloudActivateSchema>;

// QR menu ac/kapat (baglantidan ayri; kapatinca baglanti kalir).
export const cloudQrSchema = z.object({
  enabled: z.boolean(),
});
export type CloudQrDto = z.infer<typeof cloudQrSchema>;
