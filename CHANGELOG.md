# CHANGELOG

Tüm önemli değişiklikler burada tutulur. Format: [Keep a Changelog](https://keepachangelog.com/),
Sürümleme: [SemVer](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-19

### Yükseltme notları

- **0.3.0 kurulu bilgisayar 0.4.0'ı kendiliğinden almaz** (0.3.0'daki güncelleme anahtarı hatası,
  aşağıda Fixed). 0.4.0 bir kez elle kurulur; sonraki sürümler kendiliğinden gelir.
- Deneme profilinde lisans zorunludur: lisans girilmemiş kurulumda güncellemeden sonra yeni adisyon
  açılmaz (menü, masa, kullanıcı ve rapor açık kalır). Önce lisansı girin.
- İlk açılışta veritabanı geçişleri çalışır (yedek boyutu, rapor indeksleri, bulut yedeği kaydı);
  öncesinde `pre-migrate` kopyası alınır. Eski yedekler (v1) açılmaya devam eder.
- Akıllı saklama, güncellemeden sonraki ilk yedekte ya da günlük temizlikte kurala uymayan eski
  yedekleri siler (sahibin onayıyla "yedekler asla silinmez" kuralının yerini aldı).

### Added

- **Akıllı yedek saklama:** yedekler sıkıştırılmış akış biçiminde (v2: gzip + AES-256-GCM, etiket
  sonda) alınır, bellek veritabanı boyutuyla büyümez. Son 7 günün her günü, son 4 haftanın her
  haftası, son 6 ayın her ayı için birer yedek kalır; elle/güncelleme öncesi/içe aktarılan
  yedekler 90 gün; en yeni 3 hiç silinmez; disk azsa yalnız en yeniler kalır. Bulut klasörü
  kopyaları da aynı kurala uyar ve arayüzden silinince birlikte silinir. Değişiklik yoksa günlük
  otomatik yedek alınmaz. İçe aktarma sınırı 8 GB (akışla). `STORAGE.md`.
- **Günlük temizlik (05:30):** biten arka plan işleri, eski yazdırma işleri, işlenmiş çevrimdışı
  işlem kayıtları, eski oturumlar, yetim görseller ve artık geçici dosyalar silinir;
  `PRAGMA optimize`. Denetim ve iş kayıtlarına dokunulmaz.
- `GET /storage` ve `POST /storage/cleanup`; Ayarlar'da **Depolama** kartı.
- Rapor sorguları için tarih indeksleri (ödeme, fiş, gider, gelir, veresiye hareketleri).
- **Her lisanslı kurulum buluta bağlanır:** QR menü gerekmeden, açılışta ve lisans girilince;
  saatlik heartbeat ile son görülme, sürüm ve sağlık (veritabanı/yedek boyutu, boş disk, son
  yedek) buluta gider; bulut lisans durumunu bildirir ve yenilenen lisansı gönderir
  (`license.remote`). Bulutta lisans kaydı (`licenses`), `POST /api/pos/heartbeat`,
  `POST /api/pos/menu/unpublish`, satıcı API'si `GET/PUT /api/admin/licenses`, `revoke`,
  `unrevoke`; iptal edilen lisans işletme silinse de bağlanamaz. `scripts/license.mjs register`.
- `PUT /cloud/qr`: QR menü bağlantıdan ayrı açılır/kapanır; Lisans kartında bulut bağlantısı satırı.
- **Otomatik bulut yedeği:** yerel yedeğin şifreli hali (dükkânın kendi anahtarıyla; bulut okuyamaz)
  buluta yüklenir: 95 MB'a kadar tek parça, büyükse kaldığı yerden devam eden parçalı yükleme;
  hata olursa 1/5/15 dk sonra, sonra saatte bir yeniden dener. Bulutta lisans başına en yeni 30 +
  son 12 ayın her ayından bir yedek kalır; kota 10 GiB. İlk kurulumda **Buluttan geri yükle**
  (lisans anahtarı + kurtarma anahtarı). Bulutta `/api/pos/backups/*` (R2 `BACKUPS`), `cloud.backup`
  özelliği varsayılan açık. Ayarlar'da **Bulut yedeği** kartı. `CLOUD_BACKUP.md`.

- **Lisans politikası (satışa hazırlık):** lisans girilmeden yeni adisyon açılmaz (deneme 0 gün);
  bitişten 14 gün önce uyarı şeridi, sonra 7 gün ek süre (lisanstaki `g` öncelikli), sonra yalnız
  **yeni adisyon** kilitlenir (`403 LICENSE_LOCKED`; çevrimdışı `OPEN_TABLE` reddedilir, tablet
  kuyruğu tıkanmaz). Açık adisyon ödenir/kapanır; rapor, yedek, ayar her zaman açık. Bulutun
  askıya alma/iptal bildirimi 7 gün ek süreyle aynı kurala bağlanır; bulutun gönderdiği yeni lisans
  imzası doğrulanıp kendiliğinden kurulur. Saat geri alınmasına karşı koruma (bulut saatiyle
  düzeltme). Paketli sürümde zorunluluk açık (derleme profili: `licenseEnforce`, `trialDays`,
  `graceDays`, `supportContact`). Uyarı şeridi ve lisans kilit penceresi. `LICENSING.md` §8.

### Changed

- `/health` yalnız veritabanına bakar: disk dolu olsa da program açılır.
- Masaüstü açılışında backend kapanırsa hata hemen ve gerçek nedeniyle (çıkış kodu, son satırlar,
  log yolu) gösterilir.
- `backups.size_bytes` BigInt (2 GB üstü veritabanı) ve `format` sütunu.
- Tüm yazmaları durduran eski lisans koruyucusu (`LicenseGuard`) kaldırıldı; kilit yalnız yeni
  adisyondadır.
- Bulutta etkinleştirme artık `qr.menu` istemez; süresi dolmuş imzalı lisans ve askıdaki işletme de
  bağlanır (menü kapalı kalır). `GET /cloud/status` `mode` yerine `link` + `qr` döner; "QR menüyü
  kapat" bağlantıyı kesmez. Denetim eylemleri `cloud.qr.enable` / `cloud.qr.disable`.

### Fixed

- Paketli sürüm, kurulum dosyasındaki `app-config.json`'dan güncelleme açık anahtarlarını okuyamıyor
  ve otomatik güncelleme kapalı kalıyordu (0.3.0 paketinde); artık iki biçim de okunur.

### Security

- Deneme (`test`) profilinin güncelleme imza anahtarı yenilendi (2026-10-19). Yeni anahtar satıcının
  tarayıcısında üretildi; özel yarısı sohbete ve depoya girmedi. Eski anahtarla imzalanan güncelleme
  kabul edilmez.

## [0.3.0] - 2026-10-11

### Added
- **Sürüm yayınlama (2026-10-11):** `.github/workflows/release.yml` — Windows'ta derleme, paketli
  programın açılış denemesi, onaylı ortamda imzalı bildirim, R2'ye yükleme (önce kurulum dosyası, en
  son bildirim), buluttan sunulduğunun denetimi ve GitHub sürümü. `scripts/update-manifest.mjs verify`
  `--latest` ile `latest.yml`'i bildirimle karşılaştırır ve virgülle birden çok anahtar alır. Bkz.
  `UPDATE_SYSTEM.md` §6.
