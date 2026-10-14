import { Injectable, Logger } from '@nestjs/common';

/**
 * Bu kurulumun buluta bildirdigi saglik bilgileri (heartbeat). Bilinmeyen deger null.
 * Saticinin panelinde "bu dukkan saglikli mi" sorusunu cevaplar: disk, yedek, bulut yedegi.
 */
export interface InstallMetrics {
  dbBytes: number | null;
  backupsBytes: number | null;
  freeDiskBytes: number | null;
  lastBackupAt: string | null;
  lastCloudBackupAt: string | null;
}

export type InstallMetricsProvider = () => Promise<Partial<InstallMetrics>>;

const EMPTY: InstallMetrics = {
  dbBytes: null,
  backupsBytes: null,
  freeDiskBytes: null,
  lastBackupAt: null,
  lastCloudBackupAt: null,
};

/** Tek saglayici bu sureden uzun surerse yok sayilir (heartbeat beklemesin). */
const PROVIDER_TIMEOUT_MS = 5_000;

/**
 * Saglik bilgisi toplayicisi. Moduller kendi bildiklerini kaydeder (yedek: veritabani/yedek boyutu
 * ve disk; bulut yedegi: son yukleme); bulut baglantisi heartbeat'te `collect()` cagirir.
 * Bir saglayicinin hatasi digerlerini ve heartbeat'i dusurmez.
 */
@Injectable()
export class InstallMetricsService {
  private readonly logger = new Logger(InstallMetricsService.name);
  private readonly providers = new Map<string, InstallMetricsProvider>();

  /** Ayni adla ikinci kayit oncekinin yerine gecer. */
  register(name: string, provider: InstallMetricsProvider): void {
    this.providers.set(name, provider);
  }

  async collect(): Promise<InstallMetrics> {
    const parts = await Promise.all(
      [...this.providers.entries()].map(async ([name, provider]) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            provider(),
            new Promise<Partial<InstallMetrics>>((_, reject) => {
              timer = setTimeout(() => reject(new Error('zaman asimi')), PROVIDER_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          this.logger.warn(`Saglik bilgisi okunamadi (${name}): ${String(err)}`);
          return {};
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    // Ayni alani birden cok saglayici verirse sonraki kazanir; tanimsiz degerler yok sayilir.
    const merged: Record<string, unknown> = { ...EMPTY };
    for (const part of parts) {
      for (const [key, value] of Object.entries(part)) {
        if (value !== undefined && key in EMPTY) merged[key] = value;
      }
    }
    return merged as unknown as InstallMetrics;
  }
}
