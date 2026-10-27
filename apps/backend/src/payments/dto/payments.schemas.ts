import { z } from 'zod';
import { PaymentMethod } from '@ado/shared';
import { nonNegativeMoneyKurus, positiveMoneyKurus } from '../money-limits';

// --- Odeme al (append-only) ---
// idempotencyKey: cift-cekim onleme (Payment.idempotencyKey @unique). Para yolu -> zorunlu.
export const recordPaymentSchema = z
  .object({
    method: z.nativeEnum(PaymentMethod),
    amount: positiveMoneyKurus('Ödeme tutarı'), // kurus (adisyona uygulanan tutar)
    received: nonNegativeMoneyKurus('Alınan nakit').optional(), // nakit verilen (para ustu icin)
    reference: z.string().nullish(), // kart/havale ref
    customerId: z.string().min(1).optional(), // veresiye (method='debt') icin zorunlu
    // Eski istemci uyumu: artik etkisiz. Nakitte kalandan fazlasi para ustu olur,
    // nakit disinda kalandan fazla tahsilat reddedilir (BILL_OVERPAY).
    allowOverpay: z.boolean().optional(),
    idempotencyKey: z.string().min(1), // ULID (offline idempotency)
  })
  .refine((d) => d.method !== PaymentMethod.Debt || !!d.customerId, {
    message: 'Veresiye odeme icin customerId zorunlu.',
    path: ['customerId'],
  })
  // Nakitte verilen para tutardan az olamaz (para ustu negatif olmaz).
  .refine(
    (d) => d.method !== PaymentMethod.Cash || d.received === undefined || d.received >= d.amount,
    {
      message: 'Nakit verilen tutar odeme tutarindan az olamaz.',
      path: ['received'],
    },
  );
export type RecordPaymentDto = z.infer<typeof recordPaymentSchema>;

// --- Odeme iade (reversal / ters kayit) ---
// customerId: iade edilen odeme veresiye (debt) ise zorunlu (serviste method'a gore dogrulanir).
export const reversePaymentSchema = z.object({
  reason: z.string().nullish(),
  customerId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
});
export type ReversePaymentDto = z.infer<typeof reversePaymentSchema>;
