# QR_MENU_DESIGN.md — QR Menü (QR-1: Dijital Menü)

> Müşteri masadaki QR kodu telefonuyla okutur, işletmenin menüsünü görür: fotoğraf, açıklama,
> alerjen, diyet etiketleri, TR/EN, "tükendi". Menü **yalnız Adisyon programından** (POS) yönetilir
> ve programdan kendiliğinden yayınlanır. Lisanslı her kurulum buluta imzalı lisansıyla
> **kendiliğinden** bağlanır (QR menü olmasa da): saatte bir heartbeat gönderir, lisans yenilemesini,
> askıya almayı ve iptali bu bağlantıyla öğrenir. QR menü bu bağlantının üzerinde ayrıca açılıp
> kapanır. Ayrı bir hesap, işletme paneli ya da eşleştirme kodu yoktur.
>
> Kapsam QR-1: yalnız menü. Sipariş (QR-2), uzaktan ödeme ve hesap bölme (QR-3), oyunlar ve şans
> çarkı (QR-4) sonraki aşamalardır; paket altyapısı şimdiden bunları taşır.

---

## 1. Parçalar

```
 Adisyon programı (POS, işletmede)          Bulut (Cloudflare, tek Worker)            Telefon
 ┌───────────────────────────────┐   HTTPS  ┌──────────────────────────────────┐    ┌───────────────┐
 │ apps/backend  cloud modülü    │ ───────▶ │ apps/cloud  (Hono)               │◀── │ /m/<masa kodu>│
 │  - lisansla kendiliğinden bağ.│  Bearer  │  /api/pos/*   bağlantı, heartbeat│    │  müşteri menü │
 │  - heartbeat (saatte bir)     │  token   │               ve QR menü yayını  │    └───────────────┘
 │  - QR menü aç/kapat (Ayarlar) │          │  /api/admin/* satıcı (ADMIN_TOKEN)│
 │  - otomatik yayın (5 sn)      │          │  /api/m/:code, /img/:key  genel  │
 │  - uzlaştırma (kaçan yayın)   │          │  D1 (SQLite)  R2 (görseller)     │
 │  - masa QR yazdırma           │          │  statik: apps/qr-web/dist (SPA)  │
 └───────────────────────────────┘          └──────────────────────────────────┘
```

| Paket | Görev |
|---|---|
| `packages/shared` → `@ado/shared/menu` | Menü anlık görüntüsünün zod şeması (POS ve bulut aynı doğrulamayı kullanır), masa listesi, görsel anahtarı. `@ado/shared/license`: lisans biçimi. |
| `@ado/shared/menu-core` | Bağımlılıksız sabitler ve yardımcılar (14 alerjen, diyet etiketleri, sınırlar, `menuText`, görsel imzası). Tarayıcı paketine yalnız bu girer; zod ve ulid girmez. |
| `apps/backend` (POS) | Ürüne açıklama, alerjen, diyet, İngilizce ad, görsel, "tükendi"; masaya QR kodu; `cloud` modülü (lisansla kendiliğinden bağlantı, heartbeat ve `license.remote` olayı, QR menü aç/kapat, yayın, uzlaştırma). |
| `apps/frontend` (POS arayüzü) | Ürün ekranında "QR menü bilgileri", Ayarlar › Lisans kartında bulut satırı (`CloudLinkStatus`), Ayarlar › QR Menü kartı, yazdırılabilir masa QR sayfası (`/qr-codes`). |
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
   bağlıdır (başka bilgisayara almak sahibin onayını ister; kendiliğinden devralınmaz).
4. **Lisans kimlik belgesidir.** İşletme bulutta lisans kimliğiyle (`id`) tanınır ve POS'un ilk
   bağlanmasında kendiliğinden açılır; ad, paket ve özellikler lisans kaydındaki geçerli lisanstan
   yazılır (`LICENSING.md`). Satıcının bulutta ayrıca işletme açması gerekmez.
