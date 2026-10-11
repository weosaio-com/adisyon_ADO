# QR_MENU_DESIGN.md — QR Menü (QR-1: Dijital Menü)

> Müşteri masadaki QR kodu telefonuyla okutur, işletmenin menüsünü görür: fotoğraf, açıklama,
> alerjen, diyet etiketleri, TR/EN, "tükendi". Menü **yalnız Adisyon programından** (POS) yönetilir
> ve programdan kendiliğinden yayınlanır. Program buluta imzalı lisansıyla bağlanır; ayrı bir hesap,
> işletme paneli ya da eşleştirme kodu yoktur.
>
> Kapsam QR-1: yalnız menü. Sipariş (QR-2), uzaktan ödeme ve hesap bölme (QR-3), oyunlar ve şans
> çarkı (QR-4) sonraki aşamalardır; paket altyapısı şimdiden bunları taşır.

---

## 1. Parçalar

```
 Adisyon programı (POS, işletmede)          Bulut (Cloudflare, tek Worker)            Telefon
 ┌───────────────────────────────┐   HTTPS  ┌──────────────────────────────────┐    ┌───────────────┐
 │ apps/backend  cloud modülü    │ ───────▶ │ apps/cloud  (Hono)               │◀── │ /m/<masa kodu>│
 │  - lisansla aç (Ayarlar kartı)│  Bearer  │  /api/pos/*   POS yayını         │    │  müşteri menü │
 │  - otomatik yayın (5 sn)      │  token   │  /api/admin/* satıcı (ADMIN_TOKEN)│    └───────────────┘
 │  - uzlaştırma (kaçan yayın)   │          │  /api/m/:code, /img/:key  genel  │
 │  - masa QR yazdırma           │          │  D1 (SQLite)  R2 (görseller)     │
 └───────────────────────────────┘          │  statik: apps/qr-web/dist (SPA)  │
                                            └──────────────────────────────────┘
```

| Paket | Görev |
|---|---|
| `packages/shared` → `@ado/shared/menu` | Menü anlık görüntüsünün zod şeması (POS ve bulut aynı doğrulamayı kullanır), masa listesi, görsel anahtarı. `@ado/shared/license`: lisans biçimi. |
| `@ado/shared/menu-core` | Bağımlılıksız sabitler ve yardımcılar (14 alerjen, diyet etiketleri, sınırlar, `menuText`, görsel imzası). Tarayıcı paketine yalnız bu girer; zod ve ulid girmez. |
| `apps/backend` (POS) | Ürüne açıklama, alerjen, diyet, İngilizce ad, görsel, "tükendi"; masaya QR kodu; `cloud` modülü (lisansla açma, yayın, uzlaştırma). |
| `apps/frontend` (POS arayüzü) | Ürün ekranında "QR menü bilgileri", Ayarlar › QR Menü kartı, yazdırılabilir masa QR sayfası (`/qr-codes`). |
| `apps/cloud` | Cloudflare Worker: API, D1, R2; qr-web çıktısını statik varlık olarak sunar. Kurulum: `apps/cloud/README.md`. |
| `apps/qr-web` | Müşteri menüsü (`/m/:code`). Vite + React 19 + Tailwind 4 + TanStack Query. Eski panel adresi (`/panel`) panelin kalktığını söyler; `public/sw.js` telefonlardaki eski panel uygulamasını siler. |

---

## 2. Kararlar

1. **Bulut Cloudflare Workers.** Tek Worker hem API'yi hem statik sayfaları sunar: tek köken, CORS
   yok. Veri D1'de, görseller R2'de. Sunucu bakımı yok, müşteri trafiği kenar ağında karşılanır.
   Parola özetleme (PBKDF2) kalktığı için ücretsiz planın CPU sınırı yetebilir; yayına almadan önce
   ölçülecek (lisans doğrulaması Ed25519, menü kaydı tek JSON).
2. **Menü tek bir sürümlü anlık görüntüdür.** POS menünün tamamını tek istekle yayınlar
   (`menus.version` her kayıtta artar); müşteri tek istekle okur. Yanıt ETag taşır, değişmeyen menü
   yeniden inmez (304). Müşteri sekmeye döndüğünde yeniden sorgulanır: "tükendi" birkaç saniyede
   görünür.
3. **Tek yayıncı: Adisyon programı.** Bulutta menü ve masa düzenleyen başka bir yer yoktur; bu yüzden
   sürüm çakışması ve "iki yerden düzenleme" sorunu da yoktur. Bir lisans aynı anda tek kurulumda
   açıktır (başka bilgisayara taşımak sahibin onayını ister).
