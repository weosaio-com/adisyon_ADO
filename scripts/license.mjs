#!/usr/bin/env node
// Satici lisans araci: Ed25519 anahtar cifti uretir, lisans imzalar, dogrular.
// Bagimliliksizdir (yalniz node:*). Bicim: LICENSING.md · packages/shared/src/license.ts.
//
//   node scripts/license.mjs gen-key --out <repo DISINDA klasor> [--github-env]
//   node scripts/license.mjs sign --key <ozel.pem> --customer "Ad" --exp 2027-01-01 \
//        [--id lic_xxx] [--plan yearly] [--grace 14] [--feature qr.menu=true ...]
//   node scripts/license.mjs verify --pub <base64 SPKI> --license <ADO1....>
//   node scripts/license.mjs public-key --key <ozel.pem>
//
// OZEL ANAHTAR ASLA REPOYA GIRMEZ: gen-key repo icindeki bir klasore yazmayi reddeder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const PRIVATE_KEY_FILE = 'ado-license-private.pem';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Yol repo klasorunun icinde mi (ozel anahtar oraya yazilamaz). */
export function isInsideRepo(path, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, resolve(path));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Yeni anahtar cifti: ozel anahtar PKCS8 PEM, acik anahtar base64 SPKI DER. */
export function generateLicenseKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}

function isRealDate(text) {
  if (!DATE_PATTERN.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function newLicenseId() {
  return `lic_${randomBytes(9).toString('base64url')}`;
}

/** Payload'i dogrular (paylasilan semayla ayni kurallar); hata varsa firlatir. */
export function buildPayload({ id, customer, exp, plan, grace, features }) {
  const payload = { id: id ?? newLicenseId(), c: String(customer ?? '').trim(), exp };
  if (!ID_PATTERN.test(payload.id)) throw new Error(`Gecersiz lisans kimligi: ${payload.id}`);
  if (!payload.c || payload.c.length > 120) throw new Error('Musteri adi 1-120 karakter olmali.');
  if (!isRealDate(exp ?? '')) throw new Error('Bitis tarihi YYYY-AA-GG biciminde olmali.');
  if (plan !== undefined) {
    if (!plan || plan.length > 40) throw new Error('Plan adi 1-40 karakter olmali.');
    payload.p = plan;
  }
  if (grace !== undefined) {
    if (!Number.isInteger(grace) || grace < 0 || grace > 366) {
      throw new Error('Ek sure 0-366 gun arasinda tam sayi olmali.');
    }
    payload.g = grace;
  }
  if (features && Object.keys(features).length > 0) payload.f = features;
  return payload;
}

/** ADO1.<payload>.<imza> uretir. Imza payload'in ham baytlari uzerindedir. */
export function signLicense(payload, privateKeyPem) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, raw, createPrivateKey(privateKeyPem));
  return `ADO1.${raw.toString('base64url')}.${signature.toString('base64url')}`;
}

/** Imzayi dogrular; gecerliyse payload, degilse null. */
export function verifyLicense(token, publicKeyB64) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'ADO1') return null;
  try {
    const raw = Buffer.from(parts[1], 'base64url');
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, raw, key, Buffer.from(parts[2], 'base64url'))) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

function parseFeatures(list = []) {
  const features = {};
  for (const item of list) {
    const match = /^([a-z0-9][a-z0-9._-]*)=(true|false)$/i.exec(item);
    if (!match) throw new Error(`Ozellik bicimi ad=true|false olmali: ${item}`);
    features[match[1]] = match[2].toLowerCase() === 'true';
  }
  return features;
}

function genKey({ out, force, 'github-env': githubEnv }) {
  if (!out) throw new Error('--out <klasor> gerekli.');
  if (isInsideRepo(out)) throw new Error('Ozel anahtar repo klasorunun icine yazilamaz.');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const keyPath = join(resolve(out), PRIVATE_KEY_FILE);
  if (existsSync(keyPath) && !force) {
    throw new Error(`${keyPath} zaten var (uzerine yazmak icin --force).`);
  }
  const { privateKeyPem, publicKeyB64 } = generateLicenseKeyPair();
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  if (githubEnv) {
    if (!process.env.GITHUB_ENV) throw new Error('--github-env yalniz GitHub Actions icinde.');
    appendFileSync(
      process.env.GITHUB_ENV,
      `ADO_LICENSE_PUBLIC_KEY=${publicKeyB64}\nADO_LICENSE_PRIVATE_KEY_FILE=${keyPath}\n`,
    );
  }
  console.log(`Ozel anahtar: ${keyPath}`);
  console.log(`Acik anahtar (base64 SPKI): ${publicKeyB64}`);
}

function signCommand(values) {
  if (!values.key) throw new Error('--key <ozel.pem> gerekli.');
  const payload = buildPayload({
    id: values.id,
    customer: values.customer,
    exp: values.exp,
    plan: values.plan,
    grace: values.grace === undefined ? undefined : Number(values.grace),
    features: parseFeatures(values.feature),
  });
  console.log(signLicense(payload, readFileSync(values.key, 'utf8')));
}

function verifyCommand(values) {
  if (!values.pub || !values.license) throw new Error('--pub ve --license gerekli.');
  const payload = verifyLicense(values.license, values.pub);
  if (!payload) {
    console.error('Gecersiz lisans (imza ya da bicim hatali).');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      'github-env': { type: 'boolean' },
      key: { type: 'string' },
      id: { type: 'string' },
      customer: { type: 'string' },
      exp: { type: 'string' },
      plan: { type: 'string' },
      grace: { type: 'string' },
      feature: { type: 'string', multiple: true },
      pub: { type: 'string' },
      license: { type: 'string' },
    },
  });
  if (command === 'gen-key') return genKey(values);
  if (command === 'sign') return signCommand(values);
  if (command === 'verify') return verifyCommand(values);
  if (command === 'public-key') {
    if (!values.key) throw new Error('--key <ozel.pem> gerekli.');
    return console.log(publicKeyFromPrivate(readFileSync(values.key, 'utf8')));
  }
  throw new Error('Komut: gen-key | sign | verify | public-key (ayrinti: dosya basi).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