5. **Bağlantı ve QR menü ayrıdır.** Lisans numaralı her kurulum açılışta, lisans girilince ve
   uzlaştırmada buluta kendiliğinden bağlanır (QR menü şart değil; süresi dolmuş ama imzalı lisans ve
   askıdaki işletme de "yalnız bağlantı" olarak bağlanır). Satıcı böylece her kurulumu, sürümünü ve
   sağlığını görür; lisans yenilemesi, askıya alma ve iptal programa ulaşır. QR menü sahibin ayarıdır
   (`cloud.qrPublish`): kapatınca menü ve masalar buluttan kalkar, bağlantı kalır.
6. **Lisans kaydı geri gitmez.** Bulutun `licenses` tablosu her lisans numarası için son imzalı
   anahtarı tutar; anahtar yalnız bitişi daha geç ya da eşitse değişir. Eski anahtarla bağlanan POS
   daha yeni lisansı heartbeat yanıtında alır (`remote.update`; aynı numara, daha geç `exp`). İptal
   edilen lisans bağlanamaz, yenilenemez, yayın yapamaz; işletme silinse de iptal kalır.
7. **Masa kodu tahmin edilemez.** 16 karakter base32 (80 bit rastgele); QR'da yalnız
   `https://<bulut>/m/<kod>`. Kodları POS üretir ve masa listesiyle yayınlar; kod yenilenince eski QR
   çalışmaz (masadaki kart yeniden basılır). QR menü kapatılıp yeniden açılınca aynı kodlar yeniden
   yayınlanır, basılı kartlar çalışır.
8. **Görseller içerik adreslidir.** Anahtar `sha256.uzantı`; aynı görsel bir kez yüklenir
   (`images/check` eksikleri söyler) ve süresiz önbelleklenir. POS arayüzü fotoğrafı yüklemeden önce
   uzun kenarı 800 px'e küçültür (WebP); bulut 1 MB üstünü ve imzası JPEG/PNG/WebP olmayan dosyayı
   reddeder.
9. **Alerjen bilgisi dürüst.** AB'nin 14 alerjeni ve diyet etiketleri (vegan, vejetaryen, glutensiz,
   acılı) gösterilir; "alerjen içermez" iddiası yoktur, her sayfada "alerjen bilgisi için personele
   danışın" notu bulunur.
10. **Diller: Türkçe temel, İngilizce isteğe bağlı.** Eksik çeviri Türkçeye düşer. Müşterinin ilk dili
    tarayıcıdan gelir, seçimi hatırlanır. POS'ta bir ürün ya da kategoride İngilizce ad varsa EN
    sunulur.
11. **Güvenlik.**
    - POS belirteci `adoqr_pos_…` yalnız etkinleştirme yanıtında düz metin döner; bulutta özeti durur.
      Yeniden bağlanma ya da devralma eski belirteci geçersiz kılar; POS'a nedeni `401` koduyla
      söylenir (`pos_token_revocations`).
    - Belirteçli her uç `posAuth`'u açıkça taşır: Hono'da `use('/menu', …)` yalnız tam yolu korur;
      `/heartbeat` ve `/menu/unpublish` ara katmanı uçta alır (testi var).
    - Etkinleştirmede hız sınırı: IP başına 15 dakikada 10, lisans başına saatte 20.
    - Satıcı API'si `ADMIN_TOKEN` ile korunur; tanımlı değilse tamamen kapalıdır.
    - Heartbeat'teki yeni lisans anahtarı (`update`) olay akışına ve loglara yazılmaz; POS imzasını
      gömülü açık anahtarlarla doğrulamadan kurmaz.
    - Statik sayfalarda CSP, `nosniff`, `frame-ancestors 'none'`, sıkı referrer.
