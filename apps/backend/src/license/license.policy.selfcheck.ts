// Lisans politikasinin self-check'i: `ts-node --transpile-only src/license/license.policy.selfcheck.ts`
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import {
  acceptsRemoteUpdate,
  addDays,
  canOpenOrder,
  clientOpTime,
  clockFromServer,
  CLOCK_SERVER_CORRECTION_MS,
  CLOCK_WRITE_INTERVAL_MS,
  DAY_MS,
  daysUntil,
  earliestDate,
  effectiveNowMs,
  evaluateLicensePolicy,
  mergeRemoteState,
  OFFLINE_OP_MAX_AGE_MS,
  shouldPersistClock,
  type PolicyInput,
} from './license.policy';

const HOUR = 3_600_000;
const NOW = new Date(2027, 5, 15, 12, 0, 0); // yerel saat (licenseDates gibi)
const base = (patch: Partial<PolicyInput> = {}): PolicyInput => ({
  now: NOW,
  enforced: true,
  license: null,
  trialStartedAt: addDays(NOW, -1),
  trialDays: 0,
  graceDays: 7,
  remote: null,
  ...patch,
});
const lic = (validUntil: Date, graceDays?: number, id: string | null = 'lic_policy_0001') => ({
  id,
  validUntil,
  ...(graceDays === undefined ? {} : { graceDays }),
});

// --- Lisans yok: deneme 0 gun -> satis yok (zorunluluk aciksa) ---
{
  const r = evaluateLicensePolicy(base());
  assert.equal(r.phase, 'unlicensed');
  assert.equal(r.locked, true, 'deneme 0 gun: lisanssiz satis yok');
  assert.equal(r.reason, 'no_license');
  assert.equal(r.daysLeft, 0);
  assert.equal(r.lockAt?.getTime(), addDays(NOW, -1).getTime(), 'kilit = deneme sonu');
  assert.equal(r.banner?.level, 'danger');
  assert.equal(r.graceUntil, null);

  const off = evaluateLicensePolicy(base({ enforced: false }));
  assert.equal(off.phase, 'unlicensed');
  assert.equal(off.locked, false, 'zorunluluk kapali: asla kilit yok');
  assert.equal(off.banner, null, 'zorunluluk kapali ve lisans yok: serit yok');
}

// --- Deneme suresi: icinde "trial", bitince "unlicensed" ---
{
  const start = addDays(NOW, -10);
  const r = evaluateLicensePolicy(base({ trialStartedAt: start, trialDays: 30 }));
  assert.equal(r.phase, 'trial');
  assert.equal(r.locked, false);
  assert.equal(r.daysLeft, 20);
  assert.equal(r.trialEndsAt?.getTime(), addDays(start, 30).getTime());
  assert.equal(r.lockAt?.getTime(), addDays(start, 30).getTime());
  assert.equal(r.banner?.level, 'info');
  assert.equal(r.reason, null);

  const over = evaluateLicensePolicy(base({ trialStartedAt: addDays(NOW, -31), trialDays: 30 }));
  assert.equal(over.phase, 'unlicensed');
  assert.equal(over.locked, true);
}

// --- Deneme baslangici: kurulum dosyasi ve ayardaki anlarin EN ERKENI ---
{
  const file = new Date(2027, 0, 1);
  const setting = new Date(2027, 2, 1);
  assert.equal(earliestDate(file, setting)?.getTime(), file.getTime());
  assert.equal(earliestDate(setting, file)?.getTime(), file.getTime());
  assert.equal(earliestDate(null, setting)?.getTime(), setting.getTime(), 'dosya yoksa ayar');
  assert.equal(earliestDate(file, undefined)?.getTime(), file.getTime(), 'ayar yoksa dosya');
  assert.equal(earliestDate(new Date('bozuk'), setting)?.getTime(), setting.getTime());
  assert.equal(earliestDate(null, undefined), null);
}

