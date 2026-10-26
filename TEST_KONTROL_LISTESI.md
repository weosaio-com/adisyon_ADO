# Elle Test Kontrol Listesi — Garson → Mutfak → Kasa

> Her sürümden önce **gerçek donanımla** yapılır: Windows kasa bilgisayarı, termal yazıcı, aynı
> Wi-Fi'de bir tablet ve bir telefon. Süre yaklaşık 1,5 saat. Otomatik testler (smoke, Playwright) yazılımı sınar;
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

**Yap:** Kasa bilgisayarında Ayarlar › **Sunucu Adresi** kartındaki QR kodları kullanın.

- Tabletin kamerasıyla **1. Sertifika** QR kodunu okutup sertifikayı kurun (Android / iPad adımları:
  `KULLANIM_KILAVUZU.md` 6. bölüm).
- **2. Adisyonu aç** QR kodunu okutun → **Garson** → kullanıcı `garson`, PIN → **Sisteme giriş yap**
  → **Uygulamayı yükle** (düğme yoksa tarayıcı menüsünden **Ana ekrana ekle**; iPad'de Safari ›
  Paylaş › Ana Ekrana Ekle).
- Tablette Wi-Fi'yi kapatıp uygulamayı ana ekrandan yeniden açın; sonra Wi-Fi'yi açın.

**Beklenen:** QR kodlar doğru adresleri açar. Giriş ekranında "Bu bağlantı güvenli değil" uyarısı
**görünmez**. Uygulama ana ekrandan tam ekran açılır. Wi-Fi kapalıyken de uygulama açılır (rozet
çevrimdışı), Wi-Fi gelince çevrimiçi olur.

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

**Yap:** `pnpm --filter @ado/desktop dist` (deneme profili; bkz. `LICENSING.md` §5) → `apps/desktop/dist` altındaki kurulum dosyasını
çalıştırın → ilk açılışta yönetici hesabını oluşturun → 1, 4, 5 ve 8. adımları kısaca tekrarlayın.

Program açıkken masaüstü simgesine bir kez daha tıklayın. Sonra programı kapatıp hemen yeniden açın.

**Beklenen:** Program açılır. Tabletler Ayarlar › Sunucu Adresi'ndeki adreslerle bağlanır
(paketli sürümde HTTP `43127`, HTTPS `43128`). İkinci tıklama yeni pencere açmaz, açık pencereyi
öne getirir. Kapatıp hemen açınca "Backend başlatılamadı" hatası çıkmaz; QR menü kartı "Yayınlanıyor…"
durumunda takılı kalmaz.

## 12. Telefondan garson siparişi

**Yap:** Bir telefonda 3. adımı tekrarlayın (sertifika, adisyon, **Uygulamayı yükle**). Garson
olarak girip bir masaya dokunun → iki ürün ekleyin → alttaki **Adisyonu gör** şeridine dokunun →
**Mutfağa gönder** → **+ Ürün ekle**.

**Beklenen:** Sayfa yana kaymaz, yazılar kesilmez. Ürün ekledikçe şeritte kalem sayısı, "mutfağa
gönderilmedi" ve toplam güncellenir. Adisyonda iki kalem ve düğmeler tam görünür; mutfak fişi çıkar.
**+ Ürün ekle** ürünlere döner.

## 13. Bağlantı yokken ödeme

**Yap:** Tablette (ya da telefonda) **yönetici/kasiyer** olarak girin → Wi-Fi'yi kapatın → boş bir
masaya dokunun → ürün ekleyin → adisyonu açın. Sonra Wi-Fi'yi açın ve rozet yeşil olana kadar
bekleyin.

**Beklenen:** Wi-Fi kapalıyken **Ödeme al** pasiftir ve altında "Ödeme için ana bilgisayara
bağlantı gerekir. Sipariş bu cihazda saklandı; bağlantı gelince gönderilir." yazar. Wi-Fi gelince
sipariş ana makineye geçer, uyarı kalkar ve **Ödeme al** çalışır. Kasada tek ödeme kaydı oluşur.

## 14. (İsteğe bağlı) WiFi'siz işletme

**Yap:** Kasa bilgisayarını ve tableti bir Android telefonun erişim noktasına (hotspot) bağlayın;
telefonun mobil verisi kapalı olabilir. Ayarlar › Sunucu Adresi'ndeki yeni adresle 3. ve 4. adımları
kısaca tekrarlayın.

**Beklenen:** Tablet kasaya bağlanır ve sipariş alınır. Bağlanamıyorsa telefon cihazların birbirini
görmesine izin vermiyordur; internetsiz basit bir modem/router kullanın (kılavuz 6. bölüm › İşletmede
WiFi yoksa).

## 15. (Test ortamı kurulunca) QR menü lisansla