- **Otomatik güncelleme (2026-10-11):** program yeni sürümü kendisi denetler ve indirir; kurulum
  yalnız yönetici onayıyla. Bkz. `UPDATE_SYSTEM.md`.
  - **Masaüstü:** electron-updater 6.8.9 (sabit sürüm); önce Ed25519 imzalı `ado-update.json`
    doğrulanır, `latest.yml` ve indirilen dosya imzalı SHA-512 ile eşleşmeli; açılıştan 2 dk sonra ve
    6 saatte bir denetim; derleme profilinde `channel` ve `updatePublicKey`; kurulum dosyası
    `Adisyon-POS-Setup-<sürüm>.exe`.
  - **Backend:** `GET /updates/status`, `POST /updates/check`, `POST /updates/approve` (`update.manage`,
    kasa bilgisayarı, açık adisyon/kasa yok; önce `pre_update` yedeği, `UpdateHistory` ve denetim
    kaydı); yeni sürüm açılınca kayıt "kuruldu"/"kurulamadı".
  - **Program:** Ayarlar › Güncelleme kartı (durum, indirme yüzdesi, engeller, **Güncellemeyi kur**).
  - **Bulut:** `/updates/<kanal>/<dosya>` R2 `UPDATES` deposundan (bildirim önbelleksiz, kurulum
    dosyası süresiz, tek aralık desteği).
  - **Araç:** `scripts/update-manifest.mjs` (gen-key/sign/verify) ve self-check'leri; IPC ile gerçek
    backend'e karşı onay e2e'si (`test:e2e:updates`, CI e2e işi).