// --- Lisans gecerli; 14 gun penceresi ---
{
  const active = evaluateLicensePolicy(base({ license: lic(addDays(NOW, 30)) }));
  assert.equal(active.phase, 'active');
  assert.equal(active.locked, false);
  assert.equal(active.banner, null, 'gecerli lisans: serit yok');
  assert.equal(active.daysLeft, 30);
  assert.equal(active.reason, null);
  assert.equal(active.trialEndsAt, null);
  assert.equal(active.graceUntil?.getTime(), addDays(NOW, 37).getTime(), 'g yok: profil 7 gun');
  assert.equal(active.lockAt?.getTime(), addDays(NOW, 37).getTime());

  const expiry = new Date(NOW.getTime() + 14 * DAY_MS);
  const at14 = evaluateLicensePolicy(base({ license: lic(expiry) }));
  assert.equal(at14.phase, 'expiring', 'tam 14 gun kala uyari baslar');
  assert.equal(at14.daysLeft, 14);
  assert.equal(at14.banner?.level, 'warning');
  assert.equal(at14.banner?.until?.getTime(), expiry.getTime(), 'serit bitis tarihini soyler');
  const before = evaluateLicensePolicy(base({ license: lic(new Date(expiry.getTime() + 1)) }));
  assert.equal(before.phase, 'active', '14 gunden biraz fazla: henuz uyari yok');
  const lastDay = evaluateLicensePolicy(base({ license: lic(new Date(NOW.getTime() + HOUR)) }));
  assert.equal(lastDay.phase, 'expiring');
  assert.equal(lastDay.daysLeft, 1, 'bugun bitiyor: 1 gun');
}

// --- Bitis sonrasi ek sure, sonra kilit ---
{
  const expired = addDays(NOW, -2);
  const grace = evaluateLicensePolicy(base({ license: lic(expired) }));
  assert.equal(grace.phase, 'grace');
  assert.equal(grace.reason, 'expired');
  assert.equal(grace.locked, false, 'ek surede satis devam eder');
  assert.equal(grace.lockAt?.getTime(), addDays(expired, 7).getTime(), 'profil: 7 gun ek sure');
  assert.equal(grace.daysLeft, 5);
  assert.equal(grace.banner?.level, 'danger');
  assert.equal(grace.banner?.until?.getTime(), addDays(expired, 7).getTime(), 'kilit tarihi');

  // Lisanstaki g profili ezer (0 dahil).
  const withG = evaluateLicensePolicy(base({ license: lic(expired, 3) }));
  assert.equal(withG.lockAt?.getTime(), addDays(expired, 3).getTime());
  assert.equal(withG.phase, 'grace');
  const noGrace = evaluateLicensePolicy(base({ license: lic(addDays(NOW, -1), 0) }));
  assert.equal(noGrace.phase, 'locked', 'g=0: bitiste kilit');

  const locked = evaluateLicensePolicy(base({ license: lic(addDays(NOW, -8)) }));
  assert.equal(locked.phase, 'locked');
  assert.equal(locked.locked, true);
  assert.equal(locked.reason, 'expired');
  assert.equal(locked.daysLeft, 0);
  assert.equal(locked.banner?.level, 'danger');

  // Zorunluluk kapali: evre bilgi icin hesaplanir ama hicbir sey durmaz.
  const off = evaluateLicensePolicy(base({ enforced: false, license: lic(addDays(NOW, -8)) }));
  assert.equal(off.phase, 'locked');
  assert.equal(off.locked, false);
  assert.equal(off.banner?.level, 'info');
  const offExpiring = evaluateLicensePolicy(
    base({ enforced: false, license: lic(addDays(NOW, 3)) }),
  );
  assert.equal(offExpiring.banner?.level, 'info');
}

