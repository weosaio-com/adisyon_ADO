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

// Elle kasa hareketi: yalniz nakit para girisi/cikisi. Satis, iade, acilis, kapanis
// hareketlerini sistem yazar; elle girilirse kasa sayimi sessizce bozulurdu (SAT-16).
export const createCashTransactionSchema = z
  .object({
    type: z.enum([CashTxnType.Income, CashTxnType.Payout], {
      errorMap: () => ({ message: 'Elle yalnız para girişi ya da para çıkışı yapılabilir.' }),
    }),
    // Kurus, pozitif: isaret turden belirlenir (cikis kasadan duser). Eski istemcinin
    // para cikisinda gonderdigi negatif tutar da kabul edilir, sunucu isareti duzeltir.
    amount: moneyKurus().refine((v) => v !== 0, 'Tutar sıfırdan büyük olmalıdır.'),
    method: z
      .literal(PaymentMethod.Cash, {
        errorMap: () => ({ message: 'Elle kasa hareketi yalnız nakit olabilir.' }),
      })
      .optional(),
    note: z.string().max(200, 'Açıklama en fazla 200 karakter olabilir.').nullish(),
    // Tekrar korumasi (istege bagli): ayni anahtarla gelen ikinci istek ikinci hareket acmaz.
    idempotencyKey: z.string().min(1).max(100).optional(),
  })
  .refine((d) => d.type === CashTxnType.Payout || d.amount > 0, {
    message: 'Para girişi tutarı sıfırdan büyük olmalıdır.',
    path: ['amount'],
  });
export type CreateCashTransactionDto = z.infer<typeof createCashTransactionSchema>;
