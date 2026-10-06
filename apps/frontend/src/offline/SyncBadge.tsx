import { useSyncExternalStore } from 'react';
import { subscribe, getState, type SyncMode } from './engine';

// Her zaman gorunur baglanti durumu. OFFLINE_DESIGN.md §11, SYSTEM_ANALYSIS.md §12
export function useSyncState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

const LABEL: Record<SyncMode, { text: string; cls: string }> = {
  online: { text: 'Çevrimiçi', cls: 'bg-green-100 text-green-700' },
  offline: { text: 'Çevrimdışı', cls: 'bg-red-100 text-red-700' },
  syncing: { text: 'Senkronlanıyor', cls: 'bg-amber-100 text-amber-700' },
  degraded: { text: 'Owner onayı bekliyor', cls: 'bg-orange-100 text-orange-700' },
};

// Ayni ekranda ikinci rozet (telefon basligi) ayri test kimligi alir: e2e seciciler tek ogeye cozulsun.
export default function SyncBadge({ testId = 'sync-badge' }: { testId?: string }) {
  const { mode, pending } = useSyncState();
  const l = LABEL[mode];
  return (
    <span
      data-testid={testId}
      data-mode={mode}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${l.cls}`}
      title="Bağlantı durumu"
    >
      <span className="h-2 w-2 rounded-full bg-current" />
      {l.text}
      {pending > 0 && <span className="ml-1 rounded-full bg-white/70 px-1">{pending}</span>}
    </span>
  );
}
