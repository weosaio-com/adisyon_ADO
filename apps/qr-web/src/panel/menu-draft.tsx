import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MENU_SCHEMA_VERSION } from '@ado/shared/menu-core';
import type { MenuSnapshot } from '@ado/shared/menu';
import { api, ApiError } from '../lib/api';
import { useOnline } from '../lib/connectivity';
import { dropPendingImage, isPendingImage, keepPendingImage, prunePendingImages } from './images';
import { meQuery, menuKey } from './queries';
import { deleteDraft, getImage, loadDraft, saveDraft } from './store';
import { classifyPublishError, referencedImageKeys, shouldAutoPublish } from './sync-core';
import type { BranchMenu, BranchSummary } from './types';

/**
 * Menu ve Isletme sekmeleri ayni taslagi duzenler. Taslak cihazda saklanir (internet yokken de
 * duzenlenir, uygulama kapansa da kaybolmaz). "Kaydet ve yayinla" internet varsa hemen, yoksa
 * internet gelince kendiliginden yayinlar: once bekleyen fotograflar, sonra menu (surum kontrollu;
 * arada baska yerden kaydedildiyse bulut 409 VERSION_CONFLICT dondurur, ezilmez).
 */
interface MenuDraft {
  loading: boolean;
  /** Menu ne buluttan ne cihazdan okunabildi (ilk acilis internetsiz ya da bulut hatasi). */
  unavailable: boolean;
  loadError: string;
  readOnly: boolean;
  online: boolean;
  draft: MenuSnapshot;
  dirty: boolean;
  version: number | null;
  updatedAt: string | null;
  saving: boolean;
  /** Yayin istendi, internet bekleniyor. */
  publishPending: boolean;
  error: string;
  conflict: boolean;
  update: (change: (menu: MenuSnapshot) => MenuSnapshot) => void;
  /** Kucultulmus fotografi cihazda saklar; internet varsa hemen yukler. */
  addImage: (key: string, blob: Blob) => Promise<void>;
  save: () => void;
  discard: () => void;
  reload: () => void;
}

const CONFLICT_TEXT =
  'Menü başka bir yerden değiştirildi. Güncel menüyü yükleyip değişikliklerinizi yeniden yapın.';
const IMAGES_TEXT =
  'Bazı fotoğraflar yüklenemedi. İlgili ürünlerin fotoğrafını yeniden seçip tekrar kaydedin.';

const Context = createContext<MenuDraft | null>(null);

export function useMenuDraft(): MenuDraft {
  const value = useContext(Context);
  if (!value) throw new Error('useMenuDraft: MenuDraftProvider disinda');
  return value;
}

function emptyMenu(name: string): MenuSnapshot {
  return {
    schemaVersion: MENU_SCHEMA_VERSION,
    branch: { name, address: '', phone: '', languages: ['tr'], currency: 'TRY' },
    categories: [],
    products: [],
  };
}

// Bulutun dogrulama hatasini okunur hale getirir: "menu.products.3.name" -> "Mercimek: name".
function describeIssues(error: ApiError, menu: MenuSnapshot): string {
  const details = Array.isArray(error.details)
    ? (error.details as Array<{ field?: string; issue?: string }>)
    : [];
  const lines = details.slice(0, 3).map(({ field = '', issue = '' }) => {
    const [, list, index] = field.match(/^menu\.(products|categories)\.(\d+)/) ?? [];
    const item =
      list === 'products'
        ? menu.products[Number(index)]?.name
        : list === 'categories'
          ? menu.categories[Number(index)]?.name
          : undefined;
    return `${item ?? field}: ${issue}`;
  });
  return [error.message, ...lines].join(' — ');
}

interface Draft {
  menu: MenuSnapshot;
  baseVersion: number | null;
}

