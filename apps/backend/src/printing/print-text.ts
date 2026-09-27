import assert from 'node:assert';

export type PrintItem = {
  name?: string;
  quantity?: number;
  price?: number;
  total?: number;
  note?: string; // garson notu (mutfak fisinde)
};

export type PrintPaymentLine = {
  method: string; // cash | card | transfer | qr | debt
  amount: number; // TL
  change?: number; // nakit para ustu (TL)
};

export type PrintPayload = {
  text?: string;
  header?: string[]; // isletme adi, adres, telefon
  title?: string;
  table?: string; // "Bahçe · Masa 5" | "Gel-al"
  waiter?: string;
  orderNo?: string;
  date?: string; // ISO; yerel saatle basilir
  items?: PrintItem[];
  discount?: number;
  grandTotal?: number;
  payments?: PrintPaymentLine[];
  footer?: string[];
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Nakit',
  card: 'Kart',
  transfer: 'Havale',
  qr: 'QR',
  debt: 'Veresiye',
};
// 58 mm rulo ~32 karakter: ayirici her iki genislikte tek satir kalir.
const RULE = '-'.repeat(32);

/** TL tutari Turk bicimiyle ("1.234,50 TL"). */
export function formatTl(value: number): string {
  return `${Number(value).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
}

function formatQty(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toLocaleString('tr-TR', { maximumFractionDigits: 3 });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Soyut fis -> yaziciya gidecek duz metin (tutarlar TL, miktarlar birim). */
export function printText(payload: PrintPayload): string {
  if (payload.text) return `${payload.text}\r\n\r\n`;
  const lines: string[] = [];
  if (payload.header?.length) lines.push(...payload.header, '');
  if (payload.title) lines.push(payload.title);
  if (payload.table) lines.push(`Masa: ${payload.table}`);
  if (payload.waiter) lines.push(`Garson: ${payload.waiter}`);
  if (payload.orderNo) lines.push(`Adisyon: ${payload.orderNo}`);
  if (payload.date) lines.push(`Tarih: ${formatDate(payload.date)}`);
  if (payload.items?.length) {
    lines.push(RULE);
    for (const item of payload.items) {
      const total = item.total === undefined ? '' : `  ${formatTl(item.total)}`;
      lines.push(`${formatQty(item.quantity ?? 1)} x ${item.name ?? ''}${total}`);
      if (item.note) lines.push(`   Not: ${item.note}`);
    }
    lines.push(RULE);
  }
  if (payload.discount) lines.push(`İndirim: ${formatTl(payload.discount)}`);
  if (payload.grandTotal !== undefined) lines.push(`TOPLAM: ${formatTl(payload.grandTotal)}`);
  for (const payment of payload.payments ?? []) {
    lines.push(`${METHOD_LABELS[payment.method] ?? payment.method}: ${formatTl(payment.amount)}`);
    if (payment.change) lines.push(`Para üstü: ${formatTl(payment.change)}`);
  }
  if (payload.footer?.length) lines.push('', ...payload.footer);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Windows PowerShell 5.1 yonlendirilmis stdin'i konsolun OEM kod sayfasiyla
 * (TR'de 857, EN'de 437) okur: UTF-8 gonderilen "Çay", "Şiş" bozulur. Metin
 * base64 (salt ASCII, her kod sayfasinda ayni) gonderilir, PowerShell UTF-8 cozer.
 */
export function encodeForPowerShell(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Yazici adi ortam degiskeniyle gecilir. `-Command <metin>` sonrasindaki argumanlar
 * $args'a DEGIL komut metnine eklenir: eski `-Name $args[0]` bos kaliyor, bosluklu
 * adlar ("EPSON TM-T20II") ayri argumanlara bolunuyordu -> baski hic calismiyordu.
 */
export const PRINTER_ENV = 'ADO_PRINTER_NAME';

/** stdin = encodeForPowerShell(metin); yazici adi = env[PRINTER_ENV]. */
export const POWERSHELL_PRINT_SCRIPT =
  "$b = [string]::Join('', @($input)); " +
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | Out-Printer -Name $env:${PRINTER_ENV}`;

/**
 * Yuklu Windows yazicilarinin adlari. Cikti base64(JSON): konsol OEM kod sayfasiyla
 * yazdigi icin "Mutfak Yazıcısı" gibi adlar duz metinde bozulurdu.
 */
export const POWERSHELL_LIST_PRINTERS_SCRIPT =
  '$n = @(Get-Printer | ForEach-Object { $_.Name }); ' +
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $n -Compress)))';

export function decodePrinterList(stdout: string): string[] {
  const parsed: unknown = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8') || '[]');
  const names = Array.isArray(parsed) ? parsed : [parsed];
  return names.filter((name): name is string => typeof name === 'string' && name.trim() !== '');
}

/** Fis listesinde tek satirlik ozet ("MUTFAK FİŞİ · Bahçe · Masa 5 · 20260927-0007"). */
export function printSummary(payload: PrintPayload): string {
  if (payload.text) return payload.text.split(/\r?\n/)[0] ?? '';
  return [payload.title, payload.table, payload.orderNo].filter(Boolean).join(' · ');
}

