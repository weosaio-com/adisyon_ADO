import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MENU_SCHEMA_VERSION } from '@ado/shared/menu-core';
import type { MenuSnapshot } from '@ado/shared/menu';
import { api, ApiError } from '../lib/api';
import { menuKey } from './queries';
import type { BranchMenu, BranchSummary } from './types';

/**
 * Menu ve Isletme sekmeleri ayni taslagi duzenler; "Kaydet" tek istekle menuyu yayinlar
 * (surum kontrollu: baska sekmede degistiyse bulut 409 VERSION_CONFLICT dondurur).
 */
interface MenuDraft {
  loading: boolean;
  readOnly: boolean;
  draft: MenuSnapshot;
  dirty: boolean;
  version: number | null;
  updatedAt: string | null;
  saving: boolean;
  error: string;
  conflict: boolean;
  /** Urun gorseli yukleme adresi (govde: kucultulmus gorsel). */
  imageUploadPath: string;
  update: (change: (menu: MenuSnapshot) => MenuSnapshot) => void;
  save: () => void;
  discard: () => void;
}

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

export function MenuDraftProvider({
  branch,
  children,
}: {
  branch: BranchSummary;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const key = menuKey(branch.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<BranchMenu>(`/api/panel/branches/${branch.id}/menu`),
  });
  const server = useMemo(
    () => query.data?.menu ?? emptyMenu(branch.name),
    [query.data, branch.name],
  );
  // Ilk duzenlemeye kadar taslak yoktur: sunucudaki menu gosterilir. Taslak, dayandigi surumu
  // saklar; menu arka planda yenilense de kayit o surume gore yapilir (baska sekmenin
  // degisikligi sessizce ezilmez, bulut 409 dondurur).
  const [draft, setDraft] = useState<{ menu: MenuSnapshot; baseVersion: number | null } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const current = draft?.menu ?? server;
  const dirty = draft !== null && JSON.stringify(draft.menu) !== JSON.stringify(server);
  const readOnly = branch.source === 'pos' || query.data?.source === 'pos';

  // Kaydedilmemis degisiklikle sayfadan cikarken tarayici uyarsin.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (input: { menu: MenuSnapshot; baseVersion: number | null }) =>
      api<{ version: number; updatedAt: string }>(`/api/panel/branches/${branch.id}/menu`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (saved, input) => {
      setError('');
      setConflict(false);
      qc.setQueryData<BranchMenu>(key, {
        source: 'panel',
        version: saved.version,
        updatedAt: saved.updatedAt,
        menu: input.menu,
      });
      // Kayit surerken yapilan duzenleme taslakta kalir ve yeni surume dayanir.
      setDraft((previous) =>
        previous === null || previous.menu === input.menu
          ? null
          : { ...previous, baseVersion: saved.version },
      );
      // Bulut metinleri kirpilmis haliyle saklar; guncel halini ve sube ozetini yeniden al.
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['panel', 'me'] });
    },
    onError: (err, input) => {
      setConflict(err instanceof ApiError && err.code === 'VERSION_CONFLICT');
      setError(
        err instanceof ApiError && err.code === 'VERSION_CONFLICT'
          ? 'Menü başka bir yerden değiştirildi. Güncel menüyü yükleyip değişikliklerinizi yeniden yapın.'
          : err instanceof ApiError && err.code === 'VALIDATION_ERROR'
            ? describeIssues(err, input.menu)
            : err instanceof ApiError
              ? err.message
              : 'Kaydedilemedi.',
      );
    },
  });

  const value: MenuDraft = {
    loading: query.isPending,
    readOnly,
    draft: current,
    dirty,
    version: query.data?.version ?? null,
    updatedAt: query.data?.updatedAt ?? null,
    saving: save.isPending,
    error: error || (query.error ? String(query.error.message) : ''),
    conflict,
    imageUploadPath: `/api/panel/branches/${branch.id}/images`,
    update: (change) => {
      if (readOnly) return;
      setDraft((previous) => ({
        menu: change(previous?.menu ?? server),
        baseVersion: previous ? previous.baseVersion : (query.data?.version ?? null),
      }));
    },
    save: () =>
      save.mutate({
        menu: current,
        baseVersion: draft ? draft.baseVersion : (query.data?.version ?? null),
      }),
    // Degisiklikleri at ve sunucudaki guncel menuyu yukle (surum cakismasinda da).
    discard: () => {
      setError('');
      setConflict(false);
      setDraft(null);
      void query.refetch();
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
