// HTTP sinirlari (kendi portu 3091): govde ayristirici hatalari kendi koduyla doner (GUV-3), tablet
// kuyrugunun toplu gonderimi icin acik govde siniri (GUV-2), veritabanisiz canlilik ucu (PLT-12).
import { checklist, prepareBackend } from './spawn-backend.mjs';

const t = checklist('HTTP govde sinirlari ve canlilik (spawned)');
const backend = prepareBackend({ name: 'http', port: 3091 });
const child = await backend.start();

async function post(path, raw, headers = {}) {
  const res = await fetch(backend.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.error?.code, message: json.error?.message };
}

try {
  // Kimliksiz giris ucuna buyuk govde: 500 degil 413 (eskiden yigin dokumuyle loglaniyordu).
  const big = await post(
    '/auth/login',
    JSON.stringify({ username: 'owner', password: 'x'.repeat(150_000) }),
  );
  t.check(
    big.status === 413 && big.code === 'PAYLOAD_TOO_LARGE',
    `150 KB giris -> ${big.status} ${big.code}`,
  );

  const broken = await post('/auth/login', '{"username":');
  t.check(
    broken.status === 400 && broken.code === 'BAD_JSON',
    `bozuk JSON -> ${broken.status} ${broken.code}`,
  );
  t.check(broken.message === 'İstek gövdesi geçerli JSON değil.', 'anlasilir Turkce mesaj');

  // /sync/mutations: 1 MB'a kadar govde ayristirilir (dogrulamaya ulasir), ustu 413.
  const token = await backend.login();
  const auth = { Authorization: `Bearer ${token}` };
  const mid = await post(
    '/sync/mutations',
    JSON.stringify({ deviceId: 'd1', mutations: [], pad: 'x'.repeat(600_000) }),
    auth,
  );
  t.check(
    mid.status === 422,
    `600 KB kuyruk gonderimi siniri asmaz, dogrulamaya ulasir (${mid.status})`,
  );
  const huge = await post(
    '/sync/mutations',
    JSON.stringify({ deviceId: 'd1', mutations: [], pad: 'x'.repeat(1_200_000) }),
    auth,
  );
  t.check(
    huge.status === 413 && huge.code === 'PAYLOAD_TOO_LARGE',
    `1,2 MB -> ${huge.status} ${huge.code}`,
  );
  // Genel sinir diger uclarda gecerli: 600 KB baska uca 413.
  const other = await post('/orders', JSON.stringify({ pad: 'x'.repeat(600_000) }), auth);
  t.check(other.status === 413, `genel uc 100 KB siniri (${other.status})`);
  // Normal istekler etkilenmez.
  const ok = await post(
    '/auth/login',
    JSON.stringify({ username: 'owner', password: 'owner1234' }),
  );
  t.check(ok.status === 200 || ok.status === 201, `normal giris (${ok.status})`);

  // Canlilik ucu: kimliksiz, veritabanina dokunmaz.
  const live = await fetch(`${backend.base}/health/live`);
  const liveBody = await live.json();
  t.check(live.status === 200 && liveBody.data?.status === 'ok', `canlilik ucu (${live.status})`);
  t.check(live.headers.get('cache-control') === 'no-store', 'canlilik yaniti onbelleklenmez');
} finally {
  await backend.stop(child);
}
t.done();
