// Otomatik guncelleme (CONVENTIONS F1/F2, L143; UPDATE_SYSTEM.md). Denetim ve indirme kendiliginden,
// kurulum yalniz yonetici onayiyla (backend /updates/approve -> IPC `update-install`).
// Akis: imzali bildirim (ado-update.json) dogrulanir -> electron-updater latest.yml'i okur, dosya
// ozeti imzali ozetle eslesmeli -> indirilir -> indirilen dosyanin SHA-512'si yeniden hesaplanir ve
// imzali ozetle eslesirse "hazir". Kurulumdan hemen once ozet bir kez daha denetlenir.
// electron-updater'in autoUpdater'i disaridan verilir (main.mjs); selfcheck sahtesiyle dener.
// Kurulum baslamazsa (yukleyici yok/calistirilamadi, program kapanmadi) durum "error" olur ve
// onInstallFailed cagrilir: kabuk backend'i yeniden baslatip pencereyi geri getirir (PLT-6).
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareVersions,
  sha512File,
  UPDATE_MANIFEST_FILE,
  updateFeedUrl,
  verifyUpdateManifest,
} from './update-manifest.mjs';

/** Ilk denetim acilistan 2 dk sonra (acilis yukunu artirmasin), sonra 6 saatte bir. */
export const FIRST_CHECK_MS = 2 * 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** quitAndInstall'dan sonra program bu surede kapanmaya baslamazsa kurulum basarisiz sayilir. */
export const INSTALL_QUIT_TIMEOUT_MS = 30_000;
/**
 * Kurulum icin kapanis bu kadar bekletilir (main.mjs before-quit): yukleyici baslatilamazsa
 * electron-updater hatayi bu surede bildirir ve program kapanmadan geri acilir.
 */
