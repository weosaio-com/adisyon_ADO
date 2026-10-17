// Temel spawned e2e: yardimcinin calistigini ve Faz 0 sozlesmelerini dogrular (kendi portu 3051).
// Kontroller: acilis + giris, yedek boyutu BigInt olsa da JSON'da sayi, yedek bicimi, duzgun kapanis.
import { checklist, prepareBackend } from './spawn-backend.mjs';

const t = checklist('Temel backend (spawned)');
const backend = prepareBackend({ name: 'base', port: 3051 });
const child = await backend.start();
try {
  await backend.login();

  const created = await backend.call('POST', '/backups');
  t.check(created.status === 201 || created.status === 200, `yedek alinir (${created.status})`);
  t.check(typeof created.data.sizeBytes === 'number', 'yeni yedegin boyutu sayi (BigInt degil)');

  const list = await backend.call('GET', '/backups');
  const first = Array.isArray(list.data) ? list.data[0] : null;
  t.check(list.status === 200 && first !== null, 'yedek listesi okunur');
  t.check(typeof first?.sizeBytes === 'number' && first.sizeBytes > 0, 'listede boyut sayi');
  t.check(first?.format === 2, 'yeni yedek bicimi 2 (sikistirilmis akis)');
} finally {
  await backend.stop(child);
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();
