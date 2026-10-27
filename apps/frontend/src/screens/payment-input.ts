// Odeme ekraninin saf hesaplari. Self-check: payment-input.selfcheck.ts

export interface PaymentRow {
  amount: number; // kurus; iade satiri da pozitif tutarla gelir
  direction?: string; // charge | refund
}

/** Net odenen = tahsilatlar - iadeler (iade sonrasi adisyon yeniden acilir). */
export function netPaid(rows: PaymentRow[]): number {
  return rows.reduce(
    (sum, row) => sum + (row.direction === 'refund' ? -row.amount : row.amount),
    0,
  );
}

/** Nakit para ustu: musterinin verdigi tutarin adisyona uygulanan kismi asan bolumu. */
export function cashChange(amount: number, received: number): number {
  return received > amount ? received - amount : 0;
}

/** Kurus -> TL giris metni ("200", "145,50"); parseTlToKurus ile geri okunur. */
export function kurusToInput(kurus: number): string {
  return kurus % 100 === 0 ? String(kurus / 100) : (kurus / 100).toFixed(2).replace('.', ',');
}

/**
 * Ayni odeme girisi icin ayni islem anahtarini verir. Cevap yolda kaybolup kasiyer
 * tekrar basarsa sunucu anahtari tanir ve ikinci kez kaydetmez. Giris degisirse
 * (yeni odeme niyeti) yeni anahtar uretilir; imzaya basarili odeme sayaci konur ki
 * ayni tutarla ikinci gercek odeme (ör. 2 x 50 TL kart) yeni anahtar alsin.
 * Ekranda "odenen" tazelenince anahtar degismez: kayip cevap sonrasi tekrar basis
 * yine ayni anahtari gonderir.
 */
export function keyReuser(generate: () => string): (signature: string) => string {
  let last: { signature: string; key: string } | undefined;
  return (signature) => {
    if (last?.signature !== signature) last = { signature, key: generate() };
    return last.key;
  };
}

/** Sunucu ust sinirlari: tek tutar en cok 10.000.000 TL, miktar en cok 10.000 adet. */
export const MAX_MONEY_KURUS = 1_000_000_000;
export const MAX_QUANTITY_MILLI = 10_000_000;

/** Para girisi alaninin hata metni; gecerliyse bos. Bos/gecersiz giris ayri denetlenir. */
export function moneyLimitError(kurus: number): string {
  return Number.isFinite(kurus) && Math.abs(kurus) > MAX_MONEY_KURUS
    ? 'Tutar en fazla 10.000.000 TL olabilir.'
    : '';
}

export interface PaymentPlan {
  /** Adisyona uygulanacak tutar (nakitte kalanla sinirli). */
  amount: number;
  /** Nakit verilen (para ustu icin); yoksa sunucu tam para sayar. */
  received?: number;
  /** Para ustu onizlemesi (sunucu yaniti esas alinir). */
  change: number;
  /** Girilen tutar kalandan fazla. */
  over: boolean;
  /** Nakit disinda kalandan fazla tahsilat: sunucu 400 BILL_OVERPAY ile reddeder. */
  blocked: boolean;
}

/**
 * Sunucunun ayirma kuraliyla ayni (payments.calc allocatePayment): nakitte kalandan fazlasi para
 * ustu olur (adisyona kalan, verilen para `received`); kart/havale/veresiyede fazla tahsilat yok.
 */
export function planPayment(input: {
  method: string;
  remaining: number;
  amount: number;
  received: number | null;
}): PaymentPlan {
  const { method, remaining, amount, received } = input;
  const over = Number.isFinite(amount) && remaining > 0 && amount > remaining;
  if (method !== 'cash') return { amount, change: 0, over, blocked: over };
  const applied = over ? remaining : amount;
  const given = Math.max(received ?? amount, amount);
  return {
    amount: applied,
    ...(given > applied || received !== null ? { received: given } : {}),
    change: Math.max(0, given - applied),
    over,
    blocked: false,
  };
}
