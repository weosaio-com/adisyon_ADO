# QR_MENU_DESIGN.md — QR Menü (QR-1: Dijital Menü)

> Müşteri masadaki QR kodu telefonuyla okutur, işletmenin menüsünü görür: fotoğraf, açıklama,
> alerjen, diyet etiketleri, TR/EN, "tükendi". Adisyon programı (POS) olan işletmede menü
> programdan kendiliğinden yayınlanır; POS'u olmayan işletme menüsünü bulut panelinden yönetir.
>
> Kapsam QR-1: yalnız menü. Sipariş (QR-2), uzaktan ödeme ve hesap bölme (QR-3), oyunlar ve şans
> çarkı (QR-4) sonraki aşamalardır; paket altyapısı şimdiden bunları taşır.

---

## 1. Parçalar

```
 Adisyon programı (POS, işletmede)          Bulut (Cloudflare, tek Worker)            Telefon
 ┌───────────────────────────────┐   HTTPS  ┌──────────────────────────────────┐    ┌───────────────┐
 │ apps/backend  cloud modülü    │ ───────▶ │ apps/cloud  (Hono)               │◀── │ /m/<masa kodu>│
 │  - eşleştirme (Ayarlar kartı) │  Bearer  │  /api/pos/*   POS yayını         │    │  müşteri menü │
 │  - otomatik yayın (5 sn)      │  token   │  /api/panel/* işletme paneli     │    ├───────────────┤
 │  - masa QR yazdırma           │          │  /api/admin/* satıcı (ADMIN_TOKEN)│◀── │ /panel        │
 └───────────────────────────────┘          │  /api/m/:code, /img/:key  genel  │    │  işletme      │
                                            │  D1 (SQLite)  R2 (görseller)     │    │  sahibi       │
                                            │  statik: apps/qr-web/dist (SPA)  │    └───────────────┘
                                            └──────────────────────────────────┘
```

| Paket | Görev |
|---|---|
| `packages/shared` → `@ado/shared/menu` | Menü anlık görüntüsünün zod şeması (POS, bulut ve panel aynı doğrulamayı kullanır), masa listesi, görsel anahtarı. |
| `@ado/shared/menu-core` | Bağımlılıksız sabitler ve yardımcılar (14 alerjen, diyet etiketleri, sınırlar, `menuText`, görsel imzası). Tarayıcı paketine yalnız bu girer; zod ve ulid girmez. |
| `apps/backend` (POS) | Ürüne açıklama, alerjen, diyet, İngilizce ad, görsel, "tükendi"; masaya QR kodu; `cloud` modülü (eşleştirme + yayın). |
| `apps/frontend` (POS arayüzü) | Ürün ekranında "QR menü bilgileri", Ayarlar › QR Menü (Bulut) kartı, yazdırılabilir masa QR sayfası (`/qr-codes`). |
| `apps/cloud` | Cloudflare Worker: API, D1, R2; qr-web çıktısını statik varlık olarak sunar. Kurulum: `apps/cloud/README.md`. |
| `apps/qr-web` | Müşteri menüsü (`/m/:code`) ve işletme paneli (`/panel`, ayrı parça). Vite + React 19 + Tailwind 4 + TanStack Query. |

---

## 2. Kararlar

