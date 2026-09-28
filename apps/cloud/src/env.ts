import type { BranchRow, TenantRow } from './lib/db';

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  /** Satici (vendor) API anahtari. Tanimli degilse /api/admin kapalidir. */
  ADMIN_TOKEN?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  tenantId: string;
}

/** POS istegini yapan sube ve isletmesi (Bearer belirtecten cozulur). */
export interface PosContext {
  branch: BranchRow;
  tenant: TenantRow;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    branch: BranchRow;
    pos: PosContext;
  };
}
