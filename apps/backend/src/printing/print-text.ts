import assert from 'node:assert';

export type PrintItem = {
  name?: string;
  quantity?: number;
  price?: number;
  total?: number;
};

export type PrintPayload = {
  text?: string;
  title?: string;
  orderNo?: string;
  date?: string;
  items?: PrintItem[];
  discount?: number;
  grandTotal?: number;
};

/** Soyut fis -> yaziciya gidecek duz metin (tutarlar TL, miktarlar birim). */
export function printText(payload: PrintPayload): string {
  if (payload.text) return `${payload.text}\r\n\r\n`;
  const lines = [String(payload.title ?? ''), `Adisyon: ${payload.orderNo ?? '-'}`, ''];
  for (const item of payload.items ?? []) {
    const quantity = item.quantity ?? 1;
    const total = item.total === undefined ? '' : `  ${Number(item.total).toFixed(2)} TL`;
    lines.push(`${quantity} x ${item.name ?? ''}${total}`);
  }
  if (payload.discount) lines.push(`İndirim: ${Number(payload.discount).toFixed(2)} TL`);
  if (payload.grandTotal !== undefined) {
    lines.push('', `TOPLAM: ${Number(payload.grandTotal).toFixed(2)} TL`);
  }
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

/** Fis listesinde tek satirlik ozet ("MUTFAK FİŞİ · 20260927-0007"). */
export function printSummary(payload: PrintPayload): string {
  if (payload.text) return payload.text.split(/\r?\n/)[0] ?? '';
  return [payload.title, payload.orderNo].filter(Boolean).join(' · ');
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
  assert.ok(text.includes('2 x Çay  30.00 TL'), 'kalem satiri');
  assert.ok(text.includes('İndirim: 10.00 TL'), 'indirim etiketi Turkce');
  assert.ok(text.includes('TOPLAM: 245.50 TL'), 'toplam');

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
    printSummary({ title: 'MUTFAK FİŞİ', orderNo: '20260927-0007' }),
    'MUTFAK FİŞİ · 20260927-0007',
  );
  assert.strictEqual(
    printSummary({ text: 'Yazıcı Sınama Sayfası\nDurum' }),
    'Yazıcı Sınama Sayfası',
  );

  console.log('✓ print-text self-check OK');
}
