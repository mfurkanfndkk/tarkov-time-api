const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ========== TARKOV TIME HESAPLAMA ==========
// Tarkov'da zaman gerçek zamanın 7 katı hızda ilerler
// Left (gündüz): 3 saat offset
// Right (gece): 15 saat offset (3+12)
// Formül: (offset + 7 * realTimeMs) % 24 saat

function getTarkovTime(isLeft) {
  const dayMs = 24 * 3600000;
  const offset = 3 * 3600000 + (isLeft ? 0 : 12 * 3600000);
  const tarkovMs = (offset + 7 * Date.now()) % dayMs;
  const date = new Date(tarkovMs);

  const h = date.getUTCHours().toString().padStart(2, '0');
  const m = date.getUTCMinutes().toString().padStart(2, '0');
  const s = date.getUTCSeconds().toString().padStart(2, '0');

  return `${h}:${m}:${s}`;
}

// ========== ROUTES ==========

// Ana endpoint - Botrix için düz metin
app.get('/api/tarkov-time', (req, res) => {
  const format = req.query.format || 'both';
  const left = getTarkovTime(true);
  const right = getTarkovTime(false);

  if (format === 'left') {
    return res.type('text/plain').send(left);
  }
  if (format === 'right') {
    return res.type('text/plain').send(right);
  }
  if (format === 'json') {
    return res.json({ left, right });
  }
  // Varsayılan: Botrix için güzel formatlı düz metin
  res.type('text/plain').send(`🌅 ${left} | 🌙 ${right}`);
});

// ========== GOON TRACKER ==========
// tarkov-goon-tracker.com'dan goon lokasyonunu çeker

const MAP_NAMES_TR = {
  'customs': 'Gümrük',
  'woods': 'Orman',
  'shoreline': 'Kıyı Şeridi',
  'lighthouse': 'Deniz Feneri',
  'night factory': 'Gece Fabrika',
};

async function getGoonLocation() {
  const response = await fetch('https://tarkov-goon-tracker.com/tr');
  const html = await response.text();

  // __NEXT_DATA__ JSON'unu çıkar
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
  if (!match) throw new Error('Goon verisi bulunamadı');

  const data = JSON.parse(match[1]);
  const trackings = data?.props?.pageProps?.trackings;

  if (!trackings || trackings.length === 0) throw new Error('Goon izleme verisi yok');

  // İlk geçerli raporu bul (bot/geçersiz kayıtları atla)
  const latest = trackings.find(t => 
    t.map?.slug && t.currentDate && t.currentDate !== 'Invalid Date'
  );
  if (!latest) throw new Error('Geçerli goon verisi bulunamadı');

  const mapSlug = latest.map.slug;
  const mapNameEN = latest.map.name || mapSlug;
  const mapNameTR = MAP_NAMES_TR[mapSlug] || mapNameEN;
  const time = latest.currentDate ? new Date(latest.currentDate) : null;

  return { mapNameTR, mapNameEN, time };
}

app.get('/api/goons', async (req, res) => {
  try {
    const { mapNameTR, mapNameEN, time } = await getGoonLocation();

    let timeStr = '';
    if (time) {
      const now = Date.now();
      const diffMin = Math.floor((now - time.getTime()) / 60000);
      if (diffMin < 60) {
        timeStr = ` (${diffMin} dk önce)`;
      } else {
        const diffHr = Math.floor(diffMin / 60);
        timeStr = ` (${diffHr} saat önce)`;
      }
    }

    const format = req.query.format;
    if (format === 'json') {
      return res.json({ map: mapNameEN, mapTR: mapNameTR, time });
    }

    res.type('text/plain').send(`🎯 Goons: ${mapNameTR}${timeStr}`);
  } catch (err) {
    console.error('Goon tracker hatası:', err.message);
    res.type('text/plain').send('Goon verisi alınamadı, lütfen daha sonra tekrar deneyin.');
  }
});

// ========== ETKİNLİK (EVENTS) ==========
// Fandom wiki API'sinden son etkinliği çeker