// --- self-check: `ts-node src/printing/print-text.ts` ---
if (require.main === module) {
  const text = printText({
    title: 'MÜŞTERİ FİŞİ',
    orderNo: '20260927-0007',
    items: [
      { name: 'Çay', quantity: 2, total: 30 },
      { name: 'Şiş Köfte', quantity: 1, total: 185.5 },
      { name: 'İçli köfte (ğüöı)', quantity: 0.5, total: 40 },
    ],
    discount: 10,
    grandTotal: 245.5,
  });
  assert.ok(text.includes('2 x Çay  30,00 TL'), 'kalem satiri (Turk para bicimi)');
  assert.ok(text.includes('0,5 x İçli köfte (ğüöı)  40,00 TL'), 'kesirli miktar virgulle');
  assert.ok(text.includes('İndirim: 10,00 TL'), 'indirim etiketi Turkce');
  assert.ok(text.includes('TOPLAM: 245,50 TL'), 'toplam');
  assert.strictEqual(formatTl(1234.5), '1.234,50 TL', 'binlik ayirac');

  // Mutfak fisi: masa, garson, saat ve kalem notu (eskiden yalniz adisyon no + kalemler).
  const kitchen = printText({
    title: 'MUTFAK FİŞİ',
    table: 'Bahçe · Masa 5',
    waiter: 'Ali',
    orderNo: '20260927-0007',
    date: '2026-09-27T11:35:00.000Z',
    items: [{ name: 'Adana', quantity: 2, note: 'az pişmiş, soğansız' }],
  });
  assert.ok(kitchen.includes('Masa: Bahçe · Masa 5'), 'mutfak fisinde masa');
  assert.ok(kitchen.includes('Garson: Ali'), 'mutfak fisinde garson');
  assert.match(kitchen, /Tarih: \d{2}\.\d{2}\.2026 \d{2}:\d{2}/, 'tarih/saat yerel bicimde');
  assert.ok(kitchen.includes('2 x Adana\r\n   Not: az pişmiş, soğansız'), 'not kalemin altinda');

  // Musteri fisi: isletme basligi, odeme satirlari + para ustu, mali deger notu.
  const receipt = printText({
    header: ['Lezzet Lokantası', 'Atatürk Cad. 1', 'Tel: 0212 000 00 00'],
    title: 'MÜŞTERİ FİŞİ',
    grandTotal: 145,
    payments: [
      { method: 'card', amount: 50 },
      { method: 'cash', amount: 95, change: 5 },
    ],
    footer: ['Bilgi fişidir — mali değeri yoktur.'],
  });
  assert.ok(receipt.startsWith('Lezzet Lokantası\r\nAtatürk Cad. 1\r\n'), 'baslik en ustte');
  assert.ok(
    receipt.includes('Kart: 50,00 TL\r\nNakit: 95,00 TL\r\nPara üstü: 5,00 TL'),
    'odeme satirlari',
  );
  assert.ok(receipt.includes('Bilgi fişidir — mali değeri yoktur.'), 'mali deger notu');

  const encoded = encodeForPowerShell(text);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/, 'base64 salt ASCII (kod sayfasindan bagimsiz)');
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf8'), text, 'Turkce roundtrip');
  assert.strictEqual(printText({ text: 'Test fişi' }), 'Test fişi\r\n\r\n', 'serbest metin');
  assert.ok(POWERSHELL_PRINT_SCRIPT.includes('-Name $env:ADO_PRINTER_NAME'), 'yazici adi env ile');
  assert.ok(
    !POWERSHELL_PRINT_SCRIPT.includes('$args'),
    '$args kullanilmaz (-Command metnine eklenir)',
  );

  const listOut = (names: unknown) =>
    Buffer.from(JSON.stringify(names), 'utf8').toString('base64') + '\r\n';
  assert.deepStrictEqual(
    decodePrinterList(listOut(['EPSON TM-T20II', 'Mutfak Yazıcısı'])),
    ['EPSON TM-T20II', 'Mutfak Yazıcısı'],
    'yazici listesi Turkce adlarla cozulur',
  );
  assert.deepStrictEqual(decodePrinterList(listOut('Tek Yazıcı')), ['Tek Yazıcı'], 'tek ad');
  assert.deepStrictEqual(decodePrinterList(listOut([])), [], 'yazici yok');
  assert.deepStrictEqual(decodePrinterList(''), [], 'bos cikti');
  assert.strictEqual(
    printSummary({ title: 'MUTFAK FİŞİ', table: 'Bahçe · Masa 5', orderNo: '20260927-0007' }),
    'MUTFAK FİŞİ · Bahçe · Masa 5 · 20260927-0007',
  );
  assert.strictEqual(
    printSummary({ text: 'Yazıcı Sınama Sayfası\nDurum' }),
    'Yazıcı Sınama Sayfası',
  );

  console.log('✓ print-text self-check OK');
}
