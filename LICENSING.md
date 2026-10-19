# LICENSING.md — Lisans

> Lisans, Weosa'nın imzaladığı tek satırlık bir metindir: işletme adı, bitiş tarihi ve açık özellikler
> (ör. QR menü). Program imzayı internetsiz doğrular; imza anahtarı yalnız satıcıdadır, sahte lisans
> üretilemez. Paketli sürümde lisans **zorunludur** (derleme profili): lisans yoksa ya da süresi
> (ek süre dahil) dolduysa yalnız **yeni adisyon** açılamaz; açık adisyonlar kapatılır, raporlar,
> yedekler ve ayarlar her zaman açıktır (§8). Geliştirmede ve CI'da zorunluluk kapalıdır.

---

## 1. Biçim

```
ADO1.<base64url(payload JSON)>.<base64url(Ed25519 imza)>
```

İmza payload'ın **ham baytları** üzerindedir. Biçim ve şema tek yerde: `packages/shared/src/license.ts`
(`@ado/shared/license`); program (Node) ve bulut (Cloudflare Worker) aynı şemayı kullanır.

| Alan | Zorunlu | Anlam |
|---|---|---|
| `id` | yeni lisanslarda | Lisans kimliği (`^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`). Yenilemede aynı kalır; bulut işletmeyi bununla tanır. |
| `c` | evet | Müşteri/işletme adı (1-120). |
| `p` | hayır | Plan adı (ör. `yearly`). |
| `exp` | evet | `YYYY-MM-DD`; o günün başında biter. |
| `g` | hayır | Bitişten sonraki ek süre (gün, 0-366). |
| `f` | hayır | Özellik bayrakları, ör. `{ "qr.menu": true }`. |

`id`'siz eski lisanslar geçerliliğini korur.

## 2. Anahtarlar

- **Özel anahtar** (PKCS8 PEM) yalnız satıcıdadır; **repoya, profillere, sunucuya girmez**. Parola
  yöneticisinde saklanır.
- **Açık anahtar** (base64 SPKI DER, 44 bayt) derleme profiline yazılır ve programa
  `ADO_LICENSE_PUBLIC_KEY` olarak verilir. Virgülle birden çok anahtar verilebilir (anahtar değişimi:
  listede tutan ilk anahtar kazanır).
- **Deneme ve üretim ayrıdır.** Şu an yalnız deneme anahtarı vardır ("lisans varmış gibi"). Üretim
  anahtarı gelince yalnız `apps/desktop/profiles/prod.json` değişir; kod değişmez.
- Açık anahtar değişirse eski anahtarla imzalı kayıtlı lisans geçersiz sayılır; Ayarlar › Lisans
  "yeniden girin" der. Özellik bayrakları yalnız doğrulanan anahtardan okunur.

## 3. Satıcı aracı (`scripts/license.mjs`)

Bağımlılıksızdır (yalnız `node:*`).

```bash
# Anahtar çifti (klasör repo DIŞINDA olmalı; araç repo içine yazmayı reddeder)
node scripts/license.mjs gen-key --out ~/ado-lisans

# Lisans imzala (id verilmezse üretilir)
node scripts/license.mjs sign --key ~/ado-lisans/ado-license-private.pem \
  --customer "Deneme Lokantası" --exp 2027-01-01 --grace 14 --feature qr.menu=true

# Doğrula
node scripts/license.mjs verify --pub <açık anahtar> --license ADO1....

# Özel anahtardan açık anahtarı yeniden çıkar
node scripts/license.mjs public-key --key ~/ado-lisans/ado-license-private.pem
```

## 4. Programda

- **Ayarlar › Lisans**: anahtar yapıştırılır → `POST /api/v1/license/activate` imzayı ve süreyi doğrular,
  `LicenseInfo`'ya yazar, `license.activated` olayını yayınlar (anahtar olaya girmez).
- `GET /api/v1/license`: durum, bitiş, lisans kimliği, özellikler, `needsReentry` ve politika
  alanları (§8).
- Kayıtlı anahtar **her okumada** yeniden doğrulanır; tarihler ve bayraklar imzalı payload'dan gelir.
- Etkinleştirme ve buluttan yenileme denetim kaydına yazılır (`license.activate`,
  `license.renewed_remote`; anahtarın kendisi yazılmaz).
- Zorunluluk: `ADO_LICENSE_ENFORCE` (paketli sürümde profilden), boşsa `license.enforce` ayarı.
  Kilit yalnız yeni adisyondadır (§8).

## 5. Derleme profilleri (`apps/desktop/profiles`)

| Profil | Bulut adresi | Lisans açık anahtarı | Güncelleme |
|---|---|---|---|
| `test` | `https://ado-qr-test.weosaio.workers.dev` | deneme anahtarı (2026-10-11; test bulutunda da `env.test` › `LICENSE_PUBLIC_KEY`) | `channel`, `updatePublicKey`: deneme güncelleme anahtarı (2026-10-19; satıcının tarayıcısında üretildi, özel yarısı sohbete ve depoya girmedi) |
| `prod` | henüz yok | henüz yok — dolmadan derlenemez | güncelleme anahtarı dolmadan derlenemez |