- **QR menü lisansla açılır (2026-10-10):** programda **Ayarlar › QR Menü › QR menüyü aç** tek tık;
  bulut adresi programa gömülü (derleme profili), adres ve eşleştirme kodu girilmez.
  - **Lisans:** lisans kimliği (`id`), satıcı imza aracı `scripts/license.mjs`
    (gen-key/sign/verify), derleme profilleri (`apps/desktop/profiles`), veritabanı dışında kurulum
    kimliği. Bkz. `LICENSING.md`.
  - **Bulut:** `POST /api/pos/activate` (Ed25519 imza; işletme lisans kimliğiyle açılır, lisans tek
    kurulumda açık, onayla devralma), `PUT /api/pos/license` (yenileme), nedenli `401`, askı ve
    bitişte `403`; D1 `0002_license_activation.sql` (yalnız ekleme).
  - **Program:** kart her durumda ne yapılacağını söyler (lisans yok, QR menü yok, süre doldu,
    internet bekleniyor, başka bilgisayarda, bağlantı kalktı, askıda); işletme bilgisi ve salon
    değişikliği de yayınlanır; uzlaştırma kaçan yayını, internetsiz açma/kapatmayı ve lisans
    yenilemesini tamamlar (`CLOUD_RECONCILE_SECONDS`). `POST /cloud/activate`, `/cloud/pair` kalktı.
  - **Testler:** bulut `activate.test.ts`, backend smoke 126 kontrol (sahte bulut + imzalı test
    lisansı), Playwright `qr-menu.spec.ts` lisansla açma ve kapatma; CI her koşumda test anahtarı
    üretir.
- **Uygulama olarak yükleme ve internetsiz çalışma (2026-10-05):** işletme paneli ve adisyon,
  telefona ve bilgisayara mağazasız yüklenen uygulama (PWA) oldu; web'den açılmaya devam eder. QR
  menü yalnız web'de kalır.
  - **İşletme paneli (`apps/qr-web` `/panel`):** "Uygulamayı yükle" (iPhone/iPad'de Ana Ekrana Ekle
    yönergesi), simgeler ve manifest; service worker yalnız `/panel` kapsamında, müşteri sayfasında
    yok. Son menü, masalar ve QR kartları cihazda saklanır (IndexedDB); panel internetsiz açılır.
    Menü ve fotoğraflar internetsiz düzenlenir, **internet gelince kendiliğinden yayınlanır**
    (sürüm kontrollü; çakışmada üzerine yazmaz). Çıkışta cihaz verisi silinir.
  - **Adisyon (`apps/frontend`):** giriş ekranında ve Ayarlar › Sunucu Adresi kartında "Uygulamayı
    yükle"; kartta tablet/telefonun kamerayla okutacağı **sertifika** ve **adisyon** QR kodları ile
    "İşletmede WiFi yoksa" yönergesi. Bağlantısız cihazda **Ödeme al** pasif ve nedeni yazılı
    (ödeme yalnız ana makinede). Telefonda ürünler ve adisyon ayrı görünüm (alt şeritte özet).
    Çevrimdışı taslakta yanlış "Gel-al" rozeti düzeltildi.
  - **Masaüstü:** QR menü kartından işletme paneli açılır; dış bağlantılar sistem tarayıcısında açılır.
  - **Bulut test ortamı:** `wrangler.jsonc` › `env.test` (ayrı Worker `ado-qr-test`, D1 ve R2),
    `deploy:test` ve `db:migrate:test` betikleri; kurulum `apps/cloud/README.md` › Test ortamı.
  - **Testler:** `qr-menu.spec.ts` panel uygulaması ve internetsiz yayın; `offline.spec.ts` ödeme
    notu; `pos-flow.spec.ts` 390 px garson akışı ve kurulum QR kodları; qr-web self-check'leri
    `image-key` ve `sync-core`.