// --- Etkin saat: saat geri alinsa da lisans acilmaz ---
{
  const expiredAt = addDays(NOW, -8);
  const rolledBack = addDays(NOW, -30); // kullanici saati bir ay geri aldi
  const hwm = NOW.getTime(); // daha once gorulen en gec an
  const now = new Date(effectiveNowMs(rolledBack.getTime(), hwm, null, 0));
  assert.equal(now.getTime(), hwm, 'etkin saat = isaret');
  const r = evaluateLicensePolicy(base({ now, license: lic(expiredAt) }));
  assert.equal(r.locked, true, 'geri alinmis saat kilidi acmaz');
  const naive = evaluateLicensePolicy(base({ now: rolledBack, license: lic(expiredAt) }));
  assert.equal(naive.locked, false, '(kontrol: saf sistem saatiyle acik gorunurdu)');

  // Surec icinde monoton saat: saat geri alinsa da sure akmaya devam eder.
  const memo = { at: hwm, mono: 1_000 };
  assert.equal(effectiveNowMs(rolledBack.getTime(), null, memo, 1_000 + HOUR), hwm + HOUR);
  assert.equal(effectiveNowMs(hwm + 5 * HOUR, hwm, memo, 1_000 + HOUR), hwm + 5 * HOUR);
  assert.equal(effectiveNowMs(hwm, null, null, 0), hwm, 'isaret/bellek yoksa sistem saati');
  assert.equal(
    effectiveNowMs(hwm, hwm - DAY_MS, null, 0),
    hwm,
    'eski isaret sistem saatini dusurmez',
  );

  // Isaret seyrek yazilir.
  assert.equal(shouldPersistClock(null, hwm), true, 'ilk deger yazilir');
  assert.equal(shouldPersistClock(hwm, hwm + CLOCK_WRITE_INTERVAL_MS - 1), false);
  assert.equal(shouldPersistClock(hwm, hwm + CLOCK_WRITE_INTERVAL_MS), true);
  assert.equal(shouldPersistClock(hwm + DAY_MS, hwm), false, 'isaret ilerideyse yazilmaz');

  // Bulut saati: ileri gidiyorsa alinir; yerel isaret 1 gunden fazla ilerideyse indirilir.
  assert.equal(clockFromServer(null, hwm), hwm);
  assert.equal(clockFromServer(hwm, hwm + HOUR), hwm + HOUR);
  assert.equal(clockFromServer(hwm, hwm - HOUR), null, 'kucuk fark: dokunulmaz');
  assert.equal(
    clockFromServer(hwm + CLOCK_SERVER_CORRECTION_MS + HOUR, hwm),
    hwm,
    'ileri kaymis yerel saat bulutla duzelir',
  );
}

