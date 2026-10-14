import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  createDomainEvent,
  DomainEventName,
  newId,
  type DomainEvent,
  type LicenseActivatedEventPayload,
  type LicenseRemoteState,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flags.service';
import { EventBusService } from '../common/events/event-bus.service';
import { AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../config/app-config.service';
import { ensureInstallFile, installCreatedAt } from '../common/util/install-id';
import { SettingKeys } from '../settings/setting-keys';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasPublicKey, licenseDates, parseLicenseKey, type LicensePayload } from './license.keys';
import {
  acceptsRemoteUpdate,
  addDays,
  canOpenOrder,
  clientOpTime,
  clockFromServer,
  daysUntil,
  earliestDate,
  effectiveGraceDays,
  effectiveNowMs,
  evaluateLicensePolicy,
  mergeRemoteState,
  shouldPersistClock,
  type BannerLevel,
  type ClockMemo,
  type LicensePhase,
  type LicenseReason,
  type PolicyResult,
  type StoredRemoteState,
} from './license.policy';

export type LicenseState = 'none' | 'active' | 'grace' | 'expired';

/** Yeni adisyon lisans yuzunden durdugunda donen hata kodu (403). */
export const LICENSE_LOCKED = 'LICENSE_LOCKED';

export interface LicenseStatus {
  /** Lisans zorunlulugu acik mi (profil/ortam, yoksa license.enforce). KAPALI iken hicbir sey durmaz. */
  enforced: boolean;
  state: LicenseState;
  customerName: string | null;
  plan: string | null;
  validUntil: string | null;
  /** Lisansin ek suresinin sonu (exp + lisanstaki g, yoksa profildeki graceDays). */
  graceUntil: string | null;
  /** validUntil'e kalan gun (gecmisse negatif; etkin saatle). Lisans yoksa null. */
  daysLeft: number | null;
  /** Bu kurulumda anahtar dogrulanabiliyor mu (acik anahtar gomulu mu). */
  verifiable: boolean;
  /** Lisans kimligi (bulutta isletme anahtari). Eski lisanslarda null. */
  licenseId: string | null;
  /** Lisanstaki ozellik bayraklari (imzasi dogrulanmis anahtardan). */
  features: Record<string, boolean>;
  /** Kayitli bir anahtar var ama bu kurulumun acik anahtariyla dogrulanamiyor: yeniden girilmeli. */
  needsReentry: boolean;
  // --- Politika (LICENSING.md §8) ---
  phase: LicensePhase;
  /** Yeni adisyon durdu mu. Acik adisyon odenir/kapanir; diger her sey acik kalir. */
  locked: boolean;
  /** Yeni adisyonun durdugu / duracagi an. */
  lockAt: string | null;
  /** Lisanssiz kurulumda deneme sonu; lisans varken null. */
  trialEndsAt: string | null;
  /** Bu lisans icin bulutun son bildirdigi durum (ayni kimlik); yoksa null. */
  remoteState: LicenseRemoteState | null;
  reason: LicenseReason | null;
  /** Uygulanan ek sure (gun): lisanstaki g, yoksa profil. */
  graceDays: number;
  /** Uyari seridi; soylenecek bir sey yoksa null. */
  banner: { level: BannerLevel; daysLeft: number | null; until: string | null } | null;
  /** Kilit ekraninda gosterilecek destek iletisimi (profil); tanimsizsa null. */
  supportContact: string | null;
}

/** Imzasi dogrulanmis, kayitli lisans (bulut baglantisi gibi tuketiciler icin). */
export interface ActiveLicense {
  key: string;
  payload: LicensePayload;
  state: Exclude<LicenseState, 'none'>;
  validUntil: Date;
  graceUntil: Date;
}

/** Imzasi dogrulanmis anahtar ve politikadaki bitis anlari (ek sure etkin degerle). */
interface VerifiedLicense {
  key: string;
  payload: LicensePayload;
  validUntil: Date;
  graceUntil: Date;
}

