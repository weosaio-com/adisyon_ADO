# DOMAIN_EVENTS.md — Domain Event Katalogu

> Sistemdeki her onemli is olayi bir **domain event** uretir. Bu dosya kanonik katalogdur:
> her event icin **amaci / yayinlandigi yer / dinleyen moduller**. Mekanizma: `EVENT_BUS.md`.

**Durum:** Sürüm 1.0 · **Oluşturuldu:** 2026-07-15 · **Tür:** Yaşayan doküman
İlgili: `EVENT_BUS.md`, `@ado/shared/events.ts` (kod sozlesmesi), `ROADMAP.md` (Tier A).

---

## İsimlendirme ve Zarf

- Ad kurali: **`entity.action`**, gecmis zaman ( or. `order.created`, `product.updated`).
- Ortak zarf (eventId/occurredAt/branchId/actorId/deviceId/correlationId/payload): `EVENT_BUS.md` §3.
- **Kural:** yeni event kodda `DomainEventName`e eklenince buraya da eklenir. Kod ve bu dosya ayrilmaz.

---

## Uygulanan Event'ler

### `category.created` / `category.updated` / `category.deleted`
- **Amaci:** Kategori olusturuldu, guncellendi (ad, sira, QR menu cevirisi, aktiflik) ya da
  soft-delete edildi.
- **Yayinlandigi yer:** `CatalogService.createCategory` / `updateCategory` / `deleteCategory`
  (post-commit; silmede payload silinmeden onceki durum).
