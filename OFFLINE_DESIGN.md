# OFFLINE_DESIGN.md — İstemci (Waiter Tablet) Offline Tasarımı

> Kod öncesi zorunlu tasarım dokümanı (§16). Garson tabletlerinin LAN/WiFi bağlantısı
> kopukken bile sipariş alabilmesini, işlemleri **lokalde kalıcı** tutmasını ve bağlantı
> gelince **kayıpsız + çakışmasız** senkronlanmasını tanımlar.

**Durum:** ✅ Kabul edildi (2026-07-14) · **Sürüm:** 1.0 · **Son güncelleme:** 2026-07-14
> Açık noktalar (§17), kullanıcının "en optimize / düşük maliyetli / kullanıcı dostu şekilde sen karar ver" yetkisiyle karara bağlandı.

---

## 0. Karar Özeti (bu dokümanda sabitlenen)

| # | Konu | Karar |
|---|------|-------|
| K1 | Offline kapsam | **Sadece Waiter tablet ve telefonları** (yüklenebilir PWA). Ana makine = sunucu + SQLite (zaten offline). |
| K2 | Offline işlemler | Masa aç · kalem ekle/çıkar (gönderilmemiş taslakta) · adet/not · **siparişi gönder**. |
| K3 | Offline OLMAYAN işlemler | Ödeme, kasa, indirim>%10, iade, masa birleştir/böl, **kayıt silme (Owner, sunucuda)**. Arayüz: bağlantı yokken **Ödeme al** pasif ve nedeni yazılır (`pay-offline-hint`). |
| K4 | Çakışma politikası | **Akıllı birleştirme** (append-only merge; kapalı/ödenmiş masa → Owner review). |
| K5 | İstemci kalıcılık | Tablet tarayıcısında **IndexedDB outbox** + Service Worker (PWA). |
| K6 | Idempotency | Her mutasyon **ULID `clientOpId`** taşır; sunucu dedup eder (replay güvenli). |
| K7 | Zaman | Sunucu zamanı esastır; istemci saati yalnız sıralama/gösterim (ULID monotonic). |

---

## 1. Amaç ve Kapsam

### 1.1 İki farklı "offline" sınırını ayır (kritik)

Projede **iki bağımsız senkron sınırı** vardır; karıştırılmamalıdır:

| Katman | Sınır | Faz | Nerede tutulur | Durum |
|--------|-------|-----|----------------|-------|
| **A — Bulut offline** | Yerel sunucu → Cloud API | Faz 2 | Sunucu SQLite (`SyncQueue`, `Conflict`) | Şemada var, ileride |
| **B — İstemci/LAN offline** | Waiter tablet → **yerel sunucu** | **Faz 1** | **Tablet tarayıcısı (IndexedDB)** | **Bu doküman** |

Bu doküman **yalnızca B katmanını** tasarlar. B, sunucu şemasına küçük eklerle destek verir
ama asıl kuyruk **tarayıcı içinde** yaşar. İki katman aynı idempotency prensibini paylaşır
(clientOpId uçtan uca taşınır) → Faz 2'de yeniden yazım yok.

### 1.2 Neden gerekli

- Ana makine (Owner/kasa) sunucunun kendisidir → LAN'a bağımlı değildir, zaten offline çalışır.
- **Asıl kırılganlık garson tabletleridir:** WiFi/AP dalgalanması, ölü nokta, router reboot →
  garson sipariş alamaz veya girdiği kaybolur. Ticari üründe bu kabul edilemez.
- Hedef: **tablet bağlantısı kopsa bile garson kesintisiz sipariş alsın**, veri tablette
  kalıcı dursun, bağlantı gelince otomatik ve güvenli senkronlansın.

### 1.3 Kapsam sınırı

