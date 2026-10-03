import { MENU_LIMITS } from '@ado/shared/menu-core';
import type { MenuSnapshot } from '@ado/shared/menu';
import { useMenuDraft } from './menu-draft';
import { MenuUnavailable } from './MenuTab';
import { Card, Field, INPUT, Notice } from './ui';

type BranchInfo = MenuSnapshot['branch'];

// Musteri sayfasinin ust ve alt bilgisi; menuyle ayni taslakta, "Kaydet ve yayinla" ile gider.
export function BusinessTab() {
  const menu = useMenuDraft();
  if (menu.loading) return <p className="text-sm text-stone-500">Yükleniyor…</p>;
  if (menu.unavailable) return <MenuUnavailable />;
  const branch = menu.draft.branch;
  const set = (change: Partial<BranchInfo>) =>
    menu.update((m) => ({ ...m, branch: { ...m.branch, ...change } }));

  return (
    <div className="max-w-lg space-y-4">
      {menu.readOnly ? (
        <Notice tone="info">
          Bu bilgiler adisyon programındaki Ayarlar › İşletme Bilgileri kartından gelir; oradan
          değiştirin.
        </Notice>
      ) : (
        <p className="text-sm text-stone-500">
          Müşteri menünün üstünde işletme adını, altında adres ve telefonu görür. Değişiklikler
          alttaki “Kaydet ve yayınla” ile menüyle birlikte yayınlanır.
        </p>
      )}
      <Card>
        <fieldset disabled={menu.readOnly} className="space-y-3">
          <Field label="İşletme adı">
            <input
              value={branch.name}
              onChange={(event) => set({ name: event.target.value })}
              maxLength={MENU_LIMITS.branchName}
              className={INPUT}
              data-testid="business-name-input"
            />
          </Field>
          {!branch.name.trim() && <p className="text-xs text-amber-800">İşletme adı gerekli.</p>}
          <Field label="Adres">
            <textarea
              value={branch.address}
              onChange={(event) => set({ address: event.target.value })}
              maxLength={MENU_LIMITS.address}
              rows={2}
              className={INPUT}
            />
          </Field>
          <Field label="Telefon">
            <input
              type="tel"
              value={branch.phone}
              onChange={(event) => set({ phone: event.target.value })}
              maxLength={MENU_LIMITS.phone}
              className={INPUT}
            />
          </Field>
          <label className="flex items-start gap-2 pt-1 text-sm text-ink-800">
            <input
              type="checkbox"
              checked={branch.languages.includes('en')}
              onChange={(event) => set({ languages: event.target.checked ? ['tr', 'en'] : ['tr'] })}
              className="mt-0.5"
              data-testid="business-english"
            />
            <span>
              İngilizce menü sun
              <span className="block text-xs text-stone-500">
                Müşteri TR/EN arasında geçebilir; İngilizce adı girilmeyen ürün Türkçe görünür.
              </span>
            </span>
          </label>
        </fieldset>
      </Card>
    </div>
  );
}
