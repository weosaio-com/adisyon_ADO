// api.ts'in runnable self-check'i: zarf acma, belirtec yenileme, oturumun yalniz gercekten
// bittiginde silinmesi (+ giris ekrani olayi), paylasilan yenileme ve zaman asimi.
// Calistir: node --experimental-strip-types src/lib/api.selfcheck.ts
import assert from 'node:assert/strict';

// --- Sahte tarayici: localStorage + window olaylari + fetch ---
const store = new Map<string, string>();
const target = new EventTarget();
const g = globalThis as unknown as Record<string, unknown>;
g.window = target;
g.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};
type Handler = (url: string, init: RequestInit) => Promise<Response>;
let handler: Handler = async () => new Response('{}');
g.fetch = (url: string, init: RequestInit) => handler(url, init);

const {
  api,
  ApiError,
  BUSY_MESSAGE,
  LONG_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  TIMEOUT_MESSAGE,
  getAccess,
  isConnectivityError,
  login,
  requestTimeout,
  unwrapEnvelope,
} = await import('./api.ts');

// Regresyon: data=null iken zarfin kendisi donerse (eski `?? ` davranisi)
// "acik kasa oturumu yok" ekranlari beyaz ekrana duser.
assert.equal(unwrapEnvelope({ success: true, data: null }), null);
assert.deepEqual(unwrapEnvelope({ success: true, data: { a: 1 } }), { a: 1 });
assert.deepEqual(unwrapEnvelope({ success: true, data: [] }), []);
// Zarfsiz yanit aynen gecer.
assert.deepEqual(unwrapEnvelope({ a: 1 }), { a: 1 });
assert.deepEqual(unwrapEnvelope({}), {});

let expiredEvents = 0;
let before = 0;
target.addEventListener(SESSION_EXPIRED_EVENT, () => expiredEvents++);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json(200, { success: true, data });
const fail = (status: number, code: string) =>
  json(status, { success: false, error: { code, message: `sunucu: ${code}` } });
const bearer = (init: RequestInit) =>
  (init.headers as Record<string, string> | undefined)?.Authorization;
const isRefresh = (url: string) => url.endsWith('/auth/refresh');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signIn(access = 'OLD', refresh = 'R1') {
  store.set('ado.access', access);
  store.set('ado.refresh', refresh);
  store.set('ado.user', JSON.stringify({ id: 'u1', username: 'owner', permissions: [] }));
}
const sessionKept = (access = 'OLD') => {
  assert.equal(store.get('ado.access'), access);
  assert.equal(store.get('ado.refresh'), 'R1');
  assert.ok(store.has('ado.user'));
};
const sessionCleared = () => {
  assert.equal(store.has('ado.access'), false);
  assert.equal(store.has('ado.refresh'), false);
  assert.equal(store.has('ado.user'), false);
};
// Eski belirtec reddedilir, yenisi ('NEW') kabul edilir; yenileme cevabi `refreshReply`.
function expiredAccess(refreshReply: () => Promise<Response>) {
  handler = async (url, init) => {
    if (isRefresh(url)) return refreshReply();
    return bearer(init) === 'Bearer NEW' ? ok({ url }) : fail(401, 'INVALID_TOKEN');
  };
}

// --- 1) Yenileme 401/403: oturum silinir, giris ekrani olayi bir kez yayilir ---
for (const status of [401, 403]) {
  signIn();
  before = expiredEvents;
  expiredAccess(async () => fail(status, 'SESSION_EXPIRED'));
  await assert.rejects(api('/orders'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'SESSION_EXPIRED');
    assert.equal(err.message, SESSION_EXPIRED_MESSAGE);
    return true;
  });
  sessionCleared();
  assert.equal(expiredEvents, before + 1, `yenileme ${status}: giris ekrani olayi`);
}

// Yenileme belirteci hic yoksa da oturum biter.
signIn();
store.delete('ado.refresh');
expiredAccess(async () => ok({ accessToken: 'NEW' }));
before = expiredEvents;
await assert.rejects(api('/orders'), { code: 'SESSION_EXPIRED' });
sessionCleared();
assert.equal(expiredEvents, before + 1);