1. **Bulut Cloudflare Workers.** Tek Worker hem API'yi hem statik sayfaları sunar: tek köken,
   çerezle oturum, CORS yok. Veri D1'de, görseller R2'de. Sunucu bakımı yok, müşteri trafiği kenar
   ağında karşılanır. **Ücretli plan gerekir ($5/ay):** parola özetleme (PBKDF2, 100 000 tur;
   Workers'ın üst sınırı) ücretsiz planın 10 ms CPU sınırını aşar.
2. **Menü tek bir sürümlü anlık görüntüdür.** POS ya da panel menünün tamamını tek istekle yayınlar
   (`menus.version` her kayıtta artar); müşteri tek istekle okur. Yanıt ETag taşır, değişmeyen menü
   yeniden inmez (304). Müşteri sekmeye döndüğünde yeniden sorgulanır: "tükendi" birkaç saniyede
   görünür.
3. **Her şubenin tek kaynağı vardır.** Şube ya POS'tan (`source = pos`) ya panelden
   (`source = panel`) yönetilir. POS eşleşince panel menüyü ve masaları salt okunur gösterir;
   bağlantı kaldırılınca (POS'tan ya da panelden) yönetim panele döner. Aynı anda iki yerden
   düzenleme ve sessiz ezme yoktur.
4. **Sürüm kontrolü.** Panel kaydı `baseVersion` ile gider; arada başka sekme/cihaz kaydettiyse bulut
   `409 VERSION_CONFLICT` döndürür, panel "güncel menüyü yükle" önerir. Taslak başladığı sürümü
   saklar; arka plandaki yenileme çakışmayı gizlemez.
5. **Masa kodu tahmin edilemez.** 16 karakter base32 (80 bit rastgele); QR'da yalnız
   `https://<bulut>/m/<kod>`. Kod yenilenince eski QR çalışmaz (masadaki kart yeniden basılır). POS'lu
   işletmede kodları POS üretir ve masa listesiyle yayınlar.
6. **Görseller içerik adreslidir.** Anahtar `sha256.uzantı`; aynı görsel bir kez yüklenir
   (`images/check` eksikleri söyler) ve süresiz önbelleklenir. Tarayıcı fotoğrafı yüklemeden önce
   uzun kenarı 800 px'e küçültür (WebP, desteklemeyende JPEG); sunucu 1 MB üstünü ve imzası
   JPEG/PNG/WebP olmayan dosyayı reddeder.
7. **Alerjen bilgisi dürüst.** AB'nin 14 alerjeni ve diyet etiketleri (vegan, vejetaryen, glutensiz,
   acılı) gösterilir; "alerjen içermez" iddiası yoktur, her sayfada "alerjen bilgisi için personele
   danışın" notu bulunur.
8. **Diller: Türkçe temel, İngilizce isteğe bağlı.** Eksik çeviri Türkçeye düşer. Müşterinin ilk dili
   tarayıcıdan gelir, seçimi hatırlanır. POS'ta bir ürün ya da kategoride İngilizce ad varsa EN
   sunulur; panelde "İngilizce menü sun" anahtarı vardır.
9. **Güvenlik.**
   - Panel oturumu `__Host-ado_session` çerezinde (HttpOnly, Secure, SameSite=Lax); durum değiştiren
     isteklerde köken (Origin) kontrolü (CSRF). Oturum 30 gün; parola değişince diğer cihazlar çıkar.
   - POS eşleştirme kodu 8 karakter, 15 dakika geçerli, tek kullanımlık; bulutta yalnız özeti
     saklanır. Eşleşince POS'a `adoqr_pos_…` belirteci verilir (bulutta özeti). Yeni eşleşme eski
     belirteci geçersiz kılar.
   - Giriş, parola değiştirme ve eşleştirme denemelerinde hız sınırı (15 dakikada 10).
   - Satıcı API'si `ADMIN_TOKEN` ile korunur; tanımlı değilse tamamen kapalıdır.
   - Statik sayfalarda CSP, `nosniff`, `frame-ancestors 'none'`, sıkı referrer.
10. **Paketler bulutta belirlenir.** `menu` (QR Menü), `order` (+ sipariş), `pay` (+ ödeme, hesap
    bölme), `full` (tümü) → özellikler `qr.menu`, `qr.order`, `qr.pay`, `qr.split`, `qr.games`.
    Satıcı özellikleri tek tek açıp kapatabilir. Askıya alınan işletmede hepsi kapalıdır. Müşteri
    sayfası `qr.menu` yoksa `403 MENU_DISABLED` alır. POS lisansındaki `qr.menu: false` yalnız
    arayüzdeki kartı gizler; asıl kapı buluttur.
11. **İşletme paneli yüklenebilir uygulamadır (PWA); müşteri sayfası değildir.** Mağaza yok: telefon
    ve bilgisayarda tarayıcıdan yüklenir, güncellemeler kendiliğinden gelir.
    - Manifest ve service worker yalnız panel açılınca eklenir. SW kapsamı `/panel` (sondaki `/`
      yok: giriş adresi `/panel` de kapsamda kalır). Müşteri sayfası `/m/*` SW'ye ve manifeste hiç
      girmez; menüyü her zaman ağdan, güncel haliyle alır.
    - SW uygulama kabuğunu önbelleğe alır ve `/panel` gezinmelerini `index.html`'e düşürür.
      `/img/<sha256>` görselleri CacheFirst'tür (anahtar içerik özeti, değişmez); `/api/*`
      önbelleklenmez.
12. **Panel internetsiz düzenlenir, internet gelince yayınlar.**
    - Veri IndexedDB'de (`ado-panel`): son sorgular (TanStack `dehydrate`, 30 gün), şube başına
      taslak (`menu`, `baseVersion`, `publishPending`), henüz yüklenmemiş fotoğraflar. Çıkışta ve
      cihaza başka hesap girince silinir. İlk giriş internet ister.
    - Bağlantı durumu tarayıcı olayları ve API yanıtlarından izlenir; bağlantı yokken `/api/health`
      yoklanır. İnternetsiz **Kaydet ve yayınla** taslağı "yayın bekliyor" işaretler. Bağlantı gelince
      önce taslağın kullandığı bekleyen fotoğraflar, sonra menü `baseVersion` ile gider.
    - Fotoğraf anahtarı tarayıcıda bulutla aynı kuralla hesaplanır (SHA-256 + dosya imzası →
      `menuImageKey`); taslak anahtarı hemen kullanır, yüklemede bulutun döndürdüğü anahtar
      karşılaştırılır.
    - Sürüm çakışması (409) kendiliğinden yeniden denenmez (karar 4). Oturum düşerse (401) taslak
      cihazda kalır, yeniden girişten sonra yayınlanır.
    - Masa ekleme/kod yenileme, POS eşleştirme ve parola değiştirme internet ister; düğmeler pasiftir
      ve nedeni yazılır.

---

## 3. Akışlar

### 3.1 POS'lu işletme
1. Satıcı işletmeyi açar (`POST /api/admin/tenants`: ad, paket, sahibin e-posta/parolası).
2. İşletme sahibi `/panel` › **Adisyon programı** sekmesinden eşleştirme kodu alır.
3. POS'ta **Ayarlar › QR Menü (Bulut)**: bulut adresi + kod → **Bağlan** (`POST /cloud/pair`).
4. POS menüyü ve masaları yayınlar. Ürün, kategori, masa değişince (`product.*`, `category.*`,
   `table.*` olayları) yayın 5 saniye birleştirilerek kendiliğinden tekrarlanır; bulut erişilemezse
   artan aralıklarla yeniden dener, kartta son hata görünür.
5. Masa QR kartları POS'taki **Masa QR kodları** sayfasından (ya da panelden) basılır.
6. Ürün ekranında **Tükendi** düğmesi: ürün menüde soluk "Tükendi" rozetiyle kalır, siparişe
   eklenemez (`PRODUCT_UNAVAILABLE`).

### 3.2 POS'suz işletme
1. Satıcı işletmeyi açar.
2. Sahip `/panel`'e girer: **Menü** (kategori, ürün, fiyat, görsel, alerjen, diyet, İngilizce,
   tükendi), **İşletme** (ad, adres, telefon, İngilizce menü), **Masalar** (ekle, adlandır, kodu
   yenile, QR yazdır). **Kaydet ve yayınla** menüyü tek seferde yayınlar.

