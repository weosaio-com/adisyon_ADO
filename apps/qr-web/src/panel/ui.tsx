import { useEffect, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { MenuImageError } from '../lib/image';

export const INPUT =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-stone-400';
export const BUTTON_PRIMARY =
  'rounded-xl bg-ink-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40';
export const BUTTON_SECONDARY =
  'rounded-xl bg-stone-200 px-4 py-2 text-sm font-bold text-ink-800 disabled:opacity-40';

export function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof MenuImageError
    ? error.message
    : 'İşlem başarısız.';
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-stone-500">{label}</span>
      {children}
    </label>
  );
}

export function Card({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <section
      className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-200/70"
      data-testid={testId}
    >
      {children}
    </section>
  );
}

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[94vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-ink-900">{title}</h2>
          <button onClick={onClose} className={BUTTON_SECONDARY}>
            Kapat
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Chip({
  on,
  onClick,
  children,
  testId,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      disabled={disabled}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition disabled:opacity-60 ${
        on ? 'bg-ink-900 text-white' : 'bg-stone-100 text-stone-700'
      }`}
    >
      {children}
    </button>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  const style =
    tone === 'error'
      ? 'bg-red-50 text-red-800'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-900'
        : 'bg-brand-50 text-brand-700';
  return <p className={`rounded-xl px-3 py-2 text-sm ${style}`}>{children}</p>;
}

export function when(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}
