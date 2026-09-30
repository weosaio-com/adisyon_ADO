import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  ALLERGEN_LABELS,
  ALLERGENS,
  DIET_TAG_LABELS,
  DIET_TAGS,
  menuText,
  type Allergen,
  type DietTag,
  type MenuLanguage,
} from '@ado/shared/menu-core';
import type { MenuProduct, MenuSnapshot } from '@ado/shared/menu';
import { api, ApiError, storage } from '../lib/api';
import { UI, type UiText } from '../lib/i18n';
import {
  activeFilterCount,
  allergenNames,
  dietNames,
  EMPTY_FILTER,
  formatPrice,
  menuSections,
  pickLanguage,
  tableLabel,
  type MenuFilter,
} from '../lib/menu-view';

/** GET /api/m/:code yaniti (apps/cloud src/routes/public.ts). */
export interface PublicMenu {
  table: { name: string; hall: string };
  version: number;
  updatedAt: string;
  features: { order: boolean; pay: boolean };
  menu: MenuSnapshot;
}

const LANG_KEY = 'ado.menu.lang';

function browserLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

// Masadaki QR'in actigi sayfa: isletmenin menusu, telefonda.
export default function CustomerMenu() {
  const { code = '' } = useParams();
  const query = useQuery({
    queryKey: ['menu', code],
    queryFn: () => api<PublicMenu>(`/api/m/${encodeURIComponent(code)}`),
    // Musteri sekmeye donunce "tukendi" gibi degisiklikler gelsin (degismediyse 304).
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const [savedLang, setSavedLang] = useState(() => storage.get(LANG_KEY));
  const lang = pickLanguage(
    query.data?.menu.branch.languages ?? ['tr', 'en'],
    browserLanguages(),
    savedLang,
  );
  const t = UI[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    if (query.data)
      document.title = `${query.data.menu.branch.name} · ${lang === 'tr' ? 'Menü' : 'Menu'}`;
  }, [query.data, lang]);

  if (query.isPending) return <Loading t={t} />;
  if (query.isError) {
    return <ErrorScreen t={t} error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <MenuView
      data={query.data}
      lang={lang}
      t={t}
      onLanguage={(next) => {
        storage.set(LANG_KEY, next);
        setSavedLang(next);
      }}
    />
  );
}

function MenuView({
  data,
  lang,
  t,
  onLanguage,
}: {
  data: PublicMenu;
  lang: MenuLanguage;
  t: UiText;
  onLanguage: (lang: MenuLanguage) => void;
}) {
  const { menu, table } = data;
  const [filter, setFilter] = useState<MenuFilter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => menuSections(menu, lang, filter), [menu, lang, filter]);
  // Menu yenilenince (ör. tukendi) acik urun penceresi de guncel veriyi gostersin.
  const selected = menu.products.find((product) => product.id === selectedId) ?? null;
  const filters = activeFilterCount(filter);

  // Kaydirdikca gorunen kategorinin sekmesi isaretlenir.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute('data-category');
        if (id) setActive(id);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    document.querySelectorAll('[data-category]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [sections]);

  // Isaretli sekme serit icinde gorunur kalir (yalniz yatay kaydirma).
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = active ? strip?.querySelector<HTMLElement>(`[data-tab="${active}"]`) : null;
    if (!strip || !tab) return;
    strip.scrollTo({
      left: tab.offsetLeft - strip.clientWidth / 2 + tab.clientWidth / 2,
      behavior: 'smooth',
    });
  }, [active]);

  const jumpTo = (id: string) => {
    setActive(id);
    document.getElementById(`cat-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen">
      <header className="bg-ink-900 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 text-white">
        <div className="mx-auto flex max-w-xl items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black" data-testid="business-name">
              {menu.branch.name}
            </h1>
            <p className="mt-0.5 truncate text-sm text-white/70" data-testid="table-label">
              {tableLabel(table)}
            </p>
          </div>
          {menu.branch.languages.length > 1 && (
            <div className="flex shrink-0 rounded-full bg-white/10 p-1" role="group">
              {menu.branch.languages.map((code) => (
                <button
                  key={code}
                  onClick={() => onLanguage(code)}
                  aria-pressed={code === lang}
                  data-testid={`lang-${code}`}
                  className={`min-w-10 rounded-full px-2.5 py-1 text-xs font-bold uppercase transition ${
                    code === lang ? 'bg-white text-ink-900' : 'text-white/80'
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="sticky top-0 z-30 border-b border-stone-200 bg-[#f5f5f2]/95 backdrop-blur">
        <div className="mx-auto max-w-xl px-4 pt-3">
          <div className="flex gap-2">
            <input
              type="search"
              value={filter.query}
              onChange={(event) => setFilter({ ...filter, query: event.target.value })}
              placeholder={t.search}
              aria-label={t.search}
              className="h-11 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 text-base text-ink-900 shadow-sm placeholder:text-stone-400"
            />
            <button
              onClick={() => setFilterOpen(true)}
              data-testid="filter-button"
              className={`h-11 shrink-0 rounded-xl px-4 text-sm font-bold shadow-sm ${
                filters ? 'bg-ink-900 text-white' : 'border border-stone-200 bg-white text-ink-800'
              }`}
            >
              {t.filter}
              {filters > 0 && ` (${filters})`}
            </button>
          </div>
          <div
            ref={tabsRef}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none]"
          >
            {sections.map(({ category }) => (
              <button
                key={category.id}
                data-tab={category.id}
                onClick={() => jumpTo(category.id)}
                aria-current={active === category.id}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold whitespace-nowrap transition ${
                  active === category.id
                    ? 'bg-ink-900 text-white'
                    : 'bg-white text-stone-600 ring-1 ring-stone-200'
                }`}
              >
                {menuText(category, lang).name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-xl px-4 pt-2">
        {sections.length === 0 && (
          <div className="py-16 text-center">
            <p className="font-semibold text-stone-600">{t.noResults}</p>
            <button
              onClick={() => setFilter(EMPTY_FILTER)}
              className="mt-3 rounded-xl bg-ink-900 px-4 py-2 text-sm font-bold text-white"
            >
              {t.clearFilters}
            </button>
          </div>
        )}
        {sections.map(({ category, products }) => (
          <section
            key={category.id}
            id={`cat-${category.id}`}
            data-category={category.id}
            className="scroll-mt-32 pt-4"
          >
            <h2 className="mb-2 text-xs font-black tracking-[0.14em] text-stone-500 uppercase">
              {menuText(category, lang).name}
            </h2>
            <ul className="space-y-3">
              {products.map((product) => (
                <li key={product.id}>
                  <ProductCard
                    product={product}
                    lang={lang}
                    t={t}
                    onOpen={() => setSelectedId(product.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      <footer className="mx-auto max-w-xl px-4 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-center text-xs text-stone-500">
        <p>{t.allergenNote}</p>
        {(menu.branch.address || menu.branch.phone) && (
          <p className="mt-2">
            {menu.branch.address}
            {menu.branch.address && menu.branch.phone ? ' · ' : ''}
            {menu.branch.phone && (
              <a href={`tel:${menu.branch.phone.replace(/[^\d+]/g, '')}`} className="underline">
                {menu.branch.phone}
              </a>
            )}
          </p>
        )}
      </footer>

      {selected && (
        <ProductSheet product={selected} lang={lang} t={t} onClose={() => setSelectedId(null)} />
      )}
      {filterOpen && (
        <FilterSheet
          filter={filter}
          lang={lang}
          t={t}
          onChange={setFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  );
}

const DIET_STYLE: Record<DietTag, string> = {
  vegan: 'bg-brand-50 text-brand-700',
  vegetarian: 'bg-brand-50 text-brand-700',
  gluten_free: 'bg-amber-50 text-amber-800',
  spicy: 'bg-red-50 text-red-700',
};

function DietPills({ product, lang }: { product: MenuProduct; lang: MenuLanguage }) {
  if (!product.diet.length) return null;
  const names = dietNames(product, lang);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {product.diet.map((tag, index) => (
        <span
          key={tag}
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${DIET_STYLE[tag]}`}
        >
          {names[index]}
        </span>
      ))}
    </div>
  );
}

