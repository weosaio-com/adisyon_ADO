// @peculiar/x509 -> tsyringe bir Reflect polyfill'i ister (backend acilista zaten yukler).
import 'reflect-metadata';
import assert from 'node:assert';
import { webcrypto, X509Certificate as NodeX509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest, createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { lanIPv4Addresses } from '../common/util/network';

/**
 * Yerel HTTPS: tabletler uygulamayi LAN IP'sinden actigi icin tarayici bunu
 * "guvenli baglam" saymaz; Service Worker (cevrimdisi acilis) yalniz HTTPS'te calisir.
 *
 * Her kurulum kendi yerel CA'sini bir kez uretir (10 yil). Tabletlere yalniz bu CA
 * bir kez kurulur. Sunucu sertifikasi CA ile imzalanir ve LAN IP'leri degisince
 * (DHCP) ya da bitisine 30 gun kala yenilenir: CA ayni kaldigi icin tabletlerde
 * yeniden kurulum gerekmez. Anahtarlar ECDSA P-256 (WebCrypto, hizli).
 */

// Backend tsconfig'inde DOM kutuphanesi yok: WebCrypto tipleri Node'dan.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
const crypto = webcrypto;
x509.cryptoProvider.set(crypto);

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;
const CA_YEARS = 10;
// Tarayici/iOS sunucu sertifikasi siniri (398 gun) altinda kalinir.
const LEAF_DAYS = 397;
const RENEW_BEFORE_DAYS = 30;

export interface TlsHosts {
  ips: string[];
  dnsNames: string[];
}

export interface TlsMaterial {
  key: string;
  cert: string;
  caCert: string;
  /** Bu cagrida sunucu sertifikasi yeniden uretildi mi (sicak yenileme icin). */
  renewed: boolean;
}

/** Bu bilgisayarin su anki adlari: LAN IP'leri + bilgisayar adi. */
export function currentTlsHosts(): TlsHosts {
  const host = hostname();
  return { ips: lanIPv4Addresses(), dnsNames: [host, `${host}.local`] };
}

// SAN'a her zaman localhost eklenir; gecersiz DNS adlari (orn. '_') elenir.
function normalizeHosts(hosts: TlsHosts): TlsHosts {
  const unique = (values: string[]) => [...new Set(values)].sort();
  return {
    ips: unique([...hosts.ips, '127.0.0.1']),
    dnsNames: unique(
      [...hosts.dnsNames, 'localhost']
        .map((name) => name.trim().toLowerCase())
        .filter((name) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)),
    ),
  };
}

const sameHosts = (a: TlsHosts, b: TlsHosts) =>
  a.ips.join(',') === b.ips.join(',') && a.dnsNames.join(',') === b.dnsNames.join(',');

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

function writePrivate(path: string, pem: string): void {
  writeFileSync(path, pem, { mode: 0o600 });
}

