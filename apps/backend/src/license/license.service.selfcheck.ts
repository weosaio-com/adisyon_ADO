// LicenseService self-check (bellekte sahte Prisma ile): durum/politika alanlari, yeni adisyon
// kilidi, saat isareti, buluttan gelen license.remote (yenileme + askiya alma) ve denetim kaydi.
// Calistir: `ts-node --transpile-only src/license/license.service.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { createDomainEvent, DomainEventName, type LicenseRemoteEventPayload } from '@ado/shared';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { SettingKeys } from '../settings/setting-keys';
import { addDays, DAY_MS } from './license.policy';
import { LICENSE_LOCKED, LicenseService } from './license.service';

Logger.overrideLogger(false); // servis loglari test ciktisini kirletmesin
const BRANCH = 'br_selfcheck';
const HOUR = 3_600_000;
const dataDir = mkdtempSync(join(tmpdir(), 'ado-license-svc-'));
process.env.ADO_DATA_DIR = dataDir;

const vendor = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
process.env.ADO_LICENSE_PUBLIC_KEY = vendor.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function makeKey(payload: Record<string, unknown>, key: KeyObject = vendor.privateKey): string {
  const raw = Buffer.from(JSON.stringify(payload));
  return `ADO1.${raw.toString('base64url')}.${sign(null, raw, key).toString('base64url')}`;
}
const LIC_ID = 'lic_selfcheck01';
const licenseKey = (exp: Date, extra: Record<string, unknown> = {}) =>
  makeKey({ id: LIC_ID, c: 'Self Lokanta', exp: ymd(exp), f: { 'qr.menu': true }, ...extra });

// --- Sahte kalicilik: yalniz servisin kullandigi Prisma cagrilari ---
interface SettingRow {
  id: string;
  branchId: string;
  key: string;
  value: string;
  deletedAt: Date | null;
}
class FakePrisma {
  rows = new Map<string, SettingRow>();
  license: Record<string, unknown> | null = null;

  setting(key: string): unknown {
    const row = this.rows.get(`${BRANCH}|${key}`);
    return row ? JSON.parse(row.value) : undefined;
  }
  putSetting(key: string, value: unknown) {
    this.rows.set(`${BRANCH}|${key}`, {
      id: key,
      branchId: BRANCH,
      key,
      value: JSON.stringify(value),
      deletedAt: null,
    });
  }

  applicationSetting = {
    findMany: async ({ where }: { where: { branchId: string; key?: { in: string[] } } }) =>
      [...this.rows.values()]
        .filter((r) => r.branchId === where.branchId && !r.deletedAt)
        .filter((r) => !where.key || where.key.in.includes(r.key))
        .map((r) => ({ key: r.key, value: r.value })),
    upsert: async (args: {
      where: { branchId_key: { branchId: string; key: string } };
      update: { value: string };
      create: SettingRow;
    }) => {
      const id = `${args.where.branchId_key.branchId}|${args.where.branchId_key.key}`;
      const existing = this.rows.get(id);
      if (existing) {
        existing.value = args.update.value;
        existing.deletedAt = null;
        return existing;
      }
      const row = { ...args.create, deletedAt: null };
      this.rows.set(id, row);
      return row;
    },
  };
  licenseInfo = {
    findFirst: async () => this.license,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      this.license = { ...this.license, ...data };
      return this.license;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.license = { ...data, deletedAt: null };
      return this.license;
    },
  };
  branch = { findMany: async () => [{ id: BRANCH }] };
}

function setup(config: Partial<Record<string, unknown>> = {}) {
  const prisma = new FakePrisma();
  const audits: Array<Record<string, unknown>> = [];
  const published: Array<{ name: string; payload: unknown }> = [];
  let reloads = 0;
  const service = new LicenseService(
    prisma as never,
    { reloadFlags: async () => void reloads++ } as never,
    {
      publish: async (event: { name: string; payload: unknown }) => void published.push(event),
    } as never,
    { record: async (entry: Record<string, unknown>) => (audits.push(entry), 'hash') } as never,
    {
      licenseEnforce: true,
      trialDays: 0,
      graceDays: 7,
      supportContact: '0850 000 00 00',
      ...config,
    } as never,
  );
  return { prisma, service, audits, published, reloads: () => reloads };
}

const user: AuthUser = {
  userId: 'usr_owner',
  sessionId: 'ses_1',
  username: 'owner',
  role: 'owner',
  branchId: BRANCH,
  permissions: [],
};

async function lockError(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ForbiddenException, 'ForbiddenException beklenir');
    assert.equal(err.getStatus(), 403);
    return err.getResponse() as { code: string; message: string };
  }
  assert.fail('kilit beklenirdi');
}