async function getLatestEvent() {
  // Fandom API: sections listesi (etkinlik adlarını al)
  const sectionsUrl = 'https://escapefromtarkov.fandom.com/api.php?action=parse&page=Events&prop=sections&format=json';
  const sectionsRes = await fetch(sectionsUrl, {
    headers: { 'User-Agent': 'TarkovBot/1.0' }
  });
  const sectionsData = await sectionsRes.json();
  const firstSection = sectionsData.parse?.sections?.[0];
  if (!firstSection) throw new Error('Etkinlik bulunamadı');

  const eventName = firstSection.line; // Örn: "Casus belli (9 April 2026)"

  // İlk bölümün wikitext'ini al
  const wikiUrl = `https://escapefromtarkov.fandom.com/api.php?action=parse&page=Events&prop=wikitext&section=${firstSection.index}&format=json`;
  const wikiRes = await fetch(wikiUrl, {
    headers: { 'User-Agent': 'TarkovBot/1.0' }
  });
  const wikiData = await wikiRes.json();
  const wikitext = wikiData.parse?.wikitext?.['*'] || '';

  // Bullet point'leri çıkar (madde işaretleri)
  const bullets = wikitext
    .split('\n')
    .filter(line => line.startsWith('*'))
    .map(line => line
      .replace(/^\*\s*/, '')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2') // [[link|text]] → text
      .replace(/<[^>]+>/g, '') // HTML taglarını kaldır
      .trim()
    )
    .filter(line => line.length > 0);

  // Google Translate ile tüm metni çevir (event adı + bullet'lar)
  const fullText = `${eventName}\n${bullets.join('\n')}`;
  const translated = await googleTranslate(fullText);
  const lines = translated.split('\n').filter(l => l.trim());
  
  const eventNameTR = lines[0] || eventName;
  const bulletsTR = lines.slice(1);

  return { eventNameTR, bullets: bulletsTR.length > 0 ? bulletsTR : bullets };
}

async function googleTranslate(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  
  if (!response.ok) throw new Error('Çeviri API hatası');
  
  const data = await response.json();
  // Google Translate yanıtı: [[["çevrilmiş metin","orijinal metin",...],...],...]
  return data[0].map(item => item[0]).join('');
}

app.get('/api/event', async (req, res) => {
  try {
    const { eventNameTR, bullets } = await getLatestEvent();

    const format = req.query.format;
    if (format === 'json') {
      return res.json({ event: eventNameTR, changes: bullets });
    }

    // Botrix için kısa düz metin (ilk 3 madde)
    const shortBullets = bullets.slice(0, 3).join(' | ');
    res.type('text/plain').send(`📢 ${eventNameTR} → ${shortBullets}`);
  } catch (err) {
    console.error('Event hatası:', err.message);
    res.type('text/plain').send('Etkinlik verisi alınamadı.');
  }
});

// ========== QUIZ SİSTEMİ ==========
// Upstash Redis ile kalıcı skor + tarkov.dev API ile dinamik sorular

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Redis REST API yardımcı fonksiyonu
async function redis(command) {
  const res = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await res.json();
  return data.result;
}

// tarkov.dev'den mermi verisi çek (cache'li)
let ammoCache = null;
let ammoCacheTime = 0;