- **Kapsamda:** Waiter tabletlerinin sipariş **ekleme/düzenleme/gönderme** akışı offline.
- **Kapsam dışı (bilinçli):**
  - Ödeme / kasa / finans → **her zaman Owner + sunucu** (offline yapılmaz, tablette finans verisi tutulmaz).
  - Kayıt **silme/iptal/iade** → Owner girişi, sunucuda (K3). Tablet offline'da persist edilmiş
    kaydı silmez; yalnız **gönderilmemiş taslak satırını** düzenleyebilir (bkz. §5.3).
  - Owner ana makinesinin offline'ı → gereksiz (sunucunun kendisi).

---

## 2. Terminoloji

- **Draft (Taslak adisyon):** Garsonun tablette hazırladığı, henüz "Gönder" denmemiş sipariş.
  Serbestçe kalem eklenir/çıkarılır; sunucuya **henüz yazılmaz**.
- **Mutation (Mutasyon):** Sunucu durumunu değiştirecek atomik, tekrar-güvenli komut
  (ör. `OPEN_TABLE`, `ADD_LINE`, `SUBMIT_ORDER`). Draft "Gönder" ile mutasyona dönüşür.
- **Outbox:** Tabletteki, gönderilmeyi bekleyen mutasyonların **kalıcı FIFO kuyruğu** (IndexedDB).
- **clientOpId:** Her mutasyona tablette üretilen **ULID**; sunucuda idempotency anahtarı.
- **baseVersion:** Mutasyonun dayandığı sunucu varlık sürümü (çakışma tespiti için).
- **Reconciliation:** Reconnect'te outbox'ın sunucuya işlenip sonuçların istemciye uygulanması.
- **Pending Review:** Otomatik uygulanamayan (çakışan) offline mutasyonun Owner onayına düşmesi.

---

## 3. Mimari Genel Bakış

```
   [ Waiter Tablet — Tarayıcı (PWA) ]
   ┌───────────────────────────────────────────────┐
   │  React UI (optimistic)                         │
   │      │                                          │
   │  ┌───▼─────────────┐   online   ┌───────────┐  │
   │  │ Sync Engine     │──────────► │ REST / WS │──┼──► Yerel Sunucu
   │  │ (state machine) │◄────────── │  client   │  │    (NestJS + SQLite)
   │  └───┬─────────────┘   pull      └───────────┘  │
   │      │ persist                                   │
   │  ┌───▼───────────────────────────────────────┐  │
   │  │ IndexedDB:  outbox · drafts · cache · meta │  │  ← kalıcı, tablet
   │  └───────────────────────────────────────────┘  │    kapansa bile durur
   │  Service Worker: app-shell cache (çevrimdışı açılış)│
   └───────────────────────────────────────────────┘
```

- Tablet istemcisi **PWA**'dır: Service Worker uygulama kabuğunu (HTML/JS/CSS) cache'ler →
  offline'da bile **uygulama açılır**. Veri katmanı IndexedDB'dir.
