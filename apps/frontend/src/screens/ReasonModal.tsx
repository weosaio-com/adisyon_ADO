import { useState } from 'react';
import { OTHER_REASON, REASON_MAX, reasonText } from './reason';

// Gerekce secici: buyuk dokunma hedefli hazir secenekler + "Diğer" (serbest metin).
// Hem gerekce penceresinde hem indirim penceresinde kullanilir.
export function ReasonPicker({
  reasons,
  choice,
  other,
  onChoice,
  onOther,
  label = 'Gerekçe',
}: {
  reasons: string[];
  choice: string | null;
  other: string;
  onChoice: (choice: string) => void;
  onOther: (text: string) => void;
  label?: string;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold text-stone-600">{label}</legend>
      <div className="grid grid-cols-2 gap-2" data-testid="reason-options">
        {[...reasons, OTHER_REASON].map((reason) => (
          <button
            key={reason}
            type="button"
            aria-pressed={choice === reason}
            onClick={() => onChoice(reason)}
            className={`min-h-12 rounded-2xl px-3 text-sm font-bold transition ${
              choice === reason
                ? 'bg-ink-900 text-white'
                : 'border border-stone-200 bg-stone-50 text-ink-800 hover:bg-stone-100'
            }`}
          >
            {reason}
          </button>
        ))}
      </div>
      {choice === OTHER_REASON && (
        <label className="mt-3 block text-sm font-semibold text-stone-600">
          Açıklama
          <input
            autoFocus
            data-testid="reason-other"
            value={other}
            onChange={(event) => onOther(event.target.value)}
            maxLength={REASON_MAX}
            placeholder="Kısaca nedenini yazın"
            className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 px-3 text-base font-normal text-ink-900"
          />
        </label>
      )}
    </fieldset>
  );
}

/**
 * Onay + gerekce penceresi (kalem iptali, adisyon / paket iptali). Gerekce secilmeden onay
 * dugmesi calismaz. Sunucu hatasi pencerede gosterilir; pencere kendiliginden kapanmaz.
 */
export default function ReasonModal({
  title,
  description,
  reasons,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  reasons: string[];
  confirmLabel: string;
  busy?: boolean;
  error?: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const reason = reasonText(choice, other);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="reason-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reason && !busy) onConfirm(reason);
        }}
        className="max-h-full w-full max-w-sm overflow-auto rounded-3xl bg-white p-5 shadow-xl"
      >
        <h2 className="text-lg font-black text-ink-900">{title}</h2>
        {description && <p className="mt-1 text-sm text-stone-600">{description}</p>}
        <div className="mt-4">
          <ReasonPicker
            reasons={reasons}
            choice={choice}
            other={other}
            onChoice={setChoice}
            onOther={setOther}
          />
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 rounded-2xl border border-stone-200 text-sm font-bold text-stone-600"
          >
            Vazgeç
          </button>
          <button
            type="submit"
            data-testid="reason-confirm"
            disabled={!reason || busy}
            className="min-h-12 rounded-2xl bg-red-600 text-sm font-black text-white disabled:opacity-40"
          >
            {busy ? 'İşleniyor…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
