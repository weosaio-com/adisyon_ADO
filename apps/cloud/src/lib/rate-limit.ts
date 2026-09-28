import { ApiError } from './http';

/**
 * Sabit pencereli sayac (D1). Giris ve eslestirme kodu denemelerini sinirlar: kaba kuvvetle
 * parola/kod denemesi pratikte imkansizlasir. Eski satirlar ara sira temizlenir.
 */
export async function hit(db: D1Database, key: string, windowSec: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (Math.random() < 0.02) {
    await db
      .prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - 86_400)
      .run();
  }
  return row?.count ?? 1;
}

/** Sinir asildiysa 429. `keys` ornegin IP ve e-posta: ikisi de ayri ayri sayilir. */
export async function limit(
  db: D1Database,
  keys: string[],
  max: number,
  windowSec: number,
): Promise<void> {
  const counts = await Promise.all(keys.map((key) => hit(db, key, windowSec)));
  if (counts.some((count) => count > max)) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Çok fazla deneme. Biraz sonra tekrar deneyin.');
  }
}
