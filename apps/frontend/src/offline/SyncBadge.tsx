import { useState, useSyncExternalStore } from 'react';
import { subscribe, getState } from './engine';
import { badgeView } from './sync-view';
import SyncPanel from './SyncPanel';

// Her zaman gorunur baglanti durumu. OFFLINE_DESIGN.md §11, SYSTEM_ANALYSIS.md §12
export function useSyncState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// Ayni ekranda ikinci rozet (telefon basligi) ayri test kimligi alir: e2e seciciler tek ogeye cozulsun.
// Dokununca gonderim ayrintisi ve senkron sorunlari acilir.
export default function SyncBadge({ testId = 'sync-badge' }: { testId?: string }) {
  const sync = useSyncState();
  const [open, setOpen] = useState(false);
  const view = badgeView(sync);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-mode={view.mode}
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-medium ${view.cls}`}
        title="Bağlantı durumu — ayrıntı için dokunun"
      >
        <span className="h-2 w-2 rounded-full bg-current" />
        {view.text}
        {sync.pending > 0 && (
          <span className="ml-1 rounded-full bg-white/70 px-1" aria-label="bekleyen işlem">
            {sync.pending}
          </span>
        )}
        {sync.problems > 0 && view.mode !== 'degraded' && (
          <span className="ml-1 rounded-full bg-orange-500 px-1 text-white" aria-label="sorun">
            !
          </span>
        )}
      </button>
      {open && <SyncPanel onClose={() => setOpen(false)} />}
    </>
  );
}