Güncelleme anahtarı lisans anahtarından ayrıdır; ayrıntı `UPDATE_SYSTEM.md`. Deneme anahtarlarının
özel yarıları depoda değil, satıcının parola yöneticisindedir; güncelleme özel anahtarı ayrıca
GitHub `release-test` ortamının secret'ıdır.

Profil lisans politikasını da taşır (hepsi isteğe bağlı): `licenseEnforce` (varsayılan `true`),
`trialDays` (0-90, varsayılan 0), `graceDays` (0-90, varsayılan 7), `supportContact` (en çok 200
karakter; kilit penceresinde gösterilir). `test` profili: zorunlu, deneme 0, ek süre 7 gün.

`node build-bundle.mjs --profile test|prod` profili doğrular ve `resources/app-config.json`'a yazar;
`main.mjs` bunu okuyup backend'e `CLOUD_API_URL`, `ADO_LICENSE_PUBLIC_KEY`, `ADO_BUILD_PROFILE`,
`ADO_LICENSE_ENFORCE` (`1`; yalnız `licenseEnforce: false` ise `0`), `ADO_TRIAL_DAYS`,
`ADO_GRACE_DAYS`, `ADO_SUPPORT_CONTACT` olarak verir (devralınan değerleri ezer). Dosya okunamazsa
program açılır, yalnız bulut ve lisans özellikleri kapalı kalır (açık anahtar yokken zorunluluk
uygulanmaz).

## 6. Kurulum kimliği

Her kurulumun kalıcı kimliği veri dizinindeki `ado-install.json` dosyasındadır
(`apps/backend/src/common/util/install-id.ts`). Bilerek veritabanının dışındadır: yedek başka bir
bilgisayara geri yüklendiğinde kimlik onunla gitmez, iki bilgisayar aynı kurulum gibi görünmez.
Dosya ilk açılışta yazılır; içindeki `createdAt` deneme süresinin başlangıçlarından biridir (§8).

## 7. Buluta lisansla bağlanma

Lisans numarası (`id`) olan her kurulum açılışta ve lisans girilince buluta **kendiliğinden**
bağlanır; QR menü gerekmez. Program lisansı, kurulum kimliğini ve şube bilgisini gönderir
(`POST /api/pos/activate`). Bulut imzayı aynı açık anahtarla (`LICENSE_PUBLIC_KEY`) doğrular; süresi
dolmuş ama imzası geçerli lisans da "yalnız bağlantı" olarak bağlanır (yenileme böyle ulaşır).
İşletme lisans kimliğiyle ilk bağlantıda oluşur ve lisans **kaydına** (`licenses`) yazılır.

- Bir lisans aynı anda tek kurulumda bağlıdır; başka bilgisayara taşımak sahibin onayını ister
  ("Bu bilgisayara al"), kendiliğinden devralma yoktur.
- Program saatte bir heartbeat gönderir. Bulut lisansın durumunu (etkin, askıda, iptal, süresi
  dolmuş) bildirir; kayıtta aynı numaralı ve daha geç bitişli imzalı lisans varsa onu da gönderir.
  Program imzayı gömülü açık anahtarlarla doğrulayıp yeni lisansı kendisi kurar.
- Satıcı lisansı `scripts/license.mjs register` ya da satıcı API'siyle (`PUT /api/admin/licenses`)
  kayda ekler; iptal edilen lisans (`POST /api/admin/licenses/:id/revoke`) işletme silinse bile
  yeniden bağlanamaz. QR menü, bağlantı üzerinde ayrı bir anahtardır ve lisansta `qr.menu` ister.
- Aynı bitiş tarihli bir lisans (yalnız özellik eklenmiş) kendiliğinden gönderilmez; bitişi bir gün
  ileri alın ya da anahtarı elle girin.

Ayrıntı: `QR_MENU_DESIGN.md` §3.1, `API_DESIGN.md` §5.12. Eşleştirme kodu ve web işletme paneli
kaldırıldı; bağlanmanın tek yolu lisanstır.

## 8. Politika: zorunluluk, deneme, ek süre, kilit

Karar saf bir fonksiyondur (`apps/backend/src/license/license.policy.ts`); girdileri
`LicenseService` okur (lisans, ayarlar, saat, bulut bildirimi).

**Zorunluluk.** `ADO_LICENSE_ENFORCE` (`1` / `0`) önceliklidir; boşsa `license.enforce` ayarına
bakılır. Paketli sürümde profilden gelir (varsayılan açık); geliştirmede ve CI'da tanımsızdır, yani
kapalıdır. Açık anahtar yoksa zorunluluk hiç uygulanmaz (kimse kilitlenmez). Kapalıyken hiçbir şey
durmaz; şerit yalnız lisansla ilgili bilgi verir.

**Evreler** (`GET /api/v1/license` → `phase`):