**Yap:** Test profiliyle derlenmiş programda deneme lisansını **Ayarlar › Lisans**'a girin,
**Ayarlar › QR Menü › QR menüyü aç** deyin. **Masa QR kodları**'ndan bir kart basıp telefonla
okutun. Bir ürünün fiyatını değiştirin ve **Tükendi** yapın. Bilgisayarın internetini kesip bir ürün
adı değiştirin, sonra interneti açın. En sonda **QR menüyü kapat** deyin.

**Beklenen:** Menü telefonda açılır; fiyat ve "Tükendi" birkaç saniyede görünür. İnternetsiz yapılan
değişiklik internet gelince kendiliğinden yayınlanır. Kapatınca kart "Bu QR kod geçersiz" gösterir;
yeniden açınca aynı kart yine çalışır. Telefonda eski panel uygulaması varsa internetteyken açılınca
"İşletme paneli kaldırıldı" yazar.

## 16. (0.3.0) Eski sürümün üzerine kurulum

**Yap:** 0.2.0 kurulu ve içinde gerçek veri (ürünler, masalar, geçmiş adisyonlar) olan bilgisayarda,
gün sonundan sonra GitHub › Releases'tan indirilen `Adisyon-POS-Setup-0.3.0.exe`'yi çalıştırın.
Program açılınca yönetici olarak girin; **Ayarlar › Lisans**'a deneme lisansını girin, **Ayarlar ›
QR Menü › QR menüyü aç** deyin ve masa QR kartlarını yeniden basın (15. adım).

**Beklenen:** Kurulum veriyi sormadan korur: ürünler, masalar, kullanıcılar ve geçmiş raporlar
yerindedir. **Ayarlar › Güncelleme** kartında "Sürüm 0.3.0" yazar. QR menü telefonda açılır.

## 17. (Deneme sürümü yayınlanınca) Otomatik güncelleme

**Yap:** Bir önceki sürüm kurulu bilgisayarda yeni sürüm yayınlandıktan sonra **Ayarlar › Güncelleme ›
Şimdi kontrol et** deyin, indirmenin bitmesini bekleyin. Açık bir adisyon varken ve kasa açıkken
**Güncellemeyi kur**'a bakın; aynı kartı bir tabletten açın. Sonra adisyonu kapatıp gün sonu yapın
ve kasa bilgisayarından **Güncellemeyi kur** deyin.

**Beklenen:** Kart "Yeni sürüm … kurulmaya hazır" der. Açık adisyon/kasa ve tablet için engel yazar,
düğme pasiftir. Onaydan sonra "Program güncelleniyor" sayfası çıkar; program kapanır ve birkaç
dakika içinde yeni sürümle kendiliğinden açılır. Veriler yerindedir; **Ayarlar › Yedekler**'de
güncelleme öncesi yedek görünür; kartta "Son kurulum: … kuruldu" yazar.

## 18. (0.4.0) Eski sürümün üzerine kurulum

**Yap:** 0.3.0 ya da 0.2.0 kurulu, içinde gerçek veri olan bilgisayarda, gün sonundan sonra
`Adisyon-POS-Setup-0.4.0.exe`'yi çalıştırın (0.3.0 bu sürümü kendiliğinden almaz). Yönetici olarak
girin ve **Ayarlar › Lisans**'a bakın; lisans yoksa deneme lisansını girin.

**Beklenen:** Ürünler, masalar, kullanıcılar ve geçmiş raporlar yerindedir. **Ayarlar › Güncelleme**
"Sürüm 0.4.0" der. **Ayarlar › Yedekler**'de eski yedekler listelenir. Lisans kartında
"Bulut: bağlı · son görülme …" yazar. QR menü açıksa açık kalır; basılı QR kartları çalışır.

## 19. (0.4.0) Depolama kartı

**Yap:** **Ayarlar › Depolama** kartına bakın, **Şimdi temizle** deyin.

**Beklenen:** Veritabanı, Yedekler, Ürün görselleri, Kayıt dosyaları ve Boş disk alanı satırları
doludur. Yedek sayısı **Ayarlar › Yedekler**'deki listeyle aynıdır. Temizlikten sonra "Son temizlik:
…" satırı çıkar; ürünler, adisyonlar ve raporlar değişmez.

## 20. (Test bulutu güncellenince) Bulut yedeği ve başka bilgisayara geri yükleme

**Yap:** Kasa bilgisayarında **Ayarlar › Yedekler › Kurtarma anahtarı**'nı yönetici şifresiyle açıp
not alın. **Ayarlar › Bulut Yedeği › Şimdi buluta yedekle** deyin. Sonra programın hiç kurulmadığı
başka bir Windows bilgisayara 0.4.0'ı kurun. İlk açılış ekranında **Yedekleriniz buluttaysa:
buluttan geri yükleyin**'e tıklayın. Lisans anahtarını girip **Buluttaki yedekleri listele** deyin.
En üstteki yedeği seçin, kurtarma anahtarını girip **Yedeği geri yükle** deyin. İstenince programı
kapatıp açın.

