# LanChat

Hamachi / yerel ag uzerinde calisan, Discord benzeri sesli ve yazili sohbet uygulamasi.
Electron ile yazildi; macOS (arm64/x64) ve Windows (x64) uzerinde calisir.

Merkezi bir servise ihtiyac duymaz: sunucuyu iceren tek bir uygulama vardir,
biriniz "Sunucu kur" der, digerleri onun Hamachi adresine baglanir.

---

## Hizli baslangic

```bash
npm install
npm start
```

Adini yaz, **Otomatik bagla**'ya bas. Uygulama agi tarar:

- Calisan bir sunucu varsa dogrudan katilir
- Yoksa sunucuyu senin bilgisayarinda baslatip icine girer

Yani kimsenin once "sunucu kurmasi" gerekmez; ilk acan kisi kendiliginden
sunucu olur, sonrakiler onu bulur. Ayni agda (LAN, Hamachi, Tailscale)
olmaniz yeterli - ag kesfi UDP yayini ile calisir ve bu aglarin hepsi
yayin trafigini tasir.

Adresi elle girmek istersen **Elle adres gir** bolumunu ac. Port yazilmazsa
`4545` varsayilir.

Sunucuyu Electron olmadan da calistirabilirsin:

```bash
npm run server
```

Ayni agda degilseniz [Arkadasina verdiginde ne yapacak?](#arkadasina-verdiginde-ne-yapacak)
bolumune bak.

---

## Arkadasina verdiginde ne yapacak?

Uygulama **P2P mesh** calisir. Iki seyin ayni anda calismasi gerekir:

1. **Sinyal sunucusuna erisim** - kimin nerede oldugunu soyleyen kucuk sunucu
2. **Eslerin birbirine erisimi** - ses ve ekran sunucudan gecmez, dogrudan akar

Asagidaki secenekler bu ikisini farkli sekillerde cozer.

### A. Tailscale - onerilen (Hamachi'nin modern hali)

Ucretsiz, CGNAT arkasinda bile calisir, kurulum disinda hicbir sey gerektirmez.

1. Ikiniz de [tailscale.com](https://tailscale.com) kurun, ayni hesaba/tailnet'e katilin
2. Her cihaz `100.x.y.z` bir adres alir
3. Uygulamayi acin, **Otomatik bagla**'ya basin

Bu kadar. Uygulama agi tarar, sunucuyu bulur ve girer; bulamazsa sunucuyu
kendisi baslatir. Port yonlendirme, STUN, TURN - hicbiri gerekmez, cunku
Tailscale sanal bir LAN kurar ve uygulama bunu yerel ag gibi gorur.

**Ucretsiz plan 100 cihaza kadar yeter.**

### B. Hamachi

Ayni mantik. 5 kisiye kadar ucretsiz. Adresler `25.x.x.x` ile baslar.
Uygulama Hamachi adreslerini otomatik olarak listenin basina koyar.

### C. VPN olmadan - port yonlendirme

Modem ayarlarina erisimin varsa:

1. Modemde **4545/TCP** portunu bilgisayarina yonlendir
2. **Sunucu kur** sekmesinde bir **sifre belirle** - yoksa adresi bilen herkes girer
3. Arkadasin `senin-genel-ip:4545` yazip sifreyi girsin
4. Ses icin **Ayarlar > Ag ve baglanti > Internet (STUN)** secili olmali (varsayilan)

**Calismayabilecegi durum:** Operatorun CGNAT kullaniyorsa gercek bir genel IP'n
yoktur ve port yonlendirme ise yaramaz. Kontrol: modemin WAN IP'si
`100.64.x.x` - `100.127.x.x` araligindaysa veya "IP adresim ne" sitesinin
gosterdigi adresten farkliysa CGNAT arkandasin. Turkiye'de mobil ve bazi
fiber baglantilarda yaygin. Bu durumda A veya D secenegine gec.

### D. Kucuk bir VPS

Sunucuyu bir sunucuda surekli calistirmak istersen:

```bash
git clone <depo> && cd lanchat && npm install
PORT=4545 node server/standalone.js
```

Herkes VPS'in IP'sine baglanir. Bu **sinyallesmeyi** cozer ama ses hala
dogrudan esler arasinda akar, yani NAT gecisi lazim:

- **STUN** cogu ev baglantisinda yeter (varsayilan acik)
- Iki taraf da **simetrik NAT** arkasindaysa TURN gerekir. Ayni VPS'e `coturn`
  kurup Ayarlar > Ag ve baglanti bolumune adresini gir. TURN, trafigi aktardigi
  icin bant genisligi harcar; yalnizca gerektiginde devreye girer.

### Ozet

| Durum | Yapilacak |
|-------|-----------|
| En az ugras | Tailscale (veya Hamachi) - uygulama degismeden calisir |
| Gercek genel IP'n var | Port yonlendir + sunucu sifresi koy |
| CGNAT arkasindasin | Tailscale, ya da VPS + TURN |
| Sunucu surekli acik kalsin | VPS + `npm run server` |

> **Sunucuyu internete aciyorsan mutlaka sifre koy.** Sifre yoksa adresi bilen
> herkes kanallara girip mesajlari okuyabilir.

---

## Ozellikler

### Metin sohbeti
- Socket.io uzerinden gercek zamanli mesajlasma, birden fazla kanal
- Markdown: `**kalin**`, `*egik*`, `` `kod` ``, ` ```blok``` `, `~~ustu cizili~~`, `||spoiler||`, `> alinti`
- Yanitlama, duzenleme, silme, emoji tepkileri
- Gorsel/dosya ekleme (surukle-birak veya yapistir, en fazla 6 MB)
- Yaziyor gostergesi, okunmamis rozetleri, `@isim` bahsetmeleri ve bildirim sesi
- Mesaj gecmisi sunucuda diske yazilir, yeniden baslatmada korunur

### Sesli sohbet (3-4 kisi)
- **WebRTC P2P tam mesh** - SFU yok, her katilimci digerleriyle ayri baglanti kurar
- Opus codec (WebRTC varsayilani), 48 kHz mono
- **Kisi basi ses seviyesi** (%0-200), sag tik veya kutucuk uzerindeki kaydirici
- Mikrofon kapatma, kulaklik kapatma, bas-konus (global kisayol)
- Konusma halkasi, baglanti kalitesi (RTT / paket kaybi / kbps) gostergesi
- Kopan baglantida ayni odaya otomatik geri donus

### Gurultu engelleme
Uc kademe arasinda anlik gecis yapabilirsin (ses panelindeki kalkan dugmesi
veya Ayarlar > Ses ve mikrofon):

| Mod | Ne yapar |
|-----|----------|
| **Kapali** | Ham mikrofon, en dusuk gecikme |
| **Standart** | WebRTC yerlesik `noiseSuppression` |
| **RNNoise** | AI tabanli (Krisp tarzi). Klavye, fan, arka plan konusmalarini keser |

RNNoise, `AudioWorklet` icinde calisan bir WebAssembly modulu olarak gomuludur
(`src/renderer/vendor/rnnoise/rnnoise.wasm`). Emscripten glue koduna ihtiyac
duymaz; worklet yalnizca uc importu stub'lar. Olculen bastirma: beyaz gurultude
**-66 dB**.

Ek olarak RNNoise'un dondurdugu konusma olasiligi (VAD) ile **konusma kapisi**
kullanilabilir: sessiz aninda mikrofon tamamen kapanir, kelime aralarinda
kesmemesi icin ~200 ms tolerans birakilir.

### Ekran paylasimi
- `getDisplayMedia()` ile ekran veya pencere secimi (onizlemeli kendi secicimiz)
- Kalite on ayarlari: 720p15 / 1080p30 / 1080p60 / 1440p30
- Mesh yapida her izleyiciye ayri akis; **yeniden pazarlik olmadan** (`replaceTrack`)
- Izleyici tarafinda cift tikla tam ekran, "Ayri pencere" ile picture-in-picture
- Windows'ta sistem sesi de paylasilir (macOS isletim sistemi kisiti nedeniyle yalnizca goruntu)

### Arayuz
- Gece / gunduz temasi, 8 vurgu rengi
- Tepsi (tray) ikonundan mikrofon kontrolu, dock rozetinde okunmamis sayisi
- Pencere konumu ve tum ayarlar diske yazilir

---

## Klavye kisayollari

| Islem | Kisayol |
|-------|---------|
| Mikrofon ac/kapat | `Ctrl/Cmd + Shift + M` |
| Kulaklik ac/kapat | `Ctrl/Cmd + Shift + D` |
| Ekran paylas | `Ctrl/Cmd + Shift + E` |
| Ses kanalindan ayril | `Ctrl/Cmd + Shift + H` |
| Ayarlar | `Ctrl/Cmd + ,` |
| Uye listesini gizle | `Ctrl/Cmd + U` |
| Mesaj gonder / alt satir | `Enter` / `Shift + Enter` |
| Son mesaji duzenle | `Yukari ok` |
| Bas-konus | Ayarlardan atanir (varsayilan `F8`) |

---

## Mimari

```
server/index.js          Socket.io sinyal sunucusu + kanal/mesaj deposu (JSON)
src/main/main.js         Electron ana surec: pencere, izinler, ekran kaynaklari,
                         global kisayol, tepsi, gomulu sunucu
src/main/preload.js      contextBridge kopru (nodeIntegration kapali)
src/main/updater.js      electron-updater sarmalayicisi
server/discovery.js      UDP yayin ile ag kesfi (sunucu duyurusu + istemci taramasi)
build/after-pack.js      paketleme sonrasi ad-hoc imzalama
build/icon.png/.icns     uygulama simgesi
src/renderer/
  js/net.js              Socket.io istemcisi, yeniden baglanma, RTT olcumu
  js/rtc.js              WebRTC tam mesh - perfect negotiation, istatistikler
  js/audio.js            Mikrofon zinciri, kisi basi kazanc, cihaz yonetimi
  js/chat.js             Mesaj listesi ve yazi alani
  js/voice.js            Ses paneli, kutucuklar, ekran paylasimi sahnesi
  js/settings.js         Ayarlar penceresi
  worklets/mic-processor.js   RNNoise + kapi + metre (AudioWorklet)
```

### Mesh pazarligi hakkinda not

Her baglantida **tam olarak iki m-line** (audio, video) bulunur ve duzen sabittir.
Bunu saglamak icin transceiver'lari **yalnizca teklifi baslatan taraf** acar;
yanit veren taraf gelen tekliften dogan transceiver'lari `sendrecv`e cevirip
sahiplenir. Iki taraf da kendi transceiver'ini onceden acarsa Chromium bunlari
eslestirmez ve 2 yerine 4 m-line uretir.

Medya duzeni sabit oldugu icin ekran paylasimi acilip kapanirken yalnizca
`replaceTrack` cagrilir - SDP hic degismez, yeniden pazarlik olmaz.

Ayni anda teklif gonderme (glare) durumu "perfect negotiation" deseniyle cozulur;
kibar/kaba rol, iki tarafin socket id'leri karsilastirilarak belirlenir.

LAN ve Hamachi icin STUN/TURN gerekmez; host adaylari yeterlidir.

---

## Test

```bash
npm test              # sunucu protokolu (24 kontrol, Electron gerektirmez)
npm run test:renderer # arayuz + RNNoise WASM zinciri
npm run test:mesh     # uctan uca WebRTC: 2 ve 3 kisilik mesh, ekran paylasimi
npm run shots         # shots/ altina arayuz ekran goruntuleri uretir
```

`test:mesh` ayni surecte uc gercek pencere acar, hepsini yerel sunucuya baglar
ve aralarinda gercekten ses/video akip akmadigini olcer.

---

## Derleme ve dagitim

Projede **native modul yoktur** - RNNoise WebAssembly olarak gomuludur.
Bu yuzden platforma ozel derleme adimi gerekmez, yalnizca paketleme yapilir.

```bash
npm run dist:mac      # macOS (arm64 + x64 dmg)
npm run dist:win      # Windows (x64 nsis)
```

macOS uzerinde Windows paketi uretmek icin Wine gerekir. Kurmak istemiyorsan
asagidaki GitHub Actions yontemini kullan - ikisini de bulutta uretir.

### Imzalama hakkinda

Apple Developer sertifikasi olmadan electron-builder imzalamayi tamamen atlar.
Bu durumda uygulama, Electron ikilisinin "linker-signed" imzasini tasimaya
devam eder; paket icerigi degistigi icin bu imza gecersizdir ve **Apple
Silicon gecersiz imzali ikiliyi calistirmaz** - uygulama aciliste sessizce
oldurulur.

Bu yuzden `build/after-pack.js` kancasi paketlemeden sonra uygulamayi kendi
kimligiyle **ad-hoc** imzalar ve imzayi dogrular. Imza gecersizse derleme durur.

Ad-hoc imza uygulamayi calistirilabilir kilar ama notarize etmez. Indiren
kisinin ilk acilista **sag tik > Ac** demesi gerekir (Windows'ta SmartScreen
icin "Yine de calistir"). Bunu tamamen kaldirmak Apple Developer hesabi
($99/yil) + notarizasyon ister.

---

## Guncelleme sistemi

Her seferinde elle dmg/exe dagitmamak icin `electron-updater` bagli.

### Kurulum (bir kez)

Depo ve yayin akisi kurulu: https://github.com/meosleee/lanchat

`package.json` > `build.publish` bu depoyu gosterir:

```json
"publish": [{ "provider": "github", "owner": "meosleee", "repo": "lanchat", "releaseType": "release" }]
```

### Yeni surum yayinlama

```bash
npm version patch          # 1.0.0 -> 1.0.1
git push --follow-tags
```

`.github/workflows/release.yml` devreye girer: macOS ve Windows makinelerinde
paralel derler, testleri kosar ve GitHub Releases'e yukler (~90 saniye).

> `releaseType: "release"` ayarlanmazsa electron-builder surumu **taslak**
> olarak birakir ve guncelleyici taslak surumleri goremez.

### Kullanici tarafinda ne oluyor

| Platform | Davranis |
|----------|----------|
| **Windows** | Yeni surum bulunca kendiliginden iner. "Kur ve yeniden baslat" dedigi an guncellenir. |
| **macOS** | Haber verilir, indirme sayfasi acilir. Otomatik kurulum **yapilamaz**. |

macOS kisitinin sebebi: Squirrel.Mac, guncellemenin kod imzasinin calisan
uygulamanin "designated requirement"i ile eslesmesini sart kosar. Ad-hoc
imzada bu gereksinim ikilinin cdhash'ine baglidir, yani yeni bir derleme
asla eslesmez. Cozumu Apple Developer sertifikasidir.

Uygulama acildiktan 8 saniye sonra sessizce bir kez bakar; Ayarlar >
Hakkinda bolumunden elle de kontrol edilebilir.

---

## Sorun giderme

**Mikrofon calismiyor (macOS)**
Sistem Ayarlari > Gizlilik ve Guvenlik > Mikrofon icin LanChat'e izin ver.
Uygulama ilk aciliste izin ister; reddedildiyse ayarlardan acip uygulamayi
yeniden baslat.

**Ekran paylasimi siyah geliyor (macOS)**
Sistem Ayarlari > Gizlilik ve Guvenlik > Ekran Kaydi listesine LanChat'i ekle.
Bu izin verildikten sonra uygulamanin yeniden baslatilmasi gerekir.

**Kimse baglanamiyor**
- Sunucuyu kuran kisinin Hamachi adresi `25.x.x.x` ile basliyor mu?
- Windows Guvenlik Duvari `4545` portuna izin veriyor mu? (Ilk calistirmada
  cikan uyarida "Ozel aglar"a izin ver.)
- Adres `IP:PORT` biciminde mi?

**Ses geliyor ama cok bozuk**
Baglanti durumu penceresinden (ses panelindeki "Durum" dugmesi) paket kaybina bak.
Kayip yuksekse ekran paylasimi kalitesini dusur - mesh yapida her izleyiciye ayri
akis gonderildigi icin 3 izleyici yukleme bant genisligini 3 katina cikarir.

**Kendi sesim yankilaniyor**
Ayarlar > Ses ve mikrofon > Yanki engelleme acik olmali. Hoparlor yerine
kulaklik kullanmak en temiz sonucu verir.

---

## Lisans

MIT. RNNoise (Xiph.Org, BSD 3-Clause) ve WebAssembly derlemesi
(@shiguredo/rnnoise-wasm, Apache-2.0) icin bkz.
`src/renderer/vendor/rnnoise/NOTICE.txt`.