- **QR menü — dijital menü (QR-1, 2026-09-30):** müşteri masadaki QR kodu okutur, menüyü telefonda
  görür: fotoğraf, açıklama, 14 alerjen, diyet etiketleri, TR/EN, "tükendi". Bkz.
  `QR_MENU_DESIGN.md`.
  - **POS:** üründe **QR menü bilgileri** (açıklama, alerjen, diyet, İngilizce ad, görsel — tarayıcıda
    800 px WebP), **Tükendi** düğmesi (`PATCH /products/:id/availability`; tükenen ürün siparişe
    eklenemez, `PRODUCT_UNAVAILABLE`), masaya tahmin edilemez QR kodu (`POST /tables/:id/public-code`).
    **Ayarlar › QR Menü (Bulut)** kartı: eşleştirme kodu ile bağlanma, ürün/kategori/masa değişince
    5 sn birleştirilmiş otomatik yayın ve yeniden deneme (`/cloud/*`); yazdırılabilir masa QR
    kartları (`/qr-codes`). Veritabanı: `20260928120000_qr_menu_fields` (yalnız sütun ekler).
  - **Bulut `apps/cloud`** (Cloudflare Worker + D1 + R2): müşteri menüsü (`/api/m/:code`, ETag),
    içerik adresli görseller, POS yayın API'si, işletme paneli API'si (çerez oturumu, CSRF, sürüm
    kontrollü kayıt), satıcı API'si (`ADMIN_TOKEN`), paketler (`menu`/`order`/`pay`/`full`). Kurulum
    ve yayına alma: `apps/cloud/README.md`.
  - **`apps/qr-web`:** müşteri menüsü `/m/:code` (arama, kategori sekmeleri, diyet ve "içermesin"
    alerjen filtresi, ürün ayrıntısı, durum ekranları) ve işletme paneli `/panel` (POS'suz işletmede
    menü yönetimi, masalar ve QR yazdırma, işletme bilgileri, POS eşleştirme, parola değiştirme).
  - **Ortak şema:** `@ado/shared/menu` (zod) ve tarayıcı için bağımlılıksız `@ado/shared/menu-core`.
  - **Testler:** bulut vitest 30 (gerçek workerd), backend smoke 86 → 112 kontrol, Playwright
    `menu-screen.spec.ts` ve `qr-menu.spec.ts` (POS + yerel bulut; POS'lu ve POS'suz akış); CI'da
    yeni `e2e-cloud` işi.
- **Yazıcı kurulumu (2026-09-27):** Ayarlar > Yazıcılar — Windows'ta yüklü yazıcıyı seçip ekleme
  (`GET /printers/discover`), test sayfası, mutfak/müşteri fişi ve kategoriye özel (bar)
  yönlendirme, son 24 saatin fişleri (önizleme), yazdırılamayan fişi tekrar dene/kaldır
  (`/printers/jobs`). Yazdırılamayan fiş varsa masa ekranında uyarı.
- **Fiş içeriği:** mutfak fişinde salon/masa, gönderen garson, saat ve kalem notu; müşteri fişi ve
  hesapta işletme başlığı (Ayarlar > İşletme Bilgileri, `GET/PUT /settings/business`), ödeme
  satırları, para üstü ve "Bilgi fişidir — mali değeri yoktur."; Türk para biçimi.
- **Sipariş ekranı:** başlıkta salon ve masa, ürün notu (`PUT /orders/:id/items/:itemId/note`),
  yanlış açılan boş adisyonu kapatma (`POST /orders/:id/discard`, garson da), yönetici için
  gerekçeli "İptal et".
- **Kasadan iade ve fiş tekrarı:** Kasa > Son işlemler'de "İade" (adisyon yeniden açılır) ve ödenmiş
  adisyonun müşteri fişini yeniden basma (`POST /printers/order/:id/receipt`).
- **Testler:** Playwright `pos-flow.spec.ts` (garson → mutfak → kasa, parçalı ödeme ve para üstü,
  boş masa, iade, HTTP LAN'dan ödeme); backend smoke 68 → 86 kontrol.
- **Yedek kurtarma anahtarı (2026-09-27):** yedek başka bilgisayarda açılabilir. Ayarlar > Yedekler'de
  yönetici şifresiyle kurtarma anahtarı gösterilir/indirilir; "Dosyadan Geri Yükle" ile bulut
  klasöründeki `.db.enc` içe aktarılır; ilk kurulum ekranında "Yedekten geri yükleyin" seçeneği.
  Kurtarma anahtarıyla açılan yedekte anahtar yeni bilgisayara taşınır. Yedek formatı değişmedi.
- **Yerel HTTPS (2026-09-27):** tabletler için ek port (paketli sürümde 43128), kurulum başına yerel
  CA (`GET /devices/ca.crt`), IP değişince CA değişmeden yenilenen sunucu sertifikası. LAN IP'de
  güvenli bağlam → Service Worker → bağlantı yokken de uygulama açılır. PWA ikonları eklendi.
- **Testler:** backend smoke 55 → 68 kontrol (yedek içe aktarma/kurtarma, TLS); Playwright
  `https-lan.spec.ts`; yeni self-check'ler (event-bus, license.paths, backup.keys, tls.certs,
  print-text, masaüstü restore/log); CI tüm paketlerin self-check'lerini koşar.

