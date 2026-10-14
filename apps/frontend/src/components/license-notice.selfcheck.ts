// Lisans seridi / penceresi / karti metinleri + api.ts'in 403 LICENSE_LOCKED olayi.
// Calistir: node --experimental-strip-types src/components/license-notice.selfcheck.ts
import assert from 'node:assert/strict';
import {
  bannerContent,
  formatMoment,
  lockDialogContent,
  phaseDetails,
  policySummary,
  statusBadge,
  type LicenseStatus,
} from './license-notice.ts';

const JUNE15 = new Date(2027, 5, 15).toISOString(); // yerel gece yarisi
const status = (patch: Partial<LicenseStatus>): LicenseStatus => ({
  enforced: true,
  state: 'active',
  customerName: 'Deneme Lokanta',
  plan: null,
  validUntil: JUNE15,
  graceUntil: null,
  daysLeft: 30,
  verifiable: true,
  licenseId: 'lic_selfcheck01',
  features: {},
  needsReentry: false,
  phase: 'active',
  locked: false,
  lockAt: null,
  trialEndsAt: null,
  remoteState: null,
  reason: null,
  graceDays: 7,
  banner: null,
  supportContact: null,
  ...patch,
});

// --- Tarih bicimi ---
assert.equal(formatMoment(JUNE15), '15 Haziran 2027', 'gece yarisi: yalniz gun');
assert.match(formatMoment(new Date(2027, 5, 15, 14, 30).toISOString()), /15 Haziran 2027 14:30/);
assert.equal(formatMoment(null), '');
assert.equal(formatMoment('bozuk'), '');

// --- Serit ---
assert.equal(bannerContent(status({})), null, 'gecerli lisans: serit yok');
assert.equal(
  bannerContent(status({ enforced: false, phase: 'unlicensed', state: 'none', banner: null })),
  null,
  'zorunluluk kapali ve lisans yok: serit yok',
);
const unlicensed = bannerContent(
  status({
    phase: 'unlicensed',
    state: 'none',
    locked: true,
    reason: 'no_license',
    banner: { level: 'danger', daysLeft: 0, until: null },
  }),
);
assert.equal(unlicensed?.level, 'danger');
assert.match(unlicensed?.text ?? '', /Lisans tanımlı değil: yeni adisyon açılamıyor/);
assert.equal(unlicensed?.action, 'Lisans anahtarı gir');
const trial = bannerContent(
  status({ phase: 'trial', state: 'none', banner: { level: 'info', daysLeft: 3, until: JUNE15 } }),
);
assert.match(trial?.text ?? '', /Deneme sürümü: 3 gün kaldı/);
const expiring = bannerContent(
  status({ phase: 'expiring', banner: { level: 'warning', daysLeft: 5, until: JUNE15 } }),
);
assert.equal(expiring?.level, 'warning');
assert.match(expiring?.text ?? '', /5 gün sonra doluyor \(15 Haziran 2027\)/);
const grace = bannerContent(
  status({
    phase: 'grace',
    reason: 'expired',
    banner: { level: 'danger', daysLeft: 4, until: JUNE15 },
  }),
);
assert.match(
  grace?.text ?? '',
  /süresi doldu: 15 Haziran 2027 itibarıyla yeni adisyon açılamayacak/,
);
assert.match(grace?.text ?? '', /4 gün kaldı/);
const suspended = bannerContent(
  status({
    phase: 'grace',
    reason: 'suspended',
    remoteState: 'suspended',
    banner: { level: 'danger', daysLeft: 6, until: JUNE15 },
  }),
);
assert.match(suspended?.text ?? '', /askıya alındı: 15 Haziran 2027 itibarıyla/);
const revoked = bannerContent(
  status({
    phase: 'locked',
    locked: true,
    reason: 'revoked',
    banner: { level: 'danger', daysLeft: 0, until: JUNE15 },
  }),
);
assert.match(revoked?.text ?? '', /iptal edildi: yeni adisyon açılamıyor/);
const infoOnly = bannerContent(
  status({
    enforced: false,
    phase: 'locked',
    reason: 'expired',
    banner: { level: 'info', daysLeft: 0, until: JUNE15 },
  }),
);
assert.equal(infoOnly?.level, 'info');
assert.match(infoOnly?.text ?? '', /satış devam ediyor/, 'zorunluluk kapali: yalniz bilgi');

