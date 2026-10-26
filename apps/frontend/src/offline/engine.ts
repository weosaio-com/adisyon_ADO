// Sync Engine: baglanti durum makinesi + outbox drain. OFFLINE_DESIGN.md §7, §10
import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError, getAccess } from '../lib/api';
import {
  deviceId,
  draftAll,
  draftDelete,
  draftGet,
  draftPut,
  metaGet,
  metaSet,
  outboxAll,
  outboxCount,
  outboxMark,
  outboxResetInflight,
  problemDeleteOne,
  problemPut,
  problemsAdd,
  problemsAll,
} from './db';
import {
  CHUNK_MAX_BYTES,
  SHADOW_PREFIX,
  applyResults,
  chunkEntries,
  classifyFailure,
  describeEntry,
  problemMessage,
  wireMutation,
  wireSize,
  type FailureKind,
  type MutationResult,
  type OutboxEntry,
  type SyncProblem,
} from './sync-core';

const BASE = '/api/v1';
// Saglik yoklamasi hafiftir; cevap gelmeyen sunucu bu surede "kopuk" sayilir (tik 8 sn).
const PING_TIMEOUT_MS = 5_000;
const TICK_MS = 8_000;

/**
 * online: bagli, bekleyen yok (ya da gonderildi). offline: sunucuya hic ulasilamiyor.
 * syncing: gonderiliyor. waiting: sunucu ulasilir ama simdi kabul etmiyor (mesgul, oturum,
 * yetki); kayitlar korunur, nedeni `note`ta.
 */
export type SyncMode = 'online' | 'offline' | 'syncing' | 'waiting';
export interface SyncState {
  mode: SyncMode;
  pending: number;
  /** Sunucunun kabul etmedigi / onaya aldigi kayitlar (garson "Anladım" deyince silinir). */
  problems: number;
  note: string;
}

let state: SyncState = { mode: 'online', pending: 0, problems: 0, note: '' };
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function set(patch: Partial<SyncState>) {
  const next = { ...state, ...patch };
  if (
    next.mode === state.mode &&
    next.pending === state.pending &&
    next.problems === state.problems &&
    next.note === state.note
  ) {
    return;
  }
  state = next;
  emit();
}

// useSyncExternalStore icin
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getState(): SyncState {
  return state;
}
export function isOffline(): boolean {
  return state.mode === 'offline';
}

let qc: QueryClient | null = null;
let draining = false;
let again = false;
let lastSnapshot = 0; // katalog cache tazelik damgasi (offline reboot icin sicak tut)

/** Bekleyen kayit ve sorun sayaclarini IndexedDB'den tazeler. */
export async function refreshPending(): Promise<void> {
  const [pending, problems] = await Promise.all([outboxCount(), problemsAll()]);
  set({ pending, problems: problems.length });
}