- **Güvenli bağlam şartı (2026-09 eki):** Service Worker yalnız HTTPS veya localhost'ta çalışır.
  Tablet uygulamayı LAN IP'sinden (`http://192.168.x.x`) açtığında SW API'si hiç yoktur: IndexedDB
  outbox sayfa açıkken çalışır ama bağlantı yokken yenileme/yeniden açma başarısız olur. Bu yüzden
  backend `API_TLS_PORT` ile ek bir **yerel HTTPS** portu açar (kurulum başına yerel CA, tabletlere
  bir kez kurulur; `GET /devices/ca.crt`). Doğrulama: `apps/frontend/e2e/https-lan.spec.ts`
  (LAN IP + HTTPS'te güvenli bağlam, SW kontrolü ve çevrimdışı yenileme).
- **Online yol:** mutasyon anında REST/WS ile sunucuya gider, sonuç uygulanır (bugünkü davranış).
- **Offline yol:** aynı mutasyon outbox'a yazılır, UI **optimistic** günceller, bağlantı
  gelince Sync Engine kuyruğu sırayla boşaltır.
- Sunucu tarafı **hiçbir zaman istemcinin online olduğunu varsaymaz**; tüm yazma uçları
  idempotent ve `baseVersion` farkındadır → online/offline aynı kod yolunu kullanır.

---

## 4. İstemci Veri Modeli (IndexedDB)

Tek bir IndexedDB veritabanı: `ado-offline` (versiyonlu şema). Object store'lar:

### 4.1 `outbox` — bekleyen mutasyonlar (FIFO)
```jsonc
{
  "clientOpId": "01J...ULID",   // PK, ULID (monotonic → doğal sıra)
  "type": "ADD_LINE",           // OPEN_TABLE | ADD_LINE | UPDATE_LINE_QTY | ADD_NOTE | SUBMIT_ORDER
  "payload": { /* §5 */ },
  "baseVersion": 3,             // dayanılan sunucu varlık version'ı (biliniyorsa)
  "dependsOn": ["01J...OPEN"],  // sıralı bağımlılık (ör. ADD_LINE, OPEN_TABLE'a bağlı)
  "deviceId": "01J...DEV",
  "waiterId": "01J...USR",
  "clientCreatedAt": 1720900000000, // istemci monotonic; yalnız sıralama/gösterim
  "status": "pending",          // pending | inflight | applied | conflict | rejected
  "retryCount": 0,
  "lastError": null
}
```

### 4.2 `drafts` — gönderilmemiş taslak adisyonlar
Masaya ait, henüz mutasyona dönüşmemiş satırlar. Serbest düzenlenir; "Gönder" → outbox'a çevrilir.

### 4.3 `cache` — okuma snapshot'ı (offline gösterim için)
Masalar/salonlar, ürün+kategori+fiyat, aktif adisyon başlıkları. `pull` ile tazelenir; **TTL**'li.
Amaç: offline açılışta garsonun masa/ürün listesini görebilmesi.

### 4.4 `meta` — cihaz ve senkron durumu
`deviceId` (ilk kayıtta üretilir, `devices` tablosuna kaydedilir), `lastPullCursor`,
`authToken` cache (kısa ömür), `clockOffset` (sunucu-istemci fark tahmini), `schemaVersion`.

> **Not:** IndexedDB seçildi (localStorage değil): büyük/yapısal veri, transaction, indeksleme
> ve tablet kapanınca kalıcılık gerekir. Erişim `idb` benzeri ince sarmalayıcı ile.

---

## 5. Mutasyon Modeli

### 5.1 Offline-capable mutasyon türleri
| Tür | Anlam | Bağımlılık |
|-----|-------|-----------|
| `OPEN_TABLE` | Masayı aç / adisyon başlat | — |
| `ADD_LINE` | Adisyona ürün satırı ekle | OPEN_TABLE |
| `UPDATE_LINE_QTY` | Gönderilmiş satır adedini artır (append delta) | ADD_LINE |
| `ADD_NOTE` | Satıra/adisyona not | OPEN_TABLE/ADD_LINE |
| `SUBMIT_ORDER` | Kalemleri mutfağa/kasaya ilet (kur) | ADD_LINE(ler) |

### 5.2 Fiyat snapshot'ı (POS kuralı)
Satır oluşurken **o anki cache fiyatı, KDV oranı, ürün adı satıra yazılır** (append-only).
Böylece offline sırasında fiyat değişse bile adisyon tutarlıdır; fark Owner raporunda görünür.
(Zaten genel POS kuralı: satır kendi fiyatını taşır.)

### 5.3 Draft düzenleme vs. persist edilmiş silme (K3 uyumu)
- **Gönderilmemiş** taslak satırı çıkarmak = mutasyon değil, sadece `drafts` düzenlemesi
  (hiç sunucuya gitmedi) → serbest, offline tam çalışır.
- **Gönderilmiş** bir satırı iptal/void = **kayıt silme** → Owner yetkisi, sunucuda yapılır (K3).
  Garson tablette bunu offline yapamaz; talep ederse "Owner onayı gerekir" mesajı.

### 5.4 Atomiklik
Bir "Gönder" tek REST çağrısında **atomik grup** olarak gider (OPEN_TABLE + N×ADD_LINE +
SUBMIT). Sunucu ya hepsini uygular ya da grubu reddeder → yarım adisyon oluşmaz.

---

## 6. Idempotency ve Sıralama

- **clientOpId (ULID)** her mutasyonun kimliğidir. Sunucu bir `ProcessedClientOp` defterinde
  (append-only) bunu tutar. Aynı clientOpId ikinci kez gelirse **yeniden işlemez**, ilk sonucu
  döndürür → retry/çift gönderim güvenli.
- **Sıra:** Aynı tabletin outbox'ı **FIFO** işlenir; `dependsOn` bağımlılıkları korunur
  (OPEN_TABLE, ADD_LINE'dan önce). ULID monotonic olduğundan sıralama doğaldır.
- **Neden ULID:** offline üretim, cihazlar arası çakışmasız, zaman-sıralı — `CONVENTIONS.md`
  kararıyla uyumlu.
- **Refresh/çökme sonrası:** outbox IndexedDB'de kalıcı → uygulama yeniden açılınca
  `inflight` kalmış kayıtlar tekrar `pending`'e alınır, dedup sunucuda korur.

---

## 7. Senkron Protokolü (API uçları)

> Bu uçlar `API_DESIGN.md`'ye eklenecek (onay sonrası). Hepsi kimlik + yetki + Zod validasyonlu.

### 7.1 `POST /sync/mutations` — toplu itme (push)
İstek:
```jsonc
{
  "deviceId": "01J...DEV",
  "mutations": [ { "clientOpId": "...", "type": "...", "payload": {...}, "baseVersion": 3 } ]
}
```
Yanıt (her mutasyon için ayrı sonuç):
```jsonc
{
  "results": [
    { "clientOpId": "...", "status": "applied",   "serverId": "01J...", "serverVersion": 4 },
    { "clientOpId": "...", "status": "duplicate",  "serverId": "01J...", "serverVersion": 4 },
    { "clientOpId": "...", "status": "conflict",   "reviewId": "01J...", "reason": "TABLE_CLOSED" },
    { "clientOpId": "...", "status": "rejected",   "reason": "PRODUCT_INACTIVE" }
  ],
  "serverTime": "2026-07-14T10:00:00.000Z"
}
```
Sonuç işleme (istemci): `applied|duplicate` → outbox'tan sil, optimistic'i gerçekle;
`conflict` → "Owner onayında" işaretle, garsona bilgi; `rejected` → hata göster, kullanıcıya sun.

### 7.2 `GET /sync/snapshot` — aktif durum anlık görüntüsü (server→tablet)
**Maliyet optimizasyonu (karar):** Faz 1 veri kümesi küçük (10-40 masa, birkaç yüz adisyon/gün)
olduğundan delta/cursor mekanizması **kullanılmaz** — gereksiz karmaşıklık ve bakım maliyeti.
Reconnect akışı: (1) `POST /sync/mutations` outbox'ı iter → (2) `GET /sync/snapshot` aktif masalar +
açık adisyon başlıkları + katalog/fiyat özetini **tek istekte** çeker, cache'i tazeler → (3) WS'e döner.
Cursor tabanlı artımlı çekme bilinçli olarak **Faz 2'ye** bırakıldı (orada `SyncStateRecord` kullanılır).

### 7.3 `GET /sync/health` — hafif bağlantı yoklaması (heartbeat)
`navigator.onLine` güvenilmez (AP'ye bağlı ama sunucu erişilemez olabilir). Uygulama seviyesinde
periyodik `sync/health` ping'i gerçek bağlanabilirliği belirler.

### 7.4 Canlı kanal
Online iken WebSocket ile anlık; offline'da WS kopar, Sync Engine REST replay'e düşer.
Reconnect'te önce `POST /sync/mutations` (push), sonra `GET /sync/pull` (pull), sonra WS'e döner.

---

## 8. Çakışma Çözümü — Akıllı Birleştirme (K4)

Reconnect'te sunucu her mutasyonu hedef varlığın **güncel durumuna** göre değerlendirir:

| Durum | Sunucu davranışı |
|-------|------------------|
| Masa **açık**, adisyon uygun | **Merge:** offline satırları ekle (append-only). `status: applied`. |
| `baseVersion` eski ama satır ekleme (append) | Merge — satır ekleme çakışmaz, sürüm ilerletilir. |
| Masa **kapanmış / ödenmiş** | Otomatik uygulama **YOK** → `conflict (TABLE_CLOSED)` → **Owner Review**. |
| Masa **silinmiş / taşınmış / birleştirilmiş** | `conflict (TABLE_MOVED)` → Owner Review (hedefe yönlendirme önerisi). |
| Ürün **pasif / silinmiş** | `rejected (PRODUCT_INACTIVE)` → garsona bildir (fiyat snapshot varsa Owner review opsiyonu). |
| Aynı clientOpId tekrar | `duplicate` (idempotency). |

**Neden merge güvenli:** sipariş satırları append-only; iki garson aynı masaya offline eklese
bile ikisi de eklenir, Owner tek adisyonda görür. Üzerine yazma yok → veri kaybı yok.

**Owner Review akışı (kapalı/ödenmiş masa):** Owner ekranında bekleyen offline kalem listelenir;
Owner: **(a)** yeni adisyon aç ve kalemleri taşı · **(b)** kapalı adisyonu yeniden aç ve ekle ·
**(c)** reddet. Her seçim audit'e yazılır (offline kaynaklı, clientOpId ile izlenebilir).

---

## 9. Sunucu Tarafı Değişiklikleri

> Bunlar ayrı bir **şema increment**'i (onay sonrası). Mevcut `SyncQueue/Conflict` **değişmez**
> (onlar Faz 2 bulut katmanı). Aşağıdakiler Faz 1 istemci-offline içindir.

### 9.1 Yeni tablo: `ProcessedClientOp` (idempotency defteri, append-only)
`clientOpId (PK, ULID)` · `deviceId` · `mutationType` · `resultRef` (oluşan varlık) ·
`resultStatus` · `appliedAt`. Sadece Owner görür; audit destekler.

### 9.2 Yeni tablo: `PendingOfflineReview` (çakışma kuyruğu)
`id (ULID)` · `deviceId` · `waiterId` · `clientOpId` · `mutationPayload (JSON)` ·
`reason (enum)` · `status (open|resolved|rejected)` · `resolvedBy` · `resolvedAt` + SyncBase alanları.

### 9.3 Mevcut modellere ek
- `OrderLine` (ve ilgili yazma varlıkları): opsiyonel **`clientOpId`** alanı (izlenebilirlik +
  ek dedup). SyncBase'de zaten `version`, `device_id` var.
- `AuditLog` kaydına: `origin=offline`, `clientOpId`, `clientCreatedAt`, `serverAppliedAt`.

### 9.4 Idempotency guard
Tüm yazma uçlarını saran interceptor: gövdede `clientOpId` varsa `ProcessedClientOp`'a bakar;
işlenmişse önceki sonucu döner, değilse işler ve deftere yazar (aynı DB transaction'ında).

---

## 10. İstemci Durum Makinesi

```
        health OK / WS up
   ┌───────────────────────────► ONLINE ──────────┐
   │                               │ fetch fail /  │ outbox boş
   │                               ▼ WS down       │ & pull tamam
 SYNCING ◄──── reconnect ──── OFFLINE               │
   │  push+pull                    ▲                 ▼
   │  bitti, çakışma var           │ health fail   ONLINE
   └──────────► DEGRADED ──────────┘  (bekleyen review)
```

- **ONLINE:** normal; mutasyonlar anında gider.
- **OFFLINE:** mutasyonlar outbox'a; UI optimistic; kırmızı/sarı rozet + bekleyen sayısı.
- **SYNCING:** reconnect'te push→pull sırası; ilerleme göstergesi.
- **DEGRADED:** senkron bitti ama çakışan (review'a düşen) mutasyon var → garsona/Owner'a bildir.
- Bağlantı tespiti: `navigator.onLine` **yetersiz**; asıl sinyal `sync/health` ping + fetch/WS sonucu.

---

## 11. UX Kuralları

- **Optimistic UI:** offline eklenen kalem anında görünür, üzerinde "⏳ senkron bekliyor" rozeti;
  onaylanınca rozet kalkar.
- **Her zaman görünür bağlantı durumu:** yeşil (online) / sarı (senkronlanıyor) / kırmızı (offline)
  + bekleyen mutasyon sayısı. `SYSTEM_ANALYSIS.md §12` "bağlantı her zaman görünür" kuralıyla uyumlu.
- **Çakışma mesajı:** garsona net Türkçe ("Bu masa kapatılmış, kalemleriniz Owner onayına gönderildi").
- **Kayıpsızlık garantisi:** tablet kapansa/yenilense/pili bitse bile outbox IndexedDB'de kalıcı.
- Offline'da yetkisiz alanlar (ödeme/kasa) zaten gizli/kilitli (yetki modeli).

---

## 12. Güvenlik ve Bütünlük

- **Kimlik:** offline mutasyon JWT/Waiter-PIN oturumuyla ilişkilidir. Token süresi offline'da
  dolarsa: mutasyon yerelde birikir; reconnect'te önce token yenilenir, sonra gönderilir.
  → **Karar:** Waiter **erişim token'ı 12 saat** (tam vardiyayı kapsar), **refresh token 30 gün**;
  offline'da mesai ortasında oturum **kilitlenmez**. Reconnect'te token sessizce yenilenir, sonra
  outbox gönderilir. (Sayısal değerler `SECURITY.md` ile hizalanacak.)
- **Replay/taklit:** `ProcessedClientOp` dedup + sunucu-tarafı yetki + `baseVersion` kontrolü.
- **Yerel veri hassasiyeti:** tablette **finans verisi tutulmaz**; yalnız katalog/masa cache +
  kendi taslakları. Cihaz kaybında hasar sınırlı.
- **Audit:** offline kaynaklı her kayıt audit-log'a `origin=offline` + zaman çifti + clientOpId ile
  yazılır (append-only, hash-zinciri — `CONVENTIONS.md`/`AUDIT_LOG.md`).

---

## 13. Zaman / Saat Sapması

İstemci saati güvenilmez. **Sunucu zamanı esastır** (`server_created_at`). İstemci zamanı yalnız
outbox sıralaması ve geçici gösterim içindir. `meta.clockOffset` sunucu yanıtından tahmin edilir.
Sıralama garantisi ULID'in monotonic üretimiyle sağlanır (saat geri gitse bile counter ilerler).

---

## 14. Kenar Durumlar

| Senaryo | Davranış |
|---------|----------|
| Uzun offline (saatler) | Outbox büyür, sorun değil (kalıcı). Cache TTL dolarsa gösterim "bayat" işaretlenir. |
| İki tablet aynı masaya offline ekler | İkisi de merge (append); Owner tek adisyonda görür. |
| Aynı mutasyon iki kez gönderilir (retry) | `duplicate` → tek kez uygulanır. |
| Fiyat offline'da değişti | Satır **snapshot fiyatı** taşır; sunucu kabul eder; fark Owner raporunda. |
| Ürün pasifleşti/silindi | `rejected (PRODUCT_INACTIVE)`; garsona bildir, gerekirse Owner review. |
| Tablet storage dolu | **%80** kullanımda uyarı + "önce gönder"; **%95**'te yeni offline mutasyon engellenir (net mesaj). Sipariş almayı bundan önce asla bloklamaz. |
| Kısmi push başarısı | Uygulanan mutasyon outbox'tan silinir, kalanı `pending` kalır, tekrar denenir. |
| Yenileme sırasında `inflight` | Açılışta `pending`'e geri alınır; dedup çift uygulamayı önler. |

---

## 15. Test Stratejisi

Risk-tabanlı + kritik modül CI kapısı (`CONVENTIONS.md §7`):
- Ağ kesme/geri gelme simülasyonu (Playwright offline modu).
- Çift gönderim / retry → idempotency (dedup) doğrulaması.
- Çakışma senaryoları: kapalı masa, taşınmış masa, pasif ürün → doğru `conflict/rejected`.
- Uzun offline + çoklu tablet aynı masa → merge doğruluğu.
- Storage limiti, refresh-sırasında-inflight, saat sapması.
- Audit: offline kaydın `origin/clientOpId/zaman-çifti` ile doğru yazılması.

---

## 16. Faz 2 ile İlişki

İki katman **aynı idempotency omurgasını** paylaşır:
`Tablet →(clientOpId)→ Yerel Sunucu →(SyncQueue, clientOpId taşınır)→ Cloud`.
Böylece bir kalem uçtan uca (tablet → yerel → bulut) tek kimlikle izlenir; Faz 2'de yeniden
tasarım gerekmez. `SYNCERROR`/`Conflict` (Faz 2) ile `PendingOfflineReview` (Faz 1) ayrı ama
benzer modellerdir; kavramlar bilinçli olarak paraleldir.

---

## 17. Kararlar (kullanıcı yetkisiyle karara bağlandı)

Önceki açık noktalar **en optimize / düşük maliyetli / kullanıcı dostu** yönde sonuçlandırıldı:

| # | Konu | Karar | Gerekçe |
|---|------|-------|---------|
| A | Waiter offline oturum (§12) | Access **12s**, refresh **30g**; mesai ortasında kilit yok | Tam vardiya kapsanır, kullanıcı dostu, sıfır ek karmaşıklık |
| B | Cache/storage (§14) | Cache offline'da süresiz kullanılır (eskiyse "bayat" rozeti); storage %80 uyar / %95 engelle | Sipariş almayı asla bloklamaz; basit sabitler |
| C | Çekme mekanizması (§7.2) | Delta/cursor YOK → outbox push + **tek seferlik snapshot refetch** | Küçük veri kümesi; koca bir alt-sistem elenir, her zaman taze |
| D | Review modeli (§9.2) | `PendingOfflineReview` **ayrı model** | Faz 1/Faz 2 katman ayrımı temiz kalır |
| E | Kod yolu | Online + offline replay **aynı domain servislerini** kullanır | Paralel kod yok, bakım maliyeti düşük |

**Sıra (uygulanıyor):**
1. `OFFLINE_DESIGN.md` → ✅ Kabul (bu sürüm).
2. **Şema increment:** `ProcessedClientOp`, `PendingOfflineReview`, `Order.clientOpId`, `OrderItem.clientOpId`, `AuditLog.origin/clientOpId`. ← *bu adımda*
3. `API_DESIGN.md`'ye `/sync/*` uçları + idempotency guard sözleşmesi.
4. Planlı **backend çekirdeği** (Kimlik/Yetki + seed) bu offline-farkında sözleşmeyle inşa edilir.
5. Frontend Sync Engine + IndexedDB katmanı (dikey dilim: Masa→Sipariş offline ile).

> Her adımda önce plan sunulur, onay beklenir. Onaysız kod yazılmaz.
