import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import CustomerMenu from './customer/CustomerMenu';
import { pickLanguage } from './lib/menu-view';
import { UI } from './lib/i18n';

// Panel ayri parca: masadaki QR'dan gelen musteri panel kodunu indirmez.
const PanelApp = lazy(() => import('./panel/PanelApp'));

export default function App() {
  return (
    <Routes>
      <Route path="/m/:code" element={<CustomerMenu />} />
      <Route
        path="/panel/*"
        element={
          <Suspense
            fallback={<p className="p-8 text-center text-sm text-stone-500">Yükleniyor…</p>}
          >
            <PanelApp />
          </Suspense>
        }
      />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}

// Kok adres: QR'siz gelen ziyaretciye yol gosterir.
function Home() {
  const t = UI[pickLanguage(['tr', 'en'], navigator.languages ?? [], null)];
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <p className="text-2xl font-black text-ink-900">{t.homeTitle}</p>
        <p className="mt-2 text-sm text-stone-600">{t.homeBody}</p>
        <Link to="/panel" className="mt-6 inline-block text-xs font-semibold text-stone-400">
          {t.homePanel}
        </Link>
      </div>
    </div>
  );
}
