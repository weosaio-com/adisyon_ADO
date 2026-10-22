// Kendini toparlama kurallari (saf, Electron'suz; selfcheck.recovery.mjs ile test edilir).
// Backend beklenmedik kapanirsa artan beklemeyle yeniden baslatilir; pencere sureci cokerse
// sayfa yeniden yuklenir. Ikisinde de kisa surede cok fazla deneme olursa durulur (dongu olmasin).

/** Ardisik yeniden baslatmalar arasindaki bekleme; sonrasi RESTART_STEADY_DELAY_MS. */
export const RESTART_DELAYS_MS = [1_000, 5_000, 15_000];
export const RESTART_STEADY_DELAY_MS = 60_000;
/** Bu pencerede RESTART_MAX_IN_WINDOW deneme olduysa vazgecilir, kullaniciya soylenir. */
export const RESTART_WINDOW_MS = 10 * 60_000;
export const RESTART_MAX_IN_WINDOW = 5;

/** Pencere yeniden yukleme siniri (cokme dongusune girmesin). */
export const RELOAD_WINDOW_MS = 5 * 60_000;
export const RELOAD_MAX_IN_WINDOW = 3;

/** Pencere bu kadar yanit vermezse kullaniciya "Yeniden yukle / Bekle" sorulur. */
export const UNRESPONSIVE_PROMPT_MS = 30_000;

/**
 * Sonraki yeniden baslatma: `history` onceki denemelerin zamanlari (ms). Pencere disina dusenler
 * atilir (`recent`); uzun sure sorunsuz calisan backend yeniden kisa beklemeyle baslar.
 */
export function planRestart(history, now = Date.now()) {
  const recent = history.filter((at) => now - at < RESTART_WINDOW_MS);
  if (recent.length >= RESTART_MAX_IN_WINDOW) return { giveUp: true, recent };
  return {
    giveUp: false,
    delayMs: RESTART_DELAYS_MS[recent.length] ?? RESTART_STEADY_DELAY_MS,
    recent,
  };
}

/** Pencere yeniden yuklenebilir mi (son RELOAD_WINDOW_MS icinde RELOAD_MAX_IN_WINDOW'dan az). */
export function allowReload(history, now = Date.now()) {
  const recent = history.filter((at) => now - at < RELOAD_WINDOW_MS);
  return { allowed: recent.length < RELOAD_MAX_IN_WINDOW, recent };
}

/** Yeniden baslatmadan vazgecilince gosterilecek pencere. */
export function restartGiveUpDialog(logPath) {
  return {
    title: 'Program arka planda kapanıyor',
    message:
      'Programın arka planda çalışan bölümü kısa sürede birkaç kez kapandı ve yeniden ' +
      'başlatılamadı. Programı kapatıp yeniden açın.\n\nSorun sürerse şu kayıt dosyasını ' +
      `destek ekibine gönderin:\n${logPath ?? '(bilinmiyor)'}`,
  };
}

/** Pencere uzun sure yanit vermeyince sorulacak secim. Ilk dugme yeniden yukler. */
export function unresponsiveDialog() {
  return {
    title: 'Program yanıt vermiyor',
    message:
      'Pencere 30 saniyedir yanıt vermiyor. Yeniden yüklemek kayıtlı adisyonları ve ödemeleri ' +
      'silmez; yalnız henüz kaydedilmemiş yazılar kaybolabilir.',
    buttons: ['Yeniden yükle', 'Bekle'],
  };
}

/** Guncelleme kurulamayinca (program eski surumle geri acildi) gosterilecek pencere. */
export function installFailedDialog(logPath) {
  return {
    title: 'Güncelleme kurulamadı',
    message:
      'Yeni sürüm kurulamadı; program eski sürümle çalışmaya devam ediyor. Kayıtlı adisyonlar ve ' +
      'ödemeler etkilenmedi.\n\nAyarlar > Güncelleme bölümünden daha sonra yeniden ' +
      'deneyebilirsiniz. Sorun sürerse şu kayıt dosyasını destek ekibine gönderin:\n' +
      `${logPath ?? '(bilinmiyor)'}`,
  };
}
