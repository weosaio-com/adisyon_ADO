# Adisyon POS — Kurulum ve Kullanım Kılavuzu

> Bu belge işletme sahibine ve personele yöneliktir. Teknik bilgi gerektirmez.
> Amaç: sistemi kurmak, ilk ayarları yapmak ve günlük kullanmak.

---

## 1. Sistem Nasıl Çalışır? (Kısaca)

Adisyon POS, kafe/restoran/büfe/pastane için **çevrimdışı çalışabilen** bir adisyon/satış otomasyonudur.

- **Ana makine (kasa bilgisayarı):** Programın kurulu olduğu Windows bilgisayar. Tüm veriler
  (adisyonlar, ürünler, ödemeler, raporlar) **burada** tutulur. İnternete ihtiyaç duymaz.
- **Garson tabletleri / telefonlar:** Aynı WiFi ağına bağlı cihazlar, tarayıcıdan ana makineye
  bağlanır ve sipariş alır. Mağazadan program indirmeye gerek yoktur; adisyon tarayıcıdan **uygulama
  olarak yüklenir** (ana ekranda simge, tam ekran; 6. bölüm).
- **İnternet gerekmez:** Sistem tamamen yerel ağda (kendi WiFi'niz) çalışır. İnternet yalnızca
  isteğe bağlı **bulut yedeği** ve **QR menü** (5.5) için kullanılır; internet kesilse de satış
  sürer, QR menü bağlantı gelince güncellenir.

```
        WiFi / Yerel Ağ (internet gerekmez)
   ┌───────────────┬───────────────┬───────────────┐
 [Tablet 1]     [Tablet 2]      [Tablet 3]   ...
   garson         garson          garson
        │              │               │
        └──────────────┴───────────────┘
                       │
              [ ANA MAKİNE / KASA ]
              Program + tüm veriler burada
```

**En önemli özellik:** Bir garson tabletinin WiFi bağlantısı kopsa bile garson **sipariş almaya
devam eder**. Bağlantı gelince siparişler otomatik ve kayıpsız senkronlanır.

---

## 2. Gereksinimler

| | Öneri |
|---|---|
| **Ana makine** | Windows 10/11, 4 GB RAM, açık kalabilen bir bilgisayar (kasa PC) |
| **Ağ** | Bir WiFi router (internet şart değil); ana makine tercihen **kabloyla** bağlı |
| **Tabletler** | Güncel bir tarayıcısı olan herhangi bir tablet/telefon (Android/iPad/Windows) |
| **Yazıcı** | (İsteğe bağlı) Mutfak/fiş yazıcısı — önce Windows'a sürücüsüyle kurulur (5.4) |

> **İpucu:** Ana makineye **sabit yerel IP** verilmesi tavsiye edilir; böylece tabletlerin adresi
> hep aynı kalır.

---

## 3. Kurulum (Ana Makine)

1. Size verilen **kurulum dosyasını** (`Adisyon-POS-Setup-<sürüm>.exe`, ör.
   `Adisyon-POS-Setup-0.3.0.exe`) ana makinede çalıştırın.
2. Windows "Windows bilgisayarınızı korudu" uyarısı gösterirse **Ek bilgi › Yine de çalıştır** deyin
   (program henüz kod imzalama sertifikasıyla imzalı değil).
3. Kurulum kendiliğinden tamamlanır ve program açılır. Sonraki açılışlarda masaüstündeki **Adisyon
   POS** simgesini kullanın.

Program ilk açıldığında kendi kendine hazırlanır (birkaç saniye sürebilir). Tüm veriler bu
bilgisayarda güvenle saklanır; taşımak/yedeklemek için 10. bölüme bakın.

---

## 4. İlk Açılış — Yönetici Hesabı Oluşturma

Program **ilk kez** açıldığında sizi bir **kurulum ekranı** karşılar (henüz kullanıcı yoktur):

1. **Yönetici (Owner) kullanıcı adı** ve **şifre** belirleyin.
2. **Kaydet** deyin.

Bu hesap **işletme sahibi** hesabıdır: her yetkiye sahiptir (ürün, kasa, rapor, kullanıcı yönetimi).
Şifreyi güvenli tutun.

> Bundan sonra her açılışta bu kullanıcı adı/şifre ile giriş yaparsınız.

---

## 5. Başlangıç Ayarları (Bir Kez Yapılır)

Yönetici olarak giriş yaptıktan sonra üst menüden şu ayarları yapın:

### 5.1 Garson (Personel) Hesapları — **Kullanıcılar**
- Her garson için bir hesap açın; garsonlar **4 haneli PIN** ile hızlıca giriş yapar.
- Garsonlar yalnızca **sipariş alma** yetkisine sahiptir (ödeme/kasa/rapor göremez).

### 5.2 Salonlar ve Masalar — **Masa Yönetimi**
- Önce **salon** ekleyin (örn. "İç Salon", "Bahçe").
- Sonra her salona **masalarını** ekleyin.

### 5.3 Ürünler — **Ürünler**
- **Kategori** ekleyin (örn. "İçecekler", "Ana Yemek").
- Gerekirse **birim** (adet, porsiyon) ve **KDV oranı** tanımlayın.
- **Ürünleri** fiyatlarıyla ekleyin. (İsterseniz ürün için **stok takibi**ni açabilirsiniz.)

### 5.4 İşletme Bilgileri ve Yazıcılar — **Ayarlar**
- **İşletme Bilgileri:** İşletme adı, adres ve telefon. Müşteri fişinin ve hesabın en üstüne
  basılır.
- **Yazıcılar:** Yazıcıyı önce Windows'a (üreticinin sürücüsüyle) kurun ve Windows'tan bir test
  sayfası basıldığını görün. Sonra **Ayarlar › Yazıcılar › + Yazıcı ekle**:
  1. **Yüklü yazıcılardan** seçin (listede yoksa Windows'taki adını aynen yazın), görünen ad
     verin (örn. "Mutfak"), kağıt genişliğini (80/58 mm) seçin.
  2. İlk yazıcıyı **Varsayılan** yapın: yönlendirme yoksa tüm fişler buradan çıkar.
  3. **Test yazdır** deyin; sayfadaki "ÇĞİÖŞÜ" satırı düzgün okunuyorsa yazıcı hazırdır.
  4. **Hangi fiş nereden çıksın?** bölümünden mutfak fişi ve müşteri fişi yazıcısını seçin.
     İçecekleri bara yönlendirmek için **Kategoriye özel** satırını kullanın
     (örn. İçecekler → Bar yazıcısı).
- **Son fişler** listesi basılan her fişi gösterir (**Önizle** ile içeriği görülür). Yazdırılamayan
  fiş kırmızı işaretlenir; yazıcıyı/kağıdı kontrol edip **Tekrar dene** deyin. Böyle bir fiş varsa
  Masalar ekranının üstünde de uyarı çıkar.

### 5.5 QR Menü (isteğe bağlı) — **Ayarlar › QR Menü**
Müşteri masadaki QR kodu telefonunun kamerasıyla okutur ve menünüzü görür: fotoğraf, açıklama,
alerjenler, İngilizce ve "tükendi" bilgisi. Uygulama kurmaya gerek yoktur. Menü **bu programdan**
yönetilir; ayrı bir hesap, adres ya da kod gerekmez. QR menü lisansınıza bağlıdır.

> Lisanslı program internete çıktığında buluta **kendiliğinden** bağlanır (Ayarlar › Lisans'ta
> "Bulut: bağlı" yazar). Bu bağlantı yenilenen lisansın gelmesi ve bulut yedeği içindir; QR menü bu
> bağlantı üzerinde ayrıca açılıp kapatılır.

1. **Lisans:** **Ayarlar › Lisans** bölümüne satıcınızın verdiği lisans anahtarını yapıştırıp
   **Lisansı Etkinleştir** deyin. Bölümde "QR menü: dahil" yazmalıdır.
2. **Ürün bilgileri:** **Ürünler**'de ürünü açıp **QR menü bilgileri**'ne dokunun: fotoğraf (telefon
   fotoğrafı olabilir, program küçültür), açıklama, alerjenler, diyet (vegan, glutensiz…) ve
   isterseniz İngilizce ad. İngilizce ad girilen ürün olduğunda menüde TR/EN seçeneği çıkar.
3. **Açma:** **Ayarlar › QR Menü** kartında **QR menüyü aç** deyin. Menü birkaç saniyede yayınlanır;
   kartta **Son yayın** zamanı görünür. İnternet yoksa kart "İnternet bekleniyor" der; bağlantı
   gelince QR menü kendiliğinden açılır.
4. **QR kartları:** Karttaki **Masa QR kodları** (ya da **Düzen › QR kodları**) › **Yazdır**. Kartları
   kesip masalara yapıştırın. Kartları QR menüyü açmadan önce de basabilirsiniz (sayfa uyarır). Bir
   masanın kodunu **Kodu yenile** ile değiştirirseniz o masanın eski kartı çalışmaz; yenisini basın.

- Ürün, fiyat, kategori, masa, salon ya da işletme bilgisi değiştiğinde menü **kendiliğinden**
  güncellenir (birkaç saniye). İnternet kesikse değişiklikler bağlantı gelince yayınlanır. Beklemek
  istemezseniz kartta **Şimdi yayınla** deyin.
- **Lisans yenileme:** Yeni lisansı **Ayarlar › Lisans**'a girmeniz yeter; QR menü açık kalır.
- **Tek bilgisayar:** Bir lisans tek bilgisayarda bağlı olur. Başka bilgisayarda kullanmak
  isterseniz Lisans bölümü "bu lisans başka bilgisayarda açık" der; **Bu bilgisayara al** derseniz
  diğer bilgisayar artık buluta bağlanamaz ve menüyü güncelleyemez.
- **Kapatma:** **QR menüyü kapat** deyince masalardaki QR kodlar menü açmaz; buluta bağlantı (lisans
  yenileme, bulut yedeği) sürer. Yeniden açınca aynı kartlar yine çalışır.
- Menüde alerjen bilgisi için "personele danışın" notu her zaman yer alır.
- Müşterinin gördüğü QR menü uygulama değildir; her zaman web'den, en güncel haliyle açılır.
- Eskiden kullanılan web işletme paneli kaldırıldı. Telefona yüklediyseniz internetteyken açtığınızda
  "İşletme paneli kaldırıldı" yazar ve kendini temizler; simgeyi ana ekrandan silebilirsiniz.

Bu ayarlar bittiğinde sistem satışa hazırdır.

---

### 5.6 Lisans — **Ayarlar › Lisans**

Satıcınızın verdiği lisans anahtarını **Ayarlar › Lisans** bölümüne yapıştırıp **Lisansı
Etkinleştir** deyin. Lisans girilmeden menü, masa, kullanıcı ve yazıcı ayarları yapılabilir ama
**yeni adisyon açılamaz**.

- Lisansın bitmesine 14 gün kala ekranın üstünde uyarı şeridi çıkar.
- Süre bitince **7 gün ek süre** vardır; şerit hangi gün kilitleneceğini yazar.
- Ek süre de bitince yeni adisyon açılamaz. Açık hesaplar yine ödenip kapatılır; raporlar, kasa
  kapanışı, yedek ve ayarlar her zaman açıktır.
- Yeni lisansı girdiğiniz an kilit kalkar. Program internete bağlıysa satıcının yenilediği lisans
  kendiliğinden gelir ve kurulur.
- Bilgisayarın saati geri alınsa da süre uzamaz.

## 6. Tablet ve Telefonların Bağlanması

Ana makinede **Ayarlar › Sunucu Adresi** kartı, tablet ve telefonlarda kullanılacak adresleri
gösterir (örnek: `https://192.168.1.20:43128`). Adresleri buradan kopyalayabilirsiniz; ana
makinenin IP'si değişirse güncel adres de burada görünür. Kartta iki **QR kod** da vardır:
**1. Sertifika** ve **2. Adisyonu aç**. Tablet ya da telefonun kamerasıyla okutursanız adres
yazmanız gerekmez.

### Önerilen: HTTPS ile (bağlantı koparsa da uygulama açılır)

Her cihazda **bir kez** yapılır (Android'de **Chrome** önerilir):

1. Cihazı **ana makineyle aynı WiFi ağına** bağlayın.
2. **1. Sertifika** QR kodunu okutun ya da tarayıcıda kartta yazan **sertifika indirme adresini**
   açın (örnek: `http://192.168.1.20:43127/api/v1/devices/ca.crt`). `adisyon-pos-ca.crt` dosyası iner.
3. Sertifikayı kurun:
   - **Android:** Ayarlar'da "sertifika" diye aratın › **CA sertifikası yükle** › indirilen
     dosyayı seçin ve uyarıyı onaylayın.
   - **iPad / iPhone:** Ayarlar › **Profil İndirildi** › Yükle. Ardından Ayarlar › Genel › Hakkında ›
     **Sertifika Güven Ayarları** › "Adisyon POS Yerel CA" için tam güveni açın.
4. **2. Adisyonu aç** QR kodunu okutun ya da tarayıcıda **HTTPS adresini** açın (örnek:
   `https://192.168.1.20:43128`); garson **PIN** ile girer.
5. Giriş ekranındaki **Uygulamayı yükle** düğmesine dokunun (düğme yoksa tarayıcı menüsünden **Ana
   ekrana ekle**; iPhone/iPad'de Safari › **Paylaş › Ana Ekrana Ekle**). Simge oluşur; uygulama tam
   ekran açılır ve **WiFi koptuğunda da açılır.**

> Ana makinenin IP adresi değişse bile sertifikayı yeniden kurmanız gerekmez; yalnızca
> Ayarlar'daki yeni adresi kullanın. Sertifika yalnızca sizin ana makinenize aittir. Yüklü uygulama
> simgesi ise eski adrese bağlı kalır; yeni adresi açıp yeniden yükleyin. Bunu önlemek için
> modem/router ayarlarından ana makineye **sabit IP** verin (DHCP rezervasyonu).

### Telefonda kullanım

Garson kendi telefonunu da kullanabilir; kurulum tabletle aynıdır. Telefonda ürünler tam ekran
açılır; alttaki **Adisyonu gör** şeridi kalem sayısını, mutfağa gönderilmemiş kalemleri ve toplamı
gösterir. Şeride dokununca adisyon açılır (mutfağa gönder, not, ödeme); **+ Ürün ekle** ile
ürünlere dönülür.

### İkinci bilgisayar

Başka bir bilgisayarda da Chrome ya da Edge ile HTTPS adresini açıp **Uygulamayı yükle**
diyebilirsiniz. Sertifika o bilgisayara da bir kez kurulur: Windows'ta indirilen dosyaya çift
tıklayın › **Sertifika Yükle** › **Tüm sertifikaları aşağıdaki depolama alanına yerleştir** ›
**Güvenilen Kök Sertifika Yetkilileri**. Program (veritabanı, yazıcılar, yedek) yalnız ana
makinede çalışır; ikinci bilgisayar bir tablet gibi bağlanır.

### İşletmede WiFi yoksa

İnternet gerekmez; ana makineyle tablet ve telefonların **aynı yerel ağda** olması yeterlidir.

- **Önerilen:** internet bağlantısı olmayan basit bir modem/router. Ana makineyi kabloyla, tablet ve
  telefonları WiFi ile bağlayın.
- **Geçici çözüm:** bir Android telefonun **erişim noktasını (hotspot)** açıp ana makineyi ve diğer
  cihazları ona bağlayın; mobil verinin açık olması gerekmez. Bazı telefonlar bağlı cihazların
  birbirini görmesine izin vermez; ilk kurulumda deneyin.
- **Hiç ağ yoksa** ana makine tek başına çalışır; siparişler ve ödemeler oradan alınır.
- İnternet yalnız QR menünün güncellenmesi ve bulut yedeği içindir; internet gelince bunlar
  kendiliğinden gider.

### Sertifikasız (HTTP)

`http://192.168.1.20:43127` adresi de çalışır; ancak bağlantı koptuğunda sayfa yenilenirse ya da
tablet kapanıp açılırsa uygulama **açılmaz** (açık sayfada sipariş almaya devam edilebilir).
Giriş ekranı bu durumda sarı bir uyarı gösterir.

> **HTTP'den HTTPS'e geçerken:** tablette gönderilmemiş işlem olmadığından emin olun (bağlantı
> rozeti yeşil olmalı); her adres kendi çevrimdışı kuyruğunu tutar.

> Aynı anda birden fazla tablet bağlanabilir; hepsi aynı masaları canlı görür. Windows Güvenlik
> Duvarı ilk açılışta izin sorarsa **Özel ağlar** için izin verin.

---

## 7. Günlük Kullanım Akışı

1. **Masalar ekranı:** Boş masa beyaz, dolu masa koyu, bekletilen mor, çevrimdışı açılıp
   senkron bekleyen sarı görünür.
2. **Sipariş alma:** Boş masaya dokun → adisyon açılır (ekranın üstünde salon ve masa adı yazar).
   Kategoriden ürünlere dokunarak ekle; adet **+ / −** ile ayarlanır, gönderilmemiş kalem
   silinebilir. **Not** ile ürüne not eklenir (örn. "az pişmiş, soğansız"); not mutfak fişinde
   ürünün altına basılır. Yanlış masaya dokunduysanız boş adisyonda **Masayı kapat** deyin.
3. **Mutfağa Gönder:** Kalemler hazırsa "Mutfağa Gönder" ile mutfağa/kasaya iletilir (ve varsa
   mutfak fişi basılır). Gönderilen kalem kilitlenir; değişiklik için yöneticiden **iptal (void)**
   gerekir.
4. **Ödeme / Kapatma:** Ödeme **kasadan/yöneticiden** alınır (nakit/kart/havale/veresiye,
   kısmi/split ödeme). Nakitte müşterinin verdiği parayı **Alınan nakit** alanına yazın (ya da
   +20/+50/+100/+200 düğmelerine dokunun); **para üstü** ekranda gösterilir ve ödemeden sonra
   ekranda kalır. Kasaya yalnızca adisyon tutarı satış olarak yazılır. Ödeme tamamlanınca masa
   boşalır ve müşteri fişi basılır.
5. **Ek işlemler (yönetici):** Masa taşı/birleştir, adisyon böl, indirim (yüksek indirim yönetici
   onayı ister), beklet/çağır, **İptal et** (neden seçilerek; ödeme alınmışsa önce iade gerekir).
6. **Yanlış ödeme / fiş tekrarı:** **Kasa › Son işlemler** listesinde ilgili ödemenin yanındaki
   **İade** ile ödeme geri alınır ve adisyon yeniden açılır; doğru ödemeyi alın. Düzeltilmiş (ya da
   kaybolan) müşteri fişini aynı listedeki **Fiş** düğmesiyle yeniden basabilirsiniz.
7. **Ürün bitti:** **Ürünler** ekranında ürünün yanındaki **Tükendi** düğmesine basın. Ürün QR
   menüde soluk "Tükendi" rozetiyle görünür ve siparişe eklenemez. Ürün gelince **Satışa aç**.
8. **Gün Sonu:** Gün bitince **Kasa → Gün Sonu (Z raporu)** ile kasa sayımı ve özet alınır.

> **Not:** Programın bastığı fişler **bilgi fişidir, mali değeri yoktur**. Yasal mali fiş (ÖKC
> fişi / e-Arşiv) ayrıca düzenlenmelidir; mali müşavirinize danışın.

---

## 8. Çevrimdışı (Offline) Çalışma — Önemli

Bu sistemin en güçlü yanı: **bağlantı koptuğunda satış durmaz.**

**Garson tabletinde bağlantı durumu her zaman görünür:**
- 🟢 **Çevrimiçi** — her şey anlık senkron.
- 🔴 **Çevrimdışı** — bağlantı yok; siparişler tablette güvenle birikiyor.
- 🟡 **Senkronlanıyor** — bağlantı geldi, bekleyenler gönderiliyor.

**Bağlantı kopukken garson yapabilir:**
- Masa açmak, ürün eklemek/çıkarmak, adet değiştirmek, **mutfağa göndermek.**

Bu işlemler tablette **kalıcı** saklanır — tablet kapansa, yenilense veya şarjı bitse bile
kaybolmaz. (Bağlantı yokken uygulamanın yeniden **açılabilmesi** için tablette HTTPS adresi
kullanılmalıdır — bkz. 6. bölüm.) Bağlantı gelince **otomatik ve kayıpsız** senkronlanır. Bekleyen sipariş kaleminde
"⏳ senkron bekliyor" işareti görünür; gönderilince kalkar.

**Bağlantı kopukken yapılamaz (güvenlik gereği):** ödeme, kasa işlemleri, yüksek indirim, iade,
kayıt silme. Bunlar her zaman **yönetici + ana makine** üzerinden yapılır.

Bağlantı yokken tablet ya da telefonda **Ödeme al** düğmesi pasiftir ve altında "Ödeme için ana
bilgisayara bağlantı gerekir" yazar; sipariş cihazda saklanır, bağlantı gelince gönderilir ve ödeme
alınabilir. Ödeme yalnız ana makinede kaydedildiği için çift tahsilat ya da kasa farkı oluşmaz.

### Çakışma olursa — Yönetici Onayı
Nadiren, bir garson çevrimdışıyken bir masa bu sırada kapatılmış olabilir. Böyle bir durumda
sipariş kaybolmaz; **yöneticinin "Offline Onay" ekranına** düşer. Yönetici tek dokunuşla seçer:
- **Yeni adisyon** aç ve kalemleri taşı,
- **Kapalı adisyonu yeniden aç** ve ekle, ya da
- **Reddet.**

Böylece hiçbir sipariş sessizce kaybolmaz.

---

## 9. Yetkiler (Kim Ne Yapar?)

| Rol | Yapabilir |
|-----|-----------|
| **Yönetici (Owner)** | Her şey: ürün/masa/kullanıcı yönetimi, ödeme, kasa, indirim, iade, raporlar, yedek |
| **Garson** | Sipariş alma (masa aç, kalem ekle, not yaz, mutfağa gönder, boş adisyonu kapat). Ödeme/kasa/rapor **göremez** |

---

## 10. Yedekleme

- **Otomatik günlük yedek:** Her gün sabah **06:00**'da sistem kendi kendine yedek alır. O gün
  hiçbir değişiklik olmadıysa yeni yedek alınmaz.
- **Akıllı saklama:** Yedekler sıkıştırılır ve eskileri kendiliğinden silinir. Son 7 günün her
  günü, son 4 haftanın her haftası ve son 6 ayın her ayı için birer yedek kalır; elle alınan ve
  güncelleme öncesi yedekler 90 gün tutulur. En yeni 3 yedek hiç silinmez. Disk dolmak üzereyse
  yalnız en yeni yedekler kalır.
- **Depolama:** **Ayarlar › Depolama** veritabanının ve yedeklerin kapladığı yeri, boş diski ve son
  temizliği gösterir; **Şimdi temizle** ile temizlik elle çalıştırılır. Program her sabah 05:30'da
  eski teknik kayıtları (yazdırma işleri, oturumlar vb.) temizler; satış, kasa ve denetim
  kayıtlarına dokunmaz.
- **Bulut kopyası (isteğe bağlı):** Ayarlardan bir senkron klasörü (OneDrive, Google Drive vb.)
  seçerseniz şifreli yedekler oraya da kopyalanır.
- **Kurtarma anahtarı (mutlaka saklayın):** Yedekler şifrelidir. **Ayarlar › Yedekler › Kurtarma
  anahtarı** bölümünden yönetici şifrenizle anahtarı görüntüleyip **yazdırın veya indirin** ve
  güvenli bir yerde saklayın (bulut klasöründen **ayrı**). Bilgisayar arızalanırsa bulut
  yedeğini yeni bilgisayarda açmak için bu anahtar gerekir; anahtar olmadan yedek açılamaz.
- **Elle yedek / geri yükleme:** **Ayarlar** ekranından istediğiniz an yedek alabilir, listedeki
  bir yedeği ya da **Dosyadan Geri Yükle** ile bulut klasöründeki bir yedek dosyasını
  (`.db.enc`) geri yükleyebilirsiniz. Geri yükleme programı kapatıp açınca uygulanır.

> **Tavsiye:** Bulut kopyasını açın, kurtarma anahtarını kâğıda yazın ve ayda bir yedeği harici
> bir diske alın.

---

### Program güncellemesi — **Ayarlar › Güncelleme**

Program yeni sürümü kendisi denetler ve arka planda indirir; **siz onaylamadan kurmaz**. Yeni sürüm
hazır olunca kartta "Yeni sürüm … kurulmaya hazır" yazar.

1. Gün sonunu yapın: açık adisyon kalmasın, kasayı kapatın. Kart engelleri listeler.
2. Kasa bilgisayarında **Güncellemeyi kur** deyin (tabletten kurulamaz).
3. Program önce şifreli yedek alır, kapanır, güncellenir ve birkaç dakika içinde kendiliğinden yeniden
   açılır. Bu sırada bilgisayarı kapatmayın.

Güncelleme dosyaları imzalıdır; imzası tutmayan dosya kurulmaz. Beklemek istemezseniz kartta
**Şimdi kontrol et** diyebilirsiniz.

---

## 11. Sık Karşılaşılanlar / Sorun Giderme

**Tablet ana makineye bağlanamıyor.**
- Tablet ve ana makine **aynı WiFi'de** mi? Adres doğru mu? Doğru adres ana makinede
  **Ayarlar › Sunucu Adresi** kartında yazar (örnek: `https://192.168.1.20:43128`).
- Ana makinede program açık mı? Windows güvenlik duvarı ilk seferde izin sormuş olabilir — **izin verin.**

**Tablet HTTPS adresinde "bağlantınız gizli değil" uyarısı veriyor.**
- Sertifika o tablete kurulmamış ya da (iPad/iPhone'da) tam güven açılmamış. 6. bölümdeki
  adımları tekrarlayın.

**Mutfak fişi / müşteri fişi çıkmıyor.**
- **Ayarlar › Yazıcılar**'da yazıcı tanımlı mı, **Varsayılan** ya da mutfak/müşteri fişi için
  seçili mi? **Test yazdır** ile deneyin.
- **Son fişler**'de fiş "Yazdırılamadı" görünüyorsa altındaki hata mesajına bakın: yazıcı kapalı,
  kağıt bitmiş ya da Windows'taki adı değişmiş olabilir. Sorunu giderip **Tekrar dene** deyin.

**Program ikinci kez açılmıyor.**
- Program zaten açıktır; ikinci açılış yeni pencere açmaz, açık pencereyi öne getirir. Görev
  çubuğundaki **Adisyon POS** simgesine bakın.

**Program güncellemeden sonra açılmıyor.**
- Program veritabanını güncellemeden önce bir kopyasını programın veri klasöründeki `pre-migrate`
  klasörüne alır (son 3 kopya). Bu klasöre dokunmadan bize ulaşın; verileriniz oradan geri alınır.

**QR menü güncellenmiyor / kartta "Son yayın başarısız" yazıyor.**
- Ana makinenin internet bağlantısını kontrol edin. Program birkaç dakika içinde kendisi yeniden
  dener; bağlantı gelince kartta **Şimdi yayınla** diyebilirsiniz. Satış bundan etkilenmez.
**Yeni adisyon açılmıyor, "Lisans" penceresi çıkıyor.**

- Lisans girilmemiş ya da süresi ve ek süresi dolmuş, veya satıcı lisansı askıya almış. Açık
  hesaplar yine kapatılabilir. Pencereden yeni lisans anahtarını girin ya da satıcınızla görüşün;
  penceredeki iletişim bilgisi satıcınızındır.

- Kartta "Lisansınız QR menüyü içermiyor", "süresi doldu" ya da "askıya alındı" yazıyorsa satıcınızla
  görüşün. Yeni lisansı girdiğinizde ya da askı kalkınca yayın kendiliğinden sürer.
- Kartta "başka bir bilgisayarda açıldı" yazıyorsa QR menü o bilgisayardan yönetiliyor; bu
  bilgisayara almak için **Bu bilgisayarda aç** deyin.

**Müşteri QR'ı okutunca "Bu QR kod geçersiz" görüyor.**
- O masanın kodu yenilenmiş ya da masa silinmiş. **Masa QR kodları** sayfasından o masanın kartını
  yeniden basın.

**Tabletlerin adresi değişiyor.**
- Ana makineye router'dan **sabit IP** verin; adres bir daha değişmez.

**Bağlantı koptu, garson ne yapmalı?**
- Hiçbir şey — sipariş almaya devam etsin. Rozet 🔴 olur, bağlantı gelince kendiliğinden 🟡→🟢 olur
  ve bekleyenler gönderilir.

**Bir sipariş "Offline Onay"a düştü.**
- Yönetici **Masalar** ekranındaki **"Offline Onay"** butonundan ilgili kaydı görüp karar verir
  (bkz. 8. bölüm).

**Ana makineyi değiştireceğim / formatlayacağım / eski bilgisayar arızalandı.**
1. Mümkünse önce güncel bir **yedek alın** (10. bölüm). Arızada bulut klasöründeki son yedeği
   kullanın.
2. Yeni bilgisayara programı kurup açın. İlk açılıştaki kurulum ekranında **"Yedekten geri
   yükleyin"** bağlantısını seçin.
3. Yedek dosyasını (`.db.enc`) seçin ve **kurtarma anahtarını** girin.
4. Programı kapatıp açın; eski kullanıcı adı ve şifrenizle giriş yapın. Tüm veriler geri gelir ve
   kurtarma anahtarınız yeni bilgisayarda da aynı kalır.
5. Tabletlerde sertifikayı yeniden kurun (yeni bilgisayarın sertifikası farklıdır; 6. bölüm).

---

## 12. Özet — Hızlı Başlangıç

1. Ana makineye programı kur → aç → **yönetici hesabı** oluştur.
2. **Kullanıcılar, Masalar, Ürünler**'i tanımla; **Ayarlar**'da işletme bilgilerini gir ve
   yazıcıyı ekleyip test et (5.4).
3. Tablet ve telefonları aynı WiFi'ye bağla; Ayarlar › Sunucu Adresi kartındaki QR kodlarla önce
   **sertifikayı kur**, sonra **adisyonu aç** ve **Uygulamayı yükle** (6. bölüm). WiFi yoksa: 6.
   bölüm › İşletmede WiFi yoksa.
4. Garsonlar **PIN** ile girsin, sipariş almaya başlasın.
5. Ödeme/gün sonu **kasadan**; **bulut yedeğini** aç ve **kurtarma anahtarını** sakla.
6. (İsteğe bağlı) **QR menü:** lisansı gir, ürünlere fotoğraf ve alerjen ekle, **QR menüyü aç**,
   masa QR kartlarını bas (5.5).

> Kurulumdan sonra yazıcı, tablet ve ödeme akışının gerçek cihazlarla çalıştığını adım adım
> doğrulamak için: [`TEST_KONTROL_LISTESI.md`](TEST_KONTROL_LISTESI.md).

Kolay gelsin.
