# @ado/cloud — QR menü bulutu (Cloudflare Worker)

Müşteri menüsü (`/m/<masa kodu>`), işletme paneli (`/panel`) ve bunların API'si tek bir Cloudflare
Worker'da çalışır. Veri D1'de, ürün görselleri R2'de tutulur. Sayfalar `apps/qr-web` derleme
çıktısıdır; Worker onları statik varlık olarak sunar. Tasarım ve kararlar:
[`QR_MENU_DESIGN.md`](../../QR_MENU_DESIGN.md).

```
/api/*  /img/*   → Worker (src/index.ts): public, pos, panel, admin rotaları
geri kalan       → apps/qr-web/dist (SPA; /m/:code ve /panel)
```

---

## Yerel geliştirme

Gereken: Node 22, pnpm (kök `package.json`'daki sürüm). Cloudflare hesabı gerekmez; D1 ve R2 yerelde
taklit edilir (`apps/cloud/.wrangler/state`).

```bash
pnpm install
pnpm --filter @ado/shared build

# Satici API anahtari (en az 16 karakter); .dev.vars git'e girmez.
cp apps/cloud/.dev.vars.example apps/cloud/.dev.vars

pnpm --filter @ado/cloud db:migrate:local   # yerel D1 tablolari
pnpm --filter @ado/qr-web build             # musteri menusu + panel (statik varliklar)
pnpm --filter @ado/cloud dev                # http://127.0.0.1:8787
```

Sayfalarda çalışırken Vite daha hızlıdır: `pnpm --filter @ado/qr-web dev` → http://localhost:5174.
Vite `/api` ve `/img` isteklerini `wrangler dev`'e (8787) yönlendirir; çerezler aynı kökende çalışır.

### Deneme işletmesi açmak

Kendi kendine kayıt henüz yok; işletmeyi satıcı API'si açar:

```bash
curl -s http://127.0.0.1:8787/api/admin/tenants \
  -H "Authorization: Bearer $(grep '^ADMIN_TOKEN=' apps/cloud/.dev.vars | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Deneme Lokantası","plan":"menu","owner":{"email":"sahip@ornek.com","password":"en-az-10-karakter"}}'
```

Sonra http://127.0.0.1:8787/panel adresinden bu e-posta ve parolayla girin.

- **POS'suz işletme:** Menü, İşletme ve Masalar sekmelerini doldurup **Kaydet ve yayınla**; Masalar'daki
  **Önizle** müşteri sayfasını açar.
- **POS'lu işletme:** panelde **Adisyon programı › Eşleştirme kodu al**; POS'ta **Ayarlar › QR Menü
  (Bulut)** kartına `http://127.0.0.1:8787` ve kodu girin. `http://` yalnız `localhost`/`127.0.0.1`
  için kabul edilir; gerçek adres `https://` olmalıdır.

### Testler

```bash
pnpm --filter @ado/cloud test        # vitest, gercek workerd (yerel D1/R2, her dosya ayri)
pnpm --filter @ado/cloud typecheck
```

Uçtan uca (POS + bulut birlikte; CI'daki `e2e-cloud` işi): POS arka ucu `:3001`'de (seed'li) ve
`wrangler dev` `:8787`'de çalışırken:

```bash
E2E_CLOUD_URL=http://127.0.0.1:8787 \
E2E_CLOUD_ADMIN_TOKEN=<.dev.vars'taki ADMIN_TOKEN> \
pnpm --filter @ado/frontend run test:e2e:cloud
```

---

## Yayına alma (Cloudflare)

Bir kez yapılır. Komutlar depo kökünden çalıştırılır.

1. **Hesap ve plan.** Cloudflare hesabı açın ve **Workers Paid** planına geçin ($5/ay). Ücretsiz planın
   istek başına 10 ms CPU sınırı panel girişindeki parola özetlemeye (PBKDF2) yetmez.
2. **Oturum.** Kendi bilgisayarınızda `pnpm --filter @ado/cloud exec wrangler login` (tarayıcı açılır).
   Otomasyon için bunun yerine `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 ve R2 düzenleme yetkili)
   ve `CLOUDFLARE_ACCOUNT_ID` ortam değişkenlerini tanımlayın.
3. **Veritabanı.** `pnpm --filter @ado/cloud exec wrangler d1 create ado-qr`; çıktıdaki
   `database_id` değerini `apps/cloud/wrangler.jsonc` içindeki `00000000-…` yerine yazıp commit'leyin
   (gizli değildir).
4. **Görsel deposu.** `pnpm --filter @ado/cloud exec wrangler r2 bucket create ado-qr-images`
5. **Tablolar.** `pnpm --filter @ado/cloud db:migrate:remote`
6. **Satıcı anahtarı.** `pnpm --filter @ado/cloud exec wrangler secret put ADMIN_TOKEN` — uzun, rastgele
   bir değer girin (ör. `openssl rand -base64 32`) ve parola yöneticinizde saklayın. Depoya asla
   yazmayın.
7. **Yükleme.** `pnpm --filter @ado/cloud run deploy` — önce `@ado/shared` ve `@ado/qr-web`'i derler,
   sonra Worker'ı ve sayfaları yükler. (`run` şart: `pnpm deploy` pnpm'in kendi komutudur.)
8. **Alan adı.** Cloudflare panelinde Workers › `ado-qr` › Settings › Domains & Routes › **Add ›
   Custom domain** (ör. `menu.ornek.com`; alan adının DNS'i Cloudflare'da olmalı). Ya da
   `wrangler.jsonc`'a `"routes": [{ "pattern": "menu.ornek.com", "custom_domain": true }]` ekleyip
   yeniden yükleyin. Sertifika otomatik gelir.
9. **Kontrol.** `https://menu.ornek.com/api/health` → `{"success":true,"data":{"ok":true}}`. Yukarıdaki
   `curl` ile bir işletme açıp (adres ve `ADMIN_TOKEN` değişir) panelden giriş yapın.

Sonraki sürümler yalnız 7. adımdır; yeni bir migration varsa önce 5. adım.

### Yayından sonra telefonla kontrol

1. POS'u eşleştirip (kılavuz 5.5) bir masanın QR kartını basın. iPhone (Kamera) ve Android (Kamera ya
   da Google Lens) ile masadan ~50 cm uzaklıktan okutun: menü mobil veride birkaç saniyede açılır,
   işletme adı ve masa doğrudur.
2. Fotoğraflar yüklenir, yazılar okunur, sayfa yana kaymaz; sayfa yakınlaştırılabilir.
3. İngilizce adı olan ürün varsa TR/EN geçişi çalışır; telefon dili İngilizceyse menü EN açılır.
4. POS'ta bir ürünü **Tükendi** yapın; telefonda sayfayı yenileyin: rozet ~10 saniye içinde görünür.
5. POS'ta masanın kodunu yenileyin: eski kart "Bu QR kod geçersiz" gösterir, yeni kart çalışır.
6. POS bilgisayarının internetini kesin: satış sürer, kartta yayın hatası görünür; internet gelince
   **Şimdi yayınla** (ya da bir sonraki değişiklik) menüyü günceller.

### İşletme yönetimi (satıcı API'si)

Tüm istekler `Authorization: Bearer <ADMIN_TOKEN>` ister.

| İş | İstek |
|---|---|
| Paketleri listele | `GET /api/admin/plans` |
| İşletme aç | `POST /api/admin/tenants` `{ name, plan, branchName?, owner: { email, password } }` |
| İşletmeleri listele / ayrıntı | `GET /api/admin/tenants` · `GET /api/admin/tenants/:id` |
| Paket değiştir, özellik aç/kapat, askıya al | `PATCH /api/admin/tenants/:id` `{ plan?, features?, status? }` |
| POS için eşleştirme kodu | `POST /api/admin/branches/:id/pairing-code` |
| Parola sıfırla (tüm oturumlar kapanır) | `POST /api/admin/users/:id/password` `{ password }` |

Paketler: `menu` (QR Menü), `order`, `pay`, `full`. QR-1'de yalnız `qr.menu` özelliği kullanılır.

### İşletim notları

- **Yedek:** D1 Time Travel ile veritabanı son 30 güne kadar herhangi bir ana döndürülebilir
  (`wrangler d1 time-travel`). Görseller içerik adreslidir, üzerine yazılmaz.
- **Günlükler:** `observability` açık; Cloudflare panelinde Workers › `ado-qr` › Logs.
- **Anahtar değişimi:** `wrangler secret put ADMIN_TOKEN` ile yenisi girilir, eskisi hemen geçersiz olur.
- **Güvenlik başlıkları:** statik sayfalar için `apps/qr-web/public/_headers` (CSP, `nosniff`,
  `frame-ancestors 'none'`).