// --- Bulut: askiya alma / iptal = ilk bildirimden itibaren ek sure, sonra kilit ---
{
  const valid = lic(addDays(NOW, 200));
  const suspended = evaluateLicensePolicy(
    base({
      license: valid,
      remote: { licenseId: 'lic_policy_0001', state: 'suspended', since: addDays(NOW, -2) },
    }),
  );
  assert.equal(suspended.phase, 'grace');
  assert.equal(suspended.reason, 'suspended');
  assert.equal(suspended.locked, false);
  assert.equal(suspended.lockAt?.getTime(), addDays(NOW, 5).getTime(), 'bildirim + 7 gun');
  assert.equal(suspended.daysLeft, 5);
  assert.equal(suspended.remoteState, 'suspended');
  assert.equal(suspended.banner?.level, 'danger');

  const revoked = evaluateLicensePolicy(
    base({
      license: valid,
      remote: { licenseId: 'lic_policy_0001', state: 'revoked', since: addDays(NOW, -8) },
    }),
  );
  assert.equal(revoked.phase, 'locked');
  assert.equal(revoked.reason, 'revoked');
  assert.equal(revoked.locked, true);

  // Lisans da bitmisse neden yine bulut kisitidir (yalniz yenilemek yetmez).
  const both = evaluateLicensePolicy(
    base({
      license: lic(addDays(NOW, -20)),
      remote: { licenseId: 'lic_policy_0001', state: 'suspended', since: NOW },
    }),
  );
  assert.equal(both.phase, 'locked');
  assert.equal(both.reason, 'suspended');

  // Baska kimlik (lisans degismis) ya da kimliksiz eski lisans: bildirim uygulanmaz.
  const other = evaluateLicensePolicy(
    base({
      license: valid,
      remote: { licenseId: 'lic_baska_0001', state: 'revoked', since: addDays(NOW, -30) },
    }),
  );
  assert.equal(other.phase, 'active');
  assert.equal(other.remoteState, null);
  const legacy = evaluateLicensePolicy(
    base({
      license: lic(addDays(NOW, 200), undefined, null),
      remote: { licenseId: 'lic_policy_0001', state: 'revoked', since: addDays(NOW, -30) },
    }),
  );
  assert.equal(legacy.phase, 'active');

  // Bulutun "expired" demesi bilgi amacli: yerel bitis (etkin saatle) esastir.
  const remoteExpired = evaluateLicensePolicy(
    base({
      license: valid,
      remote: { licenseId: 'lic_policy_0001', state: 'expired', since: null },
    }),
  );
  assert.equal(remoteExpired.phase, 'active');
  assert.equal(remoteExpired.remoteState, 'expired');

  // Zorunluluk kapali: bulut kisiti da kilitlemez.
  const off = evaluateLicensePolicy(
    base({
      enforced: false,
      license: valid,
      remote: { licenseId: 'lic_policy_0001', state: 'revoked', since: addDays(NOW, -30) },
    }),
  );
  assert.equal(off.locked, false);
  assert.equal(off.banner?.level, 'info');
}

// --- Bulut bildirimlerinin birlesmesi: ek sure ILK bildirimden; "active" kisiti kaldirir ---
{
  const t0 = new Date(2027, 5, 1);
  const msg = (
    state: 'active' | 'suspended' | 'revoked' | 'expired',
    licenseId = 'lic_policy_0001',
  ) => ({
    licenseId,
    state,
    receivedAt: t0.toISOString(),
    serverTime: t0.toISOString(),
  });
  const first = mergeRemoteState(null, msg('suspended'), t0);
  assert.equal(first.since, t0.toISOString());
  const hourLater = mergeRemoteState(first, msg('suspended'), new Date(t0.getTime() + HOUR));
  assert.equal(hourLater.since, t0.toISOString(), 'heartbeat tekrari ek sureyi uzatmaz');
  const revoked = mergeRemoteState(hourLater, msg('revoked'), addDays(t0, 2));
  assert.equal(revoked.since, t0.toISOString(), 'askidan iptale gecis yeni ek sure vermez');
  const cleared = mergeRemoteState(revoked, msg('active'), addDays(t0, 3));
  assert.equal(cleared.since, null, 'bulut yeniden active: kisit kalkar');
  assert.equal(cleared.state, 'active');
  const again = mergeRemoteState(cleared, msg('suspended'), addDays(t0, 4));
  assert.equal(again.since, addDays(t0, 4).toISOString(), 'yeni askiya alma yeniden sayilir');
  const otherLicense = mergeRemoteState(again, msg('suspended', 'lic_baska_0001'), addDays(t0, 5));
  assert.equal(otherLicense.since, addDays(t0, 5).toISOString(), 'baska lisans: yeni sure');
  assert.equal(mergeRemoteState(null, msg('expired'), t0).since, null);

  // Yenilenmis lisans (ayni kimlik, daha gec bitis) + bulut active: kilit kalkar.
  const renewed = evaluateLicensePolicy(
    base({
      license: lic(addDays(NOW, 365)),
      remote: { licenseId: 'lic_policy_0001', state: cleared.state, since: null },
    }),
  );
  assert.equal(renewed.phase, 'active');
  assert.equal(renewed.locked, false);
}