interface Evaluation {
  /** Etkin saat (saat geri alinsa da geri gitmez). */
  now: Date;
  enforced: boolean;
  license: VerifiedLicense | null;
  /** Kayitli (dogrulansin ya da dogrulanmasin) bir anahtar var mi. */
  hasStoredKey: boolean;
  policy: PolicyResult;
}

type AuditAction = 'license.activate' | 'license.renewed_remote';

const POLICY_KEYS = [
  SettingKeys.licenseEnforce,
  SettingKeys.licenseTrialStartedAt,
  SettingKeys.licenseClock,
  SettingKeys.licenseRemote,
];

const remoteStates = ['active', 'suspended', 'revoked', 'expired'] as const;

/** license.remote olayinin payload'i (bulut baglantisindan; yine de dogrulanir). */
const remoteEventSchema = z.object({
  licenseId: z.string().min(1).max(64),
  state: z.enum(remoteStates),
  update: z.string().max(4096).nullish(),
  serverTime: z.string().min(1).max(64),
  receivedAt: z.string().min(1).max(64),
});

const storedRemoteSchema = z.object({
  licenseId: z.string().min(1),
  state: z.enum(remoteStates),
  since: z.string().nullable(),
  receivedAt: z.string(),
  serverTime: z.string(),
});

const LOCKED_MESSAGES: Record<LicenseReason, string> = {
  no_license:
    'Lisans tanımlı değil: yeni adisyon açılamaz. Ayarlar › Lisans bölümünden lisans anahtarınızı girin.',
  expired:
    'Lisans süresi doldu: yeni adisyon açılamaz. Açık adisyonlar ödenip kapatılabilir; lisansınızı yenileyin.',
  suspended:
    'Lisans askıya alındı: yeni adisyon açılamaz. Açık adisyonlar ödenip kapatılabilir; satıcınızla görüşün.',
  revoked:
    'Lisans iptal edildi: yeni adisyon açılamaz. Açık adisyonlar ödenip kapatılabilir; satıcınızla görüşün.',
};