// --- Kilit penceresi ---
assert.match(lockDialogContent(undefined).message, /okunuyor/);
const lockedNoLicense = lockDialogContent(
  status({ phase: 'unlicensed', locked: true, reason: 'no_license' }),
);
assert.equal(lockedNoLicense.title, 'Lisans gerekli');
assert.match(lockedNoLicense.message, /Açık adisyonlar ödenip kapatılabilir/);
assert.match(lockedNoLicense.message, /lisans anahtarını girerek/);
const lockedSuspended = lockDialogContent(
  status({ phase: 'locked', locked: true, reason: 'suspended' }),
);
assert.equal(lockedSuspended.title, 'Lisans askıya alındı');
assert.match(lockedSuspended.message, /satıcınızla görüşün/);
assert.equal(
  lockDialogContent(status({ phase: 'locked', locked: true, reason: 'expired' })).title,
  'Lisans süresi doldu',
);
assert.match(
  lockDialogContent(
    status({ phase: 'expiring', banner: { level: 'warning', daysLeft: 5, until: JUNE15 } }),
  ).message,
  /5 gün sonra doluyor/,
);
assert.equal(lockDialogContent(status({})).message, 'Lisansınız geçerli.');

// --- Ayarlar karti ---
assert.deepEqual(statusBadge(status({})), { label: 'Geçerli', tone: 'ok' });
assert.equal(statusBadge(status({ phase: 'trial' })).label, 'Deneme');
assert.equal(statusBadge(status({ phase: 'unlicensed' })).tone, 'danger');
assert.equal(statusBadge(status({ phase: 'unlicensed', enforced: false })).tone, 'neutral');
assert.equal(statusBadge(status({ phase: 'expiring' })).label, 'Süresi yaklaşıyor');
assert.equal(
  statusBadge(status({ phase: 'grace', reason: 'expired' })).label,
  'Süresi doldu (ek süre)',
);
assert.equal(
  statusBadge(status({ phase: 'grace', reason: 'suspended' })).label,
  'Askıya alındı (ek süre)',
);
assert.equal(statusBadge(status({ phase: 'locked', reason: 'revoked' })).label, 'İptal edildi');
assert.match(policySummary(status({ graceDays: 3 })), /3 gün ek süre/);
assert.match(policySummary(status({ enforced: false })), /zorunluluğu kapalı/);
assert.deepEqual(phaseDetails(status({})), []);
assert.match(
  phaseDetails(status({ phase: 'trial', trialEndsAt: JUNE15 }))[0] ?? '',
  /15 Haziran 2027 itibarıyla biter/,
);
assert.match(
  phaseDetails(status({ phase: 'grace', lockAt: JUNE15 }))[0] ?? '',
  /Yeni adisyon 15 Haziran 2027 itibarıyla durur/,
);
assert.deepEqual(phaseDetails(status({ remoteState: 'revoked' })), ['Bulut: lisans iptal edildi.']);

// --- api.ts: 403 LICENSE_LOCKED -> genel `license-locked` olayi (pencere acilir) ---
const target = new EventTarget();
const g = globalThis as unknown as Record<string, unknown>;
g.window = target;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let reply = {
  status: 403,
  body: { success: false, error: { code: 'LICENSE_LOCKED', message: 'x' } },
};
g.fetch = async () => new Response(JSON.stringify(reply.body), { status: reply.status });
const { api, ApiError, LICENSE_LOCKED_EVENT, openLicenseDialog } = await import('../lib/api.ts');
let opened = 0;
target.addEventListener(LICENSE_LOCKED_EVENT, () => opened++);

await assert.rejects(api('/orders', { method: 'POST', body: {} }), (err: unknown) => {
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'LICENSE_LOCKED');
  return true;
});
assert.equal(opened, 1, '403 LICENSE_LOCKED pencereyi acar');
reply = { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'yetki' } } };
await assert.rejects(api('/orders', { method: 'POST', body: {} }));
reply = { status: 409, body: { success: false, error: { code: 'LICENSE_LOCKED', message: 'x' } } };
await assert.rejects(api('/orders', { method: 'POST', body: {} }));
assert.equal(opened, 1, 'baska 403 ya da baska durum kodu pencere acmaz');
openLicenseDialog();
assert.equal(opened, 2, 'serit dugmesi de ayni olayi yayar');

console.log('license-notice self-check OK');