async function ping(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/sync/health`, { cache: 'no-store', signal: controller.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Aktif durum anlik goruntusu -> cache (offline gosterim icin). §7.2
// api() kullanir: 401'de sessizce token yeniler (uzun offline sonrasi, §12).
export async function pullSnapshot(): Promise<void> {
  try {
    const snap = await api<unknown>('/sync/snapshot');
    await metaSet('snapshot', snap);
    lastSnapshot = Date.now();
  } catch {
    /* offline veya yetki yok: eski cache kalir */
  }
}

export async function cachedSnapshot<T = unknown>(): Promise<T | undefined> {
  return metaGet<T>('snapshot');
}

/** Kaydin sorun listesindeki karsiligi (garsona gosterilir). */
async function problemFor(
  entry: OutboxEntry,
  kind: SyncProblem['kind'],
  reason: string,
  reviewId?: string,
): Promise<SyncProblem> {
  const draft =
    entry.localOrderId.startsWith('local:') || entry.localOrderId.startsWith(SHADOW_PREFIX)
      ? await draftGet(entry.localOrderId)
      : undefined;
  const what = describeEntry(entry, draft);
  const serverOrderId =
    draft?.serverId ??
    (typeof entry.payload.orderId === 'string' ? entry.payload.orderId : undefined);
  const tableId = draft?.tableId ?? entry.tableId;
  return {
    id: entry.clientOpId,
    kind,
    type: entry.type,
    reason,
    message: problemMessage(kind, reason, what),
    what,
    localOrderId: entry.localOrderId,
    ...(serverOrderId ? { serverOrderId } : {}),
    ...(tableId ? { tableId } : {}),
    orderLabel: draft ? draft.orderNo.replace(/^⏳\s*/, '') : (entry.label ?? 'Adisyon'),
    ...(reviewId ? { reviewId } : {}),
    createdAt: Date.now(),
  };
}

// Bir dilimin sunucu sonuclarini uygula: islenenler outbox'tan cikar; reddedilen / onaya
// alinan kayitlar sorun listesine yazilir (garsona soylenmeden silinmez, OFF-3).
async function applyChunk(chunk: OutboxEntry[], results: MutationResult[]): Promise<void> {
  const byId = new Map(chunk.map((entry) => [entry.clientOpId, entry]));
  const oc = applyResults(results.filter((r) => byId.has(r.clientOpId)));

  // OPEN_TABLE applied -> local drafta gercek server id yaz (OrderScreen yonlendirir)
  for (const entry of chunk) {
    const sid = oc.serverIdByOpId[entry.clientOpId];
    if (sid && entry.type === 'OPEN_TABLE') {
      const draft = await draftGet(entry.localOrderId);
      if (draft) await draftPut({ ...draft, serverId: sid, syncedAt: Date.now() });
    }
  }
  const problems: SyncProblem[] = [];
  for (const r of [...oc.conflicts, ...oc.rejections]) {
    const entry = byId.get(r.clientOpId);
    if (!entry) continue;
    const kind = r.status === 'conflict' ? 'conflict' : 'rejected';
    problems.push(await problemFor(entry, kind, r.reason ?? r.status, r.reviewId));
  }
  await problemsAdd(problems, oc.remove);
  // Sunucu adisyonuna cevrimdisi eklenen kalem islendi (uygulandi / reddedildi / onaya dustu):
  // golge taslaktan duser; ekran sunucu adisyonunu (ya da sorun kutusunu) gosterir. OFF-4
  const shadowIds = new Set(
    chunk
      .filter((e) => e.localOrderId.startsWith(SHADOW_PREFIX) && oc.remove.includes(e.clientOpId))
      .map((e) => e.localOrderId),
  );
  for (const shadowId of shadowIds) {
    const shadow = await draftGet(shadowId);
    if (!shadow) continue;
    const items = shadow.items.filter((item) => !oc.remove.includes(item.id));
    const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
    await draftPut({ ...shadow, items, subtotal: total, grandTotal: total });
  }
  // OPEN_TABLE onaya dustu: taslak "onayda" (masa planinda hayalet "Senkron bekliyor" kalmaz);
  // reddedildi: taslak silinir (garson sorun listesinden ogrenir). OFF-8
  for (const r of [...oc.conflicts, ...oc.rejections]) {
    const entry = byId.get(r.clientOpId);
    if (entry?.type !== 'OPEN_TABLE') continue;
    const draft = await draftGet(entry.localOrderId);
    if (!draft) continue;
    if (r.status === 'conflict') {
      await draftPut({
        ...draft,
        review: { reason: r.reason ?? 'other', ...(r.reviewId ? { reviewId: r.reviewId } : {}) },
      });
    } else {
      await draftDelete(draft.id);
    }
  }
}

interface ReviewStatus {
  clientOpId: string;
  status: string; // open | resolved | rejected | unknown
  orderId: string | null;
}

/**
 * Onaya dusen kayitlarin sonucunu sorar (OFF-8): onaylanan masa acma taslagi sunucu adisyonuna
 * baglanir (ekran oraya gecer), reddedilen taslak silinir ve garsona "yönetici reddetti" denir.
 * Rozet acik onay sayisini izler: sonuclanan onay sorun listesinden duser.
 */
async function pollReviews(): Promise<void> {
  const open = (await problemsAll()).filter((p) => p.kind === 'conflict');
  if (open.length === 0) return;
  const statuses = await api<ReviewStatus[]>('/sync/reviews/status', {
    method: 'POST',
    body: { clientOpIds: open.slice(0, 500).map((p) => p.id) },
  });
  let changed = false;
  for (const s of statuses) {
    const problem = open.find((p) => p.id === s.clientOpId);
    if (!problem || (s.status !== 'resolved' && s.status !== 'rejected')) continue;
    changed = true;
    const draft = problem.type === 'OPEN_TABLE' ? await draftGet(problem.localOrderId) : undefined;
    if (s.status === 'resolved') {
      if (draft && s.orderId) {
        const { review: _review, ...rest } = draft;
        await draftPut({ ...rest, serverId: s.orderId, syncedAt: Date.now() });
      }
      await problemDeleteOne(problem.id);
    } else {
      if (draft) await draftDelete(draft.id);
      await problemPut({
        ...problem,
        kind: 'rejected',
        reason: 'REVIEW_REJECTED',
        message: problemMessage('rejected', 'REVIEW_REJECTED', problem.what),
      });
    }
  }
  if (changed) {
    await refreshPending();
    qc?.invalidateQueries();
  }
}

/** Sunucuya gecmis taslaklar bir dakika sonra silinir (bekleyen kaydi yoksa). */
async function cleanupDrafts(): Promise<void> {
  const [drafts, entries] = await Promise.all([draftAll(), outboxAll()]);
  const busy = new Set(entries.map((entry) => entry.localOrderId));
  for (const draft of drafts) {
    if (busy.has(draft.id)) continue;
    // Golge taslak: tum kalemleri sunucuya gecince silinir.
    const stale = draft.id.startsWith(SHADOW_PREFIX)
      ? draft.items.length === 0
      : draft.serverId && Date.now() - (draft.syncedAt ?? 0) > 60_000;
    if (stale) await draftDelete(draft.id);
  }
}

// Sunucunun istek olarak reddettigi tek kayit: kuyrugu kilitlemesin diye ayrilir.
async function quarantine(entry: OutboxEntry, error: unknown): Promise<void> {
  const reason =
    error instanceof ApiError
      ? error.code && error.code !== 'ERROR'
        ? error.code
        : String(error.status)
      : 'ERROR';
  await problemsAdd([await problemFor(entry, 'failed', reason)], [entry.clientOpId]);
}

function waitingNote(kind: FailureKind, error: unknown): string {
  if (kind === 'blocked') {
    return error instanceof ApiError && error.status === 403
      ? 'Bu kullanıcının sipariş gönderme yetkisi yok; yöneticinize haber verin.'
      : 'Oturum süresi doldu; yeniden giriş yapınca gönderilecek.';
  }
  return 'Ana bilgisayar şu an yanıt veremiyor; birazdan tekrar denenecek.';
}

type DrainResult = 'done' | FailureKind;

/**
 * Outbox'i dilimler halinde SIRAYLA gonderir (OFF-1): her dilim en cok 100 kayit / ~64 KB.
 * Bir dilim istek olarak reddedilirse (400/413/422) ikiye bolunur; tek kayitta hata o kayda
 * aittir: sorun listesine ayrilir, kalanlar gonderilmeye devam eder. "Çevrimdışı" yalniz
 * sunucuya hic ulasilamadiginda; mesgul/oturum/yetki durumunda kayitlar korunur ("waiting").
 */
async function drainOnce(): Promise<DrainResult> {
  const entries = (await outboxAll()).filter((entry) => entry.status !== 'inflight');
  if (entries.length === 0) {
    await refreshPending();
    return 'done';
  }
  set({ mode: 'syncing', note: '' });
  const dev = await deviceId();
  const queue = chunkEntries(entries);
  let result: DrainResult = 'done';
  let failure: unknown;
  let progressed = false;
  while (queue.length > 0) {
    const chunk = queue.shift()!;
    const ids = chunk.map((entry) => entry.clientOpId);
    await outboxMark(ids, 'inflight');
    try {
      // api(): 401'de sessizce token yeniler + retry (uzun offline sonrasi reconnect, §12).
      const body = await api<{ results?: MutationResult[] }>('/sync/mutations', {
        method: 'POST',
        body: { deviceId: dev, mutations: chunk.map(wireMutation) },
      });
      await applyChunk(chunk, body.results ?? []);
      progressed = true;
    } catch (error) {
      await outboxMark(ids, 'pending');
      const kind =
        error instanceof ApiError ? classifyFailure(error.status, error.code) : 'offline';
      const oversized = chunk.length === 1 && wireSize(chunk[0]!) > CHUNK_MAX_BYTES;
      if (kind === 'split' || (oversized && kind !== 'offline')) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          queue.unshift(chunk.slice(0, mid), chunk.slice(mid));
        } else {
          await quarantine(chunk[0]!, error);
          progressed = true;
        }
        continue;
      }
      result = kind;
      failure = error;
      break;
    }
  }
  await refreshPending();
  if (progressed) {
    await pullSnapshot();
    qc?.invalidateQueries();
  }
  if (result === 'offline') set({ mode: 'offline', note: '' });
  else if (result === 'done') set({ mode: 'online', note: '' });
  else set({ mode: 'waiting', note: waitingNote(result, failure) });
  return result;
}

// Outbox'i sunucuya it, sonuclari uygula. §7.1 Gonderim surerken eklenen kayitlar ayni
// turda ardindan gonderilir (bir sonraki tiki beklemez).
export async function drain(): Promise<void> {
  if (draining) {
    again = true;
    return;
  }
  draining = true;
  try {
    let result: DrainResult;
    do {
      again = false;
      result = await drainOnce();
    } while (again && result === 'done');
  } finally {
    draining = false;
  }
}

// Aksiyonlar cagirir: outbox degisti -> sayaci tazele, hemen boslatmayi dene.
export async function kick(): Promise<void> {
  await refreshPending();
  void drain();
}

export function startEngine(client: QueryClient): () => void {
  qc = client;
  // Onceki oturumda yolda kalan kayitlar yeniden gonderilecek (sunucu tekrari tanir). §6
  void outboxResetInflight()
    .catch(() => {})
    .then(refreshPending);

  const runTick = async () => {
    const online = await ping();
    if (!online) {
      set({ mode: 'offline', note: '' });
      return;
    }
    const pending = await outboxCount();
    if (state.problems > 0) await pollReviews().catch(() => {});
    void cleanupDrafts().catch(() => {});
    if (pending > 0) {
      await drain();
    } else if (state.mode !== 'online') {
      // Yeni online: cache tazele, sorgulari yenile.
      await pullSnapshot();
      qc?.invalidateQueries();
      set({ mode: 'online', note: '' });
    } else if (getAccess() && Date.now() - lastSnapshot > 60_000) {
      // Online + bekleyen yok: katalog snapshot'ini periyodik tazele -> offline reboot sicak.
      await pullSnapshot();
    }
  };
  // Onceki tik bitmeden yenisi baslamaz: yavas istekler ust uste binip birikmez.
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runTick();
    } catch {
      // IndexedDB vb. hatasi: bir sonraki tik yeniden dener.
    } finally {
      ticking = false;
    }
  };

  void tick();
  const iv = window.setInterval(() => void tick(), TICK_MS);
  const onOnline = () => void tick();
  const onOffline = () => set({ mode: 'offline', note: '' }); // navigator.onLine=false kesindir
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.clearInterval(iv);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