4. **Lisans kimlik belgesidir.** İşletme bulutta lisans kimliğiyle (`id`) tanınır ve POS'un ilk
   etkinleştirmesinde kendiliğinden açılır; ad, paket ve özellikler imzalı lisanstan yazılır
   (`LICENSING.md`). Satıcının bulutta ayrıca işletme açması gerekmez.
5. **Masa kodu tahmin edilemez.** 16 karakter base32 (80 bit rastgele); QR'da yalnız
   `https://<bulut>/m/<kod>`. Kodları POS üretir ve masa listesiyle yayınlar; kod yenilenince eski QR
   çalışmaz (masadaki kart yeniden basılır). QR menü kapatılıp yeniden açılınca aynı kodlar yeniden
   yayınlanır, basılı kartlar çalışır.
6. **Görseller içerik adreslidir.** Anahtar `sha256.uzantı`; aynı görsel bir kez yüklenir
   (`images/check` eksikleri söyler) ve süresiz önbelleklenir. POS arayüzü fotoğrafı yüklemeden önce
   uzun kenarı 800 px'e küçültür (WebP); bulut 1 MB üstünü ve imzası JPEG/PNG/WebP olmayan dosyayı
   reddeder.
7. **Alerjen bilgisi dürüst.** AB'nin 14 alerjeni ve diyet etiketleri (vegan, vejetaryen, glutensiz,
   acılı) gösterilir; "alerjen içermez" iddiası yoktur, her sayfada "alerjen bilgisi için personele
   danışın" notu bulunur.
8. **Diller: Türkçe temel, İngilizce isteğe bağlı.** Eksik çeviri Türkçeye düşer. Müşterinin ilk dili
   tarayıcıdan gelir, seçimi hatırlanır. POS'ta bir ürün ya da kategoride İngilizce ad varsa EN
   sunulur.
9. **Güvenlik.**
   - POS belirteci `adoqr_pos_…` yalnız etkinleştirme yanıtında düz metin döner; bulutta özeti durur.
     Yeniden bağlanma ya da devralma eski belirteci geçersiz kılar; POS'a nedeni `401` koduyla
     söylenir (`pos_token_revocations`).
   - Etkinleştirmede hız sınırı: IP başına 15 dakikada 10, lisans başına saatte 20.
   - Satıcı API'si `ADMIN_TOKEN` ile korunur; tanımlı değilse tamamen kapalıdır.
   - Statik sayfalarda CSP, `nosniff`, `frame-ancestors 'none'`, sıkı referrer.
10. **Paketler bulutta belirlenir, lisanstan yazılır.** `menu` (QR Menü), `order` (+ sipariş), `pay`
    (+ ödeme, hesap bölme), `full` (tümü) → özellikler `qr.menu`, `qr.order`, `qr.pay`, `qr.split`,
    `qr.games`. Lisanstaki özellikler birebir uygulanır; satıcı tek tek açıp kapatabilir (bir sonraki
    yenilemede lisans yeniden yazar). Askıya alınan ya da lisansı dolan işletmede hepsi kapalıdır.
    Müşteri sayfası `qr.menu` yoksa `403 MENU_DISABLED` alır; asıl kapı buluttur.
11. **Müşteri sayfası uygulama değildir.** Service worker ve manifest yoktur; menü her zaman ağdan,
    güncel haliyle gelir. Eskiden telefona yüklenen panel uygulamasının service worker'ı (`/sw.js`,
    kapsam `/panel`) kendini silen bir sürümle değiştirildi: önbelleği temizler, kaydını kaldırır ve
    sayfayı yeniler.

---

## 3. Akışlar

### 3.1 QR menüyü açma ve yayın
1. Satıcı lisansı imzalar (`scripts/license.mjs sign`, `qr.menu=true`; `LICENSING.md`).
2. Sahip lisansı POS'ta **Ayarlar › Lisans**'a girer, **Ayarlar › QR Menü** kartında **QR menüyü
   aç** der (`POST /cloud/activate` → bulutta `POST /api/pos/activate`). Bulut adresi programa
   gömülüdür (derleme profili → `CLOUD_API_URL`); adres ya da kod girilmez.
   - İnternet yoksa istek saklanır ("İnternet bekleniyor"); bağlantı gelince kendiliğinden açılır.
   - Lisans başka bilgisayarda açıksa kart sorar; **Bu bilgisayara taşı** (`takeover`) diğer
     kurulumun belirtecini geçersiz kılar (`superseded`).
