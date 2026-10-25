# NBA Tahmin

Her gecenin NBA maçlarına tahmin oyunu: kazanan, fark ve maçın en skoreri.

## Kurallar
- Her maç için **kazanan**, **fark aralığı** (1-5 / 6-10 / 11-15 / 16+) ve **maçın en skoreri** zorunlu.
- Kazanan doğru: **1 puan**. Kazananla birlikte fark da doğru: **+1**. En skorer doğru: **+1** (eşitlikte en çok sayı atanlardan biri yeter).
- **Günün bankosu:** her gece bir maç seçilir; o maçta kazanan doğruysa 2 puan, yanlışsa **-1**.
- **Günün oyuncusu:** gecenin en çok sayı atanı bilinirse **+2**.
- Gecenin bütün tahminleri (maçlar, banko, günün oyuncusu) **gecenin ilk maçı başladığı anda** kilitlenir; o ana kadar değiştirilebilir ve "Tahmini kaydet" ile kaydedilir. Kilitlenince rakiplerin seçimleri açılır; kimin hangi maçları girdiği ise "Günün tahminleri"nde hemen görünür.
- **Gecenin sorusu:** her gece evet/hayır sorusu (ör. "Bir maç uzatmaya gider mi?"), doğru cevap **+1**.
- **Playoff:** tüm puanlar 2 katı. Her seri başlamadan seriyi kim, kaç maçta alır tahmini: kazanan **+3**, maç sayısı da doğruysa **+2**.
- **Laf atma:** kilit sonrası maçlara emoji ve kısa yorum (küfür filtreli).
- Rozetler, ayın şampiyonları, takım karnesi, rakip analizi ve sezon ödülleri siteden hesaplanır.
- Haftalar pazartesi–pazar; tek başına en çok puanı alan haftayı kazanır.

## Nasıl çalışır
- `index.html`, `style.css`, `app.js`: Site (GitHub Pages).
- `config.json`: Firebase proje bilgileri ve ayarlar.
- `firestore.rules`: Veritabanı güvenlik kuralları (kilit, gizlilik, davet kodu). Firebase konsoluna yapıştırılır.
- `scripts/sync.py`: Biten maçları ESPN'den, tahminleri Firestore'dan okuyup puanları hesaplar → `data/`.
- `.github/workflows/sync.yml`: Bu betiği saatte bir çalıştırır. Ayrıca `data/allplayers.json` (güvenlik sorusu için oyuncu listesi) güncellenir.
- `.github/workflows/worker.yml`: arka plan görevi. ~5,5 saat açık kalır, 20 saniyede bir onay kodlarını (`verify.py`) ve "Şifremi unuttum" isteklerini (`reset.py`), 10 dakikada bir hatırlatma maillerini (`remind.py`) işler; süresi dolunca kendini yeniden başlatır. Durursa Actions → "Arka plan görevleri" → Run workflow ile elle başlatılır. `reset.yml` ve `remind.yml` artık yalnızca elle çalıştırmak için.

## Hatırlatma maili
- Oyuncu profilinden e-posta adresini yazıp "Hatırlat"ı açarsa, gecenin ilk maçına 2 saat kala eksik tahmini varsa bir kez mail gelir; seçtiği skorer ya da günün oyuncusu ESPN'de "Out" görünürse kilitten önce uyarı maili gelir.
- "Pazartesi haftalık özet" açıksa her pazartesi 10:00'dan sonra geçen haftanın özeti gelir.
- Mailler yalnızca **onaylanmış** adreslere gider. Profilde "Onay kodu gönder" → `verifyReq/{uid}`; `scripts/verify.py` (arka plan göreviyle, genelde 1 dakika içinde) 6 haneli kodu mailler ve özetini `otp/{uid}`'ye yazar. Kod 30 dakika geçerli; doğruluğunu Firebase kuralı kontrol eder (`contacts.verified`).
- Adres `contacts/{uid}` belgesinde durur; yalnızca sahibi okuyabilir. Gönderilenler `reminders/` koleksiyonunda tutulur (aynı gece ikinci mail gitmez).
- `scripts/remind.py` arka plan görevinde 10 dakikada bir çalışır. Gerekli gizli değişkenler: `FIREBASE_SA`, `GMAIL_USER` (gönderen Gmail adresi), `GMAIL_APP_PASSWORD` (Google hesabında oluşturulan uygulama şifresi).

## Şifre sıfırlama
- Kayıtta herkes bir **takım** ve bir **basketbolcu** seçer (güvenlik sorusu). Cevap tuzlu SHA-256 olarak `recovery/{uid}` belgesinde durur; yalnızca sahibi okuyabilir.
- "Şifremi unuttum" → ad + takım + oyuncu + yeni şifre. İstek `resets/` koleksiyonuna düşer, GitHub görevi doğrular ve şifreyi değiştirir (genelde 5–15 dk).
- 3 yanlış denemeden sonra o hesap için 1 saat bekleme konur.
- Görevin çalışması için GitHub'da `FIREBASE_SA` adlı gizli değişken gerekir: Firebase konsolu → Proje ayarları → Hizmet hesapları → "Yeni özel anahtar oluştur" ile inen JSON dosyasının tüm içeriği.

## Yönetim paneli
- Profil penceresinde "Yönetim paneli" yalnızca yöneticilere görünür. Yöneticiler Firebase konsolunda `config/admin` belgesindeki `uids` listesidir.
- **Ligi sıfırla:** seçilen geceden itibaren puanlar sıfırdan sayılır (`league/settings.start`). Eski puan durumu `history` listesine kaydedilir ve Puan sekmesinde "Geçmiş ligler"de görünür. Tahminler silinmez.
- **Ligden çıkar:** oyuncunun `players` belgesi silinir, `banned/{uid}` eklenir; tekrar katılamaz. "Geri al" ile eski adı ve katılma tarihiyle döner.
- **Davet kodu:** panelden görülüp değiştirilebilir.

## Yeni oyuncu eklemek
Siteye girip **Yeni oyuncu** sekmesinden ad, güvenlik sorusu, 6 haneli şifre ve davet kodu ile katılınır.
Ad büyük harfle başlamalı ve küfür, argo ya da hakaret içermemeli (sitede ve Firebase kurallarında kontrol edilir).
Davet kodu Firebase konsolunda `config/secret` belgesindeki `invite` alanıdır; değiştirmek için oradan düzenle.
