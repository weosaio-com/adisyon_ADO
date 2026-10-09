import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  createDomainEvent,
  DomainEventName,
  newId,
  type LicenseActivatedEventPayload,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flags.service';
import { EventBusService } from '../common/events/event-bus.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasPublicKey, licenseDates, parseLicenseKey, type LicensePayload } from './license.keys';

export type LicenseState = 'none' | 'active' | 'grace' | 'expired';

export interface LicenseStatus {
  /** Lisans zorunlulugu acik mi (settings: license.enforce). KAPALI iken hicbir sey engellenmez. */
  enforced: boolean;
  state: LicenseState;
  customerName: string | null;
  plan: string | null;
  validUntil: string | null;
  graceUntil: string | null;
  /** validUntil'e kalan gun (gecmisse negatif). Lisans yoksa null. */
  daysLeft: number | null;
  /** Bu kurulumda anahtar dogrulanabiliyor mu (acik anahtar gomulu mu). */
  verifiable: boolean;
  /** Lisans kimligi (bulutta isletme anahtari). Eski lisanslarda null. */
  licenseId: string | null;
  /** Lisanstaki ozellik bayraklari (imzasi dogrulanmis anahtardan). */
  features: Record<string, boolean>;
  /** Kayitli bir anahtar var ama bu kurulumun acik anahtariyla dogrulanamiyor: yeniden girilmeli. */
  needsReentry: boolean;
}

/** Imzasi dogrulanmis, kayitli lisans (bulut baglantisi gibi tuketiciler icin). */
export interface ActiveLicense {
  key: string;
  payload: LicensePayload;
  state: Exclude<LicenseState, 'none'>;
  validUntil: Date;
  graceUntil: Date;
}

const ENFORCE_KEY = 'license.enforce';
const DAY_MS = 86_400_000;

/**
 * Yillik lisans: imzali anahtari cevrimdisi dogrular, LicenseInfo'ya yazar,
 * durumu okur.
 *
 * ONEMLI: bu servis hicbir seyi kendi basina ENGELLEMEZ. Engelleme
 * LicenseGuard'in isi ve yalnizca `license.enforce = true` ayariyla acilir.
 * Varsayilan KAPALI -> mevcut kurulumlar aynen calismaya devam eder.
 */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly events: EventBusService,
  ) {}

  /** Zorunluluk ayari. Ayar yoksa/bozuksa KAPALI kabul edilir (guvenli varsayilan). */
  async isEnforced(branchId: string): Promise<boolean> {
    if (!hasPublicKey()) return false;
    const row = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId, key: ENFORCE_KEY } },
    });
    if (!row || row.deletedAt) return false;
    try {
      return JSON.parse(row.value) === true;
    } catch {
      return false;
    }
  }

  private async current() {
    return this.prisma.licenseInfo.findFirst({ where: { deletedAt: null } });
  }

  /**
   * Kayitli anahtari HER OKUMADA yeniden dogrular: acik anahtar degistiyse (deneme -> uretim
   * derlemesi) eski anahtar artik gecerli sayilmaz. Tarihler ve bayraklar imzali payload'dan
   * okunur, veritabanindaki kopyalardan degil.
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

  /** Kayitli lisansin o anki durumu. Yan etkisi yok. */
  async getStatus(branchId: string): Promise<LicenseStatus> {
    const enforced = await this.isEnforced(branchId);
    const verifiable = hasPublicKey();
    const active = await this.getActiveLicense();

    if (!active) {
      const lic = await this.current();
      return {
        enforced,
        state: 'none',
        customerName: null,
        plan: null,
        validUntil: null,
        graceUntil: null,
        daysLeft: null,
        verifiable,
        licenseId: null,
        features: {},
        needsReentry: Boolean(lic?.licenseKey),
      };
    }

    const { payload, state, validUntil, graceUntil } = active;
    return {
      enforced,
      state,
      customerName: payload.c,
      plan: payload.p ?? null,
      validUntil: validUntil.toISOString(),
      graceUntil: graceUntil.toISOString(),
      daysLeft: Math.ceil((validUntil.getTime() - Date.now()) / DAY_MS),
      verifiable,
      licenseId: payload.id ?? null,
      features: payload.f ?? {},
      needsReentry: false,
    };
  }

  /**
   * Anahtari dogrular ve kaydeder. Gecersiz/suresi gecmis anahtar kabul
   * edilmez; mevcut lisans bozulmaz.
   */
  async activate(user: AuthUser, licenseKey: string): Promise<LicenseStatus> {
    if (!hasPublicKey()) {
      throw new BadRequestException(
        'Bu kurulumda lisans doğrulama anahtarı tanımlı değil. Satıcınıza başvurun.',
      );
    }
    const payload = parseLicenseKey(licenseKey);
    if (!payload) {
      throw new BadRequestException('Lisans anahtarı geçersiz veya bozuk.');
    }
    const { validUntil, graceUntil } = licenseDates(payload);
    if (graceUntil.getTime() <= Date.now()) {
      throw new BadRequestException('Lisans anahtarının süresi dolmuş.');
    }

    const features = JSON.stringify(payload.f ?? {});
    const existing = await this.current();
    const data = {
      licenseKey: licenseKey.trim(),
      customerName: payload.c,
      plan: payload.p ?? null,
      features,
      status: 'active',
      validUntil,
      graceUntil,
      activatedAt: new Date(),
      lastVerifiedAt: new Date(),
      signatureValid: true,
      deviceId: user.deviceId ?? null,
      syncState: 'pending',
    };

    if (existing) {
      await this.prisma.licenseInfo.update({
        where: { id: existing.id },
        data: { ...data, version: { increment: 1 } },
      });
    } else {
      await this.prisma.licenseInfo.create({ data: { id: newId(), ...data } });
    }

    // Lisanstaki feature-flag'ler onbellekte -> yeni anahtar sonrasi tazele.
    await this.flags.reloadFlags();
    this.logger.log(`Lisans etkinlestirildi: ${payload.c} (${payload.exp})`);

    // Yan etkiler (QR menu bulutunda lisansin yenilenmesi vb.) event ile. Anahtar event'e girmez.
    await this.events.publish(
      createDomainEvent<string, LicenseActivatedEventPayload>(
        DomainEventName.LicenseActivated,
        { licenseId: payload.id ?? null, customerName: payload.c, features: payload.f ?? {} },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
    return this.getStatus(user.branchId);
  }
}
