import type { BranchRow, TenantRow } from './lib/db';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  /** Program guncellemeleri (kurulum dosyasi, latest.yml, imzali ado-update.json). */
  UPDATES?: R2Bucket;
  ASSETS: Fetcher;
  /** Satici (vendor) API anahtari. Tanimli degilse /api/admin kapalidir. */
  ADMIN_TOKEN?: string;
  /**
   * Lisans imzasini dogrulayan Ed25519 acik anahtar(lar)i (base64 SPKI; virgulle liste).
   * Programdaki derleme profiliyle ayni anahtar (LICENSING.md). Bossa lisansla etkinlestirme kapali.
   */
  LICENSE_PUBLIC_KEY?: string;
}

/** POS istegini yapan sube ve isletmesi (Bearer belirtecten cozulur). */
export interface PosContext {
  branch: BranchRow;
  tenant: TenantRow;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    pos: PosContext;
  };
}