### Removed
- **Web işletme paneli (2026-10-10):** QR menü yalnız Adisyon programından yönetilir.
  - `apps/qr-web`: `/panel` uygulaması, manifest ve simgeler, `idb`/`qrcode`/`vite-plugin-pwa`
    bağımlılıkları kalktı. Eski adres "İşletme paneli kaldırıldı" der. Telefonlara yüklenmiş panel
    uygulamasının service worker'ı (`/sw.js`) kendini silen sürümle değişti: önbelleği temizler,
    kaydını kaldırır.
  - `apps/cloud`: `/api/panel/*`, eşleştirme kodu (`POST /api/pos/pair`), satıcının işletme açma,
    eşleştirme kodu ve parola sıfırlama uçları, parola özetleme (PBKDF2) kalktı. İşletmeler POS'un
    lisansla ilk bağlanmasında açılır. D1 `0003_remove_panel.sql`: `users`, `sessions`,
    `pairing_codes` ve `branches.source` silinir, lisanssız işletmeler kalkar (uygulamadan önce Time
    Travel yer imi).
  - Testler: `panel.test.ts` ve Playwright panel testleri silindi; bulut testleri lisansla açılan
    şubeyle yeniden yazıldı; eski panel adresi ve kendini silen service worker için e2e eklendi.

### Fixed
- **Masaüstü programı (2026-10-11):**
  - Program tek kopya çalışır: ikinci açılış aynı veritabanına ikinci bir sunucu başlatmaz, açık
    pencereyi öne getirir.
  - Kapanışta arka plan sunucusu artık kabaca öldürülmüyor: IPC ile `shutdown` mesajı alır, açık
    bağlantıları (canlı akış dahil) keser ve veritabanını kapatır (en fazla 10 sn). Program çökerse
    sunucu kendini kapatır; port ve veritabanı bir sonraki açılışa kilitli kalmaz.
  - Veritabanı güncellemesinden önce `userData/pre-migrate`'e tutarlı kopya (`VACUUM INTO`, son 3).
  - Hızlı yeniden başlatmada yarım kalan arka plan işleri (ör. QR menü yayını) beklemeden yeniden
    kuyruğa alınır; kart "Yayınlanıyor…" durumunda takılı kalmaz.
  - Pencere yerel arayüzden başka adrese gidemez; dış bağlantılar sistem tarayıcısında açılır.
- **Para üstü (2026-09-27):** ödeme ekranında "alınan nakit" alanı yoktu; müşterinin verdiği 200 TL
  yazılınca 145 TL'lik adisyona 200 TL satış kaydediliyordu (gün sonu kasa açığı, şişik ciro).
  Artık adisyon tutarı satış, fazlası para üstü olarak kaydedilir ve ekranda gösterilir.
- **Çift tahsilat:** ödeme işlem anahtarı her tıklamada yenileniyordu; cevap kaybolup tekrar
  basılınca parçalı ödeme iki kez yazılabiliyordu. Aynı giriş için aynı anahtar kullanılır.
- **HTTP'de ödeme:** tabletten `http://<ip>` ile ödeme hiç alınamıyordu (`crypto.randomUUID`
  güvenli bağlam ister). İade sonrası ödeme ekranı "kalan"ı yanlış (0) gösteriyordu.
- **Kasa uygulamasında PIN/şifre sıfırlama:** `window.prompt` Electron'da hata fırlatır; Kullanıcılar
  ekranındaki sıfırlama düğmeleri çalışmıyordu (uygulama içi pencere eklendi).
- **Arayüz:** tablette ürün adları kesiliyordu; pencereler alt menünün altında kalıyordu; silinen
  yazıcının rotaları yeni rota eklemeyi engelliyordu; olmayan yazıcıya test sayfası 500 veriyordu.
