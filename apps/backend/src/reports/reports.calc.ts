import assert from 'node:assert';

// Gun sonu saati (vars. 06:00 — CONVENTIONS.md; orders.service ile ayni).
// ponytail: sabit; ileride ApplicationSetting'ten okunacak.
const DAY_END_HOUR = 6;

/**
 * YYYY-MM-DD is-gunu penceresi (SAF): [date 06:00, ertesi 06:00).
 * CashSession.businessDay ile ayni gun tanimi. Gecersiz tarihte bugunun is-gunu.
 */
export function businessDayWindow(dateStr: string): { day: string; start: Date; end: Date } {
  const parsed = new Date(`${dateStr}T00:00:00`);
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const start = new Date(base);
  start.setHours(DAY_END_HOUR, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const day =
    `${start.getFullYear()}-` +
    `${String(start.getMonth() + 1).padStart(2, '0')}-` +
    `${String(start.getDate()).padStart(2, '0')}`;
  return { day, start, end };
}

/**
 * Verilen anin ait oldugu is-gunu (YYYY-MM-DD, LOCAL saat). 06:00 oncesi dunun
 * gunudur. cash.service acilis businessDay'i bunu kullanir — UTC (toISOString)
 * KULLANMA: TR'de 00:00-03:00 arasi gunu 1 daha geri kaydirir.
 */
export function businessDayOf(now: Date = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < DAY_END_HOUR) d.setDate(d.getDate() - 1);
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

// --- Self-check: `ts-node src/reports/reports.calc.ts` ---
if (require.main === module) {
  const w = businessDayWindow('2026-07-17');
  assert.strictEqual(w.day, '2026-07-17', 'gun');
  assert.strictEqual(w.start.getHours(), DAY_END_HOUR, 'baslangic 06:00');
  assert.strictEqual(w.end.getDate(), 18, 'bitis ertesi gun');
  assert.ok(w.end > w.start, 'end > start');

  // Gecersiz tarih -> bugunun is-gunu (crash yok).
  const fallback = businessDayWindow('');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fallback.day), 'gecersiz tarih fallback');

  // businessDayOf: 06:00 oncesi dune, sonrasi bugune yazar (LOCAL).
  assert.strictEqual(
    businessDayOf(new Date(2026, 6, 22, 2, 30)),
    '2026-07-21',
    'gece 02:30 -> dun',
  );
  assert.strictEqual(
    businessDayOf(new Date(2026, 6, 22, 9, 0)),
    '2026-07-22',
    'sabah 09:00 -> bugun',
  );
  // Window ile ayni gun tanimi: window(day).day === day.
  assert.strictEqual(
    businessDayWindow(businessDayOf(new Date(2026, 6, 22, 2, 30))).day,
    '2026-07-21',
    'window uyumu',
  );

  console.log('✓ reports.calc self-check OK');
}