async function createCa(now: Date): Promise<{ keyPem: string; certPem: string }> {
  const keys = (await crypto.subtle.generateKey(KEY_ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + CA_YEARS);
  const host = hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'kasa';
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=Adisyon POS Yerel CA (${host}), O=Adisyon POS`,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter,
    keys,
    signingAlgorithm: SIGN_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { keyPem: await exportPrivateKey(keys.privateKey), certPem: cert.toString('pem') };
}

async function createLeaf(
  ca: { keyPem: string; certPem: string },
  hosts: TlsHosts,
  now: Date,
): Promise<{ keyPem: string; certPem: string; notBefore: Date; notAfter: Date }> {
  const keys = (await crypto.subtle.generateKey(KEY_ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await crypto.subtle.importKey(
    'pkcs8',
    x509.PemConverter.decodeFirst(ca.keyPem),
    KEY_ALG,
    false,
    ['sign'],
  );
  const notBefore = new Date(now.getTime() - DAY_MS);
  const notAfter = new Date(now.getTime() + LEAF_DAYS * DAY_MS);
  const cert = await x509.X509CertificateGenerator.create({
    subject: `CN=${hosts.ips.find((ip) => ip !== '127.0.0.1') ?? 'localhost'}`,
    // CA'nin Name nesnesi aynen: DN yeniden kodlanirsa bazi istemciler zinciri eslestiremez.
    issuer: caCert.subjectName,
    notBefore,
    notAfter,
    publicKey: keys.publicKey,
    signingKey: caKey,
    signingAlgorithm: SIGN_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        ...hosts.ips.map((value) => ({ type: 'ip' as const, value })),
        ...hosts.dnsNames.map((value) => ({ type: 'dns' as const, value })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey),
    ],
  });
  return {
    keyPem: await exportPrivateKey(keys.privateKey),
    certPem: cert.toString('pem'),
    notBefore,
    notAfter,
  };
}

/**
 * `dir` altinda CA + sunucu sertifikasini hazirlar (yoksa uretir, gerekiyorsa
 * yeniler). Dosyalar: ca.key.pem, ca.crt.pem, server.key.pem, server.crt.pem, server.json.
 */
export async function ensureTlsMaterial(
  dir: string,
  hosts: TlsHosts,
  now = new Date(),
): Promise<TlsMaterial> {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => join(dir, name);

  let ca: { keyPem: string; certPem: string };
  if (existsSync(file('ca.key.pem')) && existsSync(file('ca.crt.pem'))) {
    ca = {
      keyPem: readFileSync(file('ca.key.pem'), 'utf8'),
      certPem: readFileSync(file('ca.crt.pem'), 'utf8'),
    };
  } else {
    ca = await createCa(now);
    writePrivate(file('ca.key.pem'), ca.keyPem);
    writeFileSync(file('ca.crt.pem'), ca.certPem);
    rmSync(file('server.json'), { force: true }); // yeni CA -> eski sunucu sertifikasi gecersiz
  }

  const wanted = normalizeHosts(hosts);
  let meta: { hosts: TlsHosts; notBefore?: string; notAfter: string } | null = null;
  try {
    meta = JSON.parse(readFileSync(file('server.json'), 'utf8'));
  } catch {
    meta = null;
  }
  // Saat geri alinmissa (notBefore gelecekte) da yenilenir: "henuz gecerli degil" kalmasin.
  const fresh =
    meta !== null &&
    sameHosts(meta.hosts, wanted) &&
    Date.parse(meta.notBefore ?? '') <= now.getTime() &&
    Date.parse(meta.notAfter) - now.getTime() > RENEW_BEFORE_DAYS * DAY_MS &&
    existsSync(file('server.key.pem')) &&
    existsSync(file('server.crt.pem'));
  if (!fresh) {
    const leaf = await createLeaf(ca, wanted, now);
    writePrivate(file('server.key.pem'), leaf.keyPem);
    writeFileSync(file('server.crt.pem'), leaf.certPem);
    writeFileSync(
      file('server.json'),
      JSON.stringify({
        hosts: wanted,
        notBefore: leaf.notBefore.toISOString(),
        notAfter: leaf.notAfter.toISOString(),
      }),
    );
  }
  return {
    key: readFileSync(file('server.key.pem'), 'utf8'),
    cert: readFileSync(file('server.crt.pem'), 'utf8'),
    caCert: ca.certPem,
    renewed: !fresh,
  };
}

// --- self-check: `ts-node src/tls/tls.certs.ts` ---
if (require.main === module) {
  void (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ado-tls-'));
    const hosts = { ips: ['192.168.1.20'], dnsNames: ['Kasa-PC', 'bad_name'] };
    const first = await ensureTlsMaterial(dir, hosts);
    const ca = new NodeX509Certificate(first.caCert);
    const leaf = new NodeX509Certificate(first.cert);

    assert.ok(ca.ca, 'CA sertifikasi CA olmali');
    assert.ok(!leaf.ca, 'sunucu sertifikasi CA olmamali');
    assert.ok(leaf.checkIssued(ca), 'sunucu sertifikasi CA tarafindan verilmis');
    assert.ok(leaf.verify(ca.publicKey), 'CA imzasi dogrulanmali');
    for (const san of ['IP Address:192.168.1.20', 'IP Address:127.0.0.1', 'DNS:localhost']) {
      assert.ok(leaf.subjectAltName?.includes(san), `SAN: ${san} (${leaf.subjectAltName})`);
    }
    assert.ok(leaf.subjectAltName?.includes('DNS:kasa-pc'), 'bilgisayar adi kucuk harfle SANda');
    assert.ok(!leaf.subjectAltName?.includes('bad_name'), 'gecersiz DNS adi elenir');
    assert.ok(leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1'), 'EKU serverAuth');
    const days = (Date.parse(leaf.validTo) - Date.now()) / DAY_MS;
    assert.ok(days > 390 && days <= 398, `sunucu sertifikasi <= 398 gun (${days})`);

    // Ayni adlar -> yeniden uretilmez; IP degisince yenilenir ama CA ayni kalir.
    const again = await ensureTlsMaterial(dir, hosts);
    assert.ok(!again.renewed && again.cert === first.cert, 'ayni adlarda sertifika korunur');
    const moved = await ensureTlsMaterial(dir, { ...hosts, ips: ['10.0.0.5'] });
    assert.ok(
      moved.renewed && moved.caCert === first.caCert,
      'IP degisti: CA ayni, sertifika yeni',
    );
    assert.ok(new NodeX509Certificate(moved.cert).subjectAltName?.includes('IP Address:10.0.0.5'));
    const later = new Date(Date.now() + 380 * DAY_MS);
    assert.ok(
      (await ensureTlsMaterial(dir, { ...hosts, ips: ['10.0.0.5'] }, later)).renewed,
      'bitise 30 gunden az kala yenilenir',
    );

    // Onceki cagri gelecek tarihli sertifika uretti: gercek saatte (geri alinmis saat gibi) yenilenir.
    const tls = await ensureTlsMaterial(dir, { ...hosts, ips: ['10.0.0.5'] });
    assert.ok(tls.renewed, 'notBefore gelecekteyse sertifika yenilenir');

    // Gercek TLS el sikismasi: Node yalniz yerel CA'ya guvenerek 127.0.0.1'e baglanir.
    const server = createHttpsServer({ key: tls.key, cert: tls.cert }, (_req, res) =>
      res.end('ok'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, ca: tls.caCert }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    server.close();
    assert.strictEqual(body, 'ok', 'yerel CA ile TLS dogrulamasi gecmeli');

    rmSync(dir, { recursive: true, force: true });
    console.log('✓ tls.certs self-check OK');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
