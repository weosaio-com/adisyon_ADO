import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Para ve miktar ust sinirlari (SAT-12/13). Prisma `Int` alanlari 32-bit'tir
 * (en cok 2.147.483.647 kurus = ~21,4 milyon TL); SQLite daha buyugunu yazar ama
 * Prisma okurken patlar ve o tabloyu okuyan her liste kalici olarak 500 verir.
 * Sinirlar 32-bit'in cok altinda: tek tutar 10 milyon TL, toplamlar da tasmaz.
 */
export const MAX_MONEY_KURUS = 1_000_000_000; // 10.000.000,00 TL
export const MAX_QUANTITY_MILLI = 10_000_000; // 10.000 adet (miktar milis: x1000)
export const MAX_SMALL_INT = 1_000_000; // sira no, kat plani koordinati vb.

const MAX_MONEY_TEXT = '10.000.000 TL';

/** Kurus cinsinden tutar (isaretsiz sinir kontrolu; isaret kurali cagirana ait). */
export const moneyKurus = (label = 'Tutar') =>
  z
    .number({ invalid_type_error: `${label} sayı olmalıdır.` })
    .int(`${label} kuruş cinsinden tam sayı olmalıdır.`)
    .min(-MAX_MONEY_KURUS, `${label} en az -${MAX_MONEY_TEXT} olabilir.`)
    .max(MAX_MONEY_KURUS, `${label} en fazla ${MAX_MONEY_TEXT} olabilir.`);

export const positiveMoneyKurus = (label = 'Tutar') =>
  moneyKurus(label).positive(`${label} sıfırdan büyük olmalıdır.`);

export const nonNegativeMoneyKurus = (label = 'Tutar') =>
  moneyKurus(label).nonnegative(`${label} negatif olamaz.`);

/** Miktar (milis: 1 adet = 1000). */
export const quantityMilli = () =>
  z
    .number({ invalid_type_error: 'Miktar sayı olmalıdır.' })
    .int('Miktar geçersiz.')
    .positive('Miktar sıfırdan büyük olmalıdır.')
    .max(MAX_QUANTITY_MILLI, 'Miktar en fazla 10.000 olabilir.');

/** Sira numarasi, koordinat gibi kucuk tamsayilar. */
export const smallInt = (label: string) =>
  z
    .number({ invalid_type_error: `${label} sayı olmalıdır.` })
    .int(`${label} tam sayı olmalıdır.`)
    .min(-MAX_SMALL_INT, `${label} çok küçük.`)
    .max(MAX_SMALL_INT, `${label} çok büyük.`);

/**
 * Hesaplanan tutar (kalem tutari = fiyat x miktar, adisyon toplami) siniri asarsa
 * yazmadan once 400 AMOUNT_LIMIT_EXCEEDED: tek tek gecerli girdiler carpimda tasmasin.
 */
export function assertMoneyWithinLimit(kurus: number, label = 'Tutar'): void {
  if (!Number.isSafeInteger(kurus) || Math.abs(kurus) > MAX_MONEY_KURUS) {
    throw new BadRequestException({
      code: 'AMOUNT_LIMIT_EXCEEDED',
      message: `${label} en fazla ${MAX_MONEY_TEXT} olabilir.`,
    });
  }
}