export function MenuDraftProvider({
  branch,
  children,
}: {
  branch: BranchSummary;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const key = useMemo(() => menuKey(branch.id), [branch.id]);
  const menuPath = `/api/panel/branches/${branch.id}/menu`;
  const imagePath = `/api/panel/branches/${branch.id}/images`;
  const query = useQuery({ queryKey: key, queryFn: () => api<BranchMenu>(menuPath) });
  const server = useMemo(
    () => query.data?.menu ?? emptyMenu(branch.name),
    [query.data, branch.name],
  );

  // Ilk duzenlemeye kadar taslak yoktur: buluttaki menu gosterilir. Taslak dayandigi surumu
  // saklar; menu arka planda yenilense de kayit o surume gore yapilir.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [publishPending, setPublishPending] = useState(false);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  // Cihazdaki taslak geri yuklenir (uygulama kapanip acilsa da duzenleme kaybolmaz).
  useEffect(() => {
    let cancelled = false;
    void loadDraft(branch.id).then((stored) => {
      if (cancelled) return;
      if (stored) {
        setDraft({ menu: stored.menu, baseVersion: stored.baseVersion });
        setPublishPending(stored.publishPending);
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [branch.id]);

  useEffect(() => {
    if (!restored) return;
    if (draft) {
      void saveDraft({
        branchId: branch.id,
        menu: draft.menu,
        baseVersion: draft.baseVersion,
        publishPending,
        updatedAt: new Date().toISOString(),
      });
    } else {
      void deleteDraft(branch.id);
    }
  }, [restored, draft, publishPending, branch.id]);

  const current = draft?.menu ?? server;
  const dirty = draft !== null && JSON.stringify(draft.menu) !== JSON.stringify(server);
  const readOnly = branch.source === 'pos' || query.data?.source === 'pos';

  // Yayin, beklerken de en guncel taslagi gonderir.
  const latest = useRef({ draft, server });
  latest.current = { draft, server };
  const busy = useRef(false);
  // Oturum dustugunde yeniden giris yapilana kadar kendiliginden denenmez (giriste yeniden kurulur).
  const sessionLost = useRef(false);

  const publish = useCallback(async () => {
    if (busy.current) return;
    const { draft: pending, server: published } = latest.current;
    if (!pending || JSON.stringify(pending.menu) === JSON.stringify(published)) {
      setDraft(null);
      setPublishPending(false);
      return;
    }
    busy.current = true;
    setSaving(true);
    setError('');
    const input = { menu: pending.menu, baseVersion: pending.baseVersion };
    try {
      for (const imageKey of referencedImageKeys(input.menu)) {
        if (!isPendingImage(imageKey)) continue;
        const stored = await getImage(imageKey);
        if (!stored) continue;
        const uploaded = await api<{ key: string }>(imagePath, { body: stored.blob });
        if (uploaded.key !== imageKey) {
          throw new ApiError(400, 'IMAGE_KEY_MISMATCH', IMAGES_TEXT);
        }
        await dropPendingImage(imageKey);
      }
      const saved = await api<{ version: number; updatedAt: string }>(menuPath, {
        method: 'PUT',
        json: input,
      });
      qc.setQueryData<BranchMenu>(key, {
        source: 'panel',
        version: saved.version,
        updatedAt: saved.updatedAt,
        menu: input.menu,
      });
      // Yayin surerken yapilan duzenleme taslakta kalir ve yeni surume dayanir.
      setDraft((previous) =>
        previous === null || previous.menu === input.menu
          ? null
          : { ...previous, baseVersion: saved.version },
      );
      setPublishPending(false);
      setConflict(false);
      void prunePendingImages();
      // Bulut metinleri kirpilmis haliyle saklar; guncel halini ve sube ozetini yeniden al.
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: meQuery.queryKey });
    } catch (err) {
      const kind = classifyPublishError(err);
      if (kind === 'offline') {
        setPublishPending(true); // internet gelince kendiliginden tekrar
      } else if (kind === 'session') {
        // Oturum dustu: taslak cihazda kalir, yeniden giristen sonra yayinlanir.
        sessionLost.current = true;
        setPublishPending(true);
        await saveDraft({
          branchId: branch.id,
          ...input,
          publishPending: true,
          updatedAt: new Date().toISOString(),
        });
        void qc.invalidateQueries({ queryKey: meQuery.queryKey });
      } else {
        setPublishPending(false);
        setConflict(kind === 'conflict');
        setError(
          kind === 'conflict'
            ? CONFLICT_TEXT
            : kind === 'images'
              ? IMAGES_TEXT
              : kind === 'invalid' && err instanceof ApiError
                ? describeIssues(err, input.menu)
                : err instanceof ApiError
                  ? err.message
                  : 'Kaydedilemedi.',
        );
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [qc, key, menuPath, imagePath, branch.id]);

  // Internet gelince bekleyen yayin kendiliginden gonderilir.
  useEffect(() => {
    if (sessionLost.current) return;
    if (
      shouldAutoPublish({
        ready: restored,
        hasDraft: draft !== null,
        publishPending,
        online,
        busy: saving,
        conflict,
      })
    ) {
      void publish();
    }
  }, [restored, draft, publishPending, online, saving, conflict, publish]);

  const unavailable =
    restored &&
    draft === null &&
    query.data === undefined &&
    (query.isError || query.fetchStatus === 'paused');
  const loadError =
    query.error instanceof ApiError && query.error.status !== 0 ? query.error.message : '';

  const value: MenuDraft = {
    loading: !restored || (query.data === undefined && draft === null && !unavailable),
    unavailable,
    loadError,
    readOnly,
    online,
    draft: current,
    dirty,
    version: query.data?.version ?? null,
    updatedAt: query.data?.updatedAt ?? null,
    saving,
    publishPending,
    error,
    conflict,
    update: (change) => {
      if (readOnly) return;
      setDraft((previous) => ({
        menu: change(previous?.menu ?? server),
        baseVersion: previous ? previous.baseVersion : (query.data?.version ?? null),
      }));
    },
    addImage: async (imageKey, blob) => {
      await keepPendingImage(imageKey, blob);
      if (!online) return; // internet gelince yayinla birlikte yuklenir
      try {
        const uploaded = await api<{ key: string }>(imagePath, { body: blob });
        if (uploaded.key !== imageKey) throw new ApiError(400, 'IMAGE_KEY_MISMATCH', IMAGES_TEXT);
        await dropPendingImage(imageKey);
      } catch (err) {
        if (classifyPublishError(err) === 'offline') return;
        await dropPendingImage(imageKey);
        throw err;
      }
    },
    save: () => {
      setError('');
      if (online) {
        void publish();
        return;
      }
      // Internetsiz: "yayin bekliyor" isareti once cihaza yazilir, sonra "Kaydedildi" gorunur.
      // Uygulama hemen ardindan kapansa da internet gelince kendiliginden yayinlanir.
      const pending = latest.current.draft;
      if (!pending) return;
      void saveDraft({
        branchId: branch.id,
        menu: pending.menu,
        baseVersion: pending.baseVersion,
        publishPending: true,
        updatedAt: new Date().toISOString(),
      }).then(() => setPublishPending(true));
    },
    // Degisiklikleri at ve buluttaki guncel menuyu yukle (surum cakismasinda da).
    discard: () => {
      setError('');
      setConflict(false);
      setPublishPending(false);
      setDraft(null);
      void deleteDraft(branch.id).then(prunePendingImages);
      void query.refetch();
    },
    reload: () => void query.refetch(),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
