import { z } from 'zod';
import { CashTxnType, PaymentMethod } from '@ado/shared';
import { moneyKurus, nonNegativeMoneyKurus } from '../../payments/money-limits';

export const openSessionSchema = z.object({
  openingFloat: nonNegativeMoneyKurus('Açılış bakiyesi'), // kurus
});
export type OpenSessionDto = z.infer<typeof openSessionSchema>;

export const closeSessionSchema = z.object({
  countedAmount: nonNegativeMoneyKurus('Sayılan tutar'), // kurus
});
export type CloseSessionDto = z.infer<typeof closeSessionSchema>;

export const createCashTransactionSchema = z.object({
  type: z.nativeEnum(CashTxnType),
  amount: moneyKurus(), // kurus (girdi/cikti durumuna gore +/-)
  method: z.nativeEnum(PaymentMethod),
  note: z.string().nullish(),
  // Tekrar korumasi (istege bagli): ayni anahtarla gelen ikinci istek ikinci hareket acmaz.
  idempotencyKey: z.string().min(1).max(100).optional(),
});
export type CreateCashTransactionDto = z.infer<typeof createCashTransactionSchema>;
