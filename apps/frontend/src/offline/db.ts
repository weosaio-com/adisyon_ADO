// IndexedDB kalici katmani (ado-offline). OFFLINE_DESIGN.md §4
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ulid } from './ids';
import { compareOutbox, type DraftOrder, type OutboxEntry, type SyncProblem } from './sync-core';

interface AdoDB extends DBSchema {
  outbox: { key: string; value: OutboxEntry };
  drafts: { key: string; value: DraftOrder };
  meta: { key: string; value: { key: string; data: unknown } };
  // v2: sunucunun kabul etmedigi / onaya aldigi kayitlar (garsona gosterilir, "Anladım" ile silinir).
  problems: { key: string; value: SyncProblem };
}

const OUTBOX_SEQ = 'outboxSeq';

let dbp: Promise<IDBPDatabase<AdoDB>> | null = null;
function db(): Promise<IDBPDatabase<AdoDB>> {
  if (!dbp) {
    dbp = openDB<AdoDB>('ado-offline', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('outbox', { keyPath: 'clientOpId' });
          d.createObjectStore('drafts', { keyPath: 'id' });
          d.createObjectStore('meta', { keyPath: 'key' });
        }
        if (oldVersion < 2) d.createObjectStore('problems', { keyPath: 'id' });
      },
      // Baska sekme yeni surumu acmak isterse bu baglanti kapanir (yeni surum beklemez).
      blocking() {
        void dbp?.then((open) => open.close());
        dbp = null;
      },
    });
  }
  return dbp;
}

export async function metaGet<T>(key: string): Promise<T | undefined> {
  const row = await (await db()).get('meta', key);
  return row?.data as T | undefined;
}
export async function metaSet(key: string, data: unknown): Promise<void> {
  await (await db()).put('meta', { key, data });
}

// Cihaz kimligi: ilk kayitta uretilir, kalici. OFFLINE_DESIGN.md §4.4
export async function deviceId(): Promise<string> {
  let id = await metaGet<string>('deviceId');
  if (!id) {
    id = ulid();
    await metaSet('deviceId', id);
  }
  return id;
}

/**
 * Taslak + outbox kayitlarini TEK IndexedDB isleminde yazar (OFF-11): sekme arada kapansa da
 * ekranda gorunen kalem kuyruga girmis olur (ya da hicbiri yazilmaz). Her kayda artan sira
 * numarasi (seq) verilir (OFF-17): gonderim sirasi tablet saatine (ULID zamani) bagli kalmaz.
 */
export async function enqueue(draft: DraftOrder | null, entries: OutboxEntry[]): Promise<void> {
  const tx = (await db()).transaction(['outbox', 'drafts', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  let seq = Number((await meta.get(OUTBOX_SEQ))?.data ?? 0);
  for (const entry of entries) {
    seq += 1;
    await tx.objectStore('outbox').put({ ...entry, seq });
  }
  await meta.put({ key: OUTBOX_SEQ, data: seq });
  if (draft) await tx.objectStore('drafts').put(draft);
  await tx.done;
}

/** Taslagi ve (verilirse) outbox kayitlarini tek islemde gunceller / siler. */
export async function saveDraftAndOutbox(
  draft: DraftOrder,
  change: { put?: OutboxEntry[]; remove?: string[] },
): Promise<void> {
  const tx = (await db()).transaction(['outbox', 'drafts'], 'readwrite');
  for (const entry of change.put ?? []) await tx.objectStore('outbox').put(entry);
  for (const id of change.remove ?? []) await tx.objectStore('outbox').delete(id);
  await tx.objectStore('drafts').put(draft);
  await tx.done;
}

export async function outboxAll(): Promise<OutboxEntry[]> {
  const all = await (await db()).getAll('outbox');
  return all.sort(compareOutbox);
}
export async function outboxCount(): Promise<number> {
  return (await db()).count('outbox');
}
export async function outboxGet(id: string): Promise<OutboxEntry | undefined> {
  return (await db()).get('outbox', id);
}
export async function outboxDelete(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = (await db()).transaction('outbox', 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}
/** Gonderimdeki kayitlari isaretler (inflight) ya da geri alir (pending). OFFLINE_DESIGN.md §6 */
export async function outboxMark(ids: string[], status: OutboxEntry['status']): Promise<void> {
  if (ids.length === 0) return;
  const tx = (await db()).transaction('outbox', 'readwrite');
  for (const id of ids) {
    const entry = await tx.store.get(id);
    if (entry && entry.status !== status) await tx.store.put({ ...entry, status });
  }
  await tx.done;
}
/** Acilista: onceki oturumda yolda kalan (inflight) kayitlar yeniden gonderilecek (pending). */
export async function outboxResetInflight(): Promise<void> {
  const all = await (await db()).getAll('outbox');
  await outboxMark(
    all.filter((entry) => entry.status === 'inflight').map((entry) => entry.clientOpId),
    'pending',
  );
}

export async function draftGet(id: string): Promise<DraftOrder | undefined> {
  return (await db()).get('drafts', id);
}
export async function draftAll(): Promise<DraftOrder[]> {
  return (await db()).getAll('drafts');
}
export async function draftPut(o: DraftOrder): Promise<void> {
  await (await db()).put('drafts', o);
}
export async function draftDelete(id: string): Promise<void> {
  await (await db()).delete('drafts', id);
}

/** Sunucunun kabul etmedigi kayit: outbox'tan cikar, sorun listesine yazilir (tek islem). */
export async function problemsAdd(problems: SyncProblem[], removeFromOutbox: string[] = []) {
  if (problems.length === 0 && removeFromOutbox.length === 0) return;
  const tx = (await db()).transaction(['problems', 'outbox'], 'readwrite');
  for (const problem of problems) await tx.objectStore('problems').put(problem);
  for (const id of removeFromOutbox) await tx.objectStore('outbox').delete(id);
  await tx.done;
}
export async function problemsAll(): Promise<SyncProblem[]> {
  const all = await (await db()).getAll('problems');
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
export async function problemPut(problem: SyncProblem): Promise<void> {
  await (await db()).put('problems', problem);
}
export async function problemsDelete(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = (await db()).transaction('problems', 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}