async function getAmmoData() {
  if (ammoCache && Date.now() - ammoCacheTime < 3600000) return ammoCache;
  
  try {
    const query = `{ ammo { item { name shortName } caliber penetrationPower damage } }`;
    const res = await fetch('https://api.tarkov.dev/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    ammoCache = data.data.ammo.filter(a => a.penetrationPower >= 25 && a.item.name);
    ammoCacheTime = Date.now();
    return ammoCache;
  } catch {
    return [];
  }
}

// Kalibre adlarını kısa yap
function shortCaliber(cal) {
  return cal.replace('Caliber', '').replace('NATO', '').replace(/x/g, 'x');
}

// Sabit Tarkov bilgi soruları (60+)
const TRIVIA_QUESTIONS = [
  // === BOSS & DÜŞMANLAR ===
  { q: '👑 Killa hangi haritada boss olarak çıkar?', a: ['interchange'], hint: 'Alışveriş merkezi' },
  { q: '👑 Reshala hangi haritada çıkar?', a: ['customs', 'gümrük'], hint: 'Yeni başlayanların haritası' },
  { q: '👑 Reshala\'nın koruması kaç kişidir?', a: ['4', 'dört'], hint: '4-5 arası' },
  { q: '👑 Tagilla hangi haritada çıkar?', a: ['factory', 'fabrika'], hint: 'En küçük harita' },
  { q: '👑 Tagilla\'nın silahı nedir?', a: ['balyoz', 'çekiç', 'hammer', 'sledgehammer'], hint: 'Yakın dövüş silahı' },
  { q: '👑 Glukhar hangi haritada çıkar?', a: ['reserve', 'rezerv'], hint: 'Askeri üs haritası' },
  { q: '👑 Shturman hangi haritada çıkar?', a: ['woods', 'orman'], hint: 'Ağaçlık harita' },
  { q: '👑 Shturman\'ın sniper\'ı ne menzile kadar etkilidir?', a: ['300', '300m'], hint: 'Yüzlerce metre' },
  { q: '👑 Sanitar hangi haritada çıkar?', a: ['shoreline', 'kıyı şeridi'], hint: 'Resort haritası' },
  { q: '👑 Killa hangi zırhı giyer?', a: ['maska', 'maska-1sch', 'vulkan'], hint: 'Yüz koruyucu kask' },
  { q: '💀 Cultist\'ler hangi saatte çıkar?', a: ['gece', 'night', 'gece vakti'], hint: 'Karanlıkta' },
  { q: '💀 Cultist\'lerin bıçağı ne yapar?', a: ['zehirler', 'poison', 'zehir'], hint: 'Sağlık etkisi' },
  { q: '🤖 Raider\'lar en çok hangi haritada çıkar?', a: ['labs', 'lab', 'reserve', 'rezerv'], hint: 'Askeri düşmanlar' },

  // === HARİTALAR ===
  { q: '🗺️ Tarkov\'daki en küçük harita hangisidir?', a: ['factory', 'fabrika'], hint: 'CQB haritası' },
  { q: '🗺️ Tarkov\'daki en büyük harita hangisidir?', a: ['shoreline', 'kıyı şeridi'], hint: 'Resort binası var' },
  { q: '🗺️ Customs\'daki Dorms kaç katlıdır? (büyük bina)', a: ['3', 'üç'], hint: 'Marked room en üstte' },
  { q: '🗺️ Reserve haritasındaki yeraltı çıkışının adı nedir?', a: ['d-2', 'd2', 'bunker'], hint: 'Güç açılmalı' },
  { q: '🗺️ Interchange\'deki alışveriş merkezinin adı nedir?', a: ['ultra', 'ultra mall'], hint: 'Büyük AVM' },
  { q: '🗺️ Factory haritasının raid süresi kaç dakikadır?', a: ['20', 'yirmi'], hint: 'En kısa raid' },
  { q: '🗺️ Lighthouse\'daki su altı çıkışı için ne gerekir?', a: ['rebreather', 'dalış ekipmanı', 'scuba'], hint: 'Sualtı ekipmanı' },
  { q: '🗺️ Streets of Tarkov\'daki sinema salonunun adı nedir?', a: ['cinema', 'razvedka', 'concordia'], hint: 'Film izlenen yer' },
  { q: '🗺️ Ground Zero hangi seviyeye kadar zorunlu haritadır?', a: ['20', 'yirmi', 'lvl 20'], hint: 'Çift haneli seviye' },

  // === SİLAHLAR & MERMİ ===
  { q: '🔫 Mosin silahı hangi ülke kaynaklıdır?', a: ['rusya', 'russia', 'rus'], hint: 'Doğu Avrupa' },
  { q: '🔫 Tarkov\'da en yüksek kalibre mermi hangisidir?', a: ['12.7x55', '12.7', 'ash-12'], hint: '12 ile başlar' },
  { q: '🔫 M4A1 hangi kalibre kullanır?', a: ['5.56x45', '5.56', '556'], hint: 'NATO standartı' },
  { q: '🔫 AK-74 hangi kalibre kullanır?', a: ['5.45x39', '5.45', '545'], hint: 'Sovyet kalibresi' },
  { q: '🔫 SVD hangi tür bir silahtır?', a: ['sniper', 'keskin nişancı', 'dmr', 'marksman'], hint: 'Uzun menzil' },
  { q: '🔫 MP7 hangi kalibre kullanır?', a: ['4.6x30', '4.6'], hint: 'Çok küçük kalibre' },
  { q: '🔫 Saiga-12 ne tür bir silahtır?', a: ['shotgun', 'pompalı', 'yarı otomatik pompalı'], hint: '12 gauge' },
  { q: '🔫 Vector hangi kalibrelerde gelir?', a: ['9x19', '45 acp', '.45', '9mm'], hint: 'İki farklı versiyon' },
  { q: '🔫 RPK ne tür bir silahtır?', a: ['lmg', 'hafif makineli', 'makineli tüfek', 'machine gun'], hint: 'Yüksek şarjör kapasitesi' },

  // === TÜCCARLAR ===
  { q: '🏪 Therapist\'in (Doktor) asıl adı nedir?', a: ['elvira khabibullina', 'elvira'], hint: 'Bir kadın ismi' },
  { q: '🏪 Peacekeeper hangi para birimini kabul eder?', a: ['dolar', 'usd', 'dollar'], hint: 'Amerikan parası' },
  { q: '🏪 Prapor\'un uzmanlık alanı nedir?', a: ['silah', 'weapon', 'guns', 'tüfek', 'ateşli silahlar'], hint: 'Savaş ekipmanı' },
  { q: '🏪 Ragman ne satar?', a: ['kıyafet', 'zırh', 'giyim', 'clothing', 'armor'], hint: 'Giyilebilir eşyalar' },
  { q: '🏪 Mechanic\'in uzmanlık alanı nedir?', a: ['silah modifikasyon', 'modding', 'weapon modding', 'silah parçaları', 'modifikasyon'], hint: 'Silah geliştirme' },
  { q: '🏪 Jaeger\'ı açmak için hangi görevi tamamlamak gerekir?', a: ['introduction', 'tanışma', 'intro'], hint: 'Mechanic\'in görevi' },
  { q: '🏪 Fence (Çitçi) ne tür eşyalar satar?', a: ['rastgele', 'random', 'karışık', 'her şey', 'diğer oyuncuların sattığı'], hint: 'Her şeyden biraz' },
  { q: '🏪 Lightkeeper hangi haritada bulunur?', a: ['lighthouse', 'deniz feneri'], hint: 'Harita adında var' },

  // === OYUN MEKANİKLERİ ===
  { q: '⏱️ Tarkov\'da oyun içi zaman gerçek zamanın kaç katı hızında ilerler?', a: ['7', 'yedi', '7x'], hint: 'Tek haneli bir sayı' },
  { q: '💉 Tarkov\'da kaç farklı vücut bölgesi hasar alabilir? (kol ve bacaklar ayrı)', a: ['7', 'yedi'], hint: 'Kafa, göğüs, mide, 2 kol, 2 bacak' },
  { q: '🏃 PMC\'nin varsayılan çanta boyutu (pouch) kaçtır? (standart versiyon)', a: ['2x2', '4', 'alpha'], hint: 'Alpha Container' },
  { q: '🎒 Secure Container "Gamma" kaç slot\'tur?', a: ['3x3', '9'], hint: 'EOD versiyonu' },
  { q: '💀 Wipe ne demektir?', a: ['sıfırlama', 'resetleme', 'herkesin baştan başlaması', 'reset', 'sıfırdan başlama'], hint: 'Her şey sıfırlanır' },
  { q: '🎯 Head-Eyes ne demektir?', a: ['göze headshot', 'göz bölgesine isabet', 'gözden headshot', 'eye headshot'], hint: 'Yüz hitbox' },
  { q: '🎯 Tarkov\'da "chad" ne anlama gelir?', a: ['agresif oyuncu', 'iyi donanımlı agresif oyuncu', 'agresif', 'full gear oyuncu'], hint: 'Tam donanımlı agresif' },
  { q: '💀 Tarkov\'da "rat" ne anlama gelir?', a: ['sinsi oyuncu', 'gizlenen oyuncu', 'pasif oyuncu', 'fare'], hint: 'Chad\'ın tersi' },
  { q: '🔧 Hideout\'ta Bitcoin Farm\'ı kurmak için en az kaç GPU gerekir?', a: ['1', 'bir'], hint: 'Minimum sayı' },
  { q: '💰 Flea Market kaçıncı seviyede açılır?', a: ['15', 'on beş'], hint: '10 ile 20 arası' },
  { q: '🏪 Fence\'den Scav Karma ile özel teklif hangi seviyede açılır?', a: ['6', 'altı'], hint: 'En yüksek karma' },
  { q: '🔑 Labs haritasına girmek için ne gerekir?', a: ['keycard', 'access keycard', 'lab keycard', 'kart', 'giriş kartı'], hint: 'Bir kart' },

  // === İTEMLER & LOOT ===
  { q: '🏥 LEDX hangi haritada en çok bulunur?', a: ['labs', 'lab', 'laboratuvar'], hint: 'Giriş kartı gereken harita' },
  { q: '💊 Tarkov\'da kırık kemiği tedavi etmek için ne kullanılır?', a: ['splint', 'cms', 'surv12', 'atel'], hint: 'Ortopedik malzeme' },
  { q: '💉 Propital ne işe yarar?', a: ['ağrı kesici', 'painkiller', 'stimulant', 'can yenileme'], hint: 'Stimülant ilaç' },
  { q: '🔑 Customs\'daki Marked Room anahtarı en fazla kaç kez kullanılabilir?', a: ['25', 'yirmi beş'], hint: '20 ile 30 arası' },
  { q: '💰 Bitcoin\'in oyundaki Therapist\'e satış fiyatı yaklaşık kaçtır?', a: ['100000', '100k', '100.000', 'yüz bin'], hint: '6 haneli ruble' },
  { q: '🎒 Tarkov\'daki en değerli single-slot item nedir?', a: ['ledx', 'gpu', 'graphics card', 'btc', 'bitcoin'], hint: 'Tek slot, çok değerli' },
  { q: '💊 Tarkov\'da ağır kanamayı durdurmak için ne kullanılır?', a: ['tourniquet', 'hemostat', 'esmarch', 'calok', 'turnike'], hint: 'Tıbbi malzeme' },
  { q: '🔋 Tarkov\'da yakın mesafe iletişim cihazının adı nedir?', a: ['walkie-talkie', 'radio', 'telsiz'], hint: 'Haberleşme aracı' },

  // === GENEL BİLGİ & LORE ===
  { q: '🌍 Tarkov hangi ülkede geçiyor?', a: ['rusya', 'russia', 'rus'], hint: 'Doğu Avrupa' },
  { q: '🏢 Tarkov\'u yapan şirketin adı nedir?', a: ['battlestate games', 'bsg', 'battlestate'], hint: '3 harfli kısaltma' },
  { q: '⚔️ PMC\'nin açılımı nedir?', a: ['private military company', 'private military contractor', 'özel askeri şirket'], hint: 'Özel askeri...' },
  { q: '⚔️ Tarkov\'daki iki PMC grubunun adı nedir?', a: ['bear usec', 'usec bear', 'bear ve usec'], hint: 'Bir Rus, bir Batılı' },
  { q: '🐻 BEAR hangi ülkenin PMC\'sidir?', a: ['rusya', 'russia', 'rus'], hint: 'Ayı sembolü' },
  { q: '🦅 USEC hangi ülkenin PMC\'sidir?', a: ['amerika', 'abd', 'usa', 'united states'], hint: 'Batılı güç' },
  { q: '🗺️ Customs haritasındaki kırmızı kart anahtarının adı nedir?', a: ['marked room', 'marked key', 'marked'], hint: 'Dorms 3. katta' },
  { q: '🎮 Tarkov\'un tam adı nedir?', a: ['escape from tarkov', 'tarkovdan kaçış'], hint: 'Escape from...' },
  { q: '📅 Tarkov ilk ne zaman duyuruldu?', a: ['2016', '2015'], hint: '2010\'ların ortası' },
  { q: '🎮 Tarkov\'un oyun motoru nedir?', a: ['unity', 'üniti'], hint: 'Popüler oyun motoru' },
];

// Rastgele soru üret
async function generateQuestion() {
  const type = Math.random();
  
  // %40 mermi sorusu (API'den)
  if (type < 0.4) {
    const ammo = await getAmmoData();
    if (ammo.length > 0) {
      const a = ammo[Math.floor(Math.random() * ammo.length)];
      const cal = shortCaliber(a.caliber);
      
      if (Math.random() < 0.5) {
        return {
          q: `🔫 Penetrasyon: ${a.penetrationPower}, Hasar: ${a.damage}, Kalibre: ${cal}. Bu hangi mermi?`,
          a: [a.item.name.toLowerCase(), a.item.shortName.toLowerCase()],
          hint: `${a.item.shortName}`
        };
      } else {
        return {
          q: `🔫 "${a.item.shortName}" mermisinin penetrasyon değeri kaçtır?`,
          a: [String(a.penetrationPower)],
          hint: `${a.penetrationPower > 40 ? '40 üstü' : '40 altı'}`
        };
      }
    }
  }
  
  // %60 bilgi sorusu (sabit)
  return TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
}

// Cevap karşılaştırma (büyük/küçük harf + Türkçe karakter duyarsız)
function normalizeAnswer(text) {
  return text
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function isCorrectAnswer(userAnswer, correctAnswers) {
  const norm = normalizeAnswer(userAnswer);
  return correctAnswers.some(a => {
    const normA = normalizeAnswer(a);
    return norm === normA || norm.includes(normA) || normA.includes(norm);
  });
}

// === QUIZ ENDPOINTS ===

// Yeni soru al
app.get('/api/quiz/question', async (req, res) => {
  try {
    const question = await generateQuestion();
    
    // Aktif soruyu Redis'e kaydet
    await redis(['SET', 'quiz:active', JSON.stringify(question)]);
    await redis(['SET', 'quiz:answered', 'false']);
    await redis(['SET', 'quiz:time', String(Date.now())]);
    
    res.type('text/plain').send(`❓ ${question.q} (💡 İpucu: ${question.hint}) — !c ile cevapla`);
  } catch (err) {
    console.error('Quiz hatası:', err.message);
    res.type('text/plain').send('Quiz sorusu yüklenemedi.');
  }
});

// Cevap kontrol
app.get('/api/quiz/answer', async (req, res) => {
  try {
    const user = req.query.user;
    const answer = req.query.answer || req.query.a || '';
    
    if (!user || !answer) {
      return res.type('text/plain').send('Kullanım: !c <cevap>');
    }

    // Aktif soru var mı?
    const activeJson = await redis(['GET', 'quiz:active']);
    if (!activeJson) {
      return res.type('text/plain').send('❌ Aktif soru yok. !quiz yazarak yeni soru al.');
    }

    // Zaten cevaplanmış mı?
    const answered = await redis(['GET', 'quiz:answered']);
    if (answered === 'true') {
      return res.type('text/plain').send('⏰ Bu soru zaten cevaplanmış. !quiz ile yeni soru al.');
    }

    const question = JSON.parse(activeJson);

    if (isCorrectAnswer(answer, question.a)) {
      // Doğru cevap!
      await redis(['SET', 'quiz:answered', 'true']);
      
      // Skoru artır (sorted set)
      await redis(['ZINCRBY', 'quiz:scores', 1, user]);
      
      // Toplam skoru al
      const score = await redis(['ZSCORE', 'quiz:scores', user]);
      
      res.type('text/plain').send(`✅ @${user} doğru bildi! +1 puan (Toplam: ${Math.floor(score)} puan) 🎉`);
    } else {
      res.type('text/plain').send(`❌ @${user} yanlış! Tekrar dene.`);
    }
  } catch (err) {
    console.error('Cevap hatası:', err.message);
    res.type('text/plain').send('Bir hata oluştu.');
  }
});

// Skor tablosu
app.get('/api/quiz/scoreboard', async (req, res) => {
  try {
    const scores = await redis(['ZREVRANGE', 'quiz:scores', 0, 4, 'WITHSCORES']);
    
    if (!scores || scores.length === 0) {
      return res.type('text/plain').send('🏆 Henüz skor yok. !quiz ile başla!');
    }

    // scores: [user1, score1, user2, score2, ...]
    let board = '🏆 ';
    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    for (let i = 0; i < scores.length; i += 2) {
      const rank = i / 2;
      board += `${medals[rank]} ${scores[i]}: ${Math.floor(scores[i + 1])}p `;
      if (rank < (scores.length / 2) - 1) board += '| ';
    }
    
    res.type('text/plain').send(board.trim());
  } catch (err) {
    console.error('Skor hatası:', err.message);
    res.type('text/plain').send('Skor tablosu yüklenemedi.');
  }
});

// Skor sıfırlama (streamer için)
app.get('/api/quiz/reset', async (req, res) => {
  try {
    const key = req.query.key;
    if (key !== 'furkan2026') {
      return res.type('text/plain').send('⛔ Yetkisiz.');
    }
    await redis(['DEL', 'quiz:scores']);
    await redis(['DEL', 'quiz:active']);
    await redis(['DEL', 'quiz:answered']);
    res.type('text/plain').send('🔄 Scoreboard sıfırlandı!');
  } catch (err) {
    res.type('text/plain').send('Hata oluştu.');
  }
});

// Health check
app.get('/api/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Root
app.get('/', (req, res) => {
  res.type('text/plain').send('Tarkov Time API - /api/tarkov-time');
});

app.listen(PORT, () => {
  console.log(`Tarkov Time API running on port ${PORT}`);
});
