// Rapor çıktısı: CSV (Excel açar) üretimi. Türkiye Windows Excel'i liste ayracı
// olarak ';' kullanır; UTF-8 BOM ile Türkçe karakterler bozulmaz.

const SEP = ';';

// Bir hücreyi CSV-güvenli hale getir: ayraç/tırnak/yeni satır içeriyorsa tırnakla.
function cell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  if (s.includes('"') || s.includes(SEP) || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(cell).join(SEP));
  return '﻿' + lines.join('\r\n'); // BOM + CRLF (Excel dostu)
}

// Tarayıcıda metin dosyası indir (CSV, kurtarma anahtarı vb.).
export function downloadText(
  filename: string,
  text: string,
  type = 'text/plain;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Tarayıcıda CSV dosyası indir. filename'e .csv eklenir (yoksa).
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null)[][],
): void {
  downloadText(
    filename.endsWith('.csv') ? filename : `${filename}.csv`,
    toCsv(headers, rows),
    'text/csv;charset=utf-8',
  );
}
