import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ALLERGEN_LABELS,
  ALLERGENS,
  DIET_TAG_LABELS,
  DIET_TAGS,
  MENU_LIMITS,
  type Allergen,
  type DietTag,
  type MenuLanguage,
} from '@ado/shared/menu-core';
import { api, apiUpload, ApiError, catalogImageUrl } from '../lib/api';
import { formatKurus, parseTlToKurus as toKurus } from '../lib/format';
import { blobToDataUrl, MenuImageError, prepareMenuImage } from '../lib/image';
import type { Category, Product, Tax, Unit } from '../lib/types';

export default function MenuScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [cat, setCat] = useState<string | null>(null); // null = tümü
  const [catModal, setCatModal] = useState<Category | 'new' | null>(null);
  const [prodModal, setProdModal] = useState<Product | 'new' | null>(null);
  const [catalogModal, setCatalogModal] = useState(false);
  const [listError, setListError] = useState('');

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<Category[]>('/categories'),
  });
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<Product[]>('/products') });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api<Unit[]>('/units') });
  const taxes = useQuery({ queryKey: ['taxes'], queryFn: () => api<Tax[]>('/taxes') });

  const shown = (products.data ?? []).filter((p) => cat === null || p.categoryId === cat);

  // "Tukendi": urun listede kalir, siparise eklenemez; QR menude rozet olarak gorunur.
  const toggleAvailability = useMutation({
    mutationFn: (p: Product) =>
      api(`/products/${p.id}/availability`, {
        method: 'PATCH',
        body: { isAvailable: p.isAvailable === false },
      }),
    onSuccess: () => {
      setListError('');
      qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => setListError(e instanceof ApiError ? e.message : 'İşlem başarısız.'),
  });

  return (
    <div className="flex h-full flex-col bg-slate-100 md:flex-row">
      <aside className="flex w-full flex-col bg-white shadow md:w-72">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <button
            onClick={() => nav('/')}
            className="rounded-lg bg-slate-200 px-3 py-1 font-medium"
          >
            ← Masalar
          </button>
          <h1 className="font-bold text-slate-800">Ürünler</h1>
          <button
            onClick={() => setCatModal('new')}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white"
          >
            + Kategori
          </button>
        </header>
        <ul className="flex-1 overflow-auto">
          <li>
            <button
              onClick={() => setCat(null)}
              className={`w-full border-b px-4 py-3 text-left font-medium ${cat === null ? 'bg-blue-50' : ''}`}
            >
              Tümü
            </button>
          </li>
          {(categories.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center border-b">
              <button
                onClick={() => setCat(c.id)}
                className={`flex-1 px-4 py-3 text-left font-medium ${cat === c.id ? 'bg-blue-50' : ''}`}
              >
                {c.name}
              </button>
              <button
                onClick={() => setCatModal(c)}
                className="px-3 py-3 text-sm text-slate-400 hover:text-slate-700"
              >
                ✎
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3">
          <h2 className="font-bold text-slate-800">
            {cat === null ? 'Tüm Ürünler' : (categories.data ?? []).find((c) => c.id === cat)?.name}
          </h2>
          <button
            onClick={() => setCatalogModal(true)}
            className="ml-auto rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            Birim / Vergi
          </button>
          <button
            onClick={() => setProdModal('new')}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            + Ürün
          </button>
        </header>
        {listError && (
          <p className="border-b bg-red-50 px-4 py-2 text-sm text-red-700">{listError}</p>
        )}
        <ul className="flex-1 overflow-auto p-2">
          {shown.length === 0 && <li className="p-6 text-center text-slate-400">Ürün yok</li>}
          {shown.map((p) => (
            <li
              key={p.id}
              data-testid={`menu-product-${p.id}`}
              className="flex items-center border-b"
            >
              <button
                onClick={() => setProdModal(p)}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-3 text-left"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {p.imagePath && (
                    <img
                      src={catalogImageUrl(p.imagePath)}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-md object-cover"
                    />
                  )}
                  <span className="truncate font-medium text-slate-800">{p.name}</span>
                  {p.isFavorite && <span className="text-amber-500">★</span>}
                  {p.isActive === false && (
                    <span className="rounded bg-slate-200 px-1.5 text-xs text-slate-500">
                      pasif
                    </span>
                  )}
                  {p.isAvailable === false && (
                    <span className="rounded bg-red-100 px-1.5 text-xs font-medium text-red-700">
                      tükendi
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-semibold text-slate-700">
                  {formatKurus(p.salePrice)}
                </span>
              </button>
              <button
                data-testid={`availability-${p.id}`}
                onClick={() => toggleAvailability.mutate(p)}
                disabled={toggleAvailability.isPending}
                className={`mr-2 shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                  p.isAvailable === false
                    ? 'border border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border border-slate-300 bg-white text-slate-600 hover:border-red-300 hover:text-red-700'
                }`}
              >
                {p.isAvailable === false ? 'Satışa aç' : 'Tükendi'}
              </button>
            </li>
          ))}
        </ul>
      </main>

      {catModal && (
        <CategoryModal
          category={catModal === 'new' ? null : catModal}
          onClose={() => setCatModal(null)}
        />
      )}
      {prodModal && (
        <ProductModal
          product={prodModal === 'new' ? null : prodModal}
          categories={categories.data ?? []}
          units={units.data ?? []}
          taxes={taxes.data ?? []}
          defaultCategoryId={cat}
          onClose={() => setProdModal(null)}
        />
      )}
      {catalogModal && (
        <CatalogSettingsModal
          units={units.data ?? []}
          taxes={taxes.data ?? []}
          onClose={() => setCatalogModal(false)}
        />
      )}
    </div>
  );
}

// Birim ve vergi yonetimi (ekle/sil). Urun eklemek icin en az bir birim + bir
// vergi sart oldugundan bu ekran katalogun on kosulu. Backend CRUD zaten mevcut.
function CatalogSettingsModal({
  units,
  taxes,
  onClose,
}: {
  units: Unit[];
  taxes: Tax[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [unitName, setUnitName] = useState('');
  const [unitAbbr, setUnitAbbr] = useState('');
  const [taxName, setTaxName] = useState('');
  const [taxPct, setTaxPct] = useState('');
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');
  const refetch = (key: string) => qc.invalidateQueries({ queryKey: [key] });

  const addUnit = useMutation({
    mutationFn: () =>
      api('/units', {
        method: 'POST',
        body: { name: unitName.trim(), abbreviation: unitAbbr.trim() || undefined },
      }),
    onSuccess: () => {
      setUnitName('');
      setUnitAbbr('');
      setError('');
      refetch('units');
    },
    onError: fail,
  });
  const delUnit = useMutation({
    mutationFn: (id: string) => api(`/units/${id}`, { method: 'DELETE' }),
    onSuccess: () => refetch('units'),
    onError: fail,
  });
  const addTax = useMutation({
    mutationFn: () =>
      api('/taxes', {
        method: 'POST',
        // Yuzde -> binde (ratePermille). %10 -> 100.
        body: {
          name: taxName.trim(),
          ratePermille: Math.round(parseFloat(taxPct.replace(',', '.')) * 10),
        },
      }),
    onSuccess: () => {
      setTaxName('');
      setTaxPct('');
      setError('');
      refetch('taxes');
    },
    onError: fail,
  });
  const delTax = useMutation({
    mutationFn: (id: string) => api(`/taxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => refetch('taxes'),
    onError: fail,
  });

  const unitValid = unitName.trim() !== '';
  const taxValid = taxName.trim() !== '' && parseFloat(taxPct.replace(',', '.')) >= 0;

  return (
    <Modal title="Birim ve Vergiler" onClose={onClose}>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <h3 className="mb-1 font-semibold text-slate-700">Birimler</h3>
      <ul className="mb-2 divide-y rounded-lg border">
        {units.length === 0 && <li className="p-2 text-sm text-slate-400">Birim yok</li>}
        {units.map((u) => (
          <li key={u.id} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm text-slate-700">
              {u.name}
              {u.abbreviation ? ` (${u.abbreviation})` : ''}
            </span>
            <button
              onClick={() => delUnit.mutate(u.id)}
              className="text-sm text-red-500 hover:text-red-700"
            >
              Sil
            </button>
          </li>
        ))}
      </ul>
      <div className="mb-4 flex gap-2">
        <input
          value={unitName}
          onChange={(e) => setUnitName(e.target.value)}
          placeholder="Birim adı (Adet)"
          className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          value={unitAbbr}
          onChange={(e) => setUnitAbbr(e.target.value)}
          placeholder="Kısaltma"
          className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => addUnit.mutate()}
          disabled={!unitValid || addUnit.isPending}
          className="rounded-lg bg-blue-600 px-3 text-sm font-medium text-white disabled:opacity-40"
        >
          Ekle
        </button>
      </div>

      <h3 className="mb-1 font-semibold text-slate-700">Vergiler (KDV)</h3>
      <ul className="mb-2 divide-y rounded-lg border">
        {taxes.length === 0 && <li className="p-2 text-sm text-slate-400">Vergi yok</li>}
        {taxes.map((t) => (
          <li key={t.id} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm text-slate-700">
              {t.name} — %{t.ratePermille / 10}
              {t.isDefault && <span className="ml-1 text-xs text-blue-600">(varsayılan)</span>}
            </span>
            <button
              onClick={() => delTax.mutate(t.id)}
              className="text-sm text-red-500 hover:text-red-700"
            >
              Sil
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          value={taxName}
          onChange={(e) => setTaxName(e.target.value)}
          placeholder="Vergi adı (KDV %10)"
          className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          value={taxPct}
          onChange={(e) => setTaxPct(e.target.value)}
          inputMode="decimal"
          placeholder="% oran"
          className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => addTax.mutate()}
          disabled={!taxValid || addTax.isPending}
          className="rounded-lg bg-blue-600 px-3 text-sm font-medium text-white disabled:opacity-40"
        >
          Ekle
        </button>
      </div>
    </Modal>
  );
}

function CategoryModal({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(category?.name ?? '');
  const [enName, setEnName] = useState(category?.translations?.en?.name ?? '');
  const [error, setError] = useState('');
  const done = () => {
    qc.invalidateQueries({ queryKey: ['categories'] });
    onClose();
  };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), translations: { en: { name: enName.trim() } } };
      return category
        ? api(`/categories/${category.id}`, { method: 'PATCH', body })
        : api('/categories', { method: 'POST', body });
    },
    onSuccess: done,
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/categories/${category!.id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <Modal title={category ? 'Kategori Düzenle' : 'Yeni Kategori'} onClose={onClose}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Kategori adı"
        className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <input
        value={enName}
        onChange={(e) => setEnName(e.target.value)}
        maxLength={MENU_LIMITS.name}
        placeholder="İngilizce adı (QR menü, isteğe bağlı)"
        className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        {category && (
          <button
            onClick={() => del.mutate()}
            disabled={del.isPending}
            className="rounded-lg bg-red-100 px-4 py-2 font-medium text-red-700 disabled:opacity-40"
          >
            Sil
          </button>
        )}
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || name.trim() === ''}
          className="flex-1 rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
        >
          Kaydet
        </button>
      </div>
    </Modal>
  );
}

function ProductModal({
  product,
  categories,
  units,
  taxes,
  defaultCategoryId,
  onClose,
}: {
  product: Product | null;
  categories: Category[];
  units: Unit[];
  taxes: Tax[];
  defaultCategoryId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const defTax = taxes.find((t) => t.isDefault)?.id ?? taxes[0]?.id ?? '';
  const [name, setName] = useState(product?.name ?? '');
  const [categoryId, setCategoryId] = useState(
    product?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? '',
  );
  const [priceTl, setPriceTl] = useState(product ? (product.salePrice / 100).toFixed(2) : '');
  const [unitId, setUnitId] = useState(product?.unitId ?? units[0]?.id ?? '');
  const [taxId, setTaxId] = useState(product?.taxId ?? defTax);
  const [isFavorite, setIsFavorite] = useState(product?.isFavorite ?? false);
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [isAvailable, setIsAvailable] = useState(product?.isAvailable ?? true);
  // QR menu bilgileri
  const [description, setDescription] = useState(product?.description ?? '');
  const [allergens, setAllergens] = useState<Allergen[]>(product?.allergens ?? []);
  const [dietTags, setDietTags] = useState<DietTag[]>(product?.dietTags ?? []);
  const [enName, setEnName] = useState(product?.translations?.en?.name ?? '');
  const [enDescription, setEnDescription] = useState(product?.translations?.en?.description ?? '');
  const [menuOpen, setMenuOpen] = useState(
    Boolean(
      product?.description ||
      product?.imagePath ||
      product?.allergens?.length ||
      product?.dietTags?.length ||
      product?.translations?.en,
    ),
  );
  // Yeni urunde gorsel kayittan sonra yuklenir; ikinci "Kaydet" tekrar urun olusturmasin diye
  // olusan kimlik saklanir.
  const [savedId, setSavedId] = useState<string | null>(product?.id ?? null);
  const [imagePath, setImagePath] = useState<string | null>(product?.imagePath ?? null);
  const [pendingImage, setPendingImage] = useState<{ blob: Blob; preview: string } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshProducts = () => qc.invalidateQueries({ queryKey: ['products'] });
  const done = () => {
    refreshProducts();
    onClose();
  };
  const fail = (e: unknown) =>
    setError(e instanceof ApiError || e instanceof MenuImageError ? e.message : 'İşlem başarısız.');

  const salePrice = toKurus(priceTl);
  const valid =
    name.trim() !== '' &&
    categoryId !== '' &&
    unitId !== '' &&
    taxId !== '' &&
    priceTl.trim() !== '' &&
    Number.isFinite(salePrice) &&
    salePrice >= 0;

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setImageBusy(true);
    try {
      const blob = await prepareMenuImage(file);
      if (savedId) {
        const updated = await apiUpload<Product>(`/products/${savedId}/image`, blob);
        setImagePath(updated.imagePath ?? null);
        refreshProducts();
      } else {
        setPendingImage({ blob, preview: await blobToDataUrl(blob) });
      }
    } catch (e) {
      fail(e);
    } finally {
      setImageBusy(false);
    }
  };
  const removeImage = async () => {
    setError('');
    if (pendingImage) {
      setPendingImage(null);
      return;
    }
    if (!savedId) return;
    setImageBusy(true);
    try {
      await api(`/products/${savedId}/image`, { method: 'DELETE' });
      setImagePath(null);
      refreshProducts();
    } catch (e) {
      fail(e);
    } finally {
      setImageBusy(false);
    }
  };
  const previewSrc = pendingImage?.preview ?? (imagePath ? catalogImageUrl(imagePath) : null);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        categoryId,
        unitId,
        taxId,
        salePrice,
        isFavorite,
        isActive,
        isAvailable,
        description: description.trim() || null,
        allergens,
        dietTags,
        translations: { en: { name: enName.trim(), description: enDescription.trim() } },
      };
      let id = savedId;
      if (id) {
        await api(`/products/${id}`, { method: 'PATCH', body });
      } else {
        id = (await api<Product>('/products', { method: 'POST', body })).id;
        setSavedId(id);
      }
      if (pendingImage) {
        try {
          await apiUpload(`/products/${id}/image`, pendingImage.blob);
        } catch (e) {
          const reason = e instanceof ApiError ? e.message : 'bağlantı hatası';
          throw new ApiError(
            0,
            'IMAGE_UPLOAD_FAILED',
            `Ürün kaydedildi, görsel yüklenemedi (${reason}). Tekrar "Kaydet"e basın.`,
          );
        }
        setPendingImage(null);
      }
    },
    onSuccess: done,
    onError: (e) => {
      refreshProducts();
      fail(e);
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/products/${savedId!}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <Modal title={savedId ? 'Ürün Düzenle' : 'Yeni Ürün'} onClose={onClose} wide>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ürün adı"
        className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Select label="Kategori" value={categoryId} onChange={setCategoryId} options={categories} />
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Satış Fiyatı (TL)</label>
          <input
            value={priceTl}
            onChange={(e) => setPriceTl(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <Select label="Birim" value={unitId} onChange={setUnitId} options={units} />
        <Select label="Vergi" value={taxId} onChange={setTaxId} options={taxes} />
      </div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isFavorite}
            onChange={(e) => setIsFavorite(e.target.checked)}
          />
          Favori
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Aktif
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-testid="product-sold-out"
            checked={!isAvailable}
            onChange={(e) => setIsAvailable(!e.target.checked)}
          />
          Tükendi
        </label>
      </div>

      <div className="mb-3 rounded-xl border border-slate-200">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-slate-700"
        >
          QR menü bilgileri
          <span className="text-slate-400">{menuOpen ? '▲' : '▼'}</span>
        </button>
        {menuOpen && (
          <div className="border-t border-slate-200 px-3 pt-3">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {previewSrc ? (
                  <img
                    src={previewSrc}
                    alt=""
                    data-testid="product-image-preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-center text-[11px] text-slate-400">Görsel yok</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className={`rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 ${
                    imageBusy ? 'opacity-50' : 'cursor-pointer hover:bg-slate-300'
                  }`}
                >
                  {imageBusy ? 'Hazırlanıyor…' : previewSrc ? 'Değiştir' : 'Görsel seç'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    data-testid="product-image-input"
                    disabled={imageBusy}
                    className="sr-only"
                    onChange={(e) => {
                      void pickImage(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
                {previewSrc && (
                  <button
                    type="button"
                    onClick={() => void removeImage()}
                    disabled={imageBusy}
                    className="text-sm text-red-500 hover:text-red-700 disabled:opacity-40"
                  >
                    Kaldır
                  </button>
                )}
              </div>
            </div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Açıklama</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MENU_LIMITS.description}
              rows={2}
              placeholder="İçindekiler, porsiyon…"
              className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <ChipGroup
              label="Alerjenler"
              codes={ALLERGENS}
              labels={ALLERGEN_LABELS}
              value={allergens}
              onChange={setAllergens}
            />
            <ChipGroup
              label="Diyet"
              codes={DIET_TAGS}
              labels={DIET_TAG_LABELS}
              value={dietTags}
              onChange={setDietTags}
            />
            <label className="mb-1 block text-xs font-medium text-slate-500">
              İngilizce (isteğe bağlı)
            </label>
            <input
              value={enName}
              onChange={(e) => setEnName(e.target.value)}
              maxLength={MENU_LIMITS.name}
              placeholder="English name"
              className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <textarea
              value={enDescription}
              onChange={(e) => setEnDescription(e.target.value)}
              maxLength={MENU_LIMITS.description}
              rows={2}
              placeholder="English description"
              className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        {savedId && (
          <button
            onClick={() => del.mutate()}
            disabled={del.isPending}
            className="rounded-lg bg-red-100 px-4 py-2 font-medium text-red-700 disabled:opacity-40"
          >
            Sil
          </button>
        )}
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || imageBusy || !valid}
          className="flex-1 rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
        >
          Kaydet
        </button>
      </div>
    </Modal>
  );
}

// Coklu secim cipleri (alerjen / diyet). Etiketler @ado/shared'deki resmi listeden gelir.
function ChipGroup<T extends string>({
  label,
  codes,
  labels,
  value,
  onChange,
}: {
  label: string;
  codes: readonly T[];
  labels: Record<T, Record<MenuLanguage, string>>;
  value: T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-xs font-medium text-slate-500">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {codes.map((code) => {
          const on = value.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              data-testid={`chip-${code}`}
              onClick={() => onChange(on ? value.filter((c) => c !== code) : [...value, code])}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                on
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'
              }`}
            >
              {labels[code].tr}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl bg-white p-6 shadow-xl ${
          wide ? 'max-w-lg' : 'max-w-sm'
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