- **Payload:** `{ categoryId, name }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. QR menu yayini (bulut baglantisi) menuyu yeniden
  gonderir.

### `product.created`
- **Amaci:** Yeni urun katalogda olusturuldu.
- **Yayinlandigi yer:** `CatalogService.createProduct` (post-commit).
- **Payload:** `{ productId, name, categoryId, salePrice }`.
- **Dinleyen moduller:** `EventLoggerSubscriber` (tumu). İleride: Cache invalidation, Dashboard, Sync.

### `product.updated`
- **Amaci:** Urun bilgisi/fiyati guncellendi; "tukendi" anahtari ya da gorsel degisti.
- **Yayinlandigi yer:** `CatalogService.updateProduct`, `setAvailability`, `setImage`,
  `clearImage` (post-commit).
- **Payload:** `{ productId, name, categoryId, salePrice }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Cache invalidation, Dashboard, Sync.
- **Not:** Ayri bir `price.changed` event'i, fiyat degisimini ozel izlemek gerekince eklenecek
  (su an fiyat guncellemesi bu event'e dahil).

### `product.deleted`
- **Amaci:** Urun soft-delete edildi.
- **Yayinlandigi yer:** `CatalogService.deleteProduct` (post-commit; payload silinmeden onceki durum).
- **Payload:** `{ productId, name, categoryId, salePrice }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Cache invalidation, Dashboard, Sync.

---

### `table.created`
- **Amaci:** Yeni masa tanimlandi (salon + kat plani).
- **Yayinlandigi yer:** `TablesService.createTable` (post-commit).
- **Payload:** `{ tableId, hallId, name }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Dashboard, canli masa katmani (WS), Sync.

### `table.updated`
- **Amaci:** Masa tanimi/konumu (posX/posY) guncellendi ya da QR menu kodu yenilendi.
- **Yayinlandigi yer:** `TablesService.updateTable`, `rotatePublicCode` (post-commit).
- **Payload:** `{ tableId, hallId, name }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Dashboard, canli masa katmani (WS), Sync.

### `table.deleted`
- **Amaci:** Masa soft-delete edildi.
- **Yayinlandigi yer:** `TablesService.deleteTable` (post-commit; payload silinmeden onceki durum).
- **Payload:** `{ tableId, hallId, name }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Dashboard, Sync.

> Not: Masa **durum** event'leri (`table.reserved`, `table.merged`, `table.moved`, occupied gecisi)
> siparise bagli oldugu icin Siparis modulunde eklenecek.

### `order.created`
- **Amaci:** Yeni adisyon acildi (masa varsa occupied'a gecti).
- **Yayinlandigi yer:** `OrdersService.openOrder` (post-commit).
- **Payload:** `{ orderId, orderNo, tableId?, status, grandTotal }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Dashboard, canli masa (WS), Sync, (mutfak yazdirma send ile).

### `order.item.added`
- **Amaci:** Adisyona kalem eklendi (fiyat/vergi snapshot alinmis).
- **Yayinlandigi yer:** `OrdersService.addItem` (post-commit).
- **Payload:** `{ orderId, orderItemId, productId, quantity, lineTotal }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Dashboard, Sync.

### `order.item.voided`
- **Amaci:** Kalem iptal edildi (void; Owner).
- **Yayinlandigi yer:** `OrdersService.voidItem` (post-commit).
- **Payload:** `{ orderId, orderItemId, productId, quantity, lineTotal }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: Audit ozel, Dashboard, Sync.

### `order.updated`
- **Amaci:** Adisyon toplamlari/durumu degisti (kalem ekle/sil/void, iptal).
- **Yayinlandigi yer:** `OrdersService` (addItem/updateItem/removeItem/voidItem/cancelOrder, post-commit).
- **Payload:** `{ orderId, orderNo, tableId?, status, grandTotal }`.
- **Dinleyen moduller:** `EventLoggerSubscriber`. İleride: canli masa (WS), Dashboard, Sync.

### `order.item.sent`
- **Amaci:** Bekleyen kalemler mutfaga/bara iletildi (hazirlik).
- **Yayinlandigi yer:** `OrdersService.sendToKitchen` (post-commit).
- **Payload:** `{ orderId, items: [{ orderItemId, productId, productName, quantity }] }`.
- **Dinleyen moduller:** `PrintingService` (mutfak fisi + Receipt kaydi).

### `order.paid`
- **Amaci:** Adisyona bir odeme alindi (append-only). Split/kismi odemede her odemede yayinlanir.
- **Yayinlandigi yer:** `PaymentsService.recordPayment` (post-commit).
- **Payload:** `{ orderId, paymentId, amount, method, customerId? }` (`customerId` yalniz veresiye).
- **Dinleyen moduller:** `CashService` (nakit hareketi), `CustomerService` (veresiye, `method='debt'`), `PrintingService` (fis). İleride: Dashboard, Sync.

### `order.refunded`
- **Amaci:** Bir odeme iade edildi (ters kayit). Adisyon kapaliysa ve tam odemenin altina duserse yeniden acilir.
- **Yayinlandigi yer:** `PaymentsService.reversePayment` (post-commit).
- **Payload:** `{ orderId, paymentId, originalPaymentId, amount, method, customerId? }`.
- **Dinleyen moduller:** `CashService` (nakit cikisi), `CustomerService` (veresiye borc geri alma).

> Not: `order.closed` / `receipt.printed` henuz yok; mutfak `order.item.sent` PR2'de.

## Planlanan Event'ler (modul gelince eklenecek)

Asagidakiler kod sozlesmesine (`DomainEventName`) ve bu katalogsa ilgili modul inşa edilirken
eklenecektir. Dinleyiciler sutunu hedeftir.

| Event | Yayinci (modul) | Muhtemel dinleyiciler |
|-------|-----------------|-----------------------|
| `order.created` | Sipariş | Printer(mutfak), Audit, Dashboard, Sync |
| `order.item.added` / `order.item.removed` | Sipariş | Dashboard, TimeMachine |
| `order.cancelled` | Sipariş | Audit, Dashboard, Sync |
| `order.closed` | Sipariş | Dashboard, Sync |
| `receipt.printed` | Yazdırma | Audit, TimeMachine |
| `price.changed` | Katalog | Audit, Cache invalidation, Dashboard |
| `debt.created` / `debt.paid` | Veresiye | Audit, Dashboard, Sync |
| `expense.created` / `income.created` | Gelir-Gider | Audit, Dashboard, Sync |
| `cash.opened` / `cash.closed` | Kasa | Audit, Dashboard, Sync |
| `customer.created` / `customer.updated` / `customer.deleted` | Müşteri | Cache, Dashboard, Sync |
| `table.merged` / `table.moved` / `table.reserved` | Masa | Dashboard, TimeMachine, Sync |
| `report.generated` | Rapor (plugin) | Audit |
| `user.logged_in` / `user.logged_out` | Kimlik | Audit, Monitoring |
| `printer.failed` / `printer.recovered` | Yazdırma | Monitoring, Notification |
| `sync.completed` / `sync.failed` | Sync (Faz 2) | Monitoring, Notification |
| `update.installed` | Güncelleme | Audit, Monitoring |

> Bu tablo **hedef**tir; her satir ilgili modul kodlanirken uygulanan bolume tasinir + payload'i tanimlanir.