function ProductCard({
  product,
  lang,
  t,
  onOpen,
}: {
  product: MenuProduct;
  lang: MenuLanguage;
  t: UiText;
  onOpen: () => void;
}) {
  const text = menuText(product, lang);
  const allergens = allergenNames(product, lang);
  return (
    <button
      onClick={onOpen}
      data-testid={`menu-item-${product.id}`}
      className={`flex w-full gap-3 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-stone-200/70 transition active:scale-[0.99] ${
        product.available ? '' : 'opacity-60'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold [overflow-wrap:anywhere] text-ink-900">{text.name}</p>
        {text.description && (
          <p className="mt-0.5 line-clamp-2 text-sm text-stone-600">{text.description}</p>
        )}
        <DietPills product={product} lang={lang} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-black text-brand-700">{formatPrice(product.price)}</span>
          {!product.available && (
            <span
              data-testid="sold-out"
              className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-bold text-stone-700"
            >
              {t.soldOut}
            </span>
          )}
        </div>
        {allergens.length > 0 && (
          <p className="mt-1 text-xs text-stone-500">
            {t.contains}: {allergens.join(', ')}
          </p>
        )}
      </div>
      {product.imageKey && (
        <img
          src={`/img/${product.imageKey}`}
          alt=""
          loading="lazy"
          decoding="async"
          width={96}
          height={96}
          className="h-24 w-24 shrink-0 rounded-xl bg-stone-100 object-cover"
        />
      )}
    </button>
  );
}

function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ProductSheet({
  product,
  lang,
  t,
  onClose,
}: {
  product: MenuProduct;
  lang: MenuLanguage;
  t: UiText;
  onClose: () => void;
}) {
  const text = menuText(product, lang);
  const allergens = allergenNames(product, lang);
  return (
    <Sheet label={text.name} onClose={onClose}>
      {product.imageKey && (
        <img
          src={`/img/${product.imageKey}`}
          alt={text.name}
          className="aspect-[4/3] w-full bg-stone-100 object-cover sm:rounded-t-3xl"
        />
      )}
      <div className="p-5" data-testid="product-sheet">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-xl font-black [overflow-wrap:anywhere] text-ink-900">
            {text.name}
          </h2>
          <span className="shrink-0 text-lg font-black text-brand-700">
            {formatPrice(product.price)}
          </span>
        </div>
        {!product.available && (
          <p className="mt-2 inline-block rounded-full bg-stone-200 px-2.5 py-0.5 text-sm font-bold text-stone-700">
            {t.soldOut}
          </p>
        )}
        {text.description && (
          <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-line text-stone-700">
            {text.description}
          </p>
        )}
        <DietPills product={product} lang={lang} />
        {allergens.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-black tracking-[0.14em] text-stone-500 uppercase">
              {t.allergens}
            </h3>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {allergens.map((name) => (
                <li
                  key={name}
                  className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900"
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 text-xs text-stone-500">{t.allergenNote}</p>
        <button
          onClick={onClose}
          autoFocus
          className="mt-5 h-12 w-full rounded-2xl bg-ink-900 font-bold text-white"
        >
          {t.close}
        </button>
      </div>
    </Sheet>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function Chip({
  on,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
        on ? 'bg-ink-900 text-white' : 'bg-stone-100 text-stone-700'
      }`}
    >
      {children}
    </button>
  );
}

