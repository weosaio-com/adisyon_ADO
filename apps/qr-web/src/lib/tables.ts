/** Masadaki QR'in actigi adres (panel ayni kokende calisir). */
export function tableMenuUrl(origin: string, code: string): string {
  return `${origin}/m/${code}`;
}

/** Siradaki bos "Masa N" adi: art arda masa eklemek tek tikla olsun. */
export function nextTableName(names: readonly string[]): string {
  const used = new Set(names.map((name) => name.trim().toLocaleLowerCase('tr')));
  let n = names.length + 1;
  while (used.has(`masa ${n}`)) n += 1;
  return `Masa ${n}`;
}
