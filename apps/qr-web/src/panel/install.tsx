import { useEffect, useReducer, useState } from 'react';
import { Dialog } from './ui';

// "Uygulamayi yukle": Chrome/Edge (Windows, Mac, Android) istemi; iPhone/iPad'de Safari yonergesi.
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Istem, dugme ekrana gelmeden once tetiklenebilir: modul yuklenir yuklenmez yakalanir.
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferred = event as InstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  // iPadOS kendini masaustu Safari olarak tanitir; dokunmatik Mac yoktur.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

export function useInstallPrompt() {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);
  const standalone = isStandalone();
  const ios = !standalone && deferred === null && isIos();
  return {
    /** Bu cihazda yukleme sunulabilir (yuklu degil ve tarayici destekliyor). */
    available: !standalone && (deferred !== null || ios),
    ios,
    install: async () => {
      const event = deferred;
      if (!event) return;
      deferred = null;
      notify();
      await event.prompt();
      await event.userChoice.catch(() => undefined);
    },
  };
}

export function InstallButton({
  className,
  label = 'Uygulamayı yükle',
}: {
  className: string;
  label?: string;
}) {
  const prompt = useInstallPrompt();
  const [help, setHelp] = useState(false);
  if (!prompt.available) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => (prompt.ios ? setHelp(true) : void prompt.install())}
        className={className}
        data-testid="install-app"
      >
        {label}
      </button>
      {help && (
        <Dialog title="Ana ekrana ekle" onClose={() => setHelp(false)}>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-800">
            <li>
              Safari'de <strong>Paylaş</strong> düğmesine dokunun (yukarı oklu kare).
            </li>
            <li>
              <strong>Ana Ekrana Ekle</strong>'yi seçin, sonra <strong>Ekle</strong>'ye dokunun.
            </li>
            <li>Panel ana ekranda uygulama olarak açılır; internet yokken de çalışır.</li>
          </ol>
        </Dialog>
      )}
    </>
  );
}
