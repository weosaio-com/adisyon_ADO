// Offline okuma: API'yi dene, kopukse son snapshot cache'inden dondur. OFFLINE_DESIGN.md §4.3, §7.2
// Kalici hata (oturum bitti, yetki, gecersiz istek) snapshot'in arkasina gizlenmez: react-query
// hatayi tasir, oturum bittiyse uygulama giris ekranina gecer (lib/api.ts). Gecici sunucu hatasinda
// (503 DB_BUSY, 5xx) snapshot varsa o gosterilir, yoksa hata (bos ekran yerine "Tekrar dene").
import { api, ApiError, isConnectivityError } from '../lib/api';
import { cachedSnapshot } from './engine';
import type { Category, Hall, Order, Product, Table } from '../lib/types';

interface Snapshot {
  halls: Hall[];
  tables: Table[];
  orders: Order[];
  categories: Category[];
  products: Product[];
}

async function read<T>(path: string, fromSnapshot: (snapshot: Snapshot | undefined) => T) {
  try {
    return await api<T>(path);
  } catch (error) {
    if (!(error instanceof ApiError) || !error.retryable) throw error;
    const snapshot = await cachedSnapshot<Snapshot>();
    if (!snapshot && !isConnectivityError(error)) throw error;
    return fromSnapshot(snapshot);
  }
}

export function readHalls(): Promise<Hall[]> {
  return read('/halls', (s) => s?.halls ?? []);
}

export function readTables(): Promise<Table[]> {
  return read('/tables?active=true', (s) => s?.tables ?? []);
}

export function readOpenOrders(): Promise<Order[]> {
  return read('/orders?open=true', (s) => (s?.orders ?? []).filter((o) => o.status === 'open'));
}

export function readHeldOrders(): Promise<Order[]> {
  return read('/orders?status=held', (s) => (s?.orders ?? []).filter((o) => o.status === 'held'));
}

export function readCategories(): Promise<Category[]> {
  return read('/categories', (s) => s?.categories ?? []);
}

export function readProducts(): Promise<Product[]> {
  return read('/products?active=true', (s) => s?.products ?? []);
}
