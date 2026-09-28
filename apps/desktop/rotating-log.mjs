// Boyut sinirli log yazicisi (Electron'suz; selfcheck.mjs ile test edilir).
// Dosya maxBytes'i asacaksa `<path>.1`'e doner: diskte en fazla ~2 x maxBytes kalir.
import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { Writable } from 'node:stream';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

// Eski surumler logu sinirsiz buyutuyordu: acilista sinir asilmissa yalniz son
// maxBytes'i `.1`'e al, buyuk dosyayi sil (disk hemen bosalir, son kayitlar kalir).
function keepTail(path, maxBytes) {
  const { size } = statSync(path);
  if (size <= maxBytes) return;
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(maxBytes);
    readSync(fd, tail, 0, maxBytes, size - maxBytes);
    writeFileSync(`${path}.1`, tail);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** `(chunk) => void` yazici dondurur; child.stdout/stderr 'data' olayina baglanir. */
export function rotatingLog(path, maxBytes = LOG_MAX_BYTES) {
  try {
    if (existsSync(path)) keepTail(path, maxBytes);
  } catch {
    // Kirpilamazsa (kilitli dosya vb.) asagidaki donus yine siniri korur.
  }
  let size = existsSync(path) ? statSync(path).size : 0;
  const finished = [];
  // Dosya eszamanli acilir: donus aninda diskte olmasi garanti (asenkron acilista
  // rename bos dosyayi kacirip veriyi kaybediyordu).
  const open = (flags) => {
    try {
      const stream = createWriteStream(path, { fd: openSync(path, flags) });
      // Log yazilamamasi (disk dolu vb.) ana sureci asla dusurmemeli.
      stream.on('error', () => {});
      return stream;
    } catch {
      return new Writable({ write: (_chunk, _enc, done) => done() });
    }
  };
  let stream = open('a');

  const write = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (size > 0 && size + bytes > maxBytes) {
      const old = stream;
      finished.push(new Promise((resolve) => old.end(resolve)));
      let flags = 'a';
      try {
        renameSync(path, `${path}.1`);
      } catch {
        // Dondurulemezse bastan yaz; sinir yine korunur.
        flags = 'w';
      }
      stream = open(flags);
      size = 0;
    }
    stream.write(chunk);
    size += bytes;
  };
  // Test/kapanis icin: tum akislar diske yazilana kadar bekler.
  write.close = () =>
    Promise.all([...finished, new Promise((resolve) => stream.end(resolve))]).then(() => {});
  return write;
}