function remoteEvent(payload: Partial<LicenseRemoteEventPayload>) {
  const now = new Date().toISOString();
  return createDomainEvent(
    DomainEventName.LicenseRemote,
    { licenseId: LIC_ID, state: 'active', serverTime: now, receivedAt: now, ...payload },
    { branchId: BRANCH },
  );
}

async function main() {
  // Dinleyici dogru olaya bagli (license.remote).
  const listeners = Reflect.getMetadata(
    'EVENT_LISTENER_METADATA',
    LicenseService.prototype.onLicenseRemote,
  ) as Array<{ event: string }>;
  assert.deepEqual(
    listeners.map((l) => l.event),
    ['license.remote'],
  );

  // --- Ilk acilis: kurulum dosyasi + deneme baslangici + saat isareti ---
  {
    const { prisma, service } = setup();
    await service.onApplicationBootstrap();
    assert.ok(prisma.setting(SettingKeys.licenseTrialStartedAt), 'deneme baslangici yazildi');
    assert.ok(prisma.setting(SettingKeys.licenseClock), 'saat isareti yazildi');
  }

  // --- Lisans yok, deneme 0: satis yok, kurulum/ayar ise serbest ---
  {
    const { service } = setup();
    const status = await service.getStatus(BRANCH);
    assert.equal(status.phase, 'unlicensed');
    assert.equal(status.locked, true);
    assert.equal(status.enforced, true);
    assert.equal(status.state, 'none');
    assert.equal(status.reason, 'no_license');
    assert.equal(status.supportContact, '0850 000 00 00');
    assert.equal(status.banner?.level, 'danger');
    assert.ok(status.trialEndsAt, 'deneme sonu bildirilir');
    const err = await lockError(service.assertCanOpenOrder(BRANCH));
    assert.equal(err.code, LICENSE_LOCKED);
    assert.match(err.message, /Lisans tanımlı değil/);
    assert.match(err.message, /Destek: 0850 000 00 00/);
  }

  // --- Zorunluluk: ortam > ayar; acik anahtar yoksa hep kapali ---
  {
    const fromSetting = setup({ licenseEnforce: null });
    assert.equal((await fromSetting.service.getStatus(BRANCH)).locked, false, 'ayar yok: kapali');
    fromSetting.prisma.putSetting(SettingKeys.licenseEnforce, true);
    assert.equal((await fromSetting.service.getStatus(BRANCH)).locked, true, 'ayar acik');
    const envOff = setup({ licenseEnforce: false });
    envOff.prisma.putSetting(SettingKeys.licenseEnforce, true);
    const off = await envOff.service.getStatus(BRANCH);
    assert.equal(off.enforced, false, 'profil/ortam kapali: ayar ezilir');
    assert.equal(off.banner, null, 'kapaliyken lisanssizlik icin serit yok');
    await envOff.service.assertCanOpenOrder(BRANCH);

    const savedKey = process.env.ADO_LICENSE_PUBLIC_KEY;
    process.env.ADO_LICENSE_PUBLIC_KEY = '';
    const noKey = setup();
    assert.equal((await noKey.service.getStatus(BRANCH)).enforced, false, 'acik anahtar yok');
    await noKey.service.assertCanOpenOrder(BRANCH);
    process.env.ADO_LICENSE_PUBLIC_KEY = savedKey;

    const trial = setup({ trialDays: 30 });
    const trialStatus = await trial.service.getStatus(BRANCH);
    assert.equal(trialStatus.phase, 'trial');
    assert.equal(trialStatus.locked, false);
    await trial.service.assertCanOpenOrder(BRANCH);
  }

  // --- Elle etkinlestirme: kilit hemen kalkar; denetim + olay; anahtar disari sizmaz ---
  {
    const { service, audits, published, reloads } = setup();
    const key = licenseKey(addDays(new Date(), 365));
    const status = await service.activate(user, key);
    assert.equal(status.phase, 'active');
    assert.equal(status.locked, false);
    assert.equal(status.licenseId, LIC_ID);
    assert.equal(status.features['qr.menu'], true);
    assert.equal(status.graceDays, 7, 'lisansta g yok: profil');
    await service.assertCanOpenOrder(BRANCH);
    assert.equal(reloads(), 1, 'bayraklar tazelendi');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'license.activate');
    assert.equal(audits[0]?.userId, 'usr_owner');
    assert.deepEqual(
      published.map((e) => e.name),
      ['license.activated'],
    );
    assert.ok(!JSON.stringify({ audits, published }).includes(key), 'anahtar loga/olaya girmez');

    // Suresi (ek sure dahil) gecmis ve yabanci imzali anahtar reddedilir.
    await assert.rejects(service.activate(user, licenseKey(addDays(new Date(), -30))), /dolmuş/);
    await assert.rejects(
      service.activate(user, makeKey({ c: 'Sahte', exp: '2099-01-01' }, stranger.privateKey)),
      /geçersiz/,
    );

    // Bulut baglantisi icin eski bicim korunur.
    const active = await service.getActiveLicense();
    assert.equal(active?.state, 'active');
    assert.equal(active?.payload.id, LIC_ID);
  }

  // --- Ek sure: bitis gecti ama kilit yok; ek sure bitince yeni adisyon durur ---
  {
    const { prisma, service } = setup();
    prisma.license = { id: 'li_1', licenseKey: licenseKey(addDays(new Date(), -3)) };
    const grace = await service.getStatus(BRANCH);
    assert.equal(grace.phase, 'grace');
    assert.equal(grace.state, 'grace', 'eski alan da etkin ek sureyle');
    assert.equal(grace.locked, false);
    assert.ok(grace.daysLeft !== null && grace.daysLeft < 0, 'daysLeft bitise gore (eksi)');
    await service.assertCanOpenOrder(BRANCH);
    // Bulut icin eski hesap (yalniz lisanstaki g) degismedi.
    assert.equal((await service.getActiveLicense())?.state, 'expired');

    prisma.license = { id: 'li_1', licenseKey: licenseKey(addDays(new Date(), -9)) };
    const locked = await service.getStatus(BRANCH);
    assert.equal(locked.phase, 'locked');
    assert.equal(locked.state, 'expired');
    const err = await lockError(service.assertCanOpenOrder(BRANCH));
    assert.match(err.message, /süresi doldu/);
  }

  // --- Cevrimdisi islem: kilitten once tablette acildiysa gecer (ULID zamani) ---
  {
    const { prisma, service } = setup();
    // Yarin biten, ek suresiz lisans; etkin saat kilitten 1 saat sonrasina isaretle tasinir.
    const tomorrow = addDays(new Date(), 1);
    prisma.license = { id: 'li_1', licenseKey: licenseKey(tomorrow, { g: 0 }) };
    const lockAt = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
    prisma.putSetting(SettingKeys.licenseClock, new Date(lockAt.getTime() + HOUR).toISOString());
    const status = await service.getStatus(BRANCH);
    assert.equal(status.locked, true);
    assert.equal(status.lockAt, lockAt.toISOString());
    await service.assertCanOpenOrder(BRANCH, { clientOpId: ulid(lockAt.getTime() - 60_000) });
    await lockError(service.assertCanOpenOrder(BRANCH, { clientOpId: ulid(lockAt.getTime() + 1) }));
    await lockError(service.assertCanOpenOrder(BRANCH, { clientOpId: 'op-ulid-degil' }));
    await lockError(service.assertCanOpenOrder(BRANCH));
  }

  // --- Saat geri alma: isaret ilerideyse sistem saati kilidi acmaz; bulut saati duzeltir ---
  {
    const { prisma, service } = setup();
    prisma.license = { id: 'li_1', licenseKey: licenseKey(addDays(new Date(), 365)) };
    assert.equal((await service.getStatus(BRANCH)).locked, false);
    const future = addDays(new Date(), 400);
    prisma.putSetting(SettingKeys.licenseClock, future.toISOString());
    const rolled = await service.getStatus(BRANCH);
    assert.equal(rolled.locked, true, 'isaret ilerde: kilit');
    assert.equal(rolled.phase, 'locked');
    await lockError(service.assertCanOpenOrder(BRANCH));
    // Gercek saat buluttan gelir: yerel isaret 1 gunden fazla ilerideyse indirilir.
    await service.onLicenseRemote(remoteEvent({ serverTime: new Date().toISOString() }));
    const fixed = await service.getStatus(BRANCH);
    assert.equal(fixed.locked, false, 'bulut saatiyle duzeldi');
    assert.ok(
      Date.parse(String(prisma.setting(SettingKeys.licenseClock))) < future.getTime(),
      'isaret indirildi',
    );
    // Bulut saati ileride: isaret ilerler (kilit tarihi gecmisse kilitlenir).
    await service.onLicenseRemote(
      remoteEvent({ serverTime: addDays(new Date(), 500).toISOString() }),
    );
    assert.equal((await service.getStatus(BRANCH)).locked, true, 'bulut saati isareti ilerletir');
  }

  // --- Bulut: askiya alma ilk bildirimden ek sure; yenileme + active kisiti kaldirir ---
  {
    const { prisma, service, audits, published } = setup();
    const oldKey = licenseKey(addDays(new Date(), 30));
    prisma.license = { id: 'li_1', licenseKey: oldKey };

    await service.onLicenseRemote(remoteEvent({ state: 'suspended' }));
    const stored = prisma.setting(SettingKeys.licenseRemote) as { since: string; state: string };
    assert.equal(stored.state, 'suspended');
    assert.ok(stored.since, 'ilk bildirim ani saklandi');
    const suspended = await service.getStatus(BRANCH);
    assert.equal(suspended.phase, 'grace');
    assert.equal(suspended.reason, 'suspended');
    assert.equal(suspended.remoteState, 'suspended');
    assert.equal(suspended.locked, false, 'ek sure icinde satis devam eder');
    const lockAt = Date.parse(suspended.lockAt ?? '');
    assert.ok(Math.abs(lockAt - addDays(new Date(stored.since), 7).getTime()) < 1000);

    // Saatlik tekrar ek sureyi uzatmaz.
    await new Promise((r) => setTimeout(r, 5));
    await service.onLicenseRemote(remoteEvent({ state: 'suspended' }));
    assert.equal(
      (prisma.setting(SettingKeys.licenseRemote) as { since: string }).since,
      stored.since,
    );

    // Ek sure bitmis askiya alma: kilit (neden: askiya alindi).
    prisma.putSetting(SettingKeys.licenseRemote, {
      ...stored,
      since: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });
    const err = await lockError(service.assertCanOpenOrder(BRANCH));
    assert.match(err.message, /askıya alındı/);

    // Gecersiz yenilemeler kurulmaz: yabanci imza, baska kimlik, daha erken bitis.
    const foreign = makeKey(
      { id: LIC_ID, c: 'Self Lokanta', exp: ymd(addDays(new Date(), 400)) },
      stranger.privateKey,
    );
    const otherId = makeKey({
      id: 'lic_baska_0001',
      c: 'Baska',
      exp: ymd(addDays(new Date(), 400)),
    });
    const earlier = licenseKey(addDays(new Date(), 10));
    for (const update of [foreign, otherId, earlier, 'ADO1.bozuk.anahtar']) {
      await service.onLicenseRemote(remoteEvent({ state: 'suspended', update }));
    }
    assert.equal(prisma.license?.licenseKey, oldKey, 'gecersiz yenileme kurulmadi');
    assert.equal(audits.length, 0);

    // Gecerli yenileme (ayni kimlik, daha gec bitis) + bulut active: kurulur, kilit kalkar.
    const renewal = licenseKey(addDays(new Date(), 395));
    await service.onLicenseRemote(remoteEvent({ state: 'active', update: renewal }));
    assert.equal(prisma.license?.licenseKey, renewal, 'yenileme kuruldu');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'license.renewed_remote');
    assert.equal(audits[0]?.userId, undefined, 'sistem islemi: kullanici yok');
    assert.equal(
      (audits[0]?.oldValue as { exp: string }).exp,
      ymd(addDays(new Date(), 30)),
      'onceki bitis denetimde',
    );
    assert.deepEqual(
      published.map((e) => e.name),
      ['license.activated'],
    );
    assert.ok(!JSON.stringify({ audits, published }).includes(renewal), 'anahtar sizmaz');
    const renewed = await service.getStatus(BRANCH);
    assert.equal(renewed.phase, 'active');
    assert.equal(renewed.locked, false);
    assert.equal(renewed.remoteState, 'active');
    assert.equal(
      renewed.validUntil,
      addDays(new Date(new Date().setHours(0, 0, 0, 0)), 395).toISOString(),
    );
    await service.assertCanOpenOrder(BRANCH);

    // Ayni yenileme tekrar gelirse yeniden kurulmaz (daha gec degil).
    await service.onLicenseRemote(remoteEvent({ state: 'active', update: renewal }));
    assert.equal(audits.length, 1);

    // Iptal: kilit nedeni "iptal edildi".
    await service.onLicenseRemote(remoteEvent({ state: 'revoked' }));
    prisma.putSetting(SettingKeys.licenseRemote, {
      ...(prisma.setting(SettingKeys.licenseRemote) as object),
      since: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    assert.match((await lockError(service.assertCanOpenOrder(BRANCH))).message, /iptal edildi/);

    // Bozuk bildirim yok sayilir (hata firlatmaz, durum degismez).
    await service.onLicenseRemote(remoteEvent({ state: 'bilinmiyor' as never }));
    assert.equal((prisma.setting(SettingKeys.licenseRemote) as { state: string }).state, 'revoked');
  }
}

main()
  .then(() => console.log('✓ license.service self-check OK'))
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