// Ayni anda 401 alan istekler reddedilen tek yenilemeyi paylasir: olay yalniz bir kez yayilir
// (yenileme bittikten sonra 401'i gelen istek de yeniden yaymaz).
signIn();
before = expiredEvents;
let refreshCalls = 0;
handler = async (url) => {
  if (isRefresh(url)) {
    refreshCalls++;
    await sleep(20);
    return fail(401, 'SESSION_EXPIRED');
  }
  if (url.endsWith('/late')) await sleep(60);
  return fail(401, 'INVALID_TOKEN');
};
const settled = await Promise.allSettled(['/a', '/b', '/late'].map((p) => api(p)));
assert.ok(settled.every((r) => r.status === 'rejected' && r.reason.code === 'SESSION_EXPIRED'));
assert.equal(refreshCalls, 1);
assert.equal(expiredEvents, before + 1, 'tek giris ekrani olayi');
sessionCleared();

// --- 2) Yenileme 500 / 503 DB_BUSY / ag hatasi / bozuk yanit: oturum KORUNUR ---
const keepCases: Array<[string, () => Promise<Response>, number]> = [
  ['500', async () => fail(500, 'INTERNAL_ERROR'), 500],
  ['503 DB_BUSY', async () => fail(503, 'DB_BUSY'), 503],
  ['429', async () => fail(429, 'RATE_LIMITED'), 429],
  ['ag hatasi', async () => Promise.reject(new TypeError('Failed to fetch')), 0],
  ['accessToken yok', async () => ok({}), 200],
];
for (const [label, refreshReply, status] of keepCases) {
  signIn();
  before = expiredEvents;
  expiredAccess(refreshReply);
  await assert.rejects(api('/orders'), (err: unknown) => {
    assert.ok(err instanceof ApiError, label);
    assert.equal(err.status, status, label);
    assert.equal(err.message, BUSY_MESSAGE, label);
    assert.equal(err.retryable, true, label);
    return true;
  });
  sessionKept();
  assert.equal(expiredEvents, before, `yenileme ${label}: oturum silinmez`);
}

// Gecici hatadan sonra yenileme basarili olunca ayni oturumla devam edilir.
signIn();
expiredAccess(async () => ok({ accessToken: 'NEW' }));
assert.deepEqual(await api('/orders'), { url: '/api/v1/orders' });
sessionKept('NEW');

// --- 3) 503 DB_BUSY hicbir cagrida oturumu silmez, yenileme de denenmez ---
signIn('A1');
refreshCalls = 0;
handler = async (url) => {
  if (isRefresh(url)) refreshCalls++;
  return fail(503, 'DB_BUSY');
};
before = expiredEvents;
await assert.rejects(api('/orders', { method: 'POST', body: {} }), (err: unknown) => {
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'DB_BUSY');
  assert.equal(err.message, BUSY_MESSAGE);
  assert.equal(err.retryable, true);
  assert.equal(isConnectivityError(err), false, 'sunucu cevap verdi: snapshot yolu degil');
  return true;
});
sessionKept('A1');
assert.equal(refreshCalls, 0);
assert.equal(expiredEvents, before);

// Yenilemeden sonra yeni belirtec de 401 alirsa (sunucuda gecici hata) oturum yine silinmez.
signIn();
refreshCalls = 0;
handler = async (url) => {
  if (!isRefresh(url)) return fail(401, 'INVALID_TOKEN');
  refreshCalls++;
  return ok({ accessToken: 'NEW' });
};
await assert.rejects(api('/orders'), { status: 401, message: BUSY_MESSAGE, retryable: true });
sessionKept('NEW');
assert.equal(refreshCalls, 1);
assert.equal(expiredEvents, before);

// --- 4) Ayni anda 401 alan istekler TEK yenileme cagrisini paylasir ---
signIn();
refreshCalls = 0;
handler = async (url, init) => {
  if (isRefresh(url)) {
    refreshCalls++;
    await sleep(20);
    return ok({ accessToken: 'NEW' });
  }
  if (bearer(init) === 'Bearer NEW') return ok({ url });
  // /late: 401'i yenileme bittikten SONRA gelir; yine yeni yenileme yapilmaz.
  if (url.endsWith('/late')) await sleep(60);
  return fail(401, 'INVALID_TOKEN');
};
const replies = await Promise.all(['/a', '/b', '/c', '/late'].map((p) => api(p)));
assert.deepEqual(
  replies.map((r) => (r as { url: string }).url),
  ['/api/v1/a', '/api/v1/b', '/api/v1/c', '/api/v1/late'],
);
assert.equal(refreshCalls, 1, 'eszamanli 401: tek /auth/refresh');
sessionKept('NEW');

