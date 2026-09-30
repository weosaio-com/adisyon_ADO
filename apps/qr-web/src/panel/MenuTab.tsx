import { useState } from 'react';
import {
  ALLERGEN_LABELS,
  ALLERGENS,
  DIET_TAG_LABELS,
  DIET_TAGS,
  MENU_LIMITS,
  type Allergen,
  type DietTag,
} from '@ado/shared/menu-core';
import type { MenuCategory, MenuProduct, MenuSnapshot } from '@ado/shared/menu';
import { api } from '../lib/api';
import { prepareMenuImage } from '../lib/image';
import { formatPrice } from '../lib/menu-view';
import { parsePrice, priceInput } from '../lib/money';
import { useMenuDraft } from './menu-draft';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  Chip,
  Dialog,
  errorText,
  Field,
  INPUT,
  Notice,
  when,
} from './ui';

const newId = () => crypto.randomUUID();

/** Diziyi siralar ve sortOrder'i siraya esitler (tasima sonrasi tutarli kalir). */
function renumber<T extends { sortOrder: number }>(items: T[]): T[] {
  return items.map((item, index) => ({ ...item, sortOrder: index }));
}

function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

const sorted = <T extends { sortOrder: number }>(items: T[]) =>
  [...items].sort((a, b) => a.sortOrder - b.sortOrder);

