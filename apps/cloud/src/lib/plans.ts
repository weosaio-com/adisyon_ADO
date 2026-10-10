/**
 * Paketler: isletme hangi QR ozelliklerini kullanir. Asil kapi buradadir. Lisansla baglanan
 * isletmede ozellikler imzali lisanstan gelir (planFromLicense + licenseFeatureOverrides) ve her
 * yenilemede yeniden yazilir. QR-1'de yalniz `qr.menu` kullanilir; digerleri sonraki asamalar icin
 * (siparis, uzaktan odeme, hesap bolme, oyunlar).
 */
export const FEATURES = ['qr.menu', 'qr.order', 'qr.pay', 'qr.split', 'qr.games'] as const;
export type Feature = (typeof FEATURES)[number];

export const PLANS = {
  menu: { label: 'QR Menü', features: ['qr.menu'] },
  order: { label: 'QR Menü + Sipariş', features: ['qr.menu', 'qr.order'] },
  pay: {
    label: 'QR Menü + Sipariş + Ödeme',
    features: ['qr.menu', 'qr.order', 'qr.pay', 'qr.split'],
  },
  full: { label: 'Tümü', features: [...FEATURES] },
} as const satisfies Record<string, { label: string; features: readonly Feature[] }>;
export type PlanId = keyof typeof PLANS;
export const PLAN_IDS = Object.keys(PLANS) as [PlanId, ...PlanId[]];

export type FeatureMap = Record<Feature, boolean>;

function parseOverrides(text: string): Partial<Record<Feature, boolean>> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Partial<Record<Feature, boolean>> = {};
    for (const feature of FEATURES) {
      const flag = (value as Record<string, unknown>)[feature];
      if (typeof flag === 'boolean') out[feature] = flag;
    }
    return out;
  } catch {
    return {};
  }
}

/** Lisansin suresi doldu mu (lisanssiz eski kiracida hic dolmaz). */
export function licenseExpired(
  tenant: { license_expires_at?: string | null },
  now = new Date(),
): boolean {
  const expiresAt = tenant.license_expires_at;
  return typeof expiresAt === 'string' && expiresAt !== '' && expiresAt <= now.toISOString();
}

/**
 * Paket + tek tek acilan/kapatilan ozellikler. Askiya alinan ya da lisansi dolan isletmede hepsi
 * kapali.
 */
export function tenantFeatures(tenant: {
  plan: string;
  features: string;
  status: string;
  license_expires_at?: string | null;
}): FeatureMap {
  const plan = PLANS[tenant.plan as PlanId];
  const base = new Set<Feature>(plan ? plan.features : []);
  const overrides = parseOverrides(tenant.features);
  const active = tenant.status === 'active' && !licenseExpired(tenant);
  return Object.fromEntries(
    FEATURES.map((feature) => [feature, active && (overrides[feature] ?? base.has(feature))]),
  ) as FeatureMap;
}

/** Lisanstaki ozelliklere en yakin paket (yalniz etiket icin). QR menu yoksa 'none'. */
export function planFromLicense(features: Record<string, boolean> | undefined): PlanId | 'none' {
  const has = (feature: Feature) => features?.[feature] === true;
  if (!has('qr.menu')) return 'none';
  if (FEATURES.every(has)) return 'full';
  if (has('qr.pay')) return 'pay';
  if (has('qr.order')) return 'order';
  return 'menu';
}

/** Lisanstaki ozellikler birebir: her bilinen ozellik icin acik/kapali (paket ne derse desin). */
export function licenseFeatureOverrides(
  features: Record<string, boolean> | undefined,
): Record<Feature, boolean> {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature, features?.[feature] === true]),
  ) as Record<Feature, boolean>;
}
