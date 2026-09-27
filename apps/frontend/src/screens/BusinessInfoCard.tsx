import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface BusinessInfo {
  name: string;
  address: string | null;
  phone: string | null;
}

const INPUT = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

// Musteri fisi ve hesap fisinin basligi.
export default function BusinessInfoCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (message: string) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['settings', 'business'],
    queryFn: () => api<BusinessInfo>('/settings/business'),
  });
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    if (!q.data) return;
    setName(q.data.name);
    setAddress(q.data.address ?? '');
    setPhone(q.data.phone ?? '');
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      api('/settings/business', {
        method: 'PUT',
        body: { name: name.trim(), address: address.trim(), phone: phone.trim() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'business'] });
      onInfo('İşletme bilgileri kaydedildi; fişlerin başlığında görünecek.');
    },
    onError,
  });

  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="business-card">
      <h2 className="mb-1 font-bold text-slate-800">İşletme Bilgileri</h2>
      <p className="mb-3 text-xs text-slate-500">Müşteri fişinin ve hesabın en üstüne basılır.</p>
      <div className="space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="İşletme adı"
          maxLength={60}
          className={INPUT}
        />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Adres (isteğe bağlı)"
          maxLength={160}
          className={INPUT}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Telefon (isteğe bağlı)"
          maxLength={30}
          inputMode="tel"
          className={INPUT}
        />
        <button
          onClick={() => save.mutate()}
          disabled={!name.trim() || save.isPending}
          className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
        >
          Kaydet
        </button>
      </div>
    </div>
  );
}