// --- Buluttan gelen yenileme: ayni kimlik + daha gec etkin bitis ---
{
  const current = { id: 'lic_policy_0001', graceUntil: addDays(NOW, 7) };
  const later = { id: 'lic_policy_0001', graceUntil: addDays(NOW, 372) };
  assert.equal(acceptsRemoteUpdate(current, later, 'lic_policy_0001'), true);
  assert.equal(acceptsRemoteUpdate(current, current, 'lic_policy_0001'), false, 'ayni bitis');
  assert.equal(
    acceptsRemoteUpdate(current, { ...later, graceUntil: addDays(NOW, 1) }, 'lic_policy_0001'),
    false,
    'daha erken bitis kurulmaz',
  );
  assert.equal(
    acceptsRemoteUpdate(current, { ...later, id: 'lic_baska_0001' }, 'lic_policy_0001'),
    false,
    'baska kimlik kurulmaz',
  );
  assert.equal(acceptsRemoteUpdate(current, later, 'lic_baska_0001'), false, 'bildirim kimligi');
  assert.equal(acceptsRemoteUpdate(null, later, 'lic_policy_0001'), false, 'kurulu lisans yok');
  assert.equal(
    acceptsRemoteUpdate({ id: null, graceUntil: current.graceUntil }, later, 'lic_policy_0001'),
    false,
    'kimliksiz eski lisans buluttan yenilenmez',
  );
}

// --- Yeni adisyon: kilitliyken yalniz kilitten once olusturulmus cevrimdisi islem gecer ---
{
  const lockAt = new Date(NOW.getTime() - 2 * HOUR);
  const locked = { locked: true, lockAt };
  assert.equal(canOpenOrder({ locked: false, lockAt }, NOW), true);
  assert.equal(canOpenOrder(locked, NOW), false, 'cevrimici istek: kilit');
  assert.equal(canOpenOrder(locked, NOW, null), false);
  assert.equal(canOpenOrder(locked, NOW, new Date(lockAt.getTime() - 1)), true, 'kilitten once');
  assert.equal(canOpenOrder(locked, NOW, lockAt), false, 'kilit aninda/sonrasinda olusmus');
  assert.equal(canOpenOrder(locked, NOW, new Date(NOW.getTime() + HOUR)), false, 'ileri saat');
  assert.equal(
    canOpenOrder(
      { locked: true, lockAt: new Date(NOW.getTime() - 3 * DAY_MS) },
      NOW,
      new Date(NOW.getTime() - 3 * DAY_MS - HOUR),
    ),
    false,
    `${OFFLINE_OP_MAX_AGE_MS / HOUR} saatten eski cevrimdisi islem gecmez (sahte eski zaman)`,
  );
  assert.equal(canOpenOrder({ locked: true, lockAt: null }, NOW, addDays(NOW, -1)), false);

  // clientOpId: tabletin urettigi ULID'in zamani.
  const at = NOW.getTime() - 3 * HOUR;
  assert.equal(clientOpTime(ulid(at))?.getTime(), at);
  for (const bad of [undefined, null, '', 'op-abc123', '01HZZZZZZZZZZZZZZZZZZZZZZ!', 'kisa']) {
    assert.equal(clientOpTime(bad), null, `ULID degil: ${String(bad)}`);
  }
}

// --- Yardimcilar ---
{
  assert.equal(daysUntil(new Date(NOW.getTime() + 1), NOW), 1);
  assert.equal(daysUntil(NOW, NOW), 0);
  assert.equal(daysUntil(new Date(NOW.getTime() - DAY_MS - 1), NOW), -1);
  // Yerel takvim gunu: saat korunur.
  const d = addDays(new Date(2027, 2, 27, 9, 30), 3);
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2, 30, 9, 30]);
}

console.log('✓ license.policy self-check OK');
