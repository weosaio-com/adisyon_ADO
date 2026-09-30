// Panelde fiyat girisi: "120", "120,5", "1.250,75" -> kurus. Gecersizse null.
export function parsePrice(text: string): number | null {
  const cleaned = text.trim().replace(/\s|₺|TL/gi, '');
  if (!cleaned) return null;
  // Turkce bicim: nokta binlik, virgul ondalik. Yalniz nokta varsa ve 2 haneden azsa ondalik say.
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : /^\d+\.\d{1,2}$/.test(cleaned)
      ? cleaned
      : cleaned.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** kurus -> duzenleme kutusu metni: 12050 -> "120,50", 12000 -> "120". */
export function priceInput(kurus: number): string {
  return kurus % 100 === 0 ? String(kurus / 100) : (kurus / 100).toFixed(2).replace('.', ',');
}
