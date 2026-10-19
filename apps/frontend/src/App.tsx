import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { isAuthed, SESSION_EXPIRED_EVENT } from './lib/api';
import AppLayout from './components/AppLayout';
import LoginScreen, { type LoginRouteState } from './screens/LoginScreen';
import TablesScreen from './screens/TablesScreen';
import OrderScreen from './screens/OrderScreen';
import ReportScreen from './screens/ReportScreen';
import KasaScreen from './screens/KasaScreen';
import VeresiyeScreen from './screens/VeresiyeScreen';
import MenuScreen from './screens/MenuScreen';
import MasaScreen from './screens/MasaScreen';
import FinansScreen from './screens/FinansScreen';
import AyarlarScreen from './screens/AyarlarScreen';
import KullaniciScreen from './screens/KullaniciScreen';
import OfflineReviewScreen from './screens/OfflineReviewScreen';
import QrCodesScreen from './screens/QrCodesScreen';

function RequireAuth({ children }: { children: React.ReactNode }) {
  return isAuthed() ? <AppLayout>{children}</AppLayout> : <Navigate to="/login" replace />;
}

// Oturum gercekten bittiginde (lib/api.ts: /auth/refresh 401/403) kullanici hangi ekrandaysa
// hemen giris ekranina gecer; bayat ekran "donmus" gibi kalmaz.
function useSessionExpiryRedirect(): void {
  const nav = useNavigate();
  useEffect(() => {
    const onExpired = () => {
      const state: LoginRouteState = { sessionExpired: true };
      nav('/login', { replace: true, state });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [nav]);
}

export default function App() {
  useSessionExpiryRedirect();
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <TablesScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/orders/:id"
        element={
          <RequireAuth>
            <OrderScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/report"
        element={
          <RequireAuth>
            <ReportScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/cash"
        element={
          <RequireAuth>
            <KasaScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/customers"
        element={
          <RequireAuth>
            <VeresiyeScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/menu"
        element={
          <RequireAuth>
            <MenuScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/tables-admin"
        element={
          <RequireAuth>
            <MasaScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/finance"
        element={
          <RequireAuth>
            <FinansScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <AyarlarScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth>
            <KullaniciScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/offline-reviews"
        element={
          <RequireAuth>
            <OfflineReviewScreen />
          </RequireAuth>
        }
      />
      <Route
        path="/qr-codes"
        element={
          <RequireAuth>
            <QrCodesScreen />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
