import { useSyncExternalStore } from 'react';
import { applyUpdate, isUpdateReady, subscribeUpdate } from './sw-update';

// Yeni surum hazir ama simdi yenilemek guvenli degil (bekleyen gonderim / acik is): garson
// isterse hemen yeniler; aksi halde guvenli anda kendiliginden yenilenir. OFF-7
export default function UpdateBanner() {
  const ready = useSyncExternalStore(subscribeUpdate, isUpdateReady, isUpdateReady);
  if (!ready) return null;
  return (
    <div
      role="status"
      data-testid="update-banner"
      className="fixed inset-x-0 bottom-0 z-[70] flex flex-wrap items-center justify-between gap-3 bg-ink-900 px-4 py-3 text-white shadow-lg print:hidden"
    >
      <p className="text-sm">
        <b>Yeni sürüm hazır.</b> Bekleyen iş bitince kendiliğinden yenilenir.
      </p>
      <button
        onClick={applyUpdate}
        className="min-h-11 rounded-xl bg-white px-4 text-sm font-black text-ink-900"
      >
        Şimdi yenile
      </button>
    </div>
  );
}