- **CI (develop kırmızıydı):** Prettier hataları; e2e job'unda eksik `BACKUP_ENCRYPTION_KEY`;
  e2e-web'de kasa oturumu açılmadığı için offline masa açılamıyordu (test kurulumu düzeltildi).
- **Olay kuyruğu:** kalıcı olay dinleyicilerinin hataları yutuluyordu (`suppressErrors`), worker
  yeniden denemiyordu → mutfak/müşteri fişi ve stok düşümü sessizce kaybolabiliyordu.
- **Windows yazdırma:** yazıcı adı `Out-Printer`'a hiç ulaşmıyordu (`-Command` sonrası argümanlar
  `$args`'a gitmez); boşluklu adlar bozuluyordu. Türkçe karakterler için metin base64 ile gider.
- **Loglar:** `Authorization`/cookie başlıkları loglanıyordu; `backend-error.log` sınırsız
  büyüyordu (sağlık ping'leri loglanmıyor, dosya 10 MB'ta dönüyor).
- **Lisans guard:** izin listesi `/api/v1` öneki yüzünden hiç eşleşmiyordu; zorunluluk açıldığında
  süresi dolan kurulum yeni anahtar giremez, yedek alamazdı.
- **Doküman:** kılavuzda yanlış tablet portu (3001 → paketli 43127/43128) ve çevrimdışı açılış
  iddiası; `.env.example` lisans değişken adı; `CODEOWNERS` yolları; `ARCHITECTURE.md` durumu.

## [0.2.0] - 2026-07-29

### Added
- **İstemci-offline sync API (2026-07-20):** `POST /sync/mutations` (toplu idempotent replay,
  ProcessedClientOp defteri, akıllı birleştirme), `GET /sync/snapshot` (tek istekte aktif durum),
  `GET /sync/health` (token'sız heartbeat), `/offline-reviews` Owner onay kuyruğu
  (yeni_adisyon / yeniden_aç / reddet). Bkz. `OFFLINE_DESIGN.md` §7-9.
- **Cloud yedek (2026-07-19):** şifreli yedeğin isteğe bağlı senkron klasörüne kopyası
  (`backup.cloudDir`) + günlük otomatik yedek 06:00 (`backup.autoDaily`, kapatılabilir).
  Yedekler asla otomatik silinmez.
- **Canlı senkron — SSE (2026-07-19, PR #9):** `GET /events/stream` olay akışı; masa/adisyon
  ekranları anında tazelenir (5 sn polling → SSE + 30 sn emniyet polling'i).
- **Kullanıcı yönetimi (PR #8):** backend CRUD + frontend ekranı.
- **İlk-kurulum sihirbazı (PR #6):** kullanıcısız DB'de owner/garson oluşturma.
- **Frontend MVP + Electron (PR #5):** 14 ekran (satış/kasa/veresiye/finans/rapor/ayarlar),
  LAN statik servis, NSIS masaüstü paketi.
- **Backend Faz-1:** sipariş (indirim/mutfak/held/taşı/merge/split), ödeme (idempotency/split/iade),
  veresiye + CSV ekstre, kasa, gelir-gider, raporlar (gün sonu Z), yazdırma (mutfak/bar ayrımı),
  yedek + restore, kullanıcı/cihaz/ayarlar/health/worker; birim self-check + e2e smoke + CI kapısı.
- **Analiz & tasarım dokümanları:** `CONVENTIONS.md`, `SYSTEM_ANALYSIS.md`, `PROJECT_STRUCTURE.md`,
  `DATABASE_DESIGN.md`, `API_DESIGN.md` (hepsi onaylandı, v1.0).
- **Monorepo iskeleti:** pnpm workspaces (`apps/*`, `packages/*`, `plugins/*`), kök `tsconfig.base.json`
  (strict), Prettier, EditorConfig, `.gitignore`, `.env.example`.
- **`@ado/shared` paketi:** merkezi enum'lar, izin (permission) anahtarları + varsayılan rol haritası,
  para/miktar yardımcıları (kuruş / milis / binde), ULID kimlik üreteci.
- **`prisma/schema.prisma`:** `DATABASE_DESIGN.md`'deki tüm tablolar (40+ model) — her modelde SyncBase
  alanları, finansal append-only tablolar, hash-zincirli `audit_logs`, outbox/sync/conflict tabloları.
  `prisma validate` ✅, client üretildi ✅, shared typecheck ✅.
