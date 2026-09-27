# CHANGELOG

Tüm önemli değişiklikler burada tutulur. Format: [Keep a Changelog](https://keepachangelog.com/),
Sürümleme: [SemVer](https://semver.org/).

## [Unreleased]

### Added
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

### Fixed
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
