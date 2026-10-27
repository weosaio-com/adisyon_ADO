// Iptal / indirim gerekcesi: hazir secenek ya da "Diğer" + serbest metin. Sunucu gerekceyi
// zorunlu tutar (400 REASON_REQUIRED) ve en cok 200 karakter kabul eder. Self-check: reason.selfcheck.ts

export const REASON_MAX = 200;
export const OTHER_REASON = 'Diğer';

/** Mutfaga gitmis kalemin iptali (rapor ikram, zayi, yanlis giris ve vazgecmeyi ayirsin). */
export const VOID_REASONS = ['Müşteri vazgeçti', 'Yanlış giriş', 'Zayi', 'İkram'];
/** Adisyon / paket / gel-al iptali. */
export const CANCEL_REASONS = ['Müşteri vazgeçti', 'Yanlış sipariş', 'Ürün kalmadı'];
/** Adisyon indirimi. */
export const DISCOUNT_REASONS = ['Sürekli müşteri', 'Personel', 'Şikâyet telafisi', 'Kampanya'];

/**
 * Secimden sunucuya gidecek gerekce metni. Gecersizse bos dizi: secim yok, "Diğer" metni bos ya da
 * sinirdan uzun. Hazir secenekler aynen yazilir (raporda gruplanabilsin).
 */
export function reasonText(choice: string | null, other: string): string {
  if (!choice) return '';
  const text = (choice === OTHER_REASON ? other : choice).trim();
  return text.length <= REASON_MAX ? text : '';
}
