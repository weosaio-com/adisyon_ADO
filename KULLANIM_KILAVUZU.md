# Adisyon POS — Kurulum ve Kullanım Kılavuzu

> Bu belge işletme sahibine ve personele yöneliktir. Teknik bilgi gerektirmez.
> Amaç: sistemi kurmak, ilk ayarları yapmak ve günlük kullanmak.

---

## 1. Sistem Nasıl Çalışır? (Kısaca)

Adisyon POS, kafe/restoran/büfe/pastane için **çevrimdışı çalışabilen** bir adisyon/satış otomasyonudur.

- **Ana makine (kasa bilgisayarı):** Programın kurulu olduğu Windows bilgisayar. Tüm veriler
  (adisyonlar, ürünler, ödemeler, raporlar) **burada** tutulur. İnternete ihtiyaç duymaz.
- **Garson tabletleri / telefonlar:** Aynı WiFi ağına bağlı cihazlar, tarayıcıdan ana makineye
  bağlanır ve sipariş alır. Ayrı program kurmaya gerek yoktur.
- **İnternet gerekmez:** Sistem tamamen yerel ağda (kendi WiFi'niz) çalışır. İnternet yalnızca
  isteğe bağlı **bulut yedeği** için kullanılır.

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

1. Size verilen **kurulum dosyasını** (`Adisyon-POS-Setup.exe`) ana makinede çalıştırın.
2. Kurulum sihirbazını takip edip **Kur** deyin.
3. Kurulum bitince masaüstündeki **Adisyon POS** simgesiyle programı açın.

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

Bu ayarlar bittiğinde sistem satışa hazırdır.

---

## 6. Tabletlerin Bağlanması

Ana makinede **Ayarlar › Sunucu Adresi** kartı, tabletlerde kullanılacak adresleri gösterir
(örnek: `https://192.168.1.20:43128`). Adresleri buradan kopyalayabilirsiniz; ana makinenin IP'si
değişirse güncel adres de burada görünür.

### Önerilen: HTTPS ile (bağlantı koparsa da uygulama açılır)

Her tablette **bir kez** yapılır (Android'de **Chrome** önerilir):

1. Tableti **ana makineyle aynı WiFi ağına** bağlayın.
2. Tabletin tarayıcısında kartta yazan **sertifika indirme adresini** açın
   (örnek: `http://192.168.1.20:43127/api/v1/devices/ca.crt`). `adisyon-pos-ca.crt` dosyası iner.
3. Sertifikayı kurun:
   - **Android:** Ayarlar'da "sertifika" diye aratın › **CA sertifikası yükle** › indirilen
     dosyayı seçin ve uyarıyı onaylayın.
   - **iPad / iPhone:** Ayarlar › **Profil İndirildi** › Yükle. Ardından Ayarlar › Genel › Hakkında ›
     **Sertifika Güven Ayarları** › "Adisyon POS Yerel CA" için tam güveni açın.
4. Tarayıcıda **HTTPS adresini** açın (örnek: `https://192.168.1.20:43128`); garson **PIN** ile girer.
5. Tarayıcı menüsünden **"Ana ekrana ekle"** deyin. Simge oluşur; uygulama tam ekran açılır ve
   **WiFi koptuğunda da açılır.**

> Ana makinenin IP adresi değişse bile sertifikayı yeniden kurmanız gerekmez; yalnızca
> Ayarlar'daki yeni adresi kullanın. Sertifika yalnızca sizin ana makinenize aittir.

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
7. **Gün Sonu:** Gün bitince **Kasa → Gün Sonu (Z raporu)** ile kasa sayımı ve özet alınır.

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

- **Otomatik günlük yedek:** Her gün sabah **06:00**'da sistem kendi kendine yedek alır.
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
3. Tabletleri aynı WiFi'ye bağla, **sertifikayı kur** ve Ayarlar'daki **HTTPS adresini** aç
   (örnek: `https://192.168.1.20:43128`), **ana ekrana ekle** (6. bölüm).
4. Garsonlar **PIN** ile girsin, sipariş almaya başlasın.
5. Ödeme/gün sonu **kasadan**; **bulut yedeğini** aç ve **kurtarma anahtarını** sakla.

> Kurulumdan sonra yazıcı, tablet ve ödeme akışının gerçek cihazlarla çalıştığını adım adım
> doğrulamak için: [`TEST_KONTROL_LISTESI.md`](TEST_KONTROL_LISTESI.md).

Kolay gelsin.
