// Akilli saklama self-check'i (sabit tarihler, yerel takvim):
// `ts-node --transpile-only src/backup/backup.retention.selfcheck.ts`
import assert from 'node:assert';
import * as path from 'node:path';
import {
  cloudCopyCandidate,
  dayKey,
  isLowDisk,
  isOwnBackupFile,
  isoWeekKey,
  isSafeCloudCopy,
  monthKey,
  planRetention,
  RETENTION,
  type RetentionItem,
} from './backup.retention';

const GB = 1024 * 1024 * 1024;
// Yerel saat kurucusu: test sonucu makinenin saat diliminden bagimsiz.
const at = (y: number, m: number, d: number, h = 6, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s);
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);
const item = (id: string, type: string, createdAt: Date): RetentionItem => ({
  id,
  type,
  createdAt,
});
const sorted = (ids: Iterable<string>) => [...ids].sort();

// --- Takvim anahtarlari ---
assert.strictEqual(dayKey(at(2026, 10, 14)), '2026-10-14');
assert.strictEqual(monthKey(at(2026, 1, 5)), '2026-01');
assert.strictEqual(isoWeekKey(at(2026, 1, 1)), '2026-W01', '1 Ocak 2026 persembe -> W01');
assert.strictEqual(isoWeekKey(at(2025, 12, 29)), '2026-W01', 'pazartesi 29 Aralik -> 2026-W01');
assert.strictEqual(isoWeekKey(at(2027, 1, 1)), '2026-W53', '2026 53 haftali');
assert.strictEqual(isoWeekKey(at(2027, 1, 3)), '2026-W53', 'pazar ayni hafta');
assert.strictEqual(isoWeekKey(at(2027, 1, 4)), '2027-W01');
assert.strictEqual(isoWeekKey(at(2021, 1, 3)), '2020-W53');
assert.strictEqual(isoWeekKey(at(2026, 10, 14)), '2026-W42');
assert.strictEqual(isoWeekKey(at(2026, 10, 12, 0, 0)), '2026-W42', 'pazartesi gece yarisi');
assert.strictEqual(isoWeekKey(at(2026, 10, 11, 23, 59)), '2026-W41', 'pazar gece');

// --- Otomatik: 400 gun, her gun 06:00 ---
const now = at(2026, 10, 14, 6, 0, 30); // carsamba, gunluk yedekten hemen sonra
const autos: RetentionItem[] = [];
for (let i = 0; i < 400; i++) autos.push(item(`a${i}`, 'auto', at(2026, 10, 14 - i)));
const idOf = (d: Date) => autos.find((a) => a.createdAt.getTime() === d.getTime())!.id;
const expectedAuto = [
  // son 7 gun (14..8 Ekim)
  ...[14, 13, 12, 11, 10, 9, 8].map((d) => at(2026, 10, d)),
  // son 4 haftanin en yenileri (pazar gunleri; 11 Ekim yukarida)
  at(2026, 10, 4),
  at(2026, 9, 27),
  at(2026, 9, 20),
  // son 6 ayin en yenileri (ay sonlari; Ekim = 14 Ekim yukarida)
  at(2026, 9, 30),
  at(2026, 8, 31),
  at(2026, 7, 31),
  at(2026, 6, 30),
  at(2026, 5, 31),
  at(2026, 4, 30),
].map(idOf);
const autoPlan = planRetention(autos, { now, lowDisk: false });
assert.deepStrictEqual(sorted(autoPlan.keep), sorted(expectedAuto), 'otomatik: gun/hafta/ay');
assert.strictEqual(autoPlan.remove.length, 400 - expectedAuto.length);
assert.ok(!autoPlan.keep.has(idOf(at(2026, 10, 7))), '7 gun once (pencere disi, carsamba) silinir');
assert.ok(!autoPlan.keep.has(idOf(at(2026, 3, 31))), '6 aydan eski ay sonu silinir');

// Ayni plan ikinci kez uygulaninca bir sey silmez (kararli).
const kept = autos.filter((a) => autoPlan.keep.has(a.id));
assert.deepStrictEqual(planRetention(kept, { now, lowDisk: false }).remove, [], 'kararli');

// --- En yeni 3 her zaman: hepsi cok eski olsa bile ---
const oldAutos = [400, 500, 600, 700].map((d, i) => item(`o${i}`, 'auto', daysAgo(now, d)));
assert.deepStrictEqual(
  sorted(planRetention(oldAutos, { now, lowDisk: false }).keep),
  ['o0', 'o1', 'o2'],
  'otomatik: en yeni 3 kalir',
);