| Evre | Ne zaman | Yeni adisyon |
|---|---|---|
| `trial` | Lisans yok, deneme süresi içinde (`ADO_TRIAL_DAYS`, varsayılan 0) | açılır; şerit kalan günü söyler |
| `unlicensed` | Lisans yok, deneme bitti (0 günse ilk açılıştan itibaren) | **açılmaz** |
| `active` | Bitişe 14 günden fazla var | açılır |
| `expiring` | Bitişe 14 gün ya da daha az kaldı | açılır; uyarı şeridi |
| `grace` | Bitiş geçti ve ek süre sürüyor (lisanstaki `g`, yoksa `ADO_GRACE_DAYS`, varsayılan 7) ya da bulut askıya aldı / iptal etti ve ek süre sürüyor | açılır; şerit kilit tarihini söyler |
| `locked` | Ek süre bitti | **açılmaz** |

**Kilit yalnız yeni adisyondadır.** `OrdersService.openOrder` → `LicenseService.assertCanOpenOrder`
→ `403 LICENSE_LOCKED` (Türkçe mesaj, varsa destek iletişimiyle). Bu yol `POST /orders`'ı, senkron
`OPEN_TABLE`'ı ve inceleme kuyruğundaki "yeni adisyon" çözümünü kapsar. Senkronda mutasyon deftere
`rejected` / `LICENSE_LOCKED` olarak yazılır: toplu istek 403 almaz, tabletin kuyruğu takılmaz.
Adisyon bölme, bekleyen adisyonu yeniden açma, kalem ekleme, ödeme ve kapatma serbesttir; raporlar,
yedekler (yerel ve bulut), ayarlar, menü, masalar, kullanıcılar, yazıcılar, lisans girişi ve
güncelleme her zaman çalışır. Yeni lisans girilince kilit hemen kalkar.

**Çevrimdışı işlem.** Tabletin kilitten **önce** açtığı masa (clientOpId ULID zamanı < kilit anı)
geç senkronlansa da kabul edilir. İstemci saati güvenilmez olduğundan yalnız en çok 24 saat eski
işlem için; sahte eski zaman böylece en fazla bir gün işe yarar.

**Deneme başlangıcı.** `ado-install.json`'daki `createdAt` ile `license.trialStartedAt` ayarının
(ilk açılışta yazılır) **erkeni**. Biri silinse de deneme sıfırlanmaz.

**Saat geri alma.** Etkin saat = en geç olanı: sistem saati, kalıcı işaret (`license.clock`) ve süreç
içinde monoton saatle ilerletilen son değer. İşaret en çok 10 dakikada bir ve bulut saatiyle
(`license.remote` → `serverTime`) ilerler. Saat geri alınınca lisans açılmaz, süre de durmaz. Yerel
işaret bulut saatinin bir günden fazla ilerisindeyse (bilgisayarın saati bir ara ileri alınmış) bulut
saatine indirilir: güvenilir kaynak buluttur.

**Bulut bildirimi (`license.remote`).** Bulut bağlantısı her heartbeat'ten sonra yayınlar (kalıcı
değil); son durum `license.remote` ayarında durur.
- `suspended` / `revoked`: o lisans için **ilk** bildirimden itibaren `ADO_GRACE_DAYS` ek süre, sonra
  kilit. Saatlik tekrarlar süreyi uzatmaz; askıdan iptale geçiş yeni süre vermez.
- Bulut aynı lisans için yeniden `active` derse kısıt kalkar. Başka kimlikli lisansa uygulanmaz.
- `expired` bilgi amaçlıdır; yerel bitiş (etkin saatle) esastır.
- `update`: aynı kimlikli, daha geç bitişli imzalı anahtar. Gömülü açık anahtarlarla doğrulanır;
  kurulu lisansla aynı kimlik ve daha geç etkin bitiş (ek süre dahil) şartıyla etkinleştirme yolundan
  kurulur. Denetim kaydı `license.renewed_remote`; `license.activated` her zamanki gibi yayınlanır.

**Arayüz.** Tüm ekranların üstünde lisans şeridi: deneme, bitişe az kaldı, ek süre ve kilit tarihi,
kilit, askıya alma / iptal. Zorunluluk kapalı ve söylenecek bir şey yoksa görünmez; lisanssız yeni
kurulumda lisans girme çağrısı da budur. Bir istek `403 LICENSE_LOCKED` alırsa (ya da şerit düğmesine
basılırsa) lisans penceresi açılır: anahtar girişi (`license.manage` yetkisi), destek iletişimi
(`ADO_SUPPORT_CONTACT`). Ayarlar › Lisans kartı aynı metinleri kullanır.

**`GET /api/v1/license` ek alanları:** `phase`, `locked`, `lockAt`, `trialEndsAt`, `remoteState`,
`reason` (`no_license` | `expired` | `suspended` | `revoked`), `graceDays`, `banner`
(`level`, `daysLeft`, `until`), `supportContact`. `state`, `graceUntil` ve `daysLeft` etkin saatle ve
etkin ek süreyle hesaplanır.

Eski, GET dışındaki tüm yazmaları durduran `LicenseGuard` emekliye ayrıldı (her isteği geçirir);
hep açık uçların listesi belge olarak `license.paths.ts`'de durur.