3. POS menüyü ve masaları yayınlar. Ürün, kategori, masa, salon ve işletme bilgisi değişince
   (`product.*`, `category.*`, `table.*`, `hall.*`, `branch.updated`) yayın 5 saniye birleştirilerek
   kendiliğinden tekrarlanır. Arka plan işi 3 kez dener; vazgeçerse ya da olay kaçarsa uzlaştırma
   (`CLOUD_RECONCILE_SECONDS`, varsayılan 5 dk; açılışta bir kez hemen) son yayından beri değişen
   menüyü yayınlar. Kartta son hata görünür.
4. Bulut yayını reddederse (`403`: askı, lisans bitti, QR menü yok) belirteç korunur; POS saatte bir
   (engelliyken her uzlaştırmada) `GET /api/pos/status` okur, engel kalkınca yayın sürer. Belirteç
   geçersizse (`401` + neden) bağlantı yerelde kalkar, kart nedenini söyler.
5. Lisans yenileme: yeni lisans POS'a girilince `license.activated` → `PUT /api/pos/license` (aynı
   kimlik, belirteç değişmez). Farklı kimlikli lisans girilirse bağlantı kapanır, yeniden açılır.
6. **QR menüyü kapat** (`DELETE /cloud/connection` → `POST /api/pos/unpair`): menü ve masalar
   yayından kalkar. İnternet yoksa yerelde hemen kapanır, bulut tarafı bağlantı gelince tamamlanır.
   Eski bağlantılar yeni açmadan önce bulutta kapatılır (masa kodları eski şubede kalmasın).
7. Masa QR kartları POS'taki **Masa QR kodları** sayfasından basılır (QR menü açılmadan da).
8. Ürün ekranında **Tükendi** düğmesi: ürün menüde soluk "Tükendi" rozetiyle kalır, siparişe
   eklenemez (`PRODUCT_UNAVAILABLE`).
9. Açılışta kayıtlı bağlantı denetlenir: başka kurulumun yedeğinden geldiyse (kurulum kimliği
   `ado-install.json` veritabanı dışında), gömülü adres ya da lisans kimliği değiştiyse düşer.

### 3.2 Müşteri
1. QR → `/m/<kod>` (statik sayfa) → `GET /api/m/<kod>`: menü + masa adı + salon.
2. Görseller `/img/<anahtar>` (R2, süresiz önbellek).
3. Durumlar: geçersiz kod (404 `TABLE_NOT_FOUND`), paket/askı/lisans bitti (403 `MENU_DISABLED`),
   menü henüz yok (404 `MENU_NOT_PUBLISHED`), bağlantı hatası (tekrar dene).

### 3.3 Satıcı
1. İşletmeleri listeler, ayrıntıda şubeyi, son görülme zamanını ve POS sürümünü görür.
2. Askıya alır ya da özellik istisnası verir (`PATCH /api/admin/tenants/:id`).
3. Çalınan lisans ya da bilgisayar değişiminde POS bağlantısını kaldırır (`revoke`); işletmeyi
   silebilir.

---

## 4. Bulut veri modeli (D1, `apps/cloud/migrations`)

