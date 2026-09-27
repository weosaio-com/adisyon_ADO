import { z } from 'zod';
import { PrinterConnection, DocumentType, PrintJobStatus } from '@ado/shared';

export const createPrinterSchema = z.object({
  name: z.string().min(1),
  driverId: z.string().min(1),
  connection: z.nativeEnum(PrinterConnection),
  address: z.string().nullish(),
  paperWidth: z.enum(['58', '80']).transform((v) => parseInt(v, 10)),
  isDefault: z.boolean().optional().default(false),
  capabilities: z.string().nullish(),
  isActive: z.boolean().optional().default(true),
});
export type CreatePrinterDto = z.infer<typeof createPrinterSchema>;

export const updatePrinterSchema = createPrinterSchema.partial();
export type UpdatePrinterDto = z.infer<typeof updatePrinterSchema>;

export const createPrintRouteSchema = z.object({
  documentType: z.nativeEnum(DocumentType),
  printerId: z.string().min(1),
  categoryId: z.string().nullish(),
});
export type CreatePrintRouteDto = z.infer<typeof createPrintRouteSchema>;

// --- Fis listesi (son 24 saat) ---
export const printJobQuerySchema = z.object({
  status: z.nativeEnum(PrintJobStatus).optional(),
});
export type PrintJobQueryDto = z.infer<typeof printJobQuerySchema>;