12. **Paketler bulutta belirlenir, lisanstan yazılır.** `menu` (QR Menü), `order` (+ sipariş), `pay`
    (+ ödeme, hesap bölme), `full` (tümü) → özellikler `qr.menu`, `qr.order`, `qr.pay`, `qr.split`,
    `qr.games`. Lisanstaki özellikler birebir uygulanır; satıcı tek tek açıp kapatabilir (bir sonraki
    yenilemede lisans yeniden yazar). Askıya alınan ya da lisansı dolan işletmede hepsi kapalıdır;
    iptal edilen lisansta yayın reddedilir ve menü yayından kalkar. Müşteri sayfası `qr.menu` yoksa
    `403 MENU_DISABLED` alır; asıl kapı buluttur.
13. **Müşteri sayfası uygulama değildir.** Service worker ve manifest yoktur; menü her zaman ağdan,
    güncel haliyle gelir. Eskiden telefona yüklenen panel uygulamasının service worker'ı (`/sw.js`,
    kapsam `/panel`) kendini silen bir sürümle değiştirildi: önbelleği temizler, kaydını kaldırır ve
    sayfayı yeniler.

---

## 3. Akışlar

### 3.1 Bulut bağlantısı (lisansla, kendiliğinden)
1. Satıcı lisansı imzalar (`scripts/license.mjs sign`; lisans numarası `id` şart, QR menü için
   `qr.menu=true`; `LICENSING.md`) ve isterse buluta kaydeder (`register` → `PUT /api/admin/licenses`).
2. Sahip lisansı POS'ta **Ayarlar › Lisans**'a girer. Program açılışta, lisans girilince
   (`license.activated`) ve uzlaştırmada buluta kendiliğinden bağlanır (`POST /api/pos/activate`:
   lisans, kurulum kimliği, şube). Bulut adresi programa gömülüdür (derleme profili →
   `CLOUD_API_URL`); adres ya da kod girilmez. Lisans kartındaki satır durumu söyler: "Bulut: bağlı ·
   son görülme …", "bağlanıyor…", "internet yok, bekliyor", "bu lisans başka bilgisayarda açık [Bu
   bilgisayara al]", "lisans iptal edildi" (bulut tanımlı değilse satır görünmez).
   - İnternet yoksa her uzlaştırmada yeniden denenir.
   - Lisans başka bilgisayarda bağlıysa (`409`) kendiliğinden devralınmaz; **Bu bilgisayara al**
     (`POST /cloud/activate { takeover: true }`) diğer kurulumun belirtecini geçersiz kılar
     (`superseded`); o bilgisayar da kendiliğinden geri almaz, satırında aynı soruyu görür.
   - Bulut reddederse (iptal `LICENSE_REVOKED`, anahtar tanınmıyor vb.) neden satırda görünür ve
     heartbeat aralığında yeniden denenir. Satıcı bağlantıyı kaldırdıysa (`POS_TOKEN_REVOKED`)
     sahibin onayıyla ("Yeniden bağlan"), belirteç yenilendi ya da geçersizse (`rotated`, `invalid`)
     bir sonraki uzlaştırmada kendiliğinden yeniden bağlanılır.
   - Lisans kuruluma aittir: kendiliğinden yalnız birincil şube bağlanır.
3. **Heartbeat** (`POST /api/pos/heartbeat`; `CLOUD_HEARTBEAT_SECONDS`, varsayılan saatte bir;
   açılıştan ve bağlanmadan sonra hemen; QR yayını engelliyken her uzlaştırmada; bağlıyken
   `POST /cloud/activate` da durumu hemen yeniler):
   sürüm, veritabanı ve yedek boyutu, boş disk, son yedek ve bulut yedeği, lisans numarası ve bitişi
   (bilinmeyen değer `null`; `@ado/shared/cloud-api`). Yanıt: işletme bilgisi, uzak durum
   (`active | suspended | expired | revoked`), bulut saati, menü sürümü ve kayıtta aynı numaralı,
   daha geç bitişli (`exp`) lisans varsa anahtarın kendisi (`update`). POS her başarılı heartbeat'ten
   sonra `license.remote` olayını yayınlar (kalıcı değil; anahtar loglanmaz); lisans politikası yeni
   anahtarı imzasını doğrulayıp kurar, askıyı/iptali ve bulut saatini uygular. Bulutta uç yoksa
   (eski Worker, `404`) `GET /api/pos/status` okunur.
