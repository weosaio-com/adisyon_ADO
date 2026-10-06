import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import { kvDelete, kvGet, kvSet } from './store';

// Panel sorgularinin (me, menu, masalar) son basarili hali cihazda saklanir: internet yokken panel
// bunlarla acilir, internet gelince sorgular kendiliginden tazelenir. Musteri sorgulari saklanmaz.
const KEY = 'query-cache';
const BUSTER = 1; // saklanan veri bicimi degisirse artirin
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Saved {
  buster: number;
  savedAt: number;
  state: DehydratedState;
}

const isPanelQuery = (key: readonly unknown[]) => key[0] === 'panel';

export async function restorePanelQueries(client: QueryClient): Promise<void> {
  const saved = await kvGet<Saved>(KEY);
  if (!saved || saved.buster !== BUSTER || Date.now() - saved.savedAt > MAX_AGE_MS) return;
  hydrate(client, saved.state);
}

/**
 * Panel sorgulari degistikce hemen cihaza yazar (ayni anda gelen olaylar tek yazmada birlesir):
 * uygulama hemen kapatilsa ya da internet hemen kesilse de son veri kaybolmaz. Durdurma doner.
 */
export function persistPanelQueries(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    // Verisi olan her panel sorgusu saklanir: internet kesilince yenileme hata verir ama son veri
    // gecerlidir. Hata durumu cihaza tasinmaz (acilista "basarili, eski veri" olarak gelir).
    const state = dehydrate(client, {
      shouldDehydrateQuery: (query) =>
        isPanelQuery(query.queryKey) && query.state.data !== undefined,
    });
    for (const query of state.queries) {
      query.state = {
        ...query.state,
        status: 'success',
        error: null,
        errorUpdateCount: 0,
        fetchFailureCount: 0,
        fetchFailureReason: null,
      };
    }
    // Saklanacak sorgu yoksa (cikistan sonra giris ekrani) cihazda kayit birakma.
    if (state.queries.length === 0) void kvDelete(KEY);
    else void kvSet(KEY, { buster: BUSTER, savedAt: Date.now(), state } satisfies Saved);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!isPanelQuery(event.query.queryKey)) return;
    if (event.type === 'updated' || event.type === 'removed') timer ??= setTimeout(save, 0);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
