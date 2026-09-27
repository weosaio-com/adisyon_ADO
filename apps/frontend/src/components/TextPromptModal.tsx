import { useState } from 'react';

// window.prompt yerine: Electron (kasa uygulamasi) prompt()'u desteklemez, cagri hata firlatir.
export default function TextPromptModal({
  title,
  description,
  label,
  initialValue = '',
  placeholder,
  suggestions = [],
  secret = false,
  numeric = false,
  minLength = 1,
  maxLength = 200,
  confirmLabel = 'Kaydet',
  danger = false,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  suggestions?: string[];
  secret?: boolean;
  numeric?: boolean;
  minLength?: number; // 0 -> bos deger kabul (ör. notu silmek)
  maxLength?: number;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const valid = trimmed.length >= minLength && trimmed.length <= maxLength;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-ink-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onConfirm(trimmed);
        }}
        className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl"
      >
        <h2 className="text-lg font-black text-ink-900">{title}</h2>
        {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setValue(suggestion)}
                className={`min-h-9 rounded-xl px-3 text-sm font-semibold ${
                  trimmed === suggestion ? 'bg-ink-900 text-white' : 'bg-stone-100 text-stone-700'
                }`}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <label className="mt-3 block text-sm font-semibold text-stone-600">
          {label}
          <input
            autoFocus
            type={secret ? 'password' : 'text'}
            inputMode={numeric ? 'numeric' : 'text'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-3 text-base font-normal text-ink-900"
          />
        </label>
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 rounded-2xl border border-stone-200 text-sm font-bold text-stone-600"
          >
            Vazgeç
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className={`min-h-12 rounded-2xl text-sm font-black text-white disabled:opacity-40 ${
              danger ? 'bg-red-600' : 'bg-ink-900'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