function FilterSheet({
  filter,
  lang,
  t,
  onChange,
  onClose,
}: {
  filter: MenuFilter;
  lang: MenuLanguage;
  t: UiText;
  onChange: (filter: MenuFilter) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={t.filterTitle} onClose={onClose}>
      <div className="p-5">
        <h2 className="text-lg font-black text-ink-900">{t.filterTitle}</h2>
        <h3 className="mt-4 text-xs font-black tracking-[0.14em] text-stone-500 uppercase">
          {t.onlyShow}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {DIET_TAGS.map((tag) => (
            <Chip
              key={tag}
              on={filter.diet.includes(tag)}
              onClick={() => onChange({ ...filter, diet: toggle<DietTag>(filter.diet, tag) })}
              testId={`diet-${tag}`}
            >
              {DIET_TAG_LABELS[tag][lang]}
            </Chip>
          ))}
        </div>
        <h3 className="mt-5 text-xs font-black tracking-[0.14em] text-stone-500 uppercase">
          {t.exclude}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {ALLERGENS.map((code) => (
            <Chip
              key={code}
              on={filter.excludeAllergens.includes(code)}
              onClick={() =>
                onChange({
                  ...filter,
                  excludeAllergens: toggle<Allergen>(filter.excludeAllergens, code),
                })
              }
              testId={`exclude-${code}`}
            >
              {ALLERGEN_LABELS[code][lang]}
            </Chip>
          ))}
        </div>
        <div className="mt-6 flex gap-2">
          <button
            onClick={() => onChange({ ...filter, diet: [], excludeAllergens: [] })}
            className="h-12 flex-1 rounded-2xl bg-stone-100 font-bold text-stone-700"
          >
            {t.clear}
          </button>
          <button
            onClick={onClose}
            className="h-12 flex-1 rounded-2xl bg-ink-900 font-bold text-white"
          >
            {t.done}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Loading({ t }: { t: UiText }) {
  return (
    <div className="min-h-screen" aria-busy="true" aria-label={t.loading}>
      <div className="h-24 bg-ink-900" />
      <div className="mx-auto max-w-xl space-y-3 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 animate-pulse rounded-2xl bg-white" />
        ))}
      </div>
    </div>
  );
}

function ErrorScreen({ t, error, onRetry }: { t: UiText; error: Error; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : 'NETWORK';
  const [title, body, retry] =
    code === 'TABLE_NOT_FOUND'
      ? [t.invalidTitle, t.invalidBody, false]
      : code === 'MENU_DISABLED'
        ? [t.disabledTitle, t.disabledBody, false]
        : code === 'MENU_NOT_PUBLISHED'
          ? [t.preparingTitle, t.preparingBody, true]
          : [t.networkTitle, t.networkBody, true];
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center" data-testid="menu-error" data-code={code}>
        <p className="text-lg font-black text-ink-900">{title}</p>
        <p className="mt-2 text-sm text-stone-600">{body}</p>
        {retry && (
          <button
            onClick={onRetry}
            className="mt-5 rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-bold text-white"
          >
            {t.retry}
          </button>
        )}
      </div>
    </div>
  );
}