export function MenuTab() {
  const menu = useMenuDraft();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<MenuCategory | 'new' | null>(null);
  const [editProduct, setEditProduct] = useState<MenuProduct | 'new' | null>(null);

  if (menu.loading) return <p className="text-sm text-stone-500">Yükleniyor…</p>;
  const categories = sorted(menu.draft.categories);
  const active = categories.find((c) => c.id === categoryId) ?? categories[0] ?? null;
  const products = active
    ? sorted(menu.draft.products.filter((p) => p.categoryId === active.id))
    : [];

  const setCategories = (next: MenuCategory[]) =>
    menu.update((m) => ({ ...m, categories: renumber(next) }));
  const setCategoryProducts = (next: MenuProduct[]) =>
    menu.update((m) => ({
      ...m,
      products: [...m.products.filter((p) => p.categoryId !== active?.id), ...renumber(next)],
    }));

  return (
    <div className="space-y-4">
      {menu.readOnly && (
        <Notice tone="info">
          Bu şubenin menüsü adisyon programından yayınlanıyor; değişiklikleri programdaki Ürünler
          ekranından yapın. Burada son yayınlanan menü görünür.
        </Notice>
      )}
      <p className="text-xs text-stone-500">
        {menu.version
          ? `Yayında: sürüm ${menu.version} · ${when(menu.updatedAt)}`
          : 'Menü henüz yayınlanmadı.'}
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <Card testId="panel-categories">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-black text-ink-900">Kategoriler</h2>
            {!menu.readOnly && (
              <button onClick={() => setEditCategory('new')} className={BUTTON_PRIMARY}>
                + Kategori
              </button>
            )}
          </div>
          {categories.length === 0 && (
            <p className="text-sm text-stone-500">Önce bir kategori ekleyin (ör. Çorbalar).</p>
          )}
          <ul className="space-y-1">
            {categories.map((category, index) => (
              <li key={category.id} className="flex items-center gap-1">
                <button
                  onClick={() => setCategoryId(category.id)}
                  className={`min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                    active?.id === category.id ? 'bg-ink-900 text-white' : 'hover:bg-stone-100'
                  }`}
                >
                  {category.name}
                  <span className="ml-1 text-xs opacity-60">
                    ({menu.draft.products.filter((p) => p.categoryId === category.id).length})
                  </span>
                </button>
                {!menu.readOnly && (
                  <>
                    <button
                      aria-label="Yukarı"
                      onClick={() => setCategories(move(categories, index, -1))}
                      className="px-1 text-stone-400 hover:text-ink-900"
                    >
                      ↑
                    </button>
                    <button
                      aria-label="Aşağı"
                      onClick={() => setCategories(move(categories, index, 1))}
                      className="px-1 text-stone-400 hover:text-ink-900"
                    >
                      ↓
                    </button>
                    <button
                      aria-label="Düzenle"
                      onClick={() => setEditCategory(category)}
                      className="px-1 text-stone-400 hover:text-ink-900"
                    >
                      ✎
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card testId="panel-products">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate font-black text-ink-900">
              {active ? active.name : 'Ürünler'}
            </h2>
            {!menu.readOnly && active && (
              <button onClick={() => setEditProduct('new')} className={BUTTON_PRIMARY}>
                + Ürün
              </button>
            )}
          </div>
          {active && products.length === 0 && (
            <p className="text-sm text-stone-500">Bu kategoride ürün yok.</p>
          )}
          <ul className="divide-y divide-stone-100">
            {products.map((product, index) => (
              <li key={product.id} className="flex items-center gap-3 py-2">
                {product.imageKey ? (
                  <img
                    src={`/img/${product.imageKey}`}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg bg-stone-100 object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-lg bg-stone-100" />
                )}
                <button
                  onClick={() => setEditProduct(product)}
                  className="min-w-0 flex-1 text-left"
                  data-testid={`panel-product-${product.name}`}
                >
                  <p className="truncate font-semibold text-ink-900">{product.name}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-sm text-brand-700">
                    <span>{formatPrice(product.price)}</span>
                    {!product.available && (
                      <span className="rounded-full bg-stone-200 px-2 text-xs font-bold text-stone-700">
                        Tükendi
                      </span>
                    )}
                  </p>
                </button>
                {!menu.readOnly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() =>
                        setCategoryProducts(
                          products.map((p) =>
                            p.id === product.id ? { ...p, available: !p.available } : p,
                          ),
                        )
                      }
                      className="rounded-lg border border-stone-300 px-2 py-1 text-xs font-semibold"
                    >
                      {product.available ? 'Tükendi' : 'Satışa aç'}
                    </button>
                    <button
                      aria-label="Yukarı"
                      onClick={() => setCategoryProducts(move(products, index, -1))}
                      className="px-1 text-stone-400 hover:text-ink-900"
                    >
                      ↑
                    </button>
                    <button
                      aria-label="Aşağı"
                      onClick={() => setCategoryProducts(move(products, index, 1))}
                      className="px-1 text-stone-400 hover:text-ink-900"
                    >
                      ↓
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {editCategory && (
        <CategoryDialog
          category={editCategory === 'new' ? null : editCategory}
          productCount={
            editCategory === 'new'
              ? 0
              : menu.draft.products.filter((p) => p.categoryId === editCategory.id).length
          }
          onClose={() => setEditCategory(null)}
          onSave={(category) => {
            menu.update((m) => ({
              ...m,
              categories: m.categories.some((c) => c.id === category.id)
                ? m.categories.map((c) => (c.id === category.id ? category : c))
                : [...m.categories, { ...category, sortOrder: m.categories.length }],
            }));
            setCategoryId(category.id);
            setEditCategory(null);
          }}
          onDelete={(id) => {
            menu.update((m) => removeCategory(m, id));
            setCategoryId(null);
            setEditCategory(null);
          }}
        />
      )}
      {editProduct && active && (
        <ProductDialog
          product={editProduct === 'new' ? null : editProduct}
          categoryId={active.id}
          readOnly={menu.readOnly}
          onClose={() => setEditProduct(null)}
          onSave={(product) => {
            menu.update((m) => ({
              ...m,
              products: m.products.some((p) => p.id === product.id)
                ? m.products.map((p) => (p.id === product.id ? product : p))
                : [...m.products, { ...product, sortOrder: products.length }],
            }));
            setEditProduct(null);
          }}
          onDelete={(id) => {
            menu.update((m) => ({ ...m, products: m.products.filter((p) => p.id !== id) }));
            setEditProduct(null);
          }}
        />
      )}
    </div>
  );
}

function removeCategory(menu: MenuSnapshot, id: string): MenuSnapshot {
  return {
    ...menu,
    categories: renumber(sorted(menu.categories.filter((c) => c.id !== id))),
    products: menu.products.filter((p) => p.categoryId !== id),
  };
}

function CategoryDialog({
  category,
  productCount,
  onClose,
  onSave,
  onDelete,
}: {
  category: MenuCategory | null;
  productCount: number;
  onClose: () => void;
  onSave: (category: MenuCategory) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [enName, setEnName] = useState(category?.translations.en?.name ?? '');
  return (
    <Dialog title={category ? 'Kategori düzenle' : 'Yeni kategori'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Ad">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MENU_LIMITS.name}
            placeholder="Çorbalar"
            className={INPUT}
            autoFocus
          />
        </Field>
        <Field label="İngilizce ad (isteğe bağlı)">
          <input
            value={enName}
            onChange={(event) => setEnName(event.target.value)}
            maxLength={MENU_LIMITS.name}
            placeholder="Soups"
            className={INPUT}
          />
        </Field>
        <div className="flex gap-2 pt-2">
          {category && (
            <button
              onClick={() => {
                const message = productCount
                  ? `"${category.name}" ve içindeki ${productCount} ürün silinsin mi?`
                  : `"${category.name}" silinsin mi?`;
                if (window.confirm(message)) onDelete(category.id);
              }}
              className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700"
            >
              Sil
            </button>
          )}
          <button
            onClick={() =>
              onSave({
                id: category?.id ?? newId(),
                name: name.trim(),
                sortOrder: category?.sortOrder ?? 0,
                translations: enName.trim() ? { en: { name: enName.trim() } } : {},
              })
            }
            disabled={!name.trim()}
            className={`${BUTTON_PRIMARY} flex-1`}
          >
            Tamam
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ProductDialog({
  product,
  categoryId,
  readOnly,
  onClose,
  onSave,
  onDelete,
}: {
  product: MenuProduct | null;
  categoryId: string;
  readOnly: boolean;
  onClose: () => void;
  onSave: (product: MenuProduct) => void;
  onDelete: (id: string) => void;
}) {
  const menu = useMenuDraft();
  const [name, setName] = useState(product?.name ?? '');
  const [price, setPrice] = useState(product ? priceInput(product.price) : '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [enName, setEnName] = useState(product?.translations.en?.name ?? '');
  const [enDescription, setEnDescription] = useState(product?.translations.en?.description ?? '');
  const [allergens, setAllergens] = useState<Allergen[]>(product?.allergens ?? []);
  const [diet, setDiet] = useState<DietTag[]>(product?.diet ?? []);
  const [available, setAvailable] = useState(product?.available ?? true);
  const [imageKey, setImageKey] = useState<string | null>(product?.imageKey ?? null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const parsedPrice = parsePrice(price);
  const valid = name.trim() !== '' && parsedPrice !== null && parsedPrice <= MENU_LIMITS.price;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const blob = await prepareMenuImage(file);
      const { key } = await api<{ key: string }>(menu.imageUploadPath, { body: blob });
      setImageKey(key);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Dialog title={product ? 'Ürün düzenle' : 'Yeni ürün'} onClose={onClose}>
      <fieldset disabled={readOnly} className="space-y-3">
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <Field label="Ad">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MENU_LIMITS.name}
              className={INPUT}
              data-testid="product-name"
              autoFocus
            />
          </Field>
          <Field label="Fiyat (TL)">
            <input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              placeholder="0,00"
              className={INPUT}
              data-testid="product-price"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-stone-100">
            {imageKey && (
              <img
                src={`/img/${imageKey}`}
                alt=""
                className="h-full w-full object-cover"
                data-testid="product-image"
              />
            )}
          </div>
          <label className={`${BUTTON_SECONDARY} cursor-pointer`}>
            {uploading ? 'Yükleniyor…' : imageKey ? 'Görseli değiştir' : 'Görsel seç'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              data-testid="product-image-input"
              disabled={uploading || readOnly}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {imageKey && (
            <button
              type="button"
              onClick={() => setImageKey(null)}
              className="text-sm text-red-600"
            >
              Kaldır
            </button>
          )}
        </div>
        <Field label="Açıklama">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MENU_LIMITS.description}
            rows={2}
            className={INPUT}
          />
        </Field>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">Alerjenler</p>
          <div className="flex flex-wrap gap-1.5">
            {ALLERGENS.map((code) => (
              <Chip
                key={code}
                on={allergens.includes(code)}
                onClick={() => setAllergens(toggle(allergens, code))}
                testId={`allergen-${code}`}
                disabled={readOnly}
              >
                {ALLERGEN_LABELS[code].tr}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">Diyet</p>
          <div className="flex flex-wrap gap-1.5">
            {DIET_TAGS.map((tag) => (
              <Chip
                key={tag}
                on={diet.includes(tag)}
                onClick={() => setDiet(toggle(diet, tag))}
                testId={`diet-${tag}`}
                disabled={readOnly}
              >
                {DIET_TAG_LABELS[tag].tr}
              </Chip>
            ))}
          </div>
        </div>
        <Field label="İngilizce ad (isteğe bağlı)">
          <input
            value={enName}
            onChange={(event) => setEnName(event.target.value)}
            maxLength={MENU_LIMITS.name}
            className={INPUT}
          />
        </Field>
        <Field label="İngilizce açıklama (isteğe bağlı)">
          <textarea
            value={enDescription}
            onChange={(event) => setEnDescription(event.target.value)}
            maxLength={MENU_LIMITS.description}
            rows={2}
            className={INPUT}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-800">
          <input
            type="checkbox"
            checked={!available}
            onChange={(event) => setAvailable(!event.target.checked)}
          />
          Tükendi (menüde görünür, sipariş verilemez)
        </label>
      </fieldset>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {!readOnly && (
        <div className="mt-4 flex gap-2">
          {product && (
            <button
              onClick={() => {
                if (window.confirm(`"${product.name}" silinsin mi?`)) onDelete(product.id);
              }}
              className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700"
            >
              Sil
            </button>
          )}
          <button
            onClick={() => {
              const en = { name: enName.trim(), description: enDescription.trim() };
              onSave({
                id: product?.id ?? newId(),
                categoryId: product?.categoryId ?? categoryId,
                name: name.trim(),
                description: description.trim(),
                price: parsedPrice ?? 0,
                imageKey,
                allergens,
                diet,
                available,
                sortOrder: product?.sortOrder ?? 0,
                translations:
                  en.name || en.description
                    ? {
                        en: {
                          ...(en.name ? { name: en.name } : {}),
                          ...(en.description ? { description: en.description } : {}),
                        },
                      }
                    : {},
              });
            }}
            disabled={!valid || uploading}
            className={`${BUTTON_PRIMARY} flex-1`}
            data-testid="product-ok"
          >
            Tamam
          </button>
        </div>
      )}
    </Dialog>
  );
}
