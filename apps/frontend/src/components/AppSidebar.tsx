import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, hasPerm, logout } from '../lib/api';
import type { OfflineReview } from '../lib/types';
import { useDialogs } from './DialogProvider';
import { outboxCount } from '../offline/db';

type IconName =
  | 'tables'
  | 'cash'
  | 'customers'
  | 'finance'
  | 'products'
  | 'layout'
  | 'reports'
  | 'users'
  | 'settings'
  | 'warning'
  | 'logout';

interface NavItem {
  icon: IconName;
  label: string;
  path: string;
  perm?: string;
}

const ITEMS: NavItem[] = [
  { icon: 'tables', label: 'Masalar', path: '/' },
  { icon: 'cash', label: 'Kasa', path: '/cash', perm: 'cash.manage' },
  { icon: 'customers', label: 'Veresiye', path: '/customers', perm: 'debt.manage' },
  { icon: 'finance', label: 'Finans', path: '/finance', perm: 'finance.manage' },
  { icon: 'products', label: 'Ürünler', path: '/menu', perm: 'product.manage' },
  { icon: 'layout', label: 'Düzen', path: '/tables-admin', perm: 'table.manage' },
  { icon: 'reports', label: 'Raporlar', path: '/report', perm: 'report.view' },
  { icon: 'users', label: 'Ekip', path: '/users', perm: 'user.manage' },
  { icon: 'settings', label: 'Ayarlar', path: '/settings', perm: 'settings.manage' },
];

export default function AppSidebar() {
  const nav = useNavigate();
  const loc = useLocation();
  const { confirmDialog } = useDialogs();
  // Cikis (OFF-5): gonderilmemis cevrimdisi islem varsa garson bilerek cikar; islemler tablete
  // bir sonraki giriste OLUSTURANIN adina gider. Sunucudaki oturum da kapatilir.
  const signOut = async () => {
    const pending = await outboxCount().catch(() => 0);
    if (pending > 0) {
      const ok = await confirmDialog({
        title: 'Gönderilmemiş işlem var',
        message: `Bu tablette ana bilgisayara gönderilmemiş ${pending} işlem var. Çıkış yaparsanız bağlantı gelince (tablete biri giriş yaptığında) sizin adınıza gönderilir.`,
        confirmLabel: 'Çıkış yap',
      });
      if (!ok) return;
    }
    await logout();
    nav('/login', { replace: true });
  };
  // Onay bekleyen SIPARIS sayisi (bir siparisin kalemleri tek kart: OFF-2).
  const reviewCount = useQuery({
    queryKey: ['offline-reviews', 'count'],
    queryFn: async () =>
      new Set(
        (
          await api<(OfflineReview & { context?: { groupKey?: string } })[]>('/offline-reviews')
        ).map((r) => r.context?.groupKey ?? r.id),
      ).size,
    refetchInterval: 20_000,
    enabled: hasPerm('order.cancel'),
  });
  const items = ITEMS.filter(
    (item) =>
      !item.perm || hasPerm(item.perm) || (item.path === '/settings' && hasPerm('backup.manage')),
  );
  const active = (path: string) =>
    path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(path);

  return (
    <nav
      aria-label="Ana menü"
      className="order-2 z-20 flex h-20 w-full shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 bg-ink-900 px-2 py-2 print:hidden lg:order-none lg:h-full lg:w-24 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:border-r lg:border-t-0 lg:px-3 lg:py-4"
    >
      <button
        onClick={() => nav('/')}
        aria-label="Adisyon ana sayfa"
        className="mb-3 hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-500 text-lg font-black tracking-tight text-white shadow-lg shadow-emerald-950/20 lg:flex"
      >
        AO
      </button>
      {items.map((item) => (
        <SideButton
          key={item.path}
          icon={item.icon}
          label={item.label}
          active={active(item.path)}
          onClick={() => nav(item.path)}
        />
      ))}
      {hasPerm('order.cancel') && (reviewCount.data ?? 0) > 0 && (
        <SideButton
          icon="warning"
          label={`Onay (${reviewCount.data})`}
          active={active('/offline-reviews')}
          onClick={() => nav('/offline-reviews')}
          highlight
        />
      )}
      <SideButton
        icon="logout"
        label="Çıkış"
        onClick={() => void signOut()}
        className="lg:mt-auto"
      />
    </nav>
  );
}

function SideButton({
  icon,
  label,
  active,
  highlight,
  onClick,
  className = '',
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  highlight?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={`flex h-15 w-17 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl text-[10px] font-semibold leading-tight transition duration-150 lg:h-16 lg:w-full ${
        active
          ? 'bg-white text-ink-900 shadow-sm'
          : highlight
            ? 'bg-amber-400 text-amber-950'
            : 'text-stone-400 hover:bg-white/8 hover:text-white'
      } ${className}`}
    >
      <NavIcon name={icon} />
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

const ICONS: Record<IconName, string> = {
  tables: 'M4 5h6v6H4V5Zm10 0h6v6h-6V5ZM4 15h6v4H4v-4Zm10 0h6v4h-6v-4Z',
  cash: 'M4 7h16v11H4V7Zm0 3h16M8 14h3',
  customers:
    'M6 19v-1a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4v1M10.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16 6h4M18 4v4',
  finance: 'M5 19V9m7 10V5m7 14v-7M3 19h18',
  products: 'm4 8 8-4 8 4-8 4-8-4Zm0 0v8l8 4 8-4V8m-8 4v8',
  layout: 'M4 5h16v14H4V5Zm6 0v14m0-8h10',
  reports: 'M5 19V9m5 10V5m5 14v-7m5 7V7',
  users:
    'M4 19v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm11 8v-1a4 4 0 0 0-4-4h-1',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-11V2m0 20v-2.5M4.5 12H2m20 0h-2.5M5.2 5.2 3.4 3.4m17.2 17.2-1.8-1.8m0-13.6 1.8-1.8M3.4 20.6l1.8-1.8',
  warning: 'M12 4 3 20h18L12 4Zm0 6v4m0 3h.01',
  logout: 'M10 5H5v14h5m4-4 4-3-4-3m4 3H9',
};

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
