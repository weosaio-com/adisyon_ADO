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
});
export type CreateCashTransactionDto = z.infer<typeof createCashTransactionSchema>;
