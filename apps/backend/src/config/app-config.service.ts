import { Injectable } from '@nestjs/common';
import { loadEnv, type Env } from './env.schema';

/**
 * Tip-guvenli config erisimi. process.env yerine bu servis enjekte edilir.
 * .env, main/seed basinda (bootstrap-env) yuklendigi icin burada hazirdir.
 */
@Injectable()
export class AppConfigService {
  private readonly env: Env;

  constructor() {
    this.env = loadEnv();
  }

  get raw(): Env {
    return this.env;
  }

  get port(): number {
    return this.env.API_PORT;
  }
  get host(): string {
    return this.env.API_HOST;
  }
  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get accessSecret(): string {
    return this.env.JWT_ACCESS_SECRET;
  }
  get refreshSecret(): string {
    return this.env.JWT_REFRESH_SECRET;
  }
  get ownerAccessTtl(): string {
    return this.env.JWT_ACCESS_TTL;
  }
  get waiterAccessTtl(): string {
    return this.env.JWT_WAITER_ACCESS_TTL;
  }
  get refreshTtl(): string {
    return this.env.JWT_REFRESH_TTL;
  }

  get failedLoginMax(): number {
    return this.env.AUTH_FAILED_LOGIN_MAX;
  }
  get lockMinutes(): number {
    return this.env.AUTH_LOCK_MINUTES;
  }

  /** QR menu bulutunun ham adresi (dogrulanmamis; bos = tanimsiz). */
  get cloudApiUrl(): string {
    return this.env.CLOUD_API_URL.trim();
  }
  /** Masaustu surumu (paketli surumde app.getVersion(); gelistirmede bos). */
  get appVersion(): string {
    return this.env.ADO_APP_VERSION.trim();
  }
  /** Derleme profili: 'test' | 'prod' (gelistirmede bos). */
  get buildProfile(): string {
    return this.env.ADO_BUILD_PROFILE.trim();
  }
}
