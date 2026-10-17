# CLOUD_BACKUP.md — Otomatik Bulut Yedeği

> Tüm veriler dükkân bilgisayarında durur; bilgisayar bozulursa yedeği olmayan işletme verisini
> kaybeder. Program bu yüzden yerel yedeklerin **şifreli kopyasını** kendiliğinden buluta yükler.
> Yeni bilgisayarda ilk kurulum ekranından lisans anahtarı ve kurtarma anahtarıyla geri alınır.
> Bulut yedeklerin içeriğini okuyamaz (anahtar yalnız dükkândadır).

---

## 1. Parçalar

| Yer | Görev |
|---|---|
| `apps/backend/src/cloud-backup/cloud-backup.service.ts` | Yükleyici: zamanlayıcı, `backup.created` dinleyicisi, tek yükleme kilidi, tek parça / multipart yükleme, geri çekilme, durum. |
| `apps/backend/src/cloud-backup/cloud-restore.service.ts` | Yeni bilgisayar: lisansla liste, indirme (özet denetimi), yerel yedeklere alma, geri yükleme. |
| `apps/backend/src/cloud-backup/cloud-backup.plan.ts` | Saf kararlar (self-check'li): geri çekilme, parça planı, yükleme sırası, hata sınıfı. |
| `prisma/schema/cloud_backup.prisma` | `cloud_backup_uploads`: yedek başına yükleme durumu ve multipart devam bilgisi. |
| `apps/frontend/src/screens/CloudBackupCard.tsx` | Ayarlar › Bulut Yedeği kartı (`backup.manage`). |
| `apps/frontend/src/screens/CloudRestoreForm.tsx` | İlk kurulum › "Yedekleriniz buluttaysa: buluttan geri yükleyin". |
| `apps/cloud/src/routes/backups.ts`, `lib/backup-store.ts` | Bulut uçları (`/api/pos/backups/*`), saklama ve kota. |
| `packages/shared/src/cloud-api.ts` › "Bulut yedeği" | Ortak sözleşme: başlıklar, şemalar, saklama kuralı (`planCloudBackupRetention`). |

## 2. Şifreleme: bulut içeriği okuyamaz

- Yerel yedekler zaten AES-256-GCM ile **dükkânın kendi anahtarıyla** şifrelidir
  (`userData/secrets.json` › `BACKUP_ENCRYPTION_KEY`, ilk açılışta üretilir). Buluta aynı şifreli
  dosya, olduğu gibi gider; anahtar hiçbir zaman buluta gönderilmez.
- Bu anahtar sahibine **kurtarma anahtarı** olarak gösterilir: Ayarlar › Yedekler › Kurtarma
  anahtarı (yönetici şifresiyle). Başka bir bilgisayarda geri yüklemek için gerekir. Kaybolursa
  buluttaki yedekler kimse tarafından açılamaz — satıcı da açamaz.
- Bütünlük: tek parça yüklemede dosyanın SHA-256 özetini R2 kendisi doğrular (uyuşmazsa yükleme
  reddedilir). Multipart'ta R2 bütün dosyanın özetini doğrulayamaz; POS yüklemeye başlamadan önce
  dosyayı yerelde kayıtlı özetle karşılaştırır. Geri yüklemede indirilen dosyanın boyutu ve özeti
  buluttaki kayıtla karşılaştırılır, sonra AES-GCM etiketi ve SQLite bütünlük denetimi yapılır.

## 3. Ne zaman, hangi yedek

- Denetim aralığı `CLOUD_BACKUP_INTERVAL_SECONDS` (varsayılan 3600 sn); açılıştan en geç 1 dk
  sonra ilk tur; yeni yedek oluşunca (`backup.created`) birkaç saniye içinde. Her turda **en çok
  bir** yedek yüklenir; aynı anda tek yükleme olur (kilit). Yükleyici `BackgroundWorker`'ı
  **kullanmaz**: oradaki sıra mutfak fişlerini de basar, büyük bir yükleme fişleri bekletmesin.
- Aday yedek: türü `auto`, `manual` ya da `pre_update` (dışarıdan alınan `imported` yüklenmez),
  silinmemiş, yüklenmemiş ve bulutun saklama kuralının tutacağı yedek (bkz. §5; yüklenip hemen
  silinecek eski yedek boşuna gönderilmez). Sıra: önce yarım kalmış multipart, sonra en yeniden
  eskiye. İlk açılışta eski yedekler de en yeniden başlayarak saatte bir yüklenir.
- Bulut bağlantısı yoksa (`CloudService.currentLink`), lisans bulut yedeğini kapattıysa ya da bu
  bilgisayarda kapatıldıysa tur sessizce atlanır.

## 4. Yükleme ve hata

- **Tek parça** (en fazla 95 MB, `CLOUD_BACKUP_SINGLE_MAX_BYTES`): `PUT /api/pos/backups/<yedekId>`;
  başlıklar `x-ado-sha256`, `x-ado-backup-type`, `x-ado-backup-format`, `x-ado-created-at`.
  Zaman aşımı 60 sn + MB başına 1 sn.
- **Multipart** (daha büyük): parça boyu `CLOUD_BACKUP_PART_BYTES` (varsayılan 8 MiB, en az 5 MiB;
  10.000 parçayı aşacaksa büyütülür). Dosyadan her seferinde tek parça okunur. Yüklenen parçalar
  `cloud_backup_uploads.parts_done`'a yazılır; kesilen yükleme kaldığı parçadan sürer.
- **Geri çekilme:** ardışık hatada 1 dk, 5 dk, 15 dk, sonra saatte bir (üst sınır denetim
  aralığıdır). İnternet yokken ekranda hata gösterilmez; diğer hatalar (askıya alma, kota, bakım)
  kartta görünür ve yeniden denenir. Dosyası olmayan ya da bozuk yedek kalıcı `failed` olur ve
  sıradakine geçilir. Bulut "zaten yüklü" derse yedek yüklenmiş sayılır.
- **Kapatma:** Ayarlar › Bulut Yedeği › "Otomatik bulut yedeği" (yalnız bu bilgisayar,
  `cloudBackup.enabled`; değişiklik denetim kaydına yazılır). Satıcı: lisansta
  `"cloud.backup": false` (özellik varsayılan **açıktır**; anahtarı olmayan eski lisanslarda da).
- "Şimdi buluta yedekle" yeni bir yerel yedek alır ve geri çekilmeyi beklemeden yükler.

## 5. Saklama ve kota (bulutta, lisans başına)

- **Saklama:** her yükleme sonunda en yeni **30** yedek + son **12** takvim ayının (UTC, bu ay
  dahil) her birinin en yeni yedeği kalır; gerisi R2'den ve kayıtlardan silinir. Bir haftadan eski
  yarım yükleme kayıtları da temizlenir.
- **Kota:** saklamadan sonra kalacak toplam boyut `licenses.backup_quota_bytes`'ı (boşsa 10 GB)
  aşacaksa yükleme **başlamadan** reddedilir (`413 BACKUP_QUOTA_EXCEEDED`); kart hatayı gösterir,
  POS saatte bir yeniden dener. Kotayı satıcı lisans kaydında artırır.
- Kayıtlar işletmeye değil lisans kimliğine bağlıdır: işletme silinse de saklama ve kota işler.

## 6. Yeni bilgisayarda geri yükleme

1. Programı kurun; ilk kurulum ekranında **"Yedekleriniz buluttaysa: buluttan geri yükleyin"**.
2. Lisans anahtarını girin: buluttaki yedekler listelenir (tarih, boyut, tür; en yenisi üstte).
3. Yedeği seçin, eski bilgisayarın **kurtarma anahtarını** girin, "Yedeği geri yükle".
4. Program yedeği indirir, doğrular ve hazırlar; uygulamayı kapatıp açınca eski veriler (kullanıcılar
   dahil) gelir. Kurtarma anahtarı yeni bilgisayarın anahtarı olarak benimsenir.

Kurallar: yalnız ana bilgisayardan ve henüz kullanıcı yokken (dosyadan geri yüklemeyle aynı).
Lisansın süresi dolmuş olsa da listelenir (veri rehin tutulmaz); iptal edilmiş lisans listelenmez.
İndirme bağlantıları 15 dk geçerlidir ve bulutta yalnız SHA-256 özetleri saklanır. Bulut bağlantısı
bu adımda **kurulmaz**; geri yüklenen veritabanındaki lisansla sonra kendiliğinden kurulur.

## 7. Uçlar

Bulut (`apps/cloud`, `BACKUPS` R2 bağlantısı yoksa hepsi `503 BACKUPS_DISABLED`):

| Uç | Yetki | Açıklama |
|---|---|---|
| `PUT /api/pos/backups/:posBackupId` | POS belirteci | Tek parça; gövde doğrudan R2'ye akar. Aynı yedek tekrar gelirse aynı kayıt döner. |
| `POST /api/pos/backups/:posBackupId/multipart` | POS belirteci | Multipart başlat; aynı lisansın yarım yüklemeleri iptal edilir. |
| `PUT /api/pos/backups/:posBackupId/parts/:n` | POS belirteci | Parça (`x-ado-upload-id`); boy son parça hariç tam `partSize`. |
| `POST /api/pos/backups/:posBackupId/complete` | POS belirteci | Tamamla; saklama kuralı uygulanır. |
| `GET /api/pos/backups` | POS belirteci | Tamamlanmış yedekler (en yeni önce). |
| `GET /api/pos/backups/:id/download` | POS belirteci | İndir. |
| `POST /api/pos/backups/by-license` | Lisans imzası | Yeni bilgisayar: liste + 15 dk indirme adresleri; IP ve lisans başına sınırlı. |
| `GET /api/pos/backups/download/:token` | Kısa ömürlü jeton | İndir. |

POS belirteçli uçların kapısı: işletme askıda değil, lisans iptal edilmemiş ve süresi (ek süre
dahil) dolmamış, `cloud.backup` kapatılmamış. Genel 5 MB gövde sınırı bu yolda uygulanmaz
(R2'nin en küçük parça boyu 5 MiB); bunun yerine `Content-Length` zorunludur (`411`), en fazla 95 MB
(`413`). Isolate'te özet hesaplanmaz (Workers Free CPU sınırı).

POS (`/api/v1`, lisans kilidinden muaf):

| Uç | Yetki | Açıklama |
|---|---|---|
| `GET /cloud-backups/status` | `backup.manage` | `{configured, switchedOn, enabled, linked, lastUploadedAt, lastBackupId, lastSizeBytes, pending, uploading, lastError, lastErrorAt}` |
| `POST /cloud-backups/upload-now` | `backup.manage` | Bekleyen en yeni yedeği hemen yükle. |
| `PUT /cloud-backups/settings` | `backup.manage` | `{enabled}`: bu bilgisayarda aç/kapat. |
| `POST /cloud-backups/setup/list` | Herkese açık, yalnız ana bilgisayar + kullanıcı yokken | `{licenseKey}` → buluttaki yedekler. |
| `POST /cloud-backups/setup/restore` | Aynı | `{licenseKey, cloudBackupId, recoveryKey}` → indir, al, geri yükle. |

Satıcının sağlık panelinde son bulut yedeği: heartbeat `lastCloudBackupAt` (InstallMetrics
sağlayıcısı `cloud-backup`).

## 8. İşletim notları

- R2 depoları: canlı `ado-backups`, deneme `ado-backups-test` (`wrangler.jsonc`; bağlantılar
  ortamlar arasında miras alınmaz, ikisinde de yazılı). Oluşturma:
  `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-backups` (ve `ado-backups-test`).
- Yarım kalan multipart yüklemeleri R2 varsayılan olarak 7 gün sonra kendiliğinden iptal eder;
  **ek yaşam döngüsü kuralı gerekmez.** Bulut ayrıca bir haftadan eski yarım kayıtları siler.
- D1 tabloları `cloud_backups`, `cloud_backup_downloads` (`migrations/0005_cloud_backups.sql`);
  kota sütunu `licenses.backup_quota_bytes` (`0004`).
- Testler: bulut `apps/cloud/test/backups.test.ts` (yerel R2 gerçek 5 MiB sınırını ve SHA-256
  denetimini uygular); POS `cloud-backup.plan.selfcheck.ts`; uçtan uca
  `apps/backend/test/cloud-backup.spawn.e2e.mjs` (backend 3031, sahte bulut 3997 +
  `E2E_PORT_OFFSET`). E2E multipart yolunu küçük veritabanıyla denemek için
  `ADO_CLOUD_BACKUP_SINGLE_MAX_BYTES` kullanır (yalnız geliştirme/test; paketli sürümde yok sayılır).
