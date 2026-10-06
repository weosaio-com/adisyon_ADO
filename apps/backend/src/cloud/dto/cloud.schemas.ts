import { z } from 'zod';

export const cloudPairSchema = z.object({
  url: z.string().trim().min(1).max(200),
  code: z.string().trim().min(4).max(32),
});
export type CloudPairDto = z.infer<typeof cloudPairSchema>;
