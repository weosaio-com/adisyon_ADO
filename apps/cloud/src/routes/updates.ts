import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/http';

/**
 * Program guncellemeleri (UPDATE_SYSTEM.md): R2 `UPDATES` deposunda `<kanal>/<dosya>`. Yetki yok:
 * guvenlik imzadadir (program bildirimin Ed25519 imzasini ve dosyanin SHA-512 ozetini dogrular).
 * Imzali bildirim ve latest.yml her seferinde denetlenir (no-cache); kurulum dosyasi surume ozel
 * adla suresiz onbelleklenir. Tek aralikli (Range) istek desteklenir.
 */
export const updateRoutes = new Hono<AppEnv>();

const CHANNELS = new Set(['stable', 'beta']);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ALWAYS_FRESH = new Set(['ado-update.json', 'latest.yml']);
const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=UTF-8',
  yml: 'text/yaml; charset=UTF-8',
  exe: 'application/vnd.microsoft.portable-executable',
  blockmap: 'application/octet-stream',
};

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Dosya bulunamadı.');

/** Tek aralik: "bytes=a-b" | "bytes=a-" | "bytes=-n". Coklu ya da bozuk aralikta tum dosya verilir. */
function parseRange(header: string | undefined): R2Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return Number(match[2]) > 0 ? { suffix: Number(match[2]) } : null;
  const offset = Number(match[1]);
  if (!match[2]) return { offset };
  const end = Number(match[2]);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

updateRoutes.get('/updates/:channel/:file', async (c) => {
  const { channel, file } = c.req.param();
  const contentType = CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
  if (!CHANNELS.has(channel) || !FILE_NAME.test(file) || !contentType || !c.env.UPDATES) {
    throw notFound();
  }
  const range = parseRange(c.req.header('Range'));
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await c.env.UPDATES.get(`${channel}/${file}`, {
      onlyIf: c.req.raw.headers,
      ...(range ? { range } : {}),
    });
  } catch {
    // Dosya disi aralik.
    return c.body(null, 416, { 'Accept-Ranges': 'bytes' });
  }
  if (!object) throw notFound();
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': ALWAYS_FRESH.has(file) ? 'no-cache' : 'public, max-age=31536000, immutable',
    ETag: object.httpEtag,
    'Accept-Ranges': 'bytes',
  };
  // onlyIf kosulu (If-None-Match) tuttuysa govde gelmez.
  if (!('body' in object)) return c.body(null, 304, headers);
  if (range) {
    const offset =
      'suffix' in range ? Math.max(0, object.size - range.suffix) : (range.offset ?? 0);
    const end =
      'suffix' in range || range.length === undefined
        ? object.size
        : Math.min(object.size, offset + range.length);
    headers['Content-Range'] = `bytes ${offset}-${end - 1}/${object.size}`;
    headers['Content-Length'] = String(end - offset);
    return c.body(object.body, 206, headers);
  }
  headers['Content-Length'] = String(object.size);
  return c.body(object.body, 200, headers);
});
