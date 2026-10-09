# LICENSING.md — Lisans

> Lisans, Weosa'nın imzaladığı tek satırlık bir metindir: işletme adı, bitiş tarihi ve açık özellikler
> (ör. QR menü). Program imzayı internetsiz doğrular; imza anahtarı yalnız satıcıdadır, sahte lisans
> üretilemez. Lisans girmek programı **kilitlemez**: zorunluluk ayrı bir ayardır ve kapalıdır.

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
- `GET /api/v1/license`: durum, bitiş, lisans kimliği, özellikler, `needsReentry`.
- Kayıtlı anahtar **her okumada** yeniden doğrulanır; tarihler ve bayraklar imzalı payload'dan gelir.
- Zorunluluk (`license.enforce`) kapalıdır; açılsa bile okuma, giriş, lisans ve yedek uçları hep açıktır.

## 5. Derleme profilleri (`apps/desktop/profiles`)

| Profil | Bulut adresi | Lisans açık anahtarı |
|---|---|---|
| `test` | `https://ado-qr-test.weosaio.workers.dev` | deneme anahtarı (boşsa lisans girilemez) |
| `prod` | henüz yok | henüz yok — dolmadan derlenemez |

`node build-bundle.mjs --profile test|prod` profili doğrular ve `resources/app-config.json`'a yazar;
`main.mjs` bunu okuyup backend'e `CLOUD_API_URL`, `ADO_LICENSE_PUBLIC_KEY`, `ADO_BUILD_PROFILE`
olarak verir (devralınan değerleri ezer). Dosya okunamazsa program açılır, yalnız bulut ve lisans
özellikleri kapalı kalır.

## 6. Kurulum kimliği

Her kurulumun kalıcı kimliği veri dizinindeki `ado-install.json` dosyasındadır
(`apps/backend/src/common/util/install-id.ts`). Bilerek veritabanının dışındadır: yedek başka bir
bilgisayara geri yüklendiğinde kimlik onunla gitmez, iki bilgisayar aynı kurulum gibi görünmez.

## 7. Sıradaki adım

QR menü bulutu lisansla bağlanacak: program "QR menüyü aç" dediğinde lisansı buluta gönderir, bulut
imzayı aynı açık anahtarla doğrulayıp işletmeyi lisans kimliğiyle tanır. Eşleştirme kodu ve web paneli
kalkar.
