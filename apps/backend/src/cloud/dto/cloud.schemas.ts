import { z } from 'zod';

// "QR menuyu ac": adres ve kod girilmez (bulut programa gomulu, baglanti lisansla).
// takeover: lisans baska bilgisayarda aciksa sahibin onayiyla bu bilgisayara tasinir.
export const cloudActivateSchema = z.object({
  takeover: z.boolean().optional(),
});
export type CloudActivateDto = z.infer<typeof cloudActivateSchema>;
