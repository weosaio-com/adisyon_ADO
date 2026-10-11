# @ado/cloud — QR menü bulutu (Cloudflare Worker)

Müşteri menüsü (`/m/<masa kodu>`) ve Adisyon programının (POS) menüyü yayınladığı API tek bir
Cloudflare Worker'da çalışır. Veri D1'de, ürün görselleri R2'de tutulur. Müşteri sayfası
`apps/qr-web` derleme çıktısıdır; Worker onu statik varlık olarak sunar. Menüyü yalnız program
yönetir; program buluta imzalı lisansıyla bağlanır, işletme paneli yoktur. Tasarım ve kararlar:
[`QR_MENU_DESIGN.md`](../../QR_MENU_DESIGN.md).

```
/api/*  /img/*   → Worker (src/index.ts): public, pos, admin rotaları
/updates/*       → Worker: program güncellemeleri (R2 UPDATES deposu; UPDATE_SYSTEM.md)
geri kalan       → apps/qr-web/dist (SPA; /m/:code, eski /panel adresi için bilgi sayfası)
```

---

## Yerel geliştirme

Gereken: Node 22, pnpm (kök `package.json`'daki sürüm). Cloudflare hesabı gerekmez; D1 ve R2 yerelde
taklit edilir (`apps/cloud/.wrangler/state`).

```bash
pnpm install
pnpm --filter @ado/shared build

# Satici API anahtari ve lisans acik anahtari; .dev.vars git'e girmez.
cp apps/cloud/.dev.vars.example apps/cloud/.dev.vars

pnpm --filter @ado/cloud db:migrate:local   # yerel D1 tablolari
pnpm --filter @ado/qr-web build             # musteri menusu (statik varliklar)
pnpm --filter @ado/cloud dev                # http://127.0.0.1:8787
```

Müşteri sayfasında çalışırken Vite daha hızlıdır: `pnpm --filter @ado/qr-web dev` →
http://localhost:5174. Vite `/api` ve `/img` isteklerini `wrangler dev`'e (8787) yönlendirir.

### Lisansla bağlanma

İşletme bulutta ayrıca açılmaz: POS lisansıyla ilk bağlandığında (`POST /api/pos/activate`) bulut
imzayı `LICENSE_PUBLIC_KEY` ile doğrular, işletmeyi lisans kimliğiyle açar ve belirteç döner
(ayrıntı: `LICENSING.md`, `QR_MENU_DESIGN.md` §5). Yerelde denemek için bir anahtar çifti üretip açık
anahtarı `.dev.vars`'a yazın; lisansı aynı araçla imzalayın:

```bash
node scripts/license.mjs gen-key --out ~/ado-lisans-yerel
echo "LICENSE_PUBLIC_KEY=<açık anahtar>" >> apps/cloud/.dev.vars
node scripts/license.mjs sign --key ~/ado-lisans-yerel/ado-license-private.pem \
  --customer "Deneme Lokantası" --exp 2027-01-01 --feature qr.menu=true
```

POS'u bu buluta bağlamak için backend'i aynı açık anahtar ve yerel adresle başlatın
(`ADO_LICENSE_PUBLIC_KEY=<açık anahtar>`, `CLOUD_API_URL=http://127.0.0.1:8787`; `http://` yalnız
`localhost`/`127.0.0.1` için kabul edilir, gerçek adres `https://` olmalıdır). İmzalı lisansı POS'ta
**Ayarlar › Lisans**'a girip **Ayarlar › QR Menü** kartında **QR menüyü aç** deyin.

`LICENSE_PUBLIC_KEY` boşsa etkinleştirme `503 ACTIVATION_DISABLED` döner.

### Testler

```bash
pnpm --filter @ado/cloud test        # vitest, gercek workerd (yerel D1/R2, her dosya ayri)
pnpm --filter @ado/cloud typecheck
```

Uçtan uca (POS + bulut birlikte; CI'daki `e2e-cloud` işi): `wrangler dev` `:8787`'de ve POS arka ucu
`:3001`'de (seed'li; yukarıdaki açık anahtar ve `CLOUD_API_URL` ile) çalışırken:

```bash
E2E_CLOUD_URL=http://127.0.0.1:8787 \
ADO_LICENSE_PRIVATE_KEY_FILE=~/ado-lisans-yerel/ado-license-private.pem \
pnpm --filter @ado/frontend run test:e2e:cloud
```

---

## Test ortamı (yayından önce deneme)

Gerçek işletmelere açmadan önce telefonla denemek için ayrı bir Worker: `ado-qr-test`. Kendi
veritabanı (`ado-qr-test`) ve görsel deposu (`ado-qr-images-test`) vardır; canlı veriye dokunmaz.
Adresi `https://ado-qr-test.<hesap>.workers.dev` olur, alan adı gerekmez. Yapılandırma
`wrangler.jsonc` › `env.test`.

Bir kez yapılır (hesap ve oturum için aşağıdaki **Yayına alma**'nın 1–2. adımları):

1. `pnpm --filter @ado/cloud exec wrangler d1 create ado-qr-test` — çıktıdaki `database_id`'yi
   `wrangler.jsonc` › `env.test` içindeki `00000000-…` yerine yazıp commit'leyin.
2. `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-qr-images-test` ve
   `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-updates-test` (program güncellemeleri)
3. Deneme lisans anahtarının açık anahtarını `wrangler.jsonc` › `env.test` › `vars.LICENSE_PUBLIC_KEY`
   ve programın `apps/desktop/profiles/test.json` dosyasına aynı değerle yazın (`LICENSING.md` §5).
4. `pnpm --filter @ado/cloud db:migrate:test`
5. `pnpm --filter @ado/cloud exec wrangler secret put ADMIN_TOKEN --env test` — canlı ortamdakinden
   farklı bir değer.
6. `pnpm --filter @ado/cloud run deploy:test` — çıktıdaki `https://ado-qr-test.….workers.dev`
   adresini not edin.

Sonraki denemeler yalnız 6. adımdır; yeni bir migration varsa önce 4. adım.

### Panelden geçiş (bir kez)

`0003_remove_panel.sql` panel kullanıcılarını, oturumları ve eşleştirme kodlarını siler, lisanssız
işletmeleri (şubeleri, menüleri ve masalarıyla) kaldırır. Uygulamadan önce geri dönüş noktası alın:

```bash
pnpm --filter @ado/cloud exec wrangler d1 time-travel info ado-qr-test --env test   # yer imini not edin
pnpm --filter @ado/cloud db:migrate:test
pnpm --filter @ado/cloud run deploy:test
```

Sonra programda lisansı girip **QR menüyü aç** deyin; masa kodları programda olduğu için basılı QR
kartları yeniden çalışır. Geri dönmek gerekirse:
`wrangler d1 time-travel restore ado-qr-test --env test --bookmark=<yer imi>`.

### Telefonla deneme

1. Test profiliyle derlenmiş programı kurun (`pnpm --filter @ado/desktop dist:test`; bulut adresi test
   ortamı). Deneme lisansını **Ayarlar › Lisans**'a girip **Ayarlar › QR Menü › QR menüyü aç** deyin.
2. **Masa QR kodları**'ndan bir kartı basıp telefonla okutun: menü açılır, işletme adı ve masa
   doğrudur.
3. Programda bir ürünü **Tükendi** yapın; telefonda sayfayı yenileyin: rozet birkaç saniyede görünür.
4. Eski panel uygulaması telefonda yüklüyse internetteyken açın: "İşletme paneli kaldırıldı" yazar ve
   uygulama kendini temizler (simgeyi ana ekrandan silebilirsiniz).

---

## Yayına alma (Cloudflare)

Bir kez yapılır. Komutlar depo kökünden çalıştırılır.

1. **Hesap ve plan.** Cloudflare hesabı açın. Parola özetleme kalktığı için ücretsiz planın istek başına
   10 ms CPU sınırı yetebilir; yayına almadan önce test ortamında ölçün, yetmezse **Workers Paid**
   ($5/ay).
2. **Oturum.** Kendi bilgisayarınızda `pnpm --filter @ado/cloud exec wrangler login` (tarayıcı açılır).
   Otomasyon için bunun yerine `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 ve R2 düzenleme yetkili)
   ve `CLOUDFLARE_ACCOUNT_ID` ortam değişkenlerini tanımlayın.
3. **Veritabanı.** `pnpm --filter @ado/cloud exec wrangler d1 create ado-qr`; çıktıdaki
   `database_id` değerini `apps/cloud/wrangler.jsonc` içindeki `00000000-…` yerine yazıp commit'leyin
   (gizli değildir).
4. **Depolar.** `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-qr-images` ve
   `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-updates` (program güncellemeleri;
   yüklemeyi release iş akışı yapar, `UPDATE_SYSTEM.md` §4)
5. **Lisans açık anahtarı.** Gerçek lisans anahtarının açık anahtarını `wrangler.jsonc` ›
   `vars.LICENSE_PUBLIC_KEY` ve `apps/desktop/profiles/prod.json` dosyasına yazıp commit'leyin (gizli
   değildir; özel anahtar asla depoya girmez).
6. **Tablolar.** `pnpm --filter @ado/cloud db:migrate:remote`
7. **Satıcı anahtarı.** `pnpm --filter @ado/cloud exec wrangler secret put ADMIN_TOKEN` — uzun, rastgele
   bir değer girin (ör. `openssl rand -base64 32`) ve parola yöneticinizde saklayın. Depoya asla
   yazmayın.
8. **Yükleme.** `pnpm --filter @ado/cloud run deploy` — önce `@ado/shared` ve `@ado/qr-web`'i derler,
   sonra Worker'ı ve sayfaları yükler. (`run` şart: `pnpm deploy` pnpm'in kendi komutudur.)
9. **Alan adı.** Cloudflare panelinde Workers › `ado-qr` › Settings › Domains & Routes › **Add ›
   Custom domain** (ör. `menu.ornek.com`; alan adının DNS'i Cloudflare'da olmalı). Ya da
   `wrangler.jsonc`'a `"routes": [{ "pattern": "menu.ornek.com", "custom_domain": true }]` ekleyip
   yeniden yükleyin. Sertifika otomatik gelir.
10. **Kontrol.** `https://menu.ornek.com/api/health` → `{"success":true,"data":{"ok":true}}`. Üretim
    profiliyle derlenmiş programda lisansı girip **QR menüyü aç** deyin.

Sonraki sürümler yalnız 8. adımdır; yeni bir migration varsa önce 6. adım.

### Yayından sonra telefonla kontrol

1. POS'ta QR menüyü açıp (kılavuz 5.5) bir masanın QR kartını basın. iPhone (Kamera) ve Android (Kamera ya
   da Google Lens) ile masadan ~50 cm uzaklıktan okutun: menü mobil veride birkaç saniyede açılır,
   işletme adı ve masa doğrudur.
2. Fotoğraflar yüklenir, yazılar okunur, sayfa yana kaymaz; sayfa yakınlaştırılabilir.
3. İngilizce adı olan ürün varsa TR/EN geçişi çalışır; telefon dili İngilizceyse menü EN açılır.
4. POS'ta bir ürünü **Tükendi** yapın; telefonda sayfayı yenileyin: rozet ~10 saniye içinde görünür.
5. POS'ta masanın kodunu yenileyin: eski kart "Bu QR kod geçersiz" gösterir, yeni kart çalışır.
6. POS bilgisayarının internetini kesin: satış sürer, kartta yayın hatası görünür; internet gelince
   menü kendiliğinden güncellenir (beklemek istemezseniz **Şimdi yayınla**).

### İşletme yönetimi (satıcı API'si)

Tüm istekler `Authorization: Bearer <ADMIN_TOKEN>` ister. İşletmeler POS'un lisansla ilk
bağlanmasında kendiliğinden açılır.

| İş | İstek |
|---|---|
| Paketleri listele | `GET /api/admin/plans` |
| İşletmeleri listele / ayrıntı (şube, son görülme, POS sürümü) | `GET /api/admin/tenants` · `GET /api/admin/tenants/:id` |
| Özellik aç/kapat, askıya al | `PATCH /api/admin/tenants/:id` `{ features?, status?, plan?, name? }` |
| POS bağlantısını kaldır (çalınan lisans, bilgisayar değişimi) | `POST /api/admin/tenants/:id/revoke` |
| İşletmeyi sil (şube, menü, masalarla) | `DELETE /api/admin/tenants/:id` |

Paketler: `menu` (QR Menü), `order`, `pay`, `full`. QR-1'de yalnız `qr.menu` özelliği kullanılır.
Ad, paket ve özellikler imzalı lisanstan gelir ve her etkinleştirme ile lisans yenilemesinde yeniden
yazılır (satıcının `PATCH` ile yaptığı değişiklik yenilemeye kadar geçerlidir). Askıya alma satıcı
kararıdır, yenilemede korunur.

### İşletim notları

- **Yedek:** D1 Time Travel ile veritabanı son 30 güne kadar herhangi bir ana döndürülebilir
  (`wrangler d1 time-travel`). Görseller içerik adreslidir, üzerine yazılmaz.
- **Günlükler:** `observability` açık; Cloudflare panelinde Workers › `ado-qr` › Logs.
- **Anahtar değişimi:** `wrangler secret put ADMIN_TOKEN` ile yenisi girilir, eskisi hemen geçersiz olur.
  Lisans anahtarı değişiminde `LICENSE_PUBLIC_KEY` virgülle birden çok anahtar alır (geçiş süresince
  eski ve yeni birlikte).
- **Güvenlik başlıkları:** statik sayfalar için `apps/qr-web/public/_headers` (CSP, `nosniff`,
  `frame-ancestors 'none'`).