// --- Elle / guncelleme oncesi / disaridan: 90 gun + her turun en yeni 3'u ---
const others = [
  item('m1', 'manual', daysAgo(now, 1)),
  item('m2', 'manual', daysAgo(now, 30)),
  item('m3', 'manual', daysAgo(now, 89)),
  item('m4', 'manual', daysAgo(now, 91)),
  item('m5', 'manual', daysAgo(now, 200)),
  item('p1', 'pre_update', daysAgo(now, 120)),
  item('p2', 'pre_update', daysAgo(now, 150)),
  item('i1', 'imported', daysAgo(now, 100)),
  item('i2', 'imported', daysAgo(now, 101)),
  item('i3', 'imported', daysAgo(now, 102)),
  item('i4', 'imported', daysAgo(now, 103)),
  item('i5', 'imported', daysAgo(now, 10)),
  item('x1', 'bilinmeyen', daysAgo(now, 500)),
];
const otherPlan = planRetention(others, { now, lowDisk: false });
assert.deepStrictEqual(
  sorted(otherPlan.remove),
  ['i3', 'i4', 'm4', 'm5'],
  'elle: 90 gun icindekiler + en yeni 3; eski guncelleme oncesi ve tek bilinmeyen kalir',
);
const manyManual = [95, 96, 97, 98, 99].map((d, i) => item(`mm${i}`, 'manual', daysAgo(now, d)));
manyManual.push(item('mm-new', 'manual', daysAgo(now, 5)));
assert.deepStrictEqual(
  sorted(planRetention(manyManual, { now, lowDisk: false }).keep),
  ['mm-new', 'mm0', 'mm1'],
  '90 gun disinda en yeni 3 tamamlanir',
);

// --- Disk azaldi: en yeni 3 otomatik + diger her turun en yeni 1'i ---
const all = [...autos, ...others];
const low = planRetention(all, { now, lowDisk: true });
assert.deepStrictEqual(
  sorted(low.keep),
  sorted(['a0', 'a1', 'a2', 'm1', 'p1', 'i5', 'x1']),
  'disk azaldi kurallari',
);
assert.strictEqual(low.keep.size + low.remove.length, all.length);

// --- Esit zaman: sonuc kimlige gore belirli (deterministik) ---
const same = ['b', 'a', 'd', 'c'].map((id) => item(id, 'manual', daysAgo(now, 200)));
assert.deepStrictEqual(sorted(planRetention(same, { now, lowDisk: false }).keep), ['b', 'c', 'd']);

// --- Gelecek tarihli yedek (saat geri alinmis) en yeni sayilir ve kalir ---
const future = [...oldAutos, item('fut', 'auto', daysAgo(now, -2))];
assert.ok(planRetention(future, { now, lowDisk: false }).keep.has('fut'));

// --- Iki yillik gunluk calisma: her gun yedek + saklama; sayi sinirli, pencereler dolu ---
let live: RetentionItem[] = [];
let maxLive = 0;
const start = at(2025, 1, 1);
let day = at(2025, 1, 1);
for (let i = 0; i < 730; i++) {
  day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 6, 0, 0);
  live.push(item(`d${i}`, 'auto', day));
  const runAt = new Date(day.getTime() + 30_000);
  const { remove } = planRetention(live, { now: runAt, lowDisk: false });
  const doomed = new Set(remove);
  live = live.filter((b) => !doomed.has(b.id));
  maxLive = Math.max(maxLive, live.length);
}
const limit = RETENTION.dailyDays + RETENTION.weeklyWeeks + 1 + RETENTION.monthlyMonths + 1;
assert.ok(maxLive <= limit, `en fazla ${limit} otomatik yedek (gorulen ${maxLive})`);
const liveDays = new Set(live.map((b) => dayKey(b.createdAt)));
for (let d = 0; d < RETENTION.dailyDays; d++) {
  const key = dayKey(new Date(day.getFullYear(), day.getMonth(), day.getDate() - d));
  assert.ok(liveDays.has(key), `son 7 gunun her gunu: ${key}`);
}
const liveMonths = new Set(live.map((b) => monthKey(b.createdAt)));
for (let m = 0; m < RETENTION.monthlyMonths; m++) {
  const key = monthKey(new Date(day.getFullYear(), day.getMonth() - m, 1));
  assert.ok(liveMonths.has(key), `son 6 ayin her ayi: ${key}`);
}

