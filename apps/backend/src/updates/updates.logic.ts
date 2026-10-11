/** Guncelleme kurulumunun saf kurallari (updates.logic.selfcheck.ts). */

export type UpdateBlockerCode = 'NOT_LOCAL' | 'OPEN_ORDERS' | 'CASH_OPEN';
export interface UpdateBlocker {
  code: UpdateBlockerCode;
  message: string;
}

/**
 * Kurulumu engelleyenler (CONVENTIONS F1): acik adisyon ya da acik kasa varken zorlanmaz; onay yalniz
 * kasa bilgisayarindan verilir (program kapanip yeniden acilir, tabletler bunu goremez).
 */
export function updateBlockers(input: {
  local: boolean;
  openOrders: number;
  cashOpen: boolean;
}): UpdateBlocker[] {
  const blockers: UpdateBlocker[] = [];
  if (!input.local) {
    blockers.push({
      code: 'NOT_LOCAL',
      message: 'Güncelleme yalnız kasa bilgisayarından onaylanabilir.',
    });
  }
  if (input.openOrders > 0) {
    blockers.push({
      code: 'OPEN_ORDERS',
      message: `${input.openOrders} açık adisyon var; önce kapatın.`,
    });
  }
  if (input.cashOpen) {
    blockers.push({
      code: 'CASH_OPEN',
      message: 'Kasa açık; önce gün sonunu yapıp kasayı kapatın.',
    });
  }
  return blockers;
}

/** Onaylanan guncellemenin acilistaki sonucu: surum yeni surumse kuruldu, degilse kurulamadi. */
export function approvalOutcome(toVersion: string, currentVersion: string): 'applied' | 'failed' {
  return currentVersion === toVersion ? 'applied' : 'failed';
}
