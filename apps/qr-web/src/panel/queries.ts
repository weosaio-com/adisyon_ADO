import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Me, PanelTable } from './types';

// Panelin ortak sorgulari; anahtarlar tek yerde (yenileme/iptal icin).
export const meQuery = queryOptions({
  queryKey: ['panel', 'me'],
  queryFn: () => api<Me>('/api/panel/me'),
  retry: false,
});

export const menuKey = (branchId: string) => ['panel', 'menu', branchId] as const;

export const tablesQuery = (branchId: string) =>
  queryOptions({
    queryKey: ['panel', 'tables', branchId],
    queryFn: () => api<PanelTable[]>(`/api/panel/branches/${branchId}/tables`),
  });