**Beklenen:** Kasa bilgisayarında kart birkaç dakika içinde "Son bulut yedeği: …" gösterir. Yeni
bilgisayarda yedekler en yenisi üstte listelenir. Yanlış kurtarma anahtarı reddedilir. Geri
yüklemeden sonra kasa bilgisayarının ürünleri, masaları ve kullanıcıları gelir; eski şifrelerle
girilir. Yeni bilgisayarın Lisans kartında "bu lisans başka bilgisayarda açık" ve **Bu bilgisayara
al** düğmesi görünür. Denemede bu düğmeye **basmayın**: basarsanız kasa bilgisayarının bulut
bağlantısı kesilir.

## 21. (0.4.0) Lisans kilidi

**Yap:** Test sürümünü lisans girmeden kurun (ya da 20. adımdaki yeni bilgisayarı sıfırdan kurun).
Yönetici olarak girin, bir ürün ve bir masa ekleyin, masaya dokunup adisyon açmayı deneyin. Sonra
çıkan pencereden deneme lisansını girin ve yeniden deneyin.

**Beklenen:** Her ekranın üstünde kırmızı şerit "Lisans tanımlı değil: yeni adisyon açılamıyor…"
yazar. Ürün ve masa eklenir; adisyon açılmaz ve lisans penceresi kendiliğinden açılır. Lisans
girilince şerit kalkar, adisyon açılır.

**Süresi geçmiş lisansla (isteğe bağlı):** satıcıdan bitiş tarihi birkaç gün önce geçmiş bir
deneme lisansı istenip girilir. Şeritte "Lisans süresi doldu: … itibarıyla yeni adisyon
açılamayacak (N gün kaldı)" yazar; adisyon hâlâ açılır. Ek süre bitince yeni adisyon açılmaz ama
açık adisyon ödenip kapatılır; raporlar ve gün sonu çalışır.

## 22. (0.4.2 yayınlanınca) 0.4.0'dan otomatik güncelleme

**Yap:** 0.4.0 kurulu bilgisayarda 17. adımı yapın.

**Beklenen:** 17. adımdaki gibi. Ek olarak güncellemeden sonra **Ayarlar › Güncelleme** "Sürüm 0.4.2"
der, Lisans kartında "Bulut: bağlı" ve Bulut Yedeği kartında son bulut yedeği görünür.

## 23. (0.4.2) Donma düzeltmeleri

**Yap:**

1. Kasa kapalıyken Masalar ekranında boş bir masaya dokunun; çıkan uyarıda **Kasa ekranını aç**'a
   basın ve açılış bakiyesini yazın.
2. Soldaki menüden **Ekip**'e girin, bir kullanıcının **Sil** düğmesine basın, onay penceresinde
   **Vazgeç** deyin (ya da Esc). Hemen ardından bir yazı kutusuna tıklayıp yazın.
3. Yazıcıyı kapatın, bir fiş yazdırın; beklemeden masa açıp sipariş girmeye devam edin.
4. Programı gün boyu kapatmadan kullanın.
5. Yoğun saati benzetin: 3–4 tablet ya da telefondan aynı anda birkaç masaya sipariş girin; bu sırada
   kasada **Ayarlar › Yedekler › Yedek al** deyin.

**Beklenen:**

1. Uyarı ekranın içinde çıkar ("Yeni adisyon açmak için önce kasa oturumunu açın."); bakiye kutusuna
   yazı gider.
2. Onay penceresi programın içinde açılır; kapandıktan sonra yazı kutuya gider, programı kapatıp
   açmak gerekmez. Kullanıcı silinmez.
3. Program donmaz, sipariş girişi sürer; en geç 30 sn içinde 9. adımdaki "fiş yazdırılamadı" uyarısı
   çıkar.
4. Donma olmaz. Olursa programı kapatmayın: pencere 30 sn yanıt vermezse program **Yeniden yükle /
   Bekle** diye sorar; **Yeniden yükle** kayıtlı adisyonları silmez. Arka plan kapanır ya da yanıt
   vermezse program en geç yaklaşık 1 dakikada kendisi yeniden başlatır. Saati not edin ve
   `%APPDATA%\@ado\desktop\` klasöründeki `ado-olaylar.log` ve `backend-error.log` dosyalarını gönderin.
5. Ekranlar takılmaz, "Sistem meşgul" ya da "Sunucu hatası" çıkmaz; siparişler mutfağa birkaç saniye
   içinde düşer, yedek alınır.