4. Lisans yenileme: yeni lisans POS'a girilince (ya da heartbeat'ten kurulunca) `license.activated` →
   `PUT /api/pos/license` (aynı kimlik, belirteç değişmez, kayıt geri gitmez; aynı anahtar bir daha
   gönderilmez, döngü olmaz). Farklı kimlikli lisans girilirse eski bağlantı bulutta kapatılır
   (`unpair`; masa kodları eski şubede kalmasın), yenisi kendiliğinden kurulur.
5. Açılışta kayıtlı bağlantı denetlenir: başka kurulumun yedeğinden geldiyse (kurulum kimliği
   `ado-install.json` veritabanı dışında), gömülü adres ya da lisans kimliği değiştiyse düşer; sonra
   yeniden bağlanılır (başka bilgisayarın yedeğinde, lisans orada bağlıysa sahibin onayıyla).
6. 0.3.0'dan yükseltme (bir kez): eski sürüm yalnız QR menü açılınca bağlanırdı. Kayıtlı bağlantı
   varsa QR menü açık kalır (`cloud.qrPublish = true`) ve lisans buluta bir kez bildirilir
   (`PUT /api/pos/license`): bulutun lisans kaydı eski işletmeleri başka yoldan öğrenemez.

### 3.2 QR menüyü açma ve yayın
1. **Ayarlar › QR Menü** kartında **QR menüyü aç** (`PUT /cloud/qr { enabled: true }`; lisans
   `qr.menu` içermeli): ayar açılır, bağlı değilse bağlanılır, menü hemen yayınlanır.
2. POS menüyü ve masaları yayınlar. Ürün, kategori, masa, salon ve işletme bilgisi değişince
   (`product.*`, `category.*`, `table.*`, `hall.*`, `branch.updated`) yayın 5 saniye birleştirilerek
   kendiliğinden tekrarlanır. Arka plan işi 3 kez dener; vazgeçerse ya da olay kaçarsa uzlaştırma
   (`CLOUD_RECONCILE_SECONDS`, varsayılan 5 dk; açılışta bir kez hemen) son yayından beri değişen
   menüyü yayınlar. Kartta son hata görünür. QR menü kapalıyken hiçbir şey yayınlanmaz.
3. Bulut yayını reddederse (`403`: askı, lisans bitti, iptal, QR menü yok) belirteç korunur;
   heartbeat engelliyken her uzlaştırmada gider, engel kalkınca yayın kendiliğinden sürer. Belirteç
   geçersizse (`401` + neden) bağlantı yerelde kalkar (bkz. 3.1).
4. **QR menüyü kapat** (`PUT /cloud/qr { enabled: false }` → `POST /api/pos/menu/unpublish`): menü ve
   masalar buluttan kalkar, **bağlantı kalır** (heartbeat, lisans yenilemesi ve bulut yedeği sürer).
   İnternet yoksa yerelde hemen kapanır, bulut tarafı bağlantı gelince tamamlanır; QR menü kapalıyken
   heartbeat bulutta menü görürse (ör. yedekten dönüş) onu da kaldırır. Eski Worker'da (uç yok) masa
   listesi boşaltılır. Eski uç `DELETE /cloud/connection` artık yalnız QR menüyü kapatır.
5. Masa QR kartları POS'taki **Masa QR kodları** sayfasından basılır (QR menü açılmadan da).
6. Ürün ekranında **Tükendi** düğmesi: ürün menüde soluk "Tükendi" rozetiyle kalır, siparişe
   eklenemez (`PRODUCT_UNAVAILABLE`).