| Tablo | İçerik |
|---|---|
| `tenants` | İşletme: ad, paket, özellik istisnaları, durum (active/suspended), lisans kimliği ve bitişi (`0002`). |
| `branches` | Şube: ad, POS belirteç özeti, bağlanma ve son görülme zamanı; bağlı kurulum, POS şube kimliği ve sürümü (`0002`). |
| `pos_token_revocations` | Geçersiz kılınan POS belirteçleri (özet) ve nedeni: `rotated`, `superseded`, `revoked`, `unpaired` (`0002`). |
| `menus` | Şube başına menü anlık görüntüsü (JSON), sürüm, güncellenme zamanı. |
| `tables` | Masa: kod, ad, salon, sıra. |
| `images` | Yüklenmiş görsel anahtarları (R2'deki nesneler). |
| `rate_limits` | Hız sınırı sayaçları. |

`0003_remove_panel.sql` panel tablolarını (`users`, `sessions`, `pairing_codes`) ve `branches.source`
sütununu kaldırır, lisanssız işletmeleri siler. Uygulamadan önce D1 Time Travel yer imi alınır.

---

## 5. API özeti

Yanıt zarfı POS ile aynıdır: `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`.

**Genel (oturumsuz)**
- `GET /api/m/:code` — masa + menü (ETag / 304)
- `GET /img/:key` — görsel
- `GET /api/health`

**POS** (`Authorization: Bearer adoqr_pos_…`; etkinleştirme hariç)
- `POST /api/pos/activate` `{ licenseKey, installId, posBranchId?, branchName?, takeover? }` →
  belirteç, işletme, şube ve lisans bilgisi (`LICENSING.md`). İmza, lisans kimliği, süre ve
  `qr.menu` şartı; işletme lisans kimliğiyle ilk etkinleştirmede açılır. Aynı kurulum yeniden
  bağlanınca belirteç yenilenir; başka kurulumda açıksa `409 ACTIVE_ON_OTHER_INSTALL`, onayla
  (`takeover`) devralınır. `LICENSE_PUBLIC_KEY` boşsa `503 ACTIVATION_DISABLED`.
- `PUT /api/pos/license` `{ licenseKey }` — yenileme: aynı lisans kimliği, belirteç değişmez
  (`409 LICENSE_ID_MISMATCH`); QR menüsüz lisans özelliği kapatır.
- `GET /api/pos/status` — işletme (durum, paket, özellikler), lisans, menü sürümü
- `POST /api/pos/images/check` `{ keys }` → `{ missing }` · `PUT /api/pos/images/:key` (gövde: görsel)
- `PUT /api/pos/menu` (menü anlık görüntüsü) · `PUT /api/pos/tables` `{ tables }` — askıda işletme,
  dolan lisans ya da QR menü hakkı yoksa `403` (`TENANT_SUSPENDED` / `LICENSE_EXPIRED` /
  `QR_MENU_NOT_LICENSED`); belirteç geçerli kalır.
- `POST /api/pos/unpair` — "QR menüyü kapat": menü ve masalar yayından kalkar, belirteç iptal.
- Geçersiz belirteçte `401` nedeniyle döner: `POS_TOKEN_ROTATED` / `POS_TOKEN_SUPERSEDED` /
  `POS_TOKEN_REVOKED` / `POS_TOKEN_UNPAIRED` / `POS_TOKEN_INVALID`.
- POS `X-Ado-Version` başlığı gönderirse sürümü şube kaydına yazılır.

**Satıcı** (`Authorization: Bearer <ADMIN_TOKEN>`)
- `GET /api/admin/plans` · `GET /api/admin/tenants` · `GET/PATCH /api/admin/tenants/:id` (ad, paket,
  özellik istisnaları, askıya alma) · `DELETE /api/admin/tenants/:id`
- `POST /api/admin/tenants/:id/revoke` — POS bağlantılarını kaldırır (`POS_TOKEN_REVOKED`)

POS tarafındaki uçlar (`/cloud/*`, ürün görseli, "tükendi", masa kodu): `API_DESIGN.md` §5.1, §5.2, §5.12.

---

## 6. Sınırlar (`MENU_LIMITS`)

Ürün/kategori adı 120, açıklama 600, işletme adı 60, adres 160, telefon 30, masa ve salon adı 60
karakter; fiyat en fazla 1 000 000 TL; en fazla 200 kategori, 2 000 ürün, 500 masa; görsel en fazla
1 MB. D1'in sorgu başına 100 parametre sınırı nedeniyle listeler `json_each` ile tek parametrede
gider.

---

## 7. Testler

- `apps/cloud/test` (vitest, gerçek workerd, yerel D1/R2): genel menü, lisansla etkinleştirme
  (`activate.test.ts`), POS yayını, satıcı API'si, paketler; eski panel ve eşleştirme yollarının
  kalktığı.
- Backend smoke (`apps/backend/test/smoke.e2e.mjs`) QR ve BULUT bölümleri: sahte bulut, test
  anahtarıyla imzalanmış lisansla açma, otomatik yayın (işletme bilgisi ve salon dahil), hata ve
  yeniden deneme, uzlaştırma, askı ve dönüş, lisans yenileme, devralma, internetsiz açma/kapatma.
  CI `e2e` işi anahtar çiftini her koşumda üretir (`scripts/license.mjs gen-key --github-env`).
- Playwright `apps/frontend/e2e/menu-screen.spec.ts` (POS ürün ekranı) ve `qr-menu.spec.ts`
  (POS + `wrangler dev`: lisansla açma, otomatik yayın, tükendi, kapatınca QR'ın çalışmaması, 390 px
  müşteri sayfası; eski panel adresinin bilgi sayfası ve kendini silen service worker). CI:
  `e2e-cloud` işi.
- Self-check'ler: `@ado/shared/menu`, `cloud.snapshot`, `cloud.state`, qr-web `menu-view`.

---

## 8. Sonraya kalanlar

- Kalıcı alan adı ve canlı bulut; geçişte QR kartları yeniden basılır.
- İşletme logosu ve renk teması.
- QR-2 sipariş, QR-3 uzaktan ödeme ve hesap bölme (ödeme sağlayıcısı QR-3'te seçilecek),
  QR-4 oyunlar ve şans çarkı.
