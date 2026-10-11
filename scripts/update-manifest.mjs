#!/usr/bin/env node
// Guncelleme imza araci: Ed25519 anahtar cifti uretir, kurulum dosyasi icin imzali `ado-update.json`
// yazar, dogrular. Bagimliliksizdir (yalniz node:*). Dogrulama programla ayni kodu kullanir
// (apps/desktop/update-manifest.mjs). Lisans anahtarindan AYRI bir anahtardir. Bicim: UPDATE_SYSTEM.md.
//
//   node scripts/update-manifest.mjs gen-key --out <repo DISINDA klasor> [--github-env]
//   node scripts/update-manifest.mjs sign --key <ozel.pem> --installer <Setup.exe> \
//        --version 0.3.1 --channel stable [--notes "..."] [--out ado-update.json]
//   node scripts/update-manifest.mjs verify --pub <base64 SPKI> --manifest <ado-update.json> \
//        [--installer <Setup.exe>]
//
// OZEL ANAHTAR ASLA REPOYA GIRMEZ: gen-key repo icindeki bir klasore yazmayi reddeder. CI'da
// GitHub Environment secret'tan gecici dosyaya yazilir (release.yml).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isInsideRepo } from './license.mjs';
import {
  parseVersion,
  sha512File,
  UPDATE_CHANNELS,
  UPDATE_MANIFEST_FILE,
  UPDATE_MANIFEST_FORMAT,
  verifyUpdateManifest,
} from '../apps/desktop/update-manifest.mjs';

export const UPDATE_KEY_FILE = 'ado-update-private.pem';

export function generateUpdateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/** Kurulum dosyasindan imzalanacak icerik (ozet ve boyut dosyadan hesaplanir). */
export async function buildManifestPayload({ installer, version, channel, notes, releaseDate }) {
  if (!parseVersion(version)) throw new Error(`Surum X.Y.Z biciminde olmali: ${version}`);
  if (!UPDATE_CHANNELS.includes(channel)) {
    throw new Error(`Kanal ${UPDATE_CHANNELS.join('|')} olmali: ${channel}`);
  }
  if (!installer || !existsSync(installer)) throw new Error(`Kurulum dosyasi yok: ${installer}`);
  const payload = {
    version,
    channel,
    file: basename(installer),
    sha512: await sha512File(installer),
    size: statSync(installer).size,
    releaseDate: releaseDate ?? new Date().toISOString(),
  };
  if (notes) payload.notes = String(notes).slice(0, 2000);
  return payload;
}

/** `ado-update.json` icerigi: imza payload'in ham baytlari uzerindedir. */
export function signManifest(payload, privateKeyPem) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, raw, createPrivateKey(privateKeyPem));
  return `${JSON.stringify(
    {
      format: UPDATE_MANIFEST_FORMAT,
      payload: raw.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    null,
    2,
  )}\n`;
}

function genKey({ out, force, 'github-env': githubEnv }) {
  if (!out) throw new Error('--out <klasor> gerekli.');
  if (isInsideRepo(out)) throw new Error('Ozel anahtar repo klasorunun icine yazilamaz.');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const keyPath = join(resolve(out), UPDATE_KEY_FILE);
  if (existsSync(keyPath) && !force) {
    throw new Error(`${keyPath} zaten var (uzerine yazmak icin --force).`);
  }
  const { privateKeyPem, publicKeyB64 } = generateUpdateKeyPair();
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  if (githubEnv) {
    if (!process.env.GITHUB_ENV) throw new Error('--github-env yalniz GitHub Actions icinde.');
    appendFileSync(
      process.env.GITHUB_ENV,
      `ADO_UPDATE_PUBLIC_KEY=${publicKeyB64}\nADO_UPDATE_PRIVATE_KEY_FILE=${keyPath}\n`,
    );
  }
  console.log(`Ozel anahtar: ${keyPath}`);
  console.log(`Acik anahtar (base64 SPKI): ${publicKeyB64}`);
}

async function signCommand(values) {
  if (!values.key) throw new Error('--key <ozel.pem> gerekli.');
  const payload = await buildManifestPayload({
    installer: values.installer,
    version: values.version,
    channel: values.channel ?? 'stable',
    notes: values.notes,
  });
  const out = values.out ?? UPDATE_MANIFEST_FILE;
  writeFileSync(out, signManifest(payload, readFileSync(values.key, 'utf8')));
  console.log(`${out}: ${payload.file} ${payload.version} (${payload.channel})`);
}

async function verifyCommand(values) {
  if (!values.pub || !values.manifest) throw new Error('--pub ve --manifest gerekli.');
  const payload = verifyUpdateManifest(readFileSync(values.manifest, 'utf8'), [values.pub]);
  if (!payload) {
    console.error('Gecersiz bildirim (imza ya da bicim hatali).');
    process.exitCode = 1;
    return;
  }
  if (values.installer && (await sha512File(values.installer)) !== payload.sha512) {
    console.error('Kurulum dosyasi bildirimdeki ozetle eslesmiyor.');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      'github-env': { type: 'boolean' },
      key: { type: 'string' },
      installer: { type: 'string' },
      version: { type: 'string' },
      channel: { type: 'string' },
      notes: { type: 'string' },
      pub: { type: 'string' },
      manifest: { type: 'string' },
    },
  });
  if (command === 'gen-key') return genKey(values);
  if (command === 'sign') return signCommand(values);
  if (command === 'verify') return verifyCommand(values);
  throw new Error('Komut: gen-key | sign | verify (ayrinti: dosya basi).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
