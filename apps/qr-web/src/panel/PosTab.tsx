import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useOnline } from '../lib/connectivity';
import { useMenuDraft } from './menu-draft';
import { meQuery, menuKey, tablesQuery } from './queries';
import type { BranchSummary } from './types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Card, errorText, Notice, when } from './ui';

interface PairingCode {
  code: string;
  expiresAt: string;
  /** Kod alindiginda bilinen eslesme zamani; degisirse bu kodla baglanilmistir. */
  pairedAtBefore: string | null;
}

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Adisyon programi (POS) baglantisi: eslestirme kodu, durum ve baglantiyi kaldirma.
export function PosTab({ branch }: { branch: BranchSummary }) {
  const qc = useQueryClient();
  const online = useOnline();
  const draft = useMenuDraft();
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [paired, setPaired] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const active = pairing !== null && Date.parse(pairing.expiresAt) > now;
  const pairedAt = branch.pos?.pairedAt ?? null;

  // Kod gecerliyken sube durumu sik yenilenir: POS baglaninca ekran kendiliginden guncellenir.
  useQuery({ ...meQuery, refetchInterval: active ? 4000 : false });

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const refreshBranch = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: meQuery.queryKey }),
      qc.invalidateQueries({ queryKey: menuKey(branch.id) }),
      qc.invalidateQueries({ queryKey: tablesQuery(branch.id).queryKey }),
    ]);

  // Bu kodla baglanildi: menu ve masalar artik POS'tan gelir, paneldeki taslak gecersiz.
  useEffect(() => {
    if (!pairing || pairedAt === null || pairedAt === pairing.pairedAtBefore) return;
    setPairing(null);
    setPaired(true);
    draft.discard();
    void refreshBranch();
  }, [pairedAt, pairing]);

  const create = useMutation({
    mutationFn: () =>
      api<{ code: string; expiresAt: string }>(`/api/panel/branches/${branch.id}/pairing-code`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      setPaired(false);
      setNow(Date.now());
      setPairing({ ...result, pairedAtBefore: pairedAt });
    },
  });
  const unpair = useMutation({
    mutationFn: () => api(`/api/panel/branches/${branch.id}/pos`, { method: 'DELETE' }),
    onSuccess: () => {
      setPaired(false);
      void refreshBranch();
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      {!online && (
        <Notice tone="warn">
          İnternet yok. Eşleştirme kodu almak ve bağlantıyı kaldırmak için internet gerekir.
        </Notice>
      )}
      {paired && (
        <Notice tone="info">
          Adisyon programı bağlandı. Menü ve masalar birkaç saniye içinde programdan yayınlanır.
        </Notice>
      )}
      <Card testId="pos-status">
        <h2 className="mb-1 font-black text-ink-900">Adisyon programı bağlantısı</h2>
        {branch.source === 'pos' && branch.pos ? (
          <>
            <p className="text-sm text-stone-600">
              Bu şube adisyon programına bağlı. Menü, “tükendi” bilgisi ve masalar programdan
              kendiliğinden yayınlanır.
            </p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-stone-500">Bağlandı</dt>
              <dd className="text-ink-900">{when(branch.pos.pairedAt)}</dd>
              <dt className="text-stone-500">Son görülme</dt>
              <dd className="text-ink-900" data-testid="pos-last-seen">
                {when(branch.pos.lastSeenAt)}
              </dd>
              <dt className="text-stone-500">Son yayın</dt>
              <dd className="text-ink-900">
                {branch.menu
                  ? `Sürüm ${branch.menu.version} · ${when(branch.menu.updatedAt)}`
                  : '—'}
              </dd>
            </dl>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Adisyon programı bağlantısı kaldırılsın mı? Menü ve masalar bundan sonra bu panelden düzenlenir; programdaki değişiklikler yayınlanmaz.',
                  )
                ) {
                  unpair.mutate();
                }
              }}
              disabled={unpair.isPending || !online}
              className="mt-4 rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700 disabled:opacity-40"
            >
              Bağlantıyı kaldır
            </button>
            {unpair.isError && (
              <div className="mt-3">
                <Notice tone="error">{errorText(unpair.error)}</Notice>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-stone-600">
            Bu şubenin menüsü bu panelden yönetiliyor. Adisyon programı kullanıyorsanız bağlayın;
            menü, “tükendi” bilgisi ve masalar programdan kendiliğinden yayınlansın.
          </p>
        )}
      </Card>

      <Card testId="pos-pairing">
        <h2 className="mb-1 font-black text-ink-900">
          {branch.source === 'pos' ? 'Başka bir bilgisayarı bağla' : 'Programı bağla'}
        </h2>
        <p className="text-sm text-stone-600">
          Eşleştirme kodu 15 dakika geçerlidir ve bir kez kullanılır.
          {branch.source === 'pos' && ' Yeni bilgisayar bağlanınca eskisinin bağlantısı kesilir.'}
        </p>
        {active && pairing ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl bg-stone-100 p-4 text-center">
              <p className="text-xs font-semibold text-stone-500">Eşleştirme kodu</p>
              <p
                className="font-mono text-3xl font-black tracking-widest text-ink-900"
                data-testid="pairing-code"
              >
                {pairing.code}
              </p>
              <p className="mt-1 text-xs text-stone-500" data-testid="pairing-remaining">
                Kalan süre {remaining(pairing.expiresAt, now)}
              </p>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-800">
              <li>Adisyon programında Ayarlar › QR Menü (Bulut) kartını açın.</li>
              <li>
                Bulut adresine{' '}
                <span className="font-mono font-bold" data-testid="pairing-url">
                  {window.location.origin}
                </span>{' '}
                yazın.
              </li>
              <li>Eşleştirme kodunu girip “Bağlan”a basın.</li>
            </ol>
            <p className="text-xs text-stone-500">
              Bağlantı kurulunca bu ekran kendiliğinden güncellenir.
            </p>
          </div>
        ) : (
          <>
            {pairing && (
              <div className="mt-3">
                <Notice tone="warn">Kodun süresi doldu; yeni kod alın.</Notice>
              </div>
            )}
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !online}
              className={`${branch.source === 'pos' ? BUTTON_SECONDARY : BUTTON_PRIMARY} mt-4`}
              data-testid="pairing-create"
            >
              Eşleştirme kodu al
            </button>
          </>
        )}
        {create.isError && (
          <div className="mt-3">
            <Notice tone="error">{errorText(create.error)}</Notice>
          </div>
        )}
      </Card>
    </div>
  );
}
