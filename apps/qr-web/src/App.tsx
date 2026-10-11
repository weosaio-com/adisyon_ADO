import { Route, Routes } from 'react-router-dom';
import CustomerMenu from './customer/CustomerMenu';
import { pickLanguage } from './lib/menu-view';
import { UI } from './lib/i18n';

export default function App() {
  return (
    <Routes>
      <Route path="/m/:code" element={<CustomerMenu />} />
      <Route path="/panel/*" element={<Notice kind="panelGone" />} />
      <Route path="*" element={<Notice kind="home" />} />
    </Routes>
  );
}

// Kok adres QR'siz gelen ziyaretciye yol gosterir; eski panel adresi (ana ekrana eklenmis panel
// uygulamasi dahil) panelin kalktigini soyler. Eski panelin service worker'i public/sw.js ile silinir.
function Notice({ kind }: { kind: 'home' | 'panelGone' }) {
  const t = UI[pickLanguage(['tr', 'en'], navigator.languages ?? [], null)];
  const [title, body] =
    kind === 'home' ? [t.homeTitle, t.homeBody] : [t.panelGoneTitle, t.panelGoneBody];
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center" data-testid={`notice-${kind}`}>
        <p className="text-2xl font-black text-ink-900">{title}</p>
        <p className="mt-2 text-sm text-stone-600">{body}</p>
      </div>
    </div>
  );
}
