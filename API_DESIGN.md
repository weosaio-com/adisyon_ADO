# API_DESIGN.md — API Tasarımı

> Faz 1 yerel backend'in (NestJS) REST + WebSocket sözleşmeleri. Tüm giriş/çıkışlar
> `packages/shared` içindeki **Zod** şemalarından türetilir (tek şema → backend validation + frontend tip).

**Durum:** ✅ Kabul (2026-07-13) · istemci-offline (Faz 1) uçları eklendi (2026-07-14) · **Sürüm:** 1.1 · **Son güncelleme:** 2026-07-14

---

## 1. Genel İlkeler

- **Taşıma:** HTTP/JSON (localhost + LAN). Canlı olaylar için **WebSocket**.
- **Base URL:** `http://<host>:<port>/api/v1` (sürümlü; kırıcı değişiklik `/v2`).
- **Kimlik:** JWT `Authorization: Bearer <access>` + refresh token (cihaz bazlı oturum).
- **Doğrulama:** her endpoint girişte Zod ile parse edilir; geçersizse `422`.
- **Yetki:** her endpoint'te guard + **permission key** kontrolü (frontend gizleme güvenlik değil — `SECURITY.md`).
- **Offline yazma (iki sınır):** (A) **Sunucu**: yazma istekleri **önce lokale** yazılır (gerçek yazma), yanıt döner; Faz 2'de ayrıca outbox'a düşer. (B) **Waiter tablet**: LAN koparsa mutasyonlar tarayıcı outbox'ında (IndexedDB) birikir, reconnect'te §5.11 uçlarıyla replay edilir. Detay: `OFFLINE_DESIGN.md`.
- **Idempotency:** para/kritik yazımlarda `Idempotency-Key` başlığı zorunlu (aşağıda).
- **Zaman:** tüm tarihler UTC ISO-8601.
- **Para:** tüm parasal alanlar **integer kuruş**. Miktar **int × 1000**.

---

## 2. Ortak Yanıt Zarfı

**Başarılı:**
```json
{ "success": true, "data": { ... }, "meta": { "requestId": "01J...", "serverTime": "2026-07-13T12:00:00Z" } }
```

**Hata:**
```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_EXCEEDS_TOTAL",
    "message": "Ödeme tutarı adisyon toplamını aşıyor.",
    "details": [ { "field": "amount", "issue": "too_large" } ],
    "requestId": "01J..."
  }
}
```

İsteğe bağlı `error.data`: hatanın bağlamı (ör. `TABLE_HAS_OPEN_ORDER` için
`{ "orderId": "01J..." }`); istisnanın `code`/`message`/`details` dışındaki alanları yalnız burada
döner. `422 VALIDATION_ERROR`'da `message` ilk sorunun şemada verilmiş (Türkçe) mesajıdır; şema
mesaj vermediyse genel "Doğrulama hatası." döner, tüm sorunlar `details`'te kalır. Gövde
ayrıştırıcı hataları: `413 PAYLOAD_TOO_LARGE` (genel sınır 100 KB, `/sync/mutations` 1 MB),
`400 BAD_JSON`, `415 UNSUPPORTED_MEDIA_TYPE`.

**HTTP kodları:** `200/201` başarı · `400` iş kuralı · `401` kimlik yok · `403` yetki yok ·
`404` bulunamadı · `409` çakışma/versiyon · `413` gövde çok büyük · `422` şema doğrulama ·
`429` rate limit · `500` sunucu · `503` veritabanı meşgul (`DB_BUSY`, tekrar denenebilir).

**Sayfalama (liste uçları):** `?cursor=<ulid>&limit=50` → `data: [...]`, `meta.nextCursor`.
(ULID sıralı olduğu için cursor tabanlı; offset yok.)

---

## 3. Idempotency (Kritik Yazımlar)

- Zorunlu olduğu uçlar: **ödeme alma/iade, kasa hareketi, veresiye hareketi, sipariş kapatma**.
- İstemci `Idempotency-Key: <ulid>` gönderir. Sunucu bu anahtarı saklar:
  - İlk kez → işlenir, sonuç anahtarla eşlenir.
  - Aynı anahtar tekrar → **işlem tekrar edilmez**, ilk sonuç döner (§8 sözleşme: aynı işlem iki kez işlenmez).
