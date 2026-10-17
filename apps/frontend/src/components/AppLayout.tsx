import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import AppSidebar from './AppSidebar';
import ErrorBoundary from './ErrorBoundary';
import LicenseBanner from './LicenseBanner';
import LicenseLockDialog from './LicenseLockDialog';

// Kimlik doğrulanmış ekranların ortak kabuğu: kalıcı sol nav + içerik alanı.
// Ekranlar kendi başlıklarını içerik alanında render eder.
// ErrorBoundary yalnız içerik alanını sarar: bir ekran çökse de sol menü ayakta
// kalır, kullanıcı başka ekrana geçebilir. key=path -> rota değişince sıfırlanır.
// Lisans şeridi içeriğin üstündedir (söylenecek bir şey yoksa görünmez); lisans penceresi
// 403 LICENSE_LOCKED ya da şerit düğmesiyle açılır.
export default function AppLayout({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-stone-100 lg:flex-row">
      <AppSidebar />
      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-none">
        <LicenseBanner />
        <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">
          <ErrorBoundary key={loc.pathname}>{children}</ErrorBoundary>
        </div>
      </div>
      <LicenseLockDialog />
    </div>
  );
}