export const INSTALL_ERROR_GRACE_MS = 3_000;
export const INSTALL_FAILED_MESSAGE =
  'Güncelleme kurulamadı; program eski sürümle çalışmaya devam ediyor. Daha sonra yeniden deneyin.';

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Guncelleyici. Profilde bulut adresi ya da guncelleme anahtari yoksa `disabled` kalir.
 * onStatus her durum degisikliginde cagrilir (backend'e iletilir).
 */
export function createUpdater({
  currentVersion,
  config,
  log,
  onStatus,
  autoUpdater,
  onInstallFailed = () => {},
  installTimeoutMs = INSTALL_QUIT_TIMEOUT_MS,
}) {
  const feed = updateFeedUrl(config.cloudUrl, config.channel);
  let status = {
    state: feed && config.updatePublicKeys.length > 0 ? 'idle' : 'disabled',
    channel: config.channel,
    currentVersion,
    version: null,
    notes: null,
    progress: null,
    error: null,
    checkedAt: null,
  };
  let ready = null; // { manifest, file }
  let checking = false;
  let timers = [];
  let installTimer = null;
  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  if (status.state !== 'disabled') {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    // Parca parca (blockmap) indirme yerine tam dosya: sunucu tek aralik destekler, ozet tek dosyada.
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = {
      info: (text) => log(`[guncelleme] ${text}`),
      warn: (text) => log(`[guncelleme] ${text}`),
      error: (text) => log(`[guncelleme] HATA ${text}`),
      debug: () => {},
    };
    autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
    autoUpdater.on('download-progress', (progress) => {
      set({ state: 'downloading', progress: Math.min(99, Math.round(progress.percent)) });
    });
    // Denetim/indirme hatalari zaten yakalaniyor (await); kurulum hatasi yalniz bu olayla gelir
    // (yukleyici yolu yok, calistirilamadi). Eskiden dinlenmiyordu: program kapali kaliyordu.
    autoUpdater.on('error', (error) => {
      if (status.state === 'installing') failInstall(message(error));
    });
  }

  function failInstall(reason) {
    if (status.state !== 'installing') return;
    clearTimeout(installTimer);
    installTimer = null;
    ready = null; // sonraki denetim dosyayi yeniden indirir
    log(`[guncelleme] kurulum basarisiz: ${reason}`);
    set({ state: 'error', error: INSTALL_FAILED_MESSAGE, progress: null });
    onInstallFailed(reason);
  }

  // Backend'i durdurmadan once: dosya yerinde, boyutu imzali bilgiyle ayni ve electron-updater
  // ayni dosyayi kuracak (yolu kaybolmussa quitAndInstall hicbir sey yapmadan doner).
  function verifyInstaller() {
    if (!existsSync(ready.file))
      throw new Error('Kurulum dosyası bulunamadı; yeniden indirilecek.');
    if (statSync(ready.file).size !== ready.manifest.size) {
      throw new Error('Kurulum dosyası eksik ya da değişmiş; yeniden indirilecek.');
    }
    const installerPath = autoUpdater.installerPath;
    if (
      installerPath !== undefined &&
      (!installerPath || resolve(installerPath) !== resolve(ready.file))
    ) {
      throw new Error('Kurulum dosyası hazır değil; yeniden indirilecek.');
    }
  }

  async function check() {
    if (status.state === 'disabled' || checking) return status;
    if (status.state === 'ready' || status.state === 'installing') return status;
    checking = true;
    set({ state: 'checking', error: null });
    try {
      const response = await fetch(`${feed}/${UPDATE_MANIFEST_FILE}`, { cache: 'no-store' });
      const checkedAt = new Date().toISOString();
      if (response.status === 404) {
        set({ state: 'idle', version: null, notes: null, progress: null, checkedAt });
        return status;
      }
      if (!response.ok) throw new Error(`Güncelleme bilgisi alınamadı (HTTP ${response.status}).`);
      const manifest = verifyUpdateManifest(await response.text(), config.updatePublicKeys);
      if (!manifest) throw new Error('Güncelleme bilgisinin imzası geçersiz.');
      if (manifest.channel !== config.channel) throw new Error('Güncelleme başka bir kanal için.');
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        set({ state: 'idle', version: null, notes: null, progress: null, checkedAt });
        return status;
      }
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      const file = info?.files?.find((entry) => entry.url === manifest.file);
      if (!info || info.version !== manifest.version || file?.sha512 !== manifest.sha512) {
        throw new Error('Sunucudaki dosya bilgisi imzalı bilgiyle eşleşmiyor.');
      }
      set({ state: 'downloading', version: manifest.version, notes: manifest.notes, progress: 0 });
      const [downloaded] = await autoUpdater.downloadUpdate();
      if (!downloaded || (await sha512File(downloaded)) !== manifest.sha512) {
        throw new Error('İndirilen dosya imzalı özetle eşleşmiyor.');
      }
      ready = { manifest, file: downloaded };
      set({ state: 'ready', progress: 100, checkedAt: new Date().toISOString() });
    } catch (error) {
      ready = null;
      set({ state: 'error', error: message(error), checkedAt: new Date().toISOString() });
      log(`[guncelleme] denetim basarisiz: ${message(error)}`);
    } finally {
      checking = false;
    }
    return status;
  }

  /**
   * Onaylanan surumu kurar: dosya yeniden dogrulanir, `beforeQuit` (kuruluyor sayfasi + backend'in
   * duzgun kapanisi) beklenir, sonra sessiz kurulum ve programin yeniden acilmasi.
   */
  async function install(version, beforeQuit) {
    if (status.state !== 'ready' || !ready || ready.manifest.version !== version) return false;
    try {
      verifyInstaller();
      if ((await sha512File(ready.file)) !== ready.manifest.sha512) {
        throw new Error('İndirilen dosya değişmiş; yeniden indirilecek.');
      }
    } catch (error) {
      ready = null;
      set({ state: 'error', error: message(error) });
      return false;
    }
    set({ state: 'installing' });
    await beforeQuit();
    if (status.state !== 'installing') return false;
    // Program kapanmaya baslamazsa (quitting cagrilmazsa) kurulum basarisiz sayilir.
    installTimer = setTimeout(
      () => failInstall('program kurulum icin kapanmadi'),
      installTimeoutMs,
    );
    installTimer.unref?.();
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      failInstall(message(error));
    }
    return status.state === 'installing';
  }

  /** Program kurulum icin gercekten kapaniyor (before-quit): zaman asimi beklenmez. */
  function quitting() {
    clearTimeout(installTimer);
    installTimer = null;
  }

  function start() {
    if (status.state === 'disabled') return;
    timers.push(setTimeout(() => void check(), FIRST_CHECK_MS));
    timers.push(setInterval(() => void check(), CHECK_INTERVAL_MS));
  }

  function stop() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  return {
    status: () => status,
    installing: () => status.state === 'installing',
    check,
    install,
    quitting,
    start,
    stop,
  };
}