### 3.3 Müşteri
1. QR → `/m/<kod>` (statik sayfa) → `GET /api/m/<kod>`: menü + masa adı + salon.
2. Görseller `/img/<anahtar>` (R2, süresiz önbellek).
3. Durumlar: geçersiz kod (404 `TABLE_NOT_FOUND`), paket/askı/lisans bitti (403 `MENU_DISABLED`),
   menü henüz yok (404 `MENU_NOT_PUBLISHED`), bağlantı hatası (tekrar dene).

### 3.4 Satıcı
1. İşletmeleri ve lisansları listeler; ayrıntıda şubeyi, son görülme zamanını, POS sürümünü ve son
   heartbeat sağlığını (veritabanı ve yedek boyutu, boş disk, son yedek ve bulut yedeği) görür.
2. Askıya alır ya da özellik istisnası verir (`PATCH /api/admin/tenants/:id`).
3. Lisans kaydeder ya da yeniler (`PUT /api/admin/licenses`; kayıt geri gitmez); POS yeni lisansı
   bir sonraki heartbeat'te alır.
4. Çalınan ya da iade edilen lisansı iptal eder (`POST /api/admin/licenses/:id/revoke`): bağlanma ve
   yenileme reddedilir, yayın durur, menü kalkar; işletme silinse de geçerlidir (`unrevoke` kaldırır).
   Bilgisayar değişiminde POS bağlantısını kaldırır (`POST /api/admin/tenants/:id/revoke`); işletmeyi
   silebilir (lisans kaydı kalır).

---

## 4. Bulut veri modeli (D1, `apps/cloud/migrations`)