function parseTime(value: unknown): number | null {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function parseDate(value: unknown): Date | null {
  const ms = parseTime(value);
  return ms === null ? null : new Date(ms);
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Yillik lisans: imzali anahtari cevrimdisi dogrular, LicenseInfo'ya yazar, durumu ve politikayi
 * (LICENSING.md §8) hesaplar.
 *
 * Kilit YALNIZ yeni adisyon acilisindadir (assertCanOpenOrder; OrdersService.openOrder cagirir).
 * Acik adisyon odenir/kapanir; rapor, yedek, ayar, katalog, kullanici, lisans girisi ve guncelleme
 * hep calisir. Zorunluluk: ADO_LICENSE_ENFORCE (paketli surumde profil), bossa `license.enforce`
 * ayari; acik anahtar yoksa hicbir zaman zorunlu degildir (kimse kilitlenmez).
 */
@Injectable()
export class LicenseService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LicenseService.name);
  /** Sube basina bu surecteki son etkin saat (monoton saatle ilerletilir; bkz. effectiveNowMs). */
  private readonly clockMemo = new Map<string, ClockMemo>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Ilk acilis: kurulum dosyasi (deneme baslangici) bulut kodunu beklemeden yazilir; her sube icin
   * deneme baslangici ve saat isareti kaydedilir. Hata acilisi durdurmaz.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      ensureInstallFile();
    } catch (err) {
      this.logger.warn(`Kurulum dosyasi yazilamadi: ${errorText(err)}`);
    }
    try {
      const branches = await this.prisma.branch.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      for (const branch of branches) await this.evaluate(branch.id);
    } catch (err) {
      this.logger.warn(`Lisans durumu acilista degerlendirilemedi: ${errorText(err)}`);
    }
  }

  // ===========================================================================
  // Ayarlar
  // ===========================================================================
  private async readSettings(branchId: string): Promise<Map<string, unknown>> {
    const rows = await this.prisma.applicationSetting.findMany({
      where: { branchId, deletedAt: null, key: { in: POLICY_KEYS } },
      select: { key: true, value: true },
    });
    const values = new Map<string, unknown>();
    for (const row of rows) {
      try {
        values.set(row.key, JSON.parse(row.value));
      } catch {
        // Bozuk deger yok sayilir (guvenli varsayilan).
      }
    }
    return values;
  }

  private async writeSetting(branchId: string, key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.prisma.applicationSetting.upsert({
      where: { branchId_key: { branchId, key } },
      update: { value: serialized, deletedAt: null, version: { increment: 1 } },
      create: { id: newId(), branchId, key, value: serialized },
    });
  }

  /** Zorunluluk: profil/ortam (ADO_LICENSE_ENFORCE) once, yoksa ayar. Acik anahtar yoksa hep kapali. */
  private enforcedFrom(setting: unknown): boolean {
    if (!hasPublicKey()) return false;
    return this.config.licenseEnforce ?? setting === true;
  }

  async isEnforced(branchId: string): Promise<boolean> {
    return this.enforcedFrom((await this.readSettings(branchId)).get(SettingKeys.licenseEnforce));
  }

  /**
   * Etkin saat: max(sistem saati, kalici isaret, surec icinde monoton ilerleyen son deger).
   * Isaret geride kaldiysa seyrek yazilir (en cok 10 dk'da bir); yazma hatasi okumayi bozmaz.
   */
  private async currentTime(branchId: string, persistedValue: unknown): Promise<number> {
    const persisted = parseTime(persistedValue);
    const mono = performance.now();
    const now = effectiveNowMs(Date.now(), persisted, this.clockMemo.get(branchId) ?? null, mono);
    this.clockMemo.set(branchId, { at: now, mono });
    if (shouldPersistClock(persisted, now)) {
      await this.writeSetting(
        branchId,
        SettingKeys.licenseClock,
        new Date(now).toISOString(),
      ).catch((err: unknown) =>
        this.logger.warn(`Lisans saat isareti yazilamadi: ${errorText(err)}`),
      );
    }
    return now;
  }

  /** Deneme baslangici: kurulum dosyasi ve ayardaki anlarin en erkeni; ayar yoksa simdi yazilir. */
  private async trialStart(branchId: string, settingValue: unknown): Promise<Date> {
    let fromSetting = parseDate(settingValue);
    if (!fromSetting) {
      fromSetting = new Date();
      await this.writeSetting(
        branchId,
        SettingKeys.licenseTrialStartedAt,
        fromSetting.toISOString(),
      ).catch((err: unknown) =>
        this.logger.warn(`Deneme baslangici yazilamadi: ${errorText(err)}`),
      );
    }
    return earliestDate(installCreatedAt(), fromSetting) ?? fromSetting;
  }

  // ===========================================================================
  // Lisans okuma
  // ===========================================================================
  private async current() {
    return this.prisma.licenseInfo.findFirst({ where: { deletedAt: null } });
  }

  /** Anahtari dogrular; bitis anlari imzali payload'dan, ek sure etkin degerle (g ?? graceDays). */
  private verify(key: string): VerifiedLicense | null {
    const payload = parseLicenseKey(key);
    if (!payload) return null;
    const { validUntil } = licenseDates(payload);
    const graceUntil = addDays(
      validUntil,
      effectiveGraceDays({ graceDays: payload.g }, this.config.graceDays),
    );
    return { key: key.trim(), payload, validUntil, graceUntil };
  }

  /**
   * Kayitli anahtari HER OKUMADA yeniden dogrular: acik anahtar degistiyse (deneme -> uretim
   * derlemesi) eski anahtar artik gecerli sayilmaz. Tarihler ve bayraklar imzali payload'dan
   * okunur, veritabanindaki kopyalardan degil. (Bulut baglantisi icin; buradaki `state` bulutun
   * hesabina uyar: sistem saati ve yalniz lisanstaki `g`. Politika getStatus'tadir.)
   */
  async getActiveLicense(): Promise<ActiveLicense | null> {
    const lic = await this.current();
    if (!lic?.licenseKey) return null;
    const payload = parseLicenseKey(lic.licenseKey);
    if (!payload) return null;
    const { validUntil, graceUntil } = licenseDates(payload);
    const now = Date.now();
    const state =
      now < validUntil.getTime() ? 'active' : now < graceUntil.getTime() ? 'grace' : 'expired';
    return { key: lic.licenseKey, payload, state, validUntil, graceUntil };
  }

  /** Politikanin tum girdilerini okur ve karari verir (deneme baslangici ve saat isaretini yazabilir). */
  private async evaluate(branchId: string): Promise<Evaluation> {
    const settings = await this.readSettings(branchId);
    const now = new Date(await this.currentTime(branchId, settings.get(SettingKeys.licenseClock)));
    const trialStartedAt = await this.trialStart(
      branchId,
      settings.get(SettingKeys.licenseTrialStartedAt),
    );
    const stored = await this.current();
    const license = stored?.licenseKey ? this.verify(stored.licenseKey) : null;
    const remote = storedRemoteSchema.safeParse(settings.get(SettingKeys.licenseRemote));
    const enforced = this.enforcedFrom(settings.get(SettingKeys.licenseEnforce));

    const policy = evaluateLicensePolicy({
      now,
      enforced,
      license: license
        ? {
            id: license.payload.id ?? null,
            validUntil: license.validUntil,
            graceDays: license.payload.g,
          }
        : null,
      trialStartedAt,
      trialDays: this.config.trialDays,
      graceDays: this.config.graceDays,
      remote: remote.success
        ? {
            licenseId: remote.data.licenseId,
            state: remote.data.state,
            since: parseDate(remote.data.since),
          }
        : null,
    });
    return { now, enforced, license, hasStoredKey: Boolean(stored?.licenseKey), policy };
  }

  /** Kayitli lisansin ve politikanin o anki durumu. Yan etkisi: deneme/saat isaretleri. */
  async getStatus(branchId: string): Promise<LicenseStatus> {
    const { now, enforced, license, hasStoredKey, policy } = await this.evaluate(branchId);
    const common = {
      enforced,
      verifiable: hasPublicKey(),
      phase: policy.phase,
      locked: policy.locked,
      lockAt: iso(policy.lockAt),
      trialEndsAt: iso(policy.trialEndsAt),
      remoteState: policy.remoteState,
      reason: policy.reason,
      banner: policy.banner
        ? {
            level: policy.banner.level,
            daysLeft: policy.banner.daysLeft,
            until: iso(policy.banner.until),
          }
        : null,
      supportContact: this.config.supportContact || null,
    };

    if (!license) {
      return {
        ...common,
        state: 'none',
        customerName: null,
        plan: null,
        validUntil: null,
        graceUntil: null,
        daysLeft: null,
        licenseId: null,
        features: {},
        needsReentry: hasStoredKey,
        graceDays: this.config.graceDays,
      };
    }

    const { payload, validUntil, graceUntil } = license;
    const at = now.getTime();
    return {
      ...common,
      state: at < validUntil.getTime() ? 'active' : at < graceUntil.getTime() ? 'grace' : 'expired',
      customerName: payload.c,
      plan: payload.p ?? null,
      validUntil: validUntil.toISOString(),
      graceUntil: graceUntil.toISOString(),
      daysLeft: daysUntil(validUntil, now),
      licenseId: payload.id ?? null,
      features: payload.f ?? {},
      needsReentry: false,
      graceDays: effectiveGraceDays({ graceDays: payload.g }, this.config.graceDays),
    };
  }

  /**
   * Yeni adisyon acilisindan once (OrdersService.openOrder): kilitliyse 403 LICENSE_LOCKED.
   * `clientOpId` cevrimdisi islemin ULID'idir: kilitten ONCE tablette olusturulduysa gecer
   * (OFFLINE_OP_MAX_AGE_MS siniriyla). Senkron OPEN_TABLE'da bu hata kayitli "rejected" sonuc olur.
   */
  async assertCanOpenOrder(
    branchId: string,
    opts: { clientOpId?: string | null | undefined } = {},
  ): Promise<void> {
    const { now, policy } = await this.evaluate(branchId);
    if (canOpenOrder(policy, now, clientOpTime(opts.clientOpId))) return;
    const contact = this.config.supportContact;
    const message = LOCKED_MESSAGES[policy.reason ?? 'expired'];
    throw new ForbiddenException({
      code: LICENSE_LOCKED,
      message: contact ? `${message} Destek: ${contact}` : message,
    });
  }

  // ===========================================================================
  // Etkinlestirme (elle ve buluttan)
  // ===========================================================================
  /**
   * Anahtari dogrular ve kaydeder. Gecersiz / ek suresi de bitmis anahtar kabul edilmez;
   * mevcut lisans bozulmaz. Yenileme kilidi hemen kaldirir (durum her istekte hesaplanir).
   */
  async activate(user: AuthUser, licenseKey: string): Promise<LicenseStatus> {
    if (!hasPublicKey()) {
      throw new BadRequestException(
        'Bu kurulumda lisans doğrulama anahtarı tanımlı değil. Satıcınıza başvurun.',
      );
    }
    const license = this.verify(licenseKey);
    if (!license) {
      throw new BadRequestException('Lisans anahtarı geçersiz veya bozuk.');
    }
    // Etkin saatle: saat geri alinarak suresi gecmis anahtar girilemez.
    const { now } = await this.evaluate(user.branchId);
    if (license.graceUntil.getTime() <= now.getTime()) {
      throw new BadRequestException('Lisans anahtarının süresi dolmuş.');
    }
    await this.install(license, {
      branchId: user.branchId,
      action: 'license.activate',
      userId: user.userId,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return this.getStatus(user.branchId);
  }

  /** LicenseInfo'ya yazar, bayraklari tazeler, denetim kaydi + license.activated. Anahtar loga/olaya girmez. */
  private async install(
    license: VerifiedLicense,
    meta: {
      branchId: string;
      action: AuditAction;
      userId?: string;
      deviceId?: string;
      previous?: LicensePayload | null;
    },
  ): Promise<void> {
    const { payload } = license;
    const existing = await this.current();
    const data = {
      licenseKey: license.key,
      customerName: payload.c,
      plan: payload.p ?? null,
      features: JSON.stringify(payload.f ?? {}),
      status: 'active',
      validUntil: license.validUntil,
      graceUntil: license.graceUntil,
      activatedAt: new Date(),
      lastVerifiedAt: new Date(),
      signatureValid: true,
      deviceId: meta.deviceId ?? null,
      syncState: 'pending',
    };
    const id = existing?.id ?? newId();
    if (existing) {
      await this.prisma.licenseInfo.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
    } else {
      await this.prisma.licenseInfo.create({ data: { id, ...data } });
    }

    // Lisanstaki feature-flag'ler onbellekte -> yeni anahtar sonrasi tazele.
    await this.flags.reloadFlags();
    this.logger.log(`Lisans etkinlestirildi (${meta.action}): ${payload.c} (${payload.exp})`);

    const summary = (p: LicensePayload) => ({
      licenseId: p.id ?? null,
      customerName: p.c,
      plan: p.p ?? null,
      exp: p.exp,
      grace: p.g ?? null,
    });
    await this.audit.record({
      branchId: meta.branchId,
      action: meta.action,
      entityType: 'license',
      entityId: id,
      ...(meta.userId ? { userId: meta.userId } : {}),
      ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
      ...(meta.previous ? { oldValue: summary(meta.previous) } : {}),
      newValue: summary(payload),
    });

    // Yan etkiler (QR menu bulutunda lisansin yenilenmesi vb.) event ile. Anahtar event'e girmez.
    await this.events.publish(
      createDomainEvent<string, LicenseActivatedEventPayload>(
        DomainEventName.LicenseActivated,
        { licenseId: payload.id ?? null, customerName: payload.c, features: payload.f ?? {} },
        {
          branchId: meta.branchId,
          ...(meta.userId ? { actorId: meta.userId } : {}),
          ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
        },
      ),
    );
  }

  /**
   * Bulutun lisans bildirimi (her heartbeat'ten sonra; kalici degil). Sirasiyla: bulut saati saat
   * isaretine islenir, varsa yenileme dogrulanip kurulur, durum kaydedilir. Hata yayinciyi bozmaz.
   */
  @OnEvent(DomainEventName.LicenseRemote)
  async onLicenseRemote(event: DomainEvent<string, unknown>): Promise<void> {
    try {
      await this.applyRemote(event.branchId, event.payload);
    } catch (err) {
      this.logger.error(`Bulut lisans bildirimi islenemedi: ${errorText(err)}`);
    }
  }

  private async applyRemote(branchId: string, raw: unknown): Promise<void> {
    const parsed = remoteEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('Gecersiz license.remote bildirimi yok sayildi.');
      return;
    }
    const remote = parsed.data;

    const serverTime = parseTime(remote.serverTime);
    if (serverTime !== null) await this.applyServerTime(branchId, serverTime);
    if (remote.update) await this.installRemoteUpdate(branchId, remote.licenseId, remote.update);

    const settings = await this.readSettings(branchId);
    const now = await this.currentTime(branchId, settings.get(SettingKeys.licenseClock));
    const previous = storedRemoteSchema.safeParse(settings.get(SettingKeys.licenseRemote));
    const prev: StoredRemoteState | null = previous.success ? previous.data : null;
    const next = mergeRemoteState(
      prev,
      {
        licenseId: remote.licenseId,
        state: remote.state,
        receivedAt: remote.receivedAt,
        serverTime: remote.serverTime,
      },
      new Date(now),
    );
    await this.writeSetting(branchId, SettingKeys.licenseRemote, next);
    if (prev?.state !== next.state || prev?.licenseId !== next.licenseId) {
      this.logger.log(`Bulut lisans durumu: ${next.state} (${next.licenseId})`);
    }
  }

  /** Bulut saati: isareti ilerletir ya da ileri kaymis yerel isareti bulut saatine indirir. */
  private async applyServerTime(branchId: string, serverTime: number): Promise<void> {
    const persisted = parseTime((await this.readSettings(branchId)).get(SettingKeys.licenseClock));
    const next = clockFromServer(persisted, serverTime);
    if (next === null) return;
    await this.writeSetting(branchId, SettingKeys.licenseClock, new Date(next).toISOString());
    // Bellekteki deger de hizalanir: indirilen isaret surec icinde geri gelmesin.
    const mono = performance.now();
    const memo = this.clockMemo.get(branchId);
    const projected = memo ? memo.at + Math.max(0, mono - memo.mono) : null;
    const corrected = persisted !== null && next < persisted;
    this.clockMemo.set(branchId, {
      at: corrected || projected === null ? next : Math.max(projected, next),
      mono,
    });
  }

  /**
   * Buluttan gelen imzali yenileme: gomulu acik anahtarlarla dogrulanir, kurulu lisansla ayni
   * kimlik ve daha gec etkin bitis sartiyla etkinlestirme yolundan kurulur (license.renewed_remote).
   */
  private async installRemoteUpdate(
    branchId: string,
    eventLicenseId: string,
    key: string,
  ): Promise<boolean> {
    if (!hasPublicKey()) return false;
    const update = this.verify(key);
    if (!update) {
      this.logger.warn('Buluttan gelen lisans dogrulanamadi; kurulmadi.');
      return false;
    }
    const stored = await this.current();
    const current = stored?.licenseKey ? this.verify(stored.licenseKey) : null;
    const accepted = acceptsRemoteUpdate(
      current ? { id: current.payload.id ?? null, graceUntil: current.graceUntil } : null,
      { id: update.payload.id ?? null, graceUntil: update.graceUntil },
      eventLicenseId,
    );
    if (!accepted) return false;
    const now = await this.currentTime(
      branchId,
      (await this.readSettings(branchId)).get(SettingKeys.licenseClock),
    );
    if (update.graceUntil.getTime() <= now) return false;
    await this.install(update, {
      branchId,
      action: 'license.renewed_remote',
      previous: current?.payload ?? null,
    });
    return true;
  }
}
