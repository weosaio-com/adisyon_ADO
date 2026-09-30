import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { BUTTON_PRIMARY, Card, errorText, Field, INPUT, Notice } from './ui';

const MIN_PASSWORD = 10;

// Parola degisince diger cihazlardaki oturumlar kapanir; bu oturum acik kalir.
export function AccountTab() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const change = useMutation({
    mutationFn: () =>
      api('/api/panel/password', { json: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
    },
  });
  const tooShort = next !== '' && next.length < MIN_PASSWORD;
  const mismatch = repeat !== '' && next !== repeat;
  const ready = current !== '' && next.length >= MIN_PASSWORD && next === repeat;

  return (
    <div className="max-w-md">
      <Card>
        <h2 className="mb-3 font-black text-ink-900">Parola değiştir</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) change.mutate();
          }}
          className="space-y-3"
        >
          <Field label="Mevcut parola">
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              maxLength={128}
              className={INPUT}
            />
          </Field>
          <Field label={`Yeni parola (en az ${MIN_PASSWORD} karakter)`}>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              maxLength={128}
              className={INPUT}
            />
          </Field>
          <Field label="Yeni parola (tekrar)">
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              maxLength={128}
              className={INPUT}
            />
          </Field>
          {tooShort && (
            <p className="text-xs text-amber-800">Parola en az {MIN_PASSWORD} karakter olmalı.</p>
          )}
          {mismatch && <p className="text-xs text-amber-800">Yeni parolalar aynı değil.</p>}
          {change.isError && <Notice tone="error">{errorText(change.error)}</Notice>}
          {change.isSuccess && (
            <Notice tone="info">Parolanız değişti. Diğer cihazlardaki oturumlar kapatıldı.</Notice>
          )}
          <button
            type="submit"
            disabled={!ready || change.isPending}
            className={`${BUTTON_PRIMARY} w-full py-2.5`}
          >
            {change.isPending ? 'Değiştiriliyor…' : 'Parolayı değiştir'}
          </button>
        </form>
      </Card>
    </div>
  );
}
