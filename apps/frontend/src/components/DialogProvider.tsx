import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

// Uygulama ici onay / bilgi pencereleri. Tarayicinin yerel pencereleri kullanilmaz: Electron'da
// (Windows) yerel pencere kapaninca metin kutulari klavye girdisi almaz (Electron #19977, #31917),
// kullanici bunu "program dondu" diye algilar. Ekranlar useDialogs() ile cagirir; DialogProvider
// uygulama kokunde (main.tsx) bir kez kurulur. Esc ve arka plana dokunmak vazgecer; odak pencereye
// girer, kapaninca onceki ogeye doner. Ekran degisince bekleyen pencereler vazgecilmis sayilir.

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Geri donusu olmayan islem: onay dugmesi kirmizi, odak "Vazgeç"te baslar. */
  danger?: boolean;
}

export interface NotifyOptions {
  title?: string;
  confirmLabel?: string;
}

export interface DialogApi {
  /** Onaylanirsa true, vazgecilirse (Esc, arka plan, "Vazgeç", ekran degisimi) false. */
  confirmDialog: (options: ConfirmOptions) => Promise<boolean>;
  /** Tek dugmeli bilgi penceresi; kapaninca cozulur. */
  notify: (message: string, options?: NotifyOptions) => Promise<void>;
}

interface PendingDialog {
  title: string;
  message?: string | undefined;
  confirmLabel: string;
  /** null: yalniz bilgi (tek dugme). */
  cancelLabel: string | null;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialogs(): DialogApi {
  const dialogs = useContext(DialogContext);
  if (!dialogs) throw new Error('useDialogs: DialogProvider kurulu degil');
  return dialogs;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const enqueue = useCallback(
    (dialog: Omit<PendingDialog, 'resolve'>) =>
      new Promise<boolean>((resolve) => setQueue((items) => [...items, { ...dialog, resolve }])),
    [],
  );
  const close = useCallback((dialog: PendingDialog, ok: boolean) => {
    dialog.resolve(ok);
    setQueue((items) => items.filter((item) => item !== dialog));
  }, []);

  const dialogs = useMemo<DialogApi>(
    () => ({
      confirmDialog: (options) =>
        enqueue({
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel ?? 'Onayla',
          cancelLabel: options.cancelLabel ?? 'Vazgeç',
          danger: options.danger ?? false,
        }),
      notify: async (message, options = {}) => {
        await enqueue({
          title: options.title ?? message,
          message: options.title ? message : undefined,
          confirmLabel: options.confirmLabel ?? 'Tamam',
          cancelLabel: null,
          danger: false,
        });
      },
    }),
    [enqueue],
  );

  // Ekran degisince (orn. oturum bitip giris ekranina gecilince) bekleyen pencereler kapanir.
  const { pathname } = useLocation();
  useEffect(() => {
    const pending = queueRef.current;
    if (pending.length === 0) return;
    for (const dialog of pending) dialog.resolve(false);
    setQueue([]);
  }, [pathname]);
  useEffect(() => () => queueRef.current.forEach((dialog) => dialog.resolve(false)), []);

  const current = queue[0];
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {current && <DialogView dialog={current} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogView({
  dialog,
  onClose,
}: {
  dialog: PendingDialog;
  onClose: (dialog: PendingDialog, ok: boolean) => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const pressedBackdrop = useRef(false);

  // Odak pencereye girer (tehlikeli islemde "Vazgeç"e); kapaninca onceki ogeye doner.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = dialog.danger ? cancelButton.current : null;
    (first ?? confirmButton.current)?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [dialog]);

  // Esc vazgecer; Tab pencerenin icinde doner. Belge seviyesinde dinlenir: odak pencere disina
  // kaysa da (orn. arka plana tiklaninca) calisir.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(dialog, false);
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const buttons = [...panel.current.querySelectorAll<HTMLButtonElement>('button')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.current.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [dialog, onClose]);

  return (
    // Arka plana dokunmak vazgecer. Kapanis "click"te: ayni dokunus alttaki ogeye gecmez; basili
    // tutulup pencereden disari surukleme de kapatmaz.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/40 p-4"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) {
          onClose(dialog, false);
        }
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={dialog.message ? messageId : undefined}
        tabIndex={-1}
        data-testid="confirm-dialog"
        className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl outline-none"
      >
        <h2 id={titleId} className="text-lg font-black text-ink-900">
          {dialog.title}
        </h2>
        {dialog.message && (
          <p id={messageId} className="mt-2 text-sm text-stone-600">
            {dialog.message}
          </p>
        )}
        <div className={`mt-5 grid gap-2 ${dialog.cancelLabel ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {dialog.cancelLabel && (
            <button
              ref={cancelButton}
              type="button"
              onClick={() => onClose(dialog, false)}
              data-testid="confirm-dialog-cancel"
              className="min-h-12 rounded-2xl border border-stone-200 text-sm font-bold text-stone-600"
            >
              {dialog.cancelLabel}
            </button>
          )}
          <button
            ref={confirmButton}
            type="button"
            onClick={() => onClose(dialog, true)}
            data-testid="confirm-dialog-confirm"
            className={`min-h-12 rounded-2xl text-sm font-black text-white ${
              dialog.danger ? 'bg-red-600' : 'bg-ink-900'
            }`}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
