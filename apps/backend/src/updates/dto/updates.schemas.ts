import { z } from 'zod';

// Onay hazir olan surum icindir: arada baska surum hazirlandiysa eski onay gecmez.
export const updateApproveSchema = z.object({
  version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, 'Sürüm X.Y.Z olmalı.'),
});
export type UpdateApproveDto = z.infer<typeof updateApproveSchema>;
