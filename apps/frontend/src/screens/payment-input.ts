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
