import { useEffect, useReducer, useState } from 'react';

// "Uygulamayi yukle": tablet, telefon ya da ikinci bilgisayarda adisyon uygulama gibi acilir (PWA;
// ana ekranda simge, tam ekran, baglanti koptugunda da acilir). Chrome/Edge istemi; iPhone/iPad'de
// Safari yonergesi. Ana bilgisayardaki masaustu programinda (Electron) gorunmez.
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Istem, dugme ekrana gelmeden once tetiklenebilir: modul (giris ekraniyla) yuklenir yuklenmez yakalanir.
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
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => setHelp(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ana ekrana ekle"
            className="w-full max-w-sm rounded-3xl bg-white p-5 text-left"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-3 text-lg font-black text-ink-900">Ana ekrana ekle</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-stone-700">
              <li>
                Safari'de <strong>Paylaş</strong> düğmesine dokunun (yukarı oklu kare).
              </li>
              <li>
                <strong>Ana Ekrana Ekle</strong>'yi seçin, sonra <strong>Ekle</strong>'ye dokunun.
              </li>
              <li>Adisyon ana ekranda uygulama olarak açılır; bağlantı koptuğunda da çalışır.</li>
            </ol>
            <button
              type="button"
              onClick={() => setHelp(false)}
              className="mt-4 min-h-11 w-full rounded-xl bg-stone-100 font-bold text-stone-700"
            >
              Tamam
            </button>
          </div>
        </div>
      )}
    </>
  );
}