// Yenileme surerken yeniden giris yapildiysa eski yenilemenin 401'i yeni oturumu silmez.
signIn();
before = expiredEvents;
handler = async (url, init) => {
  if (isRefresh(url)) {
    signIn('FRESH', 'R2'); // kullanici bu arada yeniden giris yapti
    return fail(401, 'SESSION_EXPIRED');
  }
  return bearer(init) === 'Bearer FRESH' ? ok({ url }) : fail(401, 'INVALID_TOKEN');
};
assert.deepEqual(await api('/orders'), { url: '/api/v1/orders' });
assert.equal(getAccess(), 'FRESH');
assert.equal(store.get('ado.refresh'), 'R2');
assert.equal(expiredEvents, before);

// --- 5) Zaman asimi -> ApiError TIMEOUT (istek de govde de); oturum korunur ---
signIn('A1');
const never: Handler = (_url, init) =>
  new Promise((_resolve, reject) =>
    init.signal?.addEventListener('abort', () => reject(new DOMException('iptal', 'AbortError'))),
  );
handler = never;
const timeout = (err: unknown) => {
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 0);
  assert.equal(err.code, 'TIMEOUT');
  assert.equal(err.message, TIMEOUT_MESSAGE);
  assert.equal(err.retryable, true);
  assert.equal(isConnectivityError(err), true);
  return true;
};
await assert.rejects(api('/slow', { timeoutMs: 20 }), timeout);
// Baslik gelir, govde takilir: govde okumasi da sure icindedir.
handler = async (_url, init) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('iptal', 'AbortError')),
        );
      },
    }),
    { status: 200 },
  );
await assert.rejects(api('/slow-body', { timeoutMs: 20 }), timeout);

// Varsayilan sureler: JSON 30 sn; dosya yukleme ve acikca istenen uzun islemler cok daha uzun.
assert.equal(REQUEST_TIMEOUT_MS, 30_000);
assert.equal(requestTimeout({}), REQUEST_TIMEOUT_MS);
assert.equal(requestTimeout({ method: 'POST', body: {} }), REQUEST_TIMEOUT_MS);
assert.equal(requestTimeout({ file: new Blob(['x']) }), LONG_REQUEST_TIMEOUT_MS);
assert.equal(requestTimeout({ timeoutMs: LONG_REQUEST_TIMEOUT_MS }), LONG_REQUEST_TIMEOUT_MS);
assert.ok(LONG_REQUEST_TIMEOUT_MS >= 10 * REQUEST_TIMEOUT_MS);

// --- 6) Ag hatasi -> ApiError NETWORK_ERROR (snapshot yolu); HTTP hatasi degil ---
handler = async () => Promise.reject(new TypeError('Failed to fetch'));
await assert.rejects(api('/halls'), (err: unknown) => {
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'NETWORK_ERROR');
  assert.equal(isConnectivityError(err), true);
  return true;
});
handler = async () => fail(404, 'NOT_FOUND');
await assert.rejects(api('/halls'), (err: unknown) => {
  assert.equal(isConnectivityError(err), false);
  assert.equal((err as InstanceType<typeof ApiError>).retryable, false);
  return true;
});

// --- 7) Giris ucu belirtec gondermez: hatali sifrenin 401'i yenileme/oturum silme tetiklemez ---
signIn('A1');
refreshCalls = 0;
before = expiredEvents;
handler = async (url, init) => {
  if (isRefresh(url)) refreshCalls++;
  assert.equal(bearer(init), undefined, 'giris istegi belirtecsiz');
  return fail(401, 'INVALID_CREDENTIALS');
};
await assert.rejects(login('owner', 'yanlis'), { status: 401, code: 'INVALID_CREDENTIALS' });
assert.equal(refreshCalls, 0);
assert.equal(expiredEvents, before);
sessionKept('A1');

console.log('api self-check OK');