| Tablo | İçerik |
|---|---|
| `tenants` | İşletme: ad, paket, özellik istisnaları, durum (active/suspended), lisans kimliği ve bitişi (`0002`). |
| `branches` | Şube: ad, POS belirteç özeti, bağlanma ve son görülme zamanı; bağlı kurulum, POS şube kimliği ve sürümü (`0002`); son heartbeat sağlığı `health_*` (`0004`). |
| `pos_token_revocations` | Geçersiz kılınan POS belirteçleri (özet) ve nedeni: `rotated`, `superseded`, `revoked`, `unpaired` (`0002`). |
| `licenses` | Lisans kaydı (`0004`): lisans numarası, son imzalı anahtar (geri gitmez), müşteri, plan, `exp`, ek süre, bitiş anı, özellikler, kaynak (`activation`/`renewal`/`admin`), iptal (`revoked_at`, neden), not, bulut yedeği kotası. İşletme silinince `tenant_id` NULL olur, kayıt kalır. |
| `cloud_backups` · `cloud_backup_downloads` | Bulut yedeği kayıtları ve kısa ömürlü indirme jetonları (`0005`; dosyalar R2 `BACKUPS`). |
| `menus` | Şube başına menü anlık görüntüsü (JSON), sürüm, güncellenme zamanı. |
| `tables` | Masa: kod, ad, salon, sıra. |
| `images` | Yüklenmiş görsel anahtarları (R2'deki nesneler). |
| `rate_limits` | Hız sınırı sayaçları. |

`0003_remove_panel.sql` panel tablolarını (`users`, `sessions`, `pairing_codes`) ve `branches.source`
sütununu kaldırır, lisanssız işletmeleri siler. Uygulamadan önce D1 Time Travel yer imi alınır.
`0004` öncesi açılmış işletmelerin lisansları kayda, POS 0.4.0'a yükseldiğinde bir kez gönderilen
lisans yenilemesiyle (`PUT /api/pos/license`) girer.

---

## 5. API özeti

Yanıt zarfı POS ile aynıdır: `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`.

**Genel (oturumsuz)**
- `GET /api/m/:code` — masa + menü (ETag / 304)
- `GET /img/:key` — görsel
- `GET /api/health`

**POS** (`Authorization: Bearer adoqr_pos_…`; etkinleştirme hariç)
- `POST /api/pos/activate` `{ licenseKey, installId, posBranchId?, branchName?, takeover? }` →
  belirteç, işletme, şube ve lisans bilgisi (`LICENSING.md`). İmza ve lisans kimliği şart; QR menü
  şart değil, süresi dolmuş ama imzalı lisans ve askıdaki işletme de bağlanır (yayın kapalı kalır).
  İşletme lisans kimliğiyle ilk bağlanmada açılır; lisans kayda yazılır (geri gitmez), işletme
  alanları kayıttaki geçerli lisanstan gelir. Aynı kurulum yeniden bağlanınca belirteç yenilenir;
  başka kurulumda bağlıysa `409 ACTIVE_ON_OTHER_INSTALL`, onayla (`takeover`) devralınır. İptal
  edilmiş lisans `403 LICENSE_REVOKED`. `LICENSE_PUBLIC_KEY` boşsa `503 ACTIVATION_DISABLED`.
- `POST /api/pos/heartbeat` (`@ado/shared/cloud-api` heartbeatRequestSchema: sürüm, sağlık, lisans
  numarası ve `exp`; alanlar `null` olabilir, atlanamaz) → işletme bilgisi + `remote: { state,
  update? }` + `serverTime` + `menu`. `update` yalnız kayıtta aynı numaralı, daha geç `exp`'li
  anahtar varsa ve lisans iptal değilse döner.
- `PUT /api/pos/license` `{ licenseKey }` — yenileme: aynı lisans kimliği, belirteç değişmez
  (`409 LICENSE_ID_MISMATCH`); QR menüsüz ya da süresi dolmuş lisans da kabul edilir, kayıt geri
  gitmez; iptal edilmişse `403 LICENSE_REVOKED`.
- `GET /api/pos/status` — işletme (durum, paket, özellikler), lisans, menü sürümü (eski POS'lar ve
  heartbeat'i olmayan eski Worker'a düşüş için).
- `POST /api/pos/images/check` `{ keys }` → `{ missing }` · `PUT /api/pos/images/:key` (gövde: görsel)
- `PUT /api/pos/menu` (menü anlık görüntüsü) · `PUT /api/pos/tables` `{ tables }` — iptal edilmiş
  lisans, askıda işletme, dolan lisans ya da QR menü hakkı yoksa `403` (`LICENSE_REVOKED` /
  `TENANT_SUSPENDED` / `LICENSE_EXPIRED` / `QR_MENU_NOT_LICENSED`); belirteç geçerli kalır.
- `POST /api/pos/menu/unpublish` — "QR menüyü kapat": menü ve masalar yayından kalkar, bağlantı kalır.
- `POST /api/pos/unpair` — eski (0.3.0) "QR menüyü kapat": menü ve masalar kalkar, belirteç iptal.
  Yeni POS yalnız eski bağlantıları kapatırken kullanır.
- Geçersiz belirteçte `401` nedeniyle döner: `POS_TOKEN_ROTATED` / `POS_TOKEN_SUPERSEDED` /
  `POS_TOKEN_REVOKED` / `POS_TOKEN_UNPAIRED` / `POS_TOKEN_INVALID`.
- POS `X-Ado-Version` başlığı (ya da heartbeat'teki `appVersion`) şube kaydına yazılır.

**Satıcı** (`Authorization: Bearer <ADMIN_TOKEN>`)
- `GET /api/admin/plans` · `GET /api/admin/tenants` · `GET/PATCH /api/admin/tenants/:id` (ad, paket,
  özellik istisnaları, askıya alma; ayrıntıda şube sağlığı ve lisans kaydı) ·
  `DELETE /api/admin/tenants/:id` (lisans kaydı kalır)
- `POST /api/admin/tenants/:id/revoke` — POS bağlantılarını kaldırır (`POS_TOKEN_REVOKED`)
- `GET /api/admin/licenses` (işletme, son görülme, sürüm, sağlık, iptal) ·
  `GET /api/admin/licenses/:id` (imzalı anahtar dahil)
- `PUT /api/admin/licenses` `{ licenseKey, notes? }` — kaydet/yenile: imza doğrulanır, kimlik şart,
  geri gitmez (`applied`), işletme varsa alanları güncellenir
- `POST /api/admin/licenses/:id/revoke` `{ reason? }` · `POST /api/admin/licenses/:id/unrevoke`

POS tarafındaki uçlar (`/cloud/*`, ürün görseli, "tükendi", masa kodu): `API_DESIGN.md` §5.1, §5.2, §5.12.

---

## 6. Sınırlar (`MENU_LIMITS`)

Ürün/kategori adı 120, açıklama 600, işletme adı 60, adres 160, telefon 30, masa ve salon adı 60
karakter; fiyat en fazla 1 000 000 TL; en fazla 200 kategori, 2 000 ürün, 500 masa; görsel en fazla
1 MB. D1'in sorgu başına 100 parametre sınırı nedeniyle listeler `json_each` ile tek parametrede
gider.

---

## 7. Testler

- `apps/cloud/test` (vitest, gerçek workerd, yerel D1/R2): genel menü, lisansla bağlanma
  (`activate.test.ts`: QR menüsüz ve süresi dolmuş lisans, askı, kayıt geri gitmez), heartbeat
  (`heartbeat.test.ts`: durum matrisi, yenileme kuralı, sağlık, 401, iptal), lisans kaydı
  (`licenses.test.ts`: imza, geri gitmeme, iptal ve işletme silinse de kalması), POS yayını ve
  kapatma (`pos.test.ts`), satıcı API'si, paketler; eski panel ve eşleştirme yollarının kalktığı.
- Backend smoke (`apps/backend/test/smoke.e2e.mjs`) QR ve BULUT bölümleri: sahte bulut, QR menüsüz
  lisansla kendiliğinden bağlanma ve heartbeat, `license.remote` olayı, QR menüyü açma ve otomatik
  yayın (işletme bilgisi ve salon dahil), hata ve yeniden deneme, uzlaştırma, askı ve dönüş, lisans
  yenileme, kapatınca bağlantının kalması (internetsiz kapatma dahil), devralma (kendiliğinden geri
  alınmaz), internetsiz bağlanma, iptal ve kaldırılması. CI `e2e` işi anahtar çiftini her koşumda
  üretir (`scripts/license.mjs gen-key --github-env`).
- Spawned `apps/backend/test/cloud-link.spawn.e2e.mjs` (kendi backend'i ve sahte bulutu): heartbeat
  aralığı, QR kapalıyken bulutta kalan menünün kaldırılması, eski Worker'a düşüş (status, masa
  listesi), 0.3.0'dan yükseltme (yeniden başlatmayla).
- Playwright `apps/frontend/e2e/menu-screen.spec.ts` (POS ürün ekranı) ve `qr-menu.spec.ts`
  (POS + `wrangler dev`: lisansla kendiliğinden bağlanma, QR menüyü açma, otomatik yayın, tükendi,
  kapatınca QR'ın çalışmaması ve bağlantının kalması, 390 px müşteri sayfası; eski panel adresinin
  bilgi sayfası ve kendini silen service worker). CI: `e2e-cloud` işi.
- Self-check'ler: `@ado/shared/menu`, `@ado/shared/cloud-api`, `cloud.snapshot`, `cloud.state`
  (bağlantı ve QR durum matrisi, heartbeat gövdesi), qr-web `menu-view`.

---

## 8. Sonraya kalanlar

- Kalıcı alan adı ve canlı bulut; geçişte QR kartları yeniden basılır.
- İşletme logosu ve renk teması.
- QR-2 sipariş, QR-3 uzaktan ödeme ve hesap bölme (ödeme sağlayıcısı QR-3'te seçilecek),
  QR-4 oyunlar ve şans çarkı.
