// Para = integer kurus. Miktar = integer milis (x1000). Float YASAK (sunum haric).
const tl = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });

export function formatKurus(kurus: number): string {
  return tl.format(kurus / 100);
}

// TL metni -> kurus. Turk formati destekler: virgul ONDALIK, virgul varsa
// noktalar binliktir ("1.500,50"); virgul yoksa "1.500" gibi salt-binlik desen
// binlik sayilir, "12.5" ondaliktir. Gecersiz/belirsiz giris NaN (cagiran dogrular).
export function parseTlToKurus(tl: string): number {
  const s = tl.trim();
  if (!s) return NaN;
  const normalized = s.includes(',')
    ? s.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(\.\d{3})+$/.test(s)
      ? s.replace(/\./g, '')
      : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return NaN;
  return Math.round(parseFloat(normalized) * 100);
}

// milis -> insan-okur miktar. Tam adetse tamsayi, degilse 3 hane.
export function formatQty(milis: number): string {
  const q = milis / 1000;
  return Number.isInteger(q) ? String(q) : q.toFixed(3);
}

// Bayt -> insan-okur boyut (yedek, veritabani, disk). 1024 tabanli; KB yukari yuvarlanir; Turkce
// ondalik virgul ("12,3 MB").
const oneDecimal = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= GB) return `${oneDecimal.format(bytes / GB)} GB`;
  if (bytes >= MB) return `${oneDecimal.format(bytes / MB)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

// ISO zaman -> Turkce tarih + saat (yerel saat dilimi).
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR');
}