// --- Disk esikleri ---
assert.strictEqual(isLowDisk({ freeBytes: 1 * GB, totalBytes: 100 * GB }), true, '1 GB bos');
assert.strictEqual(isLowDisk({ freeBytes: 15 * GB, totalBytes: 100 * GB }), false, '%15 bos');
assert.strictEqual(isLowDisk({ freeBytes: 5 * GB, totalBytes: 60 * GB }), true, '%8 bos');
assert.strictEqual(isLowDisk({ freeBytes: 1.9 * GB, totalBytes: 10 * GB }), true, '2 GB alti');
assert.strictEqual(isLowDisk({ freeBytes: 3 * GB, totalBytes: 10 * GB }), false, '3/10 GB');
assert.strictEqual(isLowDisk(null), false, 'okunamadi -> normal kurallar');
assert.strictEqual(isLowDisk({ freeBytes: 0, totalBytes: 0 }), false, 'gecersiz deger');

// --- Bulut kopyasi guvenligi (Linux ve Windows yollari) ---
const name = 'backup_2026-10-14T06-00-00-000Z.db.enc';
assert.ok(isSafeCloudCopy(`/bulut/${name}`, '/bulut', path.posix));
assert.ok(isSafeCloudCopy(`/bulut/${name}`, '/bulut/', path.posix), 'sondaki / farketmez');
assert.ok(!isSafeCloudCopy(`/bulut/alt/${name}`, '/bulut', path.posix), 'alt klasor');
assert.ok(!isSafeCloudCopy(`/bulut/../etc/${name}`, '/bulut', path.posix), 'klasor disi');
assert.ok(!isSafeCloudCopy(`/baska/${name}`, '/bulut', path.posix), 'ayar degismis');
assert.ok(!isSafeCloudCopy('/bulut/fatura.pdf', '/bulut', path.posix), 'bizim adimiz degil');
assert.ok(!isSafeCloudCopy(`/bulut/${name}.tmp`, '/bulut', path.posix), 'uzanti tutmaz');
assert.ok(!isSafeCloudCopy('/bulut/imported_x.db.enc', '/bulut', path.posix), 'yalniz backup_');
assert.ok(!isSafeCloudCopy(`/bulut/${name}`, '', path.posix), 'bulut klasoru kapali');
assert.ok(!isSafeCloudCopy(`/bulut/${name}`, null, path.posix), 'ayar yok');
assert.ok(!isSafeCloudCopy('/bulut', '/bulut', path.posix), 'klasorun kendisi');
assert.ok(
  isSafeCloudCopy(
    `C:\\Users\\Ali\\OneDrive\\Yedek\\${name}`,
    'c:\\users\\ali\\onedrive\\yedek',
    path.win32,
  ),
  'Windows: buyuk/kucuk harf farki',
);
assert.ok(!isSafeCloudCopy(`D:\\Yedek\\${name}`, 'C:\\Yedek', path.win32), 'Windows: baska surucu');
assert.ok(
  !isSafeCloudCopy(`C:\\Yedek\\Eski\\${name}`, 'C:\\Yedek', path.win32),
  'Windows: alt klasor',
);

// --- Yerel yedek dosyasi guvenligi ---
assert.ok(isOwnBackupFile(`/veri/backups/${name}`, '/veri/backups', path.posix));
assert.ok(isOwnBackupFile('/veri/backups/imported_2026_01X.db.enc', '/veri/backups', path.posix));
assert.ok(!isOwnBackupFile('/veri/backups/temp_01X.db', '/veri/backups', path.posix));
assert.ok(!isOwnBackupFile(`/baska/backups/${name}`, '/veri/backups', path.posix));
assert.ok(isOwnBackupFile(`C:\\Veri\\backups\\${name}`, 'c:\\veri\\BACKUPS', path.win32));

// --- Bulut kopyasi yolu: kayitli yol; eski kayitta ayarli klasor + dosya adi ---
assert.strictEqual(
  cloudCopyCandidate({ path: `/veri/backups/${name}`, cloudCopyPath: `/x/${name}` }, '/bulut'),
  `/x/${name}`,
);
assert.strictEqual(
  cloudCopyCandidate({ path: `/veri/backups/${name}`, cloudCopyPath: null }, '/bulut', path.posix),
  `/bulut/${name}`,
);
assert.strictEqual(
  cloudCopyCandidate({ path: `/veri/backups/${name}`, cloudCopyPath: null }, '  '),
  null,
);

console.log('✓ backup.retention self-check OK');