### 3.3 Panel internetsizken
1. Panel ana ekrandan açılır; üstte "İnternet yok — değişiklikler bu cihazda saklanıyor." yazar.
2. Menüde ürün/fotoğraf değiştirilir, **Kaydet ve yayınla** → "internet gelince kendiliğinden
   yayınlanacak". Uygulama kapanıp açılsa da taslak durur.
3. Bağlantı gelince yayın kendiliğinden gider (sürüm artar); müşteri sayfası yeni menüyü alır.

### 3.4 Müşteri
1. QR → `/m/<kod>` (statik sayfa) → `GET /api/m/<kod>`: menü + masa adı + salon.
2. Görseller `/img/<anahtar>` (R2, süresiz önbellek).
3. Durumlar: geçersiz kod (404 `TABLE_NOT_FOUND`), paket/askı (403 `MENU_DISABLED`), menü henüz yok
   (404 `MENU_NOT_PUBLISHED`), bağlantı hatası (tekrar dene).

---

## 4. Bulut veri modeli (D1, `apps/cloud/migrations`)

| Tablo | İçerik |
|---|---|
| `tenants` | İşletme: ad, paket, özellik istisnaları, durum (active/suspended), lisans kimliği ve bitişi (`0002`). |
| `branches` | Şube: ad, kaynak (`panel`/`pos`), POS belirteç özeti, eşleşme ve son görülme zamanı; bağlı kurulum, POS şube kimliği ve sürümü (`0002`). |
| `pos_token_revocations` | Geçersiz kılınan POS belirteçleri (özet) ve nedeni: `rotated`, `superseded`, `revoked`, `unpaired` (`0002`). |
| `users` | Panel kullanıcısı (e-posta, PBKDF2 parola özeti). |
| `sessions` | Panel oturumları (belirteç özeti, bitiş). |
| `pairing_codes` | Eşleştirme kodu özeti, şube, bitiş (şubenin yalnız son kodu geçerli). |
| `menus` | Şube başına menü anlık görüntüsü (JSON), sürüm, güncellenme zamanı. |
| `tables` | Masa: kod, ad, salon, sıra. |
| `images` | Yüklenmiş görsel anahtarları (R2'deki nesneler). |
| `rate_limits` | Hız sınırı sayaçları. |

---

## 5. API özeti

Yanıt zarfı POS ile aynıdır: `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`.

**Genel (oturumsuz)**
- `GET /api/m/:code` — masa + menü (ETag / 304)
- `GET /img/:key` — görsel
- `GET /api/health`

**POS** (`Authorization: Bearer adoqr_pos_…`; etkinleştirme ve eşleştirme hariç)
- `POST /api/pos/activate` `{ licenseKey, installId, posBranchId?, branchName?, takeover? }` →
  belirteç, işletme, şube ve lisans bilgisi (`LICENSING.md`). İmza, lisans kimliği, süre ve
  `qr.menu` şartı; işletme lisans kimliğiyle ilk etkinleştirmede açılır. Aynı kurulum yeniden
  bağlanınca belirteç yenilenir; başka kurulumda açıksa `409 ACTIVE_ON_OTHER_INSTALL`, onayla
  (`takeover`) devralınır. `LICENSE_PUBLIC_KEY` boşsa `503 ACTIVATION_DISABLED`.
- `PUT /api/pos/license` `{ licenseKey }` — yenileme: aynı lisans kimliği, belirteç değişmez
  (`409 LICENSE_ID_MISMATCH`); QR menüsüz lisans özelliği kapatır.
- `POST /api/pos/pair` `{ code }` → belirteç, işletme ve şube bilgisi (eski yol; panelle kalkacak)
- `GET /api/pos/status` — işletme (durum, paket, özellikler), lisans, menü sürümü
- `POST /api/pos/images/check` `{ keys }` → `{ missing }` · `PUT /api/pos/images/:key` (gövde: görsel)
- `PUT /api/pos/menu` (menü anlık görüntüsü) · `PUT /api/pos/tables` `{ tables }` — askıda işletme,
  dolan lisans ya da QR menü hakkı yoksa `403` (`TENANT_SUSPENDED` / `LICENSE_EXPIRED` /
  `QR_MENU_NOT_LICENSED`); belirteç geçerli kalır.
- `POST /api/pos/unpair` — "QR menüyü kapat": menü ve masalar yayından kalkar, belirteç iptal.
- Geçersiz belirteçte `401` nedeniyle döner: `POS_TOKEN_ROTATED` / `POS_TOKEN_SUPERSEDED` /
  `POS_TOKEN_REVOKED` / `POS_TOKEN_UNPAIRED` / `POS_TOKEN_INVALID`.
- POS `X-Ado-Version` başlığı gönderirse sürümü şube kaydına yazılır.

**Panel** (çerez oturumu; `branches/:branchId/*` kiracıya göre sınırlı)
- `POST /api/panel/login` · `POST /api/panel/logout` · `GET /api/panel/me` · `POST /api/panel/password`
- `GET/PUT /api/panel/branches/:branchId/menu` (`PUT`: `{ baseVersion, menu }`) · `POST …/images`
- `GET/POST …/tables` · `PATCH/DELETE …/tables/:tableId` · `POST …/tables/:tableId/rotate`
- `POST …/pairing-code` → `{ code, expiresAt }` · `DELETE …/pos` (POS bağlantısını kaldır)

**Satıcı** (`Authorization: Bearer <ADMIN_TOKEN>`)
- `GET /api/admin/plans` · `GET/POST /api/admin/tenants` · `GET/PATCH /api/admin/tenants/:id`
  (ad, paket, özellikler, askıya alma) · `DELETE /api/admin/tenants/:id`
- `POST /api/admin/tenants/:id/revoke` — POS bağlantılarını kaldırır (`POS_TOKEN_REVOKED`)
- `POST /api/admin/branches/:id/pairing-code` · `POST /api/admin/users/:id/password`

POS tarafındaki uçlar (`/cloud/*`, ürün görseli, "tükendi", masa kodu): `API_DESIGN.md` §5.1, §5.2, §5.12.

---

## 6. Sınırlar (`MENU_LIMITS`)

Ürün/kategori adı 120, açıklama 600, işletme adı 60, adres 160, telefon 30, masa ve salon adı 60
karakter; fiyat en fazla 1 000 000 TL; en fazla 200 kategori, 2 000 ürün, 500 masa; görsel en fazla
1 MB. D1'in sorgu başına 100 parametre sınırı nedeniyle listeler `json_each` ile tek parametrede
gider.

---

## 7. Testler

- `apps/cloud/test` (vitest, gerçek workerd, yerel D1/R2): genel menü, POS eşleştirme ve yayın,
  panel oturumu/CSRF/sürüm çakışması, satıcı API'si, paketler.
- Backend smoke (`apps/backend/test/smoke.e2e.mjs`) QR ve BULUT bölümleri: sahte buluta eşleştirme,
  otomatik yayın, birleştirme, hata ve yeniden deneme.
- Playwright `apps/frontend/e2e/menu-screen.spec.ts` (POS ürün ekranı) ve `qr-menu.spec.ts`
  (POS + `wrangler dev`: POS'lu ve POS'suz akış, 390 px müşteri sayfası; panelin uygulama olarak
  yüklenmesi, internetsiz düzenleme ve fotoğraf, internet gelince yayın, müşteri sayfasında SW
  olmaması, çıkışta cihaz verisinin silinmesi). CI: `e2e-cloud` işi.
- Self-check'ler: `@ado/shared/menu`, `cloud.snapshot`, qr-web `menu-view`, `money`, `tables`,
  `image-key` (tarayıcı anahtarı = bulut anahtarı), `sync-core` (yayın durumları).

---

## 8. Sonraya kalanlar

- İşletme logosu ve renk teması; kendi kendine kayıt ve ücretlendirme (şimdilik satıcı açar).
- Panelde internetsiz masa düzenleme; Google Play / App Store sürümleri (istenirse).
- QR-2 sipariş, QR-3 uzaktan ödeme ve hesap bölme (ödeme sağlayıcısı QR-3'te seçilecek),
  QR-4 oyunlar ve şans çarkı.
