// Backend yanit sekilleri (Faz-1 kullanilan alt kume).
import type { Allergen, DietTag, MenuTranslations } from '@ado/shared/menu-core';

export interface Hall {
  id: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface Table {
  id: string;
  hallId: string;
  name: string;
  status: string; // empty | occupied | ...
  seats?: number;
  isActive?: boolean;
  publicCode?: string | null; // QR menu masa kodu (/m/<kod>)
}

export interface OrderItemNote {
  id: string;
  note: string;
  type: string; // waiter | kitchen
}

export interface OrderItem {
  id: string;
  productId: string;
  productNameSnapshot: string;
  quantity: number; // milis
  lineTotal: number; // kurus
  status: string; // pending | sent | ...
  notes?: OrderItemNote[];
}

export interface Discount {
  id: string;
  type: string; // percent | amount
  value: number; // percent: yuzde; amount: kurus
  amount: number; // hesaplanmis indirim (kurus)
  reason?: string | null;
}

export interface Order {
  id: string;
  orderNo: string;
  tableId: string | null;
  table?: { id: string; name: string; hall?: { name: string } } | null;
  type?: string; // dine_in | takeaway | delivery
  status: string; // open | held | completed | cancelled
  grandTotal: number; // kurus
  subtotal: number;
  discountTotal: number;
  items: OrderItem[];
  discounts?: Discount[];
}

export interface Payment {
  id: string;
  amount: number; // kurus; iade satiri da pozitif, yonu direction belirtir
  direction?: string; // charge | refund
  method: string; // cash | card | transfer | qr | debt
}

export interface CashTransaction {
  id: string;
  type: string; // opening | sale | refund | payout | income | expense | adjustment | closing
  amount: number; // kurus (+/-)
  method: string;
  note?: string | null;
  createdAt: string;
}

export interface CashSession {
  id: string;
  openingFloat: number; // kurus
  status: string; // open | closed
  businessDay: string;
  openedAt: string;
  transactions: CashTransaction[];
  countedAmount?: number; // kapanista
  expectedAmount?: number;
  difference?: number; // sayilan - beklenen
}

export interface DebtTransaction {
  id: string;
  type: string; // debt_add | payment
  amount: number; // kurus (+borc, -tahsilat)
  note?: string | null;
  occurredAt: string;
}

export interface DebtAccount {
  id: string;
  balance: number; // kurus (guncel borc)
  transactions?: DebtTransaction[];
}

export interface Customer {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  debtAccount?: DebtAccount | null;
}

export interface Category {
  id: string;
  name: string;
  sortOrder?: number;
  translations?: MenuTranslations;
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  salePrice: number; // kurus
  unitId?: string;
  taxId?: string;
  isActive?: boolean;
  isFavorite?: boolean;
  // QR menu alanlari
  description?: string | null;
  allergens?: Allergen[];
  dietTags?: DietTag[];
  translations?: MenuTranslations;
  isAvailable?: boolean; // false = tukendi (listede kalir, siparise eklenemez)
  imagePath?: string | null; // gorsel anahtari -> catalogImageUrl()
}

export interface Unit {
  id: string;
  name: string;
  abbreviation?: string | null;
}

export interface Tax {
  id: string;
  name: string;
  ratePermille: number; // binde: %10 -> 100
  isDefault?: boolean;
}

export interface ExpenseCategory {
  id: string;
  name: string;
}

export interface Expense {
  id: string;
  categoryId: string;
  amount: number; // kurus
  description?: string | null;
  spentAt: string;
}

export interface Income {
  id: string;
  category?: string | null;
  amount: number; // kurus
  description?: string | null;
  receivedAt: string;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface Backup {
  id: string;
  type: string; // auto | manual | pre_update | imported
  sizeBytes: number;
  createdAt: string;
}

// Cakisan offline mutasyonun Owner onay kaydi. OFFLINE_DESIGN.md §9.2
export interface OfflineReview {
  id: string;
  deviceId: string;
  waiterId: string;
  clientOpId: string;
  mutationType: string; // OfflineMutationType
  mutationPayload: string; // JSON (TEXT)
  reason: string; // table_closed | table_moved | product_inactive | other
  status: string; // open | resolved | rejected
  createdAt: string;
}

export interface Printer {
  id: string;
  name: string;
  driverId: string; // windows-spooler | escpos-mock
  connection: string;
  address: string | null; // Windows'taki yazici adi
  paperWidth: number; // 58 | 80
  isDefault: boolean;
  isActive: boolean;
}

export interface PrintRoute {
  id: string;
  documentType: string; // kitchen | bar | customer
  printerId: string;
  categoryId: string | null; // null -> genel rota
}

export interface DiscoveredPrinter {
  driverId: string;
  name: string;
  connection: string;
  address: string;
}

export interface PrintJobRow {
  id: string;
  documentType: string;
  status: string; // queued | printing | done | failed
  attempts: number;
  lastError: string | null;
  createdAt: string;
  printedAt: string | null;
  printerName: string;
  summary: string;
  text: string; // yaziciya giden metin (onizleme)
}
