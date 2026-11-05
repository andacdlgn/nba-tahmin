// NBA Tahmin — her gecenin maçlarına tahmin: kazanan, fark, en skorer.
// Seçimler Firebase'de (Firestore) tutulur, maç verisi ESPN'den canlı okunur,
// geçmiş puanlar GitHub'daki data/ dosyalarından gelir.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, connectAuthEmulator }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch, serverTimestamp, Timestamp, arrayUnion, connectFirestoreEmulator, onSnapshot, orderBy, limit, startAfter, deleteField }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const TZ = "Europe/Istanbul";
const UI_EN = (()=>{ try{ return localStorage.getItem("lang")==="en"; }catch(e){ return false; } })();
const LOC = UI_EN ? "en-US" : "tr-TR";
const Q = new URLSearchParams(location.search);
const ESPN_BASES = Q.get("espn") ? [Q.get("espn")] :
  ["https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"];
// Fark baremleri: MARGINS 3 Kasım 2026'ya kadar, MARGINS2 4 Kasım'dan itibaren.
// RULES2_FROM: yeni kurallar (5 barem, günün oyuncusu +3, yanan banko katlanmaz, yeni soru havuzu)
const MARGINS = ["1-5", "6-10", "11-15", "16+"];
const MARGINS2 = ["1-3", "4-7", "8-12", "13-19", "20+"];
const RULES2_FROM = "20261104";
const PCOL = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)", "var(--p5)"];

const S = {
  cfg:null, db:null, auth:null, uid:null,
  players:{}, order:[],
  tab:"tahmin", day:null, today:null,
  days:{},                // gün -> {games, picks:{gid:{uid:pick}}, daily:{uid:doc}, at}
  rosters:{}, sums:{},    // takım kadroları, maç özetleri (ESPN summary)
  pstats:{}, arch:{games:{}, scores:{days:{}, games:{}, totals:{}, weeks:{}}},
  draft:{}, statFor:null, timer:null, seen:new Set(), sub:"maclar", viewFor:null
};
try{ S.seen = new Set(JSON.parse(localStorage.getItem("seenReveal")||"[]")); }catch(e){}

/* ====================================================== yardımcılar */
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate());
const parseYmd = s => new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)));
const shiftDay = (s, n) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate()+n); return ymd(d); };
// "Bugün" = bu akşamın maçları. Türkiye saatiyle 08.00'e kadar dün gecenin maçları, sonra bu akşamınkiler.
const espnToday = () => new Date(Date.now()-8*36e5).toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"}).replaceAll("-","");
const timeTR = d => d.toLocaleTimeString(LOC,{timeZone:TZ,hour:"2-digit",minute:"2-digit"});
const dayNice = (s, o={day:"numeric",month:"long",weekday:"long"}) => parseYmd(s).toLocaleDateString(LOC,{timeZone:"UTC",...o});
// Takım logoları sitenin kendi logos/ klasöründen gelir (ESPN'e bağımlı değil).
// Yerel dosya yüklenemezse ESPN'in adresi denenir, o da olmazsa takım kısaltması gösterilir.
// Her güncellemede bir artır: sitenin en altında ve Kurallar'da görünür, yeni sürüm yüklendi mi diye bakmak için
const VERSION = "1.21.5";
if(window.BUILD && window.BUILD!==VERSION){ try{ const k="mm:"+VERSION; if(!sessionStorage.getItem(k)){ sessionStorage.setItem(k,"1");
  fetch("./", {cache:"reload"}).catch(()=>{}).finally(()=>location.reload()); throw new Error("sürüm uyuşmazlığı, yenileniyor"); } }catch(e){ if(String(e.message).startsWith("sürüm")) throw e; } }
// Sürüm: 1 = 2026-27 sezonu · ikinci sayı = yeni özellik paketi · üçüncü sayı = düzeltme.
// Her yeni paket CHANGELOG'un başına eklenir; oyunculara bir kez "Yenilikler" penceresi olarak gösterilir.
const CHANGELOG = [
  {v:"1.21.5", d:"5 Kasım 2026", items:["Gecenin sorusu cevaplanınca Evet/Hayır düğmeleri gizleniyor, \"Değiştir\" ile yeniden açılıyor.","Görsel düzeltmeler: Günün oyuncusu ve skorer fotoğrafları kaymıyor, alt menüde simgeler ve yazılar aynı hizada.","Bağlantı yavaşken oturumun kendiliğinden kapanması engellendi."]},
  {v:"1.21.4", d:"5 Kasım 2026", items:["Mobil açılış düzeltmesi: hızlandırma için eklenen telefon önbelleği (servis çalışanı) kaldırıldı; eski ve yeni dosyaların karışıp bazı bölümlerin yüklenmemesine yol açıyordu.","Maç ve puan verisi önce sitenin kendi sunucusundan geliyor (telefonda ek bağlantı yok).","Sakatlıklar ve kadrolar artık açılıştan hemen sonra yükleniyor; dokunma sırasında ekranın donabildiği bir durum düzeltildi."]},
  {v:"1.21.3", d:"5 Kasım 2026", items:["Mobilde (özellikle Safari'de) geç ya da boş açılma düzeltmesi: yavaş veya erişilemeyen veri adresi siteyi artık kilitlemiyor, en fazla 3 sn bekleyip sitenin kendi kopyasına geçiyor.","Açılış takılırsa boş ekran yerine \"Tekrar dene\" düğmesi çıkıyor."]},
  {v:"1.21.2", d:"4 Kasım 2026", items:["Davet mesajında bu gecenin ilk kilit saati ve deneme haftası bilgisi yazıyor.","Mail adresi onaylanmamış olanlara daha açık bir hatırlatma: neden gerekli olduğu ve kodun nasıl girileceği."]},
  {v:"1.21.1", d:"4 Kasım 2026", items:["Profil → Ayarlar'ın en altında \"Profilimi sil\": hesabını ve bütün verini kalıcı olarak silebilirsin.","Giriş ekranında \"Giriş yapan\" kartındaki fotoğraf artık yuvarlak, basık görünmüyor."]},
  {v:"1.21.0", d:"4 Kasım 2026", items:["Üst çubukta İstekler düğmesi: sorun, istek, öneri ya da soru yaz; doğrudan lig yöneticisinin mailine gider, yönetici yanıtlayınca cevap senin mailine gelir."]},
  {v:"1.20.0", d:"4 Kasım 2026", items:["Otomatik tahmin (eski adıyla yedek tahmin) kayıt sırasında zorunlu bir seçim oldu; Profil → Ayarlar'ın en üstünde açık/kapalı durumu görünüyor.","Kurallar ve Puanlama rehberi baştan gözden geçirildi: otomatik tahmin, deneme haftası, sohbet, mail ve konferans sıralaması puanları eklendi; playoff'ta neyin katlandığı netleşti."]},
  {v:"1.19.5", d:"4 Kasım 2026", items:["Düzeltme: deneme haftası penceresindeki \"Anladım, oynamaya başla\" düğmesi pencereyi kapatmıyordu.","Bir pencere kapatılamaz durumda kalmasın diye her yeni pencere kilitsiz açılıyor."]},
  {v:"1.19.4", d:"4 Kasım 2026", items:["Kayıtta mail adresi artık atlanamıyor; onay kodu istersen sonra Profil → Ayarlar'dan girilebiliyor. Kod girilene kadar hiçbir mail gönderilmiyor.","Favori takım adımında Takımım sekmesi anlatılıyor.","Oyuncu adlarında son ek düzeltmesi: \"III\" yerine \"Murphy III\", \"Jr.\" yerine \"Jackson Jr.\" yazıyor."]},
  {v:"1.19.3", d:"4 Kasım 2026", items:["Güvenlik sorusu artık \"en sevdiğin\" takım ve oyuncuyu sormuyor: tahmin edilemesin diye seninle alakasız bir gizli takım ve gizli oyuncu seçmen isteniyor."]},
  {v:"1.19.2", d:"4 Kasım 2026", items:["Üstteki puan panosu az oyuncu varken de sıralama listesi olarak görünüyor (iki kişilik VS görünümü kalktı)."]},
  {v:"1.19.1", d:"4 Kasım 2026", items:["Deneme haftası boyunca en üstte sabit, kapatılamayan bir \"DENEME HAFTASI\" şeridi var; asıl lige kaç gün kaldığını yazıyor, dokununca açıklama açılıyor."]},
  {v:"1.19.0", d:"4 Kasım 2026", items:["Deneme haftası: 4–8 Kasım deneme ligi. Puanlar 9 Kasım pazartesi kendiliğinden sıfırlanır, profiller kalır; deneme tablosu Geçmiş ligler'e geçer. Üstte şerit ve ilk girişte açıklama penceresi var, 9 Kasım'da \"Lig başladı\" penceresi çıkar.","Düzeltme: lig sıfırlanınca önceki uzun vade turlarının puanları artık yeni lige taşınmıyor."]},
  {v:"1.18.0", d:"4 Kasım 2026", items:["Sohbette yanıtla: mesajın altındaki Yanıtla ile cevap ver; alıntıya dokununca asıl mesaja gidilir.","@etiketleme: @ yazınca oyuncu listesi açılır. Seni anan ya da sana yanıt veren mesaj vurgulu görünür, baloncukta @ işareti çıkar.","Yazıyor… göstergesi, gönderdikten sonra 2 dakika içinde düzenleme, tıklanabilir bağlantılar.","Yönetici bir mesajı sohbetin üstüne sabitleyebilir.","🔔 düğmesiyle sohbeti sessize al: baloncukta yalnızca seni anan mesajlar sayılır."]},
  {v:"1.17.2", d:"4 Kasım 2026", items:["Sohbette her mesaj grubunun üstünde gönderenin adı ve avatarı görünüyor; kendi mesajlarında \"(sen)\" yazıyor.","Sohbetteki 5 saniyede bir mesaj sınırı kalktı."]},
  {v:"1.17.1", d:"4 Kasım 2026", items:["Sohbette mesaj yokken görünen gereksiz \"Daha eski mesajlar\" düğmesi kalktı; sohbet açılamazsa açık bir uyarı çıkıyor."]},
  {v:"1.17.0", d:"4 Kasım 2026", items:["Lig sohbeti: sağ alttaki baloncuktan herkesin yazdığı ortak sohbete gir. Mesajlar canlı akar, okunmamış mesaj sayısı baloncukta görünür.","Mesajlara emoji tepkisi bırakabilir, kendi mesajını silebilirsin. Mesaj en fazla 500 karakter.","Sert küfür koruması: küfürler, kısaltmaları (amk, aq, oç, sg, mk…) ve harf oyunlarıyla yazılmış hâlleri sohbette ve maç yorumlarında yazılamıyor."]},
  {v:"1.16.1", d:"4 Kasım 2026", items:["Üst çubukta Davet et düğmesi: sana özel davet linkini gösteriyor; tek dokunuşla kopyala, WhatsApp'ta gönder ya da paylaş."]},
  {v:"1.16.0", d:"4 Kasım 2026", items:["Üst çubukta Kurallar'ın yanında ayrı bir Puanlama düğmesi: puan rehberi tek dokunuşla açılıyor.","Gecenin sorusu yenilendi (5 Kasım'dan itibaren): sorudaki sayı gecenin maç sayısına göre seçiliyor, cevap yaklaşık yarı yarıya. \"Ev sahipleri bütün maçlarını kazanır mı?\" gibi neredeyse kesin sorular kalktı."]},
  {v:"1.15.0", d:"4 Kasım 2026", items:["Profil analizi: sayıyla fark tahmininde ±3 tutturma oranı, ortalama şaşma ve farkı az mı çok mu tahmin ettiğin.","Puanların nereden geldi ve sezon özeti: sürpriz ekini, devamlılık bonusunu ve yedek tahmini ayrı gösteriyor.","Tahminler'de gece özeti: Gecenin sürprizi ve onu bilenler.","Alt bilgideki puan özeti güncellendi, puanlama rehberine bağlantı."]},
  {v:"1.14.1", d:"4 Kasım 2026", items:["Puanlama rehberi: bütün puan kuralları örnekleriyle tek yerde (Kurallar'dan da açılır).","Fark kaydırıcısı boşken de diğerleriyle aynı görünüyor."]},
  {v:"1.14.0", d:"4 Kasım 2026", items:["Sürpriz kademesi: ESPN'in şans vermediği takımı bilirsen kazanan puanı +2 (%33 ve altı) ya da +3 (%20 ve altı). Banko 2 kat, kazanan puanı en fazla 4.","Takım düğmelerinde ESPN'in maç önü kazanma şansı ve sürpriz puanı görünüyor."]},
  {v:"1.13.0", d:"3 Kasım 2026", items:["Fark artık kaydırıcıyla sayı olarak seçiliyor; gerçek farka 3 sayı ya da daha yakınsan +1.","Yedek tahmin (isteğe bağlı): unuttuğun gecede ESPN favorileri girer, her 2 doğru kazanan 1 puan.","Devamlılık bonusu: haftada en az 4 gece oynayana +2.","Hiç tahmin yapmamış oyunculara ilk maçta adım adım rehber.","Yönetim paneli: her oyuncunun oynadığı gece sayısı ve son girişi."]},
  {v:"1.12.0", d:"3 Kasım 2026", items:["Daha hızlı açılış: sitenin kendi dosyaları telefondaki kopyadan anında açılıyor, yeni sürüm arka planda iniyor.","Sakatlık listesi, kadrolar ve oyuncu listesi ilk ekran çizildikten sonra yükleniyor.","Fotoğraf sunucusuna ve sitenin koduna önceden bağlanılıyor."]},
  {v:"1.11.3", d:"3 Kasım 2026", items:["Görsel hizalar: kürsüde isimler aynı hizada, takım liderleri kartları eşit boyda, oyuncu arama seçicileri ekrandan taşmıyor, filtre düğmeleri alt satıra geçiyor, puan şeridi telefonda kesilmiyor, puan tablosunda takım adları iki satıra kadar görünüyor."]},
  {v:"1.11.2", d:"3 Kasım 2026", items:["Telefonda dokunuşlar düzeldi: canlı veri gelince ekran parmağının altında değişmiyor, çubuklar yanlışlıkla açılıp kapanmıyor, hızlı dokunuşlar yakınlaştırmaya dönüşmüyor.","İnce şeritte önündeki ve arkandaki rakiple puan farkı."]},
  {v:"1.11.1", d:"3 Kasım 2026", items:["Avatar artık yalnızca basketbolcu fotoğrafı olabiliyor; profilde istediğin oyuncuyu arayıp seçebilirsin.","Diğer sekmelerdeki ince puan şeridi daha anlaşılır: lider, senin sıran ve puanın."]},
  {v:"1.11.0", d:"3 Kasım 2026", items:["Gecenin kazananı gece bitince sahneye çıkıyor, puan tablosunda satırı parlıyor.","Sıralama: Sezon yarışı — gece gece puanlarla çubuk yarışı, Oynat'a bas.","Oyuncu kartı: takım logosu, son 10 maçın sayı grafiği, 10 maçlık günlük, sakatlık notu ve ligde kaç kez skorer seçildiği.","Boş ekranlar çizimli ve yönlendiren hale geldi.","Rozetler: ilerleme çubuğu ve ligde kaç kişide olduğu."]},
  {v:"1.10.3", d:"3 Kasım 2026", items:["Takım sayfasındaki son maç tarihleri sitenin geri kalanı gibi ABD tarihine göre.","Gece kazananı yıldızının rengi her avatarda okunur."]},
  {v:"1.10.2", d:"3 Kasım 2026", items:["İngilizce arayüzde kalan Türkçe metinler çevrildi."]},
  {v:"1.10.1", d:"3 Kasım 2026", items:["Renk düzeltmelerinin herkese yüklenmesi için sürüm yenilendi; sakatlık rozetleri anlamına göre renkli."]},
  {v:"1.10.0", d:"3 Kasım 2026", items:["Mobilde aşağı kaydırınca üst çubuk ve alt menü saklanıyor, yukarı kaydırınca geri geliyor.","Puan tablosu tam haliyle Bu Gece ve Sıralama'da; diğer sekmelerde tek satırlık şerit, dokununca açılıyor.","İngilizce çeviriler ayrı dosyada; Türkçe kullananlar için site daha hafif.","Stil dosyası ve yazı tipleri sadeleşti.","Renk zıtlığı: takım temasının vurgu rengi ve oyuncu renkleri her temada okunur hale getirildi."]},
  {v:"1.9.3", d:"3 Kasım 2026", items:["Mobilde dokunma alanları büyüdü (gün okları, isimler, alt bilgi bağlantıları).","Günün oyuncusu ve gecenin sorusunda seçmeyenler tek satırda.","NBA sekmesinde son açtığın bölüm hatırlanıyor.","Takım logoları daha hafif, sayfa daha hızlı açılıyor."]},
  {v:"1.9.2", d:"3 Kasım 2026", items:["1.9.1'deki açılmama hatası düzeltildi."]},
  {v:"1.9.1", d:"3 Kasım 2026", items:["Seçili düğmelerde okunmayan yazı rengi düzeldi.","NBA → Oyuncu ara: istediğin istatistiğe göre sırala; takım, konferans, çaylak ve bu gece oynayanlar filtreleri.","Sezon ödülleri gerçek adlarıyla; finalistler artık Eastern ve Western Conference Champion.","Uzun vadeden konferans sıralaması kaldırıldı.","Kurallar ve açıklamalar son değişikliklere göre güncellendi."]},
  {v:"1.9.0", d:"3 Kasım 2026", items:["Sakatlıklar artık sitenin her yerinde aynı kaynaktan geliyor; ESPN'in notunda \"oynamayacak\" yazan oyuncu da oynamıyor görünür.","Uzun vadeye NBA şampiyonu (+10) ve finalistler (+5) eklendi.","Üstte küçük arama: kişi, takım ya da oyuncu.","Maç kartında oynamayanların adları ve iki takımın son karşılaşması.","Profilde \"Puanların nereden geldi\" ve \"Sezon özeti\".","NBA → Oyuncular: iki oyuncuyu karşılaştır.","Sıralama: Sezon arşivi.","Takımım: kadroyu istediğin istatistiğe göre sırala."]},
  {v:"1.8.0", d:"3 Kasım 2026", items:["Yeni sekme: Takımım. Favori takımının maçları, takvimi, kadrosu, sakatları, takım liderleri ve ligin o takımdaki tahmin karnesi tek yerde.","Formda olanlar: sayı, ribaund, asist ve verimlilik kategorileri.","Takvim NBA sekmesinden Takımım'a taşındı."]},
  {v:"1.7.0", d:"3 Kasım 2026", items:["Gecenin sorusu artık 21 soruluk havuzdan geliyor; aynı soru 3 hafta boyunca tekrar etmiyor, bazıları zor (ör. biri 45 atar mı?).","Günün oyuncusu +3.","2 kat puanlı maçlarda yanan banko yine -1.","Fark baremleri: 1-3 · 4-7 · 8-12 · 13-19 · 20+.","Eşit puanda sıra: önce gece birinciliği, sonra kazanan puanı.","Ayın tahmincisi ödülü +1.","Hepsi 4 Kasım gecesinden itibaren geçerli; eski geceler değişmedi."]},
  {v:"1.6.1", d:"3 Kasım 2026", items:["NBA sekmesindeki aylık takvimin bozuk görünümü düzeldi."]},
  {v:"1.6.0", d:"3 Kasım 2026", items:["Mail onayı artık zorunlu değil; onaylamadan da oynayabilirsin, ama site ara ara hatırlatır.","Onay ve şifre sıfırlama kodları 3 saat geçerli.","Mailler sadeleşti ve azaldı: günde en fazla bir özet maili gelir (gerekirse bir de acil sakatlık uyarısı)."]},
  {v:"1.5.2", d:"3 Kasım 2026", items:["Puan durumunda takım adları üstte ve büyük, gerçek isimler altta.","Grafiklerde berabere olanların isimleri ve puanları artık üst üste binmiyor."]},
  {v:"1.5.1", d:"3 Kasım 2026", items:["İngilizce arayüz büyük ölçüde tamamlandı: tarihler, kayan şerit, gecenin manşeti, hata mesajları ve açıklamalar da çevriliyor."]},
  {v:"1.5.0", d:"3 Kasım 2026", items:[
    "Tahminler sekmesinin üstünde gecenin özeti: en iyi tahmin, en çok yanılan, en çok seçilen takım ve bankoların durumu.",
    "Çoğunluktan ayrıldığın maçlarda \"Sen tek başına … dedin\" ya da \"Azınlıktasın\" etiketi.",
    "Telefonda maç kutuları alt alta; kazanan taraf üstte geniş.",
    "Maç başlığına dokununca kutu skoru açılıyor; takım kutularında oyuncular aldıkları puana göre sıralı.",
    "Tarih oklarıyla önceki gecelerin tahminleri gezilebiliyor.",
    "Tahmin geçmişi ayrıntılandı: seriler, banko karnesi, en iyi gece, gece gece puan grafiği, takım filtresi, gece gece gruplama ve maç sonuçlarıyla ESPN favorisi."]},
  {v:"1.4.1", d:"3 Kasım 2026", items:[
    "Tahminler sekmesinde her maçın altında farkın kaç sayı ve hangi baremde bittiği ile en skorer büyük yazıyla görünüyor.",
    "Herkesin tahmin geçmişi: Tahminler sekmesinde bir oyuncuya ya da profilde İstatistik'teki düğmeye dokun. Özet ve Bildikleri / Bilemedikleri / Bankolar filtreleri var."]},
  {v:"1.4.0", d:"3 Kasım 2026", items:[
    "İngilizce arayüz: sayfanın altındaki ya da giriş ekranındaki \"English\" ile geçebilirsin (çoğu ekran çevrildi).",
    "Sayfanın altında \"Sorun bildir\": yazdığın mesaj sürüm ve cihaz bilgisiyle yöneticiye iletilir.",
    "Yönetim panelinde oyuncu durumu (kim kaç gündür oynamıyor, mail onayı, takım adı) ve gelen sorun bildirimleri.",
    "Lig sıfırlanırken döneme ad verilebiliyor; arşive puanlar, ödüller ve uzun vade puanları da kaydediliyor.",
    "Lig verileri her hafta otomatik olarak yedekleniyor."]},
  {v:"1.3.0", d:"3 Kasım 2026", items:[
    "Uzun vadeye konferans sıralaması eklendi: Doğu ve Batı'nın ilk 6'sını sırala (tam yer +2, bir sıra şaşma +1). 1 Aralık'ta kilitlenir.",
    "Lig ödülleri: her ay sonunda Ayın tahmincisi (+1), Banko ustası, Sürpriz avcısı, Skorer ustası ve Fark ustası (+2'şer) seçilir; puanlar sıralamaya eklenir.",
    "Ödüller yarışma programı gibi bir tören ekranıyla tek tek açılır; Sıralama sekmesinden tekrar izlenebilir."]},
  {v:"1.2.0", d:"3 Kasım 2026", items:[
    "Profil → İstatistik'te kişisel analiz: en iyi ve en kötü bildiğin takımlar, ev/deplasman isabetin, fark aralıkların, son bankoların.",
    "Oyuncu kartında \"Karşılaştır\": iki oyuncuyu sayı, ribaund, asist, isabet yüzdeleri ve son 5 maçla yan yana gör.",
    "Bu Gece sekmesinde canlı akış: çeyrek sonları, son 2 dakikada yakın maçlar, uzatmalar ve biten maçlar.",
    "NBA sekmesine takvim eklendi: favori takımının maçları, NBA Kupası geceleri ve uzun vade kilit günleri."]},
  {v:"1.1.0", d:"3 Kasım 2026", items:[
    "Kilit açılınca her maçta kimin hangi takımı seçtiği yüzde olarak görünüyor; azınlıkta kalıp bilenler öne çıkıyor.",
    "Profilden bir oyuncuyu rakibin yapabilirsin: sıralamada ve maç kartlarında onunla aranızdaki fark görünür.",
    "Sıralama sekmesine gece gece sıralama grafiği eklendi.",
    "İstatistik sekmesinde ESPN'in favorisiyle kendi tahminlerini karşılaştırabilirsin.",
    "Maç önü ayrıntılarına iki takımın bu sezonki maçları ve sayı ortalamaları eklendi.",
    "Sürüm numaraları artık 1.1.0 biçiminde; her yenilik burada listelenir."]},
  {v:"1.0.0", d:"Ekim–Kasım 2026", items:["Günlük tahminler, uzun vade, NBA Kupası, Tahminler sekmesi ve daha önceki her şey (eski v1–v33 sürümleri)."]},
];
// İstekler: sorun, istek / öneri, soru → reports/{id}; arka plan görevi yöneticinin mailine yollar (yanıt, bildirenin onaylı adresine gider)
const REP_KINDS = [["sorun","🐞 Sorun / hata"],["istek","💡 İstek / öneri"],["soru","❓ Soru"],["diger","💬 Diğer"]];
function openReport(kind){
  S.repKind = kind || S.repKind || "";
  const mailOk = S.contact?.verified && S.contact?.email;
  openSheet(`<h3 id="shTitle">İstekler ve sorunlar</h3><p class="muted">Bir sorun mu var, bir şey mi istiyorsun, aklına bir soru mu takıldı? Yaz, doğrudan lig yöneticisinin mail kutusuna gider. ${mailOk?`Cevap <b>${esc(S.contact.email)}</b> adresine gelebilir.`:`Mail adresini onaylarsan cevap doğrudan mailine gelebilir.`}</p>
    <div class="rep-k">${REP_KINDS.map(([k,l])=>`<button type="button" data-rk="${k}" aria-pressed="${S.repKind===k}">${l}</button>`).join("")}</div>
    <textarea id="repText" class="adm-in" rows="6" maxlength="1000" placeholder="ör. Uzun vade sekmesinde oyuncu seçince ekran donuyor · ör. Maç sonu skor kartı sohbete düşsün"></textarea>
    <small class="muted" id="repCnt" style="display:block;text-align:right">0/1000</small>
    <p class="muted" style="font-size:12.5px;margin:4px 0 0">Sürüm, cihaz ve açık sekme bilgisi sorunu bulmak için otomatik eklenir.</p>
    <p class="err" id="repErr"></p><button class="btn-primary" id="repSend" type="button">Gönder</button>`);
  $("#sheet .rep-k").onclick=e=>{ const b=e.target.closest("[data-rk]"); if(!b) return; S.repKind=b.dataset.rk; $$("#sheet [data-rk]").forEach(x=>x.setAttribute("aria-pressed", x===b)); $("#repErr").textContent=""; };
  $("#repText").oninput=()=>{ $("#repCnt").textContent=`${$("#repText").value.length}/1000`; };
  $("#repSend").onclick=async()=>{ const t=$("#repText").value.trim();
    if(!S.repKind) return $("#repErr").textContent="Önce ne tür bir mesaj olduğunu seç.";
    if(t.length<5) return $("#repErr").textContent="Biraz daha ayrıntı yaz.";
    if(chatProblem(t)) return $("#repErr").textContent="Mesajda küfür ya da hakaret var, gönderilmedi.";
    $("#repSend").disabled=true;
    try{ await setDoc(doc(S.db,"reports",randHex(10)), {uid:S.uid, kind:S.repKind, text:t, v:VERSION, tab:S.tab||"", ua:navigator.userAgent.slice(0,180), w:innerWidth, at:serverTimestamp()});
      S.repKind=""; closeSheet(); toast("Teşekkürler, mesajın yöneticiye iletildi."); }
    catch(e){ $("#repErr").textContent="Gönderilemedi, tekrar dene."; $("#repSend").disabled=false; } };
}
function openNews(all=false){
  const list = all ? CHANGELOG : CHANGELOG.slice(0,1);
  openSheet(`<h3 id="shTitle">Yenilikler</h3>${list.map(c=>`<div class="news"><div class="news-h"><b>Sürüm ${c.v}</b><small>${c.d}</small></div><ul>${c.items.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></div>`).join("")}
    ${all?"":`<button class="linkish" id="newsAll" type="button">Önceki sürümler</button>`}<button class="btn-primary" id="newsOk" type="button" style="margin-top:10px">Tamam</button>`);
  $("#newsOk").onclick=()=>closeSheet(); $("#newsAll")?.addEventListener("click", ()=>openNews(true));
}
function maybeNews(){
  const seen=lsGet("newsSeen");
  if(!seen){ lsSet("newsSeen", VERSION); return; }   // ilk kez gelen için gösterme
  if(seen===VERSION) return;
  const go=(n=0)=>{ if(!$("#sheet").classList.contains("hide") || S.onboard || S.obStep){ if(n<40) setTimeout(()=>go(n+1),3000); return; }
    lsSet("newsSeen", VERSION); openNews(); };
  setTimeout(go, 3000);
}
const LOGO_SMALL = a => `logos/${String(a).toLowerCase()}.png`;
const LOGO_FULL  = a => `https://a.espncdn.com/i/teamlogos/nba/500/${String(a).toLowerCase()}.png`;
document.addEventListener("error", e => {
  const img = e.target;
  if(!(img instanceof HTMLImageElement)) return;
  if(img.classList.contains("av-img") && !img.classList.contains("logo")){ img.closest(".av")?.classList.remove("has-img"); img.remove(); return; }
  const src = img.getAttribute("src") || "";
  const local = /^logos\/([a-z]+)\.png$/i.exec(src);
  if(local){ img.src = LOGO_FULL(local[1]); return; }
  const espn = /teamlogos\/nba\/500\/([a-z]+)\.png/i.exec(src);
  if(espn){
    const b = document.createElement("span");
    b.className = "logo-fb"; b.textContent = espn[1].toUpperCase();
    b.style.width = (img.width||28)+"px"; b.style.height = (img.height||28)+"px";
    img.replaceWith(b); return;
  }
  // oyuncu fotoğrafı vb. yüklenemezse boş gri kutu kalsın
  img.removeAttribute("src"); img.style.visibility = "hidden";
}, true);
const esc = s => String(s??"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const bucket = m => m<=5?"1-5":m<=10?"6-10":m<=15?"11-15":"16+";
const bucket2 = m => m<=3?"1-3":m<=7?"4-7":m<=12?"8-12":m<=19?"13-19":"20+";
const isRules2 = g => g.day ? g.day>=RULES2_FROM : g.start>=PERGAME_FROM;
const marginsFor = g => isRules2(g) ? MARGINS2 : MARGINS;
const bucketOf = (g, m) => isRules2(g) ? bucket2(m) : bucket(m);
// tahmindeki barem hangi düzendeyse onunla karşılaştır (yeni kurala geçişte eski seçimler bozulmasın)
const MARGIN_TOL = 3, MARGIN_MAX = 40;
const marginHit = (label, m) => /^\d+$/.test(String(label)) ? (+label>=MARGIN_MAX ? m>=MARGIN_MAX-MARGIN_TOL : Math.abs(+label-m)<=MARGIN_TOL) : MARGINS2.includes(label) ? bucket2(m)===label : bucket(m)===label;
const dpValue = day => day>=RULES2_FROM ? 3 : 2;
// Sürpriz kademesi (4 Kasım 2026'dan itibaren): ESPN'in maç önü şansı %20 ve altı +3, %33 ve altı +2, üstü +1.
// Banko bunu 2 katına çıkarır; kazanan puanı (kupa/playoff katıyla birlikte) en fazla 4 olur. scripts/sync.py ile aynı.
const TIER_FROM = "20261104", WIN_CAP = 4;
function oddsTag(g, abbr){
  const h=homeProb(g); if(h==null || isNaN(h)) return "";
  const hp=Math.round(h*100), p=abbr===g.home.abbr ? hp : 100-hp, t=tierOf(g, abbr);
  return `<span class="odds ${t>1?"t"+t:""}" title="ESPN maç önü kazanma şansı"><b>%${p}</b>${t>1?`<em>+${t}</em>`:""}</span>`;
}
function homeProb(g){
  if(g.hp!=null) return +g.hp;
  const s=S.sums?.[g.id]?.data; const pr=s?.predictor?.homeTeam?.gameProjection;
  if(pr!=null && pr!=="") return +pr/100;
  const wp=s?.winprobability?.[0]?.homeWinPercentage; return wp!=null ? +wp : null;
}
const gameDayOf = g => g.day || ymd(new Date(new Date(g.start).getTime()-8*36e5));
function tierOf(g, abbr){
  if(gameDayOf(g) < TIER_FROM) return 1;
  const h=homeProb(g); if(h==null || isNaN(h)) return 1;
  const p = abbr===g.home.abbr ? h : 1-h;
  return p<=0.20 ? 3 : p<=0.33 ? 2 : 1;
}
const slug = s => s.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, c => ({ç:"c",ğ:"g",ı:"i",ö:"o",ş:"s",ü:"u"}[c])).replace(/[^a-z0-9]/g, "");
const weekKey = s => { const d = parseYmd(s); const w = (d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-w); return ymd(d); };
// 4 Kasım 2026 gecesinden itibaren her maçın tahmini kendi maçı başlamadan 10 dk önce kilitlenir (rakiplerin
// seçimi o an açılır). Banko, günün oyuncusu ve gecenin sorusu gecenin ilk maçından 10 dk önce kilitlenir.
// g.lock = bu maçın kilidi, g.nightLock = gecenin kilidi, g.lockBase = Firestore'a yazılan "start" (kural 10 dk düşer).
const LOCK_GAP = 10*6e4, PERGAME_FROM = Date.UTC(2026,10,4,12), GAP_FROM = Date.UTC(2026,10,3,12);
const started = g => g.state !== "pre" || Date.now() >= g.lock.getTime();
// NBA Kupası maçları 4 Kasım gecesinden itibaren 2 kat puan (playoff da 2 kat)
const CUP2X_FROM = "20261104";
const multOf = g => g.seasonType===3 ? 2 : (g.cup && (g.day ? g.day>=CUP2X_FROM : g.start>=PERGAME_FROM)) ? 2 : 1;
const CUP_STAGE = {"Group Play":"Grup maçı","Quarterfinal":"Çeyrek final","Quarterfinals":"Çeyrek final","Semifinal":"Yarı final","Semifinals":"Yarı final","Championship":"Final"};
const cupStageTR = st => CUP_STAGE[st] || (st ? st : "Kupa maçı");
const cupTag = g => g.cup ? `<span class="cup-tag">${ICON.cup}NBA Kupası · ${esc(cupStageTR(g.cupStage))}${multOf(g)===2?" · <b>2× puan</b>":""}</span>` : "";
const lockedMsg = g => g.perGame ? "Bu maçın tahmini kilitlendi (maçtan 10 dk önce)." : "Tahminler kilitlendi.";
// renk katılma sırasına sabit: herkes aynı oyuncuyu aynı renkte görür
const PKEYS = ["p0","p1","p2","p3","p4","p5","p6","p7","p8","p9"];
const col = uid => { const c=S.players[uid]?.color; return PKEYS.includes(c) ? `var(--${c})` : PCOL[Math.max(0, (S.colorOrder||S.order).indexOf(uid)) % PCOL.length]; };
// eski kayıtlarda küçük harfle başlayan adlar ekranda büyük harfle görünsün
const pname = uid => { const n=S.players[uid]?.name; return n ? n.charAt(0).toLocaleUpperCase("tr")+n.slice(1) : "?"; };
function toast(msg, ms=2600){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hide"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add("hide"), ms); }
// Her istek en fazla ms kadar bekler; takılan bağlantı (ör. mobil operatörde yavaş ya da engelli bir adres) siteyi kilitlemesin
async function getJSON(url, ms=10000){
  const ac = typeof AbortController==="function" ? new AbortController() : null, t = ac ? setTimeout(()=>ac.abort(), ms) : 0;
  try{ const r = await fetch(url, {cache:"no-store", ...(ac?{signal:ac.signal}:{})}); if(!r.ok) throw new Error(r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(r=>setTimeout(()=>r("timeout"), ms))]);
async function espn(path){
  let err;
  for(const b of ESPN_BASES){ try{ return await getJSON(b+path); }catch(e){ err=e; } }
  throw err;
}

// Arayüz simgeleri: hepsi aynı çizgi tarzında (emojiler yalnızca avatar, tepki ve şeritte)
const IC = (d, cls="ic") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  cup: IC('<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>', "ic ic-s"),
  shield: IC('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>'),
  bolt: IC('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  cards: IC('<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h9"/>'),
  list: IC('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  tools: IC('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  link: IC('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  megaphone: IC('<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 8a5 5 0 0 1 0 8"/>'),
  mail: IC('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  palette: IC('<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.5-.3-.9-.3-1.4 0-.8.6-1.5 1.5-1.5H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
  star: IC('<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
  question: IC('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/>'),
  download: IC('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  medal: IC('<circle cx="12" cy="15" r="5"/><path d="M8.5 11L6 3h4l2 5 2-5h4l-2.5 8"/>'),
  home: IC('<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>', "ic ic-s"),
  plane: IC('<path d="M10 14l-6 2 1 2 6-1 3 5h2l-1-6 5-2a1.5 1.5 0 0 0-1-2.8L14 13l-4-8H8l2 7"/>', "ic ic-s"),
  chev: IC('<path d="M9 6l6 6-6 6"/>', "ic ic-s"),
  edit: IC('<path d="M4 20h4L19 9l-4-4L4 16z"/>', "ic ic-s"),
};
/* ====================================================== dil (İngilizce) */
// Site Türkçe yazılır; İngilizce seçilirse ekrandaki metinler bu sözlükle çevrilir (tam eşleşme + kalıplar).
// Sözlükte olmayan metin Türkçe kalır. Yeni metin eklerken buraya da eklemek yeterli.
const LANG = (()=>{ try{ return localStorage.getItem("lang")||"tr"; }catch(e){ return "tr"; } })();
function setLang(l){ try{ localStorage.setItem("lang", l); }catch(e){} location.reload(); }
// İngilizce sözlük i18n/en.json'da; yalnızca İngilizce seçilince yüklenir.
const EN = UI_EN ? await fetch("i18n/en.json?v="+(window.BUILD||"")).then(r=>r.json()).catch(()=>({})) : {};
const EN_RX = [
  [/^Kilide (\d+) sa (\d+) dk kaldı$/, "$1 h $2 min to lock"], [/^Kilide (\d+) dk kaldı$/, "$1 min to lock"],
  [/^Kilide (\d+) gün (\d+) sa$/, "$1 d $2 h to lock"], [/^Kilide (\d+) sa$/, "$1 h to lock"],
  [/^(\d+) maç eksik$/, "$1 games missing"], [/^(\d+) dk sonra$/, "in $1 min"], [/^(\d+) saat sonra$/, "in $1 h"], [/^(\d+) gün sonra$/, "in $1 days"],
  [/^(\d+)\. sırada · (\d+) puan/, "#$1 · $2 pts"], [/^(\d+) puan$/, "$1 pts"], [/^\+(\d+) puan$/, "+$1 pts"], [/^(\d+) maç$/, "$1 games"],
  [/^(.+) gecesi$/, "night of $1"], [/^(\d+) oyuncunun seçimi$/, "picks of $1 players"], [/^(\d+)\/(\d+) tahmin yaptı$/, "$1/$2 picked"],
  [/^Seçimler (.+)'de açılır$/, "Picks open at $1"], [/^Sürüm (.+) · Yenilikler$/, "Version $1 · What's new"], [/^Sürüm (.+)$/, "Version $1"],
  [/^Adım (\d)\/5 · (.+)$/, "Step $1/5"], [/^(\d+) maç bu gece$/, "$1 games tonight"],
];

EN_RX.push(
  [/^(.+) \(ABD\)$/, "$1 (US)"], [/^(.+) önde$/, "$1 leads"], [/^Haftanın lideri (.+)$/, "Week leader $1"], [/^(\d+) gündür yok$/, "away $1 days"],
  [/^mail onaylı$/, "email verified"], [/^mail onaysız$/, "email not verified"], [/^mail yok$/, "no email"], [/^hiç oynamadı$/, "never played"],
  [/^Kilide (\d+) sa (\d+) dk var · (.+)'de, (.+) kilitlenir$/, "$1 h $2 min to lock · locks at $3"], [/^(.+)'de, maçtan 10 dk önce kilitlenir$/, "Locks at $1, 10 min before tip-off"],
  [/^(\d+) maç eksik$/, "$1 games missing"], [/^(\d+)\/(\d+) seçim$/, "$1/$2 picks"], [/^(\d+) biten maç\.?$/, "$1 finished games."], [/^(\d+) biten maç \(bu lig\)\.$/, "$1 finished games (this league)."],
  [/^Rakibin (.+)$/, "Your rival $1"], [/^Sezonda (\d+) puan öndesin · bu hafta (.+)$/, "$1 pts ahead this season · this week $2"], [/^Sezonda (\d+) puan gerisindesin · bu hafta (.+)$/, "$1 pts behind this season · this week $2"],
  [/^(\d+) puan · gece (\d+)\.(.*)$/, "$1 pts · #$2$3 that night"], [/^Kilit: (.+)\. O zamana kadar değiştirebilirsin; seçimler kilitten sonra herkese açılır\.$/, "Lock: $1. You can change until then; picks are revealed after the lock."],
  [/^Sen tek başına (.+) dedin$/, "Only you picked $1"], [/^Azınlıktasın \((.+)\)$/, "You're in the minority ($1)"], [/^(\d+) kez$/, "$1 times"], [/^(\d+)\/(\d+) tuttu$/, "$1/$2 hit"],
  [/^(\d+) oyuncunun seçimi$/, "picks of $1 players"], [/^Bu gece (\d+) maç var\.(.*)$/, "$1 games tonight.$2"], [/^Takım (\d+)-(\d+)$/, "Team $1-$2"], [/^takım (\d+)-(\d+)$/, "team $1-$2"],
  [/^(\d+) maçlık gece; eşik, cevap yarı yarıya olsun diye maç sayısına göre seçildi\.$/, "$1-game night; the number is set by tonight's game count so the answer is roughly 50/50."],
  [/^Biraz yavaş: (\d+) saniye sonra tekrar gönderebilirsin\.$/, "Slow down: you can send again in $1 s."], [/^Mesaj en fazla (\d+) karakter olabilir\.$/, "Messages can be up to $1 characters."],
  [/^(\d+) sayı$/, "$1 pts"], [/^(.+) baremi$/, "$1 range"], [/^Lige getirdiği: (.+)$/, "Brought in: $1"],
);
// tarih ve saatler İngilizce yazılsın






const EN_MON = {Ocak:"January",Şubat:"February",Mart:"March",Nisan:"April",Mayıs:"May",Haziran:"June",Temmuz:"July",Ağustos:"August",Eylül:"September",Ekim:"October",Kasım:"November",Aralık:"December"};
EN_RX.push(
  [/^Tümünü göster \((\d+)\)$/, "Show all ($1)"], [/^· (\d+) puan$/, "· $1 pts"], [/^· (\d+) maç$/, "· $1 games"],
  [/^Son 5 maçtaki (.+?) ortalaması; ▲ sezon ortalamasından ne kadar yüksek olduğu\.(.*)$/, (m,c)=>`Last-5-game average (${EN[c[0].toUpperCase()+c.slice(1)]||c}); ▲ how far above the season average.`],
  [/^(\w+) · çaylak$/, "$1 · rookie"], [/^(.+) maçları \(ABD tarihi; G\/M sonuç\)$/, "$1 games (US date; W/L result)"],
  [/^(Attığı|Yediği) sayı \(ort\.\)(?: · Ligde (\d+)\.)?$/, (m,k,r)=>`${k==="Attığı"?"Points scored":"Points allowed"} (avg.)${r?` · ${r}${["th","st","nd","rd"][(r%100>10&&r%100<14)?0:Math.min(r%10,4)%4]||"th"} in league`:""}`],
  [/^(Doğu|Batı) sırası$/, (m,c)=>`${c==="Doğu"?"East":"West"} seed`],
  [/^Haftanın oyuncusu · (.+)$/, "Player of the week · $1"], [/^Ayın ödülleri · (.+)$/, (m,x)=>"Monthly awards · "+x.split("-").map(v=>EN_MON[v]||v).join("–")],
  [/^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık) (\d{4})$/, (m,a,y)=>EN_MON[a]+" "+y],
  [/^(\d+)-(\d+) \(G-M\)(.*)$/, "$1-$2 (W-L)$3"],
  [/^Seçmeyen: (.+)$/, "No pick: $1"], [/^Ligde (\d+) kişide var$/, "$1 in the league have it"], [/^(.+) gecesi$/, (m,d)=>"Night of "+d], [/^Cevaplamayan: (.+)$/, "No answer: $1"],
);
EN_RX.push(
  [/^🏀 Zirvede (.+) var: (\d+) puan\. (.+) (\d+) puan geride\.$/, "🏀 $1 leads with $2 pts. $3 is $4 behind."],
  [/^🏀 Zirvede ortalık karışık: (.+) ve (.+) (\d+) puanla berabere\.?$/, "🏀 It's tight at the top: $1 and $2 tied on $3 pts."],
  [/^📆 Bu haftanın lideri (.+): (\d+) puan\.$/, "📆 This week's leader $1: $2 pts."],
  [/^🔥 (.+) üst üste (\d+) gecedir kazanıyor\. Durduran çıkacak mı\?$/, "🔥 $1 has won $2 nights in a row. Can anyone stop them?"],
  [/^⏳ Henüz tahmin yapmayanlar: (.+)\.$/, "⏳ No picks yet from: $1."],
  [/^❓ Gecenin sorusu: (.+)$/, (m,q)=>"❓ Question of the night: "+(EN[q]||q)],
  [/^👋 Ligimize hoş geldin, (.+)! Bol puanlı geceler\.$/, "👋 Welcome to the league, $1! Many high-scoring nights."],
  [/^👋 Ligimize hoş geldiniz: (.+) ve (.+)! Bol puanlı geceler\.$/, "👋 Welcome to the league: $1 and $2! Many high-scoring nights."],
  [/^📅 Bu gece (\d+) maç var\. Her maç başlamadan 10 dk önce kilitleniyor; ilk kilit (.+)\.$/, "📅 $1 games tonight. Each locks 10 min before tip-off; first lock $2."],
  [/^📅 Bu gece (\d+) maç var\. Tahminler (.+) itibarıyla kapanıyor\.$/, "📅 $1 games tonight. Picks close at $2."],
  [/^🏁 Bu gecenin (\d+) maçı bitti\. Skorlar sekmesine bir göz at\.$/, "🏁 All $1 games are over tonight. Check the Scores tab."],
  [/^📺 Bu gecenin maçları başladı\. Tahminler kapandı, herkesin seçimi artık görünüyor\.$/, "📺 Tonight's games have started. Picks are closed and everyone's choices are visible."],
  [/^🌙 Dün gece — (.+)$/, "🌙 Last night — $1"], [/^🌙 (.+) gecesi — (.+)$/, "🌙 Night of $1 — $2"],
);
function trText(t){
  const k=t.trim(); if(!k || !/[a-zçğıöşüİ]/i.test(k)) return null;
  if(EN[k]) return t.replace(k, EN[k]);
  for(const [rx,to] of EN_RX) if(rx.test(k)) return t.replace(k, k.replace(rx,to));
  return null;
}
function trNode(root){
  if(LANG!=="en") return;
  const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode:n=>n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  const list=[]; while(w.nextNode()) list.push(w.currentNode);
  for(const n of list){ const v=trText(n.nodeValue); if(v!=null && v!==n.nodeValue) n.nodeValue=v; }
  if(root.querySelectorAll) for(const el of root.querySelectorAll("[placeholder],[title],[aria-label]")) for(const a of ["placeholder","title","aria-label"]){ const v=el.getAttribute(a); const t=v&&trText(v); if(t && t!==v) el.setAttribute(a,t); }
}
if(LANG==="en"){
  document.documentElement.lang="en";
  const mo=new MutationObserver(ms=>{ mo.disconnect(); for(const m of ms){ if(m.type==="characterData"){ const v=trText(m.target.nodeValue); if(v!=null && v!==m.target.nodeValue) m.target.nodeValue=v; } else m.addedNodes.forEach(n=>{ if(n.nodeType===3){ const v=trText(n.nodeValue); if(v!=null) n.nodeValue=v; } else if(n.nodeType===1) trNode(n); }); } start(); });
  const start=()=>mo.observe(document.body,{childList:true,subtree:true,characterData:true});
  trNode(document.body); start();
}

/* ====================================================== tema */
const ICON_MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const ICON_SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const isDark = () => { const t=document.documentElement.dataset.theme; return t ? t==="dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
function paintTheme(){ const b=$("#theme"); b.innerHTML=isDark()?ICON_SUN:ICON_MOON; b.setAttribute("aria-label", isDark()?"Açık moda geç":"Koyu moda geç"); }
$("#theme").onclick = () => { const n=isDark()?"light":"dark"; document.documentElement.dataset.theme=n; try{localStorage.setItem("theme",n);}catch(e){} paintTheme(); if(typeof applyTheme==="function"){ applyTheme(); render(); } };
paintTheme();

/* ====================================================== ESPN verisi */
function parseGames(raw){
  const list = (raw.events||[]).filter(ev => ev.season?.type !== 1).map(ev => {
    const c = ev.competitions[0], st = ev.status||c.status||{}, ty = st.type||{};
    const side = k => {
      const x = c.competitors.find(p => p.homeAway===k) || {};
      return { abbr:x.team?.abbreviation, id:x.team?.id, name:x.team?.shortDisplayName, logo:LOGO_SMALL(x.team?.abbreviation||""),
               score: x.score!=null && x.score!=="" ? +x.score : null, winner:!!x.winner,
               rec:(x.records||[])[0]?.summary||"", ls:(x.linescores||[]).map(l=>l.displayValue ?? l.value) };
    };
    const sr = c.series && ev.season?.type===3 ? (() => {
      const byId = Object.fromEntries(c.competitors.map(p=>[String(p.team?.id), p.team?.abbreviation]));
      const wins = Object.fromEntries((c.series.competitors||[]).map(x=>[byId[String(x.id)]||String(x.id), +x.wins||0]));
      const abbrs = Object.values(byId).sort();
      return { key:`${ev.season?.year||""}${abbrs.join("-")}`, wins, need:Math.floor((+c.series.totalCompetitions||7)/2)+1, done:!!c.series.completed, summary:c.series.summary||"" };
    })() : null;
    const cupNote = (c.notes||[]).map(n=>n.headline||"").find(h=>/NBA Cup/i.test(h)) || "";
    return { id:ev.id, start:new Date(ev.date), state:ty.state, series:sr, cup:!!cupNote, cupStage:cupNote.replace(/^.*NBA Cup\s*-?\s*/i,""), detail:ty.shortDetail||"", typeName:ty.name||"",
             period:st.period||0, clock:st.displayClock||"", home:side("home"), away:side("away"),
             seasonType:ev.season?.type ?? 2 };
  }).sort((a,b) => a.start-b.start);
  if(list.length){
    const first = Math.min(...list.map(g=>g.start.getTime())), gap = first>=GAP_FROM ? LOCK_GAP : 0, per = first>=PERGAME_FROM;
    list.forEach(g => { g.nightLock = new Date(first-gap); g.lock = per ? new Date(g.start.getTime()-gap) : g.nightLock;
      g.lockBase = per ? g.start : new Date(first); g.nightBase = new Date(first); g.perGame = per; });
  }
  return list;
}
async function loadRoster(team){
  if(S.rosters[team.id]) return S.rosters[team.id];
  const raw = await espn(`/teams/${team.id}/roster`);
  const list = (raw.athletes||[]).map(a => ({
    id:String(a.id), name:a.displayName, pos:a.position?.abbreviation||"", jersey:a.jersey||"",
    img:a.headshot?.href||"", team:team.abbr, teamLogo:team.logo,
    inj:(a.injuries||[])[0]?.status || null
  }));
  S.rosters[team.id] = list;
  return list;
}
function ppg(id){ const p=S.pstats[id]; return p && p.gp ? p.pts/p.gp : null; }
async function loadSummary(g, force=false){
  const c = S.sums[g.id];
  const ttl = g.state==="post" ? Infinity : g.state==="in" ? 25e3 : 10*60e3;
  if(c && !force && Date.now()-c.at < ttl) return c.data;
  const data = await espn(`/summary?event=${g.id}`);
  S.sums[g.id] = {at:Date.now(), data};
  return data;
}
function boxPlayers(sum){
  const out=[];
  for(const team of sum?.boxscore?.players||[]){
    for(const st of team.statistics||[]){
      const keys = st.keys||[];
      for(const a of st.athletes||[]){
        if(a.didNotPlay || !a.stats?.length) continue;
        const r = Object.fromEntries(keys.map((k,i)=>[k,a.stats[i]]));
        out.push({ id:String(a.athlete.id), name:a.athlete.displayName, team:team.team.abbreviation, starter:a.starter,
          pts:+r.points||0, reb:+r.rebounds||0, ast:+r.assists||0, min:r.minutes||"0",
          fg:r["fieldGoalsMade-fieldGoalsAttempted"]||"", tp:r["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]||"",
          ft:r["freeThrowsMade-freeThrowsAttempted"]||"", pm:r.plusMinus||"" });
      }
    }
  }
  return out;
}
function topsOf(g){
  const a = S.arch.games[g.id];
  if(a?.top?.length) return a.top;
  const s = S.sums[g.id]?.data; if(!s) return null;
  const bp = boxPlayers(s); if(!bp.length) return null;
  const m = Math.max(...bp.map(p=>p.pts));
  return bp.filter(p=>p.pts===m).map(p=>({id:p.id,name:p.name,team:p.team,pts:p.pts}));
}

// Kilit açılınca: oyuncuların yüzde kaçı hangi takımı seçti
function pickShare(D, g){
  const ps=S.order.map(u=>D.picks[g.id]?.[u]).filter(Boolean), n=ps.length;
  const a=ps.filter(p=>p.winner===g.away.abbr).length;
  return {n, away:n?Math.round(a/n*100):0, home:n?100-Math.round(a/n*100):0, cnt:{[g.away.abbr]:a, [g.home.abbr]:n-a}};
}
function shareBar(D, g){
  const sh=pickShare(D,g); if(sh.n<2) return "";
  const [ca,ch]=pairCols(g.away.abbr,g.home.abbr);
  return `<div class="share"><div class="share-bar"><i style="width:${sh.away}%;background:${ca}"></i><i style="width:${sh.home}%;background:${ch}"></i></div>
    <div class="share-l"><span>${esc(g.away.abbr)} %${sh.away}</span><small>${sh.n} oyuncunun seçimi</small><span>%${sh.home} ${esc(g.home.abbr)}</span></div></div>`;
}
/* ====================================================== puanlama (scripts/sync.py ile aynı) */
function scorePick(g, pick, conf){
  const mult = multOf(g);
  const r = {w:0,m:0,s:0,pts:0,final:g.state==="post"};
  if(!pick) return r;
  const homeLead = (g.home.score??0) - (g.away.score??0);
  const winner = homeLead>0 ? g.home.abbr : homeLead<0 ? g.away.abbr : null;
  const won = winner && pick.winner===winner;
  r.tier = tierOf(g, pick.winner);
  if(won){ r.w = (conf?2:1)*r.tier; if(marginHit(pick.margin, Math.abs(homeLead))) r.m=1; }
  else if(conf && winner) r.w = -1;
  const tops = g.state==="post" ? topsOf(g) : liveTops(g);
  if(tops && tops.some(t=>t.id===pick.scorerId)) r.s=1;
  r.pts = Math.min(WIN_CAP, Math.max(r.w,0)*mult) + (r.m+r.s)*mult + Math.min(r.w,0);   // kazanan en fazla 4; yanan banko (-1) katlanmaz
  return r;
}
function liveTops(g){
  const s=S.sums[g.id]?.data; if(!s) return null;
  const bp=boxPlayers(s); if(!bp.length) return null;
  const m=Math.max(...bp.map(p=>p.pts));
  return bp.filter(p=>p.pts===m).map(p=>({id:p.id,name:p.name,pts:p.pts}));
}
// Bir günün puanları, kırılımıyla: w = taraf (banko dahil), m = fark, s = en skorer, dp = günün oyuncusu
function dayPoints(day){
  const arch = S.arch.scores.days?.[day];
  const out = {};
  const D = S.days[day];
  const archParts = uid => {
    const p = {pts:arch[uid].pts+(arch[uid].sr||0)+(arch[uid].bon||0), n:arch[uid].n??1, final:true, src:"arch", w:0, m:0, s:0, dp:arch[uid].dp||0, q:arch[uid].qp||0, sr:arch[uid].sr||0, bon:arch[uid].bon||0, auto:arch[uid].auto||0};
    for(const [gid,row] of Object.entries(S.arch.scores.games||{})){
      const g = S.arch.games[gid]; const r = row[uid];
      if(!g || g.day!==day || !r) continue;
      const k = multOf(g);
      p.w += r.w>0 ? Math.min(WIN_CAP, r.w*k) : r.w; p.m += r.m*k; p.s += r.s*k;
    }
    return p;
  };
  for(const uid of S.order){
    if(arch?.[uid] && (!D || D.games.every(g=>g.state==="post") && !D.games.some(g=>!S.arch.games[g.id]))){ out[uid] = archParts(uid); continue; }
    if(!D){ out[uid] = arch?.[uid] ? archParts(uid) : null; continue; }
    const p = {pts:0, n:0, final:D.games.length>0, src:"live", w:0, m:0, s:0, dp:0, q:0, sr:0};
    const daily=D.daily[uid];
    for(const g of D.games){
      if(!started(g)) { p.final=false; continue; }
      if(g.state!=="post" || !topsOf(g)) p.final=false;   // skorer bilgisi gelmeden gece kesinleşmiş sayılmaz
      const pick = D.picks[g.id]?.[uid];
      if(pick) p.n++;
      if(g.state!=="post" && g.state!=="in") continue;
      const r = scorePick(g, pick, daily?.confGame===g.id);
      const k = multOf(g);
      p.w += r.w>0 ? Math.min(WIN_CAP, r.w*k) : r.w; p.m += r.m*k; p.s += r.s*k; p.pts += r.pts;
    }
    const dpr = dayPlayerResult(day, uid);
    if(dpr?.hit){ const v=dpValue(day); p.pts += v; p.dp = v; }
    if(daily?.dayPlayerId) p.n++;
    if(daily?.q){ p.n++; const qr = questionResult(day); if(qr?.final && qr.ans===daily.q){ p.q=1; p.pts+=1; } }
    out[uid] = p;
  }
  return out;
}
function dayPlayerResult(day, uid){
  const D=S.days[day]; if(!D) return null;
  const d=D.daily[uid]; if(!d?.dayPlayerId) return null;
  const allFinal = D.games.length && D.games.every(g=>g.state==="post");
  let best=-1, ids=new Set(), anyData=false;
  for(const g of D.games){
    if(!started(g)) continue;
    const t = g.state==="post" ? topsOf(g) : liveTops(g);
    if(!t) continue; anyData=true;
    for(const x of t){ if(x.pts>best){best=x.pts; ids=new Set([x.id]);} else if(x.pts===best) ids.add(x.id); }
  }
  return { name:d.dayPlayerName, id:d.dayPlayerId, hit: allFinal && ids.has(d.dayPlayerId), leading: anyData && ids.has(d.dayPlayerId), final:allFinal };
}

/* ====================================================== Firebase */
async function initFirebase(){
  S.cfg = await getJSON("config.json?t="+Date.now());
  if(S.cfg.firebase.projectId==="BURAYA" && !Q.has("emu")) return false;
  const app = initializeApp(Q.has("emu") ? {apiKey:"demo", projectId:"demo-tahmin", authDomain:"demo"} : S.cfg.firebase);
  S.auth = getAuth(app); S.db = getFirestore(app);
  if(Q.has("emu")){ connectAuthEmulator(S.auth, "http://127.0.0.1:9099", {disableWarnings:true}); connectFirestoreEmulator(S.db, "127.0.0.1", 8085); }
  return true;
}
async function loadPlayers(){
  const snap = await getDocs(collection(S.db, "players"));
  S.players = {};
  // katılma saati henüz sunucudan gelmediyse "en yeni" say (renk sırası kaymasın)
  snap.forEach(d => { const x=d.data({serverTimestamps:"estimate"});
    S.players[d.id] = {name:x.name, joined:x.joined?.toMillis?.()||Date.now(), color:x.color||"", emoji:x.emoji||"", favTeam:x.favTeam||"", theme:x.theme||"default", av:x.av||"", bio:x.bio||"", ref:x.ref||"", club:x.club||"", rival:x.rival||"", ...("autoPick" in x ? {autoPick:!!x.autoPick} : {}), seen:x.seen?.toMillis?.()||0}; });
  S.order = Object.keys(S.players).sort((a,b) => (S.players[a].joined-S.players[b].joined) || pname(a).localeCompare(pname(b),"tr"));
  S.colorOrder = [...S.order];
  // giriş yapan oyuncu her zaman ilk sırada (iki kişide solda)
  if(S.uid && S.order.includes(S.uid)) S.order = [S.uid, ...S.order.filter(u=>u!==S.uid)];
  $("#playerNames").innerHTML = S.order.map(u=>`<option value="${esc(pname(u))}">`).join("");
}
const pickRef = (gid, uid) => doc(S.db, "picks", `${gid}_${uid}`);
const dailyRef = (day, uid) => doc(S.db, "daily", `${day}_${uid}`);
const progressRef = (day, uid) => doc(S.db, "progress", `${day}_${uid}`);
async function readPick(gid, uid){ try{ const s=await getDoc(pickRef(gid,uid)); return s.exists()?s.data():null; }catch(e){ return null; } }
async function readDaily(day, uid){ try{ const s=await getDoc(dailyRef(day,uid)); return s.exists()?s.data():null; }catch(e){ return null; } }

S.loadingDay = {};
function loadDay(day, opts={}){
  // aynı gün için süren bir yükleme varsa onu bekle (açılışta iki kez istenmesin)
  if(S.loadingDay[day]) return S.loadingDay[day];
  return S.loadingDay[day] = loadDayNow(day, opts).finally(()=>{ delete S.loadingDay[day]; });
}
async function loadDayNow(day, {force=false}={}){
  const old = S.days[day];
  if(old && !force && Date.now()-old.at < 20e3) return old;
  let raw=null;
  if(S.preSB?.day===day){ raw=await S.preSB.p; S.preSB=null; }   // açılışta önceden istenmiş liste
  const games = parseGames(raw || await espn(`/scoreboard?dates=${day}&limit=50`));
  const D = { games, picks: old?.picks||{}, daily: old?.daily||{}, progress: old?.progress||{}, at:Date.now() };
  const firstStart = games.length ? Math.min(...games.map(g=>g.start.getTime())) : Infinity;
  const jobs=[];
  for(const g of games){
    D.picks[g.id] = D.picks[g.id]||{};
    for(const uid of S.order){
      if(uid!==S.uid && !started(g)) continue;
      if(D.picks[g.id][uid] && started(g) && uid!==S.uid && D.picks[g.id][uid]._locked) continue;
      jobs.push(readPick(g.id, uid).then(p => { if(p){ p._locked = started(g); D.picks[g.id][uid]=p; } else delete D.picks[g.id][uid]; }));
    }
  }
  for(const uid of S.order){
    jobs.push(getDoc(progressRef(day, uid)).then(s => { D.progress[uid] = new Set(s.exists() ? s.data().gids||[] : []); }).catch(()=>{}));
    if(uid!==S.uid && Date.now()<(games[0]?.nightLock?.getTime() ?? firstStart)) continue;
    jobs.push(readDaily(day, uid).then(d => { if(d) D.daily[uid]=d; else delete D.daily[uid]; }));
  }
  // kilitlenmiş maçlara bırakılan emoji ve yorumlar
  D.talk = old?.talk || {};
  if(games.some(started)) jobs.push(getDocs(query(collection(S.db,"talk"), where("day","==",day))).then(snap => {
    D.talk = {}; snap.forEach(x => { const t=x.data(); (D.talk[t.gid] ||= {})[t.uid] = t; });
  }).catch(()=>{}));
  // playoff seri tahminleri
  D.series = old?.series || {};
  for(const g of games.filter(g=>g.series)) for(const uid of S.order){
    if(uid!==S.uid && !started(g)) continue;
    jobs.push(getDoc(doc(S.db,"series",`${g.series.key}_${uid}`)).then(x => { (D.series[g.series.key] ||= {})[uid] = x.exists() ? x.data() : null; }).catch(()=>{}));
  }
  await Promise.all(jobs);
  S.days[day] = D;
  // biten / süren maçların özetleri (en skorer ve canlı takip için). Sayfayı bekletmez:
  // arka planda yüklenir, gelince ekran yeniden çizilir.
  const need = games.filter(g => g.state==="in" || (g.state==="post" && !S.arch.games[g.id]?.top));
  const fresh = need.filter(g => { const c=S.sums[g.id]; return !c || (g.state!=="post" && Date.now()-c.at>=25e3); });
  if(fresh.length) Promise.all(fresh.map(g => loadSummary(g).catch(()=>null))).then(()=>{ if(S.uid && S.days[day]===D) render(); });
  return D;
}

/* ====================================================== kaydetme */
async function savePick(g, {quiet=false}={}){
  const d = S.draft[g.id]; if(!d) return;
  if(!(d.winner && d.margin && d.scorerId)) return;
  if(started(g)){ toast(lockedMsg(g)); return; }
  const D = S.days[S.day];
  const prev = D.picks[g.id]?.[S.uid];
  if(prev && prev.winner===d.winner && prev.margin===d.margin && prev.scorerId===d.scorerId) return;
  d.saving = true; renderGames();
  try{
    // start = kilidin dayanağı (maçın kendi saati; kural 10 dk önce kapatır). Kaydedilmiş tahminde eski değer korunur.
    const data = { uid:S.uid, gameId:g.id, day:S.day, start: prev?.start || Timestamp.fromDate(g.lockBase),
      winner:d.winner, margin:d.margin, scorerId:d.scorerId, scorerName:d.scorerName, updatedAt:serverTimestamp() };
    await setDoc(pickRef(g.id, S.uid), data);
    D.picks[g.id][S.uid] = {...data, updatedAt:Timestamp.now()};
    d.err = null; d.justSaved = Date.now();
    if(!quiet) toast(pick(["Tahmin kaydedildi.","Tamamdır, tahminin kaydedildi.","Kaydedildi. Şimdi maçı bekle.","Tahminin alındı."]));
    setDoc(progressRef(S.day, S.uid), {uid:S.uid, day:S.day, gids:arrayUnion(g.id), updatedAt:serverTimestamp()}, {merge:true})
      .then(()=>{ (D.progress[S.uid] ||= new Set()).add(g.id); renderDayView(); }).catch(()=>{});
  }catch(e){
    d.err = started(g) ? "Kilitlendi, kaydedilemedi." : "Kaydedilemedi, tekrar dene.";
  }
  d.saving = false; renderGames(); renderStatus();
  if(!d.err){ setTimeout(()=>{ S.edit.delete(g.id); if(S.tab==="tahmin" && S.sub==="maclar") renderGames(); }, 1500); }
}
async function saveDaily(patch){
  const D = S.days[S.day];
  const firstStart = Math.min(...D.games.map(g=>g.start.getTime()));
  const cur = D.daily[S.uid] || {};
  const data = { uid:S.uid, day:S.day, firstStart: cur.firstStart || Timestamp.fromMillis(firstStart) };
  for(const k of ["confGame","confStart","confAt","dayPlayerId","dayPlayerName","dayAt","q","qAt"]) if(cur[k]!==undefined) data[k]=cur[k];
  if(patch.confGame){ data.confGame=patch.confGame; data.confStart=Timestamp.fromDate(patch.confStart); data.confAt=serverTimestamp(); }
  if(patch.dayPlayerId){ data.dayPlayerId=patch.dayPlayerId; data.dayPlayerName=patch.dayPlayerName; data.dayAt=serverTimestamp(); }
  if(patch.q){ data.q=patch.q; data.qAt=serverTimestamp(); }
  try{
    await setDoc(dailyRef(S.day, S.uid), data);
    // sunucunun yazdığı saatleri geri oku; sonraki kayıt bunları aynen göndermeli
    D.daily[S.uid] = await readDaily(S.day, S.uid) || D.daily[S.uid];
    toast(patch.confGame ? pick(["Banko seçildi.","Bankon hazır, umarım tutar.","Banko kaydedildi."]) : patch.q ? pick(["Cevabın kaydedildi.","Cevabını aldık.","Kaydedildi, gece bitince belli olur."]) : pick(["Günün oyuncusu seçildi.","Günün oyuncusu kaydedildi.","Seçimin kaydedildi, umarım bu gece şov yapar."]));
  }catch(e){ toast("Kaydedilemedi: süre dolmuş olabilir."); }
  render();
}

/* ====================================================== görsel yardımcılar */
// Takım ana / ikincil renkleri (ESPN). Çok koyu renk koyu temada ikincisiyle değiştirilir.
const TEAM_COL = {ATL:["c8102e","fdb927"],BOS:["008348","ffffff"],BKN:["000000","ffffff"],CHA:["008ca8","1d1060"],CHI:["ce1141","000000"],CLE:["860038","bc945c"],
  DAL:["0064b1","bbc4ca"],DEN:["0e2240","fec524"],DET:["1d428a","c8102e"],GS:["fdb927","1d428a"],HOU:["ce0e2d","000000"],IND:["0c2340","ffd520"],LAC:["12173f","c8102e"],
  LAL:["552583","fdb927"],MEM:["5d76a9","12173f"],MIA:["98002e","000000"],MIL:["00471b","eee1c6"],MIN:["266092","79bc43"],NO:["0a2240","b4975a"],NY:["1d428a","f58426"],
  OKC:["007ac1","ef3b24"],ORL:["0150b5","9ca0a3"],PHI:["1d428a","e01234"],PHX:["29127a","e56020"],POR:["e03a3e","000000"],SAC:["5a2d81","6a7a82"],SA:["000000","c4ced4"],
  TOR:["d91244","000000"],UTAH:["4e008e","79a3dc"],WSH:["e31837","002b5c"]};
// iki renk arasındaki zıtlık (WCAG) ve bir rengi zeminde okunur hale getirme
const hexMix = (a,b,t) => { const A=parseInt(a,16), B=parseInt(b,16); return [16,8,0].map(k=>Math.round(((A>>k)&255)*t+((B>>k)&255)*(1-t)).toString(16).padStart(2,"0")).join(""); };
const contrast = (a,b) => { const x=lum(a), y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
function readableOn(hex, bgs, min=4.5){
  let c=hex.replace("#",""); const darkBg = lum(bgs[0]) < .2;
  for(let i=0;i<20 && bgs.some(b=>contrast(c,b)<min);i++) c=hexMix(c, darkBg?"ffffff":"000000", .88);
  return "#"+c;
}
const lum = h => { const n=parseInt(h,16), c=[n>>16&255,n>>8&255,n&255].map(v=>{v/=255; return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;}); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
function tcol(abbr){
  const c = TEAM_COL[abbr]; if(!c) return "var(--line)";
  return "#" + (isDark() && lum(c[0]) < .03 ? c[1] : c[0]);
}
// İki takımın rengi birbirine çok yakınsa ev sahibi ikinci rengini kullanır (ör. Lakers–Jazz)
function pairCols(a, h){
  const ca=tcol(a), ch=tcol(h), hx=c=>c.startsWith("#")?[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)):null;
  const A=hx(ca), H=hx(ch);
  if(A && H && Math.hypot(A[0]-H[0],A[1]-H[1],A[2]-H[2]) < 90){ const alt=TEAM_COL[h]?.[1]; if(alt && lum(alt)>.03 && lum(alt)<.9) return [ca,"#"+alt]; }
  return [ca,ch];
}
const initials = n => String(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toLocaleUpperCase("tr");
// Avatar olarak seçilebilen 50 oyuncu (CBS Sports 2026-27 ilk 50 sıralaması) ve 30 takım logosu
const STARS = [["5104157","Victor Wembanyama"],["4278073","Shai Gilgeous-Alexander"],["3112335","Nikola Jokic"],["3945274","Luka Doncic"],["4594268","Anthony Edwards"],["3032977","Giannis Antetokounmpo"],["3934672","Jalen Brunson"],["4432166","Cade Cunningham"],["4065648","Jayson Tatum"],["3975","Stephen Curry"],["6450","Kawhi Leonard"],["4396993","Tyrese Haliburton"],["4431678","Tyrese Maxey"],["3908809","Donovan Mitchell"],["3202","Kevin Durant"],["3136195","Karl-Anthony Towns"],["3917376","Jaylen Brown"],["4433134","Scottie Barnes"],["1966","LeBron James"],["4593803","Jalen Williams"],["3149673","Pascal Siakam"],["4432158","Evan Mobley"],["4066261","Bam Adebayo"],["3934719","OG Anunoby"],["5041939","Cooper Flagg"],["3136193","Devin Booker"],["4683021","Deni Avdija"],["4433255","Chet Holmgren"],["3936299","Jamal Murray"],["4701230","Jalen Johnson"],["4066457","Austin Reaves"],["4684740","Amen Thompson"],["3078576","Derrick White"],["4433621","Jalen Duren"],["4871144","Alperen Sengun"],["4277961","Jaren Jackson Jr."],["3059318","Joel Embiid"],["5037871","Dylan Harper"],["6583","Anthony Davis"],["4845367","Stephon Castle"],["4432816","LaMelo Ball"],["4066336","Lauri Markkanen"],["6442","Kyrie Irving"],["4566434","Franz Wagner"],["4432573","Paolo Banchero"],["3032976","Rudy Gobert"],["3992","James Harden"],["5061575","Kon Knueppel"],["4431671","Jaden McDaniels"],["4397688","Trey Murphy III"]];
const FACE = id => `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=96&h=70&scale=crop&cquality=70`;
const faceImg = (id, cls="face") => id ? `<img class="${cls}" src="${FACE(id)}" alt="" loading="lazy">` : "";
const HEADSHOT = id => `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=160&h=117&scale=crop&cquality=70`;
// Avatar yalnızca basketbolcu olabilir ("p:id"); eski takım logosu ve emoji avatarları gösterilmez, baş harfler görünür
const avImg = av => { const m=/^p:(\w+)$/.exec(av||""); return m ? `<img class="av-img" src="${HEADSHOT(m[1])}" alt="" loading="lazy">` : ""; };
const avatar = (u, cls="") => { const p=S.players[u]||{}; const h=honors(); const img=avImg(p.av);
  const crown = h.week===u ? `<span class="av-crown" title="Geçen haftanın şampiyonu">👑</span>` : "";
  const star = h.night===u ? `<span class="av-star" title="Son gecenin kazananı">★</span>` : "";
  const badge = p.favTeam ? `<img class="av-team" src="${LOGO_SMALL(p.favTeam)}" alt="">` : "";
  return `<span class="av ${cls} ${img?"has-img":""}" style="--pc:${col(u)}">${img?`<span class="av-ini">${esc(initials(pname(u)))}</span>${img}`:esc(initials(pname(u)))}${badge}${crown}${star}</span>`; };
// Geçen haftanın tek şampiyonu ve son bitmiş gecenin tek kazananı (+ o gecenin puanları)
function honors(){
  const key = S.today + "|" + Object.keys(S.arch.scores.days||{}).length + "|" + S.order.length + "|" + (S.days[S.today]?.at||0) + "|" + (S.days[shiftDay(S.today,-1)]?.at||0);
  if(honors.k===key) return honors.v;
  const v={week:null, night:null, nightDay:null, nightPts:{}};
  const pw = S.arch.scores.weeks?.[shiftDay(weekKey(S.today),-7)];
  if(pw){ const vals=Object.entries(pw).filter(([u])=>S.order.includes(u)); const m=Math.max(...vals.map(x=>x[1])); const w=vals.filter(x=>x[1]===m); if(w.length===1 && m>0) v.week=w[0][0]; }
  for(const d of allDays()){ const w=dayWinner(d); if(!w || w.st==="live") continue; v.nightDay=d; if(w.st==="w") v.night=w.u; const p=dayPoints(d); for(const u of S.order) v.nightPts[u]=p[u]?.pts??null; break; }
  honors.k=key; honors.v=v; return v;
}
const deltaHTML = u => { const h=honors(), p=h.nightPts[u]; if(p==null) return "";
  return `<span class="delta ${p>0?"up":p<0?"down":""}" title="${dayNice(h.nightDay,{day:"numeric",month:"long"})} gecesi">${p>0?"▲":p<0?"▼":"•"} ${p>0?"+":""}${p} <small>son gece</small></span>`; };
// Son 5 bitmiş gece: G (tek başına en çok), B (berabere en çok), M
function formOf(u, n=5){
  const out=[];
  for(const d of allDays()){
    const p=dayPoints(d);
    if(S.order.some(x=>p[x] && !p[x].final) || !p[u]?.n) continue;
    const best=Math.max(...S.order.map(x=>p[x]?.pts??-99)); const w=S.order.filter(x=>(p[x]?.pts??-99)===best);
    out.push(w.includes(u) ? (w.length===1?"W":"T") : "L");
    if(out.length>=n) break;
  }
  return out.reverse();
}
const formHTML = u => { const f=formOf(u); return `<span class="form" title="Son 5 gece">${f.map(r=>`<i class="${r}"></i>`).join("")}${"<i></i>".repeat(5-f.length)}</span>`; };
// Skorbord rakamı: oyuncu renginde ışık, sayılar değişince sayarak gelir
const digitsHTML = (u, v) => `<div class="digits tnum" data-u="${u}" data-v="${v}" style="--pc:${col(u)}"><span>${v}</span></div>`;

/* ====================================================== skorbord */
// Sezon toplamı ve kırılımı: arşivdeki günler + henüz arşive girmemiş günler (canlı)
// Lig ödülleri (sync her ay sonunda hesaplar: data/scores.json -> awards)
const awardPts = u => Object.values(S.arch.scores.awards||{}).reduce((t,a)=>t+(a.list||[]).filter(x=>x.u?.includes(u)).reduce((s,x)=>s+x.pts,0),0);
function awardsHTML(){
  const A=Object.entries(S.arch.scores.awards||{}).sort((a,b)=>b[0].localeCompare(a[0]));
  if(!A.length){ // henüz açıklanan ay yok: ödülleri ve ne zaman açıklanacağını göster
    const L=[["👑","Ayın tahmincisi","Ayın en çok puan toplayanı",1],["★","Banko ustası","En yüksek banko isabeti (en az 4 banko)",2],["🎯","Sürpriz avcısı","ESPN'in favorisinin karşısına geçip en çok bilen",2],["🔥","Skorer ustası","En skoreri en çok bilen",2],["📏","Fark ustası","Farkı en çok tutturan",2]];
    return `<div class="sec-title"><h2>Lig ödülleri</h2><span class="aside">her ay sonu, puana eklenir</span></div><div class="aw-m"><div class="aw-mh"><b>Ekim-Kasım ödülleri</b><span class="muted">1 Aralık'ta açıklanır</span></div>
      ${L.map(([i,t,d,p])=>`<div class="aw-r"><span class="aw-i">${i}</span><span class="aw-t"><b>${t}</b><small>${d}</small></span><span class="aw-w"><span class="muted">—</span></span><span class="aw-p">+${p}</span></div>`).join("")}</div>`;
  }
  return `<div class="sec-title"><h2>Lig ödülleri</h2><span class="aside">her ay sonu, puana eklenir</span></div>${A.map(([k,a])=>`<div class="aw-m"><div class="aw-mh"><b>${esc(a.title)}</b><button class="linkish" data-awshow="${k}" type="button">Töreni izle</button></div>
    ${(a.list||[]).map(x=>`<div class="aw-r"><span class="aw-i">${x.i||"🏅"}</span><span class="aw-t"><b>${esc(x.t)}</b><small>${esc(x.d||"")}</small></span><span class="aw-w">${(x.u||[]).map(u=>`<b style="color:${col(u)}">${esc(pname(u))}</b>`).join(", ")||'<span class="muted">—</span>'}</span><span class="aw-p">+${x.pts}</span></div>`).join("")}</div>`).join("")}`;
}
// Tören ekranı: ödüller tek tek açılır (yarışma programı gibi)
function openCeremony(k){
  const a=S.arch.scores.awards?.[k]; if(!a?.list?.length) return;
  let i=-1; const ov=document.createElement("div"); ov.className="cer"; document.body.appendChild(ov);
  const next=()=>{ i++; if(i>=a.list.length){ ov.innerHTML=`<div class="cer-in"><div class="cer-k">${esc(a.title)}</div><div class="cer-big">Tebrikler!</div><div class="cer-sum">${S.order.filter(u=>a.list.some(x=>x.u?.includes(u))).map(u=>`<span>${avatar(u,"sm")}<b style="color:${col(u)}">${esc(pname(u))}</b> +${a.list.filter(x=>x.u?.includes(u)).reduce((s,x)=>s+x.pts,0)}</span>`).join("")}</div><button class="btn-primary" id="cerX" type="button">Kapat</button></div>`; $("#cerX").onclick=()=>ov.remove(); return; }
    const x=a.list[i];
    ov.innerHTML=`<div class="cer-in"><div class="cer-k">${esc(a.title)} · ${i+1}/${a.list.length}</div><div class="cer-i">${x.i||"🏅"}</div><div class="cer-t">${esc(x.t)}</div><div class="cer-d">${esc(x.d||"")}</div>
      <div class="cer-env" id="cerEnv"><span>Kazanan…</span></div><button class="btn-primary" id="cerN" type="button" disabled>Sonraki</button></div>`;
    setTimeout(()=>{ const e=$("#cerEnv"); if(!e) return; e.classList.add("open"); e.innerHTML=(x.u||[]).length ? x.u.map(u=>`<span class="cer-w">${avatar(u,"lg")}<b style="color:${col(u)}">${esc(pname(u))}</b></span>`).join("")+`<em>${esc(x.v||"")} · +${x.pts} puan</em>` : `<span class="muted">Bu ay kimse kazanamadı</span>`; $("#cerN").disabled=false; }, 1600);
    $("#cerN").onclick=next; };
  ov.onclick=e=>{ if(e.target===ov) ov.remove(); };
  next();
}
function maybeCeremony(){
  const ks=Object.keys(S.arch.scores.awards||{}).sort(); if(!ks.length) return; const k=ks.at(-1);
  if(lsGet("cerSeen")===k) return;
  const go=(n=0)=>{ if(!$("#sheet").classList.contains("hide") || S.onboard || S.obStep){ if(n<40) setTimeout(()=>go(n+1),3000); return; } lsSet("cerSeen",k); openCeremony(k); };
  setTimeout(go, 4500);
}
function seasonBreakdown(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d] && inLeague(d)) days.add(d);
  const b = {}; for(const u of S.order){ const lt=S.lt?.loaded ? ltPoints(u) : 0, aw=awardPts(u); b[u] = {pts:lt+aw, w:0, m:0, s:0, dp:0, q:0, sr:0, bon:0, auto:0, lt, aw}; }
  for(const d of days){
    const dp = dayPoints(d);
    for(const u of S.order){ const p=dp[u]; if(!p) continue; b[u].pts+=p.pts; b[u].w+=p.w; b[u].m+=p.m; b[u].s+=p.s; b[u].dp+=p.dp; b[u].q+=p.q||0; b[u].sr+=p.sr||0; b[u].bon+=p.bon||0; b[u].auto+=p.auto||0; }
  }
  return b;
}
// Eşit puanda sıra: daha çok gece birinciliği, sonra daha çok kazanan puanı, sonra isim
function nightWins(){
  const w={}; S.order.forEach(u=>w[u]=0);
  for(const d of allDays()){ const p=dayPoints(d); const nv=u=>p[u] ? p[u].pts-(p[u].bon||0) : null; const vals=S.order.map(nv).filter(v=>v!=null);
    if(!vals.length || S.order.some(u=>p[u] && !p[u].final)) continue;
    const best=Math.max(...vals), x=S.order.filter(u=>nv(u)===best); if(x.length===1) w[x[0]]++; }
  return w;
}
function rankOrder(tot){
  const b=seasonBreakdown(), nw=nightWins();
  return [...S.order].sort((a,c)=>(tot[c]-tot[a]) || (nw[c]-nw[a]) || ((b[c]?.w||0)-(b[a]?.w||0)) || pname(a).localeCompare(pname(c),"tr"));
}
// Sezon arşivi: yönetim panelinden "Ligi sıfırla / yeni sezon" yapılınca biten lig buraya kalıcı olarak kaydedilir
function openArchive(idx){
  const H=S.league?.history||[];
  if(idx==null || !H[idx]){
    openSheet(`<h3 id="shTitle">Sezon arşivi</h3>${H.length?`<div class="months">${[...H].map((h,i)=>({h,i})).reverse().map(({h,i})=>`<div class="mo done" data-arch2="${i}" role="button" tabindex="0"><span class="mo-n" style="text-transform:none">${h.name?`<b>${esc(h.name)}</b> · `:""}${dayNice(h.start,{day:"numeric",month:"short"})} – ${dayNice(h.end,{day:"numeric",month:"short"})}</span><span class="mo-w">👑 <b>${esc(h.rows?.[0]?.name||"?")}</b><small>${h.rows?.[0]?.pts??0} puan</small></span><span class="mo-s">ayrıntı ›</span></div>`).join("")}</div>`
      : emptyBox("archive", `Yönetim panelinden "Ligi sıfırla / yeni sezon" yapıldığında biten lig puan tablosu, gece birincilikleri, uzun vade puanları ve ödülleriyle burada saklanır.`, "Henüz biten bir lig yok")}`);
    $$("#sheet [data-arch2]").forEach(b=>b.onclick=()=>openArchive(+b.dataset.arch2)); return; }
  const h=H[idx];
  openSheet(`<h3 id="shTitle">${esc(h.name||"Lig")}</h3><p class="muted">${dayNice(h.start,{day:"numeric",month:"long"})} – ${dayNice(h.end,{day:"numeric",month:"long"})}</p>
    <div class="box arch-t"><div class="arch-r arch-h"><span>#</span><span>Oyuncu</span><span>Puan</span><span>Gece</span><span>UV</span></div>${(h.rows||[]).map((r,i)=>`<div class="arch-r"><span>${i===0?"👑":i+1}</span><b>${esc(r.name)}</b><span class="tnum">${r.pts}</span><span class="tnum">${r.nights??"–"}</span><span class="tnum">${h.lt?.[r.uid]??"–"}</span></div>`).join("")}</div>
    ${(h.awards||[]).length?`<div class="sec-title"><h2 style="font-size:18px">Ödüller</h2></div><div class="box" style="font-size:14px;line-height:1.7">${h.awards.map(esc).join("<br>")}</div>`:""}
    <button class="linkish" id="archBack" type="button">‹ Bütün sezonlar</button>`);
  $("#archBack").onclick=()=>openArchive();
}
function seasonTotals(){ const b=seasonBreakdown(); const t={}; for(const u of S.order) t[u]=b[u].pts; return t; }
// Puan tablosu tam hali yalnızca Bu Gece ve Sıralama'da; diğer sekmelerde tek satırlık şerit (dokununca açılır)
const EMPTY_ICO = {
  archive:'<path d="M4 7h16v12H4z"/><path d="M3 4h18v3H3zM10 11h4"/>',
  chart:'<path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 4-6"/>',
  people:'<circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><path d="M17 11a2.5 2.5 0 1 0 0-5M21 19c0-2-1.5-3.6-3.5-4.3"/>',
  filter:'<path d="M4 5h16l-6 7v6l-4 1v-7z"/>',
  ball:'<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4v16M6.3 6.3c3 2.6 3 8.8 0 11.4M17.7 6.3c-3 2.6-3 8.8 0 11.4"/>',
  heal:'<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11h5M12 8.5v5"/>',
  cards:'<rect x="5" y="4" width="11" height="15" rx="2"/><path d="M19 7v12a2 2 0 0 1-2 2H8"/>',
  shield:'<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
  medal:'<circle cx="12" cy="14" r="5"/><path d="M8.5 3h7l-2 6.5h-3z"/><path d="M12 12v4"/>',
  clock:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
};
function emptyBox(ico, text, title=""){
  return `<div class="empty-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${EMPTY_ICO[ico]||EMPTY_ICO.ball}</svg>${title?`<b>${title}</b>`:""}<span>${text}</span></div>`;
}
function renderBoardStrip(){
  const el=$("#boardStrip"); if(!el) return;
  const compact = !["tahmin","puan"].includes(S.tab) && S.order.length>0;
  const open = compact && S.boardOpen===S.tab;
  $("#board").classList.toggle("compact", compact && !open);
  el.classList.toggle("hide", !compact);
  if(!compact) return;
  const tot=seasonTotals(), rk=rankOrder(tot), lead=rk[0], me=rk.indexOf(S.uid);
  el.innerHTML = open ? `<span class="bs-t">Tabloyu küçült</span><span class="bs-c">▴</span>`
    : (()=>{ const mine=tot[S.uid]||0, up=me>0?rk[me-1]:null, dn=me>=0&&me<rk.length-1?rk[me+1]:null;
        const nb = me<0 ? "" : `<span class="bs-nb">${up?`<span>▲ <b style="color:${col(up)}">${esc(pname(up))}</b> ${(tot[up]||0)-mine} puan önde</span>`:""}${dn?`<span>▼ <b style="color:${col(dn)}">${esc(pname(dn))}</b> ${mine-(tot[dn]||0)} puan geride</span>`:""}</span>`;
        const head = me===0 ? `👑 <b>Zirvedesin</b> · ${mine} puan` : `<span>👑 <b style="color:${col(lead)}">${esc(pname(lead))}</b> ${tot[lead]||0}</span>${me>0?`<span>Sen <b>${me+1}.</b> sırada · ${mine} puan</span>`:""}`;
        return `<span class="bs-t"><span class="bs-h">${head}</span>${nb}</span><span class="bs-c">Tablo ▾</span>`; })();
}
function renderBoard(){
  const brk = seasonBreakdown();
  const tot = {}; for(const u of S.order) tot[u]=brk[u].pts;
  const tonight = S.days[S.today] && inLeague(S.today) ? dayPoints(S.today) : {};
  const ranked = rankOrder(tot);
  let html;
  if(false){   // eski iki kişilik "VS" görünümü kullanılmıyor; oyuncu sayısı ne olursa olsun sıralama listesi
    const [a,b] = S.order;
    const cell = u => u ? `<div class="pl" data-pu="${u}">${avatar(u)}<div class="nm" style="color:${col(u)}">${esc(pname(u))}</div>${digitsHTML(u, tot[u])}${deltaHTML(u)}${formHTML(u)}</div>` : `<div class="pl"><span class="av empty">?</span><div class="nm">Rakip bekleniyor</div><div class="digits">–</div></div>`;
    html = `<div class="duel">${cell(a)}<div class="vs">VS</div>${cell(b)}</div>`;
    if(a && b){
      // halat çekme: düğüm farka göre kayar
      const d = tot[a]-tot[b], span = Math.max(12, Math.abs(tot[a])+Math.abs(tot[b]));
      const pos = Math.min(92, Math.max(8, 50 + d/span*50));
      const lbl = d===0 ? "Berabere" : `${esc(pname(d>0?a:b))} +${Math.abs(d)}`;
      html += `<div class="tug" style="--a:${col(a)};--b:${col(b)};--pos:${pos}%"><div class="tug-bar"><i class="ta"></i><i class="tb"></i><span class="knot"></span></div><div class="tug-lbl" style="${d?`color:${col(d>0?a:b)}`:""}">${lbl}</div></div>`;
    }
  } else {
    const top = Math.max(1, ...ranked.map(u=>tot[u]));
    const showAll = S.boardAll || ranked.length<=4;
    const vis = showAll ? ranked : ranked.filter((u,i)=>i<3 || u===S.uid);
    html = `<div class="lb">${vis.map((u)=>{ const i=ranked.indexOf(u); return `<div class="lb-row" data-pu="${u}" style="--pc:${col(u)};--w:${Math.max(0,tot[u])/top*100}%"><span class="rk">${i+1}</span>${avatar(u,"sm")}<span class="nmw"><span class="nm" style="color:${col(u)};display:block">${esc(pname(u))}</span>${formHTML(u)}</span>${tonight[u]?.pts ? `<span class="td on">+${tonight[u].pts} bu gece</span>` : `<span class="td"></span>`}<span class="tn tnum">${tot[u]}${deltaHTML(u)}</span></div>`; }).join("")}</div>`
      + (ranked.length<2 ? `<button class="lb-more lb-inv" id="lbInvite" type="button">${ICON.link}Arkadaşlarını davet et, tablo dolsun</button>` : "")
      + (ranked.length>4 ? `<button class="lb-more" id="lbMore" type="button">${S.boardAll?"Daralt":`Tümünü göster (${ranked.length})`}</button>` : "");
  }
  let lead = `<i></i>Henüz puan yok`;
  if(ranked.length>1){
    if(tot[ranked[0]]===tot[ranked[1]]) lead = `<i style="background:var(--amber)"></i>Şu an berabere`;
    else lead = `<i style="background:${col(ranked[0])}"></i>${esc(pname(ranked[0]))} önde`;
  }
  const tn = false ? `Bu gece <b>${S.order.map(u=>tonight[u]?.pts??0).join("–")}</b>` : "";
  const wk = weekKey(S.today), wkPts = {}; for(const u of S.order) wkPts[u]=(S.arch.scores.weeks?.[wk]?.[u]||0);
  for(const day of [S.today, shiftDay(S.today,-1)]){ if(weekKey(day)!==wk || !S.days[day] || !inLeague(day)) continue; const dp=dayPoints(day); for(const u of S.order) if(dp[u]?.src==="live") wkPts[u]+=dp[u].pts-(S.arch.scores.days?.[day]?.[u]?.pts||0); }
  const wkLead = [...S.order].sort((x,y)=>wkPts[y]-wkPts[x]);
  const wkTxt = !S.order.length ? "" : false ? `Bu hafta <b>${S.order.map(u=>wkPts[u]).join("–")}</b>`
    : wkPts[wkLead[0]]>0 ? `Haftanın lideri <b style="color:${col(wkLead[0])}">${esc(pname(wkLead[0]))}</b> · ${wkPts[wkLead[0]]} puan` : "Yeni hafta başladı";
  html += `<div class="board-foot"><div class="lead">${lead}</div><div class="bf-meta">${[tn,wkTxt].filter(Boolean).join(" · ")}</div></div>`;
  // sıralama değiştiyse satırlar kayarak yer değiştirsin (FLIP), öne geçenin yanında ▲ çıksın
  const before = {}; $$("#board .lb-row[data-pu]").forEach(el=>{ before[el.dataset.pu]=el.getBoundingClientRect().top; });
  const prevRank = S.prevRank || null;
  $("#board").innerHTML = html;
  const nowRank = $$("#board .lb-row[data-pu]").map(el=>el.dataset.pu);
  if(prevRank && nowRank.join()!==prevRank.join()){
    $$("#board .lb-row[data-pu]").forEach((el,i)=>{
      const u=el.dataset.pu, old=prevRank.indexOf(u);
      if(before[u]!=null){ const dy=before[u]-el.getBoundingClientRect().top; if(dy){ el.animate([{transform:`translateY(${dy}px)`},{transform:"none"}],{duration:650,easing:"cubic-bezier(.2,.8,.2,1)"}); } }
      if(old>i) el.insertAdjacentHTML("beforeend", `<span class="rk-up">▲ ${old-i}</span>`);
    });
  }
  if(nowRank.length) S.prevRank = nowRank;
  countUp();
  $("#mini").innerHTML = S.order.length<=2 && S.order.length===2 ? `<span style="color:${col(S.order[0])}">${esc(pname(S.order[0]))}</span><span class="ms tnum">${tot[S.order[0]]}–${tot[S.order[1]]}</span><span style="color:${col(S.order[1])}">${esc(pname(S.order[1]))}</span>` : "";
}

/* ====================================================== TAHMİN sekmesi */
// "3 saat sonra" gibi; 1 saatten az kaldıysa turuncu
function startsIn(g){
  const ms=g.start-Date.now(); if(ms<=0) return "";
  if(!started(g) && Math.abs(g.start-g.lock)<30*6e4) return "";   // gecenin ilk maçı: kilit halkası zaten aynı süreyi gösteriyor
  const m=Math.round(ms/6e4), h=Math.floor(m/60);
  const t = m<60 ? `${m} dk sonra` : h<24 ? `${h} saat sonra` : `${Math.floor(h/24)} gün sonra`;
  return ` <span class="starts ${m<60?"soon":""}">${t}</span>`;
}
function gameStatusTR(g){
  if(g.state==="pre") return timeTR(g.start);
  if(g.state==="post") return g.period>4 ? "Bitti (uzatma)" : "Bitti";
  if(/half/i.test(g.typeName+g.detail)) return "Devre arası";
  if(/end/i.test(g.typeName)) return g.period<=4 ? `${g.period}. çeyrek sonu` : "Uzatma sonu";
  return (g.period<=4 ? `${g.period}. çeyrek` : "Uzatma") + " " + g.clock;
}
function draftFor(g){
  if(!S.draft[g.id]){
    const p = S.days[S.day]?.picks[g.id]?.[S.uid];
    S.draft[g.id] = p ? {winner:p.winner, margin:p.margin, scorerId:p.scorerId, scorerName:p.scorerName} : {};
  }
  return S.draft[g.id];
}
function renderStatus(){
  const D = S.days[S.day]; if(!D){ $("#dayStatus").innerHTML=""; return; }
  const open = D.games.filter(g=>!started(g));
  const mine = D.games.filter(g=>D.picks[g.id]?.[S.uid]).length;
  const daily = D.daily[S.uid]||{};
  const parts = [];
  if(!D.games.length){ $("#dayStatus").innerHTML = EMPTY_NIGHT; return; }
  const pct = Math.round(mine/D.games.length*100);
  parts.push(`<span><b>${mine}/${D.games.length}</b> maçı tahmin ettin</span><span class="prog"><i style="width:${pct}%"></i></span>`);
  if(open.length){
    const missing = open.filter(g=>!D.picks[g.id]?.[S.uid]).length;
    if(missing) parts.push(`<span class="warn">${missing} maç eksik</span>`);
    if(!daily.confGame) parts.push(`<span class="warn">Banko seçilmedi</span>`);
    if(!daily.dayPlayerId && !D.games.some(started)) parts.push(`<span class="warn">Günün oyuncusu seçilmedi</span>`);
    if(!daily.q && !D.games.some(started)) parts.push(`<span class="warn">Gecenin sorusu cevaplanmadı</span>`);
    const inj = injuryAlerts(D);
    if(inj.length) parts.push(`<span class="bad">Oynamayacak: ${inj.map(esc).join(", ")}</span>`);
  }
  if(D.games.some(g=>g.seasonType===3)) parts.push(`<span class="playoff">Playoff: bütün puanlar iki katı</span>`);
  const allFinal = D.games.every(g=>g.state==="post");
  const anyPick = D.games.some(g=>Object.keys(D.picks[g.id]||{}).length);
  if(allFinal && anyPick) parts.push(`<button class="btn" id="sumBtn">Gece özeti</button>`);
  if(open.length) parts.push(`<button class="btn quick-btn" id="quickBtn" type="button">${ICON.bolt}Hızlı tahmin</button><button class="btn quick-btn" id="swipeBtn" type="button">${ICON.cards}Tek tek tahmin</button>`);
  $("#dayStatus").innerHTML = `<div class="status">${parts.join("")}</div>`;
  renderPickBar(D);
  $("#sumBtn")?.addEventListener("click", nightSummary);
  $("#quickBtn")?.addEventListener("click", openQuick);
  $("#swipeBtn")?.addEventListener("click", openSwipe);
}
function renderDayLabel(){
  const rel = S.day===S.today ? "Bugün" : S.day===shiftDay(S.today,-1) ? "Dün" : S.day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#dayLabel").innerHTML = (rel ? `${rel}<small>${dayNice(S.day)} (ABD)</small>` : `${dayNice(S.day)}<small>ABD tarihi</small>`)
    + (S.day!==S.today ? `<button class="today-chip" id="toToday" type="button">Bugüne dön</button>` : "");
  $("#toToday")?.addEventListener("click", e=>{ e.stopPropagation(); S.day=S.today; showDay?.(); render(); });
}
function renderDayPlayer(){
  const D = S.days[S.day]; if(!D?.games.length){ $("#dayPlayer").innerHTML=""; return; }
  const locked = D.games.some(started);
  const mine = D.daily[S.uid];
  if(!locked){
    $("#dayPlayer").innerHTML = `<button class="dp" id="dpBtn" style="width:100%;cursor:pointer;text-align:left">
      <span class="ico">${mine?.dayPlayerId?faceImg(mine.dayPlayerId,"dp-face"):ICON.star}</span><span class="tx"><b>Günün oyuncusu${mine?.dayPlayerName?": "+esc(mine.dayPlayerName):""}</b>
      <small>${mine?.dayPlayerName?"Değiştirmek için dokun.":`Gecenin en skorerini bilirsen ${dpValue(S.day)} puan.`} Gecenin ilk maçından 10 dk önce kilitlenir.</small></span></button>`;
    $("#dpBtn").onclick = () => openPlayerPicker({mode:"day"});
    $("#dayPlayer").insertAdjacentHTML("beforeend", questionCard());
    return;
  }
  const dpNo = S.order.filter(u=>!dayPlayerResult(S.day, u));
  const rows = S.order.filter(u=>dayPlayerResult(S.day, u)).map(u => {
    const r = dayPlayerResult(S.day, u);
    const st = r.final ? (r.hit?`<span class="ok">+${dpValue(S.day)}</span>`:`<span class="no">0</span>`) : r.leading ? `<span class="now">şu an önde</span>` : `<span class="muted">bekleniyor</span>`;
    return `<span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span>: ${esc(r.name)} ${st}`;
  }).join(" · ") + (dpNo.length ? `<span class="none-line">Seçmeyen: ${dpNo.map(u=>esc(pname(u))).join(", ")}</span>` : "");
  $("#dayPlayer").innerHTML = `<div class="dp"><span class="ico">${ICON.star}</span><span class="tx"><b>Günün oyuncusu</b><small>${rows}</small></span></div>` + questionCard();
}
function pickCell(g, pick, uid, conf){
  const r = scorePick(g, pick, conf);
  const live = g.state==="in", post = g.state==="post";
  const tops = post ? topsOf(g) : liveTops(g);
  const team = pick.winner===g.home.abbr ? g.home : g.away;
  const homeLead=(g.home.score??0)-(g.away.score??0);
  const winNow = homeLead!==0 && (homeLead>0?g.home.abbr:g.away.abbr)===pick.winner;
  // çip durumu: ok / no (bitti), nok / nno (canlı, şu anki duruma göre), boş (henüz yok)
  const st = (got, known=true) => post ? (got?"ok":"no") : live && known ? (got?"nok":"nno") : "";
  const ic = c => c==="ok"||c==="nok" ? "✓" : c==="no" ? "✗" : "";
  const chip = (txt, c, lbl, face="") => `<span class="rc ${c}${face?" has-face":""}" title="${lbl}">${ic(c)?`<i>${ic(c)}</i>`:""}${face}${txt}</span>`;
  const cW = st(winNow, homeLead!==0), cM = st(r.m>0, winNow), cS = st(r.s>0, !!tops);
  const state = live ? (winNow ? "winning" : homeLead!==0 ? "losing" : "") : "";
  const small = post ? "puan" : live ? (state==="winning"?"tutuyor":state==="losing"?"tutmuyor":"şu an") : "";
  return `<div class="prow ${state} ${!S.seen.has(g.id) && uid!==S.uid ? "reveal":""}" style="--pc:${col(uid)}">
    <span class="who">${esc(pname(uid))}${conf?' <span class="star" title="Günün bankosu">★</span>':""}</span>
    <span class="pk">${chip(esc(team.abbr||team.name), cW, "Kazanan")}${chip(pick.margin, cM, "Fark")}${chip(esc(pick.scorerName), cS, "En skorer", faceImg(pick.scorerId,"rc-face"))}</span>
    <span class="pts tnum">${(post||live)?(r.pts>0?"+":"")+r.pts:""}<small>${small}</small></span>
  </div>`;
}
// Çeyrek çeyrek skor tablosu
function lineScore(g){
  const a=g.away.ls||[], h=g.home.ls||[]; const n=Math.max(a.length,h.length);
  if(!n || g.state==="pre") return "";
  const hd=Array.from({length:n},(_,i)=>i<4?i+1:(n>5?"U"+(i-3):"UZ"));
  const cur = g.state==="in" ? n-1 : -1;
  const row=(t,arr)=>`<tr><th><img src="${t.logo||""}" alt="">${esc(t.abbr)}</th>${hd.map((_,i)=>`<td class="${i===cur?"cur":""}">${arr[i]??"–"}</td>`).join("")}<td class="tot">${t.score??""}</td></tr>`;
  return `<table class="ls"><thead><tr><th></th>${hd.map((x,i)=>`<td class="${i===cur?"cur":""}">${x}</td>`).join("")}<td class="tot">T</td></tr></thead><tbody>${row(g.away,a)}${row(g.home,h)}</tbody></table>`;
}
// Biten maç: tek satırlık küçük kart
S.open = new Set();
function compactCard(g){
  const D=S.days[S.day], my=D.picks[g.id]?.[S.uid], conf=D.daily[S.uid]?.confGame===g.id;
  const r = my ? scorePick(g, my, conf) : null;
  const side = k => { const t=g[k], o=k==="home"?g.away:g.home, lose=(t.score??0)<(o.score??0);
    return `<span class="cm-t ${lose?"lose":"win"}" style="--tc:${tcol(t.abbr)}"><img src="${t.logo||""}" alt=""><b>${esc(t.abbr)}</b><span class="sc">${t.score??""}</span></span>`; };
  const dots = r ? `<span class="cm-dots" title="Kazanan · Fark · En skorer"><i class="${r.w>0?"ok":"no"}"></i><i class="${r.m>0?"ok":"no"}"></i><i class="${r.s>0?"ok":"no"}"></i></span>` : `<span class="muted cm-none">tahmin yapmadın</span>`;
  const badge = r ? `<span class="pt-badge ${r.pts>0?"pos":r.pts<0?"neg":"zero"}">${r.pts>0?"+":""}${r.pts}</span>` : "";
  return `<article class="game compact${r && r.pts<=0 ? " miss" : ""}${g.cup?" cup":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <button class="cm" data-act="expand" data-g="${g.id}" aria-expanded="false">${side("away")}<span class="cm-sep">–</span>${side("home")}<span class="cm-r">${g.cup?`<span class="cup-mini" title="NBA Kupası">${ICON.cup}</span>`:""}${conf?'<span class="star">★</span>':""}${dots}${badge}<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span></button></article>`;
}
// Aşağı kaydırınca üstte kalan ince ilerleme şeridi (yalnızca tahmine açık gece)
function renderPickBar(D){
  const el=$("#pickBar"); if(!el) return;
  const open=D?.games.filter(g=>!started(g))||[];
  if(!open.length || S.tab!=="tahmin" || S.sub!=="maclar"){ el.innerHTML=""; el.classList.remove("show"); return; }
  const mine=D.games.filter(g=>D.picks[g.id]?.[S.uid]).length, dl=D.daily[S.uid]||{};
  const it=(ok,t)=>`<span class="${ok?"ok":"no"}">${ok?"✓":"✗"} ${t}</span>`;
  const ms=D.games[0].lock-Date.now(), h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  el.innerHTML=`<div class="wrap pb-in" title="Dokun: ilk eksik maça git"><b>${mine}/${D.games.length}</b><span class="pb-prog"><i style="width:${Math.round(mine/D.games.length*100)}%"></i></span>${it(dl.confGame,"Banko")}${it(dl.dayPlayerId,"Oyuncu")}${it(dl.q,"Soru")}<span class="pb-t">${ms>0?`${h?h+" sa ":""}${m} dk`:""}</span></div>`;
  el.classList.toggle("show", !!S.pbShow);
  el.onclick = () => { const g=open.find(x=>!D.picks[x.id]?.[S.uid]); const c=g && $(`#games [data-gid="${g.id}"]`);
    if(c){ scrollTo({top: c.getBoundingClientRect().top + scrollY - 110, behavior:"smooth"}); c.classList.add("ping"); setTimeout(()=>c.classList.remove("ping"),1200); } };
}
// Kaydedilmiş, değiştirilmemiş tahmin: tek satır (dokununca düzenlemek için açılır)
S.edit = new Set();
function isDone(g, D){
  if(started(g) || S.edit.has(g.id)) return false;
  const sv=D.picks[g.id]?.[S.uid], d=S.draft[g.id]; if(!sv) return false;
  if(d && (d.saving || (d.justSaved && Date.now()-d.justSaved<1400))) return false;
  return !d || (d.winner===sv.winner && d.margin===sv.margin && d.scorerId===sv.scorerId);
}
function pickedCard(g){
  const D=S.days[S.day], sv=D.picks[g.id][S.uid], conf=D.daily[S.uid]?.confGame===g.id;
  const tm = side => { const t=g[side], on=sv.winner===t.abbr; return `<span class="pc-tm ${on?"on":""}" style="--tc:${tcol(t.abbr)}"><img src="${t.logo||LOGO_SMALL(t.abbr)}" alt=""><b>${esc(t.abbr)}</b></span>`; };
  return `<article class="game picked${g.cup?" cup":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <button class="pk-row" data-act="edit" data-g="${g.id}"><span class="pk-time">${g.cup?`<span class="cup-mini" title="NBA Kupası · 2× puan">${ICON.cup}</span>`:""}${timeTR(g.start)}</span>${tm("away")}<span class="pk-at">@</span>${tm("home")}
      <span class="pk-sel"><span class="rc ok"><i>✓</i>${esc(sv.winner)}</span><span class="rc">${sv.margin}</span><span class="rc has-face">${faceImg(sv.scorerId,"rc-face")}${esc(surname(sv.scorerName))}</span>${conf?'<span class="rc star-chip">★</span>':""}</span>
      <span class="pk-edit">${ICON.edit}</span></button></article>`;
}
// Gece bitince en çok puan getiren tahmin
function bestPickCard(D){
  if(!D.games.length || !D.games.every(g=>g.state==="post")) return "";
  let best=null;
  for(const g of D.games) for(const u of S.order){ const p=D.picks[g.id]?.[u]; if(!p) continue;
    const r=scorePick(g,p,D.daily[u]?.confGame===g.id); if(r.pts>0 && (!best || r.pts>best.r.pts)) best={g,u,p,r}; }
  if(!best) return "";
  const {g,u,p,r}=best, team=p.winner===g.home.abbr?g.home:g.away;
  const ch=(t,ok)=>`<span class="rc ${ok?"ok":"no"}"><i>${ok?"✓":"✗"}</i>${t}</span>`;
  return `<div class="best" style="--pc:${col(u)}"><div class="best-l"><span class="best-k">Gecenin tahmini</span>${avatar(u)}</div>
    <div class="best-m"><b style="color:${col(u)}">${esc(pname(u))}</b><span class="best-g"><img src="${g.away.logo}" alt="">${esc(g.away.abbr)} ${g.away.score}–${g.home.score} ${esc(g.home.abbr)}<img src="${g.home.logo}" alt=""></span>
      <span class="pk">${ch(esc(team.abbr),r.w>0)}${ch(p.margin,r.m>0)}${ch(esc(p.scorerName),r.s>0)}${D.daily[u]?.confGame===g.id?'<span class="rc ok"><i>★</i>banko</span>':""}</span></div>
    <div class="best-p">+${r.pts}<small>puan</small></div></div>`;
}
// Kilide kalan süre halkası (6 saatten itibaren boşalır)
function ringHTML(g){
  const ms = g.lock.getTime() - Date.now();
  const f = Math.max(0, Math.min(1, ms/(6*36e5)));
  const cls = ms < 15*6e4 ? "urgent" : ms < 60*6e4 ? "warn" : "";
  const h=Math.floor(Math.max(0,ms)/36e5), m=Math.floor(Math.max(0,ms)%36e5/6e4);
  const txt = ms<=0 ? "Kilitli" : `${h?h+" sa ":""}${m} dk`;
  return `<span class="ring ${cls}" data-ring="${g.id}" title="Tahminlerin kapanmasına kalan süre"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="rt"/><circle cx="18" cy="18" r="15" class="rf" style="stroke-dashoffset:${(94.25*(1-f)).toFixed(1)}"/></svg><span>${txt}</span></span>`;
}
S.prevSc = {};
function gameCard(g){
  const D = S.days[S.day];
  const lock = started(g);
  const daily = D.daily[S.uid]||{};
  const confHere = daily.confGame===g.id;
  const confLocked = daily.confGame && D.games.find(x=>x.id===daily.confGame && started(x));
  const t = (side) => {
    const s = g[side], other = side==="home"?g.away:g.home;
    const loser = g.state==="post" && (s.score??0)<(other.score??0), winner = g.state==="post" && (s.score??0)>(other.score??0);
    const sel = (lock ? D.picks[g.id]?.[S.uid]?.winner : draftFor(g).winner)===s.abbr;
    const nm = g.state==="pre" ? esc(s.name) : `<span title="${esc(s.name)}">${s.abbr}</span>`;
    const key = g.id+side, prev = S.prevSc[key], flash = g.state==="in" && prev!=null && s.score!=null && s.score!==prev;
    if(s.score!=null) S.prevSc[key] = s.score;
    return `<button class="tbtn ${loser?"loser":""} ${winner?"winner":""}" style="--tc:${tcol(s.abbr)}" data-act="win" data-g="${g.id}" data-v="${s.abbr}" aria-pressed="${sel}" ${lock?"disabled":""}>
      <span class="tlogo"><img src="${s.logo||""}" alt=""></span><span class="tt"><b>${nm}</b>${s.rec&&g.state==="pre"?`<small class="rec">${s.rec}</small>`:""}<small class="ha">${side==="home"?ICON.home+"Ev sahibi":ICON.plane+"Deplasman"}</small></span>${g.state==="pre"?oddsTag(g,s.abbr):""}
      ${g.state!=="pre"?`<span class="sc ${flash?"flash":""}">${s.score??""}</span>`:""}</button>`;
  };
  let body = `<div class="teams">${t("away")}<span class="vs-mini">VS</span>${t("home")}</div>`;
  if(!lock){
    body += infoBox(g);
    const d = draftFor(g);
    body += `<div class="row-lbl">Fark</div>${isRules2(g) ? marginCtl(g,d,"g") : `<div class="margins">${marginsFor(g).map(m=>`<button class="mbtn" data-act="mar" data-g="${g.id}" data-v="${m}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>`}
      <div class="row-lbl">Maçın en skoreri</div>
      <button class="scorer-btn${d.scorerId?" has-face":""}" data-act="scorer" data-g="${g.id}">${d.scorerId ? `${faceImg(d.scorerId,"sb-face")}<b>${esc(d.scorerName)}</b><small>${ppg(d.scorerId)!=null?ppg(d.scorerId).toFixed(1)+" sayı ort.":""}</small>` : `<span class="ph">Oyuncu seç</span>`}</button>`;
    const saved = D.picks[g.id]?.[S.uid];
    const same = saved && saved.winner===d.winner && saved.margin===d.margin && saved.scorerId===d.scorerId;
    const missing = [!d.winner&&"kazanan", !d.margin&&"fark", !d.scorerId&&"en skorer"].filter(Boolean);
    const st = d.saving ? `<span class="muted">Kaydediliyor…</span>` : d.err ? `<span class="no">${d.err}</span>`
      : same ? `<span class="saved">✓ Kaydedildi</span>` : missing.length ? `<span class="need">Eksik: ${missing.join(", ")}</span>`
      : saved ? `<span class="need">Değişiklik kaydedilmedi</span>` : `<span class="need">Henüz kaydedilmedi</span>`;
    const canSave = !d.saving && !missing.length && !same;
    body += injuryNote(g) + seriesBox(g) + `<div class="g-foot">${st}</div>
      <button class="save-btn ${same && d.justSaved && Date.now()-d.justSaved<1500 ? "done":""}" data-act="save" data-g="${g.id}" ${canSave?"":"disabled"}>${same?'<span class="tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>Kaydedildi':saved?"Değişikliği kaydet":"Tahmini kaydet"}</button>
      <div class="lock-note">${lockLeft(g)}</div>`;
  } else {
    const rv=S.players[S.uid]?.rival, ord=[...S.order].sort((a,b)=>(b===S.uid)-(a===S.uid) || (b===rv)-(a===rv));
    const rows = ord.map(u => { const p = D.picks[g.id]?.[u]; return p ? pickCell(g, p, u, D.daily[u]?.confGame===g.id) : `<div class="prow" style="--pc:${col(u)}"><span class="who">${esc(pname(u))}</span><span class="pk muted">Tahmin yapmadı</span><span class="pts">0</span></div>`; }).join("");
    body += lineScore(g) + flowChart(g) + seriesBox(g) + shareBar(D,g) + `<div class="plist">${rows}</div>`;
    const tops = g.state==="post" ? topsOf(g) : liveTops(g);
    body += `<div class="g-foot"><span class="leaders">${tops?`En skorer: <b>${tops.map(x=>esc(x.name)).join(", ")}</b> ${tops[0].pts} sayı`:""}</span><span class="g-links">${g.state==="post"?`<button class="linkish" data-act="collapse" data-g="${g.id}">Küçült</button>`:""}<button class="linkish" data-act="box" data-g="${g.id}">İstatistikler</button></span></div>` + (g.state!=="pre" ? talkHTML(g) : "");
  }
  const conf = !lock ? `<button class="conf-btn" data-act="conf" data-g="${g.id}" aria-pressed="${confHere}" ${confLocked&&!confHere?"disabled":""} title="Günün bankosu: kazananı bilirsen +2, bilemezsen -1">★ ${confHere?"Banko":"Banko yap"}</button>`
    : confHere ? `<span class="conf-btn" aria-pressed="true">★ Banko</span>` : "";
  const dd = S.draft[g.id], sv = D.picks[g.id]?.[S.uid];
  const dirty = !lock && sv && dd && (dd.winner!==sv.winner || dd.margin!==sv.margin || dd.scorerId!==sv.scorerId);
  const missingCls = !lock && (!sv || dirty) ? " missing" : "";
  const myPick = D.picks[g.id]?.[S.uid];
  const myR = g.state==="post" && myPick ? scorePick(g, myPick, confHere) : null;
  const badge = myR ? `<span class="pt-badge ${myR.pts>0?"pos":myR.pts<0?"neg":"zero"}">${myR.pts>0?"+":""}${myR.pts}</span>` : "";
  let stt;
  if(g.state==="in"){
    const per = /half/i.test(g.typeName+g.detail) ? "Devre" : /end/i.test(g.typeName) ? (g.period<=4?`${g.period}. Ç sonu`:"UZ sonu") : g.period<=4 ? `${g.period}. Ç` : "UZ";
    const clk = /half|end/i.test(g.typeName+g.detail) ? "" : g.clock;
    stt = `<span class="badge-live">Canlı</span><span class="live-clock">${per}${clk?` <b>${clk}</b>`:""}</span>`;
  } else if(g.state==="pre") stt = `${gameStatusTR(g)}${startsIn(g)}${!lock ? ringHTML(g) : ' <span class="muted" style="font-weight:600">· Kilitli</span>'}`;
  else stt = gameStatusTR(g);
  const selAbbr = lock ? myPick?.winner : draftFor(g).winner;
  const glow = selAbbr ? `;--sel:${tcol(selAbbr)}` : "";
  return `<article class="game tex ${g.state==="in"?"is-live":""}${missingCls}${selAbbr?" has-sel":""}${g.cup?" cup":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}${glow}" data-gid="${g.id}">
    ${g.cup?`<div class="cup-band">${cupTag(g)}</div>`:""}<div class="g-head"><span class="stt">${stt}</span><span class="g-hr">${badge}${conf}</span></div>${body}</article>`;
}
// Maç önü kutusu: ESPN kazanma olasılığı + son 5 maç + sakat sayısı (özet yüklendiyse)
// bu sezon iki takımın aralarındaki son maç (arşivden)
function lastMeetHTML(g){
  const ms=Object.values(S.arch.games||{}).filter(x=>x.id!==g.id && [x.home?.abbr,x.away?.abbr].includes(g.home.abbr) && [x.home?.abbr,x.away?.abbr].includes(g.away.abbr)).sort((a,b)=>(b.start||"").localeCompare(a.start||""));
  if(!ms.length) return `<small class="ib-meet muted">Bu sezon henüz karşılaşmadılar.</small>`;
  const m=ms[0]; return `<small class="ib-meet">Son karşılaşma (${dayNice(m.day,{day:"numeric",month:"short"})}): <b>${esc(m.away.abbr)} ${m.away.score}–${m.home.score} ${esc(m.home.abbr)}</b>${ms.length>1?` · bu sezon ${ms.filter(x=>x.winner===g.away.abbr).length}-${ms.filter(x=>x.winner===g.home.abbr).length}`:""}</small>`;
}
function infoBox(g){
  if(!S.inj && !loadInj.p && !infoBox.wait){ infoBox.wait=true; later(()=>loadInj().then(()=>render()).catch(()=>{}), Math.max(0, 600-(Date.now()-S.bootAt))); }
  const s = S.sums[g.id]?.data;
  let inner = `<span class="ib-loading">Maç öncesi bilgiler yükleniyor…</span>`;
  if(s){
    const pr = s.predictor;
    const hp0 = homeProb(g); const h = hp0!=null && !isNaN(hp0) ? Math.round(hp0*100) : null, a = h!=null ? 100-h : null;
    const l5 = t => ((s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[]).map(e=>`<i class="${e.gameResult}">${e.gameResult==="W"?"G":"M"}</i>`).join("");
    const outs = t => injOfTeam(t.abbr).filter(x=>x.o);
    const outTxt = t => { const o=outs(t); return !S.inj ? "" : !o.length ? "Eksik oyuncu yok" : `Oynamıyor: ${o.slice(0,3).map(x=>esc(surname(x.n))).join(", ")}${o.length>3?` +${o.length-3}`:""}`; };
    const side = (t,p,cls) => `<div class="ib-side ${cls}"><b>${esc(t.name)}${p!=null?` %${Math.round(p)}`:""}</b><span class="ib-l5">${l5(t)||""}</span><small>${outTxt(t)}</small></div>`;
    inner = (a!=null ? `<div class="ib-bar"><i style="width:${a}%;background:${pairCols(g.away.abbr,g.home.abbr)[0]}"></i><i style="width:${h}%;background:${pairCols(g.away.abbr,g.home.abbr)[1]}"></i></div>` : "")
      + `<div class="ib-row">${side(g.away,a,"l")}${side(g.home,h,"r")}</div>` + lastMeetHTML(g);
  }
  return `<button class="info-box" data-act="info" data-g="${g.id}"><span class="ib-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Maç önü bilgileri<span class="ib-more">Ayrıntılar ›</span></span>${inner}</button>`;
}
function prefetchInfo(D){
  const need = D.games.filter(g => !started(g) && !S.sums[g.id]);
  if(!need.length || prefetchInfo.busy) return;
  prefetchInfo.busy = true;
  Promise.allSettled(need.map(g => loadSummary(g))).then(() => {
    prefetchInfo.busy = false;
    // kartları yeniden çiz ama yazılmakta olan seçimi bozma (taslaklar S.draft'ta)
    if(S.tab==="tahmin" && S.sub==="maclar" && S.days[S.day]===D) renderGames();
  });
}
// Hiç tahmin yapmamış oyuncuya ilk maçta adım adım yol gösterir
function firstPickGuide(D){
  if(lsGet("guideDone") || userRecs(S.uid).length || Object.values(S.days).some(x=>Object.values(x.picks||{}).some(p=>p[S.uid]))) return "";
  const g=D.games.find(x=>!started(x)); if(!g) return "";
  const d=draftFor(g), st=[["Kazanan takıma dokun", !!d.winner],["Farkı kaydırarak seç", !!d.margin && !d.autoM],["Maçın en skorerini seç", !!d.scorerId],["\"Tahmini kaydet\"e bas", false]];
  const i=st.findIndex(x=>!x[1]);
  return `<div class="fp-guide"><div class="fp-h"><b>İlk tahminin: ${esc(g.away.name)} @ ${esc(g.home.name)}</b><button class="linkish" id="fpX" type="button">Geç</button></div>
    <ol>${st.map(([t,ok],k)=>`<li class="${ok?"ok":k===i?"now":""}">${ok?"✓":k+1}. ${t}</li>`).join("")}</ol><small class="muted">Her doğru +1: kazanan, fark ve en skorer. Diğer maçları da aynı şekilde doldur.</small></div>`;
}
document.addEventListener("click", e=>{ if(e.target.closest("#fpX")){ lsSet("guideDone","1"); renderGames(); } });
function renderGames(){
  const D = S.days[S.day];
  if(!D){ $("#games").innerHTML = skeletonCards(); return; }
  // Küçük satırlar (tahmini yapılmış ya da bitmiş maçlar) ve büyük kartlar ayrı gruplarda:
  // böylece iki sütunlu ekranda küçük satırların yanında boşluk kalmaz.
  // Kilitten önce tahmini yapılanlar üstte; maçlar başladıktan sonra süren maçlar üstte, bitenler altta.
  const small=[], big=[];
  for(const g of D.games){
    if(g.state==="post" && !S.open.has(g.id)) small.push(compactCard(g));
    else if(isDone(g, D)) small.push(pickedCard(g));
    else big.push(gameCard(g));
  }
  const sm = small.length ? `<div class="g-small">${small.join("")}</div>` : "", bg = big.length ? `<div class="g-big">${big.join("")}</div>` : "";
  const locked = D.games.some(started);
  $("#games").innerHTML = firstPickGuide(D) + bestPickCard(D) + (locked ? bg + sm : sm + bg);
  celebrate(D);
  prefetchInfo(D);
  refreshInjuries(D);
  // açılış animasyonu bir kez oynasın
  let changed=false;
  for(const g of D.games) if(started(g) && !S.seen.has(g.id)){ S.seen.add(g.id); changed=true; }
  if(changed) try{ localStorage.setItem("seenReveal", JSON.stringify([...S.seen].slice(-400))); }catch(e){}
}
$("#games").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if(!b || b.disabled) return;
  const D = S.days[S.day]; const g = D.games.find(x=>x.id===b.dataset.g); if(!g) return;
  const d = draftFor(g);
  const act = b.dataset.act;
  if(act==="edit"){ S.edit.add(g.id); return renderGames(); }
  if(act==="expand"){ S.open.add(g.id); if(!S.sums[g.id]) loadSummary(g).then(()=>{ if(S.tab==="tahmin") renderGames(); }).catch(()=>{}); return renderGames(); }
  if(act==="emo"){ const cur=D.talk?.[g.id]?.[S.uid]?.e; return saveTalk(g,{e: cur===b.dataset.v ? "" : b.dataset.v}); }
  if(act==="talk") return openTalk(g);
  if(act==="srw"||act==="srn"){ S.seriesDraft ||= {}; const k=g.series.key; const m=D.series?.[k]?.[S.uid]; const dd=(S.seriesDraft[k] ||= {w:m?.winner, n:m?.games}); if(act==="srw") dd.w=b.dataset.v; else dd.n=+b.dataset.v; return renderGames(); }
  if(act==="srsave") return saveSeries(g);
  if(act==="collapse"){ S.open.delete(g.id); return renderGames(); }
  if(act==="info") return openInfo(g);
  if(act==="box") return openBox(g);
  if(started(g)) return toast(lockedMsg(g));
  if(act==="save"){ lsSet("guideDone","1"); return savePick(g); }
  if(act==="win"){ d.winner=b.dataset.v; if(isRules2(g) && !/^\d+$/.test(d.margin||"")){ d.margin=suggestMargin(g,d.winner); d.autoM=true; } }
  if(act==="mar"){ d.margin=b.dataset.v; }
  if(act==="scorer"){ S.swipeReturn=false; return openPlayerPicker({mode:"game", g}); }
  if(act==="conf"){
    const cur = D.daily[S.uid]?.confGame;
    if(cur===g.id) return toast("Bankoyu başka maça taşıyabilirsin; kaldırılamaz.");
    if(Date.now()>=g.nightLock.getTime()) return toast("Banko gecenin ilk maçından 10 dk önce kilitlendi.");
    return saveDaily({confGame:g.id, confStart:g.nightBase});
  }
  d.err=null; renderGames();
});


/* ====================================================== doğru tahmin anı ve skor akışı */
// Maç gözünün önünde bittiğinde (canlıdan bitti'ye geçiş) tahminin tuttuysa kart parlar, puan yukarı uçar.
S.lastState = {};
function celebrate(D){
  for(const g of D.games){
    const prev = S.lastState[g.id]; S.lastState[g.id] = g.state;
    if(prev!=="in" || g.state!=="post") continue;
    const p = D.picks[g.id]?.[S.uid]; if(!p) continue;
    const r = scorePick(g, p, D.daily[S.uid]?.confGame===g.id);
    const card = $(`#games [data-gid="${g.id}"]`); if(!card) continue;
    if(r.pts>0){
      card.classList.add("win-flash");
      const f=document.createElement("span"); f.className="pts-fly"; f.textContent=`+${r.pts}`; card.append(f);
      setTimeout(()=>{ card.classList.remove("win-flash"); f.remove(); }, 2200);
    } else card.classList.add("lose-fade");
  }
}
// Skor akışı: maç boyunca ev sahibinin farkı (üstte ev sahibi, altta deplasman önde)
const clockSec = c => { const v=String(c?.displayValue??c??""); if(v.includes(":")){ const [m,s]=v.split(":"); return +m*60 + +s; } return +v||0; };
function flowChart(g){
  if(g.state==="pre") return "";
  const plays = S.sums[g.id]?.data?.plays; if(!plays?.length) return "";
  const pts=[[0,0]]; let last=null;
  for(const p of plays){
    const per=p.period?.number||1, len=per<=4?720:300, base=per<=4?(per-1)*720:2880+(per-5)*300;
    const t=base + len - clockSec(p.clock), d=(p.homeScore??0)-(p.awayScore??0);
    if(last===null || d!==last){ pts.push([t,d]); last=d; }
  }
  const end = g.state==="post" ? Math.max(2880, pts.at(-1)[0]) : Math.max(...pts.map(x=>x[0]));
  pts.push([end, pts.at(-1)[1]]);
  const W=320, H=64, max=Math.max(8, ...pts.map(x=>Math.abs(x[1])));
  const X=t=>(t/Math.max(end,1)*W).toFixed(1), Y=d=>(H/2 - d/max*(H/2-3)).toFixed(1);
  let path=`M0 ${H/2}`; for(let i=1;i<pts.length;i++){ path+=` H${X(pts[i][0])} V${Y(pts[i][1])}`; }
  const area=path+` V${H/2} Z`;
  const [ca,ch]=pairCols(g.away.abbr,g.home.abbr);
  const qs=[720,1440,2160].filter(q=>q<end).map(q=>`<line x1="${X(q)}" x2="${X(q)}" y1="2" y2="${H-2}" class="fl-q"/>`).join("");
  const big=pts.reduce((a,b)=>Math.abs(b[1])>Math.abs(a[1])?b:a,[0,0]);
  const bigTxt = big[1] ? `En büyük fark: ${esc(big[1]>0?g.home.abbr:g.away.abbr)} +${Math.abs(big[1])}` : "";
  return `<div class="flow"><div class="fl-h"><span>Skor akışı</span><small>${bigTxt}</small></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id="flT${g.id}"><rect x="0" y="0" width="${W}" height="${H/2}"/></clipPath><clipPath id="flB${g.id}"><rect x="0" y="${H/2}" width="${W}" height="${H/2}"/></clipPath></defs>
      ${qs}<line x1="0" x2="${W}" y1="${H/2}" y2="${H/2}" class="fl-0"/>
      <path d="${area}" fill="${ch}" opacity=".35" clip-path="url(#flT${g.id})"/><path d="${area}" fill="${ca}" opacity=".35" clip-path="url(#flB${g.id})"/>
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
    <div class="fl-k"><span><i style="background:${ch}"></i>${esc(g.home.abbr)} önde</span><span><i style="background:${ca}"></i>${esc(g.away.abbr)} önde</span></div></div>`;
}

/* ====================================================== tek tek tahmin (kaydırmalı) */
S.swipeIdx = 0;
function openSwipe(){
  const D=S.days[S.day]; const games=D.games.filter(g=>!started(g));
  if(!games.length) return toast("Açık maç kalmadı.");
  const firstMissing = games.findIndex(g=>!D.picks[g.id]?.[S.uid]);
  S.swipeIdx = firstMissing>=0 ? firstMissing : 0;
  openSheet(`<div id="swipe" class="swipe"></div>`); paintSwipe();
  const el=$("#swipe"); let x0=null, y0=null;
  el.addEventListener("touchstart", e=>{ x0=e.touches[0].clientX; y0=e.touches[0].clientY; }, {passive:true});
  el.addEventListener("touchend", e=>{ if(x0==null) return; const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0; x0=null;
    if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.5) swipeGo(dx<0?1:-1); }, {passive:true});
}
function swipeGames(){ const D=S.days[S.day]; return D.games.filter(g=>!started(g)); }
function swipeGo(dir){
  const gs=swipeGames(); const n=S.swipeIdx+dir; if(n<0||n>=gs.length){ if(n>=gs.length){ closeSheet(); toast("Bütün maçları gezdin."); } return; }
  const card=$("#swipe .sw-card"); if(card){ card.classList.add(dir>0?"out-l":"out-r"); }
  setTimeout(()=>{ S.swipeIdx=n; paintSwipe(dir); }, 170);
}
function paintSwipe(dir=0){
  const box=$("#swipe"); if(!box) return;
  const D=S.days[S.day], gs=swipeGames(); if(!gs.length){ closeSheet(); return; }
  S.swipeIdx=Math.min(S.swipeIdx, gs.length-1);
  const g=gs[S.swipeIdx], d=draftFor(g), saved=D.picks[g.id]?.[S.uid];
  const same = saved && saved.winner===d.winner && saved.margin===d.margin && saved.scorerId===d.scorerId;
  const ready = d.winner && d.margin && d.scorerId;
  const team = side => { const t=g[side]; return `<button class="sw-team" style="--tc:${tcol(t.abbr)}" data-sw="win" data-v="${t.abbr}" aria-pressed="${d.winner===t.abbr}"><img src="${t.logo||LOGO_SMALL(t.abbr)}" alt=""><b>${esc(t.name)}</b>${t.rec?`<small>${t.rec}</small>`:""}<small class="ha">${side==="home"?ICON.home+"Ev sahibi":ICON.plane+"Deplasman"}</small>${oddsTag(g,t.abbr)}</button>`; };
  const dots = gs.map((x,i)=>`<i class="${i===S.swipeIdx?"on":""} ${D.picks[x.id]?.[S.uid]?"ok":""}"></i>`).join("");
  box.innerHTML = `<div class="sw-top"><b>${S.swipeIdx+1} / ${gs.length}</b><span class="sw-dots">${dots}</span></div>
    <div class="sw-card ${dir>0?"in-r":dir<0?"in-l":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}">
      <div class="sw-time">${timeTR(g.start)} · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</div>
      <div class="sw-teams">${team("away")}<span class="sw-vs">VS</span>${team("home")}</div>
      <div class="row-lbl">Fark</div>${isRules2(g) ? marginCtl(g,d,"sw") : `<div class="margins">${marginsFor(g).map(m=>`<button class="mbtn" data-sw="mar" data-v="${m}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>`}
      <div class="row-lbl">Maçın en skoreri</div>
      <button class="scorer-btn${d.scorerId?" has-face":""}" data-sw="scorer">${d.scorerId?`${faceImg(d.scorerId,"sb-face")}<b>${esc(d.scorerName)}</b>`:`<span class="ph">Oyuncu seç</span>`}</button>
      <div class="sw-st">${same?'<span class="saved">✓ Kaydedildi</span>':ready?'<span class="need">Kaydetmeye hazır</span>':'<span class="need">Kazanan, fark ve skoreri seç</span>'}</div>
    </div>
    <div class="sw-nav"><button class="btn" data-sw="prev" ${S.swipeIdx?"":"disabled"}>‹ Önceki</button>
      <button class="btn-primary" data-sw="next">${same||!ready ? (S.swipeIdx<gs.length-1?"Sonraki ›":"Bitir") : (S.swipeIdx<gs.length-1?"Kaydet ve geç ›":"Kaydet ve bitir")}</button></div>
    <small class="muted sw-hint">Kartı sağa sola kaydırarak da geçebilirsin.</small>`;
  box.onclick = async e => {
    const b=e.target.closest("[data-sw]"); if(!b || b.disabled) return;
    const a=b.dataset.sw;
    if(started(g)){ toast("Bu maçın tahminleri kilitlendi."); return paintSwipe(); }
    if(a==="win"){ d.winner=b.dataset.v; if(isRules2(g) && !/^\d+$/.test(d.margin||"")){ d.margin=suggestMargin(g,d.winner); d.autoM=true; } return paintSwipe(); }
    if(a==="mar"){ d.margin=b.dataset.v; return paintSwipe(); }
    if(a==="scorer"){ S.swipeReturn=true; return openPlayerPicker({mode:"game", g}); }
    if(a==="prev") return swipeGo(-1);
    if(a==="next"){ if(ready && !same){ await savePick(g,{quiet:true}); } swipeGo(1); }
  };
}

/* ====================================================== gecenin sorusu */
// scripts/sync.py'deki QUESTIONS ile aynı sırada olmalı (gün numarası % soru sayısı).
const topPts = g => Math.max(0, ...((g.state==="post" ? topsOf(g) : liveTops(g)) || []).map(t=>t.pts));
const gMargin = g => Math.abs((g.home.score??0)-(g.away.score??0));
const QUESTIONS = [
  {t:"Gecenin en skoreri 40 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=40, mono:true},
  {t:"Bu gece en az bir maç 20 sayı ya da daha fazla farkla biter mi?", f:gs=>Math.max(...gs.map(gMargin))>=20},
  {t:"Bu gece en az bir maç uzatmaya gider mi?", f:gs=>gs.some(g=>g.period>4), mono:true},
  {t:"Bu gece bir takım 130 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(g=>Math.max(g.home.score??0,g.away.score??0)))>=130, mono:true},
  {t:"Deplasman takımları bu gece ev sahiplerinden daha çok maç kazanır mı?", f:gs=>gs.filter(g=>(g.away.score??0)>(g.home.score??0)).length > gs.filter(g=>(g.home.score??0)>(g.away.score??0)).length},
  {t:"Bu gece en az bir maç 3 sayı ya da daha az farkla biter mi?", f:gs=>Math.min(...gs.map(gMargin))<=3},
];
// 4 Kasım 2026'dan itibaren: 21 soruluk havuz, günler sırayla döner; bir haftada (21 günde) aynı soru iki kez gelmez
const QUESTIONS2 = [
  {t:"Bu gece biri 33 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=33, mono:true},
  {t:"Bu gece en az bir maç 25 sayı ya da daha fazla farkla biter mi?", f:gs=>Math.max(...gs.map(gMargin))>=25},
  {t:"Bu gece en az bir maç uzatmaya gider mi?", f:gs=>gs.some(g=>g.period>4), mono:true},
  {t:"Bu gece bir takım 95 ya da daha az sayıda kalır mı?", f:gs=>Math.min(...gs.map(g=>Math.min(g.home.score??0,g.away.score??0)))<=95},
  {t:"Bu gece biri 45 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=45, mono:true},
  {t:"Bu gece en az bir maç 2 sayı ya da daha az farkla biter mi?", f:gs=>Math.min(...gs.map(gMargin))<=2},
  {t:"Bu gece bir takım 135 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(g=>Math.max(g.home.score??0,g.away.score??0)))>=135, mono:true},
  {t:"Deplasman takımları bu gece ev sahiplerinden daha çok maç kazanır mı?", f:gs=>gs.filter(g=>(g.away.score??0)>(g.home.score??0)).length > gs.filter(g=>(g.home.score??0)>(g.away.score??0)).length},
  {t:"Bu gece biri 38 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=38, mono:true},
  {t:"Bu gece bir maçta iki takımın toplamı 250 sayıyı geçer mi?", f:gs=>Math.max(...gs.map(g=>(g.home.score??0)+(g.away.score??0)))>=250, mono:true},
  {t:"Bu gece en az iki maç 15 sayı ya da daha fazla farkla biter mi?", f:gs=>gs.filter(g=>gMargin(g)>=15).length>=2},
  {t:"Bu gece en az iki maç uzatmaya gider mi?", f:gs=>gs.filter(g=>g.period>4).length>=2, mono:true},
  {t:"Bu gece biri 50 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=50, mono:true},
  {t:"Ev sahipleri bu gece bütün maçlarını kazanır mı?", f:gs=>gs.every(g=>(g.home.score??0)>(g.away.score??0))},
  {t:"Bu gece en az bir maç 30 sayı ya da daha fazla farkla biter mi?", f:gs=>Math.max(...gs.map(gMargin))>=30},
  {t:"Bu gece bir takım 130 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(g=>Math.max(g.home.score??0,g.away.score??0)))>=130, mono:true},
  {t:"Bu gece en az bir maç 5 sayı ya da daha az farkla biter mi?", f:gs=>Math.min(...gs.map(gMargin))<=5},
  {t:"Gecenin en skoreri 40 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=40, mono:true},
  {t:"Bu gece bir maçta iki takımın toplamı 205 sayının altında kalır mı?", f:gs=>Math.min(...gs.map(g=>(g.home.score??0)+(g.away.score??0)))<205},
  {t:"Ev sahipleri bu gece deplasman takımlarından daha çok maç kazanır mı?", f:gs=>gs.filter(g=>(g.home.score??0)>(g.away.score??0)).length > gs.filter(g=>(g.away.score??0)>(g.home.score??0)).length},
  {t:"Bu gece bir takım 140 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(g=>Math.max(g.home.score??0,g.away.score??0)))>=140, mono:true},
];
/* Q3 START */
// 5 Kasım 2026'dan itibaren: eşikler gecenin maç sayısına göre seçilir, cevap yaklaşık yarı yarıya olsun diye.
// Oranlar sezonun ilk maçlarından; scripts/sync.py'deki QUESTIONS3 ile birebir aynı sıra ve aynı hesap.
const Q3_FROM = "20261105";
const qpw = (x,i) => { let r=1; for(let j=0;j<i;j++) r*=x; return r; };
const qAny = (q,n) => 1-qpw(1-q,n);
function qAtLeast(p,n,k){ let s=0; for(let i=k;i<=n;i++){ let c=1; for(let j=0;j<i;j++) c=c*(n-j)/(j+1); s+=c*qpw(p,i)*qpw(1-p,n-i); } return s; }
const qH = g => g.home.score??0, qA = g => g.away.score??0;
const qC = (k,n) => k===n ? (n===1 ? "Bu geceki tek maçta" : "Bu gece bütün maçlarda") : k===1 ? "Bu gece en az bir maçta" : `Bu gece en az ${k} maçta`;
const qE = (k,n) => k===n ? (n===1 ? "in tonight's only game" : "in every game tonight") : k===1 ? "in at least one game tonight" : `in at least ${k} games tonight`;
const QK = (p, ev, tr, en, mono=false) => ({kind:"k", p, ev, tr, en, mono});
const QX = (tab, ev, tr, en, mono=false) => ({kind:"x", tab, ev, tr, en, mono});
const QUESTIONS3 = [
  QX([[30,.505],[32,.421],[34,.355],[36,.252],[38,.196],[40,.14],[42,.103],[44,.056],[46,.03],[50,.012]], (g,x)=>topPts(g)>=x, x=>`Bu gece biri ${x} ya da daha fazla sayı atar mı?`, x=>`Will anyone score ${x}+ tonight?`, true),
  QK(.514, g=>qH(g)>qA(g), c=>`${c} ev sahibi kazanır mı?`, e=>`Will the home team win ${e}?`),
  QX([[10,.542],[15,.355],[20,.252],[25,.131],[30,.075],[35,.04],[40,.025]], (g,x)=>gMargin(g)>=x, x=>`Bu gece en az bir maç ${x} sayı ya da daha fazla farkla biter mi?`, x=>`Will a game end with a ${x}+ point margin tonight?`),
  QK(.449, g=>qH(g)+qA(g)>=230, c=>`${c} iki takımın toplamı 230 sayı ya da daha fazla olur mu?`, e=>`Will the combined score reach 230+ ${e}?`, true),
  QX([[10,.495],[8,.421],[7,.346],[6,.252],[5,.206],[4,.131],[3,.075],[2,.04],[1,.028]], (g,x)=>gMargin(g)<=x, x=>`Bu gece en az bir maç ${x} sayı ya da daha az farkla biter mi?`, x=>`Will a game be decided by ${x} points or fewer tonight?`),
  QK(.505, g=>topPts(g)>=30, c=>`${c} 30 ya da daha fazla sayı atan bir oyuncu çıkar mı?`, e=>`Will someone score 30+ ${e}?`, true),
  QX([[115,.682],[120,.561],[125,.374],[130,.196],[135,.084],[140,.025],[145,.01]], (g,x)=>Math.max(qH(g),qA(g))>=x, x=>`Bu gece bir takım ${x} ya da daha fazla sayı atar mı?`, x=>`Will a team score ${x}+ tonight?`, true),
  QK(.542, g=>gMargin(g)>=10, c=>`${c} fark 10 sayı ya da daha fazla olur mu?`, e=>`Will the margin be 10+ points ${e}?`),
  QX([[110,.598],[105,.477],[100,.308],[95,.187],[90,.084],[85,.04]], (g,x)=>Math.min(qH(g),qA(g))<=x, x=>`Bu gece bir takım ${x} ya da daha az sayıda kalır mı?`, x=>`Will a team score ${x} or fewer tonight?`),
  QK(.561, g=>Math.max(qH(g),qA(g))>=120, c=>`${c} bir takım 120 sayıya ulaşır mı?`, e=>`Will a team reach 120 points ${e}?`, true),
  QX([[220,.636],[230,.449],[240,.262],[250,.121],[260,.05],[270,.02]], (g,x)=>qH(g)+qA(g)>=x, x=>`Bu gece bir maçta iki takımın toplamı ${x} sayı ya da daha fazla olur mu?`, x=>`Will a game total ${x}+ points tonight?`, true),
  QK(.346, g=>gMargin(g)<=7, c=>`${c} fark 7 sayı ya da daha az olur mu?`, e=>`Will the margin be 7 points or fewer ${e}?`),
  QK(.486, g=>qA(g)>qH(g), c=>`${c} deplasman takımı kazanır mı?`, e=>`Will the road team win ${e}?`),
  QX([[230,.55],[225,.439],[220,.393],[215,.318],[210,.206],[205,.131],[200,.093],[195,.075]], (g,x)=>qH(g)+qA(g)<=x, x=>`Bu gece bir maçta iki takımın toplamı ${x} sayı ya da daha az olur mu?`, x=>`Will a game total ${x} points or fewer tonight?`),
  QK(.308, g=>Math.min(qH(g),qA(g))<=100, c=>`${c} kaybeden takım 100 ya da daha az sayıda kalır mı?`, e=>`Will the losing team score 100 or fewer ${e}?`),
  QK(.28, g=>topPts(g)>=35, c=>`${c} 35 ya da daha fazla sayı atan bir oyuncu çıkar mı?`, e=>`Will someone score 35+ ${e}?`, true),
  QK(.355, g=>gMargin(g)>=15, c=>`${c} fark 15 sayı ya da daha fazla olur mu?`, e=>`Will the margin be 15+ points ${e}?`),
  QK(.374, g=>Math.max(qH(g),qA(g))>=125, c=>`${c} bir takım 125 sayıya ulaşır mı?`, e=>`Will a team reach 125 points ${e}?`, true),
  QK(.43, g=>Math.min(qH(g),qA(g))>=110, c=>`${c} iki takım da 110 sayıya ulaşır mı?`, e=>`Will both teams reach 110 points ${e}?`, true),
  QK(.262, g=>qH(g)+qA(g)>=240, c=>`${c} iki takımın toplamı 240 sayı ya da daha fazla olur mu?`, e=>`Will the combined score reach 240+ ${e}?`, true),
  QK(.318, g=>qH(g)+qA(g)<=215, c=>`${c} iki takımın toplamı 215 sayı ya da daha az olur mu?`, e=>`Will the combined score be 215 or fewer ${e}?`),
];
// Eşik (x) ya da maç sayısı (k): "evet" ihtimali %50'ye en yakın olan; eşitlikte listedeki ilki
function q3Param(def, n){
  let best=null, bd=9;
  if(def.kind==="x"){ for(const [v,q] of def.tab){ const d=Math.abs(qAny(q,n)-0.5); if(d<bd-1e-9){ bd=d; best=v; } } }
  else for(let k=1;k<=n;k++){ const d=Math.abs(qAtLeast(def.p,n,k)-0.5); if(d<bd-1e-9){ bd=d; best=k; } }
  return best;
}
function q3Build(def, n){
  n=Math.max(1,n||0); const v=q3Param(def,n);
  if(def.kind==="x") return {t:UI_EN?def.en(v):def.tr(v), f:gs=>gs.some(g=>def.ev(g,v)), mono:def.mono, n};
  return {t:UI_EN?def.en(qE(v,n)):def.tr(qC(v,n)), f:gs=>gs.filter(def.ev).length>=v, mono:def.mono, n};
}
/* Q3 END */
const dayNum = d => Math.round(Date.UTC(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8))/864e5);
const questionOf = day => { day=String(day);
  if(day>=Q3_FROM) return q3Build(QUESTIONS3[dayNum(day) % QUESTIONS3.length], S.days[day]?.games?.length);
  return day>=RULES2_FROM ? QUESTIONS2[dayNum(day) % QUESTIONS2.length] : QUESTIONS[Number(day) % QUESTIONS.length]; };
// {final, ans:'y'|'n', early:true (gece bitmeden kesinleşti)}
function questionResult(day){
  const D=S.days[day]; if(!D?.games.length) return null;
  const q=questionOf(day), done=D.games.every(g=>g.state==="post");
  const going=D.games.filter(g=>g.state!=="pre");
  if(done) return {final:true, ans:q.f(D.games)?"y":"n"};
  if(q.mono && going.length && q.f(going)) return {final:true, ans:"y", early:true};
  return {final:false};
}
function questionCard(){
  const D=S.days[S.day]; if(!D?.games.length) return "";
  const q=questionOf(S.day), locked=D.games.some(started), mine=D.daily[S.uid]?.q;
  const lbl = v => v==="y" ? "Evet" : "Hayır";
  // cevap verildiyse düğmeler gizlenir; "Değiştir" ile yeniden açılır
  if(!locked && mine && !S.qEdit) return `<div class="qcard q-done"><span class="ico">${ICON.question}</span><span class="tx"><b>Gecenin sorusu</b><span class="qt">${q.t}</span>
    <span class="q-ans"><span>Cevabın: <b>${lbl(mine)}</b></span><button class="linkish" data-qedit type="button">Değiştir</button></span>
    <small>Gecenin ilk maçından 10 dk önceye kadar değiştirebilirsin.</small></span></div>`;
  if(!locked) return `<div class="qcard"><span class="ico">${ICON.question}</span><span class="tx"><b>Gecenin sorusu</b><span class="qt">${q.t}</span>
    <span class="qbtns"><button data-q="y" aria-pressed="${mine==="y"}">Evet</button><button data-q="n" aria-pressed="${mine==="n"}">Hayır</button></span>
    <small>Doğru cevap +1. Gecenin ilk maçından 10 dk önce kilitlenir.</small>${q.n?`<small>${q.n} maçlık gece; eşik, cevap yarı yarıya olsun diye maç sayısına göre seçildi.</small>`:""}</span></div>`;
  const r=questionResult(S.day);
  const qNo=S.order.filter(u=>!D.daily[u]?.q);
  const rows=S.order.filter(u=>D.daily[u]?.q).map(u=>{ const a=D.daily[u].q; const st=r?.final?(a===r.ans?'<span class="ok">+1</span>':'<span class="no">0</span>'):"";
    return `<span><b style="color:${col(u)}">${esc(pname(u))}</b> ${lbl(a)} ${st}</span>`; }).join("") + (qNo.length ? `<span class="none-line">Cevaplamayan: ${qNo.map(u=>esc(pname(u))).join(", ")}</span>` : "");
  return `<div class="qcard"><span class="ico">${ICON.question}</span><span class="tx"><b>Gecenin sorusu</b><span class="qt">${q.t}</span>
    ${r?.final?`<span class="qres">Cevap: <b>${lbl(r.ans)}</b></span>`:""}<span class="qrows">${rows}</span></span></div>`;
}
$("#dayPlayer").addEventListener("click", e => {
  if(e.target.closest("[data-qedit]")){ S.qEdit=true; return render(); }
  const b=e.target.closest("[data-q]"); if(!b) return;
  const D=S.days[S.day]; if(D.games.some(started)) return toast("Soru kilitlendi (gecenin ilk maçından 10 dk önce).");
  S.qEdit=false; saveDaily({q:b.dataset.q});
});

/* ====================================================== küfür koruması (sohbet, maç yorumları) */
// Harf oyunları (0→o, 1→i, 4→a, $→s…), tekrarlanan harfler (amkkk), aralara konan nokta/boşluk (a.m.k, a m k),
// s yerine z/x (zikeyim), "s2m" türü yazımlar ve kısaltmalar (amk, aq, oç, sg, mk, sktr…) yakalanır.
// Firebase kuralları da en bariz olanları ayrıca engeller, yani site atlatılarak da yazılamaz.
const CH_F = s => s.toLocaleLowerCase("tr").replace(/\S+/g, w => /[a-zçğışöüâîû]/.test(w) ? w.replace(/[0-9@$!|€]/g, c=>LEET[c]) : " ").normalize("NFD").replace(/[\u0300-\u036f]/g,"");   // ı korunur
const CH_SQ = s => s.replace(/(.)\1+/g, "$1");
// kelime bu köklerle BAŞLIYORSA yasak (tekrarlı harfler sadeleştirilmiş hâliyle)
const CH_ROOT = ["amcik","amck","amcuk","amina","amini","aminda","amindan","aminoglu","amk","amq","aq","awk","orospu","orosbu","oruspu","orspu","orsp","orosp","orostop",
  "yarak","yarag","yrak","yarram","yaramin","dalyarak","daltasak","tasak","tasag","dasak","dasag","pezeven","pezevek","pzvnk","pzv","kahpe","kaltak","kevase","fahise",
  "gavat","gavad","yavsak","yavsag","yavusak","serefsiz","srfsz","surtuk","ibne","ipne","ibine","ibina","pust","godos","gotveren","gotelek","gotlek","gotlalesi","gotos","gotun","gotune",
  "siktir","sikti","siker","sikey","sikim","sikik","sikis","sikiy","sikin","sikip","sikme","sikmi","sikse","siksin","sikec","sikic","sikiir","sikiim","sikko","siko","sike",
  "sktr","sktir","skerim","skeyim","skiyim","skrm","skim","skem","skcem","skecem","sksin","sksn","skyim","skym","hsktr","hasiktir","zikey","zikim","zikik","zikiim","ziker","xik",
  "ananisik","ananizi","anasini","anasinin","avradin","bacini","bacina","sulalen","ecdadini","veledizina","weledizina","itoglu",
  "fuck","fuk","motherf","madafak","bitch","biatch","cunt","whore","slut","nigg","fagg","asshole","pussy","dick","porn","bok"];
// yalnızca TEK BAŞINA kelime olarak yasak olanlar (başka kelimelerin içinde de geçtikleri için)
const CH_WORD = new Set(["am","amn","amm","amna","mk","mq","oc","ocuu","pic","pici","picin","picler","sg","sie","sik","skm","sker","yrk","yrrk","anan","anani","ananin","anana","ananiz","ebeni","ebenin","got","gt","gtn","gtne","pic","sex","seks","boka","boku","bokum","boktan","fck","wtf"]);
// zararsız olup köklerle başlayan kelimeler
const CH_OK = /^(fukara|sikke|sikkel|sikil|sikint|sikisik|sikistir|sikca|amk?ca|aqua|bokser|boks|dicke?ns|picnic|pick|pust?ula|siko?loj|godoss?$)/;
// birleşik (boşluksuz) metinde aranacak, kelime aralarına bölünse de yakalanacak uzun kökler
const CH_JOIN = ["orospu","siktir","amcik","aminakoy","aminako","pezevenk","serefsiz","ananisik","anasinisik","gotveren","dalyarak","motherfuck","fuck"];
function chatProblem(t){
  if(!t) return false;
  const low=t.toLocaleLowerCase("tr");
  if(/(^|[^a-z0-9])s+2+[a-zçğışöü]/.test(low) || /🖕/u.test(t)) return true;          // s2m, s2k, orta parmak
  const f1=CH_F(t), f2=f1.replace(/ı/g,"i");
  const words = f2.split(/[^a-z]+/).filter(Boolean);
  // a.m.k / a m k gibi tek harflere bölünmüş yazım: art arda gelen tek harfleri birleştir
  const runs=[]; let cur="";
  for(const w of f2.split(/[^a-z]+/)){ if(w.length===1) cur+=w; else { if(cur.length>1) runs.push(cur); cur=""; } }
  if(cur.length>1) runs.push(cur);
  // "sık-" ile başlayan zararsız kelimeler (sıkıldım, sıkıcı) Türkçe harfle yazılınca engellenmesin
  const sikOk = new Set(f1.split(/[^a-zı]+/).filter(w=>/^s[ıi]*k/.test(w) && w.includes("ı")).map(w=>w.replace(/ı/g,"i")));
  const all=[...words, ...runs];
  for(let i=0;i<all.length;i++){
    const w=all[i], q=CH_SQ(w);
    if(CH_OK.test(w) || sikOk.has(w)) continue;
    if(q==="am" && i>0 && all[i-1]==="i") continue;                      // İngilizce "I am"
    if(CH_WORD.has(w) || CH_WORD.has(q)) return true;
    if(CH_ROOT.some(r=>q.startsWith(CH_SQ(r)) || w.startsWith(r))) return true;
  }
  const joined=CH_SQ(f2.replace(/[^a-z]/g,""));
  return CH_JOIN.some(x=>joined.includes(CH_SQ(x)));
}

/* ====================================================== laf atma */
const TALK_EMOJI = ["😂","🔥","🤡","😱","👏","💀","🎯","🙏"];
const textProblem = t => chatProblem(t);
// Hakkında satırı için ek kontrol: argo / hakaret kökleri (harf oyunlarına karşı sadeleştirilmiş metinde aranır)
const BIO_BAD = ["salak","aptal","gerizekal","mal ","dangalak","pic","pust","kodum","gavat","yavsak","serefsiz","orospu","sik","amk","aq ","oc ","got","yarak","yarrak","ibne","kahpe","pezevenk","fuck","shit","bitch","dick","pussy","bastard"];
function bioProblem(t){
  const f=" "+foldName(t).replace(/[^a-z]+/g," ")+" ", joined=squeeze(foldName(t).replace(/[^a-z]/g,""));
  return BIO_BAD.some(w=> w.endsWith(" ") ? f.includes(" "+w) : (w.length>=4 ? joined.includes(w) : f.includes(" "+w+" ")));
}
function talkHTML(g){
  const D=S.days[S.day], T=D.talk?.[g.id]||{};
  const list=S.order.filter(u=>T[u] && (T[u].e||T[u].t)).map(u=>`<div class="tk">${avatar(u,"xs")}<span><b style="color:${col(u)}">${esc(pname(u))}</b>${T[u].e?` <span class="tk-e">${T[u].e}</span>`:""}${T[u].t?` ${esc(T[u].t)}`:""}</span></div>`).join("");
  const me=T[S.uid]||{};
  return `<div class="talk">${list}<div class="tk-bar">${TALK_EMOJI.map(e=>`<button data-act="emo" data-g="${g.id}" data-v="${e}" aria-pressed="${me.e===e}">${e}</button>`).join("")}
    <button class="tk-write" data-act="talk" data-g="${g.id}">${me.t?"Yorumunu değiştir":"Yorum yaz"}</button></div></div>`;
}
async function saveTalk(g, patch){
  const D=S.days[S.day], cur=D.talk?.[g.id]?.[S.uid]||{e:"",t:""};
  const data={uid:S.uid, gid:g.id, day:S.day, e:cur.e||"", t:cur.t||"", ...patch, at:serverTimestamp()};
  (D.talk[g.id] ||= {})[S.uid] = data; renderGames();
  try{ await setDoc(doc(S.db,"talk",`${g.id}_${S.uid}`), data); }catch(e){ toast("Gönderilemedi, tekrar dene."); }
}
function openTalk(g){
  const cur=S.days[S.day].talk?.[g.id]?.[S.uid]?.t||"";
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} – ${esc(g.home.name)}</h3><p class="muted">En fazla 80 karakter. Herkes görür.</p>
    <textarea id="tkIn" maxlength="80" rows="2" class="tk-in" placeholder="Bir şey yaz…">${esc(cur)}</textarea><p class="err" id="tkErr"></p>
    <div style="display:flex;gap:8px"><button class="btn-primary" id="tkSend" type="button">Gönder</button>${cur?'<button class="btn" id="tkDel" type="button">Sil</button>':""}</div>`);
  $("#tkIn").focus();
  $("#tkSend").onclick=()=>{ const t=$("#tkIn").value.trim(); if(textProblem(t)){ $("#tkErr").textContent="Küfür ve hakaret yazılamaz."; return; } closeSheet(); saveTalk(g,{t}); };
  $("#tkDel")?.addEventListener("click",()=>{ closeSheet(); saveTalk(g,{t:""}); });
}

/* ====================================================== sakatlık uyarısı */
// Seçtiğin skorer ya da günün oyuncusu ESPN'e göre oynamıyorsa / belirsizse uyar
S.rosterAt = {};
// Açılışta acil olmayan işler: ilk ekran çizildikten sonra, tarayıcı boşalınca
S.bootAt = Date.now();
const later = (fn, ms=600) => setTimeout(()=>{ if("requestIdleCallback" in window) requestIdleCallback(()=>fn(), {timeout:800}); else fn(); }, ms);
async function refreshInjuries(D){
  if(refreshInjuries.busy) return;
  if(Date.now()-S.bootAt < 800){ if(!refreshInjuries.wait){ refreshInjuries.wait=true; later(()=>{ refreshInjuries.wait=false; refreshInjuries(D); }, 800); } return; }
  const open=D.games.filter(g=>!started(g)); if(!open.length) return;
  const teams=open.flatMap(g=>[g.away,g.home]).filter(t=>!S.rosterAt[t.id] || Date.now()-S.rosterAt[t.id]>20*60e3);
  if(!teams.length) return;
  refreshInjuries.busy=true;
  await loadInj(true).catch(()=>{});
  await Promise.allSettled(teams.map(t=>{ delete S.rosters[t.id]; return loadRoster(t).then(()=>{ S.rosterAt[t.id]=Date.now(); }); }));
  refreshInjuries.busy=false;
  if(S.days[S.day]===D) render();
}
function injuryOf(pid, teams){
  if(!pid || !S.inj) return null;
  const i=S.inj[pid]; return i ? (i.o ? "out" : "doubt") : "ok";
}
function injuryNote(g){
  const d=draftFor(g); if(!d.scorerId || started(g)) return "";
  const st=injuryOf(d.scorerId,[g.away,g.home]);
  if(st==="out") return `<div class="inj-warn"><b>${esc(d.scorerName)} bu maçta oynamıyor.</b> Skorer seçimini değiştirmen iyi olur.</div>`;
  if(st==="doubt") return `<div class="inj-warn soft"><b>${esc(d.scorerName)}</b> için oynayıp oynamayacağı belirsiz.</div>`;
  return "";
}
function injuryAlerts(D){
  const out=[];
  for(const g of D.games){ if(started(g)) continue; const p=D.picks[g.id]?.[S.uid]; if(p && injuryOf(p.scorerId,[g.away,g.home])==="out") out.push(p.scorerName); }
  const dp=D.daily[S.uid]; if(dp?.dayPlayerId && !D.games.some(started) && injuryOf(dp.dayPlayerId, D.games.flatMap(g=>[g.away,g.home]))==="out") out.push(dp.dayPlayerName+" (günün oyuncusu)");
  return out;
}

/* ====================================================== playoff seri tahmini */
function seriesBox(g){
  const sr=g.series; if(!sr) return "";
  const D=S.days[S.day], picks=D.series?.[sr.key]||{}, mine=picks[S.uid];
  const [a,b]=[g.away,g.home];
  const score=`${esc(a.abbr)} ${sr.wins[a.abbr]??0}–${sr.wins[b.abbr]??0} ${esc(b.abbr)}`;
  const openPick = !started(g) && (sr.wins[a.abbr]??0)+(sr.wins[b.abbr]??0)===0;
  const res = S.arch.scores.series?.[sr.key];
  let body;
  if(openPick){
    const d = S.seriesDraft?.[sr.key] || {w:mine?.winner, n:mine?.games};
    body = `<div class="sr-pick"><span class="sr-q">Seriyi kim, kaç maçta alır? Kazananı bilirsen +3, maç sayısını da bilirsen +2 daha.</span>
      <div class="sr-row">${[a,b].map(t=>`<button data-act="srw" data-g="${g.id}" data-v="${t.abbr}" aria-pressed="${d.w===t.abbr}"><img src="${t.logo}" alt="">${esc(t.abbr)}</button>`).join("")}</div>
      <div class="sr-row">${[4,5,6,7].map(n=>`<button data-act="srn" data-g="${g.id}" data-v="${n}" aria-pressed="${+d.n===n}">${n} maç</button>`).join("")}</div>
      <button class="btn" data-act="srsave" data-g="${g.id}" ${d.w&&d.n&&!(mine&&mine.winner===d.w&&mine.games===+d.n)?"":"disabled"}>${mine&&mine.winner===d.w&&mine.games===+d.n?"✓ Kaydedildi":"Seri tahminini kaydet"}</button></div>`;
  } else {
    body = `<div class="sr-list">${S.order.map(u=>{ const p=picks[u]; const r=res?.row?.[u];
      return `<span><b style="color:${col(u)}">${esc(pname(u))}</b> ${p?`${esc(p.winner)}, ${p.games} maçta`:'<span class="muted">tahmin yapmadı</span>'}${r?` <span class="${r.pts>0?"ok":"no"}">${r.pts>0?"+"+r.pts:"0"}</span>`:""}</span>`; }).join("")}</div>`;
  }
  return `<div class="series"><div class="sr-h"><span>Playoff serisi</span><b>${score}</b>${res?`<small>${esc(res.winner)} ${res.games} maçta kazandı</small>`:""}</div>${body}</div>`;
}
async function saveSeries(g){
  const sr=g.series, d=S.seriesDraft?.[sr.key]; if(!d?.w || !d?.n) return;
  const D=S.days[S.day], prev=D.series?.[sr.key]?.[S.uid];
  const data={uid:S.uid, key:sr.key, winner:d.w, games:+d.n, start: prev?.start || Timestamp.fromDate(g.lock), updatedAt:serverTimestamp()};
  try{ await setDoc(doc(S.db,"series",`${sr.key}_${S.uid}`), data); (D.series[sr.key] ||= {})[S.uid]=data; toast(pick(["Seri tahminin kaydedildi.","Seri tahminin alındı.","Kaydedildi, seri başlasın."])); }
  catch(e){ toast("Kaydedilemedi, seri başlamış olabilir."); }
  renderGames();
}

/* ====================================================== hızlı tahmin */
// Bütün açık maçlar tek ekranda. Takım seçince fark (ESPN olasılığına göre) ve skorer (takımın sayı lideri) önerisi dolar.
// Fark kaydırıcısı: 1-40 (40 = 40 ve üstü)
function marginCtl(g, d, ctx){
  const v = /^\d+$/.test(d.margin||"") ? +d.margin : null;
  return `<div class="mslide ${v==null?"ms-none":""}"><input type="range" min="1" max="${MARGIN_MAX}" step="1" value="${v??8}" data-ms="${g.id}" data-ctx="${ctx}" aria-label="Fark">
    <output>${v==null?"Kaydır":v>=MARGIN_MAX?`${MARGIN_MAX}+ sayı`:`${v} sayı`}</output></div><small class="ms-hint">Gerçek farka ${MARGIN_TOL} sayı ya da daha yakınsan +1</small>`;
}
document.addEventListener("input", e=>{ const r=e.target.closest?.("[data-ms]"); if(!r) return; const v=+r.value; const o=r.parentElement.querySelector("output"); if(o) o.textContent = v>=MARGIN_MAX?`${MARGIN_MAX}+ sayı`:`${v} sayı`; r.parentElement.classList.remove("ms-none"); });
document.addEventListener("change", e=>{ const r=e.target.closest?.("[data-ms]"); if(!r) return; const D=S.days[S.day]; const g=D?.games.find(x=>x.id===r.dataset.ms); if(!g) return;
  if(started(g)){ toast(lockedMsg(g)); return; } const d=draftFor(g); d.margin=String(r.value); d.autoM=false;
  if(r.dataset.ctx==="sw") paintSwipe(); else if(r.dataset.ctx==="qk") paintQuick(); else renderGames(); });
function suggestMargin(g, abbr){
  const pr=S.sums[g.id]?.data?.predictor; const side = abbr===g.home.abbr ? pr?.homeTeam : pr?.awayTeam;
  const p = side?.gameProjection!=null ? +side.gameProjection : null;
  if(isRules2(g)) return String(p==null||p<55 ? 5 : p<62 ? 7 : p<70 ? 10 : p<80 ? 14 : 19);
  if(p==null || p<55) return "1-5";
  return p<68 ? "6-10" : p<80 ? "11-15" : "16+";
}
function teamTop(g, abbr){
  const t = abbr===g.home.abbr ? g.home : g.away;
  return (S.rosters[t.id]||[]).filter(p=>!S.inj?.[p.id]?.o).map(p=>({...p, ppg:ppg(p.id)})).sort((a,b)=>(b.ppg??-1)-(a.ppg??-1)).slice(0,8);
}
async function openQuick(){
  const D=S.days[S.day], games=D.games.filter(g=>!started(g));
  if(!games.length) return toast("Açık maç kalmadı.");
  openSheet(`<h3 id="shTitle">Hızlı tahmin</h3><p class="muted">Kadrolar yükleniyor…</p>`);
  await Promise.allSettled([...games.flatMap(g=>[g.away,g.home]).map(t=>loadRoster(t)), ...games.filter(g=>!S.sums[g.id]).map(g=>loadSummary(g))]);
  paintQuick();
}
function paintQuick(){
  const D=S.days[S.day], games=D.games.filter(g=>!started(g)); const box=$("#shBody"); if(!box) return;
  const rows=games.map(g=>{
    const d=draftFor(g), sv=D.picks[g.id]?.[S.uid];
    const same = sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId;
    const team = t => `<button class="qk-t ${d.winner===t.abbr?"on":""}" style="--tc:${tcol(t.abbr)}" data-qw="${t.abbr}" data-g="${g.id}"><img src="${t.logo}" alt="">${esc(t.abbr)}${oddsTag(g,t.abbr)}</button>`;
    const opts = d.winner ? teamTop(g,d.winner) : [];
    const sel = d.winner ? `<select class="qk-s" data-qs="${g.id}">${d.scorerId && !opts.some(o=>o.id===d.scorerId) ? `<option value="${d.scorerId}" selected>${esc(d.scorerName)}</option>` : ""}${opts.map(o=>`<option value="${o.id}" ${o.id===d.scorerId?"selected":""}>${esc(o.name)}${o.ppg!=null?` · ${o.ppg.toFixed(1)}`:""}</option>`).join("")}</select>` : `<span class="muted qk-hint">Önce kazananı seç</span>`;
    return `<div class="qk ${same?"saved":d.winner?"dirty":""}"><div class="qk-h"><span>${timeTR(g.start)}</span><span>${same?'<span class="ok">✓ Kaydedildi</span>':d.winner&&d.margin&&d.scorerId?'<span class="need">Kaydedilmedi</span>':""}</span></div>
      <div class="qk-teams">${team(g.away)}<span class="qk-at">@</span>${team(g.home)}</div>
      ${d.winner?(isRules2(g) ? marginCtl(g,d,"qk") : `<div class="qk-m">${marginsFor(g).map(m=>`<button data-qm="${m}" data-g="${g.id}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>`):""}${sel}</div>`;
  }).join("");
  const ready=games.filter(g=>{ const d=draftFor(g), sv=D.picks[g.id]?.[S.uid]; return d.winner&&d.margin&&d.scorerId && !(sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId); }).length;
  box.innerHTML=`<h3 id="shTitle">Hızlı tahmin</h3><p class="muted">Kazananı seç; fark ESPN olasılığına göre, skorer takımın sayı liderine göre önerilir. İstersen değiştir, sonra hepsini birden kaydet.</p>
    <div class="qk-list">${rows}</div>
    <div class="qk-bar"><button class="btn-primary" id="qkSave" ${ready?"":"disabled"}>${ready?`${ready} tahmini kaydet`:"Kaydedilecek değişiklik yok"}</button></div>`;
  box.onclick=e=>{
    const w=e.target.closest("[data-qw]"), m=e.target.closest("[data-qm]");
    if(w){ const g=D.games.find(x=>x.id===w.dataset.g), d=draftFor(g); if(started(g)) return;
      const changed=d.winner!==w.dataset.qw; d.winner=w.dataset.qw;
      if(!d.margin || d.autoM){ d.margin=suggestMargin(g,d.winner); d.autoM=true; }
      if(!d.scorerId || (d.autoS && changed)){ const top=teamTop(g,d.winner)[0]; if(top){ d.scorerId=top.id; d.scorerName=top.name; d.autoS=true; } }
      return paintQuick(); }
    if(m){ const g=D.games.find(x=>x.id===m.dataset.g), d=draftFor(g); d.margin=m.dataset.qm; d.autoM=false; return paintQuick(); }
  };
  box.onchange=e=>{ const s=e.target.closest("[data-qs]"); if(!s) return; const g=D.games.find(x=>x.id===s.dataset.qs), d=draftFor(g);
    d.scorerId=s.value; d.scorerName=s.options[s.selectedIndex].text.split(" · ")[0]; d.autoS=false; paintQuick(); };
  $("#qkSave").onclick=async()=>{
    $("#qkSave").disabled=true; $("#qkSave").textContent="Kaydediliyor…";
    let n=0;
    for(const g of games){ const d=draftFor(g), sv=D.picks[g.id]?.[S.uid];
      if(!(d.winner&&d.margin&&d.scorerId) || (sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId)) continue;
      await savePick(g, {quiet:true}); if(!d.err) n++; }
    toast(n ? pick([`${n} tahmin kaydedildi.`,`Tamamdır, ${n} tahmin kaydedildi.`,`${n} maçın tahmini hazır.`]) : "Kaydedilemedi, tekrar dene."); paintQuick(); renderStatus();
  };
}

/* ====================================================== Günün tahminleri */
function lockLeft(g){
  const ms = g.lock.getTime() - Date.now();
  if(ms<=0) return "Kilitlendi";
  const h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  const why = g.perGame ? "maçtan 10 dk önce" : "gecenin ilk maçıyla";
  if(h>=12) return `${timeTR(g.lock)}'de, ${why} kilitlenir`;
  return `Kilide ${h?h+" sa ":""}${m} dk var · ${timeTR(g.lock)}'de, ${why} kilitlenir`;
}
function renderDayView(){
  const D = S.days[S.day]; const box=$("#dayView"); if(!box) return;
  if(!D){ box.innerHTML=`<div class="note">Yükleniyor.</div>`; return; }
  if(!D.games.length){ box.innerHTML=""; return; }
  const u = S.order.includes(S.viewFor) ? S.viewFor : S.uid;
  const prog = D.progress[u] || new Set();
  const count = D.games.filter(g => D.picks[g.id]?.[u] || prog.has(g.id)).length;
  const daily = D.daily[u];
  const firstLocked = D.games.some(started);
  let dp;
  if(u===S.uid || firstLocked) dp = daily?.dayPlayerName ? `Günün oyuncusu: <b>${esc(daily.dayPlayerName)}</b>` : "Günün oyuncusu seçilmedi";
  else dp = "Günün oyuncusu ilk maçla birlikte görünecek";
  let html = `<div class="chips" id="dvSel">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>
    <div class="dv-head"><span><b style="color:${col(u)}">${esc(pname(u))}</b> · ${count}/${D.games.length} maç girildi</span><span class="muted">${dp}</span></div><div class="dv-list">`;
  for(const g of D.games){
    const p = D.picks[g.id]?.[u];
    const conf = daily?.confGame===g.id;
    const st = g.state==="in" ? `<span class="badge-live">Canlı</span> ${g.away.score??0}–${g.home.score??0}` : g.state==="post" ? `Bitti ${g.away.score}–${g.home.score}` : timeTR(g.start);
    let body;
    if(p && (u===S.uid || started(g))){
      const t = p.winner===g.home.abbr ? g.home : g.away;
      const r = scorePick(g, p, conf);
      const pts = (g.state==="post"||g.state==="in") ? `<span class="p" style="color:${r.pts>0?"var(--win)":r.pts<0?"var(--lose)":"var(--muted)"}">${r.pts>0?"+":""}${r.pts}</span>` : "";
      body = `<div class="dv-pick"><img src="${t.logo||""}" alt=""><div><div class="w">${esc(t.name)} ${conf?'<span class="star">★</span>':""}</div><div class="m">${p.margin} fark · ${esc(p.scorerName)}</div></div>${pts}</div>`;
    } else if(u!==S.uid && !started(g)){
      body = `<div class="dv-hidden">${prog.has(g.id)?"<b>✓ Tahmin yaptı</b> · ":"Henüz tahmin yapmadı · "}seçimler ${timeTR(g.lock)}'de açılacak</div>`;
    } else {
      body = `<div class="dv-hidden">${started(g)?"Tahmin girilmedi":"Henüz kaydedilmedi"}</div>`;
    }
    html += `<div class="dv" style="--pc:${col(u)}"><div class="dv-top"><img src="${g.away.logo||""}" alt="">${esc(g.away.name)} @ <img src="${g.home.logo||""}" alt="">${esc(g.home.name)}<span class="t">${st}</span></div>${body}</div>`;
  }
  box.innerHTML = html + `</div>`;
  $("#dvSel").onclick = e => { const c=e.target.closest(".chip"); if(!c) return; S.viewFor=c.dataset.v; renderDayView(); };
}
$("#subSel").addEventListener("click", e => {
  const b=e.target.closest("button"); if(!b) return; S.sub=b.dataset.v;
  $$("#subSel button").forEach(x=>x.setAttribute("aria-pressed", x===b));
  $("#subMaclar").classList.toggle("hide", S.sub!=="maclar");
  $("#subTahminler").classList.toggle("hide", S.sub!=="tahminler");
  render();
});

/* ====================================================== oyuncu seçici */
async function openPlayerPicker({mode, g}){
  const D = S.days[S.day];
  const games = mode==="game" ? [g] : D.games.filter(x=>!started(x));
  openSheet(`<h3 id="shTitle">${mode==="game"?"Maçın en skoreri":"Günün oyuncusu"}</h3><p class="muted">Yükleniyor…</p>`);
  let list = [];
  try{
    const teams = games.flatMap(x=>[x.away, x.home]);
    const rs = await Promise.all(teams.map(t=>loadRoster(t).catch(()=>[])));
    list = rs.flat();
  }catch(e){}
  list.forEach(p => p.ppg = ppg(p.id));
  list.sort((a,b)=>(b.ppg??-1)-(a.ppg??-1) || a.name.localeCompare(b.name));
  const cur = mode==="game" ? draftFor(g).scorerId : D.daily[S.uid]?.dayPlayerId;
  const teamsChips = mode==="game" ? `<div class="chips" id="tmF"><button class="chip" data-v="" aria-pressed="true">Hepsi</button><button class="chip" data-v="${g.away.abbr}" aria-pressed="false">${esc(g.away.name)}</button><button class="chip" data-v="${g.home.abbr}" aria-pressed="false">${esc(g.home.name)}</button></div>` : "";
  const injTxt = id => injBadge(id);
  const row = p => `<button class="plr" data-id="${p.id}" data-name="${esc(p.name)}" data-team="${p.team}" aria-pressed="${p.id===cur}">
    <img src="${p.img}" alt="" loading="lazy"><span class="pi"><b>${esc(p.name)}${injTxt(p.id)}</b><small>${p.team} · ${p.pos}${p.jersey?" · #"+p.jersey:""}</small></span>
    <span class="ppg">${p.ppg!=null?p.ppg.toFixed(1):"–"}<small>sayı ort.</small></span></button>`;
  $("#shBody").innerHTML = `<h3 id="shTitle">${mode==="game"?"Maçın en skoreri":"Günün oyuncusu"}</h3>${teamsChips}
    <input class="search" id="plSearch" placeholder="Oyuncu ara" autocomplete="off"><div id="plList">${list.length?list.map(row).join(""):'<p class="muted">Kadro alınamadı.</p>'}</div>`;
  let tf="";
  const filter = () => { const q=slug($("#plSearch").value); $$("#plList .plr").forEach(el=>{ el.classList.toggle("hide", (tf && el.dataset.team!==tf) || (q && !slug(el.dataset.name).includes(q))); }); };
  $("#plSearch").oninput = filter;
  $("#tmF")?.addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(!c) return; tf=c.dataset.v; $$("#tmF .chip").forEach(x=>x.setAttribute("aria-pressed", x===c)); filter(); });
  $("#plList").onclick = e => {
    const b = e.target.closest(".plr"); if(!b) return;
    closeSheet();
    if(mode!=="game") S.swipeReturn=false;
    if(mode==="game"){
      if(started(g)) return toast(lockedMsg(g));
      const d=draftFor(g); d.scorerId=b.dataset.id; d.scorerName=b.dataset.name; d.err=null; renderGames();
      if(S.swipeReturn){ S.swipeReturn=false; openSheet(`<div id="swipe" class="swipe"></div>`); paintSwipe(); }
    } else {
      if(D.games.some(started)) return toast("Günün oyuncusu kilitlendi (gecenin ilk maçından 10 dk önce).");
      saveDaily({dayPlayerId:b.dataset.id, dayPlayerName:b.dataset.name});
    }
  };
}

/* ====================================================== maç önü ve kutu skoru */
async function openInfo(g){
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><p class="muted">Yükleniyor…</p>`);
  await loadInj().catch(()=>{});
  let s; try{ s = await loadSummary(g); }catch(e){ $("#shBody").innerHTML += `<div class="note">Maç öncesi bilgilere şu an ulaşılamıyor.</div>`; return; }
  const teamSec = side => {
    const t=g[side];
    const l5 = (s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[];
    const inj = injOfTeam(t.abbr);
    const ld = (s.leaders||[]).find(x=>x.team?.abbreviation===t.abbr)?.leaders||[];
    const pts = ld.find(x=>/points/i.test(x.name))?.leaders?.[0];
    const reb = ld.find(x=>/rebounds/i.test(x.name))?.leaders?.[0];
    const ast = ld.find(x=>/assists/i.test(x.name))?.leaders?.[0];
    return `<div class="box"><h4 style="margin:0 0 8px;display:flex;gap:8px;align-items:center"><img src="${t.logo}" alt="" width="26" height="26">${esc(t.name)} <small class="muted">${t.rec}</small><button class="linkish" data-tp="${t.abbr}" style="margin-left:auto;font-size:13px">Takım sayfası ›</button></h4>
      <div class="row-lbl">Son 5 maç</div><div class="l5">${l5.map(e=>`<span class="${e.gameResult}" title="${esc(e.atVs||"")} ${esc(e.opponent?.abbreviation||"")} ${esc(e.score||"")}">${e.gameResult==="W"?"G":"M"}</span>`).join("")||'<span class="muted">–</span>'}</div>
      <div class="row-lbl">Öne çıkan oyuncular (maç başına ortalama)</div><div style="font-size:14px">${[pts&&`${esc(pts.athlete.displayName)} ${pts.displayValue} sayı`,reb&&`${esc(reb.athlete.displayName)} ${reb.displayValue} ribaund`,ast&&`${esc(ast.athlete.displayName)} ${ast.displayValue} asist`].filter(Boolean).join("<br>")||"–"}</div>
      <div class="row-lbl">Sakatlar</div><div style="font-size:14px">${inj.length?inj.map(i=>`${esc(i.n)} <span class="inj ${i.o?"":"q"}">${i.s}</span>${i.c?`<small class="inj-c">${esc(i.c)}</small>`:""}`).join(""):'<span class="muted">Sakat oyuncu yok</span>'}</div></div>`;
  };
  const pr = s.predictor; let pred="";
  if(pr?.homeTeam?.gameProjection){
    const h=+pr.homeTeam.gameProjection, a=+pr.awayTeam.gameProjection;
    pred = `<div class="box"><div class="row-lbl" style="margin-top:0">ESPN kazanma olasılığı</div><div class="pred"><i style="width:${a}%;background:var(--p0)"></i><i style="width:${h}%;background:var(--p1)"></i></div>
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>${esc(g.away.name)} %${a.toFixed(0)}</span><span>${esc(g.home.name)} %${h.toFixed(0)}</span></div></div>`;
  }
  const ss=(s.seasonseries||[])[0];
  const series = ss?.events?.length ? `<div class="box"><div class="row-lbl" style="margin-top:0">Bu sezon aralarındaki maçlar</div>${ss.events.map(e=>{ const c=e.competitors||[]; const h=c.find(x=>x.homeAway==="home"), a=c.find(x=>x.homeAway==="away");
      return `<div class="ss-row"><small>${e.date?dayNice(ymd(new Date(new Date(e.date).getTime()-8*36e5)),{day:"numeric",month:"short"}):""}</small><span>${esc(a?.team?.abbreviation||"")} <b>${a?.score??""}</b> – <b>${h?.score??""}</b> ${esc(h?.team?.abbreviation||"")}</span></div>`; }).join("")}</div>` : "";
  await nbaStandings().catch(()=>null);
  const stE=a=>(S.standings||[]).flatMap(c=>c.entries).find(e=>e.team.abbreviation===a);
  const avg=(a,k)=>{ const e=stE(a); const v=e&&+stOf(e,k); return v?v.toFixed(1):"–"; };
  const comp = stE(g.away.abbr) ? `<div class="box"><div class="row-lbl" style="margin-top:0">Sezon ortalamaları</div><div class="cmp-t"><span></span><b>${esc(g.away.abbr)}</b><b>${esc(g.home.abbr)}</b>
      <span>Attığı sayı</span><span>${avg(g.away.abbr,"avgPointsFor")}</span><span>${avg(g.home.abbr,"avgPointsFor")}</span>
      <span>Yediği sayı</span><span>${avg(g.away.abbr,"avgPointsAgainst")}</span><span>${avg(g.home.abbr,"avgPointsAgainst")}</span>
      <span>Galibiyet-mağlubiyet</span><span>${stE(g.away.abbr)?wlOf(stE(g.away.abbr)):"–"}</span><span>${stE(g.home.abbr)?wlOf(stE(g.home.abbr)):"–"}</span></div></div>` : "";
  $("#shBody").innerHTML = `<h3 id="shTitle">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><p class="muted" style="margin-top:-6px">${dayNice(S.day,{day:"numeric",month:"long"})} · ${timeTR(g.start)}${g.cup?" · NBA Kupası (2× puan)":""}</p>${pred}${series}${comp}${teamSec("away")}${teamSec("home")}`;
}
async function openBox(g){
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} ${g.away.score??""} – ${g.home.score??""} ${esc(g.home.name)}</h3><p class="muted">Yükleniyor…</p>`);
  let s; try{ s = await loadSummary(g, g.state==="in"); }catch(e){ $("#shBody").innerHTML += `<div class="note">İstatistiklere şu an ulaşılamıyor.</div>`; return; }
  const bp = boxPlayers(s);
  const top = Math.max(0,...bp.map(p=>p.pts));
  const table = side => {
    const t=g[side], rows=bp.filter(p=>p.team===t.abbr).sort((a,b)=>b.pts-a.pts);
    return `<div class="box"><h4 style="margin:0 0 6px;display:flex;gap:8px;align-items:center"><img src="${t.logo}" alt="" width="24" height="24">${esc(t.name)} <span class="big" style="margin-left:auto">${t.score??""}</span></h4>
      <div style="overflow-x:auto"><table class="bx"><thead><tr><th>Oyuncu</th><th>DK</th><th>SAY</th><th>RİB</th><th>AST</th><th>SA</th><th>3S</th><th>SB</th><th>+/-</th></tr></thead><tbody>
      ${rows.map(p=>`<tr class="${p.pts===top?"top":""}"><td>${esc(p.name)}${p.starter?"":' <span class="muted">·</span>'}</td><td>${p.min}</td><td><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td><td>${p.fg}</td><td>${p.tp}</td><td>${p.ft}</td><td>${p.pm}</td></tr>`).join("")||'<tr><td colspan="9" class="muted">Maç başlayınca istatistikler burada görünecek</td></tr>'}
      </tbody></table></div></div>`;
  };
  $("#shBody").innerHTML = `<h3 id="shTitle">${esc(g.away.name)} ${g.away.score??""} – ${g.home.score??""} ${esc(g.home.name)}</h3><p class="muted" style="margin-top:-6px">${gameStatusTR(g)} · SA: isabet-deneme, 3S: üçlük, SB: serbest atış</p>${table("away")}${table("home")}`;
}
function openSheet(html){ if($("#sheet").classList.contains("hide")){ try{ history.pushState({sheet:1}, ""); }catch(e){} }
  S.sheetLocked=false; $("#shClose").classList.remove("hide");
  $("#shBody").innerHTML=html; $("#sheet").classList.remove("hide"); $$("#sheet, #sheet *").forEach(el=>{ if(el.scrollTop) el.scrollTop=0; }); document.body.style.overflow="hidden"; $("#shClose").focus(); }
function closeSheet(fromPop){ if(S.sheetLocked){ if(fromPop) try{ history.pushState({sheet:1}, ""); }catch(e){} return; }
  if($("#sheet").classList.contains("hide")) return;
  $("#sheet").classList.add("hide"); document.body.style.overflow="";
  if(!fromPop && history.state?.sheet){ S.popSkip=true; history.back(); } }
addEventListener("popstate", ()=>{ if(S.popSkip){ S.popSkip=false; return; } if(!$("#sheet").classList.contains("hide")) closeSheet(true); });
$("#shClose").onclick = ()=>closeSheet();
$("#sheet").addEventListener("click", e => { if(e.target.id==="sheet") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key==="Escape") closeSheet(); });


/* ====================================================== Kurallar */
// Puanlama rehberi: 1.14.0'da herkese bir kez açılır; Kurallar'dan da açılır
function openScoringGuide(){
  openSheet(`<div class="rules pg">${UI_EN ? `
<h3 id="shTitle">Scoring guide</h3>
<p class="pg-lead">Points come from three places: <b>each game's pick</b>, <b>nightly extras</b> and <b>long-term picks</b>. Everything is explained below with examples.</p>
<h4>1. Every game: winner, margin, top scorer</h4>
<div class="pg-t"><span>Correct winner</span><b>+1</b><span>Correct margin (with the winner)</span><b>+1</b><span>Correct top scorer</span><b>+1</b></div>
<p><b>Margin:</b> pick the point difference with the slider. Within <b>3 points</b> of the real margin counts. Example: you pick 9, the game ends by 6 to 12 → +1. "40+" covers 37 and above.</p>
<p><b>Top scorer:</b> the game's leading scorer; on a tie, anyone who picked one of them gets it.</p>
<h4>2. Upset tier</h4>
<p>Each team button shows ESPN's pregame win chance. Correctly picking an unlikely winner pays more:</p>
<div class="pg-t"><span>Your team's chance 34% or more</span><b>+1</b><span>21% – 33%</span><b>+2</b><span>20% or less</span><b>+3</b></div>
<p>The expected value of picking the underdog never beats picking the favorite, so nobody gains by picking upsets at random — only by being right.</p>
<h4>3. Lock pick</h4>
<p>One game per night: the winner points are <b>doubled</b> (+2 normally, +4 for a 33% upset). A miss costs <b>-1</b>. Margin and scorer are unaffected.</p>
<h4>4. NBA Cup and playoffs</h4>
<p>Cup games (gold band) and playoff games give <b>double points</b>. A missed lock is still -1. <b>Cap:</b> winner points from one game are at most <b>4</b> (upset, lock and cup combined).</p>
<h4>5. Nightly extras</h4>
<div class="pg-t"><span>Player of the night: the night's top scorer</span><b>+3</b><span>Question of the night</span><b>+1</b></div>
<p>Lock, player of the night and question lock 10 minutes before the first game; each game's pick locks 10 minutes before that game.</p>
<h4>6. Consistency bonus and auto picks</h4>
<p><b>Consistency:</b> pick on at least <b>4 nights</b> in a week (Mon–Sun) → <b>+2</b>. It doesn't decide the night's winner.</p>
<p><b>Auto picks:</b> you choose on/off when you join and can change it in Profile → Settings. On a night you make no picks at all, ESPN favorites are entered for you; <b>every 2 correct winners = 1 point</b>. Margin, scorer and banko are not included.</p>
<h4>7. Monthly league awards</h4>
<div class="pg-t"><span>Predictor of the month</span><b>+1</b><span>Lock master, Upset hunter, Scorer master, Margin master</span><b>+2 each</b></div>
<h4>8. Long-term</h4>
<div class="pg-t"><span>Player of the week (East and West)</span><b>+2</b><span>Player / rookie / defender of the month</span><b>+4 / +3 / +3</b><span>Conference standings (top 6 East and West, per team)</span><b>exact +2 / one off +1</b><span>NBA Cup champion / finalists / Cup MVP</span><b>+8 / +3 / +6</b><span>Most Valuable Player</span><b>+12</b><span>Other season awards</span><b>+8 each</b><span>NBA Champion / Conference Champions</span><b>+10 / +5</b></div>
<h4>9. Playoff series</h4>
<p>Series winner <b>+3</b>, plus <b>+2</b> for the right number of games.</p>
<h4>10. Standings and ties</h4>
<p>Season points add up nights, bonuses, monthly awards and long-term picks. Ties: more night wins first, then more winner points.</p>
<button class="btn-primary" id="pgOk" type="button">Got it</button>` : `
<h3 id="shTitle">Puanlama rehberi</h3>
<p class="pg-lead">NBA Tahmin'de puanlar üç yerden gelir: <b>her maçın tahmini</b>, <b>her gecenin ekstraları</b> ve <b>uzun vadeli tahminler</b>. Aşağıda hepsini örnekleriyle anlattık.</p>

<h4>1. Her maç: kazanan, fark, en skorer</h4>
<p>Her maç için üç şey seçersin. Her biri ayrı puan getirir.</p>
<div class="pg-t"><span>Kazananı bilirsen</span><b>+1</b><span>Farkı bilirsen (kazananı da bildiysen)</span><b>+1</b><span>Maçın en skorerini bilirsen</span><b>+1</b></div>
<p><b>Fark:</b> Kaydırıcıyla iki takım arasındaki sayı farkını seçersin. Gerçek farka <b>3 sayı ya da daha yakınsan</b> tuttu sayılır. Örnek: 9 dedin, maç 6 ile 12 arasında bir farkla bittiyse +1. "40+" seçersen 37 ve üstü farklar tutar.</p>
<p><b>En skorer:</b> Maçta en çok sayı atan oyuncu. Eşitlik olursa eşit atanlardan birini seçen herkes bilmiş sayılır. Sakat ya da oynamayacak oyuncular listede işaretlidir.</p>

<h4>2. Sürpriz kademesi</h4>
<p>Her takım düğmesinde ESPN'in maç önü kazanma şansı yazar (örneğin %28). Şansı az olan takımı doğru bilirsen kazanan puanı artar:</p>
<div class="pg-t"><span>Seçtiğin takımın şansı %34 ve üstü</span><b>+1</b><span>%21 – %33 arası</span><b>+2</b><span>%20 ve altı</span><b>+3</b></div>
<p>Bu oranlar rastgele seçilmedi: sürpriz takımı seçmenin ortalama getirisi favoriyi seçmenin getirisini hiç geçmez. Yani kimse sırf kat için sürpriz seçerek öne geçemez; ama sürprize gerçekten inanıp haklı çıkan ödüllendirilir. Şans maç önü tahminidir, maç başlayınca değişmez.</p>

<h4>3. Banko</h4>
<p>Her gece bir maçı banko seçersin. Bankoda kazanan puanın <b>2 katına</b> çıkar: normal maçta +2, %33'lük sürprizde +4. Bilemezsen <b>-1</b> puan kaybedersin. Fark ve skorer puanları bankodan etkilenmez. Bankoyu başka maça taşıyabilirsin ama kaldıramazsın.</p>

<h4>4. NBA Kupası ve playoff</h4>
<p>NBA Kupası maçları (altın şeritli kartlar) ve playoff maçları <b>2 kat puan</b> getirir; kazanan, fark ve skorer puanlarının hepsi katlanır. Yanan banko yine -1'dir.</p>
<p><b>Üst sınır:</b> Bir maçtan alınan <b>kazanan puanı en fazla 4</b>'tür (sürpriz, banko ve kupa katı birlikte). Örnek: kupa maçında %25'lik sürprize banko yaptın ve tuttu → kazanan puanı 2×2×2=8 değil <b>4</b>; fark ve skorer de tutarsa onlar 2'şer gelir, toplam 8.</p>

<h4>5. Her gece: günün oyuncusu ve gecenin sorusu</h4>
<div class="pg-t"><span>Günün oyuncusu: gecenin bütün maçlarındaki en skoreri bilirsen</span><b>+3</b><span>Gecenin sorusu: evet/hayır sorusunu bilirsen</span><b>+1</b></div>
<p>Banko, günün oyuncusu ve gecenin sorusu gecenin ilk maçından 10 dakika önce kilitlenir. Maç tahminleri ise her maçın kendi başlama saatinden 10 dakika önce kilitlenir.</p>

<h4>6. Devamlılık bonusu ve otomatik tahmin</h4>
<p><b>Devamlılık:</b> Bir haftada (pazartesi–pazar) en az <b>4 gece</b> kendin tahmin yaparsan <b>+2</b>. Bu bonus haftanın toplamına girer, gecenin kazananını belirlemez.</p>
<p><b>Otomatik tahmin:</b> Kayıt olurken açık ya da kapalı seçersin, sonra Profil → Ayarlar'dan değiştirebilirsin. Açıksa ve bir gece hiçbir tahmin yapmazsan her maçta ESPN'in favorisi senin yerine seçilir; doğru çıkan <b>her 2 kazanan 1 puan</b> eder. Fark, skorer, banko, günün oyuncusu ve gecenin sorusu otomatik tahminde yoktur; o gece devamlılık bonusuna da sayılmaz.</p>

<h4>7. Aylık lig ödülleri</h4>
<div class="pg-t"><span>Ayın tahmincisi (ayın en çok puanı)</span><b>+1</b><span>Banko ustası, Sürpriz avcısı, Skorer ustası, Fark ustası</span><b>+2'şer</b></div>
<p>Ay bitince hesaplanır, eşitlikte ödülü paylaşan herkes puanı alır.</p>

<h4>8. Uzun vade</h4>
<div class="pg-t"><span>Haftanın oyuncusu (Doğu ve Batı ayrı)</span><b>+2</b><span>Ayın oyuncusu / ayın çaylağı / ayın savunmacısı</span><b>+4 / +3 / +3</b><span>Konferans sıralaması (Doğu ve Batı'nın ilk 6'sı, her takım için)</span><b>tam yer +2 / bir sıra şaşma +1</b><span>NBA Kupası şampiyonu / finalistler / kupa MVP'si</span><b>+8 / +3 / +6</b><span>Most Valuable Player</span><b>+12</b><span>Diğer sezon ödülleri (ROY, DPOY, MIP, 6MOY, COY)</span><b>+8'er</b><span>NBA Champion / Eastern ve Western Conference Champion</span><b>+10 / +5</b></div>
<p>Kilit tarihleri Uzun Vade sekmesinde yazar. Seçimler kilitten sonra herkese açılır.</p>

<h4>9. Playoff serileri</h4>
<p>Her seri başlamadan kazananı ve kaç maçta biteceğini tahmin edersin: kazanan <b>+3</b>, maç sayısı da doğruysa <b>+2</b> daha.</p>

<h4>10. Sıralama ve eşitlik</h4>
<p>Sezon puanı bütün gecelerin, bonusların, aylık ödüllerin ve uzun vade tahminlerinin toplamıdır. Toplam eşitse önce daha çok gece birinciliği, o da eşitse daha çok kazanan puanı olan öne geçer. Gecenin en çok puanını tek başına alan o geceyi kazanır.</p>
<button class="btn-primary" id="pgOk" type="button">Anladım</button>`}</div>`);
  $("#pgOk").onclick=()=>closeSheet();
}
// Deneme haftasında ilk girişte bir kez; deneme bitince ilk girişte bir kez "Lig başladı"
function maybeLeaguePop(){
  if(!S.uid || S.onboard) return;
  if(!$("#sheet").classList.contains("hide")) return setTimeout(maybeLeaguePop, 4000);
  const t=S.league?.trial; if(!t?.end) return;
  const nice=(d,o={day:"numeric",month:"long"})=>dayNice(d,o), go=shiftDay(t.end,1);
  if(trialActive() && !lsGet("trialPop_"+t.end)){
    lsSet("trialPop_"+t.end,"1");
    openSheet(`<div class="rules lg-pop"><div class="lg-ico">🧪</div><h3 id="shTitle">Bu hafta deneme haftası</h3>
      <p><b>${nice(baseStart())} – ${nice(t.end)}</b> arası deneme ligi. Tahmin yap, puan topla, siteyi tanı: her şey gerçeği gibi sayılıyor.</p>
      <p><b>${nice(go,{day:"numeric",month:"long",weekday:"long"})}</b> puanlar, rozetler ve istatistikler sıfırlanacak, asıl lig o gün başlayacak. Hesabın, profilin, avatarın ve ayarların olduğu gibi kalır. Deneme haftasının tablosu "Geçmiş ligler"de saklanır.</p>
      <button class="btn-primary" type="button" id="lgPopOk">Anladım, oynamaya başla</button></div>`);
    $("#lgPopOk").onclick=()=>closeSheet(); return;
  }
  const done = t.done || espnToday()>t.end;
  if(done && !lsGet("leagueGo_"+go) && espnToday()<=shiftDay(go,13)){
    lsSet("leagueGo_"+go,"1"); lsSet("trialPop_"+t.end,"1");
    const h=(S.league?.history||[]).filter(x=>x.end===t.end).pop(), top=h?.rows?.[0];
    openSheet(`<div class="rules lg-pop"><div class="lg-ico">🏁</div><h3 id="shTitle">Lig başladı!</h3>
      <p>Deneme haftası bitti. Puanlar, rozetler ve istatistikler sıfırlandı; <b>${nice(go)} gecesinden itibaren her puan gerçek</b>.</p>
      ${top?.pts?`<p>Deneme haftasının birincisi <b>${esc(top.name)}</b> (${top.pts} puan). Bütün tablo "Geçmiş ligler"de.</p>`:""}
      <p>Bu hafta sohbette ve tahminlerde bol şans!</p>
      <button class="btn-primary" type="button" id="lgPopOk">Hadi başlayalım</button></div>`); $("#lgPopOk").onclick=()=>closeSheet();
    if(typeof confetti==="function") try{ confetti(); }catch(e){}
  }
}
// Deneme bittiyse yönetici açtığında deneme tablosunu arşive yaz ve lig başlangıcını kalıcı yap
async function maybeArchiveTrial(){
  const t=trialOf(); if(!S.isAdmin || !t || espnToday()<=t.end || S.trialArchiving) return;
  S.trialArchiving=true;
  try{
    S.lsRange=[baseStart(), t.end]; applyLeague();
    const tt=seasonTotals(), nights={}; for(const n of nightsOf()) if(n.w.st==="w") nights[n.w.u]=(nights[n.w.u]||0)+1;
    const rows=[...S.order].sort((a,b)=>(tt[b]||0)-(tt[a]||0)).map(u=>({uid:u, name:pname(u), pts:tt[u]||0, nights:nights[u]||0}));
    const lt=Object.fromEntries(S.order.map(u=>[u, S.lt?.loaded?ltPoints(u):0]));
    S.lsRange=null;
    const entry={start:baseStart(), end:t.end, rows, at:new Date().toISOString(), name:t.name||"Deneme haftası", awards:[], lt};
    const history=[...(S.league?.history||[]), ...(rows.some(r=>r.pts) ? [entry] : [])];
    const next={...S.league, start:shiftDay(t.end,1), history, trial:{...t, done:true}};
    await setDoc(doc(S.db,"league","settings"), next); S.league=next;
  }catch(e){ S.lsRange=null; }
  S.trialArchiving=false; applyLeague(); render();
}
function maybeScoringGuide(){ if(lsGet("pg1141") || S.onboard) return; if(!$("#sheet").classList.contains("hide")){ return setTimeout(maybeScoringGuide, 4000); } lsSet("pg1141","1"); openScoringGuide(); }
function openRules(){
  openSheet(`<div class="rules"><h3 id="shTitle">Kurallar</h3><button class="btn pg-open" id="pgOpen" type="button">📖 Puanlama rehberi: bütün puanlar örnekleriyle</button>
    <p>Her gece o gecenin bütün NBA maçları için üç tahmin yaparsın: <b>kazanan takım</b>, <b>fark</b> (iki takım arasındaki sayı farkı) ve <b>maçın en skoreri</b>. Bir maçın tahmini, üçü de seçilip kaydedilince geçerli olur.</p>
    <h4>Puanlar</h4>
    <div class="pt"><span>Kazananı bilirsen</span><b>+1</b><span>Sürpriz kazananı bilirsen (ESPN şansı %33 ve altı / %20 ve altı)</span><b>+2 / +3</b><span>Kazananla birlikte farkı da bilirsen (±3 sayı)</span><b>+1</b><span>Maçın en skorerini bilirsen</span><b>+1</b><span>Günün oyuncusunu bilirsen</span><b>+3</b><span>Gecenin sorusunu bilirsen</span><b>+1</b></div>
    <h4>Fark</h4>
    <p>Farkı kaydırıcıyla sayı olarak seçersin (1–40+). Gerçek farka <b>3 sayı ya da daha yakın</b> tahmin tutmuş sayılır: 9 dedin, maç 6 ile 12 arası bir farkla bittiyse +1. "40+" 37 ve üstü farkları kapsar. Uzatmaya giden maçlarda son skordaki fark geçerlidir. Fark puanını almak için kazananı da bilmen gerekir.</p>
    <h4>Sürpriz kademesi</h4>
    <p>Her takım düğmesinde ESPN'in maç önü kazanma şansı yazar. Seçtiğin takımın şansı <b>%33 ve altındaysa kazanan puanı +2</b>, <b>%20 ve altındaysa +3</b>, üstündeyse +1 olur. Şans maç önündeki ESPN tahminidir, maç başladıktan sonra değişmez. Fark ve skorer puanları sürprizden etkilenmez.</p>
    <h4>Günün bankosu</h4>
    <p>Her gece bir maçı banko seçersin. Bankoda <b>kazanan puanın 2 katına çıkar</b> (normal maçta +2, %33'lük sürprizde +4, %20'lik sürprizde +6), bilemezsen <b>-1</b> puan kaybedersin. Fark ve skorer puanları bankodan etkilenmez. Bankoyu başka maça taşıyabilirsin ama tamamen kaldıramazsın.</p>
    <h4>NBA Kupası ve playoff</h4>
    <p>NBA Kupası maçları (altın şeritli kartlar) ve playoff maçları <b>2 kat puan</b> getirir: kazanan, fark ve skorer puanlarının hepsi katlanır. Günün oyuncusu ve gecenin sorusu katlanmaz, yanan banko yine -1'dir.</p>
    <p><b>Üst sınır:</b> Bir maçtan alınan kazanan puanı sürpriz, banko ve kupa ya da playoff katı birlikte <b>en fazla 4</b> olur.</p>
    <h4>Günün oyuncusu</h4>
    <p>O gecenin bütün maçları arasından bir oyuncu seçersin. Gecenin en çok sayı atan oyuncusu o olursa <b>+3</b>.</p>
    <h4>Gecenin sorusu</h4>
    <p>Her gece evet ya da hayır diye cevaplanan bir soru gelir (ör. "Bu gece biri 40 ya da daha fazla sayı atar mı?"). Doğru cevap <b>+1</b>. Sorular 21 soruluk bir havuzdan sırayla gelir, aynı soru 21 gün içinde tekrar etmez. Sorudaki sayı (eşik ya da maç sayısı) gecenin maç sayısına göre seçilir; böylece cevap ne neredeyse kesin evet ne de neredeyse kesin hayır olur. Sonuç gecenin maçları bitince, bazı sorularda koşul gerçekleştiği anda belli olur.</p>
    <h4>Kilit ve gizlilik</h4>
    <p>Her maçın tahmini, o maç başlamadan <b>10 dakika önce</b> kilitlenir. Banko, günün oyuncusu ve gecenin sorusu gecenin ilk maçından 10 dakika önce kilitlenir. Kilitlenene kadar istediğin kadar değiştirebilirsin ve kimse senin seçimini göremez; kimin kaç maçı doldurduğu "Günün tahminleri"nde görünür. Kilitten sonra bütün seçimler herkese açılır.</p>
    <h4>Eşitlikler</h4>
    <p>Bir maçta ya da gecede birden fazla oyuncu aynı en yüksek sayıyı atarsa bunlardan birini seçen herkes bilmiş sayılır.</p>
    <h4>Gece, hafta, sezon</h4>
    <p>Gecenin en çok puanını tek başına alan o geceyi kazanır. Haftalar pazartesi başlar, pazar biter. Sezon puanı bütün gecelerin, bonusların, aylık lig ödüllerinin, playoff serilerinin ve uzun vade tahminlerinin toplamıdır. Toplam eşitse önce daha çok gece kazanan, o da eşitse daha çok kazanan puanı olan öne geçer.</p>
    <h4>Devamlılık bonusu</h4>
    <p>Bir haftada (pazartesi–pazar) en az <b>4 gece</b> kendin tahmin yaparsan o hafta <b>+2</b> puan alırsın. Puan, 4. gecenin sonunda eklenir. Otomatik tahminle geçen geceler sayılmaz. Bonus gecenin kazananını belirlemez.</p>
    <h4>Otomatik tahmin</h4>
    <p>Kayıt olurken açık mı kapalı mı olacağını seçersin, sonra Profil → Ayarlar'dan değiştirebilirsin. Açıksa, hiç tahmin yapmadığın bir gecede her maçta ESPN'in favorisi senin yerine seçilir; doğru çıkan <b>her 2 kazanan 1 puan</b> getirir. Fark, skorer, banko, günün oyuncusu ve gecenin sorusu otomatik tahminde yoktur. O gece herhangi bir tahmin yaptıysan (bir maç, banko, günün oyuncusu ya da gecenin sorusu) otomatik tahmin devreye girmez.</p>
    <h4>Playoff serileri</h4>
    <p>Playoff'ta her seri başlamadan önce seriyi kimin kaç maçta kazanacağını tahmin edersin. Kazananı bilirsen <b>+3</b>, maç sayısını da bilirsen <b>+2</b> daha. Tahminler serinin ilk maçı başlayınca kilitlenir.</p>
    <h4>Uzun vade</h4>
    <p>Haftanın oyuncusu, ayın ödülleri, konferans sıralaması, NBA Kupası ve sezon ödülleri için önceden tahmin yaparsın. Puanlar ve kilit tarihleri Uzun Vade sekmesinde ve Puanlama rehberinde yazar. Doğru tahminler ana sıralamaya eklenir.</p>
    <h4>Aylık lig ödülleri</h4>
    <p>Her ay sonunda <b>Ayın tahmincisi +1</b>; <b>Banko ustası, Sürpriz avcısı, Skorer ustası ve Fark ustası +2</b>'şer puan alır. Eşitlikte ödülü paylaşanların hepsi puanı alır.</p>
    <h4>Deneme haftası</h4>
    <p>Lig deneme haftasıyla başlarsa o hafta her şey gerçeği gibi sayılır, ama haftanın sonunda puanlar, rozetler ve istatistikler sıfırlanır; hesabın, profilin ve ayarların kalır. Deneme haftasının tablosu "Geçmiş ligler"de saklanır. Deneme süresince sayfanın en üstünde çizgili bir "Deneme haftası" şeridi görünür.</p>
    <h4>Yeni oyuncu</h4>
    <p>Davet linkiyle siteye girip "Yeni oyuncu" adımlarını izlersin: adın, 6 haneli şifren, güvenlik sorusu (gizli takım ve gizli oyuncu), takım adın, favori takımın, avatarın, otomatik tahmin tercihin ve mail adresin. Linkle gelmediysen davet kodu da sorulur. Mail adresi zorunludur; onay kodunu hemen ya da sonra Profil → Ayarlar'dan girebilirsin. Kod girilene kadar sana hiçbir mail (hatırlatma, haftalık özet, şifre sıfırlama kodu) gelmez.</p>
    <h4>Sohbet ve yorumlar</h4>
    <p>Sağ alttaki baloncuktan lig sohbetine girersin: mesajlara yanıt verebilir, @ ile birini etiketleyebilir, emoji tepkisi bırakabilir, kendi mesajını gönderdikten sonraki 2 dakika içinde düzenleyebilir, istediğin zaman silebilirsin. Maçlar kilitlendikten sonra maç kartlarına da emoji ve kısa yorum bırakılabilir. Sohbette ve yorumlarda küfür, kısaltmaları (amk, aq, oç…) ve hakaret yazılamaz.</p>
    <p class="muted" style="margin-top:18px;font-size:12px;text-align:center">Sürüm ${VERSION}</p></div>`);
}
$("#rulesBtn").onclick = openRules;
$("#scoreBtn").onclick = openScoringGuide;
$("#reqBtn").onclick = ()=>openReport();
document.addEventListener("click", e=>{ if(e.target.closest("#pgOpen, #pgFoot")) openScoringGuide(); });

/* ====================================================== SONUÇLAR */
// Sonuçlar sekmesi açılınca: bu gecenin maçları başladıysa bugün, başlamadıysa oynanmış son gece (dün)
function resDay(){
  if(S.rday) return S.rday;
  if(S.day!==S.today) return S.day;
  const D=S.days[S.today];
  return D?.games.some(g=>g.state!=="pre") ? S.today : shiftDay(S.today,-1);
}
async function renderResults(){
  const day = resDay();
  const rel = day===S.today ? "Bugün" : day===shiftDay(S.today,-1) ? "Dün" : day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#rdLabel").innerHTML = rel ? `${rel}<small>${dayNice(day)} (ABD)</small>` : `${dayNice(day)}<small>ABD tarihi</small>`;
  const D = S.days[day];
  if(!D){ $("#results").innerHTML=skeletonCards(2); loadDay(day).then(()=>{ if(S.tab==="sonuclar") renderResults(); }).catch(()=>{ $("#results").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor.</div>`; }); return; }
  if(!D.games.length){ $("#results").innerHTML=`<div class="note">Bu gece NBA'de maç yok. Oklarla diğer günlere bakabilirsin.</div>`; return; }
  const order={in:0,post:1,pre:2};
  const games=[...D.games].sort((a,b)=>(order[a.state]-order[b.state])||(a.start-b.start));
  const hl = inLeague(day) ? headlineOf(day) : "", hw = dayWinner(day);
  $("#results").innerHTML = (hl?`<div class="headline" style="--hc:${hw?.st==="w"?col(hw.u):"var(--amber)"}"><span>🌙</span><span><b>Gecenin manşeti</b>${esc(hl)}</span></div>`:"") + `<div class="res">${games.map(g=>{
    const tm = side => { const t=g[side], o=side==="home"?g.away:g.home; const lose=g.state==="post" && (t.score??0)<(o.score??0);
      return `<div class="rg-t ${lose?"lose":""}"><img src="${t.logo||""}" alt=""><span class="n">${esc(t.name)}<small>${t.rec}</small></span><span class="sc">${g.state==="pre"?"":t.score??""}</span></div>`; };
    const tops = g.state==="post" ? topsOf(g) : g.state==="in" ? liveTops(g) : null;
    const s = S.sums[g.id]?.data;
    let lead = "";
    if(s && g.state!=="pre"){
      const bp = boxPlayers(s);
      const best = side => { const arr=bp.filter(p=>p.team===g[side].abbr).sort((a,b)=>b.pts-a.pts)[0]; return arr?`${esc(g[side].name)}: <b>${esc(arr.name)}</b> ${arr.pts} sayı, ${arr.reb} rib, ${arr.ast} ast`:""; };
      lead = [best("away"),best("home")].filter(Boolean).join("<br>");
    } else if(tops){ lead = `En skorer: <b>${tops.map(t=>esc(t.name)).join(", ")}</b> ${tops[0].pts} sayı`; }
    return `<button class="rg ${g.state==="in"?"is-live":""}" data-g="${g.id}"><div class="rg-h"><span class="s">${g.state==="in"?'<span class="badge-live">Canlı</span> ':""}${gameStatusTR(g)}</span><span>${g.state==="pre"?"Türkiye saati":"İstatistikler ›"}</span></div>
      ${tm("away")}${tm("home")}${lineScore(g)}${lead?`<div class="rg-l">${lead}</div>`:""}</button>`;
  }).join("")}</div>`;
  // biten maçların oyuncu istatistiklerini arka planda getir
  const need = games.filter(g=>g.state==="post" && !S.sums[g.id]);
  if(need.length) Promise.all(need.slice(0,15).map(g=>loadSummary(g).catch(()=>null))).then(()=>{ if(S.tab==="sonuclar" && (resDay())===day) renderResults(); });
}
$("#results").addEventListener("click", e => {
  const b=e.target.closest(".rg"); if(!b) return;
  const D=S.days[resDay()]; const g=D?.games.find(x=>x.id===b.dataset.g); if(!g) return;
  if(g.state==="pre") return openInfo(g);
  openBox(g);
});
$("#rdPrev").onclick=()=>{ S.rday=shiftDay(resDay(),-1); renderResults(); };
$("#rdNext").onclick=()=>{ S.rday=shiftDay(resDay(),1); renderResults(); };

/* ====================================================== AYRIŞMA */
// Tahminler sekmesi: gecenin bütün maçlarında herkesin seçimi. Bir gecenin tahminleri, sonraki gecenin
// ilk maçı kilitlenene kadar burada kalır.
function tahDefault(){ const T=S.days[S.today]; return T && T.games.length && T.games.some(started) ? S.today : shiftDay(S.today,-1); }
function tahDay(){ const d=tahDefault(); return S.thDay && S.thDay<d ? S.thDay : d; }
function renderAyrisma(){
  const day=tahDay(), D=S.days[day];
  const isDef = day===tahDefault();
  $("#ayrDay").innerHTML = `<span class="th-nav"><button class="btn sm" data-thd="-1" type="button" aria-label="Önceki gece">‹</button><span>${dayNice(day,{day:"numeric",month:"long"})} gecesi</span><button class="btn sm" data-thd="1" type="button" aria-label="Sonraki gece" ${isDef?"disabled":""}>›</button>${isDef?"":`<button class="linkish" data-thd="0" type="button">Son gece</button>`}</span>`;
  $("#ayrDay").onclick = e => { const b=e.target.closest("[data-thd]"); if(!b || b.disabled) return; const v=+b.dataset.thd; S.thDay = v===0 ? null : shiftDay(day, v); if(S.thDay && S.thDay>=tahDefault()) S.thDay=null; renderAyrisma(); };
  if(!D){ $("#ayrisma").innerHTML=`<div class="note">Yükleniyor…</div>`; loadDay(day).then(()=>{ if(S.tab==="ayrisma") renderAyrisma(); }).catch(()=>{ $("#ayrisma").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor.</div>`; }); return; }
  if(!D.games.length){ $("#ayrisma").innerHTML=`<div class="note">Bu gece maç yok.</div>`; return; }
  const pts=dayPoints(day);
  const sideBox = (g, side, picks) => {
    const t=g[side], o=side==="home"?g.away:g.home;
    const ps=picks.filter(x=>x[1].winner===t.abbr).map(x=>[...x, g.state!=="pre"?scorePick(g,x[1],D.daily[x[0]]?.confGame===g.id).pts:0]).sort((a,b)=>b[2]-a[2]);
    const diff=(t.score??0)-(o.score??0);
    const cls = g.state==="post" ? (diff>0?"won":"lost") : g.state==="in" && diff>0 ? "leading" : "";
    const who = ps.map(([u,p])=>{
      const cf=D.daily[u]?.confGame===g.id, r = g.state!=="pre" ? scorePick(g,p,cf) : null;
      return `<div class="fo-p" data-hsu="${u}" title="${esc(pname(u))} · tahmin geçmişi">${avatar(u,"sm")}<span class="fo-pi"><b style="color:${col(u)}">${esc(pname(u))}${cf?' <span class="star">★</span>':""}</b><small>${p.margin} · ${faceImg(p.scorerId,"fo-face")}${esc(p.scorerName)}</small></span>${r&&(g.state==="post"||g.state==="in")?`<span class="pt-badge ${r.pts>0?"pos":r.pts<0?"neg":"zero"}">${r.pts>0?"+":""}${r.pts}</span>`:""}</div>`;
    }).join("") || `<small class="muted fo-none">kimse seçmedi</small>`;
    return `<div class="fo-side ${cls}" style="--tc:${tcol(t.abbr)}"><div class="fo-tm"><img src="${t.logo||LOGO_SMALL(t.abbr)}" alt=""><span><b>${esc(t.abbr)}</b><small>${esc(t.name)}</small></span>${g.state!=="pre"?`<span class="fo-sc">${t.score??""}</span>`:""}</div>${who}
      ${cls==="won"?(ps.length && ps.length*2<picks.length?'<span class="fo-flag minor">Azınlıkta kaldı, haklı çıktı</span>':'<span class="fo-flag">Haklı çıktı</span>'):cls==="leading"?'<span class="fo-flag lead">Şu an önde</span>':""}</div>`;
  };
  const order = g => g.state==="in" ? 0 : g.state==="post" ? 1 : 2;
  const games=[...D.games].sort((a,b)=>order(a)-order(b) || a.start-b.start);
  const fu = S.thFilter && S.order.includes(S.thFilter) ? S.thFilter : null;
  const chips = `<div class="chips th-f"><button class="chip" data-thf="" aria-pressed="${!fu}">Herkes</button>${S.order.map(u=>`<button class="chip" data-thf="${u}" aria-pressed="${fu===u}" style="--pc:${col(u)}">${esc(pname(u))}</button>`).join("")}</div>`;
  const fin=D.games.filter(g=>g.state==="post");
  let summary="";
  if(fin.length){
    let best=null; const wrong={}, teamCnt={}; let bn=0, bok=0;
    for(const g of D.games.filter(started)) for(const u of S.order){ const p=D.picks[g.id]?.[u]; if(!p) continue; teamCnt[p.winner]=(teamCnt[p.winner]||0)+1;
      if(g.state!=="post") continue; const cf=D.daily[u]?.confGame===g.id, r=scorePick(g,p,cf);
      if(!best || r.pts>best.r.pts) best={u,g,r,p}; if(!(r.w>0)) wrong[u]=(wrong[u]||0)+1; if(cf){ bn++; bok+=r.w>0; } }
    const wm=Math.max(0,...Object.values(wrong)), wu=Object.keys(wrong).filter(u=>wrong[u]===wm);
    const tt=Object.entries(teamCnt).sort((a,b)=>b[1]-a[1])[0];
    const it=(ico,l,v)=>`<div class="ns-i"><span class="ns-ic">${ico}</span><span><small>${l}</small><b>${v}</b></span></div>`;
    summary=`<div class="ns">${[
      best&&best.r.pts>0 ? it("🏆","En iyi tahmin",`<span style="color:${col(best.u)}">${esc(pname(best.u))}</span> +${best.r.pts} · ${esc(best.g.away.abbr)}-${esc(best.g.home.abbr)}`) : "",
      wm ? it("😬","En çok yanılan",`${wu.map(u=>`<span style="color:${col(u)}">${esc(pname(u))}</span>`).join(", ")} · ${wm} maç`) : "",
      tt ? it(`<img src="${LOGO_SMALL(tt[0])}" alt="">`,"En çok seçilen",`${esc(tt[0])} · ${tt[1]} kez`) : "",
      bn ? it("★","Bankolar",`${bok}/${bn} tuttu`) : "",
      (()=>{ const up=fin.map(g=>{ const w=(g.home.score??0)>(g.away.score??0)?g.home:g.away, h=homeProb(g); if(h==null) return null; const pr=w.abbr===g.home.abbr?h:1-h; return pr<=0.33 ? {g,w,pr} : null; }).filter(Boolean).sort((a,b)=>a.pr-b.pr)[0];
        if(!up) return ""; const who=S.order.filter(u=>D.picks[up.g.id]?.[u]?.winner===up.w.abbr);
        return it(`<img src="${LOGO_SMALL(up.w.abbr)}" alt="">`,"Gecenin sürprizi",`${esc(up.w.abbr)} kazandı (ESPN %${Math.round(up.pr*100)}) · ${who.length?`bilen: ${who.map(u=>`<span style="color:${col(u)}">${esc(pname(u))}</span>`).join(", ")}`:"kimse bilemedi"}`); })()].join("")}</div>`;
  }
  const board = summary + `<div class="th-board">${[...S.order].sort((a,b)=>(pts[b]?.pts??0)-(pts[a]?.pts??0)).map(u=>`<div class="th-u" style="--pc:${col(u)}">${avatar(u,"sm")}<b>${esc(pname(u))}</b><span class="tnum">${pts[u]?.pts??0}</span></div>`).join("")}</div>`;
  const card = g=>{
    if(!started(g)){
      const done=S.order.filter(u=>D.progress?.[u]?.has(g.id));
      return `<div class="faceoff wait${g.cup?" cup":""}">${g.cup?`<div class="cup-band">${cupTag(g)}</div>`:""}<div class="fo-h"><span>${esc(g.away.name)} @ ${esc(g.home.name)}</span><small>${timeTR(g.start)}</small></div>
        <div class="fo-wait"><span>Seçimler <b>${timeTR(g.lock)}</b>'de açılır</span><span class="fo-done">${done.map(u=>avatar(u,"xs")).join("")}<small>${done.length}/${S.order.length} tahmin yaptı</small></span></div></div>`;
    }
    const picks = S.order.filter(u=>!fu || u===fu).map(u=>[u, D.picks[g.id]?.[u]]).filter(x=>x[1]);
    const none = S.order.filter(u=>(!fu || u===fu) && !D.picks[g.id]?.[u]);
    const same = picks.length>1 && new Set(picks.map(x=>x[1].winner)).size===1;
    const st = g.state==="in"?`<span class="badge-live">Canlı</span> ${gameStatusTR(g)}`:gameStatusTR(g);
    const tops = g.state==="post" ? topsOf(g) : g.state==="in" ? liveTops(g) : null;
    const allPicks = S.order.map(u=>[u, D.picks[g.id]?.[u]]).filter(x=>x[1]);
    const myP=D.picks[g.id]?.[S.uid]; let vs="";
    if(myP && allPicks.length>2){ const same=allPicks.filter(x=>x[1].winner===myP.winner).length-1, others=allPicks.length-1;
      vs = same===0 ? `<span class="th-me alone">Sen tek başına ${esc(myP.winner)} dedin</span>` : same*2<others ? `<span class="th-me minor">Azınlıktasın (${same+1}/${allPicks.length})</span>` : ""; }
    return `<div class="faceoff ${g.state==="in"?"is-live":""}${g.cup?" cup":""}">${g.cup?`<div class="cup-band">${cupTag(g)}</div>`:""}<button class="fo-h fo-hb" data-box="${g.id}" type="button" title="Kutu skoru"><span>${esc(g.away.name)} @ ${esc(g.home.name)}${same?' <small class="fo-same">herkes aynı tarafta</small>':""}${vs}</span><small>${st} ›</small></button>
      ${shareBar(D,g)}<div class="fo-body">${sideBox(g,"away",picks)}<div class="fo-vs"><span>VS</span></div>${sideBox(g,"home",picks)}</div>
      ${g.state!=="pre"?(()=>{ const df=Math.abs((g.home.score??0)-(g.away.score??0)), b=bucketOf(g,df), lead=(g.home.score??0)>(g.away.score??0)?g.home.abbr:g.away.abbr;
        return `<div class="fo-res"><div class="fo-ri"><small>${g.state==="post"?"Fark":"Şu anki fark"}</small><b>${df ? `${esc(lead)} +${df}` : "Eşit"}</b><span class="fo-bar">${df && !isRules2(g)?`${b} baremi`:""}</span></div>
          <div class="fo-ri"><small>${g.state==="post"?"En skorer":"Şu an en skorer"}</small><b>${tops?tops.map(x=>esc(x.name)).join(", "):"—"}</b><span class="fo-bar">${tops?`${tops[0].pts} sayı`:""}</span></div></div>`; })():""}
      ${none.length?`<div class="fo-foot"><span class="muted">Tahmin yapmayan: ${none.map(u=>`<button class="linkish fo-hs" data-hsu="${u}" type="button">${esc(pname(u))}</button>`).join(", ")}</span></div>`:""}</div>`;
  };
  const grp = (t, list, open=true) => list.length ? `<details class="th-grp" ${open?"open":""}><summary><b>${t}</b><span>${list.length} maç</span></summary><div class="split">${list.map(card).join("")}</div></details>` : "";
  const html = grp("Canlı", games.filter(g=>g.state==="in")) + grp("Biten", games.filter(g=>g.state==="post"))
    + grp("Kilitte / başlamadı", games.filter(g=>g.state==="pre"), !games.some(g=>g.state!=="pre"));
  const next = day!==S.today && S.days[S.today]?.games.length ? `<div class="note" style="margin-top:12px">Bu gecenin seçimleri ilk maçın kilidiyle (${timeTR(S.days[S.today].games[0].lock)}) burada görünmeye başlar.</div>` : "";
  $("#ayrisma").innerHTML = board + chips + html + next;
  $("#ayrisma").onclick = e => { const bx=e.target.closest("[data-box]"); if(bx){ const g=D.games.find(x=>x.id===bx.dataset.box); if(g) openBox(g); return; }
    const h=e.target.closest("[data-hsu]"); if(h) openHistory(h.dataset.hsu); };
  $("#ayrisma .th-f").onclick = e => { const b=e.target.closest("[data-thf]"); if(!b) return; S.thFilter=b.dataset.thf||null; renderAyrisma(); };
}

/* ====================================================== sezon grafiği ve gece takvimi */
function dayWinner(d){
  const p=dayPoints(d);
  if(!S.order.some(u=>p[u]?.n)) return null;
  if(S.order.some(u=>p[u] && !p[u].final)) return {st:"live"};
  const nv=u=>p[u] ? p[u].pts-(p[u].bon||0) : -99;   // devamlılık bonusu gece birinciliğine sayılmaz
  const best=Math.max(...S.order.map(nv)); const w=S.order.filter(u=>nv(u)===best);
  return w.length===1 ? {st:"w", u:w[0], pts:best} : {st:"t", pts:best};
}
function spreadLabels(items, gap, top, bottom){
  const a=[...items].sort((p,q)=>p.y-q.y);
  for(let i=0;i<a.length;i++) a[i].ly=Math.max(a[i].y, i?a[i-1].ly+gap:top);
  for(let i=a.length-1;i>=0;i--) a[i].ly=Math.min(a[i].ly, i<a.length-1?a[i+1].ly-gap:bottom);
  return a;
}
function rankChart(){
  const days=[...allDays()].reverse(); if(days.length<2 || S.order.length<2) return "";
  const cum={}, rk={}; S.order.forEach(u=>{cum[u]=0; rk[u]=[];});
  for(const d of days){ const p=dayPoints(d); S.order.forEach(u=>cum[u]+=p[u]?.pts||0);
    const r=[...S.order].sort((a,b)=>cum[b]-cum[a]); r.forEach((u,i)=>{ const same=r.findIndex(x=>cum[x]===cum[u]); rk[u].push(same+1); }); }
  const N=S.order.length, W=600, H=Math.max(150, 26*N+30), L=26, R=90, T=14, B=24, n=days.length;
  const x=i=>L+(W-L-R)*(n===1?0:i/(n-1)), y=r=>T+(H-T-B)*(r-1)/Math.max(1,N-1);
  let g=""; for(let r=1;r<=N;r++) g+=`<line x1="${L}" x2="${W-R}" y1="${y(r)}" y2="${y(r)}" class="gl"/><text x="2" y="${y(r)+4}" class="gt">${r}.</text>`;
  const me=S.uid, rv=S.players[S.uid]?.rival;
  const lines=S.order.map(u=>{ const hi=u===me||u===rv; return `<polyline points="${rk[u].map((r,i)=>`${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(" ")}" fill="none" stroke="${col(u)}" stroke-width="${hi?4:2.5}" opacity="${hi||!rv?1:.55}" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(n-1)}" cy="${y(rk[u][n-1])}" r="5" fill="${col(u)}" stroke="var(--panel)" stroke-width="2"/>`; }).join("")
    + spreadLabels(S.order.map(u=>({u, y:y(rk[u][n-1])+4})), 17, T+4, H-B+2).map(o=>`${Math.abs(o.ly-o.y)>3?`<line x1="${x(n-1)+6}" y1="${o.y-4}" x2="${x(n-1)+9}" y2="${o.ly-4}" stroke="${col(o.u)}" stroke-width="1" opacity=".6"/>`:""}<text x="${x(n-1)+10}" y="${o.ly}" class="el el-s" fill="${col(o.u)}">${esc(pname(o.u))}</text>`).join("");
  const dl=d=>dayNice(d,{day:"numeric",month:"short"});
  return `<div class="sec-title"><h2>Sıralama grafiği</h2><span class="aside">her gecenin sonunda kaçıncıydın</span></div>
    <div class="box chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gece gece sıralama">${g}${lines}
    <text x="${L}" y="${H-6}" class="gt">${dl(days[0])}</text><text x="${W-R}" y="${H-6}" class="gt" text-anchor="end">${dl(days[n-1])}</text></svg></div>`;
}
// Sezon yarışı: gece gece toplam puanla çubuklar yarışır
function raceData(){
  const days=[...allDays()].reverse(); const cum={}; S.order.forEach(u=>cum[u]=0);
  return days.map(d=>{ const p=dayPoints(d); S.order.forEach(u=>cum[u]+=p[u]?.pts||0); return {d, v:{...cum}}; });
}
function raceHTML(){
  if(S.order.length<2 || allDays().length<2) return "";
  return `<div class="sec-title"><h2>Sezon yarışı</h2><button class="btn sm" id="raceBtn" type="button">▶ Oynat</button></div><div class="box race" id="race">${raceFrame(raceData().at(-1))}</div>`;
}
function raceFrame(f){
  const rk=[...S.order].sort((a,b)=>f.v[b]-f.v[a]), max=Math.max(1,...Object.values(f.v));
  return `<div class="rc-day">${dayNice(f.d,{day:"numeric",month:"long"})}</div><div class="rc-rows" style="height:${S.order.length*30}px">${S.order.map(u=>{ const i=rk.indexOf(u);
    return `<div class="rc-r" data-rcu="${u}" style="transform:translateY(${i*30}px)"><span class="rc-n">${esc(pname(u))}</span><span class="rc-b"><i style="width:${Math.max(2,f.v[u]/max*100)}%;background:${col(u)}"></i></span><b class="tnum">${f.v[u]}</b></div>`; }).join("")}</div>`;
}
function playRace(){
  const box=$("#race"); if(!box || playRace.t) return; const F=raceData(); let i=0;
  box.innerHTML=raceFrame(F[0]); $("#raceBtn").textContent="■ Durdur";
  const step=()=>{ i++; if(i>=F.length || !$("#race")){ clearInterval(playRace.t); playRace.t=null; if($("#raceBtn")) $("#raceBtn").textContent="▶ Tekrar"; return; }
    const f=F[i], rk=[...S.order].sort((a,b)=>f.v[b]-f.v[a]), max=Math.max(1,...Object.values(f.v));
    box.querySelector(".rc-day").textContent=dayNice(f.d,{day:"numeric",month:"long"});
    for(const u of S.order){ const r=box.querySelector(`[data-rcu="${u}"]`); if(!r) continue; r.style.transform=`translateY(${rk.indexOf(u)*30}px)`; r.querySelector("i").style.width=Math.max(2,f.v[u]/max*100)+"%"; r.querySelector("b").textContent=f.v[u]; } };
  playRace.t=setInterval(step, 900);
}
function seasonChart(){
  const days=[...allDays()].reverse();
  if(days.length<2) return "";
  const cum={}, series={}; S.order.forEach(u=>{cum[u]=0; series[u]=[0];});
  for(const d of days){ const p=dayPoints(d); for(const u of S.order){ cum[u]+=p[u]?.pts||0; series[u].push(cum[u]); } }
  const W=600, H=210, L=8, R=64, T=12, B=26, n=days.length;
  const max=Math.max(4,...S.order.map(u=>cum[u])), min=Math.min(0,...S.order.flatMap(u=>series[u]));
  const x=i=>L+(W-L-R)*i/n, y=v=>T+(H-T-B)*(1-(v-min)/(max-min||1));
  const step=Math.max(1,Math.ceil(max/4/5)*5);
  let g=""; for(let v=0; v<=max; v+=step) g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" class="gl"/>${v?`<text x="${L}" y="${y(v)-4}" class="gt">${v}</text>`:""}`;
  const ranked=[...S.order].sort((a,b)=>cum[b]-cum[a]);
  const lines=ranked.slice().reverse().map(u=>{
    const pts=series[u].map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const lx=x(n), ly=y(cum[u]);
    return `<polyline points="${pts}" fill="none" stroke="${col(u)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" class="ln"/>
      <circle cx="${lx}" cy="${ly}" r="5" fill="${col(u)}" stroke="var(--panel)" stroke-width="2"/>`;
  }).join("");
  // uç etiketleri üst üste binmesin
  const vals=[...new Set(ranked.map(u=>cum[u]))];
  const labels=spreadLabels(vals.map(v=>({v, us:ranked.filter(u=>cum[u]===v), y:y(v)+4})), 17, T+6, H-B+4).map(o=>o.us.length===1
    ? `<text x="${W-R+8}" y="${o.ly}" class="el" fill="${col(o.us[0])}">${o.v}</text>`
    : `<text x="${W-R+8}" y="${o.ly}" class="el" fill="var(--muted)">${o.v}<tspan class="el-n" dx="3">×${o.us.length}</tspan></text>`).join("");
  const dl=d=>dayNice(d,{day:"numeric",month:"short"});
  return `<div class="sec-title"><h2>Sezon grafiği</h2><span class="aside">gece gece toplam puan</span></div>
    <div class="box chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sezon boyunca toplam puan">${g}${lines}${labels}
    <text x="${L}" y="${H-6}" class="gt">${dl(days[0])}</text><text x="${W-R}" y="${H-6}" class="gt" text-anchor="end">${dl(days[n-1])}</text></svg>
    <div class="chart-leg">${ranked.map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))}</span>`).join("")}</div></div>`;
}
function nightCalendar(){
  const start=leagueStart()||"20261020";
  if(S.today<start) return "";
  const first=weekKey(start);
  const weeks=[]; for(let wk=first; wk<=S.today; wk=shiftDay(wk,7)) weeks.push(wk);
  const cell=d=>{
    if(d<start || d>S.today) return `<span class="cc out"></span>`;
    const w=dayWinner(d), tip=dayNice(d,{day:"numeric",month:"short",weekday:"short"});
    if(!w) return `<span class="cc none" title="${tip}: oynanmadı"></span>`;
    if(w.st==="live") return `<button class="cc live" data-day="${d}" title="${tip}: sürüyor"></button>`;
    if(w.st==="t") return `<button class="cc tie" data-day="${d}" title="${tip}: berabere"></button>`;
    return `<button class="cc" data-day="${d}" style="background:${col(w.u)}" title="${tip}: ${esc(pname(w.u))} kazandı"></button>`;
  };
  const rows=["Pzt","","Çar","","Cum","","Paz"].map((lb,r)=>`<span class="cl">${lb}</span>${weeks.map(wk=>cell(shiftDay(wk,r))).join("")}`).join("");
  const months=weeks.map((wk,i)=>{ const m=dayNice(wk,{month:"short"}); return i===0||m!==dayNice(weeks[i-1],{month:"short"})?`<span>${m}</span>`:"<span></span>"; }).join("");
  const counts={}; S.order.forEach(u=>counts[u]=0); let ties=0;
  for(const d of allDays()){ const w=dayWinner(d); if(w?.st==="w") counts[w.u]++; else if(w?.st==="t") ties++; }
  return `<div class="sec-title"><h2>Gece takvimi</h2><span class="aside">her kare bir gece</span></div>
    <div class="box"><div class="cal-wrap"><div class="cal" style="--wk:${weeks.length}"><span></span>${months}${rows}</div></div>
    <div class="chart-leg">${S.order.map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))} ${counts[u]}</span>`).join("")}<span class="pn"><i style="background:var(--amber)"></i>Berabere ${ties}</span><span class="pn"><i class="none"></i>Oynanmadı</span></div></div>`;
}

/* ====================================================== sezon verisi: kayıtlar, rozetler, ödüller */
// Bir oyuncunun biten maçlardaki bütün tahmin kayıtları (arşiv + henüz arşive girmemiş canlı günler)
function userRecs(u){
  const recs=[];
  for(const [gid,row] of Object.entries(S.arch.scores.games||{})){ const r=row[u], g=S.arch.games[gid]; if(r?.pick && g) recs.push({gid, day:g.day, start:g.start, home:g.home, away:g.away, winner:g.winner, r}); }
  for(const day of [S.today, shiftDay(S.today,-1)]){
    const D=S.days[day]; if(!D || !inLeague(day)) continue;
    for(const g of D.games){ if(g.state!=="post" || S.arch.scores.games?.[g.id]?.[u]) continue; const p=D.picks[g.id]?.[u]; if(!p) continue;
      const c=D.daily[u]?.confGame===g.id, r=scorePick(g,p,c);
      recs.push({gid:g.id, day, start:g.start.toISOString(), home:g.home, away:g.away, winner:(g.home.score>g.away.score?g.home.abbr:g.away.abbr), r:{...r,c,pick:{w:p.winner,m:p.margin,s:p.scorerName}}}); }
  }
  return recs.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
}
const pickW = (u, gid) => S.arch.scores.games?.[gid]?.[u]?.pick?.w ?? Object.values(S.days).find(D=>D.picks?.[gid])?.picks[gid]?.[u]?.winner ?? null;
function nightsOf(){ return [...allDays()].reverse().map(d=>({d, w:dayWinner(d), p:dayPoints(d)})).filter(x=>x.w && x.w.st!=="live"); }
const monthKey = d => d.slice(0,6);
const monthName = k => parseYmd(k+"01").toLocaleDateString(LOC,{timeZone:"UTC",month:"long",year:"numeric"});
function monthTable(){
  const m={};
  for(const d of allDays()){ const p=dayPoints(d), k=monthKey(d); m[k] ||= {pts:{}, live:false}; for(const u of S.order) m[k].pts[u]=(m[k].pts[u]||0)+(p[u]?.pts||0); if(S.order.some(u=>p[u] && !p[u].final)) m[k].live=true; }
  return m;
}
const BADGES = [
  {id:"kahin", ico:"🔮", name:"Kâhin", desc:"Bir gecede bütün maçların kazananını bil (en az 3 maç)"},
  {id:"kusursuz", ico:"💯", name:"Kusursuz maç", desc:"Bir maçta kazanan, fark ve en skorerin üçünü de bil"},
  {id:"banko", ico:"⭐", name:"Banko kralı", desc:"Üst üste 5 bankoyu tuttur"},
  {id:"skorer", ico:"🎯", name:"Skorer avcısı", desc:"10 kez maçın en skorerini bil"},
  {id:"fark", ico:"📏", name:"Fark ustası", desc:"Bir gecede 3 maçın farkını bil"},
  {id:"gece", ico:"🌙", name:"Gece kralı", desc:"Üst üste 3 gece kazan"},
  {id:"hafta", ico:"🏆", name:"Haftanın şampiyonu", desc:"Bir haftayı kazan"},
  {id:"ay", ico:"📅", name:"Ayın şampiyonu", desc:"Bir ayı kazan"},
  {id:"oyuncu", ico:"🌟", name:"Keskin göz", desc:"Günün oyuncusunu 3 kez bil"},
  {id:"bilge", ico:"🦉", name:"Bilge", desc:"Gecenin sorusunu 5 kez bil"},
];
function badgesOf(u){
  const recs=userRecs(u), got={}, first={};
  const mark=(id,d)=>{ if(d && !first[id]) first[id]=d; };
  const byDay={}; for(const x of recs) (byDay[x.day] ||= []).push(x);
  const dKeys=Object.keys(byDay).sort();
  got.kahin=0; got.fark=0;
  for(const d of dKeys){ const a=byDay[d];
    if(a.length>=3 && a.every(x=>x.r.w>0)){ got.kahin++; mark("kahin",d); }
    if(a.filter(x=>x.r.m>0).length>=3){ got.fark++; mark("fark",d); } }
  got.kusursuz=0; let sk=0; for(const x of recs){ if(x.r.w>0 && x.r.m>0 && x.r.s>0){ got.kusursuz++; mark("kusursuz",x.day); } if(x.r.s>0){ sk++; if(sk%10===0) mark("skorer",x.day); } }
  got.skorer = Math.floor(sk/10);
  let run=0; got.banko=0; for(const x of recs.filter(x=>x.r.c)){ if(x.r.w>0){ run++; if(run===5){ got.banko++; run=0; mark("banko",x.day); } } else run=0; }
  let nr=0; got.gece=0; for(const n of nightsOf()){ if(n.w.st==="w" && n.w.u===u){ nr++; if(nr===3){ got.gece++; nr=0; mark("gece",n.d); } } else nr=0; }
  const curWk=weekKey(S.today); got.hafta=0;
  for(const [wk,row] of Object.entries(S.arch.scores.weeks||{}).sort()){ if(wk===curWk) continue; const v=Object.entries(row).filter(([x])=>S.order.includes(x)); const m=Math.max(...v.map(x=>x[1])); const w=v.filter(x=>x[1]===m); if(w.length===1 && w[0][0]===u && m>0){ got.hafta++; mark("hafta",shiftDay(wk,6)); } }
  const mt=monthTable(), curM=monthKey(S.today); got.ay=0;
  for(const [k,v] of Object.entries(mt).sort()){ if(k===curM || v.live) continue; const m=Math.max(...S.order.map(x=>v.pts[x]||0)); const w=S.order.filter(x=>(v.pts[x]||0)===m); if(w.length===1 && w[0]===u && m>0){ got.ay++; mark("ay",k+"28"); } }
  const dayRows=Object.entries(S.arch.scores.days||{}).sort().map(([d,r])=>[d,r[u]]).filter(x=>x[1]);
  let dpc=0, qc=0; for(const [d,x] of dayRows){ if(x.dp>0){ dpc++; if(dpc%3===0) mark("oyuncu",d); } if(x.qp>0){ qc++; if(qc%5===0) mark("bilge",d); } }
  got.oyuncu = Math.floor(dpc/3); got.bilge = Math.floor(qc/5);
  const prog = {skorer:`${sk%10}/10`, banko:`${run}/5`, gece:`${nr}/3`, oyuncu:`${dpc%3}/3`, bilge:`${qc%5}/5`};
  return BADGES.map(b=>({...b, n:got[b.id]||0, prog:prog[b.id]||"", first:first[b.id]||null}));
}
const badgeHTML = (list, compact=false) => `<div class="badges ${compact?"compact":""}">${list.map(b=>`<div class="bdg ${b.n?"on":""}" title="${esc(b.desc)}"><span class="bi">${b.ico}</span><span class="bt"><b>${esc(b.name)}${b.n>1?` <small>×${b.n}</small>`:""}</b>${compact?"":`<small>${b.n?esc(b.desc):esc(b.desc)+(b.prog?` · ${b.prog}`:"")}</small>`}</span></div>`).join("")}</div>`;
// Kafa kafaya: ayrışılan biten maçlarda kim haklı çıktı
function rivalry(u, v){
  const recs=userRecs(u); let n=0, me=0, them=0; const teams={};
  for(const x of recs){ const w2=pickW(v, x.gid); if(!w2 || w2===x.r.pick.w) continue; n++; if(x.r.pick.w===x.winner) me++; else if(w2===x.winner) them++;
    for(const t of [x.home.abbr, x.away.abbr]) teams[t]=(teams[t]||0)+1; }
  const top=Object.entries(teams).sort((a,b)=>b[1]-a[1])[0];
  return {n, me, them, team: top?.[0], tn: top?.[1]||0};
}
// Sezon ödülleri
function seasonAwards(){
  const P=S.order, recs=Object.fromEntries(P.map(u=>[u,userRecs(u)])), tot=seasonTotals();
  const nights=nightsOf(), days=S.arch.scores.days||{};
  const by = (f, minNeed=0) => { const v=P.map(u=>[u,f(u)]).filter(x=>x[1]!=null); if(!v.length) return null; const m=Math.max(...v.map(x=>x[1])); if(m<=minNeed) return null; return {us:v.filter(x=>x[1]===m).map(x=>x[0]), v:m}; };
  const pct = u => recs[u].length>=20 ? Math.round(recs[u].filter(x=>x.r.w>0).length/recs[u].length*100) : null;
  const streak = u => { let b=0,c=0; for(const n of nights){ if(n.w.st==="w"&&n.w.u===u){c++;b=Math.max(b,c);} else c=0; } return b; };
  return [
    {ico:"🏀", t:"Sezonun MVP'si", d:"En çok puan", r:by(u=>tot[u]), f:v=>`${v} puan`},
    {ico:"🔮", t:"Kâhin", d:"Kazanan isabeti en yüksek (en az 20 maç)", r:by(pct), f:v=>`%${v}`},
    {ico:"🌙", t:"Gecelerin hâkimi", d:"En çok gece kazanan", r:by(u=>nights.filter(n=>n.w.st==="w"&&n.w.u===u).length), f:v=>`${v} gece`},
    {ico:"🔥", t:"En uzun seri", d:"Üst üste kazanılan gece", r:by(streak), f:v=>`${v} gece`},
    {ico:"🎯", t:"Skorer avcısı", d:"En çok en skorer bilen", r:by(u=>recs[u].filter(x=>x.r.s>0).length), f:v=>`${v} kez`},
    {ico:"📏", t:"Fark ustası", d:"En çok fark bilen", r:by(u=>recs[u].filter(x=>x.r.m>0).length), f:v=>`${v} kez`},
    {ico:"⭐", t:"Banko kralı", d:"Bankodan en çok net puan", r:by(u=>recs[u].filter(x=>x.r.c).reduce((s,x)=>s+(x.r.w>0?2:-1),0)), f:v=>`${v>0?"+":""}${v} puan`},
    {ico:"🌟", t:"Keskin göz", d:"Günün oyuncusunu en çok bilen", r:by(u=>Object.values(days).filter(r=>r[u]?.dp>0).length), f:v=>`${v} kez`},
    {ico:"🦉", t:"Bilge", d:"Gecenin sorusunu en çok bilen", r:by(u=>Object.values(days).filter(r=>r[u]?.qp>0).length), f:v=>`${v} kez`},
  ];
}
function openAwards(){
  const list=seasonAwards();
  openSheet(`<h3 id="shTitle">Sezon ödülleri</h3><p class="muted">Sezon sürüyor; ödüller şu ana kadarki sonuçlara göre. Sezon bitince kesinleşir.</p>
    <div class="awards">${list.map(a=>`<div class="aw"><span class="aw-i">${a.ico}</span><span class="aw-t"><b>${a.t}</b><small>${a.d}</small></span>
      <span class="aw-w">${a.r?a.r.us.map(u=>`${avatar(u,"sm")}<b style="color:${col(u)}">${esc(pname(u))}</b>`).join(" ")+`<small>${a.f(a.r.v)}</small>`:'<small class="muted">henüz sahibi yok</small>'}</span></div>`).join("")}</div>`);
}

/* ====================================================== PUAN */
// Yalnızca en az bir oyuncunun tahmin girdiği geceler
function allDays(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d]?.games.some(started)) days.add(d);
  return [...days].filter(d => inLeague(d) && (() => { const p=dayPoints(d); return S.order.some(u=>p[u]?.n); })()).sort().reverse();
}
function renderPuan(){
  const tot = seasonTotals();
  const days = allDays();
  const dayRows = days.map(d => ({d, pts: dayPoints(d)}));
  const wins = {}, wks = {}; S.order.forEach(u=>{wins[u]=0; wks[u]=0;});
  for(const {pts} of dayRows){
    const nvv=u=>pts[u] ? pts[u].pts-(pts[u].bon||0) : null; const vals = S.order.map(nvv).filter(v=>v!=null);
    if(!vals.length || S.order.some(u=>pts[u] && !pts[u].final)) continue;
    const best = Math.max(...vals); const w = S.order.filter(u=>nvv(u)===best);
    if(w.length===1) wins[w[0]]++;
  }
  const curWk = weekKey(S.today);
  for(const [wk,row] of Object.entries(S.arch.scores.weeks||{})){
    if(wk===curWk) continue;
    const best=Math.max(...Object.values(row)); const w=Object.keys(row).filter(u=>row[u]===best);
    if(w.length===1 && wks[w[0]]!==undefined) wks[w[0]]++;
  }
  const ranked=rankOrder(tot);
  // podyum: ilk üç (puan varsa)
  const rk=ranked;
  const pod = rk.length>=2 && tot[rk[0]]>0 ? `<div class="podium">${[1,0,2].filter(i=>rk[i]).map(i=>{ const u=rk[i];
    return `<div class="pd pd${i+1}" data-pu="${u}" style="--pc:${col(u)}">${avatar(u, i===0?"lg":"")}<span class="pd-nm">${S.players[u]?.club?`<b class="pd-club" style="color:${col(u)}">${esc(S.players[u].club)}</b><small class="pd-name">${esc(pname(u))}</small>`:`<b class="pd-club" style="color:${col(u)}">${esc(pname(u))}</b>`}</span><span class="pd-pts tnum">${tot[u]}</span><div class="pd-step"><span>${i+1}</span></div></div>`; }).join("")}</div>` : "";
  const rv=S.players[S.uid]?.rival; let rivalBox="";
  if(rv && S.players[rv] && tot[rv]!=null){ const d=tot[S.uid]-tot[rv], wk=weekKey(S.today), wkP=u=>dayRows.filter(x=>weekKey(x.d)===wk).reduce((s,x)=>s+(x.pts[u]?.pts||0),0), wd=wkP(S.uid)-wkP(rv);
    rivalBox=`<div class="rival-card" style="--pc:${col(rv)}">${avatar(S.uid,"sm")}<span class="rv-vs">VS</span>${avatar(rv,"sm")}<span class="rv-t"><b>Rakibin ${esc(pname(rv))}</b><small>${d>0?`Sezonda ${d} puan öndesin`:d<0?`Sezonda ${-d} puan gerisindesin`:"Sezonda puanlar eşit"} · bu hafta ${wd>0?`+${wd}`:wd}</small></span><button class="linkish" data-pu="${rv}" type="button">Profil</button></div>`; }
  let html = pod + rivalBox + `<div class="sec-title"><h2>Puan tablosu</h2><span class="aside">${trialActive() ? `<span class="trial-tag">Deneme haftası</span> ${dayNice(shiftDay(trialOf().end,1),{day:"numeric",month:"long"})}'da sıfırlanır` : S.league?.start ? dayNice(leagueStart(),{day:"numeric",month:"long"})+" gecesinden beri" : "sezon"}</span></div>
    <div class="tbl"><div class="tr th t-lb"><span>#</span><span>Oyuncu</span><span class="r">Puan</span><span class="c">Gece</span><span class="c">Hafta</span><span class="c" title="Uzun vade puanı">UV</span></div>
    ${ranked.map((u,i)=>`<div class="tr t-lb${u===rv?" rival":""}${u===S.uid?" me":""}"><span class="muted">${i+1}</span><span class="pn"><i style="background:${col(u)}"></i><span>${S.players[u]?.club?`<b class="pn-club">${esc(S.players[u].club)}</b><small class="pn-name">${esc(pname(u))}</small>`:`<b class="pn-solo">${esc(pname(u))}</b>`}</span></span><span class="r big tnum">${tot[u]}</span><span class="c tnum">${wins[u]}</span><span class="c tnum">${wks[u]}</span><span class="c tnum">${S.lt?.loaded?ltPoints(u):"–"}</span></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:6px 2px">Gece: tek başına en çok puan aldığın geceler. Hafta: kazandığın haftalar (pazartesi–pazar). UV: uzun vade tahminlerinden gelen puan (Puan'a dahil).</p>`;
  const brk = seasonBreakdown();
  html += `<div class="sec-title"><h2>Puanlar nereden geldi</h2></div>
    <div class="tbl"><div class="tr th t-br"><span>Oyuncu</span><span class="c">Kazanan</span><span class="c">Fark</span><span class="c">Skorer</span><span class="c">Diğer</span><span class="c">UV</span></div>
    ${ranked.map(u=>`<div class="tr t-br"><span class="pn"><i style="background:${col(u)}"></i><span>${esc(pname(u))}</span></span><span class="c tnum">${brk[u].w}</span><span class="c tnum">${brk[u].m}</span><span class="c tnum">${brk[u].s}</span><span class="c tnum">${brk[u].dp+brk[u].q+brk[u].sr+brk[u].aw}</span><span class="c tnum">${brk[u].lt}</span></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:6px 2px">Kazanan sütununa banko dahil. Diğer: günün oyuncusu, gecenin sorusu, playoff serileri ve lig ödülleri. UV: uzun vade tahminleri.</p>`;
  // aylık şampiyonlar duvarı
  const mt=monthTable(), curM=monthKey(S.today), mks=Object.keys(mt).sort().reverse();
  if(mks.length){
    html += `<div class="sec-title"><h2>Ayın şampiyonları</h2></div><div class="months">${mks.map(k=>{
      const v=mt[k], m=Math.max(...S.order.map(u=>v.pts[u]||0)), w=S.order.filter(u=>(v.pts[u]||0)===m), on=k===curM||v.live;
      const who = m<=0 ? '<small class="muted">henüz puan yok</small>' : w.length===1 ? `${avatar(w[0],"sm")}<b style="color:${col(w[0])}">${esc(pname(w[0]))}</b><small>${m} puan</small>` : `<b>Berabere</b><small>${m} puan</small>`;
      return `<div class="mo ${on?"live":"done"}"><span class="mo-n">${monthName(k)}</span><span class="mo-w">${on?"":"👑 "}${who}</span><span class="mo-s">${on?"sürüyor":"şampiyon"}</span></div>`; }).join("")}</div>`;
  }
  html += awardsHTML() + `<button class="btn awards-btn" id="awardsBtn" type="button">${ICON.medal}Sezon ödüllerine bak</button>`;
  const hist=[...(S.league?.history||[])].reverse();
  html += `<button class="btn awards-btn" id="archBtn" type="button">📚 Sezon arşivi</button>`;
  if(hist.length) html += `<div class="sec-title"><h2>Geçmiş ligler</h2></div><div class="months">${hist.map((h,hi)=>{ const w=h.rows?.[0];
    return `<div class="mo done" data-arch="${hist.length-1-hi}" role="button" tabindex="0"><span class="mo-n" style="text-transform:none">${h.name?`<b>${esc(h.name)}</b> · `:""}${dayNice(h.start,{day:"numeric",month:"short"})} – ${dayNice(h.end,{day:"numeric",month:"short"})}</span>
      <span class="mo-w">👑 <b>${esc(w?.name||"?")}</b><small>${w?.pts??0} puan</small></span><span class="mo-s">${(h.rows||[]).slice(1).map(r=>`${esc(r.name)} ${r.pts}`).join(" · ")}</span></div>`; }).join("")}</div>`;
  html += seasonChart() + raceHTML() + rankChart() + nightCalendar();

  // bu hafta
  const wk = weekKey(S.today);
  const wkDays = dayRows.filter(x=>weekKey(x.d)===wk).reverse();
  if(wkDays.length){
    const wt={}; S.order.forEach(u=>wt[u]=wkDays.reduce((s,x)=>s+(x.pts[u]?.pts||0),0));
    html += `<div class="sec-title"><h2>Bu hafta</h2><span class="aside">${dayNice(wk,{day:"numeric",month:"short"})}'den beri</span></div>
      <div class="box"><div style="display:flex;flex-wrap:wrap;gap:6px 18px">${[...S.order].sort((a,b)=>wt[b]-wt[a]).map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))} <span class="big tnum">${wt[u]}</span></span>`).join("")}</div></div>`;
  }

  // rekorlar
  let bestNight=null, streak={}, maxStreak={};
  S.order.forEach(u=>{streak[u]=0; maxStreak[u]=0;});
  for(const {d,pts} of [...dayRows].reverse()){
    if(S.order.some(u=>pts[u] && !pts[u].final)) continue; // süren gece rekora sayılmaz
    for(const u of S.order){ const p=pts[u]?.pts; if(p!=null && (!bestNight||p>bestNight.p)) bestNight={u,p,d}; }
    const vals=S.order.map(u=>pts[u]?.pts??-99); const best=Math.max(...vals); const w=S.order.filter(u=>(pts[u]?.pts??-99)===best);
    for(const u of S.order){ if(w.length===1 && w[0]===u){ streak[u]++; maxStreak[u]=Math.max(maxStreak[u],streak[u]); } else streak[u]=0; }
  }
  if(bestNight){
    const ms = S.order.map(u=>[u,maxStreak[u]]).sort((a,b)=>b[1]-a[1])[0];
    html += `<div class="sec-title"><h2>Rekorlar</h2></div><div class="cards2">
      <div class="kpi"><b>${bestNight.p}</b><small>En iyi gece: <span style="color:${col(bestNight.u)};font-weight:700">${esc(pname(bestNight.u))}</span>, ${dayNice(bestNight.d,{day:"numeric",month:"short"})}</small></div>
      <div class="kpi"><b>${ms[1]}</b><small>Üst üste kazanılan gece: <span style="color:${col(ms[0])};font-weight:700">${esc(pname(ms[0]))}</span></small></div>
      ${S.order.map(u=>`<div class="kpi"><b>${streak[u]}</b><small>Şu anki seri: <span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span></small></div>`).join("")}</div>`;
  }

  // gün gün
  html += `<div class="sec-title"><h2>Gece gece</h2><span class="aside">dokun, o geceye git</span></div><div class="daylist">` +
    (dayRows.length ? dayRows.map(({d,pts})=>{
      const vals=S.order.map(u=>pts[u]?.pts??null); const best=Math.max(...vals.filter(v=>v!=null));
      const w=S.order.filter(u=>pts[u]?.pts===best);
      const prov = S.order.some(u=>pts[u] && !pts[u].final);
      return `<button class="dayrow" data-day="${d}"><span class="d">${dayNice(d,{day:"numeric",month:"short",weekday:"short"})}</span>
        <span class="sc">${S.order.map(u=>`<span style="color:${col(u)}">${esc(pname(u))} ${pts[u]?.pts??0}</span>`).join("")}</span>
        <span class="w">${prov?"sürüyor":w.length===1?esc(pname(w[0])):"berabere"}</span></button>`;
    }).join("") : `${emptyBox("chart", "İlk gece bitince puan tablosu burada dolmaya başlayacak.")}`) + `</div>`;
  $("#puan").innerHTML = html;
}
$("#puan").addEventListener("click", e => { if(e.target.closest("#raceBtn")){ if(playRace.t){ clearInterval(playRace.t); playRace.t=null; e.target.textContent="▶ Oynat"; } else playRace(); return; } if(e.target.closest("#awardsBtn")) return openAwards(); if(e.target.closest("#archBtn")) return openArchive(); const ar=e.target.closest("[data-arch]"); if(ar) return openArchive(+ar.dataset.arch); const aw=e.target.closest("[data-awshow]"); if(aw) return openCeremony(aw.dataset.awshow); const b=e.target.closest("[data-day]"); if(!b) return; S.day=b.dataset.day; location.hash="#tahmin"; showDay(); });

/* ====================================================== İSTATİSTİK */
function renderStats(){
  const u = S.statFor && S.order.includes(S.statFor) ? S.statFor : S.uid || S.order[0];
  const chips = `<div class="chips" id="statSel" style="margin-top:4px">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>`;
  $("#istatistik").innerHTML = (u?chips:"") + statsBody(u, {badges:true}); bindStatSel();
}
// Kişisel analiz: hangi takımları iyi biliyorsun, ev/deplasman, fark aralıkları, banko gidişatı
// Puanların nereden geldi: favori mi, sürpriz mi; hangi kategoriden
// Sürpriz kademesinden gelen ek puan (aynı maç favorinin kazanması halinde alınacak puana göre fark)
function upsetExtra(recs){
  let x=0; for(const r0 of recs){ const r=r0.r; if(!(r.w>0) || !(r.tier>1)) continue; const g=S.arch.games?.[r0.gid]||{seasonType:2}; const k=multOf(g);
    x += Math.min(WIN_CAP, r.w*k) - Math.min(WIN_CAP, (r.w/r.tier)*k); }
  return x;
}
function luckHTML(u){
  const recs=userRecs(u).filter(x=>x.r.w>0); if(recs.length<5) return "";
  let fav=0, und=0, unk=0;
  for(const x of recs){ const f=S.arch.games?.[x.gid]?.fav; if(!f) unk++; else if(f===x.r.pick?.w) fav++; else und++; }
  const b=seasonBreakdown()[u]||{}; const ux=upsetExtra(userRecs(u));
  const tot=Math.max(1,(b.w||0)+(b.m||0)+(b.s||0)+(b.dp||0)+(b.q||0)+(b.sr||0)+(b.bon||0)+(b.auto||0)+(b.lt||0)+(b.aw||0));
  const parts=[["Kazanan",(b.w||0)-ux],["Sürpriz eki",ux],["Fark",b.m],["Skorer",b.s],["Günün oyuncusu",b.dp],["Gecenin sorusu",b.q],["Playoff serisi",b.sr],["Devamlılık",b.bon],["Otomatik tahmin",b.auto],["Uzun vade",b.lt],["Lig ödülleri",b.aw]].filter(x=>x[1]);
  const known=fav+und;
  return `<div class="sec-title"><h2 style="font-size:20px">Puanların nereden geldi</h2></div><div class="box luck">
    ${known?`<div class="lk-bar"><i style="width:${fav/known*100}%"></i></div><div class="lk-l"><span><b>%${Math.round(fav/known*100)}</b> favoriyi bilerek</span><span><b>%${Math.round(und/known*100)}</b> sürprizi bilerek</span></div>
    <small class="muted">${known} doğru kazanan tahmini, ESPN'in maç önü favorisine göre${unk?` (${unk} maçta favori bilgisi yok)`:""}.</small>`:""}
    <div class="lk-parts">${parts.map(([l,v])=>`<span><b class="tnum">${v}</b><small>${l} · %${Math.round(v/tot*100)}</small></span>`).join("")}</div></div>`;
}
// Sezon özeti ("Wrapped")
function openWrapped(u=S.uid){
  const recs=userRecs(u), me=u===S.uid, tot=seasonTotals(), rk=rankOrder(tot), nw=nightWins();
  if(recs.length<3){ openSheet(`<h3 id="shTitle">Sezon özeti</h3>${emptyBox("chart", "Özet için biraz daha maç tahmin etmek gerekiyor.")}`); return; }
  const byT={}; for(const x of recs){ for(const t of [x.home.abbr,x.away.abbr]){ const o=byT[t] ||= {n:0,ok:0}; o.n++; o.ok+=x.r.w>0; } }
  const bestT=Object.entries(byT).filter(([,o])=>o.n>=3).sort((a,b)=>b[1].ok/b[1].n-a[1].ok/a[1].n || b[1].n-a[1].n)[0];
  const picked={}; recs.forEach(x=>{ const w=x.r.pick?.w; if(w) picked[w]=(picked[w]||0)+1; }); const fav=Object.entries(picked).sort((a,b)=>b[1]-a[1])[0];
  const sc={}; recs.forEach(x=>{ const n=x.r.pick?.s; if(n){ const o=sc[n] ||= {n:0,ok:0}; o.n++; o.ok+=x.r.s>0; } }); const fsc=Object.entries(sc).sort((a,b)=>b[1].n-a[1].n)[0];
  const nights=allDays().map(d=>({d,p:dayPoints(d)[u]})).filter(x=>x.p?.n); const best=nights.sort((a,b)=>b.p.pts-a.p.pts)[0];
  let run=0, mx=0; [...recs].sort((a,b)=>(a.start||"").localeCompare(b.start||"")).forEach(x=>{ run = x.r.w>0 ? run+1 : 0; mx=Math.max(mx,run); });
  const bank=recs.filter(x=>x.r.c), bankOk=bank.filter(x=>x.r.w>0).length;
  const ups=recs.filter(x=>{ const f=S.arch.games?.[x.gid]?.fav; return f && x.r.w>0 && f!==x.r.pick?.w; }).length;
  const card=(i,big,l,sub="")=>`<div class="wr-c"><span class="wr-i">${i}</span><b>${big}</b><span>${l}</span>${sub?`<small>${sub}</small>`:""}</div>`;
  const tn=a=>ALLP?.teams.find(t=>t.a===a)?.n||a;
  openSheet(`<div class="wr-head" style="--pc:${col(u)}">${avatar(u,"lg")}<div><small>Sezon özeti</small><h3 id="shTitle">${esc(pname(u))}</h3></div></div>
    <div class="wr-grid">
    ${card("🏆", `${rk.indexOf(u)+1}.`, `sırada, ${tot[u]||0} puan`)}
    ${card("🌙", nights.length, "gece oynadı", `${nw[u]||0} geceyi kazandı`)}
    ${card("✅", `%${Math.round(recs.filter(x=>x.r.w>0).length/recs.length*100)}`, "kazananı bilme", `${recs.length} maç`)}
    ${best?card("🔥", `${best.p.pts} puan`, "en iyi gece", dayNice(best.d,{day:"numeric",month:"long"})):""}
    ${card("📈", mx, "üst üste doğru kazanan")}
    ${bank.length?card("★", `${bankOk}/${bank.length}`, "tutan banko"):""}
    ${card("🎯", ups, "favorinin tersine bildi", (()=>{ const x=upsetExtra(recs); return x?`sürprizden +${x} puan`:""; })())}
    ${bestT?card(`<img src="${LOGO_SMALL(bestT[0])}" alt="">`, `%${Math.round(bestT[1].ok/bestT[1].n*100)}`, `en iyi okuduğu takım: ${esc(tn(bestT[0]))}`, `${bestT[1].n} maç`):""}
    ${fav?card(`<img src="${LOGO_SMALL(fav[0])}" alt="">`, fav[1], `kez ${esc(tn(fav[0]))} dedi`):""}
    ${fsc?card("🏀", `${fsc[1].ok}/${fsc[1].n}`, `en çok seçtiği skorer: ${esc(fsc[0])}`):""}
    </div>${me?`<button class="btn" id="wrShare" type="button" style="width:100%;margin-top:12px">${ICON.share||""}Paylaş</button>`:""}`);
  $("#wrShare")?.addEventListener("click", async()=>{ const t=`NBA Tahmin sezon özetim: ${rk.indexOf(u)+1}. sıradayım, ${tot[u]||0} puan, kazananı %${Math.round(recs.filter(x=>x.r.w>0).length/recs.length*100)} bildim. ${location.origin}${location.pathname}`;
    try{ if(navigator.share) return await navigator.share({text:t}); await navigator.clipboard.writeText(t); toast("Kopyalandı."); }catch(e){} });
}
function analysisHTML(u){
  const recs=userRecs(u); if(recs.length<5) return "";
  const pc=(a,b)=>b?Math.round(a/b*100):0, nm=a=>ALLP?.teams.find(t=>t.a===a)?.n?.split(" ").slice(-1)[0]||a;
  const byT={}; for(const x of recs){ const t=x.r.pick?.w; if(!t) continue; const o=byT[t] ||= {n:0,ok:0}; o.n++; o.ok+=x.r.w>0; }
  const tl=Object.entries(byT).filter(([,o])=>o.n>=2).map(([t,o])=>({t,...o,p:pc(o.ok,o.n)}));
  const best=[...tl].sort((a,b)=>b.p-a.p||b.n-a.n).slice(0,3), worst=[...tl].sort((a,b)=>a.p-b.p||b.n-a.n).slice(0,3);
  const tRow=x=>`<div class="an-t"><img src="${LOGO_SMALL(x.t)}" alt=""><span>${esc(nm(x.t))}</span><small>${x.ok}/${x.n}</small><b>%${x.p}</b></div>`;
  const home=recs.filter(x=>x.r.pick?.w===x.home?.abbr), away=recs.filter(x=>x.r.pick?.w===x.away?.abbr);
  const ok=a=>a.filter(x=>x.r.w>0).length;
  const mb={}; for(const x of recs){ if(!(x.r.w>0) || !x.r.pick?.m) continue; const o=mb[x.r.pick.m] ||= {n:0,ok:0}; o.n++; o.ok+=x.r.m>0; }
  const bank=recs.filter(x=>x.r.c).slice(-12);
  const bar=(l,a,b)=>`<div class="ev-row"><span>${l}</span><div class="ev-bar"><i style="width:${pc(a,b)}%;background:${col(u)}"></i></div><b>%${pc(a,b)}</b></div>`;
  return `<div class="box an"><div class="row-lbl" style="margin-top:0">Analiz</div>
    ${tl.length?`<div class="an-cols"><div><small class="muted">En iyi bildiğin takımlar</small>${best.map(tRow).join("")}</div><div><small class="muted">En çok yanıldığın</small>${worst.map(tRow).join("")}</div></div>`:""}
    <div class="row-lbl">Ev sahibi mi, deplasman mı?</div>${bar(`Ev sahibini seçince (${home.length})`,ok(home),home.length)}${bar(`Deplasmanı seçince (${away.length})`,ok(away),away.length)}
    ${(()=>{ const num=recs.filter(x=>x.r.w>0 && /^\d+$/.test(String(x.r.pick?.m||"")) && x.home?.score!=null);
      if(!num.length) return "";
      const errs=num.map(x=>Math.abs(+x.r.pick.m-Math.abs((x.home.score||0)-(x.away.score||0)))), hit=num.filter(x=>x.r.m>0).length;
      const under=num.filter(x=>+x.r.pick.m < Math.abs((x.home.score||0)-(x.away.score||0))).length;
      return `<div class="row-lbl">Fark tahminin (kazananı bildiğin ${num.length} maç)</div>${bar(`±3 içinde tutturma`,hit,num.length)}
        <div class="an-mg"><span><b class="tnum">${(errs.reduce((a,b)=>a+b,0)/errs.length).toFixed(1)}</b><small>ortalama şaşma (sayı)</small></span><span><b class="tnum">%${pc(under,num.length)}</b><small>farkı az tahmin ettiğin maçlar</small></span></div>`; })()}
    ${(()=>{ const old=[...MARGINS,...MARGINS2].filter(m=>mb[m]); return old.length?`<div class="row-lbl">Eski baremlerle (3 Kasım'a kadar)</div>${old.map(m=>bar(`${m} sayı (${mb[m].n})`,mb[m].ok,mb[m].n)).join("")}`:""; })()}
    ${bank.length?`<div class="row-lbl">Son bankoların</div><div class="an-bank">${bank.map(x=>`<i class="${x.r.w>0?"ok":"no"}" title="${esc(x.away?.abbr||"")} @ ${esc(x.home?.abbr||"")}">${x.r.w>0?"✓":"✗"}</i>`).join("")}<small>${ok(bank)}/${bank.length} tuttu</small></div>`:""}
  </div>`;
}
// ESPN'in maç önü favorisiyle karşılaştırma (sync her biten maça "fav" yazar)
function espnVsHTML(u){
  let n=0, me=0, es=0, against=0, againstOk=0;
  for(const [gid,row] of Object.entries(S.arch.scores.games||{})){ const g=S.arch.games[gid], r=row[u]; if(!g?.fav || !r?.pick?.w) continue;
    n++; const ok=r.pick.w===g.winner; me+=ok; es+=g.fav===g.winner; if(r.pick.w!==g.fav){ against++; againstOk+=ok; } }
  if(n<3) return "";
  const pc=x=>Math.round(x/n*100);
  return `<div class="box espn-vs"><div class="row-lbl" style="margin-top:0">ESPN'e karşı</div>
    <div class="ev-row"><span>${u===S.uid?"Sen":esc(pname(u))}</span><div class="ev-bar"><i style="width:${pc(me)}%;background:${col(u)}"></i></div><b>%${pc(me)}</b></div>
    <div class="ev-row"><span>ESPN favorisi</span><div class="ev-bar"><i style="width:${pc(es)}%;background:var(--muted)"></i></div><b>%${pc(es)}</b></div>
    <small class="muted">${n} maçta kazananı bilme oranı. ${against?`ESPN'in favorisinin karşısına ${against} kez geçtin, ${againstOk} tanesinde haklı çıktın.`:"Hep ESPN'in favorisini seçtin."} ${me>es?"ESPN'den iyi tahmin ediyorsun.":me<es?"Şimdilik ESPN önde.":"ESPN'le başa baş."}</small></div>`;
}
function statsBody(u, {badges=false}={}){
  if(!u) return `${emptyBox("people", "Henüz kimse katılmadı. Davet linkini paylaş, rakiplerin gelsin.")}`;
  const recs=userRecs(u), n=recs.length;
  const wOk=recs.filter(x=>x.r.w>0).length, mOk=recs.filter(x=>x.r.m>0).length, sOk=recs.filter(x=>x.r.s>0).length;
  const conf=recs.filter(x=>x.r.c), cOk=conf.filter(x=>x.r.w>0).length;
  const days=Object.values(S.arch.scores.days||{}).map(d=>d[u]).filter(Boolean);
  const dps=days.filter(x=>x.dpName), dpHit=dps.filter(x=>x.dp>0).length;
  const qs=days.filter(x=>x.q), qHit=qs.filter(x=>x.qp>0).length;
  const srPts=days.reduce((s,x)=>s+(x.sr||0),0);
  const pct=(a,b)=>b?Math.round(a/b*100):0;
  const kpi=(v,l,c)=>`<div class="kpi"><b>${v}</b><small>${l}</small>${c!=null?`<div class="bar2"><i style="width:${c}%;background:${col(u)}"></i></div>`:""}</div>`;
  let html = "";
  if(!n) return `<div class="note">${u===S.uid?"Tahmin yaptığın ilk maçlar bitince istatistiklerin burada birikmeye başlayacak.":"Bu oyuncunun biten bir tahmini henüz yok."}</div>`;
  const net=cOk*2-(conf.length-cOk);
  html += `<div class="sec-title"><h2>İsabet</h2><span class="aside">${n} maç</span></div><div class="cards2">
    ${kpi("%"+pct(wOk,n),`Kazananı bildin (${wOk}/${n})`,pct(wOk,n))}
    ${kpi("%"+pct(mOk,wOk),`Kazananı bildiğin maçlarda farkı da bildin (${mOk}/${wOk})`,pct(mOk,wOk))}
    ${kpi("%"+pct(sOk,n),`En skoreri bildin (${sOk}/${n})`,pct(sOk,n))}
    ${kpi(`${cOk}/${conf.length}`,`Tutan banko (net ${net>0?"+":""}${net} puan)`,null)}
    ${kpi(`${dpHit}/${dps.length}`,"Günün oyuncusu",null)}
    ${kpi(`${qHit}/${qs.length}`,"Gecenin sorusu",null)}
    ${(()=>{ const ds=allDays().filter(d=>dayPoints(d)[u]?.n); const t=ds.reduce((s,d)=>s+(dayPoints(d)[u]?.pts||0),0); return kpi(ds.length?(t/ds.length).toFixed(1):"–",`Gece başına ortalama puan (${ds.length} gece)`,null); })()}</div>`;
  const totals=[["Kazanan (banko dahil)",recs.reduce((s,x)=>s+x.r.w,0)],["Fark",mOk],["En skorer",sOk],["Günün oyuncusu",dpHit*3],["Gecenin sorusu",qHit],["Playoff serileri",srPts]].filter(([l,v])=>v || !/Playoff/.test(l));
  const tmax=Math.max(1,...totals.map(x=>x[1]));
  html += `<div class="sec-title"><h2>Puanların nereden geliyor</h2></div><div class="box">${totals.map(([l,v])=>`<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span>${l}</span><b>${v}</b></div><div class="bar2"><i style="width:${Math.max(0,v)/tmax*100}%;background:${col(u)}"></i></div></div>`).join("")}</div>`;
  if(badges) html += `<div class="sec-title"><h2>Rozetler</h2><span class="aside">${badgesOf(u).filter(b=>b.n).length}/${BADGES.length}</span></div>${badgeHTML(badgesOf(u))}`;
  // takım karnesi: hangi takımın maçlarında ne kadar bildin oranı
  const tm={};
  for(const x of recs) for(const t of [x.home.abbr,x.away.abbr]){ tm[t] ||= {n:0,ok:0}; tm[t].n++; if(x.r.w>0) tm[t].ok++; }
  const tl=Object.entries(tm).map(([k,v])=>({k,...v,p:v.ok/v.n})).sort((a,b)=>b.p-a.p||b.n-a.n);
  if(tl.length){
    const heat=p=>`color-mix(in srgb, ${p>=.5?"var(--win)":"var(--lose)"} ${Math.round(Math.abs(p-.5)*2*60+12)}%, var(--panel))`;
    html += `<div class="sec-title"><h2>Takım karnesi</h2><span class="aside">hangi takımın maçlarında ne kadar bildin</span></div>
      <div class="tgrid">${tl.map(x=>`<div class="tcell" data-tp="${x.k}" style="background:${heat(x.p)}" title="${x.ok}/${x.n} maç"><img src="${LOGO_SMALL(x.k)}" alt=""><b>%${Math.round(x.p*100)}</b><small>${x.ok}/${x.n}</small></div>`).join("")}</div>`;
  }
  // rakip analizi
  const others=S.order.filter(v=>v!==u);
  if(others.length){
    html += `<div class="sec-title"><h2>Rakip analizi</h2><span class="aside">farklı tahmin ettiğiniz maçlar</span></div><div class="rivals">${others.map(v=>{
      const r=rivalry(u,v); if(!r.n) return `<div class="box rv"><b style="color:${col(v)}">${esc(pname(v))}</b><small class="muted">Henüz farklı taraf tuttuğunuz, biten bir maç yok.</small></div>`;
      const pu=Math.round(r.me/r.n*100);
      return `<div class="box rv"><div class="rv-h">${avatar(v,"sm")}<b style="color:${col(v)}">${esc(pname(v))}</b><span class="muted">${r.n} maçta farklı tahmin ettiniz</span></div>
        <div class="rv-bar"><i style="width:${pu}%;background:${col(u)}"></i><i style="width:${Math.round(r.them/r.n*100)}%;background:${col(v)}"></i></div>
        <div class="rv-t"><span><b>${r.me}</b> maçta ${esc(pname(u))} haklı çıktı</span><span><b>${r.them}</b> maçta ${esc(pname(v))}</span></div>
        ${r.team?`<small class="muted">En çok ${esc(ALLP?.teams.find(t=>t.a===r.team)?.n || r.team)} maçlarında ayrı düştünüz (${r.tn} maç).</small>`:""}</div>`; }).join("")}</div>`;
  }
  if(!ALLP) allPlayers().then(()=>{ if(S.prof?.tab==="ist") paintProf(); }).catch(()=>{});
  return html;
}
function bindStatSel(){ $("#statSel")?.addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(!c) return; S.statFor=c.dataset.v; renderStats(); }); }

/* ====================================================== gece özeti (paylaşılabilir görsel) */
async function nightSummary(){
  const D=S.days[S.day]; const pts=dayPoints(S.day);
  const W=1080, H=1350, c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
  await document.fonts.ready;
  x.fillStyle="#121a24"; x.fillRect(0,0,W,H);
  x.fillStyle="#e09410"; x.fillRect(0,0,W,14);
  x.fillStyle="#8b98a8"; x.font="600 38px Barlow"; x.fillText("NBA Tahmin · Gece özeti", 70, 110);
  x.fillStyle="#f4f6f8"; x.font="800 72px 'Barlow Condensed'"; x.fillText(dayNice(S.day), 70, 190);
  const cols=["#7ea2f6","#f2737f","#4fd0aa","#b38cf5","#f0a35c","#5cc6ec"];
  const ranked=[...S.order].sort((a,b)=>(pts[b]?.pts||0)-(pts[a]?.pts||0));
  let y=300;
  ranked.slice(0,4).forEach((u,i)=>{
    x.fillStyle="#1b2633"; x.beginPath(); x.roundRect(70,y,W-140,150,26); x.fill();
    x.fillStyle=(()=>{ const c=col(u); return c.startsWith("var(") ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4,-1)).trim()||cols[0] : c; })(); x.font="700 56px 'Barlow Condensed'"; x.fillText(pname(u), 110, y+92);
    x.fillStyle="#f4f6f8"; x.font="800 110px 'Barlow Condensed'"; x.textAlign="right"; x.fillText(String(pts[u]?.pts??0), W-110, y+112); x.textAlign="left";
    if(i===0 && (pts[ranked[1]]?.pts??-1)<(pts[u]?.pts??0)){ x.fillStyle="#e09410"; x.font="700 30px Barlow"; x.fillText("GECENİN KAZANANI", 110, y+132); }
    y+=172;
  });
  // en iyi tahmin: en çok puan getiren tek maç
  let best=null;
  for(const g of D.games) for(const u of S.order){ const p=D.picks[g.id]?.[u]; if(!p) continue; const r=scorePick(g,p,D.daily[u]?.confGame===g.id); if(!best||r.pts>best.r.pts) best={g,u,p,r}; }
  y+=20; x.fillStyle="#8b98a8"; x.font="600 34px Barlow";
  if(best){ x.fillText("Gecenin tahmini", 70, y); x.fillStyle="#f4f6f8"; x.font="700 44px Barlow";
    const t=best.p.winner===best.g.home.abbr?best.g.home.name:best.g.away.name;
    x.fillText(`${pname(best.u)}: ${t} ${best.p.margin}, ${best.p.scorerName}`.slice(0,46), 70, y+58);
    x.fillStyle="#4fd093"; x.fillText(`+${best.r.pts} puan`, 70, y+116); y+=170; }
  const tops=D.games.map(g=>topsOf(g)?.[0]).filter(Boolean).sort((a,b)=>b.pts-a.pts)[0];
  if(tops){ x.fillStyle="#8b98a8"; x.font="600 34px Barlow"; x.fillText("Gecenin en skoreri", 70, y); x.fillStyle="#f4f6f8"; x.font="700 44px Barlow"; x.fillText(`${tops.name} · ${tops.pts} sayı`, 70, y+58); }
  x.fillStyle="#8b98a8"; x.font="500 28px Barlow"; x.fillText((location.host+location.pathname).replace(/index\.html$/,""), 70, H-60);
  const blob=await new Promise(r=>c.toBlob(r,"image/png"));
  const file=new File([blob],`gece-ozeti-${S.day}.png`,{type:"image/png"});
  if(navigator.canShare?.({files:[file]})){ try{ await navigator.share({files:[file], title:"Gece özeti"}); return; }catch(e){ if(e.name==="AbortError") return; } }
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=file.name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}


/* ====================================================== küçük animasyonlar */
const RM = matchMedia("(prefers-reduced-motion: reduce)");
S.shown = {};
function countUp(){
  for(const el of $$("#board .digits[data-u]")){
    const u=el.dataset.u, to=+el.dataset.v, from=S.shown[u];
    S.shown[u]=to;
    if(from==null || from===to || RM.matches) continue;
    const sp=el.querySelector("span"), t0=performance.now(), dur=Math.min(1200, 250+Math.abs(to-from)*120);
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    const tick=now=>{ const k=Math.min(1,(now-t0)/dur), e=1-(1-k)**3; sp.textContent=Math.round(from+(to-from)*e); if(k<1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}
// Geceyi tek başına kazanınca bir kez konfeti
// Gece bitince kazanan bir kez sahneye çıkar (kendin kazandıysan konfeti zaten çıkıyor)
// Yedek tahmin: bir gece hiç tahmin yapmazsan ESPN favorileri senin yerine girer; doğru bildiği her 2 kazanan 1 puan
function maybeAskAuto(){
  const me=S.players[S.uid]; if(!me || "autoPick" in me || S.onboard || lsGet("autoAsk")) return;
  if(!$("#sheet").classList.contains("hide")) return;
  lsSet("autoAsk","1");
  openSheet(`<h3 id="shTitle">Otomatik tahmin açılsın mı?</h3><p>Bir gece hiç tahmin yapmayı unutursan senin yerine her maçta ESPN'in favorisi seçilir. Doğru çıkan her <b>2 kazanan için 1 puan</b> alırsın; fark, skorer ve banko yedekte yoktur. Böylece unuttuğun gece tablodan kopmazsın, ama tahmin yapan her zaman daha çok kazanır.</p>
    <p class="muted">İstediğin zaman profilinden değiştirebilirsin.</p><div class="pf-btns"><button class="btn" id="apNo" type="button">Hayır</button><button class="btn-primary" id="apYes" type="button">Evet, açılsın</button></div>`);
  const set=async v=>{ try{ await updateDoc(doc(S.db,"players",S.uid), {autoPick:v}); S.players[S.uid].autoPick=v; toast(v?"Otomatik tahmin açıldı.":"Otomatik tahmin kapalı."); }catch(e){ toast("Kaydedilemedi."); } closeSheet(); };
  $("#apYes").onclick=()=>set(true); $("#apNo").onclick=()=>set(false);
}
function markSeen(){ if(!S.uid || Date.now()-+(lsGet("seenAt")||0) < 36e5) return; lsSet("seenAt", String(Date.now()));
  updateDoc(doc(S.db,"players",S.uid), {seen:serverTimestamp()}).catch(()=>{}); }
function maybeNightWinner(){
  if(!S.uid || document.querySelector(".badge-pop, .nw-pop")) return;
  for(const d of [S.today, shiftDay(S.today,-1)]){
    if(!S.days[d] || !inLeague(d)) continue;
    const w=dayWinner(d); if(w?.st!=="w") continue;
    const key="nw_"+d; if(lsGet(key)) continue; lsSet(key,"1");
    const row=$(`#board [data-pu="${w.u}"]`); row?.classList.add("glow"); setTimeout(()=>row?.classList.remove("glow"), 7000);
    if(w.u===S.uid) return;   // kendi zaferinde konfeti ve mesaj maybeConfetti'den
    const el=document.createElement("div"); el.className="nw-pop"; el.setAttribute("role","status"); el.style.setProperty("--pc", col(w.u));
    el.innerHTML=`<div class="nw-card"><small>${dayNice(d,{day:"numeric",month:"long"})} gecesi</small><div class="nw-av">${avatar(w.u,"lg")}</div><b>Gecenin kazananı</b><span>${esc(pname(w.u))}</span><em>${w.pts} puan</em></div>`;
    document.body.append(el);
    const close=()=>{ el.classList.add("out"); setTimeout(()=>el.remove(),400); }; el.onclick=close; setTimeout(close, 4500);
    return;
  }
}
function maybeConfetti(){
  if(!S.uid || RM.matches) return;
  for(const d of [S.today, shiftDay(S.today,-1)]){
    if(!S.days[d]) continue;
    const w=dayWinner(d); if(w?.st!=="w" || w.u!==S.uid) continue;
    const key="confetti_"+d; try{ if(localStorage.getItem(key)) continue; localStorage.setItem(key,"1"); }catch(e){ continue; }
    confetti(); toast(pick([`🏆 ${dayNice(d,{day:"numeric",month:"long"})} gecesini kazandın!`,`🏆 Gece senin! ${dayNice(d,{day:"numeric",month:"long"})} gecesinin kazananı sensin.`,`🏆 Tebrikler, ${dayNice(d,{day:"numeric",month:"long"})} gecesini aldın!`]), 4000);
    return;
  }
}
function confetti(){
  const c=document.createElement("canvas"); c.className="confetti"; document.body.appendChild(c);
  const x=c.getContext("2d"), dpr=devicePixelRatio||1; c.width=innerWidth*dpr; c.height=innerHeight*dpr; x.scale(dpr,dpr);
  const cols=[col(S.uid),"#f2a83a","#4fd093","#ffffff","#7ea2f6","#f2737f"].map(v=>v.startsWith("var")?getComputedStyle(document.documentElement).getPropertyValue(v.slice(4,-1)).trim():v);
  const P=Array.from({length:140},()=>({x:innerWidth/2+(Math.random()-.5)*80,y:innerHeight*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*13-4,
    w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.4,c:cols[Math.floor(Math.random()*cols.length)]}));
  const t0=performance.now();
  const step=now=>{
    const t=now-t0; x.clearRect(0,0,innerWidth,innerHeight);
    for(const p of P){ p.vy+=.35; p.vx*=.99; p.x+=p.vx; p.y+=p.vy; p.r+=p.vr;
      x.save(); x.translate(p.x,p.y); x.rotate(p.r); x.globalAlpha=Math.max(0,1-t/2600); x.fillStyle=p.c; x.fillRect(-p.w/2,-p.h/2,p.w,p.h*Math.abs(Math.cos(p.r))); x.restore(); }
    if(t<2600) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}
// Yükleme iskeleti ve maçsız gün
const skeletonCards = (n=3) => Array.from({length:n},()=>`<div class="game skel" aria-hidden="true"><div class="sk sk-h"></div><div class="sk-teams"><div class="sk sk-t"></div><div class="sk sk-t"></div></div><div class="sk sk-l"></div><div class="sk sk-m"></div></div>`).join("") + `<span class="sr">Maçlar yükleniyor</span>`;
const EMPTY_NIGHT = `<div class="empty"><svg viewBox="0 0 160 120" aria-hidden="true">
  <rect x="38" y="8" width="84" height="54" rx="4" class="e-board"/><rect x="64" y="30" width="32" height="22" class="e-sq"/>
  <path d="M58 62h44l-6 34H64z" class="e-net"/><path d="M62 72h36M64 82h32M66 92h28M70 62l4 34M80 62v34M90 62l-4 34" class="e-net"/>
  <rect x="54" y="60" width="52" height="5" rx="2.5" class="e-rim"/>
  <circle cx="128" cy="100" r="14" class="e-ball"/><path d="M114 100h28M128 86v28M118 90c6 6 6 14 0 20M138 90c-6 6-6 14 0 20" class="e-ln"/></svg>
  <b>Bu gece maç yok</b><span>Oklarla diğer günlere bakabilirsin.</span></div>`;

/* ====================================================== Türkçe ekler, gecenin manşeti, kayan şerit */
const VOW="aeıioöuü";
const lastV = s => [...String(s).toLocaleLowerCase("tr")].reverse().find(c=>VOW.includes(c)) || "e";
const endsV = s => VOW.includes(String(s).slice(-1).toLocaleLowerCase("tr"));
// İlgi eki: Kemal'in, Mustafa'nın, Andaç'ın, Selin'in
const FRONT_NAMES = new Set(["kemal","celal","cemal","bilal","hilal","nihal","hayal","iclal","meral"]); // ince l: Kemal'in
// Oyuncu soyadı: "Trey Murphy III" → "Murphy III", "Jaren Jackson Jr." → "Jackson Jr." (yalnızca son ek gösterilmesin)
const NAME_SFX = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;
const surname = n => { const w=String(n||"").trim().split(/\s+/); if(w.length<2) return w[0]||""; const last=w[w.length-1]; return NAME_SFX.test(last) ? w[w.length-2]+" "+last : last; };
const gen = n => n+"'"+(endsV(n)?"n":"")+({a:"ın",ı:"ın",e:"in",i:"in",o:"un",u:"un",ö:"ün",ü:"ün"}[FRONT_NAMES.has(String(n).toLocaleLowerCase("tr").split(/\s+/).pop()) ? "e" : lastV(n)]);
const pick = a => a[Math.floor(Math.random()*a.length)];
// Gecenin manşeti: bitmiş bir gece için tek cümle
function headlineOf(d){
  const w=dayWinner(d); if(!w || w.st==="live") return "";
  const p=dayPoints(d), played=S.order.filter(u=>p[u]?.n);
  if(UI_EN){
    if(w.st==="t"){ const ws=played.filter(u=>p[u].pts===w.pts).map(pname); return ws.length===played.length ? `The night ended level: everyone on ${w.pts} pts.` : `${ws.join(" and ")} shared the night with ${w.pts} pts.`; }
    const n=pname(w.u), recs=userRecs(w.u).filter(x=>x.day===d), ok=recs.filter(x=>x.r.w>0).length;
    const second=Math.max(...played.filter(u=>u!==w.u).map(u=>p[u].pts), -99), diff=second>-99 ? w.pts-second : 0;
    const full=recs.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0).length;
    const extra = p[w.u].dp>0 ? " Also called the player of the night." : full ? ` Got winner, margin and scorer all right in ${full} game${full>1?"s":""}.` : "";
    if(recs.length && ok===recs.length && recs.length>=3) return `${n}'s night: called all ${recs.length} winners, ${w.pts} pts.${extra}`;
    if(diff>=5) return `${n} owned the night: ${w.pts} pts, ${diff} ahead of the next.${extra}`;
    if(diff===1) return `${n} edged the night: ${w.pts} pts, by just 1.${extra}`;
    return `${n}'s night: ${recs.length?`${ok} of ${recs.length} winners right, `:""}${w.pts} pts.${extra}`;
  }
  if(w.st==="t"){ const ws=played.filter(u=>p[u].pts===w.pts).map(pname);
    return ws.length===played.length ? `Gece berabere bitti: herkes ${w.pts} puanda kaldı.` : `${ws.slice(0,-1).join(", ")} ve ${ws.at(-1)} geceyi ${w.pts} puanla paylaştı.`; }
  const n=pname(w.u), recs=userRecs(w.u).filter(x=>x.day===d), ok=recs.filter(x=>x.r.w>0).length;
  const second=Math.max(...played.filter(u=>u!==w.u).map(u=>p[u].pts), -99), diff=second>-99 ? w.pts-second : 0;
  const extra = p[w.u].dp>0 ? " Günün oyuncusunu da bildi." : recs.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0).length ? ` ${recs.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0).length} maçta kazanan, fark ve en skorerin üçünü birden bildi.` : "";
  if(recs.length && ok===recs.length && recs.length>=3) return `${gen(n)} gecesi: ${recs.length} maçın hepsinde kazananı bildi, ${w.pts} puan topladı.${extra}`;
  if(diff>=5) return `${n} geceye damgasını vurdu: ${w.pts} puan, en yakın rakibinden ${diff} puan fazla.${extra}`;
  if(diff===1) return `${n} geceyi kıl payı aldı: ${w.pts} puan, sadece 1 puan farkla.${extra}`;
  return `${gen(n)} gecesi: ${recs.length?`${recs.length} maçın ${ok} tanesinde kazananı bildi, `:""}${w.pts} puan topladı.${extra}`;
}
// Kayan şerit: son 24 saatte katılanlara hoş geldin + ligden haberler
function tickerItems(){
  const out=[], now=Date.now();
  // son 24 saatte katılanlar tek satırda; giriş yapan kişi kendine "hoş geldin" görmez
  const fresh=S.order.filter(u=>{ const j=S.players[u]?.joined||0; return now-j<864e5 && now-j>=0; });
  const others=fresh.filter(u=>u!==S.uid).map(pname);
  if(others.length===1) out.push({cls:"hi", t:`👋 Ligimize hoş geldin, ${others[0]}! Bol puanlı geceler.`});
  else if(others.length>1) out.push({cls:"hi", t:`👋 Ligimize hoş geldiniz: ${others.slice(0,-1).join(", ")} ve ${others.at(-1)}! Bol puanlı geceler.`});
  if(fresh.includes(S.uid)) out.push({cls:"hi", t:`👋 Hoş geldin, ${pname(S.uid)}! Her akşam maçlara tahmin yap, puanları topla.`});
  const tot=seasonTotals(), ranked=rankOrder(tot);
  const nights=allDays().filter(d=>{ const w=dayWinner(d); return w && w.st!=="live"; });
  if(nights[0]){ const h=headlineOf(nights[0]); if(h) out.push({t:`🌙 ${nights[0]===shiftDay(S.today,-1)?"Dün gece":dayNice(nights[0],{day:"numeric",month:"long"})+" gecesi"} — ${h}`}); }
  if(ranked.length>1 && tot[ranked[0]]>0){ const d=tot[ranked[0]]-tot[ranked[1]];
    out.push({t: d ? `🏀 Zirvede ${pname(ranked[0])} var: ${tot[ranked[0]]} puan. ${pname(ranked[1])} ${d} puan geride.` : `🏀 Zirvede ortalık karışık: ${pname(ranked[0])} ve ${pname(ranked[1])} ${tot[ranked[0]]} puanla eşit.`}); }
  let run=0, ru=null; for(const d of nights){ const w=dayWinner(d); if(w.st!=="w") break; if(ru===null) ru=w.u; if(w.u!==ru) break; run++; }
  if(run>=2) out.push({t:`🔥 ${pname(ru)} üst üste ${run} gecedir kazanıyor. Durduran çıkacak mı?`});
  const wk=weekKey(S.today), wp={}; for(const d of allDays()) if(weekKey(d)===wk){ const p=dayPoints(d); for(const u of S.order) wp[u]=(wp[u]||0)+(p[u]?.pts||0); }
  const wr=[...S.order].sort((a,b)=>(wp[b]||0)-(wp[a]||0)); if(wr.length>1 && (wp[wr[0]]||0)>(wp[wr[1]]||0)) out.push({t:`📆 Bu haftanın lideri ${pname(wr[0])}: ${wp[wr[0]]} puan.`});
  const D=S.days[S.today];
  if(D?.games.length){ const open=!D.games.some(started);
    out.push({t: open ? `📅 Bu gece ${D.games.length} maç var. ${D.games[0].perGame?`Her maç başlamadan 10 dk önce kilitleniyor; ilk kilit ${timeTR(D.games[0].lock)}.`:`Tahminler ${timeTR(D.games[0].lock)} itibarıyla kapanıyor.`}` : (D.games.every(g=>g.state==="post") ? `🏁 Bu gecenin ${D.games.length} maçı bitti. Skorlar sekmesine bir göz at.` : `📺 Bu gecenin maçları başladı. Tahminler kapandı, herkesin seçimi artık görünüyor.`)});
    if(open){ const q=questionOf(S.today); out.push({t:`❓ Gecenin sorusu: ${q.t}`});
      const miss=S.order.filter(u=>!(D.progress?.[u]?.size)); if(miss.length && miss.length<S.order.length) out.push({t:`⏳ Henüz tahmin yapmayanlar: ${miss.map(pname).join(", ")}.`}); }
  }
  if(!out.length) out.push({t:"🏀 NBA Tahmin'e hoş geldin! Her gece maçlara tahmin yap, puanları topla."});
  return out;
}
function renderTicker(){
  const el=$("#ticker"); if(!el) return;
  const items=tickerItems(), key=items.map(x=>x.t).join("|");
  if(el.dataset.k===key) return; el.dataset.k=key;
  const row=items.map(x=>`<span class="tk-i ${x.cls||""}">${esc(x.t)}</span>`).join('<span class="tk-sep">•</span>');
  const len=items.reduce((s,x)=>s+x.t.length,0);
  el.innerHTML=`<div class="tk-track" style="--dur:${Math.max(25, Math.round(len/6))}s"><div class="tk-row">${row}<span class="tk-sep">•</span></div><div class="tk-row" aria-hidden="true">${row}<span class="tk-sep">•</span></div></div>`;
  el.classList.toggle("has-hi", items.some(x=>x.cls==="hi"));
}

/* ====================================================== duyuru ve mail uyarısı */
const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
const lsSet = (k,v) => { try{ localStorage.setItem(k,v); }catch(e){} };
function renderBanners(){
  const box=$("#banners"); if(!box) return;
  let html="";
  const tr=trialActive() ? trialOf() : null;
  const strip=$("#trialStrip");
  if(strip){ strip.classList.toggle("hide", !tr); document.body.classList.toggle("trial-on", !!tr);
    if(tr){ const left=Math.max(0, Math.round((parseYmd(shiftDay(tr.end,1))-parseYmd(espnToday()))/864e5));
      strip.innerHTML=`<span class="ts-tag">🧪 DENEME HAFTASI</span><span class="ts-t">${dayNice(baseStart(),{day:"numeric",month:"long"})}–${dayNice(tr.end,{day:"numeric",month:"long"})} · puanlar ${dayNice(shiftDay(tr.end,1),{day:"numeric",month:"long"})} pazartesi sıfırlanacak${left?` · asıl lige ${left} gün`:""}</span>`; } }
  const n=S.notice;
  if(n?.text && lsGet("noticeSeen")!==String(n.at)) html += `<div class="banner notice"><span class="bn-i">${ICON.megaphone}</span><span class="bn-t">${esc(n.text)}</span><button class="bn-x" data-bn="notice" aria-label="Kapat">✕</button></div>`;
  const later=+(lsGet("mailNudge")||0);
  if(S.contactLoaded && !S.contact?.verified && Date.now()>later) html += `<div class="banner nudge"><span class="bn-i">${ICON.mail}</span><span class="bn-t"><b>${S.contact?.email?"Mail onay kodunu gir":"Mail adresini ekle"}</b> ${S.contact?.email?"Adresin kayıtlı ama onaylanmadı. Kodu girmezsen hiçbir mail gelmez; şifreni unutursan mail ile sıfırlayamazsın.":"Onaylı adres olmadan hatırlatma maili gelmez ve şifreni unutursan kodla sıfırlayamazsın."}</span>
    <span class="bn-acts"><button class="btn sm" data-bn="mail">${S.contact?.email?"Onayla":"Ekle"}</button><button class="linkish" data-bn="later">Sonra</button></span></div>`;
  // Profilini özelleştirmemiş olana (favori takım ya da avatar seçmemiş) hatırlatma
  const me=S.players[S.uid];
  const missP = me ? [!me.favTeam && "favori takımını", !avImg(me.av) && "avatarını"].filter(Boolean) : [];
  if(missP.length && Date.now()>+(lsGet("profileNudge")||0)) html += `<div class="banner nudge"><span class="bn-i">${ICON.palette}</span><span class="bn-t"><b>Profilini özelleştir</b> ${missP.length===2?"Favori takımını, avatarını ve rengini seç":missP[0][0].toLocaleUpperCase("tr")+missP[0].slice(1)+" da seç"}, puan tablosunda öyle görün.</span>
    <span class="bn-acts"><button class="btn sm" data-bn="profile">Seç</button><button class="linkish" data-bn="plater">Sonra</button></span></div>`;
  box.innerHTML=html;
}
$("#trialStrip").onclick=()=>{ lsSet("trialPop_"+(S.league?.trial?.end||""), ""); try{ localStorage.removeItem("trialPop_"+(S.league?.trial?.end||"")); }catch(e){} maybeLeaguePop(); };
$("#banners").addEventListener("click", e=>{
  const b=e.target.closest("[data-bn]"); if(!b) return;
  if(b.dataset.bn==="notice"){ lsSet("noticeSeen", String(S.notice?.at)); }
  if(b.dataset.bn==="later"){ lsSet("mailNudge", String(Date.now()+6*36e5)); }
  if(b.dataset.bn==="plater"){ lsSet("profileNudge", String(Date.now()+3*864e5)); }
  if(b.dataset.bn==="profile"){ openProfile("ayar"); setTimeout(()=>{ $(".pf-avtab")?.closest(".pf-sec")?.scrollIntoView({block:"start"}); }, 300); }
  if(b.dataset.bn==="mail"){ allPlayers().catch(()=>{}).finally(()=>openOnboard(5)); }
  renderBanners();
});

/* ====================================================== oyuncu kartı, tahmin geçmişi, takım sayfası */
document.addEventListener("click", e=>{ const p=e.target.closest(".podium [data-pu]"); if(p) openPlayer(p.dataset.pu); });
$("#board").addEventListener("click", e=>{ if(e.target.closest("#lbInvite")) return openInvite(); if(e.target.closest("#lbMore")){ S.boardAll=!S.boardAll; return renderBoard(); } const p=e.target.closest("[data-pu]"); if(p) openPlayer(p.dataset.pu); });
document.addEventListener("click", e=>{ const t=e.target.closest("[data-tp]"); if(t) { e.stopPropagation(); openTeam(t.dataset.tp); } });
// ====== Profil: herkesin kendi sayfası (Özet · İstatistik · Rozetler · kendi profilinde Ayarlar)
S.prof = {u:null, tab:"ozet"};
function openProf(u, tab="ozet"){
  if(!S.players[u]) return;
  if(u!==S.uid && tab==="ayar") tab="ozet";
  S.prof = {u, tab};
  openSheet(`<div id="profx"></div>`); paintProf();
}
function openPlayer(u){ openProf(u, "ozet"); }
function profCover(u){
  const p=S.players[u]||{}, m=/^(t|p):(\w+)$/.exec(p.av||"");
  return m?.[1]==="p" ? `<div class="pc-cover photo" style="--pc:${col(u)};--cv:url('https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${m[2]}.png&w=600&h=438&scale=crop&cquality=75')"></div>`
    : m?.[1]==="t" ? `<div class="pc-cover team" style="--tc:${tcol(m[2])}"><img src="${LOGO_SMALL(m[2])}" alt=""></div>`
    : p.favTeam ? `<div class="pc-cover team soft" style="--tc:${tcol(p.favTeam)}"><img src="${LOGO_SMALL(p.favTeam)}" alt=""></div>`
    : `<div class="pc-cover plain" style="--pc:${col(u)}"><span>${esc(initials(pname(u)))}</span></div>`;
}
function profStats(u){
  const recs=userRecs(u), n=recs.length, tot=seasonTotals();
  const nights=nightsOf();   // eskiden yeniye
  const won=nights.filter(x=>x.w.st==="w"&&x.w.u===u).length;
  let best=0, cur=0; for(const x of nights){ if(x.w.st==="w"&&x.w.u===u){ cur++; best=Math.max(best,cur); } else cur=0; }
  let top=null; for(const x of nights){ const v=x.p[u]?.pts; if(v!=null && (!top || v>top.v)) top={v, d:x.d}; }
  const conf=recs.filter(x=>x.r.c);
  return {recs, n, tot:tot[u]||0, rank:[...S.order].sort((a,b)=>(tot[b]||0)-(tot[a]||0)).indexOf(u)+1, won, streak:best, curStreak:cur, top,
    w:recs.filter(x=>x.r.w>0).length, m:recs.filter(x=>x.r.m>0).length, s:recs.filter(x=>x.r.s>0).length, c:conf.length, cOk:conf.filter(x=>x.r.w>0).length,
    badges:badgesOf(u).filter(b=>b.n).length, nights};
}
const pctTxt=(a,b)=>b?"%"+Math.round(a/b*100):"–";
function paintProf(){
  const box=$("#profx"); if(!box) return;
  const {u, tab}=S.prof, me=u===S.uid, p=S.players[u]||{}, st=profStats(u);
  const fav=p.favTeam && ALLP?.teams.find(t=>t.a===p.favTeam);
  const daysIn=Math.max(1, Math.floor((Date.now()-(p.joined||Date.now()))/864e5)+1);
  const tabs=[["ozet","Özet"],["ist","İstatistik"],["roz","Rozetler"], ...(me?[["ayar","Ayarlar"]]:[])];
  let body="";
  if(tab==="ozet") body=profOzet(u, st);
  else if(tab==="ist") body=`<div class="pf-btns"><button class="btn" data-hsu="${u}" type="button">${ICON.cards}${me?"Tahmin geçmişin":"Tahmin geçmişi"}</button><button class="btn" data-wr="${u}" type="button">✨ Sezon özeti</button></div>` + (me?"":compareHTML(S.uid,u)) + espnVsHTML(u) + luckHTML(u) + analysisHTML(u) + recordsHTML(u, st) + statsBody(u);
  else if(tab==="roz") body=badgesFull(u);
  else body=`<div id="prof"></div>`;
  box.innerHTML = profCover(u) + `<div class="pc-head on-cover">${avatar(u,"lg")}<div style="min-width:0"><h3 id="shTitle" style="margin:0;color:${col(u)}">${esc(pname(u))}</h3>
      ${p.club?`<div class="pf-club">${ICON.shield}${esc(p.club)}</div>`:""}
      ${p.bio?`<div class="pf-bio">“${esc(p.bio)}”</div>`:""}
      ${(inv=>inv.length?`<div class="pf-inv">${ICON.link}Lige getirdiği: ${inv.map(x=>`<b style="color:${col(x)}">${esc(pname(x))}</b>`).join(", ")}</div>`:"")(invitedBy(u))}
      ${!me && S.uid ? `<button class="btn sm rival-btn ${S.players[S.uid]?.rival===u?"on":""}" id="rivalBtn" type="button">${S.players[S.uid]?.rival===u?"✓ Rakibim":"Rakibim yap"}</button>` : ""}
      <small class="muted">${st.rank}. sırada · ${st.tot} puan${p.favTeam?` · <span data-tp="${p.favTeam}" class="linkish" style="font-size:13px">${esc(fav?.n||p.favTeam)}</span> taraftarı`:""} · Ligde ${daysIn}. günü</small></div></div>
    <div class="seg2 prof-tabs" style="grid-template-columns:repeat(${tabs.length},1fr)">${tabs.map(([k,l])=>`<button data-ptab="${k}" aria-pressed="${tab===k}">${l}</button>`).join("")}</div>
    <div class="prof-body">${body}</div>`;
  box.querySelector("[data-hsu]")?.addEventListener("click", ()=>openHistory(u));
  box.querySelector("[data-wr]")?.addEventListener("click", ()=>openWrapped(u));
  box.querySelector("#rivalBtn")?.addEventListener("click", async()=>{ const cur=S.players[S.uid]?.rival; const v=cur===u?"":u;
    try{ await updateDoc(doc(S.db,"players",S.uid),{rival:v}); S.players[S.uid].rival=v; toast(v?`${pname(u)} artık rakibin.`:"Rakip kaldırıldı."); paintProf(); render(); }catch(e){ toast("Kaydedilemedi."); } });
  box.querySelector(".prof-tabs").onclick = e => { const b=e.target.closest("[data-ptab]"); if(!b) return; S.prof.tab=b.dataset.ptab; paintProf(); };
  if(tab==="ayar") paintProfile();
  if(!ALLP && p.favTeam) allPlayers().then(()=>{ if(S.prof.u===u && $("#profx")) paintProf(); }).catch(()=>{});
}
function profOzet(u, st){
  const kpi=(v,l)=>`<div class="kpi"><b>${v}</b><small>${l}</small></div>`;
  let h = `<div class="cards2 pf-kpis">${kpi(st.tot,"Toplam puan")}${kpi(st.won,"Kazandığı gece")}${kpi(pctTxt(st.w,st.n),`Kazananı bilme (${st.n} maç)`)}${kpi(st.streak,"En uzun gece serisi")}${kpi(st.top?st.top.v:"–", st.top?`En iyi gece (${dayNice(st.top.d,{day:"numeric",month:"short"})})`:"En iyi gece")}${kpi(`${st.cOk}/${st.c}`,"Tutan banko")}</div>`;
  // form grafiği: son 10 gece
  const last=st.nights.slice(-10);
  if(last.length){
    const mx=Math.max(3,...last.map(x=>x.p[u]?.pts??0));
    h += `<div class="sec-title"><h2 style="font-size:20px">Son ${last.length} gece</h2></div><div class="formchart">${last.map(x=>{ const v=x.p[u]?.pts??0, w=x.w.st==="w"&&x.w.u===u;
      return `<div class="fc-c" title="${dayNice(x.d,{day:"numeric",month:"short"})}: ${v} puan"><span class="fc-v">${v}</span><i class="${w?"win":""}" style="height:${Math.max(4,Math.max(0,v)/mx*70)}px;--pc:${col(u)}"></i><small>${dayNice(x.d,{day:"numeric"})}</small></div>`; }).join("")}</div>
      <small class="muted">Renkli çubuklar geceyi kazandığı geceler.</small>`;
  }
  // bu gecenin tahminleri
  const D=S.days[S.today];
  if(D?.games.length){
    const locked=D.games.some(started), canSee = locked || u===S.uid;
    h += `<div class="sec-title"><h2 style="font-size:20px">Bu gecenin tahminleri</h2></div>`;
    if(!canSee){ const k=D.progress?.[u]?.size||0; h += `<div class="note">Seçimler kilit açılınca (${timeTR(D.games[0].lock)}) görünür. Şu an ${k}/${D.games.length} maça tahmin yaptı.</div>`; }
    else {
      const rows=D.games.map(g=>{ const pk=D.picks[g.id]?.[u];
        if(u!==S.uid && !started(g)) return `<div class="pt-row"><span class="pt-g">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span><span class="muted">${timeTR(g.lock)}'de açılır</span></div>`;
        if(!pk) return `<div class="pt-row"><span class="pt-g">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span><span class="muted">tahmin yok</span></div>`;
        const r=started(g)?scorePick(g,pk,D.daily[u]?.confGame===g.id):null;
        return `<div class="pt-row"><span class="pt-g"><img src="${LOGO_SMALL(pk.winner)}" alt="">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span><span class="pk"><span class="rc">${esc(pk.winner)}</span><span class="rc">${pk.margin}</span><span class="rc has-face">${faceImg(pk.scorerId,"rc-face")}${esc(surname(pk.scorerName))}</span>${D.daily[u]?.confGame===g.id?'<span class="rc star-chip">★</span>':""}</span>${r&&(g.state!=="pre")?`<b class="pt-p ${r.pts>0?"pos":r.pts<0?"neg":""}">${r.pts>0?"+":""}${r.pts}</b>`:""}</div>`; }).join("");
      h += `<div class="box pt-list">${rows}</div>`;
    }
  }
  // son geceler ve en iyi bildiği takımlar
  const tm={}; for(const x of st.recs) for(const t of [x.home.abbr,x.away.abbr]){ tm[t] ||= {n:0,ok:0}; tm[t].n++; if(x.r.w>0) tm[t].ok++; }
  const bestT=Object.entries(tm).filter(([,v])=>v.n>=2).sort((a,b)=>b[1].ok/b[1].n-a[1].ok/a[1].n||b[1].n-a[1].n).slice(0,3);
  if(bestT.length) h += `<div class="sec-title"><h2 style="font-size:20px">En iyi bildiği takımlar</h2></div><div class="pc-teams">${bestT.map(([k,v])=>`<button class="pc-t" data-tp="${k}"><img src="${LOGO_SMALL(k)}" alt=""><b>%${Math.round(v.ok/v.n*100)}</b><small>${v.ok}/${v.n}</small></button>`).join("")}</div>`;
  return h;
}
// Sen ve o: iki oyuncunun sayıları yan yana
function compareHTML(a, b){
  const A=profStats(a), B=profStats(b);
  const row=(l,va,vb,na,nb)=>{ const x=na??parseFloat(String(va).replace("%","")), y=nb??parseFloat(String(vb).replace("%",""));
    const wa=isFinite(x)&&isFinite(y)&&x>y, wb=isFinite(x)&&isFinite(y)&&y>x;
    return `<div class="cmp-r"><b class="${wa?"win":""}" style="${wa?`color:${col(a)}`:""}">${va}</b><span>${l}</span><b class="${wb?"win":""}" style="${wb?`color:${col(b)}`:""}">${vb}</b></div>`; };
  const r=rivalry(a,b);
  return `<div class="sec-title"><h2 style="font-size:20px">Sen ve ${esc(pname(b))}</h2></div><div class="box cmp">
    <div class="cmp-h"><span>${avatar(a,"sm")}<b style="color:${col(a)}">${esc(pname(a))}</b></span><span>${avatar(b,"sm")}<b style="color:${col(b)}">${esc(pname(b))}</b></span></div>
    ${row("Toplam puan",A.tot,B.tot)}${row("Kazanılan gece",A.won,B.won)}${row("Kazananı bilme",pctTxt(A.w,A.n),pctTxt(B.w,B.n))}${row("Farkı bilme",pctTxt(A.m,A.w),pctTxt(B.m,B.w))}${row("En skoreri bilme",pctTxt(A.s,A.n),pctTxt(B.s,B.n))}${row("Tutan banko",`${A.cOk}/${A.c}`,`${B.cOk}/${B.c}`,A.cOk,B.cOk)}${row("Rozet",A.badges,B.badges)}
    ${r.n?`<div class="cmp-f">${r.n} maçta farklı taraf tuttunuz: <b style="color:${col(a)}">${r.me}</b> kez sen, <b style="color:${col(b)}">${r.them}</b> kez ${esc(pname(b))} haklı çıktı.</div>`:`<div class="cmp-f muted">Henüz farklı taraf tuttuğunuz, biten bir maç yok.</div>`}</div>`;
}
// Kişisel rekorlar
function recordsHTML(u, st){
  const recs=st.recs; if(!recs.length) return "";
  let br=0, cr=0; for(const x of recs.filter(x=>x.r.c)){ if(x.r.w>0){ cr++; br=Math.max(br,cr); } else cr=0; }
  const cnt=(arr)=>{ const m={}; for(const k of arr) m[k]=(m[k]||0)+1; return Object.entries(m).sort((a,b)=>b[1]-a[1])[0]; };
  const sc=cnt(recs.filter(x=>x.r.s>0).map(x=>x.r.pick.s)), tmw=cnt(recs.map(x=>x.r.pick.w));
  const it=(ico,l,v)=>`<div class="rec-i"><span class="rec-ico">${ico}</span><span><small>${l}</small><b>${v}</b></span></div>`;
  return `<div class="sec-title"><h2 style="font-size:20px">Rekorlar</h2></div><div class="recs">
    ${it("🔥","En çok puanlı gece", st.top?`${st.top.v} puan · ${dayNice(st.top.d,{day:"numeric",month:"short"})}`:"–")}
    ${it("🌙","En uzun gece serisi", `${st.streak} gece`)}
    ${it("⭐","En uzun banko serisi", `${br} banko`)}
    ${it("🎯","En çok bildiği skorer", sc?`${esc(sc[0])} (${sc[1]} kez)`:"–")}
    ${it("🏀","En çok seçtiği takım", tmw?`${esc(tmw[0])} (${tmw[1]} maç)`:"–")}</div>`;
}
// Rozetler: kazanılanlar büyük ve renkli, kalanlar ilerlemeyle
function badgesFull(u){
  const bs=badgesOf(u), got=bs.filter(b=>b.n), not=bs.filter(b=>!b.n);
  // ligde bu rozet kaç kişide var
  const own={}; for(const x of S.order){ for(const b of badgesOf(x)) if(b.n) own[b.id]=(own[b.id]||0)+1; }
  const bar=pr=>{ const [a,b]=String(pr).split("/").map(Number); return b ? `<span class="bd-bar"><i style="width:${Math.min(100,a/b*100)}%"></i></span><em class="pr">${pr}</em>` : ""; };
  const card=b=>`<div class="bdg2 ${b.n?"on":"locked"}"><span class="bi">${b.ico}</span><b>${esc(b.name)}${b.n>1?` <small>×${b.n}</small>`:""}</b><small>${esc(b.desc)}</small>
    ${b.n ? (b.first?`<em>İlk kez: ${dayNice(b.first,{day:"numeric",month:"long"})}</em>`:"") : bar(b.prog)}
    <span class="bd-own">${own[b.id]?`Ligde ${own[b.id]} kişide var`:"Ligde henüz kimsede yok"}</span></div>`;
  return `<div class="sec-title"><h2 style="font-size:20px">Kazanılanlar</h2><span class="aside">${got.length}/${bs.length}</span></div>
    ${got.length?`<div class="bgrid">${got.map(card).join("")}</div>`:emptyBox("medal","Aşağıdakileri kazanmak için tahmin yapmaya devam!", u===S.uid?"Henüz rozetin yok":"Henüz rozeti yok")}
    ${not.length?`<div class="sec-title"><h2 style="font-size:20px">Sıradakiler</h2></div><div class="bgrid">${not.map(card).join("")}</div>`:""}`;
}
// Tahmin geçmişi (herkes için) + CSV (yalnızca kendin)
function openHistory(u=S.uid, flt="all", team=""){
  const all=userRecs(u).reverse(), me=u===S.uid;
  let recs = flt==="ok" ? all.filter(x=>x.r.w>0) : flt==="no" ? all.filter(x=>!(x.r.w>0)) : flt==="banko" ? all.filter(x=>x.r.c) : flt==="full" ? all.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0) : all;
  if(team) recs=recs.filter(x=>x.home?.abbr===team || x.away?.abbr===team);
  const n=all.length, w=all.filter(x=>x.r.w>0).length, m=all.filter(x=>x.r.m>0).length, sc=all.filter(x=>x.r.s>0).length, pts=all.reduce((t,x)=>t+(x.r.pts||0),0);
  const pc=a=>n?Math.round(a/n*100):0;
  // seriler (kronolojik)
  let cur=0, best=0; for(const x of [...all].reverse()){ if(x.r.w>0){ cur++; best=Math.max(best,cur); } else cur=0; }
  let curNow=0; for(const x of all){ if(x.r.w>0) curNow++; else break; }
  const bank=all.filter(x=>x.r.c), bankOk=bank.filter(x=>x.r.w>0).length;
  // gece gece puan ve o gecenin sırası
  const nights=[...new Set(all.map(x=>x.day))];
  const nInfo=Object.fromEntries(nights.map(d=>{ const dp=dayPoints(d); const mine=dp[u]?.pts??0; const rank=1+S.order.filter(o=>(dp[o]?.pts??-99)>mine).length; return [d,{pts:mine, rank, of:S.order.filter(o=>dp[o]?.n).length}]; }));
  const bestN=nights.reduce((b,d)=>!b||nInfo[d].pts>nInfo[b].pts?d:b, null);
  const last=nights.slice(0,20).reverse(), mx=Math.max(1,...last.map(d=>Math.abs(nInfo[d].pts)));
  const spark = last.length>1 ? `<div class="hs-spark">${last.map(d=>`<i class="${nInfo[d].pts<0?"neg":""}" style="height:${Math.max(6,Math.abs(nInfo[d].pts)/mx*100)}%" title="${dayNice(d,{day:"numeric",month:"short"})}: ${nInfo[d].pts} puan"></i>`).join("")}</div><small class="muted">Son ${last.length} gecede aldığı puanlar</small>` : "";
  const teams=[...new Set(all.flatMap(x=>[x.home?.abbr,x.away?.abbr]).filter(Boolean))].sort();
  const sum = n ? `<div class="hs-sum"><span><b>${n}</b><small>maç</small></span><span><b>%${pc(w)}</b><small>kazanan</small></span><span><b>%${pc(m)}</b><small>fark</small></span><span><b>%${pc(sc)}</b><small>skorer</small></span><span><b>${pts}</b><small>puan</small></span></div>
    <div class="hs-sum hs-sum2"><span><b>${curNow}</b><small>şu anki seri</small></span><span><b>${best}</b><small>en uzun seri</small></span><span><b>${bank.length?`${bankOk}/${bank.length}`:"–"}</b><small>banko</small></span><span><b>${bestN?nInfo[bestN].pts:"–"}</b><small>${bestN?`en iyi gece (${dayNice(bestN,{day:"numeric",month:"short"})})`:"en iyi gece"}</small></span></div>
    ${spark}
    <div class="chips hs-f">${[["all","Hepsi"],["ok","Bildikleri"],["no","Bilemedikleri"],["full","Üçünü de bildikleri"],["banko","Bankolar"]].map(([k,l])=>`<button class="chip" data-hsf="${k}" aria-pressed="${flt===k}">${l}</button>`).join("")}</div>
    <select class="adm-in hs-team" id="hsTeam"><option value="">Bütün takımlar</option>${teams.map(t=>`<option value="${t}" ${t===team?"selected":""}>${esc(ALLP?.teams.find(x=>x.a===t)?.n||t)}</option>`).join("")}</select>` : "";
  const ch=(t,ok)=>`<span class="rc ${ok?"ok":"no"}"><i>${ok?"✓":"✗"}</i>${esc(t)}</span>`;
  const byDay={}; for(const x of recs) (byDay[x.day] ||= []).push(x);
  const rows=Object.entries(byDay).map(([d,list])=>`<div class="hs-n"><div class="hs-nh"><b>${dayNice(d,{day:"numeric",month:"long",weekday:"short"})}</b><span>${nInfo[d]?`${nInfo[d].pts} puan · gece ${nInfo[d].rank}.${nInfo[d].of?`/${nInfo[d].of}`:""}`:""}</span></div>
    ${list.map(x=>{ const g=S.arch.games[x.gid]||{}, fav=g.fav, upset=fav && x.r.pick.w && x.r.pick.w!==fav && x.r.w>0, df=Math.abs((x.home?.score??0)-(x.away?.score??0));
      return `<div class="hs"><div class="hs-h"><span class="hs-m"><img src="${LOGO_SMALL(x.away.abbr)}" alt="">${esc(x.away.abbr)} <b>${x.away.score??""}–${x.home.score??""}</b> ${esc(x.home.abbr)}<img src="${LOGO_SMALL(x.home.abbr)}" alt="">${g.cup?`<span class="cup-mini">${ICON.cup}</span>`:""}</span><span class="hs-p ${x.r.pts>0?"pos":x.r.pts<0?"neg":""}">${x.r.pts>0?"+":""}${x.r.pts}</span></div>
        <div class="pk">${ch(x.r.pick.w||"–",x.r.w>0)}${ch(x.r.pick.m||"–",x.r.m>0)}${ch(x.r.pick.s||"–",x.r.s>0)}${x.r.c?'<span class="rc"><i>★</i>banko</span>':""}</div>
        <small class="hs-x">Sonuç: ${esc(x.winner||"")} ${df} farkla (${bucketOf(g,df)})${g.top?.length?` · en skorer ${esc(g.top.map(t=>t.name).join(", "))} ${g.top[0].pts}`:""}${fav?` · ESPN favorisi ${esc(fav)}`:""}${upset?' · <b class="hs-up">favorinin tersine bildi</b>':""}</small></div>`; }).join("")}</div>`).join("");
  openSheet(`<div class="hs-top">${avatar(u,"sm")}<h3 id="shTitle" style="margin:0">${me?"Tahmin geçmişin":`${esc(pname(u))} · tahmin geçmişi`}</h3></div><p class="muted">${n} biten maç${leagueStart()>(S.cfg?.seasonStart||"")?" (bu lig)":""}.</p>
    ${sum}${n?`${me?`<button class="btn" id="csvBtn" type="button">${ICON.download}Excel için indir (CSV)</button>`:""}<div class="hs-list">${rows||emptyBox("filter", "Bu filtrede maç yok.")}</div>`:`<div class="note">${me?"Tahmin yaptığın":"Tahmin yaptığı"} maçlar bittikçe burada listelenecek.</div>`}`);
  $$("#sheet [data-hsf]").forEach(b=>b.onclick=()=>openHistory(u, b.dataset.hsf, team));
  $("#hsTeam")?.addEventListener("change", e=>openHistory(u, flt, e.target.value));
  $("#csvBtn")?.addEventListener("click", ()=>{
    const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const head=["Tarih","Deplasman","Ev sahibi","Skor","Kazanan","Tahminin","Fark tahmini","Skorer tahmini","Banko","Kazanan doğru","Fark doğru","Skorer doğru","Puan"];
    const lines=recs.map(x=>[`${x.day.slice(6)}.${x.day.slice(4,6)}.${x.day.slice(0,4)}`, x.away.abbr, x.home.abbr, `${x.away.score??""}-${x.home.score??""}`, x.winner, x.r.pick.w, x.r.pick.m, x.r.pick.s, x.r.c?"evet":"", x.r.w>0?"evet":"hayır", x.r.m>0?"evet":"hayır", x.r.s>0?"evet":"hayır", x.r.pts].map(q).join(";"));
    const blob=new Blob(["﻿"+[head.map(q).join(";"),...lines].join("\r\n")],{type:"text/csv;charset=utf-8"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`nba-tahmin-${slug(pname(u))||"tahminler"}.csv`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  });
}
// Takım sayfası: son maçlar, sıradaki maçlar, sakatlar ve senin bu takımla karnen
S.sched={};
async function openTeam(abbr){ openSheet('<div id="tmRoot"></div>'); return teamPage(abbr, $("#tmRoot")); }
async function teamPage(abbr, root, opts={}){
  await allPlayers().catch(()=>{});
  const t=ALLP?.teams.find(x=>x.a===abbr) || {a:abbr,n:abbr};
  const id=t.id || Object.values(S.days).flatMap(D=>D.games).flatMap(g=>[g.home,g.away]).find(x=>x.abbr===abbr)?.id;
  root.innerHTML=(`<div class="pc-cover team" style="--tc:${tcol(abbr)}"><img src="${LOGO_SMALL(abbr)}" alt=""></div><div class="pc-head on-cover"><div><h3 ${opts.view?"":'id="shTitle"'} style="margin:0">${esc(t.n)}</h3><small class="muted tmRec">Yükleniyor…</small></div>${opts.head||""}</div><div class="tmTop"></div><div class="tmBody"></div>${opts.view?'<div class="tmMore"></div>':""}`);
  nbaStandings().then(()=>{ const el=root.querySelector(".tmTop"); if(el) el.innerHTML=teamStatsHTML(abbr); }).catch(()=>{});
  let sch=null;
  if(id){ const c=S.sched[id]; if(c && Date.now()-c.at<10*60e3) sch=c.data; else { try{ sch=await espn(`/teams/${id}/schedule`); S.sched[id]={at:Date.now(), data:sch}; }catch(e){} } }
  const evs=(sch?.events||[]).filter(e=>e.seasonType?.type!==1 && e.season?.type!==1);
  const side=e=>{ const c=e.competitions[0], me=c.competitors.find(x=>x.team?.abbreviation===abbr), op=c.competitors.find(x=>x!==me); return {c,me,op}; };
  const done=evs.filter(e=>e.competitions[0].status?.type?.completed).slice(-5).reverse();
  const next=evs.filter(e=>!e.competitions[0].status?.type?.completed).slice(0,opts.view?5:3);
  const sc=v=>v?.displayValue ?? v ?? "";
  const roster = id ? await loadRoster({id, abbr, logo:LOGO_SMALL(abbr)}).catch(()=>[]) : [];
  await loadInj().catch(()=>{});
  const inj=injOfTeam(abbr);
  const my=userRecs(S.uid).filter(x=>x.home.abbr===abbr||x.away.abbr===abbr), ok=my.filter(x=>x.r.w>0).length;
  if(!root.isConnected) return;
  const DIV={Atlantic:"Atlantik",Central:"Merkez",Southeast:"Güneydoğu",Northwest:"Kuzeybatı",Pacific:"Pasifik",Southwest:"Güneybatı",Eastern:"Doğu",Western:"Batı"};
  const stand=UI_EN ? (sch?.team?.standingSummary||"") : (sch?.team?.standingSummary||"").replace(/^(\d+)\w*\s+in\s+(\w+)\s+(Division|Conference)$/i,(m,n,d,k)=>`${DIV[d]||d} ${/conf/i.test(k)?"Konferansı":"Grubu"}nda ${n}.`);
  root.querySelector(".tmRec").textContent=[sch?.team?.recordSummary?`${sch.team.recordSummary} (G-M)`:"", stand].filter(Boolean).join(" · ");
  root.querySelector(".tmBody").innerHTML=`
    <div class="sec-title"><h2 style="font-size:20px">Son maçlar</h2></div>
    ${done.length?`<div class="tm-list">${done.map(e=>{ const {me,op}=side(e); const w=me?.winner; return `<div class="tm-g"><span class="tm-r ${w?"W":"L"}">${w?"G":"M"}</span><img src="${LOGO_SMALL(op?.team?.abbreviation||"")}" alt=""><span>${me?.homeAway==="home"?"":"@ "}${esc(op?.team?.shortDisplayName||op?.team?.abbreviation||"")}</span><b>${sc(me?.score)}–${sc(op?.score)}</b><small>${dayNice(ymd(new Date(new Date(e.date).getTime()-8*36e5)),{day:"numeric",month:"short"})}</small></div>`; }).join("")}</div>`:emptyBox("ball", "Bu sezon henüz maçı yok.")}
    ${next.length?`<div class="sec-title"><h2 style="font-size:20px">Sıradaki maçlar</h2></div><div class="tm-list">${next.map(e=>{ const {me,op}=side(e); return `<div class="tm-g"><span class="tm-r"></span><img src="${LOGO_SMALL(op?.team?.abbreviation||"")}" alt=""><span>${me?.homeAway==="home"?"":"@ "}${esc(op?.team?.shortDisplayName||"")}</span><small>${new Date(e.date).toLocaleString(LOC,{timeZone:TZ,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</small></div>`; }).join("")}</div>`:""}
    <div class="sec-title"><h2 style="font-size:20px">Sakatlar</h2></div>
    ${inj.length?`<div class="tm-list">${inj.map(p=>`<button class="tm-g tm-inj" data-ath="${p.id}"><span class="tm-r ${p.o?"L":"T"}"></span><span>${esc(p.n)}${p.c?`<small class="inj-c">${esc(p.c)}</small>`:""}</span><small>${UI_EN?({Oynamıyor:"Out",Belirsiz:"Questionable",Cezalı:"Suspended"}[p.s]||p.s):p.s}${p.y?` · ${esc(UI_EN?p.y.toLowerCase():(INJ_PART[p.y]||p.y).toLocaleLowerCase("tr"))}`:""}</small></button>`).join("")}</div>`:emptyBox("heal", "Sakat oyuncu yok.")}
    <div class="sec-title"><h2 style="font-size:20px">Senin karnen</h2></div>
    ${my.length?`<div class="box"><b style="font-size:20px">%${Math.round(ok/my.length*100)}</b> <span class="muted">bu takımın ${my.length} maçında kazananı bildin</span>
      <div class="pk" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${my.slice(-6).reverse().map(x=>`<span class="rc ${x.r.w>0?"ok":"no"}"><i>${x.r.w>0?"✓":"✗"}</i>${esc(x.away.abbr)}–${esc(x.home.abbr)}</span>`).join("")}</div></div>`:emptyBox("cards", "Bu takımın maçlarına tahmin yaptıkça karnen burada oluşacak.")}`;
  // kadro: seçilen istatistiğe göre (sayı, ribaund, asist, top çalma, blok, saha içi %, üçlük %, maç)
  if(roster.length){
    const box=document.createElement("div"); root.querySelector(".tmBody").appendChild(box);
    const RS={pts:["Sayı",p=>p.pts/p.gp,1],reb:["Ribaund",p=>p.reb/p.gp,1],ast:["Asist",p=>p.ast/p.gp,1],stl:["Top çalma",p=>(p.stl||0)/p.gp,1],blk:["Blok",p=>(p.blk||0)/p.gp,1],
      fg:["Saha içi %",p=>p.fga?p.fgm/p.fga*100:null,0],tp:["Üçlük %",p=>p.tpa?p.tpm/p.tpa*100:null,0],gp:["Maç",p=>p.gp,2]};
    const paint=()=>{ const k=RS[S.rsort]?S.rsort:"pts", [lab,f,fmt]=RS[k];
      const rs=roster.map(p=>{ const st=S.pstats[p.id]; return {...p, v: st&&st.gp ? f(st) : null}; }).sort((a,b)=>(b.v??-1)-(a.v??-1));
      const show=v=> v==null ? "–" : fmt===0 ? "%"+v.toFixed(1) : fmt===2 ? String(v) : v.toFixed(1);
      box.innerHTML=`<div class="sec-title"><h2 style="font-size:20px">Kadro</h2><span class="aside">${lab.toLocaleLowerCase("tr")}${fmt===2?" sayısına":fmt===0?"na":" ortalamasına"} göre</span></div>
        <div class="chips rs-f">${Object.entries(RS).map(([kk,[l]])=>`<button class="chip" data-rs="${kk}" aria-pressed="${kk===k}">${l}</button>`).join("")}</div>
        <div class="roster">${rs.map(p=>`<button class="ro-p" data-ath="${p.id}"><img src="${FACE(p.id)}" alt="" loading="lazy"><span><b>${esc(p.name)}</b><small>${esc(p.pos||"")}${p.jersey?" · #"+p.jersey:""}${S.inj?.[p.id]?` · ${injBadge(p.id)}`:""}</small></span><em>${show(p.v)}</em></button>`).join("")}</div>`;
      box.querySelectorAll("[data-rs]").forEach(b=>b.onclick=e=>{ e.stopPropagation(); S.rsort=b.dataset.rs; paint(); }); };
    paint(); }
  if(opts.view) await opts.after?.(root.querySelector(".tmMore"), {roster, evs});
}

/* ====================================================== Eksik tahmin uyarısı */
function renderAlert(){
  const el=$("#alert"); if(!el) return;
  const D=S.days[S.today];
  el.classList.remove("sticky");
  if(!S.uid || !D || !D.games.length){ el.innerHTML=""; return; }
  const open = D.games.filter(g=>!started(g));
  if(!open.length){ el.innerHTML=""; return; }
  const missing = open.filter(g=>!D.picks[g.id]?.[S.uid]);
  const daily = D.daily[S.uid]||{};
  const noBanko = !daily.confGame && !D.games.some(started);
  const noDp = !daily.dayPlayerId && !D.games.some(started);
  const noQ = !daily.q && !D.games.some(started);
  const inj = injuryAlerts(D);
  if(!missing.length && !noBanko && !noDp && !noQ && !inj.length){ el.innerHTML=""; return; }
  // en yakın kilit: eksik maçlar ya da (günün oyuncusu eksikse) ilk maç
  const locks = missing.map(g=>g.lock.getTime());
  if(noDp || noBanko || noQ || inj.length) locks.push(D.games[0].nightLock.getTime());
  const ms = Math.min(...locks) - Date.now();
  if(ms > 12*36e5 && !inj.length){ el.innerHTML=""; return; }   // 12 saatten uzaksa gösterme (sakatlık hariç)
  const h=Math.floor(ms/36e5), m=Math.max(0,Math.floor(ms%36e5/6e4));
  const when = ms<=0 ? "Tahminler kilitleniyor" : `Kilide ${h?h+" sa ":""}${m} dk kaldı`;
  const parts=[];
  if(inj.length) parts.push(`<b>${inj.map(esc).join(", ")} oynamayacak</b>`);
  if(missing.length) parts.push(`<b>${missing.length} maç eksik</b>`);
  if(noBanko) parts.push("Banko seçilmedi");
  if(noDp) parts.push("Günün oyuncusu seçilmedi");
  if(noQ) parts.push("Gecenin sorusu cevaplanmadı");
  const urgent = ms < 60*60e3;
  el.classList.toggle("sticky", urgent);   // son 1 saatte ekranın üstüne yapışır
  el.innerHTML = `<button class="alert ${urgent?"urgent":""}" id="alertBtn"><span class="al-dot"></span><span class="al-tx"><span>${when}</span><span>${parts.join(" · ")}</span></span><span class="al-go">Tamamla ›</span></button>`;
  $("#alertBtn").onclick = () => {
    if(S.day!==S.today){ S.day=S.today; }
    S.sub="maclar"; $$("#subSel button").forEach(x=>x.setAttribute("aria-pressed", x.dataset.v==="maclar"));
    $("#subMaclar").classList.remove("hide"); $("#subTahminler").classList.add("hide");
    if(location.hash!=="#tahmin") location.hash="#tahmin"; else showDay();
    setTimeout(()=>{ const first=$(".game.missing"); first?.scrollIntoView({behavior:"smooth",block:"center"}); }, 900);
  };
}
setInterval(()=>{ if(S.uid) { renderAlert(); if(S.tab==="tahmin" && S.sub==="maclar") $$(".lock-note").forEach(el=>{ const g=S.days[S.day]?.games.find(x=>x.id===el.closest(".game")?.dataset.gid); if(g) el.textContent=lockLeft(g); });
  $$("[data-ring]").forEach(el=>{ const g=S.days[S.day]?.games.find(x=>x.id===el.dataset.ring); if(g) el.outerHTML=ringHTML(g); }); } }, 30e3);

/* ====================================================== NBA sekmesi: puan durumu, liderler, takımlar, oyuncular */
const WEB = "https://site.web.api.espn.com/apis";
S.nba = { sub:(()=>{ try{ return localStorage.getItem("nbaSub")||"puan"; }catch(e){ return "puan"; } })(), view:"conf", cat:"pts", q:"", tonight:false };
S.nbaC = {};
async function cached(key, url, ttl=10*60e3){
  const c=S.nbaC[key]; if(c && Date.now()-c.at<ttl) return c.data;
  const data=await getJSON(url); S.nbaC[key]={at:Date.now(), data}; return data;
}
const stOf = (e, n) => { const x=e.stats.find(s=>s.name===n || s.type===n || s.abbreviation===n); return x ? (x.displayValue ?? x.value) : ""; };
const wlOf = e => `${stOf(e,"wins")||0}-${stOf(e,"losses")||0}`;
const streakTR = v => String(v||"–").replace(/^W/,"G").replace(/^L/,"M");
async function nbaStandings(){
  const d=await cached("st", `${WEB}/v2/sports/basketball/nba/standings?level=3`);
  const confs=(d.children||[]).map(c=>{ const divs=(c.children||[]).map(dv=>({name:dv.name, entries:dv.standings?.entries||[]}));
    const entries=divs.flatMap(x=>x.entries).sort((a,b)=>(+stOf(a,"playoffSeed")||99)-(+stOf(b,"playoffSeed")||99));
    return {name:c.name, abbr:c.abbreviation, divs, entries}; });
  S.standings=confs; return confs;
}
const DIV_TR={Atlantic:"Atlantik",Central:"Merkez",Southeast:"Güneydoğu",Northwest:"Kuzeybatı",Pacific:"Pasifik",Southwest:"Güneybatı"};
function teamStatsHTML(abbr){
  const all=(S.standings||[]).flatMap(c=>c.entries.map(e=>({e,c}))); const me=all.find(x=>x.e.team.abbreviation===abbr); if(!me) return "";
  const rank=(n,desc=true)=>{ const v=all.map(x=>+stOf(x.e,n)); const mine=+stOf(me.e,n); return 1+v.filter(x=> desc? x>mine : x<mine).length; };
  const k=(v,l,r)=>`<div class="kpi"><b>${v}</b><small>${l}${r?` · Ligde ${r}.`:""}</small></div>`;
  return `<div class="cards2 tm-kpis">${k(wlOf(me.e)||"–","Galibiyet-mağlubiyet")}${k(`${stOf(me.e,"playoffSeed")}.`,`${me.c.abbr==="East"?"Doğu":"Batı"} sırası`)}
    ${k(stOf(me.e,"avgPointsFor"),"Attığı sayı (ort.)",rank("avgPointsFor"))}${k(stOf(me.e,"avgPointsAgainst"),"Yediği sayı (ort.)",rank("avgPointsAgainst",false))}
    ${k(stOf(me.e,"Home")||"–","İç saha")}${k(stOf(me.e,"Road")||"–","Dış saha")}${k(stOf(me.e,"Last Ten Games")||"–","Son 10 maç")}${k(streakTR(stOf(me.e,"streak")),"Seri")}</div>`;
}
// Takımım: favori takımın sayfası + takvim + takım liderleri + ligin bu takımdaki tahminleri
function teamLeadersHTML(abbr){
  const ps=Object.entries(S.pstats||{}).filter(([,p])=>p.t===abbr && p.gp>=2);
  if(!ps.length) return "";
  const pg=(p,k)=>(p[k]||0)/p.gp, pct=(m,a)=>a?m/a*100:null;
  const cats=[["Sayı",p=>pg(p,"pts"),v=>v.toFixed(1)],["Ribaund",p=>pg(p,"reb"),v=>v.toFixed(1)],["Asist",p=>pg(p,"ast"),v=>v.toFixed(1)],
    ["Top çalma + blok",p=>pg(p,"stl")+pg(p,"blk"),v=>v.toFixed(1)],["Saha içi %",p=>(p.fga||0)>=8*p.gp?pct(p.fgm,p.fga):null,v=>"%"+v.toFixed(1)],["Üçlük %",p=>(p.tpa||0)>=3*p.gp?pct(p.tpm,p.tpa):null,v=>"%"+v.toFixed(1)]];
  const cards=cats.map(([l,f,fmt])=>{ const best=ps.map(([id,p])=>({id,p,v:f(p)})).filter(x=>x.v!=null).sort((a,b)=>b.v-a.v)[0]; if(!best) return "";
    return `<button class="tl-c" data-ath="${best.id}"><img src="${FACE(best.id)}" alt="" loading="lazy"><span><small>${l}</small><b>${esc(surname(best.p.n))}</b></span><em class="tnum">${fmt(best.v)}</em></button>`; }).join("");
  return `<div class="sec-title"><h2 style="font-size:20px">Takım liderleri</h2><span class="aside">maç başına, bu sezon</span></div><div class="tl-grid">${cards}</div>`;
}
async function renderTakim(){
  const box=$("#takim"); if(!box) return;
  await allPlayers().catch(()=>{});
  const fav=S.players[S.uid]?.favTeam;
  if(!fav){ box.innerHTML=`${emptyBox("shield","Favori takımını seçersen bu sekmede o takımın maçları, takvimi, kadrosu ve istatistikleri görünür.","Takımını seç")}<button class="btn-primary" id="tkPick" type="button" style="margin-top:12px">Favori takımını seç</button>`;
    $("#tkPick").onclick=()=>openProfile("ayar"); return; }
  box.innerHTML='<div id="tkRoot"></div>';
  await teamPage(fav, $("#tkRoot"), {view:true, head:`<button class="linkish tk-ch" id="tkChange" type="button">Takımı değiştir</button>`,
    after: async el=>{ if(!el) return;
      el.innerHTML = teamLeadersHTML(fav) + `<div class="sec-title"><h2 style="font-size:20px">Takvim</h2></div><div id="tkCal">${skeletonCards(1)}</div>`;
      try{ $("#tkCal").innerHTML=await calendarHTML(); bindCalendar(); }catch(e){ $("#tkCal").innerHTML='<div class="note">Takvime şu an ulaşılamıyor.</div>'; } } });
  $("#tkChange")?.addEventListener("click", ()=>openProfile("ayar"));
}
function renderNBA(){
  const box=$("#nba"); if(!box) return;
  const subs=[["puan","Puan durumu"],["kupa","NBA Kupası"],["lider","Liderler"],["takim","Takımlar"],["oyuncu","Oyuncular"]];
  if(S.nba.sub==="takvim") S.nba.sub="puan";
  const head=`<div class="nba-subs">${subs.map(([k,l])=>`<button data-nsub="${k}" aria-pressed="${S.nba.sub===k}">${l}</button>`).join("")}</div><div id="nbaBody">${skeletonCards(1)}</div>`;
  if(!box.querySelector(".nba-subs")) box.innerHTML=head; else box.querySelectorAll("[data-nsub]").forEach(b=>b.setAttribute("aria-pressed", b.dataset.nsub===S.nba.sub));
  const body=$("#nbaBody");
  const fail=()=>{ body.innerHTML=`<div class="note">ESPN'e şu an ulaşılamıyor. Biraz sonra tekrar dene.</div>`; };
  if(S.nba.sub==="puan") nbaStandings().then(c=>{ if(S.nba.sub==="puan") body.innerHTML=standingsHTML(c); }).catch(fail);
  if(S.nba.sub==="kupa") body.innerHTML=cupHTML();
  if(S.nba.sub==="takvim") calendarHTML().then(h=>{ if(S.nba.sub==="takvim"){ body.innerHTML=h; bindCalendar(); } }).catch(fail);
  if(S.nba.sub==="lider") leadersHTML().then(h=>{ if(S.nba.sub==="lider") body.innerHTML=h; }).catch(fail);
  if(S.nba.sub==="takim") nbaStandings().catch(()=>null).then(()=>allPlayers().catch(()=>{})).then(()=>{ if(S.nba.sub==="takim") body.innerHTML=teamsGridHTML(); });
  if(S.nba.sub==="oyuncu") allPlayers().catch(()=>{}).then(()=>{ if(S.nba.sub==="oyuncu"){ body.innerHTML=playersHTML(); bindPlayerSearch();
    body.querySelectorAll("[data-fcat]").forEach(b=>b.onclick=()=>{ S.formCat=b.dataset.fcat; renderNBA(); });
    $("#pcmpBtn")?.addEventListener("click", ()=>openPlayerCompare()); } });
}
// Takvim: favori takımın maçları, NBA Kupası geceleri ve uzun vade kilitleri tek ayda
const CUP_NIGHTS = {"20261030":"Kupa grup","20261106":"Kupa grup","20261113":"Kupa grup","20261120":"Kupa grup","20261124":"Kupa grup","20261125":"Kupa grup","20261127":"Kupa grup","20261204":"Kupa çeyrek final","20261205":"Kupa çeyrek final"};
async function calendarHTML(){
  await allPlayers().catch(()=>{});
  const fav=S.players[S.uid]?.favTeam, team=ALLP?.teams.find(t=>t.a===fav);
  S.calM = S.calM || S.today.slice(0,6);
  let sched={};
  if(team){ const d=await cached("sch_"+team.id, `${ESPN_BASES[0]}/teams/${team.id}/schedule`, 3*36e5).catch(()=>null);
    for(const ev of d?.events||[]){ const c=ev.competitions?.[0]; if(!c) continue; const me=c.competitors.find(x=>x.team?.abbreviation===fav), op=c.competitors.find(x=>x.team?.abbreviation!==fav);
      const day=ymd(new Date(new Date(ev.date).getTime()-8*36e5)); sched[day]={op:op?.team?.abbreviation, home:me?.homeAway==="home", t:new Date(ev.date),
        res: c.status?.type?.completed ? `${me?.winner?"G":"M"} ${me?.score?.displayValue??me?.score??""}-${op?.score?.displayValue??op?.score??""}` : ""}; } }
  const locks={}; for(const k of ltRounds()){ const d=ymd(new Date(ltLock(k)+3*36e5-8*36e5)); (locks[d] ||= []).push(ltTitle(k).split(" · ")[0]); }
  const y=+S.calM.slice(0,4), m=+S.calM.slice(4,6), first=new Date(Date.UTC(y,m-1,1)), days=new Date(Date.UTC(y,m,0)).getUTCDate(), off=(first.getUTCDay()+6)%7;
  let cells=""; for(let i=0;i<off;i++) cells+=`<div class="cal-c empty"></div>`;
  for(let d=1; d<=days; d++){ const k=`${y}${String(m).padStart(2,"0")}${String(d).padStart(2,"0")}`, g=sched[k], cup=CUP_NIGHTS[k], lk=locks[k];
    cells+=`<div class="cal-c${k===S.today?" today":""}${cup?" cup":""}"><span class="cal-d">${d}</span>${g?`<span class="cal-g" title="${g.home?"Evde":"Deplasmanda"} ${g.op}"><img src="${LOGO_SMALL(g.op)}" alt="">${g.res?`<small class="${g.res[0]==="G"?"w":"l"}">${g.res.split(" ")[0]}</small>`:`<small>${g.home?"ev":"dep"}</small>`}</span>`:""}${cup?`<i class="cal-cup" title="${cup}">${ICON.cup}</i>`:""}${lk?`<i class="cal-lk" title="Uzun vade kilidi: ${esc(lk.join(", "))}">🔒</i>`:""}</div>`; }
  const mn=MONTHS_TR[m-1]+" "+y;
  return `<div class="cal-nav"><button class="btn sm" data-calm="-1" type="button">‹</button><b>${mn}</b><button class="btn sm" data-calm="1" type="button">›</button></div>
    <div class="mcal">${["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"].map(x=>`<div class="cal-w">${x}</div>`).join("")}${cells}</div>
    <div class="cal-key">${team?`<span><img src="${LOGO_SMALL(fav)}" alt="">${esc(team.n)} maçları (ABD tarihi; G/M sonuç)</span>`:`<span>Favori takımını seçersen maçları burada görünür (Profil → Ayarlar).</span>`}<span>${ICON.cup} NBA Kupası gecesi</span><span>🔒 Uzun vade kilidi</span></div>`;
}
function bindCalendar(){ $$("[data-calm]").forEach(b=>b.onclick=()=>{ const y=+S.calM.slice(0,4), m=+S.calM.slice(4,6)+ +b.dataset.calm; const d=new Date(Date.UTC(y,m-1,1)); S.calM=`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}`;
  if(S.tab==="takim") calendarHTML().then(h=>{ const el=$("#tkCal"); if(el){ el.innerHTML=h; bindCalendar(); } }); else renderNBA(); }); }
// NBA Kupası 2026: grup sıralaması biten kupa maçlarından hesaplanır (sync her saat arşive ekler)
const CUP_GROUPS = [["Doğu A",["BKN","DET","MIL","ORL","TOR"]],["Doğu B",["CLE","IND","MIA","NY","PHI"]],["Doğu C",["ATL","BOS","CHA","CHI","WSH"]],
  ["Batı A",["DAL","DEN","HOU","PHX","UTAH"]],["Batı B",["LAC","MEM","MIN","NO","OKC"]],["Batı C",["GS","LAL","POR","SAC","SA"]]];
function cupHTML(){
  const st={}, ko=[], h2h={};
  for(const g of Object.values(S.arch.games||{})){ if(!g.cup) continue;
    if(!/group/i.test(g.cupStage||"Group")){ ko.push(g); continue; }
    h2h[g.home.abbr+"|"+g.away.abbr]=g.winner; h2h[g.away.abbr+"|"+g.home.abbr]=g.winner;
    for(const [me,op] of [["home","away"],["away","home"]]){ const a=g[me].abbr, x=st[a] ||= {w:0,l:0,pd:0,pf:0};
      if(g.winner===a) x.w++; else x.l++; x.pd += (g[me].score||0)-(g[op].score||0); x.pf += g[me].score||0; } }
  // NBA.com sırası: galibiyet yüzdesi (maçı olmayan en sonda), ikili maç, sayı farkı, atılan sayı
  const pct = r => r.w+r.l ? r.w/(r.w+r.l) : -1;
  const cmp = (x,y) => pct(y)-pct(x) || (h2h[x.a+"|"+y.a]===x.a ? -1 : h2h[x.a+"|"+y.a]===y.a ? 1 : 0) || y.pd-x.pd || y.pf-x.pf;
  const fav=S.players[S.uid]?.favTeam, nm=a=>ALLP?.teams.find(t=>t.a===a)?.n?.split(" ").slice(-1)[0] || a;
  const grp=([name,teams])=>{ const rows=teams.map(a=>({a, ...(st[a]||{w:0,l:0,pd:0,pf:0})})).sort(cmp);
    return `<div class="cup-g"><div class="cup-gh">${esc(name)}</div>${rows.map((r,i)=>`<button class="cup-r ${i===0&&r.w?"lead":""} ${r.a===fav?"fav":""}" data-tp="${r.a}" style="--tc:${tcol(r.a)}"><span class="cup-n">${i+1}</span><img src="${LOGO_SMALL(r.a)}" alt=""><b>${esc(nm(r.a))}</b><span class="tnum">${r.w}-${r.l}</span><span class="tnum cup-pd ${r.pd>0?"pos":r.pd<0?"neg":""}">${r.pd>0?"+":""}${r.pd}</span></button>`).join("")}</div>`; };
  const koHTML = ko.length ? `<div class="sec-title"><h2 style="font-size:20px">Eleme turu</h2></div><div class="cup-ko">${ko.sort((a,b)=>a.day.localeCompare(b.day)).map(g=>`<div class="cup-kr"><small>${esc(cupStageTR(g.cupStage))} · ${dayNice(g.day,{day:"numeric",month:"short"})}</small><span><img src="${LOGO_SMALL(g.away.abbr)}" alt="">${esc(g.away.abbr)} <b>${g.away.score}</b> – <b>${g.home.score}</b> ${esc(g.home.abbr)}<img src="${LOGO_SMALL(g.home.abbr)}" alt=""></span></div>`).join("")}</div>` : "";
  if(!ALLP) allPlayers().then(()=>{ if(S.nba.sub==="kupa") $("#nbaBody").innerHTML=cupHTML(); }).catch(()=>{});
  return `<div class="cup-hero">${ICON.cup}<div><b>NBA Kupası 2026</b><small>Grup maçları cuma geceleri, son grup maçları 24-25 Kasım. Çeyrek finaller 4-5 Aralık, final Indianapolis'te. Kupa maçlarına yapılan tahminler 2 kat puan getirir.</small></div></div>
    <div class="cup-grid">${CUP_GROUPS.map(grp).join("")}</div>
    <small class="muted st-key">Her grubun birincisi ve her konferansta en iyi grup ikincisi çeyrek finale çıkar. Eşitlikte sırasıyla ikili maç, sayı farkı ve atılan sayıya bakılır (NBA.com ile aynı).</small>${koHTML}
    <button class="btn awards-btn" data-lt="c_2026" type="button">${ICON.cup}Kupa şampiyonunu ve finalistleri tahmin et (Uzun vade)</button>`;
}
function standingsHTML(confs){
  const fav=S.players[S.uid]?.favTeam;
  const row=(e,i,mode)=>{ const t=e.team, a=t.abbreviation, l10=stOf(e,"Last Ten Games")||"0-0", [w10,lo10]=l10.split("-").map(Number), seed=+stOf(e,"playoffSeed");
    const cls = mode==="conf" ? (seed<=6?"po":seed<=10?"pi":"") : "";
    return `<button class="st-r ${cls} ${a===fav?"fav":""}" data-tp="${a}" style="--tc:${tcol(a)}"><span class="st-n">${mode==="conf"?seed:i+1}</span><img src="${LOGO_SMALL(a)}" alt=""><span class="st-t"><b>${esc(t.shortDisplayName||a)}</b><small>${esc(a)}</small></span>
      <span class="st-wl tnum">${wlOf(e)}</span><span class="st-pct tnum">${stOf(e,"winPercent")}</span><span class="st-gb tnum">${stOf(e,"gamesBehind")}</span>
      <span class="st-l10"><i style="width:${(w10+lo10)?w10/(w10+lo10)*100:0}%"></i><small class="tnum">${l10}</small></span><span class="st-sk ${/^W/.test(stOf(e,"streak"))?"w":"l"} tnum">${(stOf(e,"streak")||"").replace(/^W/,"G").replace(/^L/,"M")}</span></button>`; };
  const hdr=`<div class="st-h"><span>#</span><span></span><span>Takım</span><span>G-M</span><span>%</span><span>Geri</span><span>Son 10</span><span>Seri</span></div>`;
  const tog=`<div class="chips nba-view"><button class="chip" data-nview="conf" aria-pressed="${S.nba.view==="conf"}">Konferans</button><button class="chip" data-nview="div" aria-pressed="${S.nba.view==="div"}">Grup</button></div>`;
  const conf=c=>`<div class="sec-title"><h2 style="font-size:20px">${c.abbr==="East"?"Doğu Konferansı":"Batı Konferansı"}</h2></div>`
    + (S.nba.view==="conf" ? `<div class="st-tbl">${hdr}${c.entries.map((e,i)=>row(e,i,"conf")).join("")}</div>`
      : c.divs.map(d=>`<div class="st-div">${esc(DIV_TR[d.name.replace(/ Division$/,"")]||d.name)}</div><div class="st-tbl">${hdr}${[...d.entries].sort((a,b)=>(+stOf(b,"winPercent"))-(+stOf(a,"winPercent"))).map((e,i)=>row(e,i,"div")).join("")}</div>`).join(""));
  return tog + confs.map(conf).join("") + `<small class="muted st-key"><i class="po"></i>İlk 6: doğrudan play-off <i class="pi"></i>7-10: play-in</small>` + pickedVsReal();
}
// Ligin en çok seçtiği takımlar ve gerçek durumları
function pickedVsReal(){
  const cnt={}, ok={};
  for(const [gid,row] of Object.entries(S.arch.scores.games||{})){ const g=S.arch.games[gid]; if(!g) continue;
    for(const [u,r] of Object.entries(row)){ if(!S.order.includes(u) || !r.pick?.w) continue; cnt[r.pick.w]=(cnt[r.pick.w]||0)+1; if(r.w>0) ok[r.pick.w]=(ok[r.pick.w]||0)+1; } }
  const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,8); if(!top.length) return "";
  const all=(S.standings||[]).flatMap(c=>c.entries);
  return `<div class="sec-title"><h2 style="font-size:20px">Ligin inandığı takımlar</h2><span class="aside">en çok seçilen ve gerçek durumu</span></div><div class="pvr">${top.map(([a,n])=>{
    const e=all.find(x=>x.team.abbreviation===a); const rec=e?wlOf(e):"–", pct=Math.round((ok[a]||0)/n*100);
    return `<button class="pvr-r" data-tp="${a}" style="--tc:${tcol(a)}"><img src="${LOGO_SMALL(a)}" alt=""><b>${esc(a)}</b><span>${n} kez seçildi</span><span class="muted">tutma %${pct}</span><em class="tnum">${rec}</em></button>`; }).join("")}</div>`;
}
const CATS=[["pts","Sayı","offensive.avgPoints","offensive",0],["reb","Ribaund","general.avgRebounds","general",11],["ast","Asist","offensive.avgAssists","offensive",10],
  ["stl","Top çalma","defensive.avgSteals","defensive",0],["blk","Blok","defensive.avgBlocks","defensive",1],["3pm","Üçlük","offensive.avgThreePointFieldGoalsMade","offensive",4],["fg","İsabet %","offensive.fieldGoalPct","offensive",3]];
async function leadersHTML(){
  const c=CATS.find(x=>x[0]===S.nba.cat)||CATS[0];
  const d=await cached("ld_"+c[0], `${WEB}/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=10&sort=${c[2]}:desc`);
  const val=a=>{ const cat=a.categories.find(x=>x.name===c[3]); const v=+cat?.values?.[c[4]]; return isFinite(v)?(c[0]==="fg"?v.toFixed(1):v.toFixed(1)):"–"; };
  const list=(d.athletes||[]).slice(0,10);
  const chips=`<div class="chips nba-cats">${CATS.map(x=>`<button class="chip" data-ncat="${x[0]}" aria-pressed="${x[0]===c[0]}">${x[1]}</button>`).join("")}</div>`;
  if(!list.length) return chips+`${emptyBox("chart", "Henüz yeterli maç oynanmadı.")}`;
  const [f,...rest]=list, fa=f.athlete;
  const top=`<button class="ld-top" data-ath="${fa.id}" data-athn="${esc(fa.displayName)}" data-atht="${esc(fa.teamShortName||"")}" style="--tc:${tcol(fa.teamShortName)}"><img class="ld-face" src="https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${fa.id}.png&w=300&h=219&scale=crop&cquality=75" alt=""><span class="ld-info"><small>1. ${c[1]} lideri</small><b>${esc(fa.displayName)}</b><span><img src="${LOGO_SMALL(fa.teamShortName)}" alt="">${esc(fa.teamShortName||"")}</span></span><em class="tnum">${val(f)}</em><span class="ld-spark" id="ldSpark"></span></button>`;
  setTimeout(()=>sparkFor(fa.id, c[0]), 0);
  return chips + top + `<div class="ld-list">${rest.map((x,i)=>`<button class="ld-r" data-ath="${x.athlete.id}" data-athn="${esc(x.athlete.displayName)}" data-atht="${esc(x.athlete.teamShortName||"")}"><span class="ld-n">${i+2}</span><img src="${FACE(x.athlete.id)}" alt="" loading="lazy"><span class="ld-nm"><b>${esc(x.athlete.displayName)}</b><small><img src="${LOGO_SMALL(x.athlete.teamShortName)}" alt="">${esc(x.athlete.teamShortName||"")} · ${esc(x.athlete.position?.abbreviation||"")}</small></span><em class="tnum">${val(x)}</em></button>`).join("")}</div><small class="muted">Kaynak: ESPN, maç başına ortalama (yeterli maçı olan oyuncular).</small>`;
}
// Liderin son maçlarındaki gidişatı (küçük çizgi grafik)
async function sparkFor(id, cat){
  const el=$("#ldSpark"); if(!el) return;
  try{
    const g=await gamelogOf(id); const idx={pts:"points",reb:"totalRebounds",ast:"assists",stl:"steals",blk:"blocks","3pm":"threePointFieldGoalsMade-threePointFieldGoalsAttempted",fg:"fieldGoalPct"}[cat];
    const k=g.names.indexOf(idx); const evs=(g.seasonTypes?.[0]?.categories||[]).flatMap(c=>c.events||[]).slice(0,10).reverse();
    const vals=evs.map(e=>parseFloat(String(e.stats[k]).split("-")[0])).filter(v=>isFinite(v)); if(vals.length<2 || !$("#ldSpark")) return;
    const mx=Math.max(...vals), mn=Math.min(...vals), W=120, H=36, X=i=>(i/(vals.length-1)*W).toFixed(1), Y=v=>(H-3-(v-mn)/((mx-mn)||1)*(H-6)).toFixed(1);
    $("#ldSpark").innerHTML=`<svg viewBox="0 0 ${W} ${H}"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${vals.map((v,i)=>X(i)+","+Y(v)).join(" ")}"/><circle cx="${X(vals.length-1)}" cy="${Y(vals.at(-1))}" r="3" fill="currentColor"/></svg><small>son ${vals.length} maç</small>`;
  }catch(e){}
}
const gamelogOf = id => cached("gl_"+id, `${WEB}/common/v3/sports/basketball/nba/athletes/${id}/gamelog`, 30*60e3);
// İki NBA oyuncusunu yan yana (bu sezonun biten maçlarından)
function openPlayerCompare(){
  S.pc = S.pc || [null,null];
  const slot=i=>{ const id=S.pc[i], p=id&&S.pstats[id], a=id&&(ALLP?.players||[]).find(x=>x.id===id);
    return `<button class="pc-slot" data-pcs="${i}">${id?`<img src="${FACE(id)}" alt=""><b>${esc(surname(p?.n||a?.n||""))}</b><small>${esc(p?.t||a?.t||"")}</small>`:`<span class="pc-plus">+</span><small>Oyuncu seç</small>`}</button>`; };
  const [A,B]=S.pc.map(id=>id&&S.pstats[id]);
  const R=[["Maç",p=>p.gp,0],["Sayı",p=>p.pts/p.gp,1],["Ribaund",p=>p.reb/p.gp,1],["Asist",p=>p.ast/p.gp,1],["Top çalma",p=>(p.stl||0)/p.gp,1],["Blok",p=>(p.blk||0)/p.gp,1],
    ["Saha içi %",p=>p.fga?p.fgm/p.fga*100:null,2],["Üçlük %",p=>p.tpa?p.tpm/p.tpa*100:null,2],["Son 5 maç sayı",p=>p.l5?.length?p.l5.reduce((x,y)=>x+y,0)/p.l5.length:null,1]];
  const fm=(v,k)=>v==null?"–":k===0?String(v):k===2?"%"+v.toFixed(1):v.toFixed(1);
  const rows = A&&B ? R.map(([l,f,k])=>{ const a=f(A), b=f(B); const wa=a!=null&&b!=null&&a>b, wb=a!=null&&b!=null&&b>a;
    return `<div class="pcr"><b class="${wa?"win":""}">${fm(a,k)}</b><span>${l}</span><b class="${wb?"win":""}">${fm(b,k)}</b></div>`; }).join("") : `<p class="muted" style="text-align:center">${S.pc.some(Boolean)&&!(A||B)?"Bu oyuncunun bu sezon kayıtlı maçı yok.":"İki oyuncu seç."}</p>`;
  openSheet(`<h3 id="shTitle">Oyuncu karşılaştır</h3><div class="pc-top">${slot(0)}<span class="pc-vs">VS</span>${slot(1)}</div><div class="pc-rows">${rows}</div>
    <small class="muted">Bu sezonun biten maçlarından, maç başına.</small>`);
  $$("#sheet [data-pcs]").forEach(b=>b.onclick=()=>pickForCompare(+b.dataset.pcs));
}
function pickForCompare(i){
  openSheet(`<h3 id="shTitle">Oyuncu seç</h3><input class="search" id="pcS" placeholder="Oyuncu adı yaz" autocomplete="off"><div id="pcL" class="pl-list"></div><button class="linkish" id="pcBack" type="button">‹ Geri</button>`);
  const inp=$("#pcS"); setTimeout(()=>inp.focus(),60);
  const norm=v=>(v||"").toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const paint=()=>{ const q=norm(inp.value.trim());
    const list=Object.entries(S.pstats||{}).filter(([,p])=>p.gp && (!q || norm(p.n).includes(q))).sort((a,b)=>b[1].pts/b[1].gp-a[1].pts/a[1].gp).slice(0,25);
    $("#pcL").innerHTML=list.map(([id,p])=>`<button class="plr" data-pcp="${id}"><img src="${FACE(id)}" alt="" loading="lazy"><span class="pi"><b>${esc(p.n)}</b><small>${p.t}</small></span><span class="ppg">${(p.pts/p.gp).toFixed(1)}<small>sayı ort.</small></span></button>`).join("")||'<p class="muted">Oyuncu bulunamadı.</p>'; };
  inp.oninput=paint; paint();
  $("#pcL").onclick=e=>{ const b=e.target.closest("[data-pcp]"); if(!b) return; e.stopPropagation(); S.pc[i]=b.dataset.pcp; openPlayerCompare(); };
  $("#pcBack").onclick=()=>openPlayerCompare();
}
function teamsGridHTML(){
  const teams=(ALLP?.teams||[]).slice().sort((a,b)=>a.n.localeCompare(b.n,"tr"));
  const all=(S.standings||[]).flatMap(c=>c.entries);
  return `<div class="tm-grid">${teams.map(t=>{ const e=all.find(x=>x.team.abbreviation===t.a);
    return `<button class="tg" data-tp="${t.a}" style="--tc:${tcol(t.a)}"><span class="tg-l"><img src="${LOGO_SMALL(t.a)}" alt=""></span><b>${esc(t.n.split(" ").slice(-1)[0])}</b><small class="tnum">${e?wlOf(e):""}</small></button>`; }).join("")}</div>`;
}
// Oyuncu aramasında sıralanabilen istatistikler: [etiket, değer, gösterim, en az şart]
const PS_STATS = {
  pts:["Sayı", p=>p.pts/p.gp, v=>v.toFixed(1)], reb:["Ribaund", p=>p.reb/p.gp, v=>v.toFixed(1)], ast:["Asist", p=>p.ast/p.gp, v=>v.toFixed(1)],
  stl:["Top çalma", p=>(p.stl||0)/p.gp, v=>v.toFixed(1)], blk:["Blok", p=>(p.blk||0)/p.gp, v=>v.toFixed(1)],
  eff:["Verimlilik", p=>(p.pts+p.reb+p.ast+(p.stl||0)+(p.blk||0)-((p.fga||0)-(p.fgm||0)))/p.gp, v=>v.toFixed(1)],
  fg:["Saha içi %", p=>(p.fga||0)>=5*p.gp ? p.fgm/p.fga*100 : null, v=>"%"+v.toFixed(1)], tp:["Üçlük %", p=>(p.tpa||0)>=2*p.gp ? p.tpm/p.tpa*100 : null, v=>"%"+v.toFixed(1)],
  tpm:["Maç başı üçlük", p=>(p.tpm||0)/p.gp, v=>v.toFixed(1)], l5:["Son 5 maç sayı", p=>p.l5?.length ? p.l5.reduce((a,b)=>a+b,0)/p.l5.length : null, v=>v.toFixed(1)], gp:["Maç", p=>p.gp, v=>String(v)],
};
function playersHTML(){
  const D=S.days[S.today], tonight=D?.games.length ? new Set(D.games.flatMap(g=>[g.home.abbr,g.away.abbr])) : new Set();
  // formda olanlar: son 5 maç ortalaması sezon ortalamasından en çok yüksek olanlar (bu gece oynayanlar arasında)
  // kategoriler: sayı, ribaund, asist, verimlilik (sayı + ribaund + asist + top çalma + blok − kaçan şut)
  const FC={pts:["Sayı",x=>x[1],p=>p.pts,12],reb:["Ribaund",x=>x[2],p=>p.reb,5],ast:["Asist",x=>x[3],p=>p.ast,4],
    eff:["Verimlilik",x=>x[1]+x[2]+x[3]+x[4]+x[5]-(x[8]-x[7]),p=>p.pts+p.reb+p.ast+(p.stl||0)+(p.blk||0)-((p.fga||0)-(p.fgm||0)),12]};
  const fc=FC[S.formCat]?S.formCat:"pts", [fl,fLast,fTot,fMin]=FC[fc];
  const ps=Object.entries(S.pstats||{}).filter(([,p])=>p.gp>=3 && (p.lg?.length>=3 || (fc==="pts" && p.l5?.length>=3)));
  const form=ps.map(([id,p])=>{ const lg=(p.lg||[]).slice(-5); const l5 = lg.length>=3 ? lg.reduce((a,x)=>a+fLast(x),0)/lg.length : p.l5.reduce((a,b)=>a+b,0)/p.l5.length;
      return {id,p,avg:fTot(p)/p.gp,l5}; }).map(x=>({...x,d:x.l5-x.avg}))
    .filter(x=>!tonight.size || tonight.has(x.p.t)).filter(x=>x.l5>=fMin).sort((a,b)=>b.d-a.d).slice(0,6);
  const fchips=`<div class="chips fm-cat">${Object.entries(FC).map(([k,[l]])=>`<button class="chip" data-fcat="${k}" aria-pressed="${k===fc}">${l}</button>`).join("")}</div>`;
  const formHTML = form.length ? `<div class="sec-title"><h2 style="font-size:20px">Formda olanlar</h2><span class="aside">${tonight.size?"bu gece oynayanlar":"son 5 maç"}</span></div>${fchips}<div class="form-list">${form.map(x=>`<button class="fm" data-ath="${x.id}"><img src="${FACE(x.id)}" alt="" loading="lazy"><b>${esc(surname(x.p.n))}</b><small>${esc(x.p.t)}</small><em class="tnum">${x.l5.toFixed(1)}</em><span class="fm-d">▲ ${x.d.toFixed(1)}</span></button>`).join("")}</div><small class="muted">Son 5 maçtaki ${fl.toLocaleLowerCase("tr")} ortalaması; ▲ sezon ortalamasından ne kadar yüksek olduğu.${fc==="eff"?" Verimlilik: sayı + ribaund + asist + top çalma + blok − kaçan şut.":""}</small>` : fchips+emptyBox("filter", "Bu kategoride şu an öne çıkan oyuncu yok.");
  const f=S.nba, teams=(ALLP?.teams||[]).slice().sort((a,b)=>a.n.localeCompare(b.n,"tr"));
  return `${formHTML}<button class="btn" id="pcmpBtn" type="button" style="width:100%;margin-top:14px">⚖️ İki oyuncuyu karşılaştır</button><div class="sec-title"><h2 style="font-size:20px">Oyuncu ara</h2></div>
    <div class="ps-f">
      <label class="ps-sel"><span>Sırala</span><select id="psSort">${Object.entries(PS_STATS).map(([k,[l]])=>`<option value="${k}" ${k===(f.sort||"pts")?"selected":""}>${l}</option>`).join("")}</select></label>
      <label class="ps-sel"><span>Takım</span><select id="psTeam"><option value="">Bütün takımlar</option>${teams.map(t=>`<option value="${t.a}" ${t.a===f.team?"selected":""}>${esc(t.n)}</option>`).join("")}</select></label>
    </div>
    <div class="chips ps-c">${[["","Hepsi"],["E","Doğu"],["W","Batı"]].map(([k,l])=>`<button class="chip" data-pconf="${k}" aria-pressed="${(f.conf||"")===k}">${l}</button>`).join("")}
      <button class="chip" data-prook="1" aria-pressed="${!!f.rookie}">Çaylaklar</button><button class="chip" data-ntonight="1" aria-pressed="${!!f.tonight}">Bu gece oynayanlar</button></div>
    <input class="search" id="nbaSearch" placeholder="Oyuncu adı yaz (ör. Curry)" autocomplete="off" value="${esc(S.nba.q)}"><div id="nbaPl" class="pl-list"></div>`;
}
function bindPlayerSearch(){
  const D=S.days[S.today], tonight=new Set((D?.games||[]).flatMap(g=>[g.home.abbr,g.away.abbr]));
  const k=PS_STATS[S.nba.sort]?S.nba.sort:"pts", [lab,fv,fm]=PS_STATS[k];
  const paint=()=>{ const q=slug(S.nba.q||""); let list=(ALLP?.players||[]).map(p=>{ const st=S.pstats?.[p.id]; return {...p, v: st&&st.gp ? fv(st) : null}; });
    if(S.nba.tonight) list=list.filter(p=>tonight.has(p.t));
    if(S.nba.team) list=list.filter(p=>p.t===S.nba.team);
    if(S.nba.conf) list=list.filter(p=>confOf(p.t)===S.nba.conf);
    if(S.nba.rookie) list=list.filter(p=>p.r);
    if(q) list=list.filter(p=>slug(p.n).includes(q));
    list.sort((a,b)=>(b.v??-1)-(a.v??-1)); list=list.slice(0, q||S.nba.team?60:30);
    $("#nbaPl").innerHTML = list.length ? list.map((p,n)=>`<button class="plr" data-ath="${p.id}"><span class="ps-n">${n+1}</span><img src="${FACE(p.id)}" alt="" loading="lazy"><span class="pi"><b>${esc(p.n)}${injBadge(p.id)}</b><small>${esc(p.t)}${p.r?" · çaylak":""}</small></span><span class="ppg">${p.v!=null?fm(p.v):"–"}<small>${esc(lab.toLocaleLowerCase("tr"))}</small></span></button>`).join("") : emptyBox("filter","Filtreleri ya da aramayı değiştirmeyi dene.","Bu filtrelerde oyuncu yok"); };
  $("#nbaSearch").oninput=e=>{ S.nba.q=e.target.value; paint(); };
  $("#psSort").onchange=e=>{ S.nba.sort=e.target.value; renderNBA(); };
  $("#psTeam").onchange=e=>{ S.nba.team=e.target.value; renderNBA(); };
  if(!S.inj) loadInj().then(()=>{ if($("#nbaPl")) paint(); }).catch(()=>{});
  paint();
}
// Oyuncu kartı: sezon ortalamaları, son 5 maç, sıradaki maç
// İki oyuncuyu yan yana koy (sezon istatistikleri, son 5 maç, sakatlık)
function openCompare(a, b){
  S.cmp=[a,b||null];
  if(!b){ openSheet(`<h3 id="shTitle">Karşılaştır</h3><p class="muted">${esc((ALLP?.players||[]).find(x=>x.id===a)?.n||"")} kiminle karşılaştırılsın?</p>
      <input class="search" id="cmpQ" placeholder="Oyuncu adı yaz" autocomplete="off"><div id="cmpL" class="pl-list"></div>`);
    const paint=()=>{ const q=slug($("#cmpQ").value||""); let l=(ALLP?.players||[]).filter(p=>p.id!==a && S.pstats?.[p.id]?.gp); if(q) l=l.filter(p=>slug(p.n).includes(q));
      l=l.map(p=>({...p, v:ppg(p.id)??-1})).sort((x,y)=>y.v-x.v).slice(0,30);
      $("#cmpL").innerHTML=l.map(p=>`<button class="plr" data-cmp="${p.id}"><img src="${FACE(p.id)}" alt="" loading="lazy"><span class="pi"><b>${esc(p.n)}</b><small>${esc(p.t)}</small></span><span class="ppg">${p.v>=0?p.v.toFixed(1):"–"}<small>sayı</small></span></button>`).join(""); };
    $("#cmpQ").oninput=paint; $("#cmpL").onclick=e=>{ const x=e.target.closest("[data-cmp]"); if(x) openCompare(a, x.dataset.cmp); }; paint(); $("#cmpQ").focus(); return; }
  const P=id=>{ const q=(ALLP?.players||[]).find(x=>x.id===id)||{}, s=S.pstats?.[id]||{}, g=s.gp||0;
    return {id, n:q.n||s.n||"?", t:q.t||s.t||"", gp:g, pts:g?s.pts/g:null, reb:g?s.reb/g:null, ast:g?s.ast/g:null, stl:g?(s.stl||0)/g:null, blk:g?(s.blk||0)/g:null,
      fg:s.fga?s.fgm/s.fga*100:null, tp:s.tpa?s.tpm/s.tpa*100:null, l5:s.l5||[]}; };
  const A=P(a), B=P(b), rows=[["Sayı","pts"],["Ribaund","reb"],["Asist","ast"],["Top çalma","stl"],["Blok","blk"],["İsabet %","fg"],["Üçlük %","tp"],["Maç","gp"]];
  const cell=(x,y,k)=>{ const v=x[k], o=y[k]; const win=v!=null && o!=null && v>o; return `<span class="${win?"win":""}">${v==null?"–":k==="gp"?v:v.toFixed(1)}</span>`; };
  const head=x=>`<div class="cmp-p" data-ath="${x.id}"><img src="${FACE(x.id)}" alt=""><b>${esc(x.n)}</b><small>${esc(x.t)}</small>${injTxt(x.id)}</div>`;
  openSheet(`<h3 id="shTitle">Karşılaştırma</h3><div class="cmp-h">${head(A)}<span class="rv-vs">VS</span>${head(B)}</div>
    <div class="cmp-g">${rows.map(([l,k])=>`${cell(A,B,k)}<small>${l}</small>${cell(B,A,k)}`).join("")}</div>
    <div class="row-lbl">Son 5 maçta sayı</div><div class="cmp-l5"><span>${A.l5.join(" · ")||"–"}</span><span>${B.l5.join(" · ")||"–"}</span></div>
    <small class="muted">Bu sezon, maç başına ortalama. Kaynak: biten maçların kutu skorları.</small>
    <button class="btn" id="cmpOther" type="button" style="width:100%;margin-top:10px">Başka biriyle karşılaştır</button>`);
  if(!S.inj) loadInj().then(()=>{ if(S.cmp?.[1]===b) openCompare(a,b); });
  $("#cmpOther").onclick=()=>openCompare(a);
}
async function openAthlete(id, hint={}){
  await allPlayers().catch(()=>{});
  const f=(ALLP?.players||[]).find(x=>x.id===id); const p = f || (hint.n ? {n:hint.n, t:hint.t||""} : null);
  openSheet(`<div class="pc-cover photo" style="--pc:${tcol(p?.t||"")};--cv:url('https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=600&h=438&scale=crop&cquality=75')">${p?.t?`<img class="pc-tlogo" src="${LOGO_SMALL(p.t)}" alt="">`:""}</div><div class="pc-head on-cover"><div><h3 id="shTitle" style="margin:0">${esc(p?.n||"Oyuncu")}</h3><small class="muted">${esc(p?.t||"")}</small></div><button class="btn sm" id="athCmp" type="button">Karşılaştır</button></div><div id="athBody"><p class="muted">Yükleniyor…</p></div>`);
  $("#athCmp").onclick=()=>openCompare(id);
  try{
    const [ov, gl]=await Promise.all([cached("ov_"+id, `${WEB}/common/v3/sports/basketball/nba/athletes/${id}/overview`, 30*60e3), gamelogOf(id).catch(()=>null)]);
    if(!$("#athBody")) return;
    const L={GP:"Maç",MIN:"Dk",PTS:"Sayı",REB:"Rib",AST:"Ast",STL:"Top çalma",BLK:"Blok","FG%":"İsabet %","3P%":"Üçlük %","FT%":"Serbest %",TO:"Top kaybı",PF:"Faul"};
    const lab=ov.statistics?.labels||[], sp=ov.statistics?.splits||[];
    const reg=sp.find(x=>/regular/i.test(x.displayName))||sp[0], car=sp.find(x=>/career/i.test(x.displayName));
    const pick=["PTS","REB","AST","FG%","3P%","STL","BLK","MIN","GP"];
    const kp = reg ? `<div class="cards2 ath-k">${pick.filter(k=>lab.includes(k)).map(k=>`<div class="kpi"><b>${reg.stats[lab.indexOf(k)]}</b><small>${L[k]||k}${car?` · Kariyer ${car.stats[lab.indexOf(k)]}`:""}</small></div>`).join("")}</div>` : `<div class="note">Bu sezon henüz maçı yok.</div>`;
    let last="";
    if(gl){ const evs=(gl.seasonTypes?.[0]?.categories||[]).flatMap(c=>c.events||[]).slice(0,10); const nm=gl.names||[];
      const ix=k=>nm.indexOf(k);
      const pts=evs.map(e=>+e.stats[nm.indexOf("points")]||0).reverse(), mx=Math.max(1,...pts);
      const spark = pts.length>1 ? `<div class="ath-bars">${pts.map((v,k)=>`<span title="${v}"><i style="height:${Math.max(4,v/mx*100)}%"></i><small>${v}</small></span>`).join("")}</div>` : "";
      last = evs.length ? `<div class="sec-title"><h2 style="font-size:20px">Son ${evs.length} maç</h2><span class="aside">sayılar, eskiden yeniye</span></div>${spark}<div class="ath-gl"><div class="agl-h"><span>Rakip</span><span>Skor</span><span>Sayı</span><span>Rib</span><span>Ast</span><span>Dk</span></div>${evs.map(e=>{ const m=gl.events?.[e.eventId]||{};
        return `<div class="agl-r"><span>${esc(m.atVs||"")} <img src="${LOGO_SMALL(m.opponent?.abbreviation||"")}" alt="">${esc(m.opponent?.abbreviation||"")}</span><span class="${m.gameResult==="W"?"w":"l"}">${m.gameResult==="W"?"G":"M"} ${esc(m.score||"")}</span><b>${e.stats[ix("points")]}</b><span>${e.stats[ix("totalRebounds")]}</span><span>${e.stats[ix("assists")]}</span><span>${e.stats[ix("minutes")]}</span></div>`; }).join("")}</div>` : "";
    }
    const ng=ov.nextGame?.events?.[0] || ov.nextGame;
    const next = ng?.date ? `<div class="note">Sıradaki maç: ${new Date(ng.date).toLocaleString(LOC,{timeZone:TZ,weekday:"long",day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"})}</div>` : "";
    // ligde bu oyuncu: skorer ve günün oyuncusu seçimleri
    let asSc=0, scOk=0; for(const row of Object.values(S.arch.scores.games||{})) for(const r of Object.values(row)){ if(r.pick?.s && r.pick.s===(p?.n||"")){ asSc++; if(r.s>0) scOk++; } }
    const league = asSc ? `<div class="box ath-lg"><b>${asSc}</b> kez skorer olarak seçildi, <b>${scOk}</b> kez tuttu.</div>` : "";
    await loadInj().catch(()=>{}); const ij=S.inj?.[id];
    const injLine = ij ? `<div class="box ath-inj ${ij.o?"out":""}">${injBadge(id)} ${ij.c?esc(ij.c):""}</div>` : "";
    $("#athBody").innerHTML = `${injLine}<div class="sec-title"><h2 style="font-size:20px">Bu sezon</h2><span class="aside">maç başına ortalama</span></div>${kp}${last}${league?`<div class="sec-title"><h2 style="font-size:20px">Ligde</h2></div>${league}`:""}${next}<small class="muted">Kaynak: ESPN.</small>`;
  }catch(e){ if($("#athBody")) $("#athBody").innerHTML=`<div class="note">Bilgilere şu an ulaşılamıyor.</div>`; }
}
document.addEventListener("click", e=>{ const a=e.target.closest("[data-ath]"); if(a){ e.stopPropagation(); openAthlete(a.dataset.ath, {n:a.dataset.athn, t:a.dataset.atht}); } });
$("#nba")?.addEventListener("click", e=>{
  const s1=e.target.closest("[data-nsub]"); if(s1){ S.nba.sub=s1.dataset.nsub; lsSet("nbaSub", S.nba.sub); scrollTo({top:Math.min(scrollY, $("#nba").getBoundingClientRect().top+scrollY-70)}); return renderNBA(); }
  const v=e.target.closest("[data-nview]"); if(v){ S.nba.view=v.dataset.nview; return renderNBA(); }
  const c=e.target.closest("[data-ncat]"); if(c){ S.nba.cat=c.dataset.ncat; return renderNBA(); }
  const t=e.target.closest("[data-ntonight]");
  if(t){ const D=S.days[S.today];
    if(!S.nba.tonight && !D?.games.length){ openSheet(`<h3 id="shTitle">Bu gece maç yok</h3><p>Bu gece NBA'de maç oynanmıyor, o yüzden "Bu gece oynayanlar" listesi boş olurdu. Liste bütün oyuncuları göstermeye devam ediyor.</p><button class="btn-primary" type="button" onclick="document.getElementById('shClose').click()">Tamam</button>`); return; }
    S.nba.tonight=!S.nba.tonight; return renderNBA(); }
  const pc=e.target.closest("[data-pconf]"); if(pc){ S.nba.conf=pc.dataset.pconf; return renderNBA(); }
  const pr=e.target.closest("[data-prook]"); if(pr){ S.nba.rookie=!S.nba.rookie; return renderNBA(); }
});

/* ====================================================== Uzun vadeli tahminler (haftanın, ayın oyuncusu, sezon ödülleri) */
// Kilitler kurallarla aynı: hafta = pazartesi + 71 saat (çarşamba 23.00 UTC, TR 02.00), ay = ayın 15'i 17.00 UTC (TR 20.00),
// NBA Kupası = 4 Aralık 17.00 UTC (çeyrek finallerden önce), sezon = 15 Ocak 2027 17.00 UTC.
const EAST = new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DET","IND","MIA","MIL","NY","ORL","PHI","TOR","WSH"]);
const LT_CATS = {
  w: [["e","Haftanın oyuncusu · Doğu",2,"E"],["w","Haftanın oyuncusu · Batı",2,"W"]],
  m: [["pe","Ayın oyuncusu · Doğu",4,"E"],["pw","Ayın oyuncusu · Batı",4,"W"],["re","Ayın çaylağı · Doğu",3,"E"],["rw","Ayın çaylağı · Batı",3,"W"],["de","Ayın savunmacısı · Doğu",3,"E"],["dw","Ayın savunmacısı · Batı",3,"W"]],
  k: [1,2,3,4,5,6].flatMap(i=>[["e"+i,`Doğu ${i}.`,2,"TE"],["w"+i,`Batı ${i}.`,2,"TW"]]).sort((a,b)=>a[0].localeCompare(b[0])),
  c: [["cw","NBA Kupası şampiyonu",8,"T"],["cfe","Kupa finalisti · Doğu",3,"TE"],["cfw","Kupa finalisti · Batı",3,"TW"],["cmvp","NBA Kupası MVP'si",6,""]],
  s: [["mvp","Most Valuable Player (MVP)",12,""],["roy","Rookie of the Year",8,""],["dpoy","Defensive Player of the Year",8,""],["mip","Most Improved Player",8,""],["smoy","Sixth Man of the Year",8,""],["coy","Coach of the Year (takımı seç)",8,"T"],
      ["champ","NBA Champion",10,"T"],["fe","Eastern Conference Champion",5,"TE"],["fw","Western Conference Champion",5,"TW"]],
};
const LT_SWAP_END = Date.UTC(2027,2,1);
const ltType = k => k[0];
function ltLock(k){
  if(k[0]==="w") return Date.UTC(+k.slice(2,6), +k.slice(6,8)-1, +k.slice(8,10)) + 71*36e5;
  if(k[0]==="m") return Date.UTC(+k.slice(2,6), +k.slice(6,8)-1, 15) + 17*36e5;
  if(k[0]==="c") return Date.UTC(2026,11,4) + 17*36e5;
  if(k[0]==="k") return Date.UTC(2026,11,1) + 17*36e5;
  return Date.UTC(2027,0,15) + 17*36e5;
}
const MONTHS_TR=["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
function ltTitle(k){
  if(k[0]==="w"){ const a=k.slice(2), b=shiftDay(a,6); return `Haftanın oyuncusu · ${dayNice(a,{day:"numeric",month:"short"})}–${dayNice(b,{day:"numeric",month:"short"})}`; }
  if(k[0]==="m"){ const m=+k.slice(6,8); return `Ayın ödülleri · ${m===11 && k.startsWith("m_2026")?"Ekim-Kasım":MONTHS_TR[m-1]}`; }
  if(k[0]==="c") return "NBA Kupası 2026";
  if(k[0]==="k") return "Konferans sıralaması";
  return "Sezon ödülleri 2026-27";
}
// Gösterilecek turlar: bu hafta, geçen hafta, bu ay, geçen ay, sezon
function ltRounds(){
  const wk=weekKey(S.today);
  const mk=(y,m)=> (y===2026 && (m===10||m===11)) ? "m_202611" : `m_${y}${String(m).padStart(2,"0")}`;
  const y=+S.today.slice(0,4), m=+S.today.slice(4,6), pm=m===1?[y-1,12]:[y,m-1];
  const keys=["w_"+wk, "w_"+shiftDay(wk,-7), mk(y,m), mk(...pm), "c_2026", "s_2027"];
  return [...new Set(keys)].filter(k=>k>="w_20261102" || k[0]!=="w").filter(k=>k!=="m_202610");
}
S.lt = {mine:{}, all:{}, res:{}, loaded:false};
const ltRef = (k,u) => doc(S.db,"lt",`${k}_${u}`);
async function loadLT(){
  try{ const snap=await getDocs(collection(S.db,"ltResults")); S.lt.res={}; snap.forEach(x=>{ S.lt.res[x.id]=x.data(); }); }catch(e){}
  const keys=[...new Set([...ltRounds(), ...Object.keys(S.lt.res)])];
  const jobs=[];
  for(const k of keys) for(const u of S.order){
    if(u!==S.uid && Date.now()<ltLock(k)) continue;
    jobs.push(getDoc(ltRef(k,u)).then(x=>{ (S.lt.all[k] ||= {})[u] = x.exists() ? x.data() : null; }).catch(()=>{}));
  }
  await Promise.all(jobs); S.lt.loaded=true;
  render(); ltNudge();
}
// Kilide 24 saatten az kalmış ve eksik seçimi olan tur varsa her açılışta bir kez hatırlat
function ltNudge(){
  if(!S.uid || !S.lt.loaded) return;
  const due=ltRounds().filter(k=>{ const ms=ltLock(k)-Date.now(); if(ms<=0 || ms>24*36e5) return false;
    const d=S.lt.all[k]?.[S.uid]; return LT_CATS[ltType(k)].some(([c])=>!d?.picks?.[c]); });
  if(!due.length) return;
  const flag="ltNudge_"+due.join(","); try{ if(sessionStorage.getItem(flag)) return; }catch(e){}
  const tryOpen=(n=0)=>{
    if(!$("#sheet").classList.contains("hide") || S.onboard){ if(n<24) setTimeout(()=>tryOpen(n+1), 5000); return; }
    try{ sessionStorage.setItem(flag,"1"); }catch(e){}
    openSheet(`<div class="ltn-ico">${ICON.cup}</div><h3 id="shTitle" style="text-align:center">Uzun vade kilitleniyor</h3>
      <p class="muted" style="text-align:center">Kilitten sonra seçim yapılamaz. Eksiklerini şimdi tamamla.</p>
      <div class="lt-card">${due.map(k=>{ const ms=ltLock(k)-Date.now(), h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4), d=S.lt.all[k]?.[S.uid], cats=LT_CATS[ltType(k)], n=cats.filter(([c])=>d?.picks?.[c]).length;
        return `<button class="lt-r open" data-ltn2="${k}"><span class="lt-t"><b>${ltTitle(k)}</b><small>Kilide ${h?h+" sa ":""}${m} dk · ${n}/${cats.length} seçim</small></span><span class="lt-n">${n}/${cats.length}</span><span class="lt-go">${ICON.chev}</span></button>`; }).join("")}</div>
      <button class="btn" id="ltnLater" type="button" style="width:100%;margin-top:10px">Sonra</button>`);
    $("#sheet .lt-card").onclick=e=>{ const b=e.target.closest("[data-ltn2]"); if(b) allPlayers().catch(()=>{}).then(()=>openLT(b.dataset.ltn2)); };
    $("#ltnLater").onclick=()=>closeSheet();
  };
  setTimeout(tryOpen, 2500);
}
function ltCatPts(k, r, c, mine, sw, p){
  if(!r?.[c] || !mine) return 0;
  if(k[0]==="k"){ const slot=Object.keys(r).find(x=>x[0]===c[0] && /^[ew]\d+$/.test(x) && String(r[x])===String(mine)); if(!slot) return 0;
    const d=Math.abs(+slot.slice(1) - +c.slice(1)); return d===0 ? p : d===1 ? 1 : 0; }
  return String(mine)===String(r[c]) ? (sw ? Math.floor(p/2) : p) : 0;
}
// Bir oyuncunun uzun vadeden puanı (sonuçlanmış turlar)
function ltPoints(u){
  let t=0;
  for(const [k,r] of Object.entries(S.lt.res)){
    if(!ltInLeague(k)) continue;
    const d=S.lt.all[k]?.[u]; if(!d?.picks) continue;
    for(const [c,,p] of LT_CATS[ltType(k)]||[]){
      if(!r[c]) continue;
      const sw=d.swaps?.[c]; const mine = sw ? sw.to : d.picks[c];
      t += ltCatPts(k, r, c, mine, sw, p);
    }
  }
  return t;
}
function ltStatus(k){
  const lock=ltLock(k), res=S.lt.res[k], open=Date.now()<lock;
  if(open){ const ms=lock-Date.now(), d=Math.floor(ms/864e5), h=Math.floor(ms%864e5/36e5); return {open, txt:`Kilide ${d?d+" gün ":""}${h} sa`}; }
  if(res && LT_CATS[ltType(k)].every(([c])=>res[c])) return {open, done:true, txt:"Sonuçlandı"};
  return {open, txt: res ? "Kısmen sonuçlandı" : "Kilitlendi · sonuç bekleniyor"};
}
function ltCardHTML(){
  const rows=ltRounds().map(k=>{
    const st=ltStatus(k), d=S.lt.all[k]?.[S.uid], cats=LT_CATS[ltType(k)], n=cats.filter(([c])=>d?.picks?.[c]).length;
    let right = st.open ? `<span class="lt-n ${n===cats.length?"ok":""}">${n}/${cats.length}</span>` : "";
    if(!st.open && S.lt.res[k]){ let p=0; const r=S.lt.res[k]; for(const [c,,pt] of cats){ const sw=d?.swaps?.[c]; const mine=sw?sw.to:d?.picks?.[c]; p+=ltCatPts(k, r, c, mine, sw, pt); } right=`<span class="lt-p ${p?"pos":""}">+${p}</span>`; }
    return `<button class="lt-r ${st.open?"open":""}" data-lt="${k}"><span class="lt-t"><b>${ltTitle(k)}</b><small>${st.txt}</small></span>${right}<span class="lt-go">${ICON.chev}</span></button>`; }).join("");
  return `<div class="lt-card">${rows}</div>`;
}
function renderUzun(){
  const el=$("#uzun"); if(!el) return;
  if(!S.uid){ el.innerHTML=`<div class="note">Uzun vade tahminleri için giriş yap.</div>`; return; }
  const tot=S.order.map(u=>[u, S.lt.loaded?ltPoints(u):0]).sort((a,b)=>b[1]-a[1]);
  el.innerHTML = `<div class="sec-title"><h2>Uzun vade</h2><span class="aside">puanlar sıralamaya eklenir</span></div>
    ${S.lt.loaded ? ltCardHTML() : `<div class="note">Yükleniyor…</div>`}
    <div class="sec-title"><h2>Uzun vade puanları</h2></div>
    <div class="lt-card">${tot.map(([u,p])=>`<div class="lt-r" style="cursor:default"><span class="lt-t"><b style="color:${col(u)}">${esc(pname(u))}</b></span><span class="lt-p ${p?"pos":""}">${p}</span></div>`).join("")}</div>
    <div class="note" style="margin-top:14px"><b>Nasıl oynanır?</b><br>
    · Haftanın oyuncusu (Doğu ve Batı): çarşamba gecesi kilitlenir, doğru tahmin +2.<br>
    · Ayın oyuncusu +4, ayın çaylağı +3, ayın savunmacısı +3 (Doğu ve Batı ayrı): her ayın 15'inde 20.00'de kilitlenir. İlk tur Ekim-Kasım.<br>
    · NBA Kupası: şampiyon takım +8, Doğu ve Batı finalisti +3'er, kupanın MVP'si +6. 4 Aralık 20.00'de, çeyrek finallerden önce kilitlenir.<br>
    · Sezon ödülleri: Most Valuable Player +12; Rookie of the Year, Defensive Player of the Year, Most Improved Player, Sixth Man of the Year ve Coach of the Year +8; NBA Champion +10; Eastern ve Western Conference Champion +5'er. 15 Ocak 20.00'de kilitlenir.<br>
    · Seçtiğin oyuncu 65 maç kuralına takılırsa 1 Mart'a kadar bir kere değiştirebilirsin; değişen seçim puanın yarısını alır.<br>
    · Seçimler kilitten sonra herkese açılır.</div>`;
}
const confOf = abbr => EAST.has(abbr) ? "E" : "W";
function ltName(d, c){ return d?.names?.[c] || ""; }
S.ltDraft = {};
function openLT(k){ if(!S.inj) loadInj().then(()=>{ if($("#ltBox") && !S.ltCat) paintLT(); }); S.ltKey=k; S.ltDraft={...(S.lt.all[k]?.[S.uid]?.picks||{})}; S.ltNames={...(S.lt.all[k]?.[S.uid]?.names||{})}; S.ltCat=null; openSheet(`<div id="ltBox"></div>`); paintLT(); }
function paintLT(){
  const box=$("#ltBox"); if(!box) return;
  const k=S.ltKey, st=ltStatus(k), cats=LT_CATS[ltType(k)], res=S.lt.res[k]||{}, mine=S.lt.all[k]?.[S.uid];
  let h=`<h3 id="shTitle">${ltTitle(k)}</h3><p class="muted">${st.open?`Kilit: ${new Date(ltLock(k)).toLocaleString(LOC,{timeZone:TZ,day:"numeric",month:"long",weekday:"long",hour:"2-digit",minute:"2-digit"})}. O zamana kadar değiştirebilirsin; seçimler kilitten sonra herkese açılır.`:st.txt}</p>`;
  if(st.open){
    if(S.ltCat){ h += ltPicker(k, S.ltCat); box.innerHTML=h; bindLTPicker(); return; }
    h += `<div class="lt-cats">${cats.map(([c,l,p,cf])=>{ const v=S.ltDraft[c], nm=S.ltNames[c];
      return `<button class="lt-c" data-ltc="${c}"><span class="lt-cl"><small>${l} · +${p}</small><b>${v?esc(nm||v):'<span class="muted">Seç</span>'}</b>${v && cf[0]!=="T" ? ltMini(v,k,/^d/.test(c)) : ""}</span>${v?(cf[0]==="T"?`<img class="lt-img logo" src="${LOGO_SMALL(v)}" alt="">`:`<img class="lt-img" src="${FACE(v)}" alt="">`):""}</button>`; }).join("")}</div>
      <button class="btn-primary" id="ltSave" type="button" style="margin-top:12px">Kaydet</button><small class="muted" id="ltMsg"></small>`;
    box.innerHTML=h;
    box.querySelector(".lt-cats").onclick=e=>{ const b=e.target.closest("[data-ltc]"); if(b){ S.ltCat=b.dataset.ltc; paintLT(); } };
    $("#ltSave").onclick=saveLT;
    return;
  }
  // kilitli: herkesin seçimleri
  const swapOk = ltType(k)==="s" && Date.now()<LT_SWAP_END;
  h += cats.map(([c,l,p,cf])=>{
    const rows=S.order.map(u=>{ const d=S.lt.all[k]?.[u]; const sw=d?.swaps?.[c]; const v=sw?sw.to:d?.picks?.[c]; const nm=sw?sw.toName:ltName(d,c);
      const got = ltCatPts(k, res, c, v, sw, p);
      return `<div class="lt-u"><span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span><span>${v?esc(nm||v):'<span class="muted">seçmedi</span>'}${sw?' <small class="muted">(değiştirdi)</small>':""}</span>${res[c]?`<b class="${got?"ok":"no"}">${got?"+"+got:"0"}</b>`:""}</div>`; }).join("");
    const myv=mine?.picks?.[c], canSwap = swapOk && c!=="coy" && myv && !mine?.swaps?.[c] && (S.ltInelig?.[myv] || S.lt.res.s_2027?.inelig?.[myv]);
    return `<div class="lt-sec"><div class="lt-sh"><b>${l}</b><small>+${p}</small>${res[c]?`<span class="lt-win">Kazanan: ${esc(res.names?.[c]||res[c])}</span>`:""}</div>${rows}
      ${canSwap?`<div class="lt-swap"><span>Seçtiğin oyuncu 65 maç kuralı yüzünden aday olamıyor. Bir kerelik tercihini değiştirebilirsin (puanın yarısı).</span><button class="btn sm" data-swap="${c}">Değiştir</button></div>`:""}</div>`; }).join("");
  box.innerHTML=h;
  box.onclick=e=>{ const b=e.target.closest("[data-swap]"); if(b){ S.ltCat=b.dataset.swap; S.ltSwap=true; box.innerHTML=`<h3 id="shTitle">Tercihini değiştir</h3>`+ltPicker(k,S.ltCat); bindLTPicker(); } };
  if(ltType(k)==="s") checkInelig(k);
}
// Turun tarih aralığı: hafta = pazartesi-pazar, ay = o ay (Ekim-Kasım turu sezon başından), sezon = hepsi
function ltRange(k){
  if(k[0]==="w"){ const a=k.slice(2); return [a, shiftDay(a,6), "bu hafta"]; }
  if(k[0]==="m"){ const y=k.slice(2,6), m=k.slice(6,8); const last=String(new Date(Date.UTC(+y,+m,0)).getUTCDate());
    return k==="m_202611" ? [S.cfg?.seasonStart||"20261020", "20261130", "sezon başından"] : [y+m+"01", y+m+last, "bu ay"]; }
  if(k[0]==="c") return ["20261030","20261220","Kupa"];
  return ["00000000","99999999","sezon"];
}
// Oyuncunun aralıktaki maçları (sync'in tuttuğu son 16 maç), yoksa sezon ortalaması
function ltPStat(id, k){
  const ps=S.pstats?.[id]; if(!ps) return null;
  const [a,b,lab]=ltRange(k);
  if(k[0]!=="s" && k[0]!=="c" && ps.lg){ const g=ps.lg.filter(x=>x[0]>=a && x[0]<=b);
    if(g.length){ const sum=i=>g.reduce((t,x)=>t+(x[i]||0),0), n=g.length; return {lab, gp:n, pts:sum(1)/n, reb:sum(2)/n, ast:sum(3)/n, stl:sum(4)/n, blk:sum(5)/n, w:sum(6), l:n-sum(6),
      fg:sum(8)?sum(7)/sum(8):null, tp:sum(10)?sum(9)/sum(10):null}; } }
  if(!ps.gp) return null;
  return {lab:"sezon", gp:ps.gp, pts:ps.pts/ps.gp, reb:ps.reb/ps.gp, ast:ps.ast/ps.gp, stl:(ps.stl||0)/ps.gp, blk:(ps.blk||0)/ps.gp, season:true,
    fg:ps.fga?ps.fgm/ps.fga:null, tp:ps.tpa?ps.tpm/ps.tpa:null};
}
// Takımın aralıktaki galibiyet-mağlubiyeti (biten maç arşivinden)
function ltTeamWL(abbr, k){
  const [a,b]=ltRange(k); let w=0,l=0;
  for(const g of Object.values(S.arch.games||{})){ if(!g.day || g.day<a || g.day>b || (k[0]==="c" && !g.cup)) continue; if(g.home?.abbr!==abbr && g.away?.abbr!==abbr) continue; if(g.winner===abbr) w++; else l++; }
  return {w,l};
}
const f1 = v => (Math.round(v*10)/10).toFixed(1);
const INJ_PART={Knee:"Diz",Ankle:"Ayak bileği",Foot:"Ayak",Hamstring:"Arka adale",Calf:"Baldır",Back:"Bel",Hip:"Kalça",Shoulder:"Omuz",Wrist:"El bileği",Hand:"El",Finger:"Parmak",Groin:"Kasık",Achilles:"Aşil",Elbow:"Dirsek",Illness:"Hastalık",Concussion:"Beyin sarsıntısı",Thigh:"Uyluk",Toe:"Ayak parmağı",Rest:"Dinlenme",Personal:"Kişisel",Neck:"Boyun",Abdomen:"Karın",Quadriceps:"Ön adale",Leg:"Bacak",Chest:"Göğüs",Face:"Yüz",Eye:"Göz",Shin:"Kaval kemiği",Oblique:"Yan karın",Rib:"Kaburga",Head:"Baş",Nose:"Burun",Heel:"Topuk"};
function injTxt(id){ const i=S.inj?.[id]; if(!i || !i.s) return "";
  const r=i.r ? " · "+dayNice(i.r.replace(/-/g,""),{day:"numeric",month:"short"})+" dönüş" : "";
  return `<span class="inj ${i.s==="Oynamıyor"||i.s==="Cezalı"?"out":""}">${esc(i.s)}${i.y?" · "+esc(INJ_PART[i.y]||i.y):""}${r}</span>`; }
// Sitedeki bütün sakatlık bilgisi buradan gelir (maç kartı, maç önü, takım sayfası, kadro, skorer seçimi, uzun vade).
// ESPN durumu "GTD" olsa bile son 40 saatteki notta "ruled out / will be rested" gibi bir ifade varsa oynamıyor sayılır.
const INJ_OUT_RX = /ruled out|\bis out\b|\bwill be out\b|will not play|won't play|will miss|sitting out|will sit|will be rested|\bout for (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight)/i;
function injRec(i, a){
  const st=i.status||"", recent=i.date && Date.now()-new Date(i.date).getTime() < 40*36e5;
  const o = /^(out|suspension)$/i.test(st) || !!(recent && INJ_OUT_RX.test(i.shortComment||""));
  return {n:a.displayName||"", t:a.team?.abbreviation||"", o, s:/suspension/i.test(st)?"Cezalı":o?"Oynamıyor":"Belirsiz", y:i.details?.type||"", r:i.details?.returnDate||"", c:i.shortComment||"", d:i.date||""};
}
async function loadInj(force=false){
  if(S.inj && !force && Date.now()-(S.injAt||0) < 10*60e3) return S.inj;
  if(loadInj.p) return loadInj.p;
  loadInj.p = (async()=>{
    try{ const d=await getJSON(`${WEB}/site/v2/sports/basketball/nba/injuries`); const out={};
      for(const t of d.injuries||[]) for(const i of t.injuries||[]){ const a=i.athlete||{}; const id=(a.links||[]).map(l=>(l.href||"").match(/\/id\/(\d+)/)?.[1]).find(Boolean); if(id) out[id]=injRec(i,a); }
      S.inj=out; S.injAt=Date.now();
    }catch(e){ if(!S.inj){ try{ const j=await getJSON("data/injuries.json"); S.inj=Object.fromEntries(Object.entries(j).map(([id,x])=>[id,{...x, o:x.s==="Oynamıyor"||x.s==="Cezalı"}])); }catch(e2){ S.inj={}; } S.injAt=Date.now()-8*60e3; } }
    loadInj.p=null; return S.inj; })();
  return loadInj.p;
}
const injOfTeam = abbr => Object.entries(S.inj||{}).filter(([,x])=>x.t===abbr).map(([id,x])=>({id,...x})).sort((a,b)=>b.o-a.o || a.n.localeCompare(b.n));
const injBadge = id => { const i=S.inj?.[id]; return !i ? "" : `<span class="inj ${i.o?"":"q"}">${i.s}</span>`; };
function ltMini(id,k,def){ const st=ltPStat(id,k), p=(ALLP?.players||[]).find(x=>x.id===id), tw=p?ltTeamWL(p.t,k):{w:0,l:0};
  return `<small class="lt-mini">${st?(def?`${f1(st.stl)} çalma · ${f1(st.blk)} blok`:`${f1(st.pts)} sayı · ${f1(st.reb)} rib. · ${f1(st.ast)} ast.`)+` (${st.lab})`:""}${tw.w+tw.l?` · takım ${tw.w}-${tw.l}`:""}</small>${injTxt(id)}`; }
function ltPicker(k, c){
  const [ ,l, ,cf]=LT_CATS[ltType(k)].find(x=>x[0]===c);
  if(cf[0]==="T"){ const teams=(ALLP?.teams||[]).filter(t=>!cf[1] || confOf(t.a)===cf[1]).sort((a,b)=>a.n.localeCompare(b.n,"tr"));
    const taken = k[0]==="k" ? new Set(Object.entries(S.ltDraft||{}).filter(([cc,v])=>cc!==c && v).map(([,v])=>v)) : new Set();
    return `<p><b>${l}</b>${cf[1]?` <small class="muted">(yalnızca ${cf[1]==="E"?"Doğu":"Batı"} takımları)</small>`:""}</p><div class="tm-grid">${teams.map(t=>`<button class="tg" data-ltp="${t.a}" data-ltn="${esc(t.n)}" style="--tc:${tcol(t.a)}" ${taken.has(t.a)?"disabled":""}><span class="tg-l"><img src="${LOGO_SMALL(t.a)}" alt=""></span><b>${esc(t.n.split(" ").slice(-1)[0])}</b><small class="tg-wl">${(w=>w.w+w.l?`${w.w}-${w.l}`:"")(ltTeamWL(t.a,k))}</small></button>`).join("")}</div><p class="muted" style="font-size:12px">${k[0]==="c"?"Galibiyet-mağlubiyet NBA Kupası maçlarında.":"Galibiyet-mağlubiyet sezon başından."}</p><button class="linkish" id="ltBack" type="button">‹ Geri</button>`; }
  return `<p><b>${l}</b>${cf?` <small class="muted">(yalnızca ${cf==="E"?"Doğu":"Batı"} takımlarının oyuncuları${/^r/.test(c)?", çaylaklar":""})</small>`:""}</p>
    <input class="search" id="ltSearch" placeholder="Oyuncu adı yaz" autocomplete="off"><div id="ltList" class="pl-list"></div><button class="linkish" id="ltBack" type="button">‹ Geri</button>`;
}
function bindLTPicker(){
  const k=S.ltKey, c=S.ltCat, cf=LT_CATS[ltType(k)].find(x=>x[0]===c)[3];
  const choose=(id,name)=>{
    if(S.ltSwap){ S.ltSwap=false; return saveSwap(c,id,name); }
    S.ltDraft[c]=id; S.ltNames[c]=name; S.ltCat=null; paintLT(); };
  $("#ltBack").onclick=()=>{ S.ltCat=null; S.ltSwap=false; paintLT(); };
  if(cf[0]==="T"){ $("#ltBox").querySelector(".tm-grid").onclick=e=>{ const b=e.target.closest("[data-ltp]"); if(b) choose(b.dataset.ltp, b.dataset.ltn); }; return; }
  const def = /^d/.test(c) || c==="dpoy", rook = /^r/.test(c) || c==="roy", hasR = (ALLP?.players||[]).some(p=>p.r);
  const paint=()=>{ const q=slug($("#ltSearch").value||"");
    let list=(ALLP?.players||[]).filter(p=>(!cf || confOf(p.t)===cf) && (!rook || !hasR || p.r)).map(p=>{ const st=ltPStat(p.id,k); return {...p, st, key: st ? (def ? st.stl+st.blk+st.reb/10 : st.pts) : -1}; });
    if(q) list=list.filter(p=>slug(p.n).includes(q)); list.sort((a,b)=>b.key-a.key); list=list.slice(0,40);
    $("#ltList").innerHTML=list.map(p=>{ const st=p.st, tw=ltTeamWL(p.t,k);
      const pct = v => v==null ? null : "%"+Math.round(v*100);
      const big = st ? (def ? [["RİB",st.reb],["TÇ",st.stl],["BLK",st.blk]] : [["SAY",st.pts],["RİB",st.reb],["AST",st.ast]]) : [];
      const sm = st ? [def ? `${f1(st.pts)} sayı · ${f1(st.ast)} asist` : `${f1(st.stl)} top çalma · ${f1(st.blk)} blok`, pct(st.fg)&&`${pct(st.fg)} saha içi`, pct(st.tp)&&`${pct(st.tp)} üçlük`, `${st.gp} maç (${st.lab})`].filter(Boolean).join(" · ") : "Bu sezon maçı yok";
      return `<button class="plr lt-pl" data-ltp="${p.id}" data-ltn="${esc(p.n)}"><img src="${FACE(p.id)}" alt="" loading="lazy">
        <span class="pi"><b>${esc(p.n)}</b><small>${esc(p.t)}${tw.w+tw.l?` · <span class="lt-wl">takım ${tw.w}-${tw.l}</span>`:""}</small><small class="lt-sm">${sm}</small>${injTxt(p.id)}</span>
        <span class="lt-big">${big.map(([l,v],x)=>`<span class="${x===0?"lead":""}">${f1(v)}<small>${l}</small></span>`).join("") || "<span>–</span>"}</span></button>`; }).join("") || `<p class="muted">Oyuncu bulunamadı.</p>`; };
  $("#ltSearch").oninput=paint; $("#ltList").onclick=e=>{ const b=e.target.closest("[data-ltp]"); if(b) choose(b.dataset.ltp, b.dataset.ltn); };
  paint(); $("#ltSearch").focus(); if(!S.inj) loadInj().then(()=>{ if($("#ltList")) paint(); });
}
async function saveLT(){
  const k=S.ltKey; if(Date.now()>=ltLock(k)) return toast("Bu tur kilitlendi.");
  const data={uid:S.uid, key:k, picks:{...S.ltDraft}, names:{...S.ltNames}, updatedAt:serverTimestamp()};
  try{ await setDoc(ltRef(k,S.uid), data); (S.lt.all[k] ||= {})[S.uid]={...data}; toast("Uzun vade tahminin kaydedildi."); closeSheet(); render(); }
  catch(e){ $("#ltMsg").textContent="Kaydedilemedi, tekrar dene."; }
}
async function saveSwap(c, id, name){
  const k=S.ltKey, cur=S.lt.all[k]?.[S.uid]; if(!cur) return;
  const swaps={...(cur.swaps||{}), [c]:{from:cur.picks[c], to:id, toName:name}};
  try{ await setDoc(ltRef(k,S.uid), {...cur, swaps, updatedAt:serverTimestamp()}); cur.swaps=swaps; toast("Tercihin değişti."); paintLT(); }
  catch(e){ toast("Değiştirilemedi."); paintLT(); }
}
// 65 maç kuralı: takımın oynadığı maç - oyuncunun oynadığı maç > 17 ise aday olamaz
S.ltInelig = {};
async function checkInelig(k){
  const d=S.lt.all[k]?.[S.uid]; if(!d?.picks || checkInelig.busy) return; checkInelig.busy=true;
  try{ await nbaStandings(); const all=(S.standings||[]).flatMap(c=>c.entries);
    for(const [c,v] of Object.entries(d.picks)){ if(c==="coy" || S.ltInelig[v]!=null) continue;
      const p=(ALLP?.players||[]).find(x=>x.id===v); const e=all.find(x=>x.team.abbreviation===p?.t); if(!e) continue;
      const ov=await cached("ov_"+v, `${WEB}/common/v3/sports/basketball/nba/athletes/${v}/overview`, 60*60e3).catch(()=>null);
      const lab=ov?.statistics?.labels||[], reg=(ov?.statistics?.splits||[]).find(x=>/regular/i.test(x.displayName));
      const gp=reg ? +reg.stats[lab.indexOf("GP")] : 0, tgp=(+stOf(e,"wins")||0)+(+stOf(e,"losses")||0);
      S.ltInelig[v] = (tgp-gp) > 17; }
  }catch(e){}
  checkInelig.busy=false; if($("#ltBox") && S.ltKey===k && !S.ltCat) paintLT();
}
// Yönetim: sonuç girme
function openLTAdmin(){
  const keys=[...new Set([...ltRounds(), ...Object.keys(S.lt.res)])].filter(k=>Date.now()>=ltLock(k) || k[0]==="s" || k[0]==="c").sort().reverse();
  S.ltAdmKey = S.ltAdmKey && keys.includes(S.ltAdmKey) ? S.ltAdmKey : keys[0];
  const k=S.ltAdmKey, r=S.lt.res[k]||{};
  const opts=(ALLP?.players||[]).map(p=>`<option value="${esc(p.n)} · ${p.t} · ${p.id}">`).join("");
  const topts=(ALLP?.teams||[]).map(t=>`<option value="${esc(t.n)} · ${t.a}">`).join("");
  openSheet(`<h3 id="shTitle">Uzun vade sonuçları</h3><p class="muted">Kazananlar Wikipedia'daki sezon sayfasından saatte bir otomatik çekilir. Burada kaydedersen o tur elle girilmiş sayılır ve artık otomatik değişmez.</p>
    <select id="ltAdmK" class="adm-in">${keys.map(x=>`<option value="${x}" ${x===k?"selected":""}>${ltTitle(x)}</option>`).join("")}</select>
    <datalist id="ltPl">${opts}</datalist><datalist id="ltTm">${topts}</datalist>
    ${LT_CATS[ltType(k)].map(([c,l,,cf])=>`<label class="fld"><span>${l}</span><input class="adm-in" data-ltr="${c}" list="${cf[0]==="T"?"ltTm":"ltPl"}" value="${r[c]?esc((r.names?.[c]||"")+(cf[0]==="T"?" · "+r[c]:" ·  · "+r[c])):""}" placeholder="Yazmaya başla, listeden seç"></label>`).join("")}
    ${k[0]==="s"?`<label class="fld"><span>65 maç kuralına takılanlar (oyuncu, virgülle)</span><input class="adm-in" id="ltInel" list="ltPl" value="${esc(Object.keys(r.inelig||{}).join(", "))}" placeholder="oyuncu kimlikleri"></label>`:""}
    <button class="btn-primary" id="ltAdmSave" type="button">Kaydet</button><small class="muted" id="ltAdmMsg"></small>`);
  $("#ltAdmK").onchange=e=>{ S.ltAdmKey=e.target.value; openLTAdmin(); };
  $("#ltAdmSave").onclick=async()=>{
    const out={names:{}, manual:true, at: S.lt.res[k]?.at || serverTimestamp()};
    for(const el of $$("[data-ltr]")){ const v=el.value.trim(); if(!v) continue; const parts=v.split("·").map(x=>x.trim()); const id=parts.at(-1); out[el.dataset.ltr]=id; out.names[el.dataset.ltr]=parts[0]; }
    if($("#ltInel")){ out.inelig={}; for(const x of $("#ltInel").value.split(",").map(s=>s.trim().split("·").pop().trim()).filter(Boolean)) out.inelig[x]=true; }
    try{ await setDoc(doc(S.db,"ltResults",k), out); S.lt.res[k]={...out, at:out.at?.toMillis ? out.at : Timestamp.now()}; $("#ltAdmMsg").textContent="Kaydedildi."; loadLT(); }catch(e){ $("#ltAdmMsg").textContent="Kaydedilemedi."; }
  };
}
document.addEventListener("click", e=>{ const b=e.target.closest("[data-lt]"); if(b){ e.stopPropagation(); allPlayers().catch(()=>{}).then(()=>openLT(b.dataset.lt)); } });

/* ====================================================== gezinme ve yenileme */
// Yeni kazanılan rozeti bir kez kutla (sayılar telefonda saklanır; ilk açılışta sessizce kaydedilir)
function checkNewBadges(){
  if(!S.uid || checkNewBadges.busy) return;
  const cur=Object.fromEntries(badgesOf(S.uid).map(b=>[b.id,b.n]));
  const key="badges:"+S.uid; let old=null; try{ old=JSON.parse(localStorage.getItem(key)||"null"); }catch(e){}
  try{ localStorage.setItem(key, JSON.stringify(cur)); }catch(e){}
  if(!old) return;
  const fresh=BADGES.filter(b=>(cur[b.id]||0)>(old[b.id]||0));
  if(!fresh.length) return;
  const b=fresh[0]; checkNewBadges.busy=true;
  const el=document.createElement("div"); el.className="badge-pop"; el.setAttribute("role","status");
  el.innerHTML=`<div class="bp-card"><div class="bp-ico">${b.ico}</div><b>Yeni rozet!</b><span>${esc(b.name)}</span><small>${esc(b.desc)}</small></div>`;
  document.body.append(el); confetti?.();
  const close=()=>{ el.classList.add("out"); setTimeout(()=>{ el.remove(); checkNewBadges.busy=false; },350); };
  el.onclick=close; setTimeout(close, 4200);
}
// Canlı akış: çeyrek sonları, son 2 dakikada yakın maç, uzatma ve bitişler (sayfa açıkken biriktirilir)
S.feed = (()=>{ try{ return JSON.parse(sessionStorage.getItem("feed")||"[]"); }catch(e){ return []; } })(); S.feedPrev = {};
function updateFeed(){
  const add=(g,t,k)=>{ const id=g.id+"_"+k; if(S.feed.some(x=>x.id===id)) return; S.feed.unshift({id, t, at:Date.now(), a:g.away.abbr, h:g.home.abbr}); };
  for(const day of [S.today, shiftDay(S.today,-1)]) for(const g of S.days[day]?.games||[]){
    const pv=S.feedPrev[g.id]; S.feedPrev[g.id]={state:g.state, period:g.period};
    if(!pv) continue;   // ilk görüşte geçmişi uydurma
    const sc=`${g.away.abbr} ${g.away.score??0} – ${g.home.score??0} ${g.home.abbr}`;
    if(pv.state==="pre" && g.state==="in") add(g, `Başladı: ${g.away.abbr} @ ${g.home.abbr}`, "start");
    if(g.state==="in" && g.period>pv.period && pv.period>=1) add(g, pv.period<4 ? `${pv.period}. çeyrek bitti: ${sc}` : `Uzatmaya gitti! ${sc}`, "p"+pv.period);
    const clk=/^(\d+):/.exec(g.clock||""); const diff=Math.abs((g.home.score??0)-(g.away.score??0));
    if(g.state==="in" && g.period>=4 && clk && +clk[1]<2 && diff<=5) add(g, `Son 2 dakika, fark ${diff}: ${sc}`, "clutch"+g.period);
    if(pv.state==="in" && g.state==="post") add(g, `Bitti: ${sc}`, "end");
  }
  S.feed=S.feed.filter(x=>Date.now()-x.at<4*36e5).slice(0,20);
  try{ sessionStorage.setItem("feed", JSON.stringify(S.feed)); }catch(e){}
}
function renderFeed(){
  const el=$("#liveFeed"); if(!el) return;
  if(!S.feed.length || S.tab!=="tahmin"){ el.innerHTML=""; return; }
  el.innerHTML=`<div class="feed"><span class="feed-h"><i></i>Canlı</span><div class="feed-s">${S.feed.slice(0,8).map(x=>`<span class="feed-i"><small>${new Date(x.at).toLocaleTimeString(LOC,{timeZone:TZ,hour:"2-digit",minute:"2-digit"})}</small>${esc(x.t)}</span>`).join("")}</div></div>`;
}
function render(){
  if(!S.uid) return;
  if(S.touching){ render.pending=true; return; }
  updateFeed(); renderFeed();
  renderBoard(); renderBoardStrip();
  renderTicker();
  renderBanners();
  renderAlert();
  maybeConfetti(); setTimeout(maybeNightWinner, 900);
  if(!render.bt || Date.now()-render.bt>20e3){ render.bt=Date.now(); setTimeout(checkNewBadges, 1500); }
  const nLive = [S.today, shiftDay(S.today,-1)].reduce((n,d)=>n+(S.days[d]?.games.filter(g=>g.state==="in").length||0),0);
  $("#navLive").classList.toggle("hide", !nLive); $("#navLive").textContent = nLive || "";
  if(S.tab==="tahmin"){ renderDayLabel(); renderStatus(); if(S.sub==="maclar"){ renderDayPlayer(); renderGames(); } else renderDayView(); }
  if(S.tab==="sonuclar") renderResults();
  if(S.tab==="ayrisma") renderAyrisma();
  if(S.tab==="puan") renderPuan();
  if(S.tab==="uzun") renderUzun();
  if(S.tab==="nba" && !render.nbaAt) { render.nbaAt=1; renderNBA(); }
  if(S.tab==="takim" && !render.tkAt) { render.tkAt=1; renderTakim(); }
  navTeamIcon();
  if(S.tab==="istatistik") renderStats();
}
function route(){
  const t=(location.hash||"#tahmin").slice(1);
  if(t==="istatistik"){ history.replaceState(null,"","#tahmin"); setTimeout(()=>S.uid && openProf(S.statFor||S.uid,"ist"),50); }
  S.tab=["tahmin","sonuclar","ayrisma","puan","uzun","takim","nba"].includes(t)?t:"tahmin";
  render.nbaAt=0; render.tkAt=0; S.boardOpen=null;
  $$("[data-view]").forEach(v=>v.classList.toggle("hide", v.id!=="view-"+S.tab));
  $$(".nav a").forEach(a=>a.dataset.tab===S.tab?a.setAttribute("aria-current","page"):a.removeAttribute("aria-current"));
  movePill();
  if(S.tab!=="tahmin"){ $("#pickBar").innerHTML=""; $("#pickBar").classList.remove("show"); }
  render();
}
S.scrollY = {};
window.addEventListener("hashchange", ()=>{ route(); scrollTo({top:S.scrollY[S.tab]||0}); });
addEventListener("scroll", ()=>{ if(S.tab) S.scrollY[S.tab]=scrollY; }, {passive:true});
document.addEventListener("click", e=>{ const a=e.target.closest(".nav a[data-tab]"); if(a && a.dataset.tab===S.tab){ e.preventDefault(); scrollTo({top:0, behavior:"smooth"}); } });
// alt menüde "Takımım" simgesi favori takımın logosu olur
function navTeamIcon(){
  const el=$("#navTeam"); if(!el) return; const fav=S.players?.[S.uid]?.favTeam||"";
  if(el.dataset.t===fav) return; el.dataset.t=fav;
  el.innerHTML = fav ? `<img src="${LOGO_SMALL(fav)}" alt="">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/></svg>`;
}
function movePill(){
  const a=$(`.nav a[data-tab="${S.tab}"]`), pill=$("#navPill"); if(!a||!pill) return;
  const w=Math.min(64, a.offsetWidth-8); pill.style.width=w+"px"; pill.style.transform=`translateX(${a.offsetLeft+(a.offsetWidth-w)/2}px)`;
}
addEventListener("resize", movePill);
// parmak ekrandayken ve dokunuştan hemen sonra yeniden çizme bekletilir
addEventListener("pointerdown", ()=>{ S.touching=true; clearTimeout(S.touchT); S.touchT=setTimeout(()=>{ S.touching=false; if(render.pending){ render.pending=false; render(); } }, 1000); }, {passive:true, capture:true});
const touchEnd=()=>{ clearTimeout(S.touchT); S.touchT=setTimeout(()=>{ S.touching=false; if(render.pending){ render.pending=false; render(); } }, 30); };
addEventListener("pointerup", touchEnd, {passive:true, capture:true}); addEventListener("pointercancel", touchEnd, {passive:true, capture:true});
$("#boardStrip")?.addEventListener("click", ()=>{ S.boardOpen = S.boardOpen===S.tab ? null : S.tab; renderBoardStrip(); });
// Mobilde aşağı kaydırınca üst çubuk ve alt menü saklanır, yukarı kaydırınca (ya da sayfanın sonunda) geri gelir
(()=>{ let last=scrollY, acc=0;
  addEventListener("scroll", ()=>{ const y=scrollY, d=y-last; last=y; acc = (Math.sign(d)===Math.sign(acc)) ? acc+d : d;
    if(Math.abs(acc)<48) return;   // en az ~50 px aynı yöne kaydırınca karar ver
    const atEnd = innerHeight+y >= document.documentElement.scrollHeight-60;
    const hide = acc>0 && y>160 && !atEnd && innerWidth<=760 && $("#sheet").classList.contains("hide");
    acc=0;
    if(hide===document.body.classList.contains("bars-hidden")) return;
    document.body.classList.toggle("bars-hidden", hide);
    document.body.classList.add("bars-moving"); clearTimeout(S.barsT); S.barsT=setTimeout(()=>document.body.classList.remove("bars-moving"), 400); }, {passive:true});
  addEventListener("hashchange", ()=>document.body.classList.remove("bars-hidden"));
})();
async function showDay(){
  S.draft={}; renderDayLabel(); $("#games").innerHTML=skeletonCards(); $("#dayStatus").innerHTML=""; $("#dayPlayer").innerHTML="";
  try{ await loadDay(S.day, {force:true}); }catch(e){ $("#games").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor. Biraz sonra tekrar dene.</div>`; return; }
  render();
}
$("#dayPrev").onclick=()=>{ S.day=shiftDay(S.day,-1); showDay(); };
$("#dayNext").onclick=()=>{ S.day=shiftDay(S.day,1); showDay(); };

async function loadArchive(){
  // Önce sitenin kendi kopyası (aynı sunucu, telefonda ek bağlantı kurulmaz); gelmezse GitHub'daki ham dosya
  const raw = (() => { const h=location.hostname; if(!h.endsWith(".github.io")) return "";
    const owner=h.split(".")[0], seg=location.pathname.split("/").filter(Boolean)[0];
    return `https://raw.githubusercontent.com/${owner}/${seg && !seg.includes(".")?seg:h}/main/data/`; })();
  const get = async n => { try{ return await getJSON("data/"+n+"?t="+Date.now(), 6000); }catch(e){ return raw ? getJSON(raw+n+"?t="+Date.now(), 6000).catch(()=>null) : null; } };
  const [g,p,s] = await Promise.all([get("games.json"), get("players.json"), get("scores.json")]);
  if(g) S.arch.games=g; if(p) S.pstats=p.p||{}; if(s) S.arch.scores={days:{},games:{},totals:{},weeks:{},...s};
  S.archRaw = S.arch.scores;
  await loadLeague();
}
// Lig: yönetim panelinden sıfırlanınca yalnızca başlangıç gecesinden sonraki geceler sayılır.
// Deneme haftası (league/settings.trial = {end, name}): bitiş gecesinden sonraki gün (TR 08.00) lig kendiliğinden sıfırlanır;
// yönetici siteyi ilk açtığında deneme tablosu "Geçmiş ligler"e kaydedilir. scripts/sync.py da aynı günü kullanır.
const baseStart = () => [S.cfg?.seasonStart||"", S.league?.start||""].sort().pop();
const trialOf = () => { const t=S.league?.trial; return t?.end && !t.done && t.end>=baseStart() ? t : null; };
const trialActive = () => { const t=trialOf(); return !!t && espnToday()<=t.end; };
const trialOver = () => { const t=trialOf(); return !!t && espnToday()>t.end; };
const leagueStart = () => { if(S.lsRange) return S.lsRange[0]; const t=trialOf(); return t && espnToday()>t.end ? shiftDay(t.end,1) : baseStart(); };
const leagueEnd = () => S.lsRange ? S.lsRange[1] : "99999999";
// uzun vade turları: yalnızca lig başladıktan sonra kilitlenen turlar sayılır (başlangıç gecesi TR 15.00)
const dayMs = d => Date.UTC(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8), 12);
const ltInLeague = k => { const l=ltLock(k), en=leagueEnd(); return l >= dayMs(leagueStart()) && (en==="99999999" || l < dayMs(shiftDay(en,1))); };
const inLeague = d => d >= leagueStart() && d <= leagueEnd();
async function loadLeague(){
  try{ const r=await getDoc(doc(S.db,"league","settings")); S.league = r.exists() ? r.data() : {}; }catch(e){ S.league = S.league || {}; }
  try{ const n=await getDoc(doc(S.db,"league","notice")); S.notice = n.exists() ? n.data() : null; }catch(e){}
  applyLeague();
}
function applyLeague(){
  const raw=S.archRaw||S.arch.scores, st=leagueStart(), en=leagueEnd(), ok=d=>d>=st && d<=en;
  const days=Object.fromEntries(Object.entries(raw.days||{}).filter(([d])=>ok(d)));
  const games=Object.fromEntries(Object.entries(raw.games||{}).filter(([gid])=>ok(S.arch.games[gid]?.day||"")));
  const series=Object.fromEntries(Object.entries(raw.series||{}).filter(([,x])=>ok(x.day||"")));
  // haftaları lig gecelerinden yeniden hesapla
  const weeks={};
  for(const [d,row] of Object.entries(days)) for(const [u,v] of Object.entries(row)){ const w=weekKey(d); (weeks[w] ||= {}); weeks[w][u]=(weeks[w][u]||0)+(v.tot ?? (v.pts+(v.sr||0))); }
  S.arch.scores={...raw, days, games, series, weeks};
  honors.k=null;
}
async function refresh(){
  // gün döndüyse (sabah 08.00) "bugün"ü ilerlet; kullanıcı bugündeyse onu da taşı
  const nt=espnToday(); if(nt!==S.today){ if(S.day===S.today) S.day=nt; S.today=nt; renderDayLabel?.(); applyLeague(); maybeLeaguePop(); }
  const jobs=[loadDay(S.today,{force:true})];
  if(S.tab==="sonuclar" && S.rday && S.rday!==S.today) jobs.push(loadDay(S.rday,{force:true}));
  if(S.day!==S.today) jobs.push(loadDay(S.day,{force:true}));
  // dün henüz arşive (tüm oyuncular için) girmediyse canlı hesap için yükle
  const yd=shiftDay(S.today,-1), archYd=S.arch.scores.days?.[yd];
  if(!archYd || S.order.some(u=>!archYd[u])) jobs.push(loadDay(yd).catch(()=>null));
  await Promise.allSettled(jobs);
  render(); schedule();
}
function schedule(){
  clearTimeout(S.timer);
  const live = Object.values(S.days).some(D=>D.games.some(g=>g.state==="in"));
  S.timer=setTimeout(refresh, document.hidden?10*60e3: live?30e3: 3*60e3);
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden && S.uid) refresh(); });
new IntersectionObserver(([e])=>{ S.pbShow = !e.isIntersecting && e.boundingClientRect.top<0; $("#pickBar")?.classList.toggle("show", S.pbShow && !!$("#pickBar").innerHTML); },{rootMargin:"-60px 0px 0px 0px"}).observe($("#dayStatus"));
new IntersectionObserver(([e])=>{ const on=!e.isIntersecting && !!$("#mini").innerHTML; $("#mini").classList.toggle("show",on); $(".topbar").classList.toggle("scrolled",on); },{rootMargin:"-52px 0px 0px 0px"}).observe($("#board"));

/* ====================================================== ad kuralı */
// Ad büyük harfle başlar, küfür/argo/hakaret içermez. Firebase kuralları da en bariz olanları ayrıca engeller.
const LEET={"0":"o","1":"i","2":"z","3":"e","4":"a","5":"s","6":"g","7":"t","8":"b","9":"g","@":"a","$":"s","!":"i","|":"i","€":"e"};
const foldName = s => s.toLocaleLowerCase("tr").replace(/[0-9@$!|€]/g, c=>LEET[c]).normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/ı/g,"i");
const squeeze = s => s.replace(/(.)\1+/g, "$1");
// birleşik yazımda (boşluk/nokta atlatmaları dahil) aranan kökler
const BAD_SUB = ["orospu","orosbu","oruspu","siktir","sikerim","sikeyim","sikiyim","sikik","sikis","sikici","sikko","sokuk",
  "yarrak","yarak","yarag","dalyarak","tasak","tasag","aminak","aminako","amcik","amcig","amck","ibne","ipne","kahpe","kaltak",
  "pezevenk","gavat","yavsak","yavsag","serefsiz","surtuk","fahise","kevase","gerizekali","dangalak","angut","godos","kancik","gotveren",
  "gotlek","gotunu","ananisik","anasini","avradini","bacini","pic kurusu","haysiyetsiz","oglanci",
  "fuck","shit","bitch","cunt","asshole","bastard","whore","slut","nigger","nigga","faggot","retard","pussy","motherf","wanker",
  "dildo","penis","vagina","porn","hitler"].map(x=>squeeze(x.replace(/ /g,"")));
// yalnızca tek başına kelime olarak yasak olanlar (başka adların içinde geçebildikleri için)
const BAD_WORD = new Set(["amk","aq","amq","mk","oc","pic","got","sik","sg","mal","salak","aptal","pust","lan","ulan","ananı","anani","dick","cock","fag","ass","fck","sex","seks","kro","pezo","fuk","nazi","amina","sikim"].map(x=>squeeze(foldName(x))));
function nameProblem(name){
  if(!name) return "Adını yaz.";
  if(name.length > 40) return "Ad en fazla 40 karakter olabilir.";
  if(!/^\p{Lu}/u.test(name)) return "Ad büyük harfle başlamalı (ör. Andaç).";
  if(!/^\p{Lu}[\p{L}\p{N} .'\-]*$/u.test(name)) return "Adda yalnızca harf, rakam, boşluk ve . - ' olabilir.";
  const f = foldName(name), joined = squeeze(f.replace(/[^a-z]/g,"")), words = f.split(/[^a-z]+/).filter(Boolean).map(squeeze);
  if(BAD_SUB.some(x=>joined.includes(x)) || words.some(w=>BAD_WORD.has(w))) return "Bu ad uygun değil. Küfür, argo ya da hakaret içermeyen bir ad seç.";
  return null;
}

// Takım adı (ör. "Kyle Korver Sevenler Derneği"): ad kuralından daha sıkı kontrol.
// Harf oyunları (s.i.k, 4m1n4, siiiktir), tek harflere bölme ve birleşik yazım ayrı ayrı denenir.
const CLUB_BAD_WORD = new Set(["amk","aq","amq","mk","oc","pic","got","sik","sg","mal","salak","aptal","pust","lan","ulan","anani","dick","cock","fag","ass","fck","sex","seks","kro","pezo","fuk","nazi","amina","sikim","sikem","sokam","dalyak","gerzek","embesil","moron","hiyar","oglan","kodum","kodumun","kudur","ebeni","bok","boktan","sic","sicmak","osur","idiot","stupid","loser","porno","meme","gay","lez","travesti","terorist","pkk","isid","isis"].map(x=>squeeze(foldName(x))));
const CLUB_BAD_SUB = [...BAD_SUB, ...["gerizekal","dangalak","yavsak","pezeven","ananin","anan","bacin","avrad","ebeni","sikis","sikti","sikey","sikec","sikin","amina","amcik","yarra","yarag","tasak","daşşak","dassak","godo","kaltak","fahis","orosp","oruspu","ibnel","puşt","pust","kevas","kahpe","sürtük","surtuk","şerefsiz","namussuz","haysiyetsiz","pislik","aşağılık","asagilik","motherfuck","dumbass","jackass","bullshit","fucker","shithead","nigg","kike","chink","retard","dalyak","kodumun","ananiz","sikmis","siksin","sokay","sokar","yalak","yalaka","gotver","gotun","osuruk"].map(x=>squeeze(foldName(x).replace(/[^a-z]/g,"")))];
// kısa kökler ek almış halde de yakalanır: "Mallar", "Götler", "Piçler"
const CLUB_STEM = /^(mal|got|sik|pic|oc|bok|pust|amk|aq|lan|gay|lez|sic|osur|salak|aptal|gerzek|hiyar|moron|idiot)(lar|ler|lari|leri|larin|lerin|cu|ci|cuk|cik|cular|ciler|culer|cilar|lik|luk|um|im|umuz|imiz)?$/;
function clubProblem(t){
  if(!t) return null;
  if(t.length < 3) return "Takım adı en az 3 karakter olmalı.";
  if(t.length > 40) return "Takım adı en fazla 40 karakter olabilir.";
  if(!/^[\p{L}\p{N}][\p{L}\p{N} .'&!\-]*$/u.test(t)) return "Takım adında yalnızca harf, rakam, boşluk ve . - ' & ! olabilir.";
  if(/(.)\1{3,}/u.test(t)) return "Aynı harfi art arda bu kadar çok yazma.";
  const f = foldName(t), joined = squeeze(f.replace(/[^a-z]/g,""));
  const words = f.split(/[^a-z]+/).filter(Boolean).map(squeeze);
  // tek harflere bölünmüş yazımı birleştir: "s i k" -> "sik"
  const glued = f.split(/[^a-z]+/).filter(Boolean).reduce((a,w)=>{ if(w.length===1 && a.length && a[a.length-1].one) a[a.length-1].w+=w; else a.push({w, one:w.length===1}); return a; }, []).map(x=>squeeze(x.w));
  const raw = f.split(/[^a-z]+/).filter(Boolean);
  const bad = raw.some(w=>CLUB_STEM.test(w)) || CLUB_BAD_SUB.some(x=>x.length>=4 && joined.includes(x)) || [...words, ...glued].some(w=>CLUB_BAD_WORD.has(w) || BAD_WORD.has(w) || CLUB_STEM.test(w) || CLUB_BAD_SUB.some(x=>x.length<4 && w===x))
    || textProblem(t) || bioProblem(t);
  return bad ? "Bu takım adı uygun değil. Küfür, argo ya da hakaret içermeyen bir ad seç." : null;
}

/* ====================================================== güvenlik sorusu */
// Herkes bir takım ve bir basketbolcu seçer. Cevap tuzlu SHA-256 olarak saklanır (recovery/{uid});
// "Şifremi unuttum" isteğini GitHub'daki görev birkaç dakikada bir işler.
let ALLP=null;
async function allPlayers(){ if(!ALLP) ALLP = await getJSON("data/allplayers.json"); return ALLP; }
const hex = buf => [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function saveRecovery(uid, v){
  const salt = randHex(16), h = await sha256hex(`${salt}${v.team}:${v.playerId}`);
  await setDoc(doc(S.db,"recovery",uid), {salt, h, setAt:serverTimestamp()});
}
function secPicker(box, setup){
  const st = {team:"", pid:""};
  box.innerHTML = `${setup?`<div class="sec-tip">🔒 Favori takımını ya da sevdiğin oyuncuyu <b>seçme</b>, arkadaşların kolayca tahmin eder. Seninle hiç alakası olmayan ama aklında kalacak bir takım ve bir oyuncu seç (ör. hiç izlemediğin bir takım, bir yedek oyuncu).</div>`:""}
    <label class="fld"><span>Gizli takımın</span><select class="sec-team"><option value="">Yükleniyor…</option></select></label>
    <label class="fld"><span>Gizli oyuncun</span><input class="sec-pl" autocomplete="off" placeholder="Ara: oyuncunun adı"></label>
    <div class="sec-res"></div>`;
  const sel = box.querySelector(".sec-team"), inp = box.querySelector(".sec-pl"), res = box.querySelector(".sec-res");
  allPlayers().then(d => {
    sel.innerHTML = `<option value="">Takım seç</option>` + d.teams.map(t=>`<option value="${esc(t.a)}">${esc(t.n)}</option>`).join("");
  }).catch(() => { sel.innerHTML = `<option value="">Liste yüklenemedi, sayfayı yenile</option>`; });
  sel.onchange = () => { st.team = sel.value; };
  inp.oninput = async () => {
    st.pid = ""; inp.classList.remove("chosen");
    const q = slug(inp.value);
    if(q.length < 2){ res.innerHTML = ""; return; }
    const d = await allPlayers().catch(()=>null); if(!d) return;
    const hits = d.players.filter(p=>slug(p.n).includes(q)).slice(0,8);
    res.innerHTML = hits.length ? hits.map(p=>`<button type="button" data-id="${esc(p.id)}" data-n="${esc(p.n)}"><img src="${LOGO_SMALL(p.t)}" alt="">${esc(p.n)}<small>${esc(p.t)}</small></button>`).join("")
      : `<p class="muted">Bulunamadı.</p>`;
  };
  res.onclick = e => {
    const b = e.target.closest("button"); if(!b) return;
    st.pid = b.dataset.id; inp.value = b.dataset.n; inp.classList.add("chosen"); res.innerHTML = "";
  };
  return { value: () => (st.team && st.pid) ? {team:st.team, playerId:st.pid} : null, focus: () => sel.focus() };
}
function openRecoverySheet(required){
  openSheet(`<h3 id="shTitle">Güvenlik sorusu</h3>
    <p class="muted">${required?"Şifreni unutursan sıfırlayabilmen için bir kez seçmen gerekiyor.":"Yeni cevabın eskisinin yerine geçer."} Seçtiğin takım ve oyuncuyu kimseye söyleme.</p>
    <div id="recBox"></div><p class="err" id="recErr"></p><button class="btn-primary" id="recSave" type="button">Kaydet</button>`);
  S.sheetLocked = required; $("#shClose").classList.toggle("hide", required);
  const pk = secPicker($("#recBox"), true);
  $("#recSave").onclick = async () => {
    const v = pk.value(); if(!v){ $("#recErr").textContent = "Takımı seç ve listeden bir oyuncuya dokun."; return; }
    $("#recSave").disabled = true;
    try{ await saveRecovery(S.uid, v); S.sheetLocked=false; $("#shClose").classList.remove("hide"); closeSheet(); toast("Güvenlik sorusu kaydedildi."); }
    catch(e){ $("#recErr").textContent = "Kaydedilemedi, tekrar dene."; $("#recSave").disabled = false; }
  };
}
async function checkRecovery(){
  if(S.joinP) await S.joinP.catch(()=>{});
  try{ const r = await getDoc(doc(S.db,"recovery",S.uid)); if(!r.exists()) openRecoverySheet(true); }catch(e){}
}

/* ====================================================== giriş */
// Şifre kutucukları: gerçek input görünmez şekilde 6 kutunun üstünde durur (şifre yöneticileri de çalışır)
function pinBoxes(inp, onFull){
  if(inp.closest(".pinb")) return inp._paint;
  const w=document.createElement("div"); w.className="pinb"; inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
  const cells=document.createElement("div"); cells.className="pinb-cells"; cells.setAttribute("aria-hidden","true"); cells.innerHTML="<i></i>".repeat(6); w.appendChild(cells);
  const paint=()=>{ const v=inp.value.replace(/\D/g,"").slice(0,6); if(v!==inp.value) inp.value=v; const n=v.length, f=document.activeElement===inp;
    [...cells.children].forEach((c,i)=>{ c.className = i<n ? "on" : (i===n && f ? "cur" : ""); c.textContent = i<n ? (inp.dataset.show ? v[i] : "●") : ""; }); };
  inp.addEventListener("input", ()=>{ paint(); if(inp.value.length===6 && onFull) onFull(); });
  inp.addEventListener("focus", paint); inp.addEventListener("blur", paint);
  inp._paint=paint; paint(); return paint;
}
const WEAK_PINS = new Set(["123456","654321","012345","543210","123123","121212","112233","098765","987654","456789","147258","159753"]);
const weakPin = p => /^(\d)\1{5}$/.test(p) || /^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p) || WEAK_PINS.has(p);
const nameTaken = n => S.order.some(u=>slug(pname(u))===slug(n));

let authMode="login", authSec=null, resetM="mail";
S.lgUser = null;
function paintLgPick(){
  const box=$("#lgPick"); if(!box) return;
  const show = authMode!=="join" && !S.lgUser && S.order.length && !S.lgType;
  box.classList.toggle("hide", !show);
  $("#fName").classList.toggle("hide", !(authMode!=="join" && !S.lgUser && (S.lgType || !S.order.length)));
  $("#authH").classList.toggle("hide", !show);
  if(show) box.innerHTML = S.order.map(u=>`<button type="button" class="lg-card" data-lgu="${u}" style="--pc:${col(u)}">${avatar(u,"lg")}<b>${esc(pname(u))}</b></button>`).join("")
    + `<button type="button" class="lg-card lg-other" data-lgu=""><span class="av lg">+</span><b>Adımı yazayım</b></button>`;
  const who=$("#lgWho");
  who.classList.toggle("hide", !S.lgUser);
  if(S.lgUser) who.innerHTML = `${avatar(S.lgUser,"lg")}<span><small>${authMode==="reset"?"Şifresi sıfırlanacak oyuncu":"Giriş yapan"}</small><b>${esc(pname(S.lgUser))}</b></span><button type="button" class="linkish" id="lgChange">Değiştir</button>`;
}
$("#lgPick").addEventListener("click", e=>{ const b=e.target.closest("[data-lgu]"); if(!b) return;
  if(!b.dataset.lgu){ S.lgType=true; paintLgPick(); $("#inName").focus(); return; }
  S.lgUser=b.dataset.lgu; $("#inName").value=pname(S.lgUser); paintLgPick(); $("#authErr").textContent="";
  if(authMode==="login") setTimeout(()=>$("#inPin").focus(), 50); });
$("#lgWho").addEventListener("click", e=>{ if(e.target.closest("#lgChange")){ S.lgUser=null; S.lgType=false; $("#inName").value=""; $("#inPin").value=""; $("#inPin")._paint?.(); paintLgPick(); } });

function setAuthMode(m){
  if(m==="join"){ authMode="join"; $$("#authMode .chip").forEach(x=>x.setAttribute("aria-pressed", x.dataset.v==="join")); $("#authForm").classList.add("hide"); $("#joinBox").classList.remove("hide"); paintJoin(); return; }
  $("#joinBox").classList.add("hide"); $("#authForm").classList.remove("hide");
  authMode=m;
  $$("#authMode .chip").forEach(x=>x.setAttribute("aria-pressed", x.dataset.v==="login"));
  const rs = m==="reset";
  $("#rsMethod").classList.toggle("hide", !rs);
  $$("#rsMethod [data-rm]").forEach(b=>b.setAttribute("aria-pressed", b.dataset.rm===resetM));
  $("#fSec").classList.toggle("hide", !(rs && resetM==="sec"));
  $("#rsMail").classList.toggle("hide", !(rs && resetM==="mail"));
  if(rs && resetM==="sec" && !authSec) authSec = secPicker($("#secPick"));
  if(rs && resetM==="mail") paintRsMail();
  const needPin = !rs || resetM==="sec" || S.rsSent;
  $("#fPin").classList.toggle("hide", !needPin);
  $("#authBtn").classList.toggle("hide", rs && resetM==="mail" && !S.rsSent);
  $("#pinLbl").textContent = rs ? "Yeni şifre (6 hane)" : "Şifre (6 hane)";
  $("#inPin").autocomplete = rs ? "new-password" : "current-password";
  $("#authBtn").textContent = rs ? "Şifremi sıfırla" : "Giriş yap";
  $("#forgotBtn").textContent = rs ? "Girişe dön" : "Şifremi unuttum";
  $("#authH").textContent = rs ? "Kimin şifresi?" : "Kimsin?";
  $("#authErr").textContent="";
  paintLgPick();
}
$("#authMode").addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(c) setAuthMode(c.dataset.v); });
$("#forgotBtn").onclick = () => { S.rsSent=null; setAuthMode(authMode==="reset" ? "login" : "reset"); };
$("#rsMethod").addEventListener("click", e=>{ const b=e.target.closest("[data-rm]"); if(b){ resetM=b.dataset.rm; setAuthMode("reset"); } });
$("#howBtn").onclick = () => openHow();
$("#authLang").textContent = LANG==="en" ? "Türkçe" : "English"; $("#authLang").onclick = () => setLang(LANG==="en"?"tr":"en");
pinBoxes($("#inPin"), () => { if(authMode==="login" && $("#inName").value.trim()) $("#authForm").requestSubmit(); });

// Mail ile sıfırlama: 1) ad -> mailReset/{id}; görev onaylı adrese kod yollar  2) kod + yeni şifre -> resets/{id}
function paintRsMail(){
  const box=$("#rsMail");
  if(!S.rsSent){ box.innerHTML = `<p class="muted" style="margin:10px 0 0">Profilinde onayladığın mail adresine 6 haneli bir kod gönderilir. Kod 3 saat geçerli.</p>
      <button class="btn-primary" id="rsSend" type="button">Kod gönder</button><p class="muted" id="rsMsg" style="margin:8px 0 0"></p>`;
    $("#rsSend").onclick = sendResetCode; return; }
  box.innerHTML = `<div class="reset-box ok" style="margin-top:12px"><b>Kod gönderildi</b><p>${esc(S.rsSent.m||"Mail adresine")} adresine bakmayı unutma; gereksiz klasörüne de düşebilir.</p></div>
    <div class="fld"><span>Maildeki kod</span><input id="rsCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" data-show="1" aria-label="Maildeki kod"></div>
    <button class="linkish" id="rsAgain" type="button">Kod gelmedi, tekrar gönder</button>`;
  pinBoxes($("#rsCode"), ()=>$("#inPin").focus());
  $("#rsAgain").onclick = () => { S.rsSent=null; setAuthMode("reset"); };
}
async function sendResetCode(){
  const name=$("#inName").value.trim(), msg=$("#rsMsg");
  if(!slug(name)){ $("#authErr").textContent="Önce kim olduğunu seç."; return; }
  const id=randHex(12); $("#rsSend").disabled=true; msg.textContent="İstek gönderiliyor…";
  try{ await setDoc(doc(S.db,"mailReset",id), {name, at:serverTimestamp()}); }
  catch(e){ msg.textContent="İstek gönderilemedi, tekrar dene."; $("#rsSend").disabled=false; return; }
  msg.innerHTML=`<span class="spin sm"></span> Kod hazırlanıyor, genelde 1 dakika sürer…`;
  const t0=Date.now();
  const poll=async()=>{
    try{ const r=await getDoc(doc(S.db,"resetStatus",id)); if(r.exists()){ const d=r.data();
      if(d.state==="sent"){ S.rsSent={id, m:d.m, name}; setAuthMode("reset"); return; }
      msg.textContent = {nomail:"Bu hesapta onaylı bir mail adresi yok. Güvenlik sorusuyla sıfırlayabilirsin.", nouser:"Bu adla bir oyuncu bulunamadı.", wait:"Az önce kod gönderildi; 2 dakika sonra tekrar dene.", locked:"Çok fazla yanlış deneme oldu. 1 saat sonra tekrar dene."}[d.state] || "İstek işlenemedi, tekrar dene.";
      if(d.state==="nomail"){ resetM="sec"; setTimeout(()=>setAuthMode("reset"), 2500); }
      $("#rsSend") && ($("#rsSend").disabled=false); return; } }catch(e){}
    if(Date.now()-t0 > 6*6e4){ msg.textContent="Kod hâlâ hazırlanıyor. Biraz sonra tekrar dene."; $("#rsSend").disabled=false; return; }
    setTimeout(poll, 5000);
  };
  setTimeout(poll, 4000);
}
const AUTH_ERR = {
  "auth/invalid-credential":"Şifre yanlış.", "auth/wrong-password":"Şifre yanlış.", "auth/user-not-found":"Bu adla oyuncu yok. Yeni oyuncu sekmesinden katıl.",
  "auth/email-already-in-use":"Bu ad alınmış. Giriş sekmesinden gir ya da başka bir ad seç.", "auth/too-many-requests":"Çok fazla yanlış deneme oldu. Birkaç dakika bekle ya da şifreni sıfırla.",
  "auth/network-request-failed":"İnternet bağlantısı yok gibi görünüyor."
};
$("#authForm").addEventListener("submit", async e=>{
  e.preventDefault();
  if($("#authBtn").disabled) return;
  const name=$("#inName").value.trim(), pin=$("#inPin").value.trim();
  const err=t=>{$("#authErr").textContent=t;};
  if(!slug(name)) return err("Önce kim olduğunu seç ya da adını yaz.");
  if(!/^\d{6}$/.test(pin)) return err(authMode==="reset" ? "Yeni şifre 6 rakam olmalı." : "Şifre 6 rakam olmalı.");
  const email=`${slug(name)}@${S.cfg.authEmailDomain}`;
  $("#authBtn").disabled=true; err("");
  try{
    if(authMode==="login"){
      await signInWithEmailAndPassword(S.auth, email, pin);
      const u=S.order.find(x=>slug(pname(x))===slug(name)); if(u) lsSet("lastUser", u);
    } else {
      const id = randHex(12); let data;
      if(resetM==="mail"){ const code=($("#rsCode")?.value||"").trim(); if(!/^\d{6}$/.test(code)){ $("#authBtn").disabled=false; return err("Maildeki 6 haneli kodu yaz."); }
        if(weakPin(pin)){ $("#authBtn").disabled=false; return err("Bu şifre çok kolay tahmin edilir; başka bir şifre seç."); }
        data={name, code, pin, at:serverTimestamp()}; }
      else { const sec=authSec?.value(); if(!sec){ $("#authBtn").disabled=false; return err("Takımı seç ve listeden bir oyuncuya dokun."); }
        if(weakPin(pin)){ $("#authBtn").disabled=false; return err("Bu şifre çok kolay tahmin edilir; başka bir şifre seç."); }
        data={name, team:sec.team, playerId:sec.playerId, pin, at:serverTimestamp()}; }
      await setDoc(doc(S.db,"resets",id), data);
      lsSet("resetReq", JSON.stringify({id, name, t:Date.now()}));
      S.rsSent=null; showResetWait();
    }
  }catch(x){ err((!S.lgUser && x.code==="auth/invalid-credential") ? "Ad ya da şifre yanlış." : AUTH_ERR[x.code]||(authMode==="reset"?"İstek gönderilemedi, tekrar dene.":"Giriş yapılamadı, tekrar dene.")); if(authMode==="login"){ $("#inPin").value=""; $("#inPin")._paint(); } }
  $("#authBtn").disabled=false;
});

/* ---------- yeni oyuncu: adım adım kayıt (1 ad, 2 şifre, 3 güvenlik sorusu; katıldıktan sonra 4 takım ve avatar, 5 mail) */
S.jw = {step:1, name:"", pin:"", inv:Q.get("davet")||"", ref:Q.get("ref")||""};
const JSTEPS = ["Adın","Şifren","Güvenlik sorusu","Takım ve avatar","Mail adresin"];
const stepBar = n => `<div class="jw-bar">${JSTEPS.map((t,i)=>`<i class="${i<n?"on":""}"></i>`).join("")}</div><div class="jw-step">Adım ${n}/5 · ${JSTEPS[n-1]}</div>`;
function paintJoin(){
  const box=$("#joinBox"), j=S.jw;
  if(j.step===1){
    box.innerHTML = stepBar(1) + `<label class="fld"><span>Ligde görünecek adın</span><input id="jwName" maxlength="40" autocomplete="username" placeholder="ör. Andaç" value="${esc(j.name)}"></label>
      <small class="hint" id="jwNameHint">Büyük harfle başlamalı. Küfür, argo ya da hakaret içeremez.</small>
      ${j.inv ? "" : `<label class="fld"><span>Davet kodu</span><input id="jwInv" autocomplete="off" maxlength="40" placeholder="Seni davet edenden al" value="${esc(j.inv)}"></label>`}
      <p class="err" id="jwErr"></p><button class="btn-primary" id="jwNext" type="button">İleri</button>`;
    const inp=$("#jwName"), hint=$("#jwNameHint");
    const check=()=>{ const v=inp.value.trim(); const p = !v ? null : nameProblem(v) || (nameTaken(v) ? "Bu ad alınmış. Sen isen Giriş sekmesinden gir." : null);
      hint.textContent = p || (v ? "✓ Bu ad uygun." : "Büyük harfle başlamalı. Küfür, argo ya da hakaret içeremez."); hint.className = "hint "+(p?"bad":v?"good":""); return p; };
    inp.oninput=check; check(); setTimeout(()=>inp.focus(),50);
    $("#jwNext").onclick=()=>{ const v=inp.value.trim(); const p=nameProblem(v) || (nameTaken(v)?"Bu ad alınmış.":null); if(p) return $("#jwErr").textContent=p;
      const inv=j.inv || $("#jwInv")?.value.trim(); if(!inv) return $("#jwErr").textContent="Davet kodunu gir.";
      j.name=v; j.inv=inv; j.step=2; paintJoin(); };
    inp.onkeydown=e=>{ if(e.key==="Enter") $("#jwNext").click(); };
  }
  if(j.step===2){
    box.innerHTML = stepBar(2) + `<div class="fld"><span>6 haneli şifre</span><input id="jwPin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" aria-label="Şifre"></div>
      <div class="fld"><span>Şifreyi tekrar yaz</span><input id="jwPin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" aria-label="Şifre tekrar"></div>
      <small class="hint" id="jwPinHint">Doğum yılı, 123456 ya da 111111 gibi kolay şifreler seçme.</small>
      <p class="err" id="jwErr"></p><div class="jw-nav"><button class="btn" id="jwBack" type="button">Geri</button><button class="btn-primary" id="jwNext" type="button">İleri</button></div>`;
    const a=$("#jwPin"), b=$("#jwPin2"), hint=$("#jwPinHint");
    const check=()=>{ const p=a.value, q=b.value; let t="Doğum yılı, 123456 ya da 111111 gibi kolay şifreler seçme.", c="";
      if(p.length===6 && weakPin(p)){ t="Bu şifre çok kolay tahmin edilir; başka bir şifre seç."; c="bad"; }
      else if(q.length===6 && p!==q){ t="İki şifre aynı değil."; c="bad"; }
      else if(p.length===6 && p===q){ t="✓ Şifreler aynı."; c="good"; }
      hint.textContent=t; hint.className="hint "+c; };
    pinBoxes(a, ()=>{ check(); b.focus(); }); pinBoxes(b, check); a.addEventListener("input",check); b.addEventListener("input",check);
    setTimeout(()=>a.focus(),50);
    $("#jwBack").onclick=()=>{ j.step=1; paintJoin(); };
    $("#jwNext").onclick=()=>{ const p=a.value; if(!/^\d{6}$/.test(p)) return $("#jwErr").textContent="Şifre 6 rakam olmalı.";
      if(weakPin(p)) return $("#jwErr").textContent="Bu şifre çok kolay tahmin edilir; başka bir şifre seç.";
      if(p!==b.value) return $("#jwErr").textContent="İki şifre aynı değil.";
      j.pin=p; j.step=3; paintJoin(); };
  }
  if(j.step===3){
    box.innerHTML = stepBar(3) + `<p class="muted" style="margin:8px 0 0">Şifreni unutursan bu takım ve oyuncuyla sıfırlarsın. Kimseye söyleme.</p><div id="jwSec"></div>
      <p class="err" id="jwErr"></p><div class="jw-nav"><button class="btn" id="jwBack" type="button">Geri</button><button class="btn-primary" id="jwNext" type="button">Oyuna katıl</button></div>`;
    const pk=secPicker($("#jwSec"), true);
    $("#jwBack").onclick=()=>{ j.step=2; paintJoin(); };
    $("#jwNext").onclick=async()=>{ const sec=pk.value(); if(!sec) return $("#jwErr").textContent="Takımı seç ve listeden bir oyuncuya dokun.";
      const btn=$("#jwNext"); btn.disabled=true; btn.textContent="Katılıyorsun…"; $("#jwErr").textContent="";
      S.onboard = true;
      try{
        S.joinP = (async()=>{
          const cred=await createUserWithEmailAndPassword(S.auth, `${slug(j.name)}@${S.cfg.authEmailDomain}`, j.pin);
          try{
            const bt=writeBatch(S.db);
            bt.set(doc(S.db,"joins",cred.user.uid),{invite:j.inv});
            const pd={name:j.name, joined:serverTimestamp()}; if(j.ref && S.players[j.ref]) pd.ref=j.ref;
            bt.set(doc(S.db,"players",cred.user.uid),pd);
            await bt.commit();
          }catch(x){ await cred.user.delete().catch(()=>{}); throw {code:"invite"}; }
          await saveRecovery(cred.user.uid, sec).catch(()=>{});
          lsSet("lastUser", cred.user.uid);
        })();
        await S.joinP;
      }catch(x){ S.onboard=false; btn.disabled=false; btn.textContent="Oyuna katıl";
        $("#jwErr").textContent = x.code==="invite" ? "Davet kodu yanlış. Seni davet edenden kontrol etmesini iste." : AUTH_ERR[x.code]||"Katılınamadı, tekrar dene.";
        if(x.code==="invite" && !Q.get("davet")){ j.step=1; j.inv=""; setTimeout(paintJoin, 1800); } }
      S.joinP=null;
    };
  }
}

// Katıldıktan sonra: 4) takım adı + favori takım + avatar (takım adı zorunlu), 5) mail onayı (isteğe bağlı, atlanabilir).
const obLock = on => { S.sheetLocked=on; $("#shClose").classList.toggle("hide", on); };
function openOnboard(step){
  S.obStep=step;
  if(step===4){
    const me=S.players[S.uid]||{}; S.ob = S.ob || {club:me.club||"", team:me.favTeam||"", av:avImg(me.av)?me.av:"", auto:("autoPick" in me) ? !!me.autoPick : null};
    const teams=(ALLP?.teams||[]).slice().sort((a,b)=>a.n.localeCompare(b.n,"tr"));
    openSheet(`${S.onboard?stepBar(4):""}<h3 id="shTitle">Takım adın</h3><p class="muted">Ligde adının altında görünür (ör. Kyle Korver Sevenler Derneği). Zorunlu.</p>
      <input id="obClub" class="adm-in" style="width:100%" maxlength="40" placeholder="ör. Kyle Korver Sevenler Derneği" value="${esc(S.ob.club||"")}"><small class="hint" id="obClubErr"></small>
      <h3 style="margin-top:18px">Favori takımın</h3><p class="muted">Alt menüde bu takıma özel <b>Takımım</b> sekmesi açılır: maçlarını, oyuncularını, sakatlıklarını ve sıralamasını oradan takip edersin. Uygulamanın renkleri de bu takıma göre olur. Sonra Ayarlar'dan değiştirebilirsin.</p>
      <div class="tm-grid ob-teams">${teams.map(t=>`<button class="tg" data-obt="${t.a}" aria-pressed="${S.ob.team===t.a}" style="--tc:${tcol(t.a)}"><span class="tg-l"><img src="${LOGO_SMALL(t.a)}" alt=""></span><b>${esc(t.n.split(" ").slice(-1)[0])}</b></button>`).join("") || `<p class="muted">Takımlar yükleniyor…</p>`}</div>
      <h3 style="margin-top:18px">Avatarın</h3><p class="muted">Bir basketbolcu seç; sıralamada ve tahtada adının yanında fotoğrafı görünür. Sonra profilinden değiştirebilir, listede olmayan bir oyuncuyu da arayabilirsin.</p>
      <div class="pf-avs ob-avs">${STARS.map(([id,n])=>`<button class="pf-av" data-oba="p:${id}" aria-pressed="${S.ob.av===`p:${id}`}"><img src="${HEADSHOT(id)}" alt="" loading="lazy"><small>${esc(surname(n))}</small></button>`).join("")}</div>
      <h3 style="margin-top:18px">Otomatik tahmin <small class="req">zorunlu seçim</small></h3><p class="muted">Bir gece hiç tahmin yapmayı unutursan senin yerine her maçta ESPN'in favorisi seçilsin mi? Doğru çıkan <b>her 2 kazanan 1 puan</b> getirir; fark, skorer ve banko yoktur. Sonra Profil → Ayarlar'dan değiştirebilirsin.</p>
      <div class="seg2 ob-auto"><button type="button" data-oap="1" aria-pressed="${S.ob.auto===true}">Açık</button><button type="button" data-oap="0" aria-pressed="${S.ob.auto===false}">Kapalı</button></div>
      <p class="err" id="obErr"></p><button class="btn-primary" id="obNext" type="button">Devam</button>`);
    obLock(true);
    $("#sheet .ob-auto").onclick=e=>{ const b=e.target.closest("[data-oap]"); if(!b) return; S.ob.auto=b.dataset.oap==="1"; $$("#sheet [data-oap]").forEach(x=>x.setAttribute("aria-pressed", x===b)); $("#obErr").textContent=""; };
    if(!ALLP) allPlayers().then(()=>{ if(S.obStep===4) openOnboard(4); }).catch(()=>{});
    const clubInp=$("#obClub");
    const checkClub=()=>{ const v=clubInp.value.trim().replace(/\s+/g," "); S.ob.club=v; const p=v?clubProblem(v):null;
      $("#obClubErr").textContent = p || (v ? "✓ Uygun." : ""); $("#obClubErr").className = "hint "+(p?"bad":v?"good":""); return p; };
    clubInp.oninput=checkClub; if(clubInp.value) checkClub();
    $("#sheet .ob-teams").onclick=e=>{ const b=e.target.closest("[data-obt]"); if(!b) return; S.ob.team=b.dataset.obt; openOnboard(4); };
    $("#sheet .ob-avs").onclick=e=>{ const b=e.target.closest("[data-oba]"); if(!b) return; S.ob.av=b.dataset.oba; $$("#sheet [data-oba]").forEach(x=>x.setAttribute("aria-pressed", x===b)); };
    $("#obNext").onclick=async()=>{
      const club=clubInp.value.trim().replace(/\s+/g," ");
      if(!club){ $("#obErr").textContent="Bir takım adı yaz."; clubInp.focus(); return; }
      const p=clubProblem(club); if(p){ $("#obErr").textContent=p; clubInp.focus(); return; }
      if(S.ob.auto==null){ $("#obErr").textContent="Otomatik tahminin açık mı kapalı mı olacağını seç."; $("#sheet .ob-auto").scrollIntoView({block:"center",behavior:"smooth"}); return; }
      const patch={club, autoPick:!!S.ob.auto}; if(S.ob.team){ patch.favTeam=S.ob.team; patch.theme="team"; } if(S.ob.av){ patch.av=S.ob.av; patch.emoji=""; }
      $("#obNext").disabled=true;
      try{ await updateDoc(doc(S.db,"players",S.uid), patch); Object.assign(S.players[S.uid], patch); applyTheme(); render(); }
      catch(e){ $("#obErr").textContent="Kaydedilemedi, tekrar dene."; $("#obNext").disabled=false; return; }
      nextOnboard(4);
    };
    return;
  }
  if(step===5){
    const em=S.contact?.email||"", rem=S.contact?.remind ?? true, wk=S.contact?.weekly ?? true;
    const unver = !!em && !S.contact?.verified;
    openSheet(`${S.onboard?stepBar(5):""}<h3 id="shTitle">${unver?"Mail adresini onayla":"Mail adresin"}</h3>
      ${unver?`<div class="inv-note">📩 <b>${esc(em)}</b> kayıtlı ama henüz onaylanmadı. Onaylamazsan hatırlatma ve haftalık özet gelmez; şifreni unutursan mail ile sıfırlayamazsın, sadece güvenlik sorusu kalır. "Kodu tekrar gönder"e bas, gelen 6 haneli kodu gir. Kod gelmezse spam klasörüne bak.</div>`:""}
      <p class="muted">Mail adresini yaz, sana 6 haneli bir onay kodu gönderelim. Kodu <b>şimdi</b> girebilir ya da <b>sonra Profil → Ayarlar'dan</b> girebilirsin. <b>Kodu girene kadar sana hiçbir mail gelmez</b> (hatırlatma, haftalık özet, şifre sıfırlama). Adresini yalnızca sen görürsün.</p>
      <label class="fld"><span>E-posta</span><input id="obMail" type="email" autocomplete="email" inputmode="email" placeholder="ornek@gmail.com" value="${esc(em)}"></label>
      <div class="ob-opts"><b>Hangi mailler gelsin?</b> <small class="muted">İsteğe bağlı, sonra Ayarlar'dan değiştirebilirsin.</small>
        <label class="ob-chk"><input type="checkbox" id="obRemind" ${rem?"checked":""}><span>Eksik tahmin ve sakatlık hatırlatmaları</span></label>
        <label class="ob-chk"><input type="checkbox" id="obWeekly" ${wk?"checked":""}><span>Pazartesi haftalık özet</span></label>
        <label class="ob-chk dis"><input type="checkbox" checked disabled><span>Şifre sıfırlama kodu (her zaman)</span></label></div>
      <button class="btn-primary" id="obSend" type="button">${unver?"Kodu tekrar gönder":"Kaydet ve onay kodu gönder"}</button>
      <div id="obCodeBox" class="${unver?"":"hide"}"><div class="fld"><span>Maildeki 6 haneli kod</span><input id="obCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" data-show="1" aria-label="Onay kodu"></div>
        <button class="btn-primary" id="obOk" type="button">Onayla ve bitir</button></div>
      <p class="muted" id="obMsg" style="margin-top:8px"></p>
      <button class="linkish ob-skip ${em?"":"hide"}" id="obSkip" type="button">Kodu sonra gireceğim</button>`);
    // mail adresi yazılmadan geçilemez; adres kaydedildikten sonra kod sonraya bırakılabilir
    obLock(!em);
    $("#obSkip").onclick=()=>{ lsSet("mailAsk", String(Date.now())); finishOnboard(); };
    const validMail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
    const prefs = () => ({remind:$("#obRemind").checked, weekly:$("#obWeekly").checked});
    pinBoxes($("#obCode"), ()=>$("#obOk").click());
    $("#obSend").onclick=async()=>{ const email=$("#obMail").value.trim(); if(!validMail(email)) return $("#obMsg").textContent="Mail adresi geçerli görünmüyor.";
      $("#obSend").disabled=true;
      try{ const d={email, ...prefs(), verified:false, updatedAt:serverTimestamp()};
        await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d};
        await setDoc(doc(S.db,"verifyReq",S.uid), {email, at:serverTimestamp()});
        $("#obCodeBox").classList.remove("hide"); $("#obSend").textContent="Kodu tekrar gönder"; $("#obSend").className="btn"; $("#obSend").style.cssText="width:100%;margin-top:8px";
        $("#obMsg").textContent=`Kod ${email} adresine gidiyor; genelde 1-2 dakika sürer. Gereksiz (spam) klasörüne de bak. Şimdi girmek istemezsen "Kodu sonra gireceğim"e bas.`; setTimeout(()=>$("#obCode").focus(),50);
        $("#obSkip").classList.remove("hide"); obLock(false);
      }catch(e){ $("#obMsg").textContent="İstek gönderilemedi, tekrar dene."; }
      $("#obSend").disabled=false; };
    $("#obOk").onclick=async()=>{ const code=$("#obCode").value.trim(); if(!/^\d{6}$/.test(code)) return $("#obMsg").textContent="Kod 6 rakam olmalı.";
      $("#obOk").disabled=true;
      try{ const d={email:$("#obMail").value.trim(), ...prefs(), verified:true, code, updatedAt:serverTimestamp()};
        await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d, code:undefined}; renderBanners(); toast("Mail adresin onaylandı."); nextOnboard(5); }
      catch(e){ $("#obMsg").textContent="Kod yanlış ya da süresi dolmuş. Tekrar dene ya da yeni kod iste."; $("#obCode").value=""; $("#obCode")._paint(); }
      $("#obOk").disabled=false; };
  }
}
const needClub = () => !S.players[S.uid]?.club || !("autoPick" in (S.players[S.uid]||{}));
const needMail = () => !(S.contact?.verified && S.contact?.email);
function nextOnboard(done){
  if(done<5 && needMail()){ lsSet("mailAsk", String(Date.now())); return openOnboard(5); }
  finishOnboard();
}
function finishOnboard(){ const first=S.onboard; S.onboard=false; S.obStep=null; obLock(false); closeSheet(); if(first) setTimeout(()=>openHow(), 350); }
// Girişte: takım adı eksikse zorunlu adım açılır. Onaylı mail eksikse atlanabilir hatırlatma: en fazla 4 saatte bir.
const MAIL_ASK_EVERY = 4*36e5;
function maybeAskMail(){
  if(S.onboard || !S.contact) return;
  if(!needClub() && !(needMail() && Date.now() - +(lsGet("mailAsk")||0) > MAIL_ASK_EVERY)) return;
  const go=(n=0)=>{ if(S.onboard || S.obStep) return;
    if(!$("#sheet").classList.contains("hide")){ if(n<30) setTimeout(()=>go(n+1), 3000); return; }
    if(!needClub()) lsSet("mailAsk", String(Date.now()));
    allPlayers().catch(()=>{}).finally(()=>openOnboard(needClub() ? 4 : 5)); };
  setTimeout(go, 1200);
}

// Nasıl oynanır: 3 kaydırmalı kart
function openHow(){
  const sl=[
    ["🏀","Her gece tahmin yap","Her maç için kazananı, farkı ve en çok sayı atacak oyuncuyu seç. Her doğru +1; ESPN'in şans vermediği sürpriz kazanan +2 ya da +3. Bir maçı banko yap: kazanan puanı 2 katına çıkar, tutmazsa -1. Her maç başlamadan 10 dakika önce kilitlenir."],
    ["🏆","Puan topla, zirveye çık","Günün oyuncusu +3, gecenin sorusu +1. Gecenin ve haftanın kazananı tahtada taç ve yıldızla görünür; rozetler topla. Tahminler sekmesinde kimin neyi seçtiğini maç maç gör."],
    ["📅","Uzun vadeyi kaçırma","Haftanın ve ayın oyuncusunu, NBA Kupası'nı, sezon ödüllerini ve NBA şampiyonunu önceden tahmin et. Doğru tahminler ana sıralamaya büyük puan olarak eklenir."]];
  openSheet(`<h3 id="shTitle" class="sr">Nasıl oynanır?</h3><div class="how" id="how">${sl.map(([e,t,d])=>`<div class="how-s"><div class="how-e">${e}</div><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>
    <div class="how-dots" id="howDots">${sl.map((_,i)=>`<i class="${i?"":"on"}"></i>`).join("")}</div><button class="btn-primary" id="howNext" type="button">Devam</button>`);
  const how=$("#how"), idx=()=>Math.round(how.scrollLeft/how.clientWidth);
  how.onscroll=()=>{ const i=idx(); $$("#howDots i").forEach((d,k)=>d.classList.toggle("on",k===i)); $("#howNext").textContent = i===sl.length-1 ? (S.uid?"Başla":"Anladım") : "Devam"; };
  $("#howNext").onclick=()=>{ const i=idx(); if(i>=sl.length-1) return closeSheet(); how.scrollTo({left:(i+1)*how.clientWidth, behavior:"smooth"}); };
}

// Giriş ekranının üstü: bu gecenin özeti ve lider
async function renderAuthLive(){
  const el=$("#authLive"); if(!el) return;
  const bits=[];
  try{ const raw=await S.preSB?.p; const g=raw?parseGames(raw):[];
    if(g.length){ const open=g.filter(x=>x.state==="pre"); bits.push(`<span><b>${g.length}</b> maç bu gece</span>`);
      if(open.length===g.length) bits.push(`<span>İlk kilit <b>${timeTR(g[0].lock)}</b></span>`); else if(g.some(x=>x.state==="in")) bits.push(`<span class="lv"><i></i>Maçlar sürüyor</span>`); } }catch(e){}
  try{ const t=seasonTotals(); const r=Object.entries(t).sort((a,b)=>b[1]-a[1]); if(r.length && r[0][1]>0) bits.push(`<span>Lider <b>${esc(pname(r[0][0]))}</b> · ${r[0][1]} puan</span>`); }catch(e){}
  if(S.order.length) bits.push(`<span><b>${S.order.length}</b> oyuncu</span>`);
  el.innerHTML=bits.join("");
  const lg=$("#authLogos"); if(lg && !lg.innerHTML) lg.innerHTML=Object.keys(TEAM_COL).map(a=>`<img src="${LOGO_SMALL(a)}" alt="" loading="lazy">`).join("");
}
function paintAuthInvite(){
  const r=S.jw.ref, el=$("#authInvite"); if(!el) return;
  if(r && S.players[r]){ el.classList.remove("hide"); el.innerHTML=`${avatar(r,"lg")}<span><b>${esc(pname(r))}</b> seni NBA Tahmin ligine davet etti.<small>Aşağıdan birkaç adımda katılabilirsin.</small></span>`; }
  else if(S.jw.inv){ el.classList.remove("hide"); el.innerHTML=`<span class="av lg">🏀</span><span><b>NBA Tahmin ligine davet edildin.</b><small>Aşağıdan birkaç adımda katılabilirsin.</small></span>`; }
}
// Davet mesajı: bu gecenin ilk kilidi (geçmediyse) ve deneme haftası bilgisiyle
function inviteNote(){
  const D=S.days[S.today], first=D?.games?.length ? D.games[0].nightLock : null, out=[];
  if(first && first.getTime()>Date.now()) out.push(`Bu gecenin ilk maçı ${timeTR(first)}'de kilitleniyor; ondan önce katılırsan bu geceden oynarsın.`);
  const t=trialActive?.() ? trialOf() : null;
  if(t) out.push(`Bu hafta deneme haftası, asıl lig ${dayNice(shiftDay(t.end,1),{day:"numeric",month:"long"})}'da başlıyor.`);
  return out;
}
const inviteText = url => [`${pname(S.uid)} seni NBA Tahmin'e davet ediyor! Her gece NBA maçlarına tahmin yapıp puan topluyoruz.`, ...inviteNote(), `Katılmak için: ${url}`].join(" ");
// Davet linki: herkes kendi linkini paylaşır (ref = davet eden); kaç kişiyi getirdiği profilde görünür
const invitedBy = u => S.order.filter(x=>S.players[x]?.ref===u);
async function shareInvite(msgEl){
  if(!S.invite){ try{ const r=await getDoc(doc(S.db,"config","secret")); S.invite=r.data()?.invite||""; }catch(e){} }
  if(!S.invite){ if(msgEl) msgEl.textContent="Davet kodu alınamadı."; return; }
  const url=`${location.origin}${location.pathname}?davet=${encodeURIComponent(S.invite)}&ref=${S.uid}`;
  const text=inviteText(url);
  try{ if(navigator.share){ await navigator.share({title:"NBA Tahmin", text, url}); return; } }catch(e){ if(e.name==="AbortError") return; }
  try{ await navigator.clipboard.writeText(url); if(msgEl) msgEl.textContent="Link kopyalandı."; else toast("Davet linkin kopyalandı."); }catch(e){ if(msgEl) msgEl.textContent=url; }
}

// Üst çubuktaki Davet et: kişisel davet linkini gösterir, tek dokunuşla kopyala / WhatsApp / paylaş
async function inviteUrl(){
  if(!S.invite){ try{ const r=await getDoc(doc(S.db,"config","secret")); S.invite=r.data()?.invite||""; }catch(e){} }
  return S.invite ? `${location.origin}${location.pathname}?davet=${encodeURIComponent(S.invite)}&ref=${S.uid}` : "";
}
async function openInvite(){
  openSheet(`<div class="rules inv-sh"><h3 id="shTitle">Arkadaşını davet et</h3><p class="muted">Link hazırlanıyor…</p></div>`);
  const url=await inviteUrl(), box=$("#sheet .inv-sh"); if(!box) return;
  if(!url){ box.innerHTML=`<h3 id="shTitle">Arkadaşını davet et</h3><p>Davet linki şu an alınamadı. Biraz sonra tekrar dene.</p>`; return; }
  const text=inviteText(url), mine=invitedBy(S.uid), note=inviteNote();
  box.innerHTML=`<h3 id="shTitle">Arkadaşını davet et</h3>
    <p>Bu link sana özel. Linkle gelen kişiye davet kodu sorulmaz, birkaç adımda lige katılır ve profilinde "Lige getirdiği" olarak senin adınla görünür.</p>
    ${note.length?`<div class="inv-note">⏰ ${note.map(esc).join("<br>")}<br><small class="muted">Bu bilgi WhatsApp ve paylaşma mesajına da ekleniyor.</small></div>`:""}
    <div class="inv-row"><input id="invUrl" readonly value="${esc(url)}" aria-label="Davet linki"><button class="btn" id="invCopy" type="button">${ICON.link}Kopyala</button></div>
    <div class="inv-acts"><a class="btn" id="invWa" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp'ta gönder</a>${navigator.share?`<button class="btn" id="invShare" type="button">Başka bir uygulamayla paylaş</button>`:""}</div>
    <small class="muted" id="invMsg">${mine.length?`Şimdiye kadar ${mine.length} kişiyi getirdin: ${mine.map(x=>esc(pname(x))).join(", ")}.`:"Henüz linkinle kimse katılmadı."}</small>`;
  $("#invUrl").onclick=e=>e.target.select();
  $("#invCopy").onclick=async()=>{ try{ await navigator.clipboard.writeText(url); $("#invMsg").textContent="Link kopyalandı. Şimdi istediğin yere yapıştırabilirsin."; }catch(e){ $("#invUrl").select(); $("#invMsg").textContent="Kopyalanamadı; linki seçtim, elle kopyalayabilirsin."; } };
  const sh=$("#invShare"); if(sh) sh.onclick=async()=>{ try{ await navigator.share({title:"NBA Tahmin", text, url}); }catch(e){} };
}
$("#invBtn").onclick=()=>openInvite();

/* ====================================================== lig sohbeti */
// chat/{id}: {uid, t (≤500), at (sunucu saati), re:{uid:emoji}, rp:{id,uid,t} yanıt, mn:[uid] etiketlenenler, ed: düzenleme saati}.
// Son 100 mesaj canlı dinlenir; eskiler istenince yüklenir. typing/{uid}: yazıyor göstergesi. chatpin/main: yöneticinin sabitlediği mesaj.
const CHAT_MAX=500, CHAT_EMOJI=["👍","😂","🔥","😮","👏","💀"], CHAT_EDIT=2*60e3, TYPING_TTL=7000;
S.chat=[]; S.chatOld=[]; S.chatMore=false; S.chatErr=false; S.chatPin=null; S.typing={};
const chatTs = m => m.at?.toMillis ? m.at.toMillis() : Date.now();
const chatSeen = () => +(lsGet("chatSeen")||0) || 0;
const setChatSeen = v => lsSet("chatSeen", String(v));
const chatMuted = () => lsGet("chatMute")==="1";
function startChat(){
  if(S.chatUnsub) return;
  S.chatUnsub = onSnapshot(query(collection(S.db,"chat"), orderBy("at","desc"), limit(100)), snap => {
    S.chat = snap.docs.map(d=>({id:d.id, ...d.data({serverTimestamps:"estimate"})}));
    S.chatErr=false;
    if(!S.chatOld.length){ S.chatMore = snap.docs.length>=100; if(S.chatMore) S.chatLastDoc=snap.docs[snap.docs.length-1]; }
    chatBadge(); if(S.chatOpen) paintChatList();
  }, () => { S.chatErr=true; S.chatUnsub=null; if(S.chatOpen) paintChatList(); });
  if(!S.pinUnsub) S.pinUnsub = onSnapshot(doc(S.db,"chatpin","main"), d => { S.chatPin = d.exists() && d.data().id ? d.data() : null; paintPin(); }, () => {});
}
function stopChat(){ for(const k of ["chatUnsub","pinUnsub","typUnsub"]) if(S[k]){ S[k](); S[k]=null; } S.chat=[]; S.chatOld=[]; S.chatPin=null; chatBadge(); }
function chatAll(){ const m=new Map(); for(const x of [...S.chatOld, ...S.chat]) m.set(x.id, x); return [...m.values()].sort((a,b)=>chatTs(a)-chatTs(b)); }
function chatBadge(){
  const fab=$("#chatFab"); if(!fab) return;
  fab.classList.toggle("hide", !S.uid);
  const seen=chatSeen(), fresh=S.chatOpen ? [] : S.chat.filter(m=>m.uid!==S.uid && chatTs(m)>seen);
  const men=fresh.filter(m=>(m.mn||[]).includes(S.uid)||m.rp?.uid===S.uid).length, muted=chatMuted();
  const n = muted ? men : fresh.length, b=$("#chatN");
  b.textContent = men ? `@${muted?"":" "+(n>99?"99+":n)}`.trim() : (n>99 ? "99+" : n);
  b.classList.toggle("hide", !n); b.classList.toggle("ment", !!men);
  fab.classList.toggle("muted", muted);
  fab.setAttribute("aria-label", n ? `Lig sohbeti, ${n} yeni mesaj${men?", seni anan var":""}` : "Lig sohbeti");
}
const chatDK = d => d.toLocaleDateString("en-CA",{timeZone:TZ});
const chatDay = ms => { const d=new Date(ms), k=chatDK(d), t=chatDK(new Date()), y=chatDK(new Date(Date.now()-864e5));
  return k===t ? "Bugün" : k===y ? "Dün" : d.toLocaleDateString(LOC,{timeZone:TZ, day:"numeric", month:"long", weekday:"long"}); };
// @etiketler ve bağlantılar: önce metin kaçırılır, sonra işaretlenir
const chatNames = () => S.order.map(u=>[u, pname(u)]).filter(x=>x[1]).sort((a,b)=>b[1].length-a[1].length);
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
// tek geçişte en uzun ad önce eşleşir ("@Ali Can" varken "@Ali" ayrıca sayılmaz)
function chatAtRx(escaped){ const ns=chatNames(); if(!ns.length) return null;
  return {rx:new RegExp("@("+ns.map(([u,n])=>reEsc(escaped?esc(n):n)).join("|")+")(?![\\p{L}\\p{N}])","giu"), ns}; }
const chatWho = (ns, hit, escaped) => ns.find(([u,n])=>(escaped?esc(n):n).toLocaleLowerCase("tr")===hit.toLocaleLowerCase("tr"));
function chatMentions(t){ const r=chatAtRx(false); if(!r) return []; const out=new Set();
  for(const m of t.matchAll(r.rx)){ const w=chatWho(r.ns, m[1], false); if(w) out.add(w[0]); } return [...out].slice(0,10); }
function chatRich(t){
  let h=esc(t);
  h=h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, u=>`<a href="${u}" target="_blank" rel="noopener nofollow">${u.length>48?u.slice(0,45)+"…":u}</a>`);
  const r=chatAtRx(true);
  if(r) h=h.replace(r.rx, (all, nm)=>{ const w=chatWho(r.ns, nm, true); return w ? `<span class="ch-at ${w[0]===S.uid?"me":""}" style="color:${col(w[0])}">@${esc(pname(w[0]))}</span>` : all; });
  return h.replace(/\n/g,"<br>");
}
function chatMsgHTML(m, prev){
  const mine=m.uid===S.uid, same=prev && prev.uid===m.uid && chatTs(m)-chatTs(prev)<5*60e3 && !m.rp;
  const re=m.re||{}, cnt={}; for(const [u,e] of Object.entries(re)) if(CHAT_EMOJI.includes(e)) (cnt[e]=cnt[e]||[]).push(u);
  const chips=Object.entries(cnt).map(([e,us])=>`<button class="ch-re ${us.includes(S.uid)?"on":""}" data-re="${e}" data-m="${m.id}" type="button" title="${esc(us.map(pname).join(", "))}">${e}<b>${us.length}</b></button>`).join("");
  const forMe = !mine && ((m.mn||[]).includes(S.uid) || m.rp?.uid===S.uid);
  const canEdit = mine && Date.now()-chatTs(m) < CHAT_EDIT - 5000;
  const pinned = S.chatPin?.id===m.id;
  return `<div class="ch-msg ${mine?"me":""} ${same?"cont":""} ${forMe?"forme":""}" data-id="${m.id}">
    <span class="ch-av">${same ? "" : avatar(m.uid)}</span>
    <div class="ch-b">
      ${same ? "" : `<b class="ch-n" style="color:${col(m.uid)}">${esc(pname(m.uid))}${mine?` <small>(sen)</small>`:""}</b>`}
      ${m.rp?`<button class="ch-q" data-goto="${esc(m.rp.id)}" type="button"><b style="color:${col(m.rp.uid)}">${esc(pname(m.rp.uid))}</b><span>${esc(m.rp.t)}</span></button>`:""}
      <div class="ch-t">${chatRich(m.t)}</div>
      <div class="ch-meta"><span class="ch-tm">${timeTR(new Date(chatTs(m)))}${m.ed?" · düzenlendi":""}${pinned?" · 📌":""}</span>
        <button class="ch-act" data-pick="${m.id}" type="button" aria-label="Tepki ver">☺︎+</button>
        <button class="ch-act" data-rep="${m.id}" type="button">Yanıtla</button>
        ${canEdit?`<button class="ch-act" data-edit="${m.id}" type="button">Düzenle</button>`:""}
        ${S.isAdmin?`<button class="ch-act" data-pin="${m.id}" type="button">${pinned?"Sabitlemeyi kaldır":"Sabitle"}</button>`:""}
        ${mine||S.isAdmin?`<button class="ch-act" data-del="${m.id}" type="button" aria-label="Mesajı sil">Sil</button>`:""}</div>
      ${chips?`<div class="ch-res">${chips}</div>`:""}
      ${S.chatPick===m.id?`<div class="ch-pick">${CHAT_EMOJI.map(e=>`<button data-re="${e}" data-m="${m.id}" type="button" aria-pressed="${re[S.uid]===e}">${e}</button>`).join("")}</div>`:""}
    </div></div>`;
}
function paintChatList(keep){
  const box=$("#chList"); if(!box) return;
  const atEnd = box.scrollHeight-box.scrollTop-box.clientHeight < 80, oldH=box.scrollHeight, oldTop=box.scrollTop;
  const ms=chatAll(); let html=S.chatMore?`<button class="btn ch-more" id="chMore" type="button">Daha eski mesajlar</button>`:"", day="";
  if(S.chatErr) html+=`<p class="ch-empty">Sohbet şu an açılamadı. Biraz sonra tekrar dene.</p>`;
  else if(!ms.length) html+=`<p class="ch-empty">Henüz mesaj yok. İlk mesajı sen yaz.</p>`;
  ms.forEach((m,i)=>{ const d=chatDay(chatTs(m)); if(d!==day){ day=d; html+=`<div class="ch-day"><span>${d}</span></div>`; } html+=chatMsgHTML(m, d===chatDay(chatTs(ms[i-1]||{}))?ms[i-1]:null); });
  box.innerHTML=html;
  if(keep==="top") box.scrollTop = box.scrollHeight-oldH+oldTop;
  else if(keep==="stay" || !atEnd) box.scrollTop=oldTop;
  else box.scrollTop=box.scrollHeight;
  if(ms.length) setChatSeen(Math.max(chatSeen(), chatTs(ms[ms.length-1])));
  paintPin();
}
function paintPin(){
  const el=$("#chPin"); if(!el) return; const p=S.chatPin;
  el.classList.toggle("hide", !p);
  if(p) el.innerHTML=`<button class="ch-pin-b" data-goto="${esc(p.id)}" type="button"><span class="ch-pin-i">📌</span><span><b style="color:${col(p.uid)}">${esc(pname(p.uid))}</b> ${esc(p.t)}</span></button>${S.isAdmin?`<button class="ch-act" id="chUnpin" type="button" aria-label="Sabitlemeyi kaldır">✕</button>`:""}`;
}
function paintMute(){ const b=$("#chMute"); if(!b) return; const m=chatMuted(); b.textContent = m ? "🔕" : "🔔"; b.setAttribute("aria-pressed", m); b.title = m ? "Sessizde: yalnızca seni anan mesajlar sayılır" : "Yeni mesajlar baloncukta sayılır"; b.setAttribute("aria-label", b.title); }
/* yazıyor göstergesi: sohbet açıkken dinlenir */
function startTyping(){
  if(S.typUnsub) return;
  S.typUnsub = onSnapshot(collection(S.db,"typing"), snap => { S.typing={}; snap.docs.forEach(d=>{ const a=d.data({serverTimestamps:"estimate"}).at; if(a?.toMillis) S.typing[d.id]=a.toMillis(); }); paintTyping(); }, () => {});
  clearInterval(S.typTick); S.typTick=setInterval(paintTyping, 2000);
}
function stopTyping(){ if(S.typUnsub){ S.typUnsub(); S.typUnsub=null; } clearInterval(S.typTick); clearTyping(); }
function paintTyping(){
  const el=$("#chTyping"); if(!el) return; const now=Date.now();
  const who=Object.entries(S.typing).filter(([u,t])=>u!==S.uid && now-t<TYPING_TTL && S.players[u]).map(([u])=>pname(u));
  el.textContent = !who.length ? "" : who.length===1 ? `${who[0]} yazıyor…` : who.length===2 ? `${who[0]} ve ${who[1]} yazıyor…` : `${who.length} kişi yazıyor…`;
}
function noteTyping(){
  const now=Date.now(); if(!$("#chIn").value.trim()) return clearTyping();
  if(now-(S.typSent||0) < 4000) return; S.typSent=now;
  setDoc(doc(S.db,"typing",S.uid), {at:serverTimestamp()}).catch(()=>{});
}
function clearTyping(){ if(!S.typSent || !S.uid) return; S.typSent=0; deleteDoc(doc(S.db,"typing",S.uid)).catch(()=>{}); }
/* yanıt ve düzenleme çubuğu */
function paintCtx(){
  const el=$("#chCtx"), r=S.chatReply, ed=S.chatEdit;
  el.classList.toggle("hide", !r && !ed);
  if(ed) el.innerHTML=`<span><b>Mesajını düzenliyorsun</b></span><button class="ch-act" id="chCtxX" type="button" aria-label="Vazgeç">✕</button>`;
  else if(r) el.innerHTML=`<span><b style="color:${col(r.uid)}">${esc(pname(r.uid))}</b> adlı kişiye yanıt: ${esc(r.t)}</span><button class="ch-act" id="chCtxX" type="button" aria-label="Vazgeç">✕</button>`;
}
function cancelCtx(){ if(S.chatEdit){ $("#chIn").value=""; chatCount(); } S.chatReply=null; S.chatEdit=null; paintCtx(); }
/* @ önerileri */
function paintMent(){
  const inp=$("#chIn"), el=$("#chMent"), before=inp.value.slice(0, inp.selectionStart ?? inp.value.length);
  const m=before.match(/(^|\s)@([^\s@]{0,20})$/);
  if(!m){ el.classList.add("hide"); S.mentList=[]; return; }
  const q=m[2].toLocaleLowerCase("tr");
  S.mentList=S.order.filter(u=>u!==S.uid && pname(u).toLocaleLowerCase("tr").startsWith(q)).slice(0,6);
  el.classList.toggle("hide", !S.mentList.length);
  el.innerHTML=S.mentList.map((u,i)=>`<button type="button" data-ment="${u}" class="${i===0?"on":""}">${avatar(u)}<span style="color:${col(u)}">${esc(pname(u))}</span></button>`).join("");
}
function pickMent(u){
  const inp=$("#chIn"), pos=inp.selectionStart ?? inp.value.length, before=inp.value.slice(0,pos), after=inp.value.slice(pos);
  const nb=before.replace(/@([^\s@]{0,20})$/, "@"+pname(u)+" ");
  inp.value=nb+after; inp.focus(); inp.setSelectionRange(nb.length, nb.length); $("#chMent").classList.add("hide"); S.mentList=[]; chatCount();
}
function openChat(){
  S.chatOpen=true; if(!S.chatUnsub) startChat(); startTyping(); const el=$("#chat"); el.classList.remove("hide"); document.body.style.overflow="hidden";
  try{ history.pushState({chat:1}, ""); }catch(e){}
  paintMute(); paintCtx(); paintChatList(); $("#chList").scrollTop=$("#chList").scrollHeight; chatBadge();
  if(matchMedia("(min-width:700px)").matches) $("#chIn").focus();
}
function closeChat(fromPop){
  if(!S.chatOpen) return; S.chatOpen=false; S.chatPick=null; $("#chat").classList.add("hide"); document.body.style.overflow="";
  stopTyping(); $("#chMent").classList.add("hide");
  const ms=S.chat; if(ms.length) setChatSeen(Math.max(chatSeen(), ...ms.map(chatTs)));
  chatBadge(); if(!fromPop && history.state?.chat){ S.popSkip=true; history.back(); }
}
addEventListener("popstate", ()=>{ if(S.chatOpen && !history.state?.chat) closeChat(true); });
document.addEventListener("keydown", e => { if(e.key==="Escape" && S.chatOpen){ if(S.chatReply||S.chatEdit) return cancelCtx(); closeChat(); } });
addEventListener("pagehide", ()=>clearTyping());
async function sendChat(){
  const inp=$("#chIn"), msg=$("#chMsg"), t=inp.value.replace(/\s+$/,"").replace(/^\s+/,"");
  if(!t) return;
  if(t.length>CHAT_MAX){ msg.textContent=`Mesaj en fazla ${CHAT_MAX} karakter olabilir.`; return; }
  if(chatProblem(t)){ msg.textContent="Bu mesajda küfür ya da hakaret var, gönderilmedi. Sohbette küfürlü kısaltmalar (amk, aq, oç…) da yazılamıyor."; return; }
  const btn=$("#chSend"); btn.disabled=true; msg.textContent="";
  const mn=chatMentions(t), edit=S.chatEdit, rp=S.chatReply;
  try{
    inp.value=""; chatCount(); $("#chMent").classList.add("hide");
    if(edit){
      S.chatEdit=null; paintCtx();
      await updateDoc(doc(S.db,"chat",edit), {t, mn, ed:serverTimestamp()});
    } else {
      const data={uid:S.uid, t, at:serverTimestamp(), re:{}};
      if(mn.length) data.mn=mn;
      if(rp) data.rp={id:rp.id, uid:rp.uid, t:rp.t};
      S.chatReply=null; paintCtx();
      await setDoc(doc(collection(S.db,"chat")), data);
      $("#chList").scrollTop=$("#chList").scrollHeight;
    }
    clearTyping();
  }catch(e){
    inp.value=inp.value||t; chatCount(); if(edit){ S.chatEdit=edit; } else if(rp){ S.chatReply=rp; } paintCtx();
    msg.textContent = edit && e?.code==="permission-denied" ? "Düzenleme süresi (2 dakika) doldu." : e?.code==="permission-denied" ? "Gönderilemedi. Sayfayı yenileyip tekrar dene." : "Gönderilemedi, bağlantını kontrol edip tekrar dene.";
  }
  btn.disabled=false; inp.focus();
}
function chatCount(){ const n=$("#chIn").value.length; $("#chCnt").textContent = n>CHAT_MAX-100 ? `${n}/${CHAT_MAX}` : ""; $("#chCnt").classList.toggle("over", n>CHAT_MAX);
  const inp=$("#chIn"); inp.style.height="auto"; inp.style.height=Math.min(120, inp.scrollHeight)+"px"; }
function chatGoto(id){
  const el=$(`#chList .ch-msg[data-id="${CSS.escape(id)}"]`);
  if(!el) return toast("Bu mesaj artık görünmüyor.");
  el.scrollIntoView({block:"center", behavior:"smooth"}); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
$("#chatFab").onclick=()=>openChat();
$("#chClose").onclick=()=>closeChat();
$("#chSend").onclick=()=>sendChat();
$("#chMute").onclick=()=>{ lsSet("chatMute", chatMuted()?"0":"1"); paintMute(); chatBadge(); toast(chatMuted()?"Sohbet sessizde: baloncukta yalnızca seni anan mesajlar sayılır.":"Sohbet bildirimleri açık."); };
$("#chIn").addEventListener("input", ()=>{ chatCount(); paintMent(); noteTyping(); });
$("#chIn").addEventListener("click", paintMent);
$("#chIn").addEventListener("blur", ()=>setTimeout(()=>{ if(document.activeElement?.closest?.("#chMent")) return; $("#chMent").classList.add("hide"); }, 200));
$("#chIn").addEventListener("keydown", e => {
  if(S.mentList?.length && !$("#chMent").classList.contains("hide") && (e.key==="Tab" || (e.key==="Enter" && !e.shiftKey))){ e.preventDefault(); return pickMent(S.mentList[0]); }
  if(e.key==="Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover:hover)").matches){ e.preventDefault(); sendChat(); }
});
$("#chMent").addEventListener("mousedown", e => e.preventDefault());
$("#chMent").addEventListener("click", e => { const b=e.target.closest("[data-ment]"); if(b) pickMent(b.dataset.ment); });
$("#chCtx").addEventListener("click", e => { if(e.target.closest("#chCtxX")) cancelCtx(); });
$("#chPin").addEventListener("click", async e => {
  if(e.target.closest("#chUnpin")){ try{ await setDoc(doc(S.db,"chatpin","main"), {id:""}); }catch(x){ toast("Kaldırılamadı."); } return; }
  const g=e.target.closest("[data-goto]"); if(g) chatGoto(g.dataset.goto);
});
$("#chList").addEventListener("click", async e => {
  if(e.target.closest("#chMore")){
    if(!S.chatLastDoc) return; const qd=await getDocs(query(collection(S.db,"chat"), orderBy("at","desc"), startAfter(S.chatLastDoc), limit(100))).catch(()=>null); if(!qd) return;
    S.chatOld.push(...qd.docs.map(d=>({id:d.id, ...d.data()}))); if(qd.docs.length<100) S.chatMore=false; else S.chatLastDoc=qd.docs[qd.docs.length-1];
    return paintChatList("top");
  }
  if(e.target.closest("a[href]")) return;
  const find = id => chatAll().find(x=>x.id===id);
  const g=e.target.closest("[data-goto]"); if(g) return chatGoto(g.dataset.goto);
  const pk=e.target.closest("[data-pick]"); if(pk){ S.chatPick = S.chatPick===pk.dataset.pick ? null : pk.dataset.pick; return paintChatList("stay"); }
  const rpb=e.target.closest("[data-rep]"); if(rpb){ const m=find(rpb.dataset.rep); if(!m) return;
    if(S.chatEdit){ S.chatEdit=null; $("#chIn").value=""; }
    S.chatReply={id:m.id, uid:m.uid, t:m.t.replace(/\s+/g," ").slice(0,100)}; paintCtx(); $("#chIn").focus(); return; }
  const eb=e.target.closest("[data-edit]"); if(eb){ const m=find(eb.dataset.edit); if(!m) return;
    if(Date.now()-chatTs(m) >= CHAT_EDIT) return toast("Düzenleme süresi (2 dakika) doldu.");
    S.chatReply=null; S.chatEdit=m.id; const inp=$("#chIn"); inp.value=m.t; chatCount(); paintCtx(); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); return; }
  const pb=e.target.closest("[data-pin]"); if(pb){ const m=find(pb.dataset.pin); if(!m) return;
    try{ await setDoc(doc(S.db,"chatpin","main"), S.chatPin?.id===m.id ? {id:""} : {id:m.id, uid:m.uid, t:m.t.replace(/\s+/g," ").slice(0,140), by:S.uid, at:serverTimestamp()}); toast(S.chatPin?.id===m.id?"Sabitleme kaldırıldı.":"Mesaj sabitlendi."); }catch(x){ toast("Sabitlenemedi."); }
    return; }
  const r=e.target.closest("[data-re]"); if(r){
    const m=find(r.dataset.m); if(!m) return; const mine=(m.re||{})[S.uid];
    S.chatPick=null;
    try{ await updateDoc(doc(S.db,"chat",m.id), {[`re.${S.uid}`]: mine===r.dataset.re ? deleteField() : r.dataset.re}); }catch(x){ toast("Tepki kaydedilemedi."); }
    return paintChatList("stay");
  }
  const d=e.target.closest("[data-del]"); if(d){
    if(d.dataset.sure!=="1"){ d.dataset.sure="1"; d.textContent="Emin misin?"; setTimeout(()=>{ if(d.isConnected){ d.dataset.sure=""; d.textContent="Sil"; } }, 3000); return; }
    const id=d.dataset.del;
    try{ await deleteDoc(doc(S.db,"chat",id)); S.chatOld=S.chatOld.filter(x=>x.id!==id); if(S.chatPin?.id===id && S.isAdmin) setDoc(doc(S.db,"chatpin","main"), {id:""}).catch(()=>{}); paintChatList("stay"); }catch(x){ toast("Silinemedi."); }
  }
});

// Şifre sıfırlama isteğinin sonucunu bekle (GitHub görevi birkaç dakikada bir çalışır)
const RESET_MSG = {
  ok:      ["ok",   "Şifren değişti. Yeni şifrenle giriş yapabilirsin."],
  wrong:   ["bad",  "Takım ya da oyuncu tutmadı. Tekrar deneyebilirsin (3 yanlıştan sonra 1 saat beklenir)."],
  badcode: ["bad",  "Maildeki kod tutmadı. Tekrar deneyebilirsin (3 yanlıştan sonra 1 saat beklenir)."],
  expired: ["bad",  "Kodun süresi dolmuş. Yeni bir kod iste."],
  locked:  ["bad",  "Çok fazla yanlış deneme oldu. 1 saat sonra tekrar dene."],
  nouser:  ["bad",  "Bu adla bir oyuncu bulunamadı. Adı kayıttaki gibi yazdığından emin ol."],
  nosetup: ["bad",  "Bu hesapta güvenlik sorusu yok. Oyunu kuran kişiden yardım iste."],
  error:   ["bad",  "İstek işlenemedi. Tekrar dene."]
};
let resetTimer=null;
function showResetWait(){
  let rq=null; try{ rq=JSON.parse(localStorage.getItem("resetReq")||"null"); }catch(e){}
  if(!rq) return;
  if(Date.now()-rq.t > 6*36e5){ try{localStorage.removeItem("resetReq");}catch(e){} return; }
  $("#authForm").classList.add("hide"); $("#authMode").classList.add("hide");
  const box=$("#resetWait"); box.classList.remove("hide");
  const done = () => { clearTimeout(resetTimer); try{localStorage.removeItem("resetReq");}catch(e){} };
  const back = (keep) => { clearTimeout(resetTimer); if(!keep) done(); box.classList.add("hide"); $("#authForm").classList.remove("hide"); $("#authMode").classList.remove("hide"); $("#inName").value=rq.name; $("#inPin").value=""; setAuthMode("login"); };
  const paint = st => {
    const m = st && RESET_MSG[st];
    box.innerHTML = m
      ? `<div class="reset-box ${m[0]}"><b>${m[0]==="ok"?"✓ Tamam":"Olmadı"}</b><p>${m[1]}</p></div><button class="btn-primary" id="rwBack" type="button">${m[0]==="ok"?"Giriş yap":"Geri dön"}</button>`
      : `<div class="reset-box"><div class="spin"></div><b>İsteğin alındı</b><p>Yeni şifren genelde 1-2 dakika içinde geçerli olur. Bu sayfayı açık bırakabilir ya da sonra dönebilirsin, sonuç burada görünür.</p></div><button class="linkish" id="rwBack" type="button">Girişe dön</button>`;
    $("#rwBack").onclick = () => m ? (back(false), m[0]!=="ok" && st!=="locked" && setAuthMode("reset")) : back(true);
    if(m) done();
  };
  paint(null);
  const poll = async () => {
    try{ const r=await getDoc(doc(S.db,"resetStatus",rq.id)); if(r.exists()){ paint(r.data().state); return; } }catch(e){}
    resetTimer=setTimeout(poll, 20e3);
  };
  poll();
}
$("#me").onclick=()=>openProfile();
$("#srch").onclick=()=>openSearch();
// Arama: ligdeki kişiler, NBA takımları ve oyuncular
async function openSearch(){
  openSheet(`<h3 id="shTitle">Ara</h3><input class="search" id="gSearch" placeholder="Kişi, takım ya da oyuncu" autocomplete="off"><div id="gRes" class="pl-list"></div>`);
  const inp=$("#gSearch"); setTimeout(()=>inp.focus(),60);
  await allPlayers().catch(()=>{});
  const norm=v=>(v||"").toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ı/g,"i");
  const paint=()=>{ const q=norm(inp.value.trim()); const el=$("#gRes"); if(!el) return;
    if(q.length<2){ el.innerHTML='<p class="muted">En az 2 harf yaz.</p>'; return; }
    const ppl=S.order.filter(u=>norm(pname(u)).includes(q)||norm(S.players[u]?.club).includes(q)).slice(0,5);
    const tms=(ALLP?.teams||[]).filter(t=>norm(t.n).includes(q)||norm(t.a)===q).slice(0,5);
    const pls=(ALLP?.players||[]).filter(x=>norm(x.n).includes(q)).slice(0,10);
    el.innerHTML = (ppl.length?`<div class="row-lbl">Ligdekiler</div>`+ppl.map(u=>`<button class="plr" data-gu="${u}">${avatar(u,"sm")}<span class="pi"><b>${esc(pname(u))}</b><small>${esc(S.players[u]?.club||"")}</small></span></button>`).join(""):"")
      + (tms.length?`<div class="row-lbl">Takımlar</div>`+tms.map(t=>`<button class="plr" data-tp="${t.a}"><img src="${LOGO_SMALL(t.a)}" alt=""><span class="pi"><b>${esc(t.n)}</b></span></button>`).join(""):"")
      + (pls.length?`<div class="row-lbl">Oyuncular</div>`+pls.map(x=>`<button class="plr" data-ath="${x.id}" data-athn="${esc(x.n)}" data-atht="${x.t}"><img src="${FACE(x.id)}" alt="" loading="lazy"><span class="pi"><b>${esc(x.n)}</b><small>${x.t}</small></span></button>`).join(""):"")
      || '<p class="muted">Sonuç yok.</p>'; };
  inp.oninput=paint; paint();
  $("#gRes").addEventListener("click", e=>{ const b=e.target.closest("[data-gu]"); if(b) openProf(b.dataset.gu); });
}
async function saveProfile(patch){
  const me=S.players[S.uid]; const old={...me};
  Object.assign(me, patch); applyTheme(); render(); paintProfile();
  try{ await updateDoc(doc(S.db,"players",S.uid), patch); }
  catch(e){ Object.assign(me, old); applyTheme(); render(); paintProfile(); toast("Kaydedilemedi, tekrar dene."); }
}
function paintMail(){
  const inp=$("#pfMail"); if(!inp) return;
  const email=inp.value.trim(), ver=!!(S.contact?.verified && S.contact.email===email);
  $("#pfMailSt").innerHTML = !email ? "" : ver ? '<span class="ok">✓ Onaylı</span>' : '<span class="need">Onaylanmadı</span>';
  $("#pfSendCode").classList.toggle("hide", !email || ver || S.otpSentTo===email);
  $("#pfOtp").classList.toggle("hide", ver || !S.otpSentTo || S.otpSentTo!==email);
}
function openProfile(tab="ozet"){ openProf(S.uid, tab); }
function paintProfile(){
  const box=$("#prof"); if(!box) return;
  const me=S.players[S.uid]||{};
  const usedBy = c => S.order.filter(u=>u!==S.uid && S.players[u]?.color===c).map(pname);
  const teams = ALLP?.teams || Object.keys(TEAM_COL).map(a=>({a,n:a}));
  const myInv=invitedBy(S.uid);
  box.innerHTML = `<div class="pf-sec pf-auto"><h4>🤖 Otomatik tahmin <span class="pf-st ${me.autoPick?"on":""}">${me.autoPick?"Açık":"Kapalı"}</span></h4><small class="muted" style="margin:0 0 8px;display:block">Bir gece hiç tahmin yapmazsan (maç, banko, günün oyuncusu, soru) her maçta ESPN'in favorisi senin yerine seçilir; doğru çıkan her 2 kazanan 1 puan. Fark, skorer ve banko yoktur.</small>
      <div class="seg2"><button data-ap="1" aria-pressed="${!!me.autoPick}">Açık</button><button data-ap="0" aria-pressed="${!me.autoPick}">Kapalı</button></div></div>
    <div class="pf-sec"><h4>Arkadaşını davet et</h4><small class="muted">Linkinle katılan herkes profilinde "Lige getirdiği" olarak görünür.${myInv.length?` Şimdiye kadar ${myInv.length} kişi getirdin: ${myInv.map(x=>esc(pname(x))).join(", ")}.`:""}</small>
      <button class="btn" id="pfInvite" type="button" style="margin-top:8px">${ICON.link}Davet linkimi paylaş</button><small class="muted" id="pfInvMsg"></small></div>
    <div class="pf-sec"><h4>Takım adın</h4><small class="muted">Sıralamada ve profilinde adının altında görünür (ör. Kyle Korver Sevenler Derneği). En fazla 40 karakter; küfür, argo ve hakaret yazılamaz.</small>
      <div class="adm-row" style="margin-top:6px"><input id="pfClub" class="adm-in" maxlength="40" placeholder="ör. Kyle Korver Sevenler Derneği" value="${esc(me.club||"")}"><button class="btn" id="pfClubSave" type="button">Kaydet</button></div>
      <small class="err" id="pfClubErr"></small></div>
    <div class="pf-sec"><h4>Hakkında</h4><small class="muted">Profilinde adının altında görünür. En fazla 60 karakter; küfür, argo ve hakaret yazılamaz.</small>
      <div class="adm-row" style="margin-top:6px"><input id="pfBio" class="adm-in" maxlength="60" placeholder="ör. Lakers'tan ölürüm" value="${esc(me.bio||"")}"><button class="btn" id="pfBioSave" type="button">Kaydet</button></div>
      <small class="err" id="pfBioErr"></small></div>
    <div class="pf-sec"><h4>Rengin</h4><div class="pf-colors">${PKEYS.map(c=>{ const u=usedBy(c); return `<button class="pf-col" data-col="${c}" style="--c:var(--${c})" aria-pressed="${col(S.uid)===`var(--${c})`}" title="${u.length?esc(u.join(", "))+" de kullanıyor":""}">${u.length?"<i></i>":""}</button>`; }).join("")}</div>
      <small class="muted">Noktalı renkleri başka oyuncular da kullanıyor.</small></div>
    <div class="pf-sec"><h4>Avatar</h4>
      <small class="muted" style="margin:0 0 8px;display:block">Avatarın bir basketbolcunun fotoğrafı olur.</small>
      <input class="search pf-avq" id="pfAvQ" placeholder="Oyuncu ara (ör. Curry)" autocomplete="off">
      <div class="pf-avs" id="pfAvs">${(()=>{ const cur=(/^p:(\w+)$/.exec(me.av||"")||[])[1]; const list=[...(cur && !STARS.some(x=>x[0]===cur) ? [[cur,(ALLP?.players||[]).find(x=>x.id===cur)?.n||""]] : []), ...STARS];
        return list.map(([id,n])=>`<button class="pf-av" data-av="p:${id}" aria-pressed="${me.av===`p:${id}`}" title="${esc(n)}"><img src="${HEADSHOT(id)}" alt="" loading="lazy"><small>${esc(surname(n))}</small></button>`).join(""); })()}</div>
        <small class="muted">Liste: CBS Sports'un 2026-27 sezonu ilk 50 oyuncusu. Başka bir oyuncu için yukarıdan ara.</small>
      ${avImg(me.av)?`<button class="linkish" data-emo="" style="font-size:13px">Fotoğrafı kaldır</button>`:""}</div>
    <div class="pf-sec"><h4>Favori takım</h4><small class="muted">Avatarının köşesinde küçük logosu görünür; site renklerini de buna göre seçebilirsin. Güvenlik sorusundan bağımsızdır.</small>
      <div class="pf-teams"><button class="pf-tm none" data-tm="" aria-pressed="${!me.favTeam}">Yok</button>${teams.map(t=>`<button class="pf-tm" data-tm="${t.a}" aria-pressed="${me.favTeam===t.a}" title="${esc(t.n)}"><img src="${LOGO_SMALL(t.a)}" alt="${esc(t.n)}"></button>`).join("")}</div></div>
    <div class="pf-sec"><h4>Site renkleri</h4><div class="seg2 pf-theme"><button data-th="default" aria-pressed="${me.theme!=="team"}">Varsayılan</button><button data-th="team" aria-pressed="${me.theme==="team"}" ${me.favTeam?"":"disabled"}>Favori takımım</button></div>
      <small class="muted">${me.favTeam?"Üst alan ve vurgu renkleri takımının renklerine geçer. Yalnızca sende görünür.":"Önce bir favori takım seç."}</small></div>
    <div class="pf-sec"><h4>Hatırlatma maili</h4><small class="muted" style="margin:0 0 8px">Günde en fazla bir özet maili gelir: akşam 21.00'de (ilk maç daha erkense maçtan 1 saat önce) eksik tahminlerin, seçtiğin oyuncuların sakatlıkları ve uzun vade haberleri tek mailde. Özetten sonra acil bir şey çıkarsa (bu geceki seçimin oynamıyor, uzun vade kilidine birkaç saat kaldı) o gün en fazla bir ek mail gelir. Mail gelmesi için adresini bir kez onaylaman gerekir. Adresini yalnızca sen görürsün.</small>
      <div class="pf-mail"><input id="pfMail" type="email" inputmode="email" autocomplete="email" placeholder="ornek@gmail.com" value="${esc(S.contact?.email||"")}"><span class="mail-st" id="pfMailSt"></span></div>
      <div id="pfOtp" class="pf-otp hide"><small class="muted" id="pfOtpMsg"></small>
        <div class="adm-row"><input id="pfCode" class="adm-in otp-in" inputmode="numeric" maxlength="6" placeholder="6 haneli kod" autocomplete="one-time-code"><button class="btn" id="pfCodeOk" type="button">Onayla</button></div>
        <button class="linkish" id="pfResend" type="button">Kodu tekrar gönder</button></div>
      <button class="btn" id="pfSendCode" type="button" style="margin-top:8px">Onay kodu gönder</button>
      <label class="pf-sw pf-sw2"><input type="checkbox" id="pfRemind" ${S.contact?.remind?"checked":""}><span></span>Eksik tahmin ve sakatlık uyarıları</label>
      <label class="pf-sw pf-sw2"><input type="checkbox" id="pfWeekly" ${S.contact?.weekly?"checked":""}><span></span>Pazartesi günleri haftalık özet</label>
      <button class="btn" id="pfMailSave" style="margin-top:10px">Tercihleri kaydet</button><small class="muted" id="pfMailMsg"></small></div>
    <div class="pf-sec"><button class="btn admin-btn" id="histBtn" type="button">${ICON.list}Tahmin geçmişim</button></div>
    ${S.isAdmin?`<div class="pf-sec"><button class="btn admin-btn" id="adminBtn" type="button">${ICON.tools}Yönetim paneli</button></div>`:""}
    <div class="pf-sec pf-acts"><button class="btn" id="secChange">Güvenlik sorusunu değiştir</button><button class="btn" id="logout">Çıkış yap</button></div>
    ${S.isAdmin?"":`<div class="pf-sec pf-del"><h4>Profilimi sil</h4><small class="muted" style="display:block;margin:0 0 8px">Hesabın, bütün tahminlerin, uzun vade seçimlerin, sohbet mesajların ve mail adresin <b>kalıcı olarak</b> silinir; puan tablosundan çıkarsın. Geri alınamaz. Aynı adla sonra yeniden kayıt olabilirsin.</small>
      <div class="adm-row"><input id="pfDelOk" class="adm-in" maxlength="40" autocomplete="off" placeholder="Onay için adını yaz: ${esc(me.name||"")}"><button class="btn danger" id="pfDel" type="button">Profilimi sil</button></div>
      <small class="err" id="pfDelErr"></small></div>`}`;
  if(!ALLP) allPlayers().then(()=>paintProfile()).catch(()=>{});
  box.onclick = e => {
    const c=e.target.closest("[data-col]"); if(c) return saveProfile({color:c.dataset.col});
    const av=e.target.closest("[data-av]"); if(av) return saveProfile({av:av.dataset.av, emoji:""});
    const m=e.target.closest("[data-emo]"); if(m) return saveProfile({emoji:m.dataset.emo, av:""});
    const t=e.target.closest("[data-tm]"); if(t) return saveProfile(t.dataset.tm ? {favTeam:t.dataset.tm} : {favTeam:"", theme:"default"});
    const h=e.target.closest("[data-th]"); if(h && !h.disabled) return saveProfile({theme:h.dataset.th});
    const ap=e.target.closest("[data-ap]"); if(ap) return saveProfile({autoPick: ap.dataset.ap==="1"});
  };
  $("#pfAvQ")?.addEventListener("input", e=>{ const q=slug(e.target.value||""); const box2=$("#pfAvs"); if(!box2) return;
    const list = q.length<2 ? STARS : (ALLP?.players||[]).filter(x=>slug(x.n).includes(q)).slice(0,30).map(x=>[x.id,x.n]);
    box2.innerHTML = list.map(([id,n])=>`<button class="pf-av" data-av="p:${id}" title="${esc(n)}"><img src="${HEADSHOT(id)}" alt="" loading="lazy"><small>${esc(surname(n))}</small></button>`).join("") || '<p class="muted">Oyuncu bulunamadı.</p>'; });
  $("#secChange").onclick=()=>openRecoverySheet(false);
  $("#adminBtn")?.addEventListener("click", openAdmin);
  $("#histBtn").onclick = () => openHistory();
  $("#pfInvite").onclick = () => shareInvite($("#pfInvMsg"));
  $("#pfClub").oninput = () => { const v=$("#pfClub").value.trim().replace(/\s+/g," "); $("#pfClubErr").textContent = v ? (clubProblem(v)||"") : ""; };
  $("#pfClubSave").onclick = async () => {
    const v=$("#pfClub").value.trim().replace(/\s+/g," "); const p=clubProblem(v);
    if(p) return $("#pfClubErr").textContent=p;
    $("#pfClubErr").textContent=""; await saveProfile({club:v}); toast(v?"Takım adın kaydedildi.":"Takım adın kaldırıldı.");
  };
  $("#pfBioSave").onclick = async () => {
    const v=$("#pfBio").value.trim().replace(/\s+/g," ");
    if(v.length>60) return $("#pfBioErr").textContent="En fazla 60 karakter.";
    if(v && (textProblem(v) || bioProblem(v))) return $("#pfBioErr").textContent="Küfür, argo ya da hakaret içeremez.";
    $("#pfBioErr").textContent=""; await saveProfile({bio:v}); toast(v?"Hakkında yazın kaydedildi.":"Hakkında yazın kaldırıldı.");
  };
  $("#logout").onclick=async()=>{ closeSheet(); S.contact=null; await signOut(S.auth); applyTheme(); };
  $("#pfDel")?.addEventListener("click", ()=>{
    const v=($("#pfDelOk").value||"").trim(), nm=(S.players[S.uid]?.name||"").trim();
    if(!nm || v.toLocaleLowerCase("tr")!==nm.toLocaleLowerCase("tr")){ $("#pfDelErr").textContent=`Onaylamak için kutuya adını (${nm}) yaz.`; return; }
    confirmBtn($("#pfDel"), "Emin misin? Tekrar dokun", async()=>{
      try{ await setDoc(doc(S.db,"deleteReq",S.uid), {at:serverTimestamp()});
        closeSheet(); toast("Profilin siliniyor; yarım dakika içinde tamamen kaldırılır. Görüşmek üzere!", 5000);
        setTimeout(async()=>{ S.contact=null; try{ await signOut(S.auth); }catch(e){} applyTheme(); }, 1500);
      }catch(e){ $("#pfDelErr").textContent="İstek gönderilemedi, tekrar dene."; } });
  });
  if(!S.contact && !S.contactLoading){
    S.contactLoading=true;
    getDoc(doc(S.db,"contacts",S.uid)).then(r=>{ S.contactLoading=false; S.contact = r.exists() ? r.data() : {email:"",remind:false}; if($("#pfMail")){ $("#pfMail").value=S.contact.email||""; $("#pfRemind").checked=!!S.contact.remind; $("#pfWeekly").checked=!!S.contact.weekly; paintMail(); } }).catch(()=>{ S.contactLoading=false; });
  }
  const contactData = (extra={}) => { const email=$("#pfMail").value.trim();
    const ver = !!(S.contact?.verified && S.contact.email===email);
    return {email, remind:$("#pfRemind").checked, weekly:$("#pfWeekly").checked, verified:ver, updatedAt:serverTimestamp(), ...extra}; };
  const validMail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  $("#pfMail").oninput = paintMail;
  $("#pfMailSave").onclick = async () => {
    const d=contactData(), msg=$("#pfMailMsg");
    if(d.email && !validMail(d.email)){ msg.textContent="E-posta adresi geçerli görünmüyor."; return; }
    if((d.remind||d.weekly) && !d.email){ msg.textContent="Önce bir e-posta adresi yaz."; return; }
    $("#pfMailSave").disabled=true;
    try{ await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d};
      msg.textContent = !(d.remind||d.weekly) ? "Kaydedildi. Mail gelmeyecek." : d.verified ? "Kaydedildi." : "Kaydedildi. Mail gelmesi için adresini onaylaman gerekiyor."; paintMail(); }
    catch(e){ msg.textContent="Kaydedilemedi, tekrar dene."; }
    $("#pfMailSave").disabled=false;
  };
  const sendCode = async () => {
    const email=$("#pfMail").value.trim(), msg=$("#pfOtpMsg");
    if(!validMail(email)){ $("#pfMailMsg").textContent="Önce geçerli bir e-posta adresi yaz."; return; }
    $("#pfSendCode").disabled=true;
    try{
      const d=contactData(); await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d};
      await setDoc(doc(S.db,"verifyReq",S.uid), {email, at:serverTimestamp()});
      S.otpSentTo=email; paintMail();
      msg.textContent=`Kod ${email} adresine gönderilecek. Genelde 1-2 dakika içinde gelir, gelince buraya yaz. Gereksiz klasörüne de bak.`;
    }catch(e){ $("#pfMailMsg").textContent="İstek gönderilemedi, tekrar dene."; }
    $("#pfSendCode").disabled=false;
  };
  $("#pfSendCode").onclick = sendCode;
  $("#pfResend").onclick = sendCode;
  $("#pfCodeOk").onclick = async () => {
    const code=$("#pfCode").value.trim(), msg=$("#pfOtpMsg");
    if(!/^\d{6}$/.test(code)){ msg.textContent="Kod 6 rakam olmalı."; return; }
    $("#pfCodeOk").disabled=true;
    try{ const d=contactData({verified:true, code}); await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d, code:undefined}; S.otpSentTo=null;
      $("#pfMailMsg").textContent="E-posta adresin onaylandı."; paintMail(); renderBanners(); toast("E-posta adresin onaylandı."); }
    catch(e){ msg.textContent="Kod yanlış ya da süresi dolmuş. Tekrar dene ya da yeni kod iste."; }
    $("#pfCodeOk").disabled=false;
  };
  paintMail();

}
// Takım teması: üst alan ve vurgu rengi favori takımın renklerine geçer (yalnızca o oyuncuda)
function paintMe(){ const p=S.players[S.uid]||{}; const img=avImg(p.av); $("#me").innerHTML = img ? img.replace('class="av-img','class="me-img') : ("" || esc(pname(S.uid).slice(0,1).toLocaleUpperCase("tr"))); $("#me").style.setProperty("--pc", col(S.uid)); $("#me").classList.add("me-btn"); }
function applyTheme(){
  if(S.uid) paintMe();
  const r=document.documentElement.style, me=S.uid && S.players[S.uid];
  const keys=["--board","--board-2","--board-line","--amber","--amber-ink","--amber-soft","--on-amber"];
  const tc = me && me.theme==="team" && TEAM_COL[me.favTeam];
  if(!tc){ keys.forEach(k=>r.removeProperty(k)); $('meta[name="theme-color"]')?.setAttribute("content","#0f1620"); return; }
  const [c1,c2] = tc.map(h=>"#"+h);
  const acc = lum(tc[1]) > .12 && lum(tc[1]) < .85 ? c2 : lum(tc[0]) > .06 ? c1 : c2;
  const base = `color-mix(in srgb, ${c1} 32%, #070b10)`;
  r.setProperty("--board", base);
  r.setProperty("--board-2", `color-mix(in srgb, ${c1} 30%, #18222e)`);
  r.setProperty("--board-line", `color-mix(in srgb, ${c1} 35%, #2a3646)`);
  r.setProperty("--amber", acc);
  r.setProperty("--on-amber", lum(acc.slice(1)) > .28 ? "#1a1200" : "#fff");   // vurgu renginin üstündeki yazı okunsun
  // yazı olarak kullanılan vurgu rengi: zeminle en az 4.5 zıtlık olana kadar açılır (koyu tema) ya da koyulaşır (açık tema)
  r.setProperty("--amber-ink", readableOn(acc, isDark() ? ["18212c","10161e"] : ["ffffff","eef1f4"]));
  r.setProperty("--amber-soft", `color-mix(in srgb, ${acc} 18%, var(--panel))`);
  // tarayıcı çubuğunun rengi
  const n=parseInt(tc[0],16), mix=v=>Math.round(v*.32+ [7,11,16][mixi++]*.68); let mixi=0;
  $('meta[name="theme-color"]')?.setAttribute("content", "#"+[n>>16&255,n>>8&255,n&255].map(v=>mix(v).toString(16).padStart(2,"0")).join(""));
}

/* ====================================================== yönetim paneli (yalnızca yönetici) */
// İki adımlı onay: ilk dokunuşta düğme "Emin misin?" olur, 4 sn içinde ikinci dokunuş işi yapar
function confirmBtn(btn, label, fn){
  if(btn.dataset.armed){ delete btn.dataset.armed; clearTimeout(btn._t); fn(); return; }
  const old=btn.textContent; btn.dataset.armed="1"; btn.textContent=label; btn.classList.add("armed");
  btn._t=setTimeout(()=>{ delete btn.dataset.armed; btn.textContent=old; btn.classList.remove("armed"); }, 4000);
}
async function openAdmin(){
  S.sheetLocked=false;
  openSheet(`<h3 id="shTitle">Yönetim paneli</h3><p class="muted">Bu bölümü yalnızca sen görüyorsun.</p><div id="adm"><p class="muted">Yükleniyor…</p></div>`);
  let banned=[];
  try{ const snap=await getDocs(collection(S.db,"banned")); snap.forEach(x=>banned.push({uid:x.id,...x.data()})); }catch(e){}
  await loadLeague();
  try{ S.purge=(await getDoc(doc(S.db,"league","purge"))).data()||null; }catch(e){}
  const st=leagueStart(), hist=S.league?.history||[];
  const first=S.days[S.today]?.games.some(started);
  const opts=[[first?shiftDay(S.today,1):S.today, first?"Yarın geceden":"Bu geceden"], [shiftDay(S.today,first?2:1), first?"Öbür geceden":"Yarın geceden"]];
  const tot=seasonTotals();
  // oyuncu durumu: son tahmin gecesi, takım adı, mail onayı
  const cts={}; await Promise.all(S.order.map(u=>getDoc(doc(S.db,"contacts",u)).then(r=>{ cts[u]=r.exists()?r.data():null; }).catch(()=>{})));
  const lastDay=u=>Object.keys(S.arch.scores.days||{}).filter(d=>S.arch.scores.days[d][u]?.n).sort().pop();
  const lastNight=allDays().find(d=>S.arch.scores.days?.[d]); const played=lastNight?S.order.filter(u=>S.arch.scores.days[lastNight]?.[u]?.n).length:0;
  let reports=[]; try{ const snap=await getDocs(collection(S.db,"reports")); snap.forEach(x=>reports.push({id:x.id,...x.data()})); }catch(e){}
  reports.sort((a,b)=>(b.at?.toMillis?.()||0)-(a.at?.toMillis?.()||0));
  const summary = `<div class="pf-sec"><h4>Durum</h4><p class="muted" style="margin:0 0 8px">${lastNight?`Son gece (${dayNice(lastNight,{day:"numeric",month:"short"})}) ${played}/${S.order.length} oyuncu tahmin yaptı.`:""}</p>
      <div class="adm-sum">${S.order.map(u=>{ const ld=lastDay(u), gap=ld?Math.round((parseYmd(S.today)-parseYmd(ld))/864e5):null, c=cts[u];
        return `<div class="adm-s"><span><b style="color:${col(u)}">${esc(pname(u))}</b><small>${esc(S.players[u].club||"takım adı yok")}</small></span>
          <span class="${gap==null||gap>3?"bad":gap>1?"warn":"ok"}">${gap==null?"hiç oynamadı":gap===0?"bu gece":gap===1?"dün":gap+" gündür yok"}</span>
          <span class="${c?.verified?"ok":"bad"}">${c?.verified?"mail onaylı":c?.email?"mail onaysız":"mail yok"}</span>
          <span class="muted">${(()=>{ const nights=Object.values(S.arch.scores.days||{}).filter(r=>r[u]?.n).length, sn=S.players[u]?.seen; const ago=sn?Math.round((Date.now()-sn)/36e5):null;
            return `${nights} gece oynadı · son giriş ${ago==null?"bilinmiyor":ago<1?"az önce":ago<24?ago+" sa önce":Math.round(ago/24)+" gün önce"}${S.players[u]?.autoPick?" · otomatik tahmin açık":""}`; })()}</span></div>`; }).join("")}</div></div>
    <div class="pf-sec"><h4>İstekler ve sorunlar ${reports.length?`<span class="pill-n">${reports.length}</span>`:""}</h4>${reports.length?reports.map(r=>`<div class="adm-rep"><div><b style="color:${col(r.uid)}">${esc(pname(r.uid))}</b> <span class="pill-k">${esc((REP_KINDS.find(x=>x[0]===r.kind)||REP_KINDS[0])[1])}</span> <small class="muted">${r.at?.toDate?r.at.toDate().toLocaleString(LOC,{timeZone:TZ,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):""} · ${esc(r.v||"")} · ${esc(r.tab||"")}</small></div><p>${esc(r.text||"")}</p><small class="muted">${esc(r.ua||"")}</small><button class="btn sm danger" data-repdel="${r.id}" type="button">Çözüldü, sil</button></div>`).join(""):'<small class="muted">Bildirim yok.</small>'}</div>`;
  $("#adm").innerHTML = summary + `
    <div class="pf-sec"><h4>Lig</h4>
      <p class="muted" style="margin:0 0 8px">Şu anki lig <b>${dayNice(st,{day:"numeric",month:"long"})}</b> gecesinden beri sayılıyor${hist.length?`, ${hist.length} geçmiş lig var`:""}.</p>
      <p style="margin:0 0 8px;font-size:14px">Ligi sıfırlarsan bütün puanlar, rozetler ve istatistikler seçtiğin geceden itibaren sıfırdan sayılır. Şu anki puan durumu "Geçmiş ligler"e kaydedilir, tahminler silinmez.</p>
      <div class="adm-row"><select id="admStart" class="adm-in">${opts.map(([d,l])=>`<option value="${d}">${l} (${dayNice(d,{day:"numeric",month:"long"})})</option>`).join("")}<option value="custom">Başka bir gece…</option></select>
      <input type="date" id="admDate" class="adm-in hide"></div>
      <input id="admSeason" class="adm-in" maxlength="40" placeholder="Biten dönemin adı (ör. 2026 sonbaharı)" style="margin:8px 0">
      <label class="adm-trial"><input type="checkbox" id="admTrialOn"> Deneme haftası olarak başlat; puanlar şu tarihten sonra kendiliğinden sıfırlansın:</label>
      <input type="date" id="admTrialEnd" class="adm-in hide" style="margin:6px 0 8px">
      <button class="btn danger" id="admReset" type="button">Ligi sıfırla / yeni sezon</button><small class="muted" id="admResetMsg"></small>
      ${trialOf()?`<p class="muted" style="margin:10px 0 0">🧪 Deneme haftası ${dayNice(trialOf().end,{day:"numeric",month:"long"})} gecesi bitiyor; ${dayNice(shiftDay(trialOf().end,1),{day:"numeric",month:"long"})} sabahı lig kendiliğinden sıfırlanır.</p>`:""}</div>
    <div class="pf-sec"><h4>Herkesi sil (yeniden kayıt)</h4>
      <p style="margin:0 0 8px;font-size:14px">Senin ve yöneticilerin dışındaki <b>bütün oyuncuların hesabı ve verisi</b> (tahminler, uzun vade seçimleri, sohbet, mail adresleri) kalıcı olarak silinir; aynı adla yeniden kayıt olabilirler. Sohbet de tamamen temizlenir. <b>Geri alınamaz.</b></p>
      <div class="adm-row"><input id="admPurgeOk" class="adm-in" maxlength="10" placeholder='Onay için SİL yaz' autocomplete="off"><button class="btn danger" id="admPurge" type="button">Herkesi sil</button></div>
      <small class="muted" id="admPurgeMsg">${S.purge?.state==="pending"?"Silme isteği sırada; yarım dakika içinde yapılır.":S.purge?.state==="done"?`Son silme: ${S.purge.n||0} oyuncu silindi.`:S.purge?.state==="error"?"Son silme isteği yapılamadı.":""}</small></div>
    <div class="pf-sec"><h4>Oyuncular</h4><div class="adm-pl">${S.order.map(u=>`<div class="adm-p">${avatar(u,"sm")}<span><b>${esc(pname(u))}</b><small>${tot[u]??0} puan · ${new Date(S.players[u].joined).toLocaleDateString(LOC,{timeZone:TZ,day:"numeric",month:"long"})} katıldı</small></span>
      ${u===S.uid?'<small class="muted">sen</small>':`<button class="btn danger sm" data-kick="${u}" type="button">Ligden çıkar</button>`}</div>`).join("")}</div>
      ${banned.length?`<h4 style="margin-top:12px">Çıkarılanlar</h4><div class="adm-pl">${banned.map(b=>`<div class="adm-p"><span class="av sm empty">?</span><span><b>${esc(b.name||"?")}</b><small>tekrar katılamaz</small></span><button class="btn sm" data-unban="${b.uid}" type="button">Geri al</button></div>`).join("")}</div>`:""}
      <small class="muted">Çıkarılan oyuncu sitede görünmez, puanları sayılmaz ve davet koduyla yeniden katılamaz.</small></div>
    <div class="pf-sec"><h4>Davet kodu</h4><div class="adm-row"><input id="admInv" class="adm-in" value="${esc(S.invite||"")}" maxlength="40"><button class="btn" id="admInvSave" type="button">Kaydet</button></div>
      <small class="muted" id="admInvMsg">Yeni oyuncular bu kodla katılır. Kodu değiştirince eski kod ve eski link çalışmaz.</small>
      <button class="btn" id="admLink" type="button" style="margin-top:8px">${ICON.link}Davet linkini paylaş</button></div>
    <div class="pf-sec"><h4>Uzun vade</h4><button class="btn" id="admLT" type="button">${ICON.medal}Sonuçları gir</button></div>
    <div class="pf-sec"><h4>Duyuru</h4><small class="muted" style="margin:0 0 8px">Sitenin üstünde herkese görünür. Kapatan bir daha görmez; yeni duyuru yine çıkar.</small>
      <textarea id="admNotice" class="adm-in" rows="2" maxlength="200" placeholder="ör. Yeni oyuncu: Zeki 👋">${esc(S.notice?.text||"")}</textarea>
      <div class="adm-row" style="margin-top:8px"><button class="btn" id="admNoticeSave" type="button">Yayınla</button>${S.notice?.text?'<button class="btn danger" id="admNoticeDel" type="button">Kaldır</button>':""}</div>
      <small class="muted" id="admNoticeMsg"></small></div>`;
  $("#admLT")?.addEventListener("click", ()=>allPlayers().catch(()=>{}).then(openLTAdmin));
  $("#admStart").onchange=()=>$("#admDate").classList.toggle("hide", $("#admStart").value!=="custom");
  $("#admTrialOn").onchange=()=>$("#admTrialEnd").classList.toggle("hide", !$("#admTrialOn").checked);
  $("#admPurge").onclick=async()=>{
    const v=($("#admPurgeOk").value||"").trim().toLocaleUpperCase("tr");
    if(v!=="SİL"){ $("#admPurgeMsg").textContent='Onaylamak için kutuya SİL yaz.'; return; }
    try{ await setDoc(doc(S.db,"league","purge"), {state:"pending", by:S.uid, at:serverTimestamp()}); $("#admPurgeMsg").textContent="Silme isteği gönderildi; arka plan görevi yarım dakika içinde yapar. Bu pencere sonucu gösterecek.";
      const t0=Date.now(); const poll=async()=>{ const d=(await getDoc(doc(S.db,"league","purge")).catch(()=>null))?.data(); S.purge=d;
        if(d?.state==="done"){ $("#admPurgeMsg").textContent=`Tamam: ${d.n||0} oyuncu silindi. Sayfa yenileniyor…`; setTimeout(()=>location.reload(), 2500); return; }
        if(d?.state==="error"){ $("#admPurgeMsg").textContent="Silinemedi: "+(d.err||"bilinmeyen hata"); return; }
        if(Date.now()-t0<10*60e3 && $("#admPurgeMsg")) setTimeout(poll, 5000); }; setTimeout(poll, 5000);
    }catch(e){ $("#admPurgeMsg").textContent="İstek gönderilemedi."; }
  };
  $("#admReset").onclick=e=>confirmBtn(e.currentTarget,"Emin misin? Tekrar dokun",async()=>{
    let ns=$("#admStart").value; if(ns==="custom"){ const v=$("#admDate").value; if(!v){ $("#admResetMsg").textContent="Bir tarih seç."; return; } ns=v.replaceAll("-",""); }
    const t=seasonTotals(), nights={}; for(const n of nightsOf()) if(n.w.st==="w") nights[n.w.u]=(nights[n.w.u]||0)+1;
    const rows=[...S.order].sort((a,b)=>(t[b]||0)-(t[a]||0)).map(u=>({uid:u, name:pname(u), pts:t[u]||0, nights:nights[u]||0}));
    const aw=Object.values(S.arch.scores.awards||{}).flatMap(a=>(a.list||[]).filter(x=>x.u?.length).map(x=>`${a.title}: ${x.t} – ${x.u.map(pname).join(", ")}`)).slice(0,30);
    const entry={start:leagueStart(), end:shiftDay(ns,-1), rows, at:new Date().toISOString(), name:($("#admSeason").value||"").trim().slice(0,40), awards:aw,
      lt:Object.fromEntries(S.order.map(u=>[u, S.lt?.loaded?ltPoints(u):0]))};
    const history=[...(S.league?.history||[]), ...(rows.some(r=>r.pts) ? [entry] : [])];
    let trial=null;
    if($("#admTrialOn").checked){ const te=($("#admTrialEnd").value||"").replaceAll("-","");
      if(!/^\d{8}$/.test(te) || te<ns){ $("#admResetMsg").textContent="Deneme haftasının bitiş gecesini seç (başlangıçtan sonra)."; return; }
      trial={end:te, name:"Deneme haftası"}; }
    const next={start:ns, history, ...(trial?{trial}:{})};
    try{ await setDoc(doc(S.db,"league","settings"), next); S.league=next; applyLeague(); render(); renderBanners(); toast(trial?"Lig deneme haftasıyla başladı.":"Lig sıfırlandı."); openAdmin(); }
    catch(err){ $("#admResetMsg").textContent="Kaydedilemedi, tekrar dene."; }
  });
  $("#adm").addEventListener("click", async e=>{ const rd=e.target.closest("[data-repdel]"); if(rd){ try{ await deleteDoc(doc(S.db,"reports",rd.dataset.repdel)); rd.closest(".adm-rep").remove(); }catch(x){ toast("Silinemedi."); } return; } });
  $("#adm").addEventListener("click", e=>{
    const k=e.target.closest("[data-kick]"); if(k) return confirmBtn(k,"Emin misin?",async()=>{
      const u=k.dataset.kick, p=S.players[u];
      try{ await setDoc(doc(S.db,"banned",u), {name:p.name, joined:Timestamp.fromMillis(p.joined), at:serverTimestamp()}); await deleteDoc(doc(S.db,"players",u));
        await loadPlayers(); render(); toast(`${p.name} ligden çıkarıldı.`); openAdmin(); }catch(err){ toast("Yapılamadı, tekrar dene."); }
    });
    const ub=e.target.closest("[data-unban]"); if(ub) return confirmBtn(ub,"Emin misin?",async()=>{
      const b=banned.find(x=>x.uid===ub.dataset.unban);
      try{ await setDoc(doc(S.db,"players",b.uid), {name:b.name, joined:b.joined}); await deleteDoc(doc(S.db,"banned",b.uid));
        await loadPlayers(); render(); toast(`${b.name} geri alındı.`); openAdmin(); }catch(err){ toast("Yapılamadı, tekrar dene."); }
    });
  });
  $("#admLink").onclick=async()=>{
    const url=`${location.origin}${location.pathname}?davet=${encodeURIComponent(S.invite||"")}`;
    const text=`NBA Tahmin'e katıl! Her gece maçlara tahmin yapıyoruz: ${url}`;
    try{ if(navigator.share){ await navigator.share({title:"NBA Tahmin", text, url}); return; } }catch(e){ if(e.name==="AbortError") return; }
    try{ await navigator.clipboard.writeText(url); $("#admInvMsg").textContent="Link kopyalandı: "+url; }catch(e){ $("#admInvMsg").textContent=url; }
  };
  $("#admNoticeSave").onclick=async()=>{ const text=$("#admNotice").value.trim(); if(!text) return;
    const n={text, at:Date.now()};
    try{ await setDoc(doc(S.db,"league","notice"), n); S.notice=n; renderBanners(); $("#admNoticeMsg").textContent="Duyuru yayınlandı."; }catch(e){ $("#admNoticeMsg").textContent="Yayınlanamadı."; } };
  $("#admNoticeDel")?.addEventListener("click", async()=>{ try{ await deleteDoc(doc(S.db,"league","notice")); S.notice=null; renderBanners(); openAdmin(); }catch(e){ $("#admNoticeMsg").textContent="Kaldırılamadı."; } });
  $("#admInvSave").onclick=async()=>{ const v=$("#admInv").value.trim(); if(!v) return;
    try{ await setDoc(doc(S.db,"config","secret"),{invite:v}); S.invite=v; $("#admInvMsg").textContent="Davet kodu değişti."; }catch(err){ $("#admInvMsg").textContent="Kaydedilemedi."; } };
}
/* ====================================================== ana ekrana ekle */
let installEvt=null;
addEventListener("beforeinstallprompt", e=>{ e.preventDefault(); installEvt=e; setTimeout(installBanner, 4000); });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
function installBanner(){
  if(!S.uid || isStandalone() || $("#installBar")) return;
  const t=+(lsGet("installAsk")||0); if(Date.now()-t < 7*864e5) return;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent) && !installEvt;
  if(!installEvt && !ios) return;
  const el=document.createElement("div"); el.id="installBar"; el.className="install-bar";
  el.innerHTML=`<img src="icons/icon-192.png" alt=""><span><b>NBA Tahmin'i ana ekrana ekle</b><small>${ios?"Safari'de alttaki Paylaş düğmesine, sonra \"Ana Ekrana Ekle\"ye dokun.":"Uygulama gibi tek dokunuşla açılır."}</small></span>${ios?"":`<button class="btn" id="instOk" type="button">Ekle</button>`}<button class="linkish" id="instNo" type="button">Kapat</button>`;
  document.body.appendChild(el);
  $("#instNo").onclick=()=>{ lsSet("installAsk", String(Date.now())); el.remove(); };
  $("#instOk")?.addEventListener("click", async()=>{ el.remove(); try{ installEvt.prompt(); await installEvt.userChoice; }catch(e){} installEvt=null; });
}
/* ====================================================== başlangıç */
// Servis çalışanı kaldırıldı (mobilde eski/yeni dosya karışmasına yol açıyordu): telefonda kalmışsa silinir, önbelleği temizlenir
if("serviceWorker" in navigator){ navigator.serviceWorker.getRegistrations?.().then(rs=>{ if(!rs.length) return;
  rs.forEach(r=>r.update().catch(()=>{}).finally(()=>r.unregister().catch(()=>{})));
  if("caches" in window) caches.keys().then(ks=>ks.forEach(k=>caches.delete(k))).catch(()=>{}); }).catch(()=>{}); }
(async()=>{
  // Hız: bugünün maç listesi Firebase ve giriş beklenmeden hemen istenir
  { const d=espnToday(); S.preSB = {day:d, p:espn(`/scoreboard?dates=${d}&limit=50`).catch(()=>null)}; }
  let ok=false;
  try{ ok = await initFirebase(); }catch(e){ console.error(e); }
  if(!ok){ $("#auth").classList.remove("hide"); $("#authForm").innerHTML=`<div class="note">Kurulum bekleniyor: config.json içine Firebase bilgileri girilince oyun açılacak.</div>`; return; }
  S.today = espnToday(); S.day = S.today;
  // açılış en fazla 8 sn bekler; geç gelen veri ekran açıldıktan sonra yerine oturur
  const boot = Promise.all([loadPlayers().catch(()=>{}), loadArchive().catch(()=>{})]);
  if(await withTimeout(boot, 8000)==="timeout"){ console.warn("açılış verisi gecikti"); boot.then(()=>{ if(S.uid){ applyLeague?.(); render(); } else paintLgPick?.(); }); }
  { const last=lsGet("lastUser"); if(last && S.players[last]){ S.lgUser=last; $("#inName").value=pname(last); } }
  setAuthMode(Q.get("davet") ? "join" : "login"); paintAuthInvite(); renderAuthLive();
  onAuthStateChanged(S.auth, async user=>{
    if(!user){ S.uid=null; $("#app").classList.add("hide"); $("#me").classList.add("hide"); $("#srch").classList.add("hide"); $("#invBtn").classList.add("hide"); stopChat(); closeChat(); $("#auth").classList.remove("hide"); paintLgPick(); showResetWait(); dispatchEvent(new Event("app-ready")); return; }
    S.uid=user.uid;
    if(S.joinP) await S.joinP.catch(()=>{});
    if(S.players?.[S.uid]) S.order=[S.uid, ...S.order.filter(u=>u!==S.uid)];
    else await loadPlayers().catch(()=>{});
    if(!S.players[S.uid]){ // kayıt yarıda kaldıysa ya da bağlantı yavaşsa
      await new Promise(r=>setTimeout(r,800)); await loadPlayers().catch(()=>{});
      if(!S.players[S.uid]){
        // Oturum yalnızca hesabın gerçekten olmadığı SUNUCUDAN doğrulanınca kapatılır; bağlantı hatasında oturum korunur
        let exists=null; for(let i=0;i<3 && exists===null;i++){ exists = await getDoc(doc(S.db,"players",S.uid)).then(r=>r.exists()).catch(()=>null); if(exists===null) await new Promise(r=>setTimeout(r,1500)); }
        if(exists===null){ $("#auth").classList.remove("hide"); $("#authErr").innerHTML=`Bağlantı yavaş, bilgilerin alınamadı. <button class="linkish" type="button" onclick="location.reload()">Tekrar dene</button>`; dispatchEvent(new Event("app-ready")); return; }
        if(exists){ await loadPlayers().catch(()=>{}); if(!S.players[S.uid]){ location.reload(); return; } }
        else {
          const ban = await getDoc(doc(S.db,"banned",S.uid)).then(r=>r.exists()).catch(()=>false);
          $("#authErr").textContent = ban ? "Bu hesap ligden çıkarıldı. Oyunu kuran kişiyle konuş." : "Hesap bulunamadı. Tekrar katılmayı dene.";
          await signOut(S.auth); return; }
      }
    }
    $("#auth").classList.add("hide"); $("#app").classList.remove("hide");
    $("#me").classList.remove("hide"); $("#srch").classList.remove("hide"); $("#invBtn").classList.remove("hide"); later(()=>{ startChat(); chatBadge(); }); paintMe(); applyTheme();
    S.statFor=S.uid;
    $("#foot").innerHTML=`Kazanan +1 (sürprizde +2 / +3) · Fark ±3 +1 · En skorer +1 · Banko 2 kat / -1 · Günün oyuncusu +3 · Gecenin sorusu +1 · Haftada 4 gece +2<br><button class="linkish ver" id="pgFoot" type="button">📖 Puanlama rehberi</button><br>Veriler ESPN'den alınır. Maç varken 30 saniyede bir yenilenir.<br><button class="linkish ver" id="verBtn" type="button">Sürüm ${VERSION} · Yenilikler</button> · <button class="linkish ver" id="repBtn" type="button">Sorun bildir</button> · <button class="linkish ver" id="langBtn" type="button">${LANG==="en"?"Türkçe":"English"}</button>`;
    $("#verBtn").onclick=()=>openNews(true); $("#repBtn").onclick=()=>openReport(); $("#langBtn").onclick=()=>setLang(LANG==="en"?"tr":"en");
    route(); showDay(); Promise.resolve(refresh()).catch(()=>{}).finally(()=>dispatchEvent(new Event("app-ready")));
    if(S.onboard){ if(S.joinP) await S.joinP.catch(()=>{}); await loadPlayers().catch(()=>{}); allPlayers().catch(()=>{}).finally(()=>openOnboard(4)); }
    else checkRecovery();
    loadLT(); setTimeout(installBanner, 6000); maybeNews(); maybeCeremony(); later(markSeen, 3000); setTimeout(()=>later(maybeLeaguePop,0), 3000); setTimeout(()=>later(maybeScoringGuide,0), 4500); setTimeout(()=>later(maybeAskAuto, 0), 9000);
    later(()=>{ getDoc(doc(S.db,"config","admin")).then(()=>{ S.isAdmin=true; maybeArchiveTrial(); }).catch(()=>{ S.isAdmin=false; });
      getDoc(doc(S.db,"config","secret")).then(r=>{ S.invite=r.data()?.invite||""; }).catch(()=>{});
      allPlayers().catch(()=>{}); }, 2000);
    getDoc(doc(S.db,"contacts",S.uid)).then(r=>{ S.contact = r.exists() ? r.data() : {email:"",remind:false}; }).catch(()=>{}).finally(()=>{ S.contactLoaded=true; renderBanners(); maybeAskMail(); });
  });
})();
