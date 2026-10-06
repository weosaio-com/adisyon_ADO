# Elle Test Kontrol Listesi — Garson → Mutfak → Kasa

> Her sürümden önce **gerçek donanımla** yapılır: Windows kasa bilgisayarı, termal yazıcı, aynı
> Wi-Fi'de bir tablet. Süre yaklaşık 1 saat. Otomatik testler (smoke, Playwright) yazılımı sınar;
> bu liste yalnız gerçek cihazda görülebilecekleri sınar.
>
> **Sonuç bildirimi:** adım numarası + ✓/✗ + kısa not, varsa fotoğraf.
> Örnek: `4 ✗ — mutfak fişinde not yok`.

---

## 0. Hazırlık

**Gerekenler:** Windows 10/11, [Node.js 22+](https://nodejs.org), Git; varsa Windows'a sürücüsüyle
kurulu bir termal yazıcı (Windows'tan test sayfası basabildiğinizi görün).

PowerShell'de:

```powershell
git clone https://github.com/weosaio-com/adisyon_ADO.git
cd adisyon_ADO
git checkout claude/serene-cray-is4fq8
npm install -g pnpm@11.9.0
pnpm install
copy .env.example .env
```

`.env` dosyasında doldurun: `JWT_ACCESS_SECRET` ve `JWT_REFRESH_SECRET` (uzun rastgele metin),
`SEED_OWNER_PASSWORD`, `SEED_WAITER_PIN` (ör. `1234`), `BACKUP_ENCRYPTION_KEY` (uzun rastgele
metin) ve tabletler için `API_TLS_PORT="3002"`.

```powershell
pnpm prisma:generate
pnpm --filter @ado/shared build
pnpm exec prisma migrate deploy
pnpm --filter @ado/backend seed
pnpm --filter @ado/frontend build
pnpm --filter @ado/backend dev
```

Kasa bilgisayarında tarayıcıyla **http://127.0.0.1:3001** açın. **Yönetici** sekmesi: `owner` ve
`.env`'deki şifre. Veritabanını sıfırlamak için `prisma/schema/prisma/dev.db` dosyasını silip
`migrate deploy` ve `seed` adımlarını tekrarlayın.

> Gerçek yazıcı yoksa 1. adımda **Simülasyon yazıcı** seçin (yalnız geliştirme modunda görünür).
> Fişin içeriği **Son fişler › Önizle**'de ve backend konsolunda görünür.

---

## 1. Yazıcı

**Yap:** Ayarlar › Yazıcılar › **+ Yazıcı ekle** → "Yüklü yazıcılardan seçin" listesinden yazıcınızı
seçin → görünen ad (ör. "Mutfak") → kağıt 80/58 mm → **Varsayılan** işaretli → **Kaydet** →
**Test yazdır**.

**Beklenen:**

- Windows'taki yazıcı listede görünür. (Görünmüyorsa "Listede yok" ile adını elle yazın ve bunu not
  edin.)
- Test sayfası çıkar: "YAZICI TEST SAYFASI" ve "Türkçe karakter testi: ÇĞİÖŞÜ çğıöşü" satırı düzgün
  okunur, satırlar kağıttan taşmaz.
- **Son fişler** listesinde satır birkaç saniyede **Yazdırıldı** olur.

## 2. İşletme bilgileri ve kasa açılışı

**Yap:** Ayarlar › **İşletme Bilgileri**: ad, adres, telefon → **Kaydet**. Kasa › Açılış Bakiyesi
(ör. 100) → **Kasa Aç**.

**Beklenen:** "İşletme bilgileri kaydedildi" mesajı. Kasa ekranında **Beklenen Nakit** ₺100,00.

## 3. Tablet bağlantısı

**Yap:** Kasa bilgisayarında Ayarlar › **Sunucu Adresi** kartındaki adresleri kullanın.

- Tablette **Sertifika indirme adresi**ni açıp sertifikayı kurun (Android / iPad adımları:
  `KULLANIM_KILAVUZU.md` 6. bölüm).
- **HTTPS** adresini açın → **Garson** → kullanıcı `garson`, PIN → **Sisteme giriş yap** → tarayıcı
  menüsünden **Ana ekrana ekle**.
- Tablette Wi-Fi'yi kapatıp uygulamayı ana ekrandan yeniden açın; sonra Wi-Fi'yi açın.

**Beklenen:** Giriş ekranında "Bu bağlantı güvenli değil" uyarısı **görünmez**. Wi-Fi kapalıyken de
uygulama açılır (rozet çevrimdışı), Wi-Fi gelince çevrimiçi olur.

## 4. Garson siparişi (tablet)

**Yap:** Bir masaya dokunun → bir ürün ekleyin, **+** ile adedi 2 yapın → bir ürün daha ekleyin → ilk
üründe **Not** → "az pişmiş" → **Kaydet** → **Mutfağa gönder**.

**Beklenen:**

- Ekranın üstünde salon ve masa adı yazar; **Ödeme al** düğmesi görünmez.
- Not ürünün altında görünür; gönderince kalemlerde "Mutfağa gönderildi" yazar.
- Mutfak fişi çıkar: "MUTFAK FİŞİ", `Masa: <Salon> · <Masa>`, `Garson: <ad>`, tarih/saat,
  `2 x <ürün>` ve hemen altında `Not: az pişmiş`. Fişte fiyat yoktur.

## 5. Kasada ödeme (kasa bilgisayarı)

**Yap:** Masalar ekranına bakın → masaya girin → **Hesap** → **Ödeme al** → **Kart**, "Adisyondan
düşülecek tutar"a 100 yazıp öde → **Nakit** → **+200** (kalan 200'den azsa) → öde → **Tamam**.

**Beklenen:**

- Masa, sayfa yenilenmeden dolu ve toplam tutarıyla görünür.
- Hesap fişi: işletme başlığı, "\*\*\* HESAP \*\*\* (Ödeme alınmadı)", toplam, "Bilgi fişidir —
  mali değeri yoktur."
- Nakitte **Para üstü** doğru hesaplanır ve ödemeden sonra ekranda kalır.
- Müşteri fişi: başlık, masa, `Kart: 100,00 TL`, `Nakit: …`, `Para üstü: …`, mali değer notu.
- Masa boşalır. Kasa › **Beklenen Nakit**, müşterinin verdiği para kadar değil, adisyondan düşülen
  nakit kadar artar.

## 6. Yanlış açılan masa

**Yap:** Tablette boş bir masaya dokunun → ürün eklemeden **Masayı kapat (boş adisyon)**.

**Beklenen:** Masa planına dönülür; masa yine boş görünür.

## 7. Yanlış ödeme ve fişi yeniden yazdırma

**Yap:** Yeni bir siparişi **Kart** ile ödeyin → Kasa › Son işlemler › o ödemede **İade** → neden
"Yanlış ödeme yöntemi" → **İade et** → **Adisyonu aç** → **Ödeme al** → **Nakit** → öde → Kasa ›
Son işlemler › nakit satırında **Fiş**.

**Beklenen:** İadeden sonra adisyon yeniden açılır ve ödeme ekranında "Ödenen ₺0,00" görünür. **Fiş**
ile basılan fişte "MÜŞTERİ FİŞİ — ÖDENDİ (tekrar)" başlığı ve yalnız Nakit satırı vardır.

## 8. PIN değiştirme (kasa uygulamasında)

**Yap:** **Ekip** › garsonun yanındaki **PIN** → yeni PIN → **Kaydet** → tablette çıkış yapıp yeni
PIN ile girin.

**Beklenen:** PIN penceresi açılır (önceden kasa uygulamasında düğme hiçbir şey yapmıyordu); yeni PIN
ile giriş yapılır.

## 9. Yazıcı kapalıyken

**Yap:** Yazıcıyı kapatın → tablette bir sipariş gönderin → 20 sn bekleyin → kasa bilgisayarında
Masalar ekranına bakın → yazıcıyı açın → Ayarlar › Yazıcılar › Son fişler › **Tekrar dene**.

**Beklenen:** Masalar ekranında "1 fiş yazdırılamadı" uyarısı çıkar. Tekrar dene sonrası fiş basılır
ve uyarı kalkar.

## 10. Gün sonu

**Yap:** Açık masaları kapatın → Kasa › **Kasa Kapat (Z)** → kasadaki nakdi sayıp **Sayılan Tutar**'a
girin → **Kasayı Kapat**.

**Beklenen:** **Fark** ₺0,00 (ya da gerçekten eksik/fazla olan tutar). Para üstü yüzünden sahte fark
oluşmaz.

## 11. (İsteğe bağlı) Kurulum paketi

**Yap:** `pnpm --filter @ado/desktop dist` → `apps/desktop/dist` altındaki kurulum dosyasını
çalıştırın → ilk açılışta yönetici hesabını oluşturun → 1, 4, 5 ve 8. adımları kısaca tekrarlayın.

**Beklenen:** Program açılır. Tabletler Ayarlar › Sunucu Adresi'ndeki adreslerle bağlanır
(paketli sürümde HTTP `43127`, HTTPS `43128`).
