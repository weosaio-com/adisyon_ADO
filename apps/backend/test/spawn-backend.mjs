// "Spawned" e2e yardimcisi: backend'i masaustu kabugu gibi (IPC kanaliyla, ts-node) kendi
// veritabani, veri dizini ve portuyla baslatir. Her test dosyasi kendi portunu kullanir
// (updates 3021, bulut yedegi 3031, lisans 3041, temel 3051); boylece birbirine dokunmazlar.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const backendDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(backendDir, '..', '..');
const tsNode = createRequire(join(backendDir, 'package.json')).resolve('ts-node/dist/bin.js');

/**
 * Temiz bir backend ortami hazirlar (migrate + seed) ve onu yoneten yardimcilari dondurur.
 * `env` ortami ezer (or. CLOUD_API_URL, ADO_LICENSE_ENFORCE); `start(extra)` acilista ek ortam alir.
 */
export function prepareBackend({ name, port: basePort, env = {} }) {
  // Ayni makinede birden cok e2e kosusu (paralel dallar) icin portlar kaydirilabilir.
  const port = basePort + portOffset();
  const dataDir = mkdtempSync(join(tmpdir(), `ado-${name}-e2e-`));
  const baseEnv = {
    ...process.env,
    DATABASE_URL: `file:${join(dataDir, `${name}.db`)}`,
    ADO_DATA_DIR: dataDir,
    API_PORT: String(port),
    API_TLS_PORT: '',
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || `${name}-e2e-access-secret-0123456789`,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || `${name}-e2e-refresh-secret-0123456789`,
    BACKUP_ENCRYPTION_KEY:
      process.env.BACKUP_ENCRYPTION_KEY || `${name}-e2e-backup-key-0123456789abcdef`,
    SEED_OWNER_USERNAME: 'owner',
    SEED_OWNER_PASSWORD: 'owner1234',
    LOG_LEVEL: 'warn',
    ...env,
  };
  const pnpm = (...args) =>
    execFileSync('pnpm', args, {
      cwd: repoRoot,
      env: baseEnv,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  pnpm('exec', 'prisma', 'migrate', 'deploy');
  pnpm('--filter', '@ado/backend', 'run', 'seed');

  const base = `http://127.0.0.1:${port}/api/v1`;
  let token = '';

  return {
    dataDir,
    env: baseEnv,
    base,
    /** Kabuk mesajlari (IPC) buraya duser. */
    messages: [],

    /** Backend'i baslatir ve /health yanit verene kadar bekler (en cok 60 sn). */
    async start(extraEnv = {}) {
      const child = spawn(process.execPath, [tsNode, '--transpile-only', 'src/main.ts'], {
        cwd: backendDir,
        env: { ...baseEnv, ...extraEnv },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      child.on('message', (message) => this.messages.push(message));
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error(`backend kapandi (kod ${child.exitCode})`);
        const up = await fetch(`${base}/health`)
          .then((res) => res.ok)
          .catch(() => false);
        if (up) return child;
        await new Promise((r) => setTimeout(r, 500));
      }
      child.kill();
      throw new Error('backend acilmadi');
    },

    /** Kabuk gibi `shutdown` yollar; 15 sn'de kapanmazsa oldurur. */
    async stop(child) {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.send({ type: 'shutdown' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await exited;
      clearTimeout(timer);
    },

    async login(username = 'owner', password = 'owner1234') {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).then((r) => r.json());
      token = res.data?.accessToken ?? '';
      if (!token) throw new Error(`giris yapilamadi: ${JSON.stringify(res)}`);
      return token;
    },

    /** JSON istek; `{status, data}` doner (data: zarfin icindeki veri ya da hata govdesi). */
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, data: json.data ?? json };
    },
  };
}

/** E2E_PORT_OFFSET: yerelde paralel kosularda tum test portlarina eklenir (CI'da bos = 0). */
export function portOffset() {
  return Number(process.env.E2E_PORT_OFFSET || 0);
}

/** Basit kontrol listesi: basarisizlikta surec 1 ile biter (CI kirmizi). */
export function checklist(title) {
  const failed = [];
  console.log(title);
  return {
    check(cond, label) {
      console.log(`  ${cond ? '✓' : '✗'} ${label}`);
      if (!cond) failed.push(label);
    },
    done() {
      if (failed.length) {
        console.error(`✗ ${failed.length} kontrol basarisiz`);
        process.exitCode = 1;
      }
    },
  };
}
