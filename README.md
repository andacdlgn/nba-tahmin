# NBA Tahmin

Her gecenin NBA maçlarına tahmin oyunu: kazanan, fark ve maçın en skoreri.

## Kurallar
- Her maç için **kazanan**, **fark aralığı** (1-5 / 6-10 / 11-15 / 16+) ve **maçın en skoreri** zorunlu.
- Kazanan doğru: **1 puan**. Kazananla birlikte fark da doğru: **+1**. En skorer doğru: **+1** (eşitlikte en çok sayı atanlardan biri yeter).
- **Günün bankosu:** her gece bir maç seçilir; o maçta kazanan doğruysa 2 puan, yanlışsa **-1**.
- **Günün oyuncusu:** gecenin en çok sayı atanı bilinirse **+2**. İlk maçtan 10 dakika önce kilitlenir.
- Tahminler maç saatinden 10 dakika öncesine kadar değiştirilebilir ve "Tahmini kaydet" ile kaydedilir. Kilitlenince rakiplerin seçimleri açılır; kimin hangi maçları girdiği ise "Günün tahminleri"nde hemen görünür.
- **Playoff:** tüm puanlar 2 katı.
- Haftalar pazartesi–pazar; tek başına en çok puanı alan haftayı kazanır.

## Nasıl çalışır
- `index.html`, `style.css`, `app.js`: Site (GitHub Pages).
- `config.json`: Firebase proje bilgileri ve ayarlar.
- `firestore.rules`: Veritabanı güvenlik kuralları (kilit, gizlilik, davet kodu). Firebase konsoluna yapıştırılır.
- `scripts/sync.py`: Biten maçları ESPN'den, tahminleri Firestore'dan okuyup puanları hesaplar → `data/`.
- `.github/workflows/sync.yml`: Bu betiği saatte bir çalıştırır. Ayrıca `data/allplayers.json` (güvenlik sorusu için oyuncu listesi) güncellenir.
- `scripts/reset.py` + `.github/workflows/reset.yml`: "Şifremi unuttum" isteklerini 5 dakikada bir işler.

## Şifre sıfırlama
- Kayıtta herkes bir **takım** ve bir **basketbolcu** seçer (güvenlik sorusu). Cevap tuzlu SHA-256 olarak `recovery/{uid}` belgesinde durur; yalnızca sahibi okuyabilir.
- "Şifremi unuttum" → ad + takım + oyuncu + yeni şifre. İstek `resets/` koleksiyonuna düşer, GitHub görevi doğrular ve şifreyi değiştirir (genelde 5–15 dk).
- 3 yanlış denemeden sonra o hesap için 1 saat bekleme konur.
- Görevin çalışması için GitHub'da `FIREBASE_SA` adlı gizli değişken gerekir: Firebase konsolu → Proje ayarları → Hizmet hesapları → "Yeni özel anahtar oluştur" ile inen JSON dosyasının tüm içeriği.

## Yeni oyuncu eklemek
Siteye girip **Yeni oyuncu** sekmesinden ad, güvenlik sorusu, 6 haneli şifre ve davet kodu ile katılınır.
Ad büyük harfle başlamalı ve küfür, argo ya da hakaret içermemeli (sitede ve Firebase kurallarında kontrol edilir).
Davet kodu Firebase konsolunda `config/secret` belgesindeki `invite` alanıdır; değiştirmek için oradan düzenle.
