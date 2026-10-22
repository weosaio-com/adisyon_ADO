// Turkce dogal siralama (URN-1): SQLite `ORDER BY name` bayt sirasiyla dizer ("Masa 10"
// "Masa 2"den once, "Çorbalar" en sonda). Liste uclari once sortOrder, sonra Turkce harf
// sirasi + sayilar sayi olarak (Masa 2 < Masa 10) dizer.
const collator = new Intl.Collator('tr', { numeric: true });

type Named = { name: string; sortOrder?: number | null; id?: string };

export function compareNatural(a: Named, b: Named): number {
  return (
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    collator.compare(a.name, b.name) ||
    (a.id ?? '').localeCompare(b.id ?? '')
  );
}

/** Yerinde siralar ve ayni diziyi doner. */
export function sortNatural<T extends Named>(rows: T[]): T[] {
  return rows.sort(compareNatural);
}
