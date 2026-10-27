import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { startEngine } from './offline/engine';
import { startUpdates } from './offline/sw-update';
import UpdateBanner from './offline/UpdateBanner';
import { DialogProvider } from './components/DialogProvider';

const queryClient = new QueryClient({
  // networkMode 'always': offline'da query/mutation'lari DURAKLATMA. Offline yolu
  // read.ts (snapshot fallback) ve offline actions kendisi yonetir. OFFLINE_DESIGN.md §10
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});

// Baglanti izleme + outbox drain (istemci-offline). OFFLINE_DESIGN.md §10
startEngine(queryClient);
// Yeni surum acik tabletlere ulassin: periyodik yoklama + guvenli anda yenileme. OFF-7
startUpdates();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Onay/bilgi pencereleri (yerel alert/confirm yerine) tum ekranlarda ortak. */}
        <DialogProvider>
          <App />
          <UpdateBanner />
        </DialogProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
