import assert from 'node:assert';
import { createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import { parseLicensePayload, splitLicenseKey, type LicensePayload } from '@ado/shared';

// Lisans anahtari: imzali, cevrimdisi dogrulanabilir tek metin. Bicim ve payload semasi
// `@ado/shared` (license.ts) icinde; bulut (Worker) ayni bicimi okur. Tasarim: LICENSING.md.
//
//   ADO1.<base64url(payload JSON)>.<base64url(ed25519 imza)>
//
// Payload alanlari:
//   { id: lisans kimligi, c: musteri adi, p: plan, exp: 'YYYY-MM-DD', g: gun (ek sure), f: {flag} }
//
// Neden Ed25519: node stdlib'de var (bagimlilik yok), imza 64 bayt, anahtar
// dogrulama saniyenin altinda. Ozel anahtar SADECE satici tarafinda; kurulumdaki
// makinede yalnizca acik anahtar bulunur -> kasadaki dosyalardan anahtar
// uretilemez.
//
// Acik anahtar(lar) env ile gelir (paketli surumde derleme profilinden,
// apps/desktop/profiles). Virgulle ayrilmis liste anahtar rotasyonu icindir: ilk tutan kazanir.

const ENV_KEY = 'ADO_LICENSE_PUBLIC_KEY';

// Yer tutucu: uretim oncesi satici acik anahtari ile degistirilebilir (base64,
// SPKI DER). Bos birakilirsa hicbir anahtar dogrulanamaz -> lisans zorunlu
// tutulamaz, sistem serbest calisir (guvenli varsayilan: kimseyi kilitlemez).
const EMBEDDED_PUBLIC_KEY_B64 = '';

export type { LicensePayload };

function publicKeysB64(): string[] {
  return (process.env[ENV_KEY] ?? EMBEDDED_PUBLIC_KEY_B64)
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** Acik anahtar tanimli mi. Yoksa lisans dogrulama devre disidir. */
export function hasPublicKey(): boolean {
  return publicKeysB64().length > 0;
}

/**
 * Anahtari cozer ve imzayi dogrular. Gecersizse null (asla exception ile
 * cagirani bozmaz — lisans yolu uygulamayi dusurmemeli).
 */
export function parseLicenseKey(key: string): LicensePayload | null {
  const parts = splitLicenseKey(key);
  if (!parts) return null;
  const payloadRaw = Buffer.from(parts.payloadRaw);
  const signature = Buffer.from(parts.signature);

  for (const pub of publicKeysB64()) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(pub, 'base64'),
        format: 'der',
        type: 'spki',
      });
      // Ed25519: algoritma parametresi null olmali.
      if (verifySignature(null, payloadRaw, publicKey, signature)) {
        return parseLicensePayload(parts.payloadRaw);
      }
    } catch {
      // Bozuk acik anahtar: listede siradakine gec.
    }
  }
  return null;
}

/** exp (YEREL gun basi) + grace gun -> bitis anlari. */
export function licenseDates(payload: Pick<LicensePayload, 'exp' | 'g'>): {
  validUntil: Date;
  graceUntil: Date;
} {
  const [y = 0, m = 1, d = 1] = payload.exp.split('-').map(Number);
  const validUntil = new Date(y, m - 1, d, 0, 0, 0, 0);
  const graceUntil = new Date(validUntil);
  graceUntil.setDate(graceUntil.getDate() + Math.max(0, payload.g ?? 0));
  return { validUntil, graceUntil };
}

// --- self-check: `ts-node src/license/license.keys.ts` ---
if (require.main === module) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  process.env[ENV_KEY] = publicB64;

  const b64url = (b: Buffer) => b.toString('base64url');
  const makeKey = (payload: unknown, signWith = privateKey) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return `ADO1.${b64url(raw)}.${b64url(sign(null, raw, signWith))}`;
  };
  const good: LicensePayload = {
    id: 'lic_TestLokanta',
    c: 'Test Lokanta',
    p: 'yearly',
    exp: '2030-01-01',
    g: 7,
    f: { 'qr.menu': true },
  };

  assert.ok(hasPublicKey(), 'env acik anahtari okunmali');
  assert.deepStrictEqual(parseLicenseKey(makeKey(good)), good);

  // Kimliksiz eski lisans hala gecerli.
  const legacy = { c: 'Eski Lokanta', exp: '2030-01-01' };
  assert.deepStrictEqual(parseLicenseKey(makeKey(legacy)), legacy);

  // Imza baska anahtarla atilirsa REDDEDILMELI (lisans kalpazanligi).
  const other = generateKeyPairSync('ed25519');
  assert.strictEqual(
    parseLicenseKey(makeKey(good, other.privateKey)),
    null,
    'yabanci imza kabul edilmemeli',
  );

  // Payload kurcalanirsa imza tutmaz.
  const parts = makeKey(good).split('.');
  const tampered = Buffer.from(JSON.stringify({ ...good, exp: '2099-01-01' })).toString(
    'base64url',
  );
  assert.strictEqual(
    parseLicenseKey(`ADO1.${tampered}.${parts[2]}`),
    null,
    'kurcalama yakalanmali',
  );

  // Imzali ama semaya uymayan payload reddedilir.
  assert.strictEqual(parseLicenseKey(makeKey({ c: '', exp: '2030-01-01' })), null);
  assert.strictEqual(parseLicenseKey(makeKey({ c: 'x', exp: '2030-01-01', id: 'kisa' })), null);

  // Bicim hatalari sessizce null doner (exception ile uygulamayi dusurmez).
  for (const bad of ['', 'ADO1.x', 'ADO2.a.b', 'saçmasapan', 'ADO1...']) {
    assert.strictEqual(parseLicenseKey(bad), null, `gecersiz bicim: ${bad}`);
  }

  // Anahtar rotasyonu: listedeki herhangi bir anahtar tutarsa gecerli; bozuk anahtar atlanir.
  const otherB64 = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  process.env[ENV_KEY] = `bozuk-anahtar, ${otherB64} ,${publicB64}`;
  assert.deepStrictEqual(parseLicenseKey(makeKey(good)), good, 'listedeki ikinci anahtar');
  process.env[ENV_KEY] = otherB64;
  assert.strictEqual(parseLicenseKey(makeKey(good)), null, 'listede olmayan anahtar');

  // Tarihler YEREL gun basi + grace gun.
  const dates = licenseDates(good);
  assert.strictEqual(dates.validUntil.getFullYear(), 2030);
  assert.strictEqual(dates.validUntil.getMonth(), 0);
  assert.strictEqual(dates.validUntil.getDate(), 1);
  assert.strictEqual(dates.graceUntil.getDate(), 8);
  // grace yoksa graceUntil = validUntil.
  const noGrace = licenseDates({ exp: '2030-01-01' });
  assert.strictEqual(noGrace.graceUntil.getTime(), noGrace.validUntil.getTime());

  // Acik anahtar yoksa hicbir sey dogrulanamaz -> lisans zorlanamaz.
  process.env[ENV_KEY] = '';
  assert.strictEqual(hasPublicKey(), false);
  assert.strictEqual(parseLicenseKey(makeKey(good)), null);
  process.env[ENV_KEY] = ' , ';
  assert.strictEqual(hasPublicKey(), false, 'yalniz bosluk/virgul anahtar sayilmaz');

  console.log('✓ license.keys self-check OK');
}