- Bu, hem ağ tekrarını hem Faz 2 sync tekrarını kapsar (aynı `idempotency_key` DB'de unique).
- **Toplu offline replay (Faz 1):** Waiter tabletinin biriken mutasyonları `POST /sync/mutations` ile toplu gelir; her mutasyon kendi `clientOpId` (ULID) anahtarını taşır — `Idempotency-Key` başlığının batch içi karşılığıdır. Sunucu `ProcessedClientOp` defterinde dedup eder (§5.11).

---

## 4. Kimlik & Oturum

| Metot | Yol | Açıklama | Erişim |
|---|---|---|---|
| POST | `/auth/login` | Owner: `username`+`password` | herkes |
| POST | `/auth/login-pin` | Waiter: `pin` (+ `deviceId`) | herkes |
| POST | `/auth/refresh` | refresh → yeni access | oturum |
| POST | `/auth/logout` | oturumu iptal et | oturum |
| GET | `/auth/me` | mevcut kullanıcı + izinler | oturum |

- Başarısız girişler `users.failed_login_count` artırır; eşik aşımında `locked_until` (brute-force koruması).
- PIN girişi rate-limit + gecikmeli (Waiter kolay tahmin edilmesin).
- **Token ömrü role bağlı:** Owner access ~15 dk (ana makine hep bağlı). **Waiter access 12 saat** (tam vardiya; tablet offline'dayken oturum mesai ortasında kilitlenmez), refresh 30 gün (cihaz bazlı, `sessions`). Reconnect'te sessiz yenileme. Bkz. `OFFLINE_DESIGN.md §12`.

---

## 5. Ana Kaynak Uçları (özet)

> Her kaynak REST CRUD kalıbı izler; **yalnızca kurala özel/önemli** uçlar burada detaylanır.

### 5.1 Katalog
- `GET/POST/PATCH/DELETE /products` · `/categories` · `/brands` · `/units` · `/taxes` · `/discounts`
- `DELETE` = **soft delete** (`deleted_at`). Fiyat değişikliği **audit**'e yazılır.
- `GET /products?favorite=true` (hızlı satış ekranı), `?barcode=<x>` (okuyucu).
- **QR menü alanları** _(uygulandı 2026-09)_: ürüne `description`, `allergens` (AB'nin 14 alerjeni),
  `dietTags`, `translations.en.{name,description}`, `isAvailable`, `imagePath`; kategoriye
  `translations`. Şema ve sınırlar ortak: `@ado/shared/menu` (`QR_MENU_DESIGN.md`).
- `PATCH /products/:id/availability` `{ isAvailable }` — "tükendi": ürün listede kalır, siparişe
  eklenemez (`409 PRODUCT_UNAVAILABLE`) (`product.manage`)
- `POST /products/:id/image` (gövde `application/octet-stream`; JPEG/PNG/WebP, en fazla 1 MB, dosya
  imzası kontrol edilir; ad = içerik özeti `sha256.uzantı`) · `DELETE /products/:id/image`
  (`product.manage`). Arayüz yüklemeden önce 800 px WebP'ye küçültür.
- `GET /catalog/images/:file` — oturumsuz; dosya adı içerik özeti olduğundan süresiz önbellek.

### 5.2 Masa & Salon
- `GET/POST/PATCH/DELETE /halls` · `/tables`
- `POST /tables/:id/merge` `{ targetTableId }` — birleştir
- `POST /tables/:id/move` `{ toTableId }` — adisyonu taşı
- `POST /tables/:id/split` `{ items:[...] }` — adisyon böl
- `PATCH /tables/:id/status` `{ status }` — boş/temizleniyor vb.
- Masada `publicCode`: QR menüdeki masa kodu (16 karakter base32, tahmin edilemez) _(uygulandı 2026-09)_
- `POST /tables/:id/public-code` — kodu yeniler; masadaki eski QR çalışmaz (`table.manage`, **audit**)

### 5.3 Sipariş / Adisyon
- `POST /orders` `{ tableId? }` → adisyon aç (order_no üretir)
- `GET /orders/:id` · `GET /orders?status=open`
- `POST /orders/:id/items` `{ productId, quantity(int×1000), note? }` → satır ekle
- `PATCH /orders/:id/items/:itemId` `{ quantity }` — adet değiştir (**audit**)
- `DELETE /orders/:id/items/:itemId` `{ reason }` — satır iptal (**audit**, `void_reason`)
- `POST /orders/:id/items/:itemId/send` — mutfağa/kasaya gönder (print job)
- `POST /orders/:id/hold` / `POST /orders/:id/resume` — beklet / tekrar aç
- `POST /orders/:id/discount` `{ type, value, reason }` — adisyon indirimi
  - Waiter > %10 ise `403 DISCOUNT_APPROVAL_REQUIRED` → Owner onayı gerekir
- `POST /orders/:id/cancel` `{ reason }` — adisyon iptal (Owner) (**audit**)
- `PUT /orders/:id/items/:itemId/note` `{ note }` — gönderilmemiş kaleme tek garson notu; boş → silinir, gönderilmiş kalem `409` (**audit**) _(uygulandı 2026-09)_
- `POST /orders/:id/discard` — aktif kalemi ve ödemesi olmayan adisyonu kapatır, masayı boşaltır (`order.create`; dolu adisyon `409 ORDER_NOT_EMPTY`) _(uygulandı 2026-09)_

### 5.4 Ödeme (append-only)
- `POST /orders/:id/payments` `{ method, amount, received? }` **(Idempotency-Key zorunlu)**
  - Parçalı: birden çok kez çağrılır; `409 PAYMENT_EXCEEDS_TOTAL` aşımda
  - Yanıt: `{ payment, change, orderPaidStatus }`
- `POST /orders/:id/payments/:pid/refund` `{ reason }` — iade = ters kayıt (Owner) **(Idempotency-Key)**
- `POST /orders/:id/close` — adisyonu kapat (tam ödendiyse) **(Idempotency-Key)**

### 5.5 Kasa
- `POST /cash/sessions/open` `{ openingFloat }` (Owner)
- `POST /cash/sessions/:id/close` `{ countedAmount }` → `difference` hesaplar (Owner) **(Idempotency-Key)**
- `GET /cash/sessions/current` · `POST /cash/transactions` `{ type, amount, note }`

### 5.6 Müşteri & Veresiye
- `GET/POST/PATCH /customers`
- `GET /customers/:id/statement` — cari ekstre (JSON; PDF için `?format=pdf`)
- `POST /customers/:id/debt` `{ type: debt_add|payment, amount, note }` **(Idempotency-Key)** — append-only

### 5.7 Finans / Stok
- `POST /expenses` · `/incomes` · `/expense-categories`
- `GET/POST /suppliers` · `/purchases` (+ items)
- `POST /stock/movements` `{ productId, type, quantity }` — append-only
- `GET /stock/levels` · `GET /stock/low` (min stok altı)

### 5.8 Yazdırma
- `GET/POST/PATCH /printers` · `POST /printers/:id/test` — test çıktısı
- `POST /printers/:id/discover` — cihaz keşfi (sürücü eklentisi)
- `GET /print-jobs?status=failed` · `POST /print-jobs/:id/retry` — kuyruk yönetimi
  - _Uygulanan (2026-09):_ `GET /printers/discover` (Windows `Get-Printer`), `GET /printers/jobs?status=` (son 24 saat, önizleme metniyle), `POST /printers/jobs/:id/retry`, `DELETE /printers/jobs/:id` (yalnız başarısız fiş), `POST /printers/test-print/:id`
- `POST /printers/order/:id/receipt` — ödenmiş adisyonun müşteri fişini yeniden basar (`payment.take`; ödenmemiş `409`) _(uygulandı 2026-09)_
- (Fiş üretimi çoğunlukla sipariş/ödeme akışında **otomatik** print job oluşturur.)

### 5.9 Raporlar (eklenti tabanlı)
- `GET /reports` — registry'deki mevcut rapor eklentileri (menüye otomatik)
- `GET /reports/:reportId/schema` — Zod parametre şeması (filtre formu)
- `POST /reports/:reportId/run` `{ params }` → veri (renderer'a göre tablo/grafik)
- `POST /reports/:reportId/export` `{ params, format: pdf|excel|csv }`

### 5.10 Sistem
- `GET/PATCH /settings` — application_settings (Owner)
- `GET/PUT /settings/business` `{ name, address?, phone? }` — fiş başlığı (şube bilgisi) (`settings.manage`, **audit**) _(uygulandı 2026-09)_
- `GET /audit-logs?action=&entityType=&from=&to=&cursor=` — filtre/arama (Owner) · `?format=csv` export
- `GET /license` · `POST /license/activate` `{ licenseKey }` — lisans durumu ve anahtar girişi
  (`license.manage`, **audit** `license.activate`). `GET /license` mevcut alanlara ek olarak
  politikayı döner: `phase` (`trial` · `unlicensed` · `active` · `expiring` · `grace` · `locked`),
  `locked`, `lockAt`, `trialEndsAt`, `remoteState` (bulutun bildirdiği), `reason`, `graceDays`,
  `banner` (`{ level, daysLeft, until }`), `supportContact`. Kilit yalnız **yeni adisyonu** durdurur
  (`403 LICENSE_LOCKED`); açık adisyon ödenir/kapanır, rapor, yedek, ayar her zaman açıktır.
  Ayrıntı: `LICENSING.md` §8. _(politika 2026-10)_
- `GET /updates/status` · `POST /updates/check` · `POST /updates/approve` `{ version }` — otomatik
  güncelleme (`update.manage`; onay yalnız kasa bilgisayarından, açık adisyon/kasa yokken; önce
  `pre_update` yedeği). Yalnız masaüstü programında çalışır; ayrıntı `UPDATE_SYSTEM.md`.
  _(uygulandı 2026-10)_
- `GET/POST /plugins` · `POST /plugins/:id/enable|disable` (yükleme/kaldırma **audit**)
- `POST /backups` · `GET /backups` · `POST /backups/:id/restore` (Owner). Yeni yedekler sıkıştırılmış
  akış biçimindedir (`format: 2`); eski biçim (`1`) açılmaya devam eder. Akıllı saklama ve
  değişiklik yoksa günlük yedeğin atlanması: `STORAGE.md`. _(2026-10)_
- `GET /cloud-backups/status` · `POST /cloud-backups/upload-now` · `PUT /cloud-backups/settings`
  `{ enabled }` — otomatik bulut yedeği: son yükleme, bekleyen, hata; şimdi yükle; aç/kapat
  (`backup.manage`). İlk kurulumda (kullanıcı yokken, yalnız kasa bilgisayarından)
  `POST /cloud-backups/setup/list` `{ licenseKey }` ve `POST /cloud-backups/setup/restore`
  `{ licenseKey, cloudBackupId, recoveryKey }` buluttan geri yükler. Bulut tarafı
  (`/api/pos/backups/*`) ve saklama/kota: `CLOUD_BACKUP.md`. _(2026-10)_
- `GET /storage` · `POST /storage/cleanup` — veritabanı/yedek/görsel/log boyutu, boş disk, son
  temizlik; elle temizlik (`backup.manage`, temizlik **audit**). _(2026-10)_
- `GET /health` — canlılık: yalnız veritabanına bakar, disk dolu olsa da 200 döner (masaüstü
  açılışı ve CI buna bağlı). Disk bilgisi `GET /storage`'dadır. _(2026-10)_
- `GET /sync/status` — çevrimiçi/çevrimdışı/bekleyen kayıt sayısı (Faz 2 bulut sync; Faz 1 stub)

### 5.11 İstemci-Offline Senkron (Faz 1) — Waiter tablet ⇄ yerel sunucu

> Faz 2 bulut sync'ten (§5.10 `/sync/status`) **ayrı** bir sınırdır. Detay: `OFFLINE_DESIGN.md`.

- `GET /sync/health` — hafif bağlanabilirlik yoklaması (heartbeat). `navigator.onLine` güvenilmez;
  gerçek erişilebilirliği bu belirler. Yanıt: `{ serverTime }` (küçük).
- `POST /sync/mutations` — tabletin biriken outbox'ını **toplu + idempotent** işler.
  - Gövde: `{ deviceId, mutations: [ { clientOpId, type, payload, baseVersion? } ] }`
  - `type`: `OFFLINE_DESIGN.md §5.1` (OPEN_TABLE | ADD_LINE | UPDATE_LINE_QTY | ADD_NOTE | SUBMIT_ORDER)
  - Her mutasyon **online yolla ortak domain servisini** çağırır; `clientOpId` `ProcessedClientOp`'ta dedup edilir.
  - Yanıt: `{ results: [ { clientOpId, status, serverId?, serverVersion?, reviewId?, reason? } ], serverTime }`
    - `status`: `applied | duplicate | conflict | rejected` (`OfflineMutationResult`)
    - `conflict` → `PendingOfflineReview` kaydı (`reviewId`, `reason`: `table_closed|table_moved|product_inactive`) → Owner onayı
- `GET /sync/snapshot` — reconnect sonrası **tek istekte** aktif durum: açık masalar + adisyon başlıkları + katalog/fiyat özeti. Cache'i tazeler. (Delta/cursor YOK — Faz 1 kararı; Faz 2'ye bırakıldı.)
- **Owner review uçları:**
  - `GET /offline-reviews?status=open` — bekleyen çakışmalar (Owner)
  - `POST /offline-reviews/:id/resolve` `{ resolution: yeni_adisyon|yeniden_ac|reddet }` — çöz (Owner, **audit**)

**Reconnect akışı:** `/sync/health` OK → `POST /sync/mutations` (push) → `GET /sync/snapshot` (pull) → WS'e dön.

### 5.12 Bulut Bağlantısı ve QR Menü (POS → bulut) _(uygulandı 2026-09; lisansla bağlanma 2026-10; her lisanslı kurulum 2026-10)_

> Bulutun kendi API'si (müşteri menüsü, satıcı, `/api/pos/*`) ve kararlar: `QR_MENU_DESIGN.md`.
> Bulut adresi programa gömülüdür (derleme profili → `CLOUD_API_URL`); kullanıcı adres ya da kod
> girmez. Bağlanma imzalı lisansla olur (`LICENSING.md`). **Bağlantı ile QR menü ayrıdır:** lisans
> numarası (`id`) olan her lisans buluta kendiliğinden bağlanır (son görülme, sürüm, sağlık,
> lisans yenileme, uzaktan askı/iptal); QR menü bu bağlantı üzerinde ayrı bir anahtardır.

- `GET /cloud/status` — kartların tek kaynağı:
  - `link`: `unconfigured` · `no_license` · `legacy_license` (lisans numarası yok) · `linking` ·
    `waiting_network` · `conflict` (lisans başka bilgisayarda bağlı) · `lost` (satıcı ya da başka
    bilgisayar bağlantıyı aldı; neden `lostReason`) · `error` (bulut reddetti; seyrek yeniden
    denenir) · `linked` · `suspended` · `expired` · `revoked`.
  - `qr`: `off` · `on` · `not_licensed`; `qrPublish` (kullanıcının seçimi), `unpublishPending`.
  - `connected`, `remoteState` (bulutun son bildirdiği lisans durumu), `lastSeenAt`,
    `lastHeartbeatAt`, `linkError`, `blocked` (bulut yayını neden reddediyor), işletme/şube/paket,
    `licenseExpiresAt`, `conflictLastSeenAt`, son yayın zamanı ve menü sürümü, `publishing`, son hata.
  - Eski `mode` alanı kaldırıldı.
- `POST /cloud/activate` `{ takeover?: boolean }` — "şimdi bağlan": bağlı değilse lisansla bağlanır
  (`POST /api/pos/activate`), bağlıysa hemen heartbeat gönderir. Lisans numarası yoksa
  `403 LICENSE_ID_REQUIRED`. Lisans başka kurulumda bağlıysa `link: conflict`; sahibin onayıyla
  `takeover: true` devralır (diğer bilgisayarın bağlantısı `superseded` olur). Otomatik devralma yoktur.
- `PUT /cloud/qr` `{ enabled: boolean }` — QR menüyü aç/kapat. Kapatınca bulutta menü ve masalar
  yayından kalkar (`POST /api/pos/menu/unpublish`), **bağlantı kalır**; internet yoksa kapatma
  bağlantı gelince tamamlanır. Açmak lisansta `qr.menu` ister.
- `POST /cloud/publish` — şimdi yayınla. QR menü kapalıysa `409 QR_MENU_OFF`, bağlantı yoksa
  `409 CLOUD_NOT_CONNECTED`.
- `DELETE /cloud/connection` — eski sürümlerle uyum için "QR menüyü kapat" ile aynı.
- Hepsi `settings.manage`; QR açma/kapatma denetim kaydına yazılır (`cloud.qr.enable`,
  `cloud.qr.disable`).
- **Kendiliğinden bağlanma:** açılışta, lisans girilince (`license.activated`) ve her uzlaştırmada;
  yalnız ana şube. 0.3.0'dan yükseltmede bağlantı varsa QR menü açık kabul edilir ve lisans bir kez
  buluta gönderilir (lisans kaydı eski işletmeleri bilmez).
- **Heartbeat** (`CLOUD_HEARTBEAT_SECONDS`, varsayılan 3600; açılışta ve bağlanınca hemen):
  `POST /api/pos/heartbeat` gövdesi `InstallMetricsService`'ten (veritabanı ve yedek boyutu, boş
  disk, son yedek, son bulut yedeği) + sürüm + lisans numarası ve bitişi. Yanıtla bağlantı bilgileri
  tazelenir ve `license.remote` olayı yayınlanır (bulut kaydında daha geç bitişli imzalı lisans
  varsa `update` alanıyla). Eski Worker'da (`404`) `GET /status`'a düşer.
- **Otomatik yayın:** `product.*`, `category.*`, `table.*`, `hall.*` ve `branch.updated` olayları
  şube başına 5 sn birleştirilen `cloud.publish` işini kuyruğa alır; iş eksik görselleri yükler,
  menüyü ve masa listesini gönderir. Arka plan işi 3 kez dener (5 sn, 10 sn arayla).
- **Uzlaştırma** (`CLOUD_RECONCILE_SECONDS`, varsayılan 300 sn): son yayın başarısızsa ya da menü
  son yayından beri değiştiyse yeniden yayınlar (uzun internet kesintisi, kaçan olay); bekleyen
  bağlanmayı, QR kapatmayı ve lisans yenilemesini (`license.activated` → `PUT /api/pos/license`,
  belirteç değişmez) tamamlar; heartbeat zamanı geldiyse (yayın engelliyken her turda) gönderir.
- **Bulut hataları:** `401` bağlantıyı yerelde kaldırır (`mode: lost`, neden kartta); `403`
  (`TENANT_SUSPENDED`, `LICENSE_EXPIRED`, `QR_MENU_NOT_LICENSED`) yayını durdurur, belirteç korunur,
  engel kalkınca yayın kendiliğinden sürer.
- **Açılış denetimi:** kayıtlı bağlantı başka kurulumun yedeğinden geldiyse, gömülü bulut adresi ya da
  lisans kimliği değiştiyse bağlantı düşer ("QR menüyü aç" yeniden gerekir).

---

## 6. WebSocket (Canlı Durum)

- Yol: `ws://<host>:<port>/realtime` (JWT ile el sıkışma).
- **Amaç:** Owner ve Waiter istemcileri arasında anlık senkron (garson ekler → kasa görür).
- **Odalar:** `branch:<id>`, opsiyonel `table:<id>`.

**Sunucu → istemci olayları:**
| Olay | Yük |
|---|---|
| `table.updated` | `{ tableId, status }` |
| `order.updated` | `{ orderId, status, grandTotal }` |
| `order.item.added` / `order.item.voided` | `{ orderId, itemId }` |
| `payment.recorded` | `{ orderId, paidStatus }` |
| `print.job.failed` | `{ jobId, printerId }` |
| `sync.status.changed` | `{ online, pending }` (Faz 2) |

> İlke: WebSocket **bildirimdir**, kaynak-doğru veri REST'ten çekilir (event geldi → ilgili kaydı invalidate et — TanStack Query).

> **Faz 1 istemci-offline:** WS kopması bir bağlantı-kopması sinyalidir → tablet offline moduna geçer, mutasyonlar outbox'a düşer. Bağlantı tespiti WS + `GET /sync/health` iledir (§5.11). `sync.status.changed` olayı Faz 2 bulut sync içindir.

---

## 7. Owner / Waiter Yetki Matrisi

| Alan | Owner | Waiter |
|---|:---:|:---:|
| Giriş | şifre | PIN |
| Masa görüntüle / aç | ✅ | ✅ |
| Sipariş ekle/çıkar/adet/not | ✅ | ✅ |
| Siparişi mutfağa gönder | ✅ | ✅ |
| İndirim ≤ %10 | ✅ | ✅ |
| İndirim > %10 / adisyon iptal | ✅ | ❌ (onay ister) |
| Ödeme alma / iade | ✅ | ❌ |
| Kasa aç/kapa | ✅ | ❌ |
| Veresiye hareketi | ✅ | ❌ |
| Ürün / fiyat yönetimi | ✅ | ❌ |
| Raporlar | ✅ | ❌ |
| Denetim kaydı | ✅ | ❌ |
| Ayarlar / yazıcı / lisans / güncelleme / yedek | ✅ | ❌ |

> Matris **permission key**'lerle uygulanır (ör. `payment.take`, `order.cancel`, `report.view`).
> Roller veri; ileride Müdür/Kasiyer eklemek yeni izin ataması demektir (`CONVENTIONS.md` §2).

---

## 8. Hata Kodları (ilk küme)

| Kod | Anlam |
|---|---|
| `VALIDATION_FAILED` | Zod şema hatası (422) |
| `UNAUTHORIZED` / `FORBIDDEN` | kimlik / yetki |
| `INVALID_TOKEN` / `SESSION_EXPIRED` | access token geçersiz ya da oturum kapanmış (401): istemci `/auth/refresh` dener; yalnız refresh de 401/403 verirse oturum kapanır ve giriş ekranına gidilir |
| `DB_BUSY` | veritabanı geçici olarak meşgul (503; örn. yedek alınırken SQLite kilidi, Prisma zaman aşımı): oturum kapanmaz, istemci birkaç saniye sonra tekrar dener |
| `DISCOUNT_APPROVAL_REQUIRED` | Waiter %10 üstü indirim → Owner onayı |
| `PAYMENT_EXCEEDS_TOTAL` | ödeme adisyon kalanını aşıyor |
| `ORDER_ALREADY_CLOSED` | kapalı adisyona işlem |
| `CASH_SESSION_NOT_OPEN` | açık kasa oturumu yok |
| `VERSION_CONFLICT` | `version` uyuşmazlığı (409, iyimser kilit) |
| `IDEMPOTENCY_REPLAY` | aynı anahtar — ilk sonuç döndü (bilgi) |
| `LICENSE_INVALID` | lisans anahtarı geçersiz ya da bu kurulumda doğrulanamıyor |
| `LICENSE_LOCKED` | lisans yok, süresi ve ek süresi doldu ya da uzaktan askıya alındı/iptal edildi: yeni adisyon açılamaz (403); çevrimdışı `OPEN_TABLE` aynı nedenle reddedilir |
| `PRINTER_UNAVAILABLE` | yazıcı yok/kapalı → iş kuyruğa alındı |
| `PRODUCT_UNAVAILABLE` | tükenen ürün siparişe eklenemez (409) |
| `IMAGE_TOO_LARGE` / `IMAGE_TYPE_INVALID` | ürün görseli 1 MB üstü (413) / JPEG-PNG-WebP değil |
| `CLOUD_NOT_CONNECTED` / `CLOUD_URL_INVALID` | QR menü bulutuna bağlı değil / geçersiz bulut adresi |
| `CLOUD_ERROR` | buluta ulaşılamadı ya da beklenmeyen yanıt (502); bulutun kendi hata kodu varsa o iletilir |
| `QR_MENU_NOT_LICENSED` | lisans QR menüyü kapatmış |

---

## 9. Sözleşme Üretimi

- Tek kaynak: `packages/shared/schemas/*.ts` (Zod).
- Backend: DTO = `z.infer<typeof Schema>`; controller girişte `.parse()`.
- Frontend: aynı şema form doğrulama (React Hook Form + Zod resolver) + tip.
- (Opsiyonel ileride) OpenAPI, Zod şemalarından üretilir → `API.md` yaşayan dokümanına işlenir.

---

## 10. Sonraki Adım

Bu tasarım onaylanınca sıra (§18): **6) Backend çekirdeği** — ama ondan **önce** somut kod adımı olarak
**`schema.prisma` + ilk migration** üretilir (bu ilk **kod** çıktısıdır ve ayrıca onaylanacak).
İlk dikey dilim hedefi (L1): **Kimlik/Yetki → Ürün → Masa → Sipariş → Ödeme → Yazdırma.**
