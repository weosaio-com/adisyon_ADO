# UPDATE_SYSTEM.md — Otomatik Güncelleme

> Adisyon programı (Windows masaüstü) yeni sürümü kendisi denetler ve indirir; kurulum yalnız
> yöneticinin onayıyla, kasa bilgisayarından ve açık adisyon/kasa yokken yapılır. Güncelleme
> paketleri imzalıdır; imzası tutmayan ya da özeti eşleşmeyen dosya kurulmaz.
>
> Kurallar: `CONVENTIONS.md` F1 (oto-kontrol + onaylı kurulum; açık adisyon/mesaide zorlanmaz),
> F2 (`stable` varsayılan, `beta` gizli/geliştirici), L143 (imza doğrulaması zorunlu).

---

## 1. Parçalar

| Yer | Görev |
|---|---|
| `apps/desktop/updater.mjs` | Denetim (açılıştan 2 dk sonra, sonra 6 saatte bir), imzalı bildirimi doğrulama, indirme (electron-updater 6.8.9), özet denetimi, kurulum. |
| `apps/desktop/update-manifest.mjs` | Bildirim biçimi ve doğrulama (Electron'suz, self-check'li). |
| `apps/backend/src/updates/*` | Durum (`GET /updates/status`), şimdi denetle (`POST /updates/check`), kurulum onayı (`POST /updates/approve`). |
| `apps/backend/src/desktop/desktop-bridge.service.ts` | Kabuk ile IPC: kabuk durum bildirir, backend "denetle"/"kur" komutu yollar. |
| `apps/frontend/src/screens/UpdateCard.tsx` | Ayarlar › Güncelleme kartı (yalnız masaüstünde ve `update.manage` yetkisiyle). |
| `apps/cloud/src/routes/updates.ts` | Dosyaları R2 `UPDATES` deposundan sunar: `/updates/<kanal>/<dosya>`. |
| `scripts/update-manifest.mjs` | Satıcı/CI aracı: güncelleme anahtarı üretir, bildirimi imzalar, doğrular. |

## 2. İmzalı bildirim (`ado-update.json`)

Kurulum dosyasının yanında durur. Lisans anahtarından **ayrı** bir Ed25519 anahtarıyla imzalanır:

```json
{ "format": "ADOU1", "payload": "<base64url JSON>", "signature": "<base64url Ed25519>" }
```

İmza `payload`'ın ham baytları üzerindedir. İçerik: `version` (X.Y.Z), `channel` (`stable`|`beta`),
`file` (kurulum dosyasının adı, `.exe`), `sha512` (base64, electron-builder'ın `latest.yml` biçimi),
`size`, `releaseDate`, `notes` (isteğe bağlı, en fazla 2000 karakter).

Açık anahtar(lar) derleme profilindedir (`apps/desktop/profiles/*.json` › `updatePublicKey`; virgülle
birden çok anahtar: anahtar değişiminde eski ve yeni birlikte). Profilde anahtar yoksa program
güncelleme denetlemez ve kart görünmez. Özel anahtar asla depoya girmez; release iş akışı GitHub
Environment secret'ından geçici dosyaya yazar.

## 3. Akış

1. **Denetim:** `<bulut>/updates/<kanal>/ado-update.json` indirilir, imza doğrulanır. Kanal
   profildekiyle aynı ve sürüm mevcut sürümden büyük olmalı; değilse "güncel".
2. **Çapraz kontrol:** electron-updater aynı klasördeki `latest.yml`'i okur; sürüm ve dosya özeti
   imzalı bildirimle aynı olmalı.
3. **İndirme:** tam dosya (parça parça indirme kapalı). electron-updater özeti `latest.yml`'e göre
   denetler; program indirilen dosyanın SHA-512'sini ayrıca hesaplar, imzalı özetle eşleşmezse
   dosya kullanılmaz. Durum "hazır" olur.
4. **Onay (backend):** `update.manage` yetkisi, istek kasa bilgisayarından (`127.0.0.1`), açık ya da
   bekleyen adisyon yok, kasa kapalı. Sonra sırasıyla:
   - şifreli yedek (`pre_update`);
   - `UpdateHistory` kaydı (`ready`) ve denetim kaydı (`update.approve`);
   - kabuğa `update-install` komutu.
5. **Kurulum (kabuk):** dosyanın özeti bir kez daha denetlenir. Pencerede "Program güncelleniyor"
   sayfası açılır, backend düzgün kapatılır (`shutdown`, en fazla 10 sn). Ardından sessiz NSIS
   kurulumu başlar ve program yeniden açılır (`quitAndInstall(true, true)`).
6. **Yeni sürümün açılışı:** migration'lardan önce `userData/pre-migrate`'e veritabanı kopyası alınır
   (son 3). Backend açılınca `UpdateHistory` kaydı sürüm yeni sürümse `applied`, değilse `failed`
   olur.

`autoInstallOnAppQuit` kapalıdır: program kapanırken habersiz kurulum yapılmaz.

## 4. Sunucu düzeni (R2 `UPDATES` deposu)

```
stable/ado-update.json         ← imzalı bildirim (no-cache)
stable/latest.yml              ← electron-builder çıktısı (no-cache)
stable/Adisyon-POS-Setup-0.3.1.exe  ← sürüme özel ad (süresiz önbellek)
beta/...                       ← gizli kanal; profilde channel: "beta"
```

Yükleme sırası önemlidir: önce kurulum dosyası, sonra `latest.yml`, **en son** `ado-update.json`.
Böylece bildirim, dosyası hazır olmayan bir sürümü göstermez. Worker tek aralıklı (Range) isteği
destekler. Depolar: `ado-updates` (canlı), `ado-updates-test` (deneme); `apps/cloud/wrangler.jsonc`.

## 5. Anahtar üretme ve imzalama

```bash
node scripts/update-manifest.mjs gen-key --out ~/ado-guncelleme-anahtari   # repo DIŞINDA
node scripts/update-manifest.mjs sign --key ~/ado-guncelleme-anahtari/ado-update-private.pem \
  --installer apps/desktop/dist/Adisyon-POS-Setup-0.3.1.exe --version 0.3.1 --channel stable \
  --notes "Düzeltmeler" --out ado-update.json
node scripts/update-manifest.mjs verify --pub <açık anahtar> --manifest ado-update.json \
  --installer apps/desktop/dist/Adisyon-POS-Setup-0.3.1.exe
```

## 6. Sınırlar ve sonraya kalanlar

- **Kod imzalama sertifikası yok:** Windows SmartScreen ilk kurulumda uyarır. Güncelleme güvenliği
  Ed25519 imzası ve SHA-512 özetine dayanır (electron-updater'ın Authenticode denetimi sertifika
  olmadan yapılamaz).
- **Geri alma:** otomatik geri alma yok. Kurulum öncesi şifreli yedek ve `pre-migrate` kopyası
  vardır; önceki sürüm elle yeniden kurulup yedek geri yüklenebilir.
- **Beta kanalı:** derleme profilinde `channel: "beta"` ile ayrı bir derleme gerekir; kullanıcı arayüzünde
  kanal seçimi yok.
- Release iş akışı (Windows derleme → imzala → R2'ye yükle → GitHub release): `.github/workflows`
  (0.3.0 adımı).
