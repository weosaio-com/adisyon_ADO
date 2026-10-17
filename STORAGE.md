# STORAGE.md — Depolama, Akıllı Saklama ve Günlük Temizlik

> Kasa bilgisayarının diski dolmasın diye program neyi tutar, neyi ne zaman siler, neye **asla**
> dokunmaz. Kod: `apps/backend/src/backup/` (yedek biçimi, parmak izi, saklama kuralları) ve
> `apps/backend/src/maintenance/` (günlük temizlik, `/storage`).

---

## 1. Neden?

Denetimde görülen sorunlar:

- Her gün 06:00'da alınan tam yedekler **hiç silinmiyordu** ve sıkıştırılmıyordu (yılda onlarca GB).
- Bulut klasörüne (OneDrive/Drive) alınan kopyalar da hiç silinmiyordu.
- Teknik tablolar (arka plan işleri, fiş işleri, oturumlar…) sonsuza kadar büyüyordu.
- Disk %95 dolunca `/health` 503 dönüyor, masaüstü programı yanıltıcı bir mesajla **hiç açılmıyordu**.

Sahibin onayıyla "akıllı saklama" uygulandı.

## 2. Diskte ne büyür?

| Ne | Nerede | Nasıl sınırlanır |
|---|---|---|
| Veritabanı (`ado.db`) | Veri dizini (paketli sürümde Electron `userData`) | İşletme verisi silinmez; yalnız teknik tablolar temizlenir (§6) |
| Yedekler (`backups/*.db.enc`) | Veri dizini `backups/` | Sıkıştırılmış biçim (§3) + akıllı saklama (§5) |
| Bulut klasörü kopyaları | Ayarlardaki **Bulut klasörü** (`backup.cloudDir`) | Yedek silinince kopyası da silinir (§5.3) |
| Ürün görselleri | Veri dizini `images/` | Hiçbir ürünün göstermediği eski görseller silinir (§6) |
| Kayıt (log) dosyaları | `backend-error.log` (+ `.1`) | Masaüstü kabuğu 10 MB'ta döndürür (en fazla ~20 MB) |
| Güncelleme öncesi kopyalar | Veri dizini `pre-migrate/` | Masaüstü kabuğu en yeni 3'ünü tutar |
| Geri yükleme öncesi kopyalar | Veri dizini `ado.pre-restore-*.db` | Yalnız en yenisi kalır (§6) |

## 3. Yedek biçimi (v2)

- Yeni yedekler **sıkıştırılmış ve şifreli** akış biçimindedir: başlık (`ADOBAK2\0` + sürüm + bayraklar
  + IV) + AES-256-GCM(gzip(SQLite)) + sonda 16 baytlık doğrulama etiketi. Başlık şifrelemeye bağlıdır
  (kurcalanırsa açılmaz).
- Şifreleme ve çözme **akışla** yapılır: bellek kullanımı veritabanı boyutuyla büyümez.
- `Backup.checksum` diskteki dosyanın **tamamının** sha256 özetidir (bulut yedeği bununla doğrular).
- Eski biçimdeki (v1) yedekler aynen açılır; kurtarma anahtarı iki biçimi de açar.
- Dışarıdan yedek yükleme sınırı **8 GB**; dosya diske akıtılır, biçimi dosyadan okunur.

## 4. Günlük otomatik yedek (06:00)

- Ayarlar › Yedekler › **Günlük otomatik yedek** kapatılabilir.
- **Veri değişmediyse yedek alınmaz.** Her tablo için satır sayısı ve en son değişiklik anından bir
  "parmak izi" çıkarılır; en yeni otomatik yedeğin izi aynıysa (ve dosyası duruyorsa) o gün yedek
  atlanır (loga yazılır). Elle alınan ve güncelleme öncesi yedekler **her zaman** alınır.
- Parmak izine girmeyenler (işletme verisi değişmeden kendiliğinden değişirler): `backups`,
  `background_jobs`, `sessions`, `print_jobs`, `processed_client_ops`, `cloud_backup_uploads`,
  migration tabloları, SQLite'ın kendi `sqlite_*` tabloları ve geçici ayarlar (bulut bağlantı
  durumu, son temizlik, lisans saati…; `setting-keys.ts` › `isVolatileSettingKey`).
- Kullanıcı girişi de bir değişikliktir (son giriş zamanı): dükkân açık olduğu sürece her gün yedek
  alınır; kapalı günlerde alınmaz.

## 5. Akıllı saklama

Her başarılı yedekten sonra ve her gün 05:30'daki bakımda uygulanır.

### 5.1 Kurallar

| Tür | Kalanlar |
|---|---|
| Otomatik | En yeni **3** yedek her zaman; son **7 günün her günü**, son **4 haftanın her haftası** (ISO hafta) ve son **6 ayın her ayı** için en yeni birer yedek |
| Elle, güncelleme öncesi, dışarıdan yüklenen | **90 gün**; her türün en yeni **3** yedeği her zaman |

Gün/hafta/ay dükkânın yerel takvimine göredir. Günlük yedekle bir yılda otomatik yedek sayısı ~20'yi
geçmez.

### 5.2 Disk azaldı modu

Veri dizininin bulunduğu sürücüde boş alan **%10'un altına** ya da **2 GB'ın altına** düşerse:
yalnız en yeni **3 otomatik** yedek ve diğer her türün en yeni **1** yedeği kalır. Depolama kartında
kırmızı uyarı görünür.

### 5.3 "Silmek" ne demek?

1. Yerel yedek dosyası silinir — **yalnız** yedek klasörünün içindeki ve bizim adlandırmamıza uyan
   (`backup_*.db.enc`, `imported_*.db.enc`) dosyalar. Klasör dışını gösteren eski kayıtların
   dosyasına dokunulmaz, yalnız kayıt kaldırılır.
2. Bulut klasöründeki kopyası silinir — **yalnız** ayarlı `backup.cloudDir` klasörünün doğrudan
   içindeki `backup_*.db.enc` dosyası (`Backup.cloudCopyPath`; eski kayıtlarda klasör + aynı dosya
   adı). Bulut klasörü ayarı boşsa ya da değiştiyse eski kopyalara dokunulmaz.
3. Kayıt silindi olarak işaretlenir (`deletedAt`; satır silinmez).

Windows'ta dosya kilitliyse (`EBUSY`/`EPERM`; antivirüs, OneDrive eşitlemesi) hata verilmez: loga
yazılır, bir sonraki çalışmada tekrar denenir. Ayarlar'dan elle silme de bulut kopyasını siler.

## 6. Günlük bakım (05:30)

Kendi zamanlayıcısıyla çalışır (mutfak fişlerinin de geçtiği arka plan iş kuyruğunu yormaz). Ayarlar ›
**Depolama** › **Şimdi temizle** ile hemen de çalıştırılabilir (denetim kaydına yazılır).

| Silinen | Koşul |
|---|---|
| Eski yedekler | Akıllı saklama kuralları (§5) |
| Arka plan işleri (`background_jobs`) | Bitmiş (`completed`) ya da kalıcı başarısız (`failed`) ve **30 günden** eski |
| Fiş işleri (`print_jobs`) | Basılmış (`done`) ya da listeden kaldırılmış ve **90 günden** eski — fişin kendisi `receipts`'te kalır |
| Tablet işlem defteri (`processed_client_ops`) | **30 günden** eski |
| Oturumlar (`sessions`) | İptal edilmiş ya da süresi dolmuş ve **30 günden** eski |
| Ürün görselleri (`images/`) | Hiçbir ürün (silinmişler dahil) göstermiyor ve **7 günden** eski (yüklenen görsel ürüne bağlanmadan önce yazılır) |
| Yedek klasöründeki artıklar | `temp_*.db(.enc)` ve bekleyen geri yüklemenin kullanmadığı `restore_staging_*.db`, **1 günden** eski |
| Geri yükleme öncesi kopyalar | `ado.pre-restore-*.db`: yalnız en yenisi kalır |

Ardından `PRAGMA optimize` çalışır ve özet `storage.lastCleanup` ayarına yazılır
(`{at, trigger, lowDisk, deleted: {...}, freedBytes, errors}`). Kayıtlar 1000'lik parçalarla silinir;
satış beklemez.

## 7. Asla silinmeyenler

- **Denetim kaydı** (`audit_logs`) — hiçbir koşulda.
- İşletme verisi: siparişler ve kalemleri, ödemeler, fişler (`receipts`), kasa oturumları ve
  hareketleri, müşteriler ve veresiye hareketleri, gelir-gider, stok, ürünler, masalar, kullanıcılar,
  ayarlar.
- Bulut klasöründeki başka dosyalar ve yedek klasörü dışındaki her şey.
- Yedek kayıtlarının satırları (yalnız silindi olarak işaretlenir).

## 8. Depolama kartı ve uç noktalar

- **Ayarlar › Depolama** (izin: `backup.manage`): veritabanı, yedekler (adet + boyut), ürün
  görselleri, kayıt dosyaları, boş/toplam disk, disk azaldı uyarısı, son temizlik, **Şimdi temizle**.
- `GET /api/v1/storage` → `{dbBytes, backups: {count, totalBytes}, imagesBytes, logsBytes,
  freeDiskBytes, totalDiskBytes, lowDisk, lastCleanup}` (disk okunamazsa boş/toplam `null`).
- `POST /api/v1/storage/cleanup` → saklama + temizlik hemen; özet döner.
- Her iki uç da lisans kilitliyken açıktır (disk dolarsa temizlik yapılabilmeli).
- Buluta giden sağlık bilgisi (`InstallMetricsService`, `storage`): `dbBytes`, `backupsBytes`,
  `freeDiskBytes`, `lastBackupAt`.

## 9. `/health` ve masaüstü açılışı

- `/health` artık **yalnız veritabanını** denetler (canlılık). Disk dolu olsa da 200 döner; disk
  bilgisi `/storage`'dadır. Masaüstü kabuğu, CI ve yayın duman testi `/health` 200 bekler.
- Masaüstü kabuğu backend'in kapanmasını sağlık kontrolüyle yarıştırır: backend açılırken kapanırsa
  hemen, yanıt vermezse 60 sn sonra gerçek sebebi (çıkış kodu ya da zaman aşımı), son kayıtları ve
  `backend-error.log` dosyasının yolunu gösterir.

## 10. Eşikler (kodda)

| Sabit | Değer | Dosya |
|---|---|---|
| `RETENTION` | 3 / 7 gün / 4 hafta / 6 ay / 90 gün | `backup/backup.retention.ts` |
| `LOW_DISK` | boş < %10 ya da < 2 GB | `backup/backup.retention.ts` |
| `PURGE_DAYS` | işler 30, fiş işleri 90, işlem defteri 30, oturum 30, görsel 7, geçici dosya 1 gün | `maintenance/maintenance.rules.ts` |
| `MAX_IMPORT_BYTES` | 8 GB | `backup/backup.service.ts` |
| Zamanlama | yedek 06:00, bakım 05:30 | `BackupService.dailyAutoBackup`, `MaintenanceService.dailyCleanup` |
| `BACKEND_START_TIMEOUT_MS` | 60 sn | `apps/desktop/startup.mjs` |
