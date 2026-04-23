const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // Webhook POST body için

// ========== KICK BOT CONFIG ==========
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '01KPVXW5GWMP71138FF945DWN1';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || 'fd09d3572d7022e2b6d0b9d849aa8c373c2e509b8508655ab13f5121c9b814ca';
const KICK_REDIRECT_URI = process.env.KICK_REDIRECT_URI || 'https://tarkov-time-api.onrender.com/auth/callback';
const KICK_BROADCASTER_ID = 24615034;
const KICK_CHANNEL_SLUG = 'mfurkan-fndk';

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
  const sections = sectionsData.parse?.sections || [];
  
  // Sadece level 2 (ana etkinlik) bölümlerini al ve tarihe göre sırala
  const mainSections = sections.filter(s => s.toclevel === 1 || s.level === '2');
  if (mainSections.length === 0) throw new Error('Etkinlik bulunamadı');
  
  // Tarih parse edip en yeniyi bul
  let latestSection = mainSections[0];
  let latestDate = new Date(0);
  for (const s of mainSections) {
    const dateMatch = s.line.match(/\((\d{1,2}\s+\w+\s+\d{4})/);
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!isNaN(parsed) && parsed > latestDate) {
        latestDate = parsed;
        latestSection = s;
      }
    }
  }
  
  const eventName = latestSection.line;

  // En güncel bölümün wikitext'ini al
  const wikiUrl = `https://escapefromtarkov.fandom.com/api.php?action=parse&page=Events&prop=wikitext&section=${latestSection.index}&format=json`;
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

// ========== BOT ROAST ==========

const BOT_ROASTS = [
  'İtiraf ediyorum... Ben aslında bot değilim, sadece bu kadar kötüyüm.',
  'Aim assist açık ama yine de vuramıyorum, sorun bende.',
  'Dün gece Scav\'a bile kaybettim ama kimseye söylemeyin.',
  'Mouse\'umu ters tutuyordum 3 aydır, yeni fark ettim.',
  'Aslında haritayı hala ezberleyemedim, telefondna bakıyorum.',
  'Reshala beni görünce acıyıp ateş etmiyor.',
  'Factory\'de 20 dakika saklandım ve 0 kill ile extract yaptım, buna da şükür.',
  'Ayarlarım 800 DPI ama parmaklarım kontrolü reddediyor.',
  'Gece raid\'e giriyorum ki kimse oynadığımı görmesin.',
  'Stash\'im var ama içinde sadece gözyaşı var.',
  'Dün 5 saat oynadım, toplam kazancım -2 milyon ruble.',
  'Scav karma\'m o kadar düşük ki Fence beni engelledi.',
  'Kendi takım arkadaşımı vurdum ama "desync" dedim.',
  'PMC seviyem 40 ama skill seviyem -40.',
  'Customs Dorms\'a girince kalp atışım 200\'e çıkıyor, gerçek hayatta.',
  'Helikopter extract\'ını 7 kez kaçırdım çünkü sesi duyunca kaçtım.',
  'Flea Market\'te yanlış fiyata satıp 3 milyon kaybettim, ağladım.',
  'GPU buldum ama sevindim heyecandan yanlış tuşa bastım, düşürdüm.',
  'Labs keycard aldım, girdim, 14 saniyede öldüm.',
  'Tarkov\'da 2000 saat var ama hala grenadeı yanlış yere atıyorum.',
  'Her raid\'de en az 1 kere kendi flashbang\'imle kendimi kör ediyorum.',
  'Arkadaşlarım benle oynamak istemiyor, "solo oyna" diyorlar.',
  'İnternet kafede Tarkov oynarken herkes ekranıma bakıp gülüyor.',
  'Benim en iyi raid\'im, hiçbir şey yapmadan extract yaptığım raid.',
  'Silahıma mermi koymayı unutuyorum, 50. kez.',
  'Cheater sandılar, rapor ettiler, sonra izlediler "yok bu bot" dediler.',
  'Annem bile "oğlum sen bu oyunu bırak" dedi.',
  'Rat oynamak istiyorum ama ratlar bile benden iyi.',
  'Oyundaki AI botlar benden daha iyi oynuyor, ciddiyim.',
  'Yükleme ekranındayken bile stres yapıyorum.',
];

app.get('/api/bot', (req, res) => {
  const user = req.query.user || 'aFaTSuMNiDyA';
  const roast = BOT_ROASTS[Math.floor(Math.random() * BOT_ROASTS.length)];
  res.type('text/plain').send(`🤖 ${user}: "${roast}"`);
});

// ========== BAHANE ÜRETİCİ ==========
// Parçalar birleşerek binlerce farklı bahane üretir

const BAHANE_SEBEP = [
  'Desync yüzünden',
  'Server lag\'ı yüzünden',
  'Mouse\'um kaydı',
  'Mouse pili bitti',
  'Klavye takıldı',
  'Alt+Tab yaptım yanlışlıkla',
  'Kapı çaldı',
  'Annem çağırdı',
  'Telefon çaldı',
  'Kedi klavyeye bastı',
  'Kedi monitörün önüne geçti',
  'Köpek kablosunu çekti',
  'İnternet gitti',
  'Ping 999 oldu',
  'FPS 5\'e düştü',
  'Güneş gözüme geldi',
  'Ekranda parlama vardı',
  'Karşıdaki adam hacker',
  'Karşıdaki adam radar kullanıyor',
  'Elim titredi',
  'Hapşurdum o anda',
  'Gözüm kaşındı',
  'Çay döküldü klavyeye',
  'Su içiyordum',
  'Bisküvi yiyordum',
  'Kulaklık düştü',
  'Discord bildirimi geldi',
  'Steam güncellemesi çıktı',
  'Windows update başladı',
  'Sandalye kaydı',
  'Mousepad bitti',
  'O an aklıma başka şey geldi',
  'Gözlüğüm buğulandı',
  'Ellerim terdi',
  'Komşu inşaat yapıyordu',
  'Odaya biri girdi',
  'Ekran dondu bi anlık',
  'Monitor renkleri bozuldu',
  'Ses kısıktı duyamadım',
  'Yanlış tuşa bastım',
];

const BAHANE_DETAY = [
  'yoksa kesin öldürüyordum',
  'ben headshot attım ama kayıt olmadı',
  'normalde böyle oynamam',
  'bugün formum düşük',
  'dün gece uyumadım ondan',
  'soğuk algınlığından ellerim titriyor',
  'yeni mouse\'a alışamadım',
  'yeni klavyeye alışıyorum',
  'ayarları değiştirdim daha',
  'sensitivity yanlıştı',
  'ses ayarı bozuktu',
  'karanlıktan görüntü seçemedim',
  'spawn noktası çöptü',
  'adam duvarın içinden vurdu',
  'mermi sapma yaptı',
  'zırh hiç korumadı',
  'o silah zaten kötü',
  'mermi stokum bitmişti',
  'iyileşmeye fırsat bulamadım',
  'bacaklarım kırıktı yapacak bir şey yok',
  'grenadeı engel olmasa öldürüyordum',
  'soundlar yanlış yerden geldi',
  'minimap\'e bakıyordum',
  'arkamı kontrol ediyordum',
  'loot bakıyordum o sırada',
  'çantayı düzenliyordum',
  'silah jam yaptı',
  'durbin takılıydı',
  'tam reload atıyordum',
];

const BAHANE_FINAL = [
  'Bir dahakine görürsünüz.',
  'Bu benim suçum değil.',
  'BSG düzeltsin bunu.',
  'Yemin ederim ben iyiyim normalde.',
  'Kanıtlarım var, replay\'i izleyin.',
  'Yayını izleyenler şahit.',
  'Adalet istiyorum.',
  'Tarkov bu ya, normal.',
  'Bu oyun bozuk zaten.',
  'Rage quit hakkım var.',
  'Herkesin başına gelir.',
  'Bir daha olmaz... belki.',
  'Ben pes etmem ama bugün zor.',
  'Ama K/D\'m yine pozitif... sanırım.',
  'Neyse bir çay alayım.',
  'İddia ediyorum hacker bu.',
  'Adam 1000 saat oynamıştır.',
  'Bug report açıyorum.',
  'Yarın daha iyi olacak inşallah.',
];

app.get('/api/bahane', (req, res) => {
  const p = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // %30 çift sebep (daha komik)
  let sebep;
  if (Math.random() < 0.3) {
    let s1 = p(BAHANE_SEBEP);
    let s2 = p(BAHANE_SEBEP);
    while (s2 === s1) s2 = p(BAHANE_SEBEP);
    sebep = `${s1} + ${s2.toLowerCase()}`;
  } else {
    sebep = p(BAHANE_SEBEP);
  }

  const detay = p(BAHANE_DETAY);
  const final = p(BAHANE_FINAL);

  res.type('text/plain').send(`😤 Resmi Bahane: ${sebep}, ${detay}. ${final}`);
});

// ========== LOADOUT CHALLENGE ==========

const LOADOUT_WEAPONS = [
  { name: 'Mosin', tier: 'ucuz' },
  { name: 'SKS', tier: 'ucuz' },
  { name: 'VPO-209', tier: 'ucuz' },
  { name: 'Saiga-9', tier: 'ucuz' },
  { name: 'MP-153', tier: 'ucuz' },
  { name: 'TOZ-106', tier: 'ucuz' },
  { name: 'Double Barrel', tier: 'ucuz' },
  { name: 'PP-91 Kedr', tier: 'ucuz' },
  { name: 'AK-74N', tier: 'orta' },
  { name: 'AKM', tier: 'orta' },
  { name: 'MP5', tier: 'orta' },
  { name: 'UMP-45', tier: 'orta' },
  { name: 'OP-SKS', tier: 'orta' },
  { name: 'RFB', tier: 'orta' },
  { name: 'ADAR', tier: 'orta' },
  { name: 'Shotgun MP-155', tier: 'orta' },
  { name: 'M4A1', tier: 'pahalı' },
  { name: 'HK 416', tier: 'pahalı' },
  { name: 'Vector 9mm', tier: 'pahalı' },
  { name: 'Vector .45', tier: 'pahalı' },
  { name: 'MCX', tier: 'pahalı' },
  { name: 'SVD', tier: 'pahalı' },
  { name: 'RSASS', tier: 'pahalı' },
  { name: 'SR-25', tier: 'pahalı' },
  { name: 'P90', tier: 'pahalı' },
  { name: 'RPK-16', tier: 'pahalı' },
  { name: 'MK-18', tier: 'pahalı' },
  { name: 'ASH-12', tier: 'pahalı' },
  { name: 'Sadece Tabanca (PM)', tier: 'troll' },
  { name: 'Sadece Tabanca (Five-Seven)', tier: 'troll' },
  { name: 'Sadece Bıçak', tier: 'troll' },
  { name: 'Sadece El Bombası', tier: 'troll' },
];

const LOADOUT_ARMOR = [
  { name: 'PACA', tier: 'ucuz' },
  { name: 'Zırh yok!', tier: 'ucuz' },
  { name: '6B23-1', tier: 'ucuz' },
  { name: 'BNTI Kirasa', tier: 'orta' },
  { name: 'Trooper', tier: 'orta' },
  { name: 'TV-110 rig', tier: 'orta' },
  { name: 'Korund', tier: 'pahalı' },
  { name: 'Slick', tier: 'pahalı' },
  { name: 'Hex Grid', tier: 'pahalı' },
  { name: 'Zabralo', tier: 'pahalı' },
];

const LOADOUT_BACKPACKS = [
  'Sling', 'Berkut', 'Scav BP', 'Pilgrim', 'Attack 2', 'Çanta yok!'
];

const LOADOUT_MAPS = [
  'Customs', 'Woods', 'Shoreline', 'Interchange', 'Reserve', 'Lighthouse', 'Factory', 'Streets', 'Ground Zero'
];

const LOADOUT_CHALLENGES = [
  'Sadece iron sight!',
  'Sussturucusuz oyna!',
  'İlk gördüğün PMC\'ye koş!',
  'Sadece tek el ateş!',
  'Prone\'dan kalkma yasak!',
  'İlk 2 dakika ateş etme!',
  'Sadece hipfire!',
  'Loot alma — sadece kill!',
  'Sadece bacaklara ateş et!',
  'Haritada en yüksek noktaya git, oradan savaş!',
  'Her öldürme sonrası silah değiştir!',
  'Ekstra şart yok, bol şans!',
  'Sadece topladığın mermilerle oyna!',
  'Zırhlı rig giy, zırh giyme!',
  'Spawn\'dan 1 dakika boyunca geriye koş!',
  'Sadece headshot at!',
  'Yürüyerek oyna, koşma yasak!',
  'Bulunan ilk silahla devam et, kendinkini bırak!',
  'Flashbang at, sonra rush!',
  'Arkadaşınla sırt sırta verin, ayrılma yasak!',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.get('/api/loadout', (req, res) => {
  const weapon = pick(LOADOUT_WEAPONS);
  const armor = pick(LOADOUT_ARMOR);
  const backpack = pick(LOADOUT_BACKPACKS);
  const map = pick(LOADOUT_MAPS);
  const challenge = pick(LOADOUT_CHALLENGES);

  // Bütçe hesapla
  const tierBudget = { ucuz: '50-100K₽', orta: '150-250K₽', pahalı: '300-500K₽', troll: '???₽' };
  const budget = tierBudget[weapon.tier] || '100-200K₽';

  res.type('text/plain').send(
    `🎲 LOADOUT CHALLENGE → Silah: ${weapon.name} | Zırh: ${armor.name} | Çanta: ${backpack} | Harita: ${map} | Bütçe: ${budget} | 🔥 ${challenge}`
  );
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
let lastQuestionIndex = -1;

async function generateQuestion() {
  const type = Math.random();
  
  // %15 mermi sorusu (API'den)
  if (type < 0.15) {
    const ammo = await getAmmoData();
    if (ammo.length > 0) {
      const a = ammo[Math.floor(Math.random() * ammo.length)];
      const cal = shortCaliber(a.caliber);
      
      if (Math.random() < 0.5) {
        return {
          q: `🔫 Penetrasyon: ${a.penetrationPower}, Hasar: ${a.damage}, Kalibre: ${cal}. Bu hangi mermi?`,
          a: [a.item.name.toLowerCase(), a.item.shortName.toLowerCase()],
          hint: `${a.item.shortName.charAt(0)}${'_'.repeat(a.item.shortName.length - 1)} (${a.item.shortName.length} harf)`
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
  
  // %85 bilgi sorusu (sabit) — aynı soruyu tekrar sormaz
  let idx;
  do {
    idx = Math.floor(Math.random() * TRIVIA_QUESTIONS.length);
  } while (idx === lastQuestionIndex && TRIVIA_QUESTIONS.length > 1);
  lastQuestionIndex = idx;
  return TRIVIA_QUESTIONS[idx];
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

// Debug - Botrix'in ne gönderdiğini göster
app.get('/api/quiz/debug', (req, res) => {
  const fullUrl = req.originalUrl;
  const user = req.query.user || 'YOK';
  const answer = req.query.answer || req.query.a || 'YOK';
  res.type('text/plain').send(`URL: ${fullUrl} | User: ${user} | Answer: "${answer}"`);
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

// ========== KICK BOT - OAuth & Webhook ==========

// PKCE yardımcıları
let codeVerifier = '';

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Token'ları Redis'te sakla
async function saveKickTokens(tokens) {
  await redis(['SET', 'kick:access_token', tokens.access_token]);
  await redis(['SET', 'kick:refresh_token', tokens.refresh_token || '']);
  await redis(['SET', 'kick:token_expires', String(Date.now() + (tokens.expires_in * 1000))]);
  console.log('Kick token kaydedildi!');
}

async function getKickAccessToken() {
  const token = await redis(['GET', 'kick:access_token']);
  const expires = await redis(['GET', 'kick:token_expires']);
  
  // Token süresi dolmuşsa yenile
  if (token && expires && Date.now() > parseInt(expires) - 60000) {
    console.log('Token süresi doldu, yenileniyor...');
    const refreshed = await refreshKickToken();
    if (refreshed) return refreshed;
  }
  
  return token;
}

async function refreshKickToken() {
  try {
    const refreshToken = await redis(['GET', 'kick:refresh_token']);
    if (!refreshToken) return null;
    
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      refresh_token: refreshToken
    });
    
    const res = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    
    if (!res.ok) {
      console.error('Token yenileme başarısız:', res.status);
      return null;
    }
    
    const tokens = await res.json();
    await saveKickTokens(tokens);
    return tokens.access_token;
  } catch (err) {
    console.error('Token refresh hatası:', err.message);
    return null;
  }
}

// Kick API ile mesaj gönder
async function sendKickMessage(content) {
  try {
    const token = await getKickAccessToken();
    if (!token) {
      console.error('Kick token yok! /auth/kick adresinden yetkilendir.');
      return false;
    }
    
    const res = await fetch('https://api.kick.com/public/v1/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_user_id: KICK_BROADCASTER_ID,
        content: content,
        type: 'user'
      })
    });
    
    if (!res.ok) {
      const err = await res.text();
      console.error('Mesaj gönderilemedi:', res.status, err);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Kick mesaj hatası:', err.message);
    return false;
  }
}

// === OAuth Endpoints ===

// Aktif OAuth state takibi
let activeAuthRole = 'bot'; // 'bot' veya 'broadcaster'

// 1a. Bot OAuth (OMbot hesabı ile)
app.get('/auth/kick', (req, res) => {
  activeAuthRole = 'bot';
  codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');
  
  const scopes = 'user:read channel:read chat:write events:subscribe moderation:manage';
  
  const url = `https://id.kick.com/oauth/authorize?` +
    `response_type=code&` +
    `client_id=${KICK_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(KICK_REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `state=${state}`;
  
  res.redirect(url);
});

// 1b. Broadcaster OAuth (senin hesabın ile — kanal ödülleri için)
app.get('/auth/broadcaster', (req, res) => {
  activeAuthRole = 'broadcaster';
  codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');
  
  const scopes = 'user:read channel:read channel:rewards:write channel:rewards:read events:subscribe';
  
  const url = `https://id.kick.com/oauth/authorize?` +
    `response_type=code&` +
    `client_id=${KICK_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(KICK_REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `state=${state}`;
  
  res.redirect(url);
});

// 2. OAuth callback (hem bot hem broadcaster için)
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error || !code) {
    return res.type('text/plain').send(`❌ OAuth hatası: ${error || 'Kod alınamadı'}`);
  }
  
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      redirect_uri: KICK_REDIRECT_URI,
      code_verifier: codeVerifier,
      code: code
    });
    
    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.type('text/plain').send(`❌ Token hatası: ${err}`);
    }
    
    const tokens = await tokenRes.json();
    
    if (activeAuthRole === 'broadcaster') {
      // Broadcaster token'ı ayrı kaydet
      await redis(['SET', 'kick:broadcaster_token', tokens.access_token]);
      await redis(['SET', 'kick:broadcaster_refresh', tokens.refresh_token || '']);
      await redis(['SET', 'kick:broadcaster_expires', String(Date.now() + (tokens.expires_in * 1000))]);
      
      // Webhook aboneliği kur (broadcaster token ile)
      await setupWebhookSubscription(tokens.access_token);
      
      res.type('text/plain').send('✅ Broadcaster yetkilendirildi! Kanal ödülleri artık aktif!');
    } else {
      // Bot token'ı kaydet
      await saveKickTokens(tokens);
      
      // Webhook aboneliği kur
      await setupWebhookSubscription(tokens.access_token);
      
      res.type('text/plain').send('✅ Bot yetkilendirildi! Chat komutları aktif!');
    }
  } catch (err) {
    res.type('text/plain').send(`❌ Hata: ${err.message}`);
  }
});

// Webhook aboneliği kur
async function setupWebhookSubscription(token) {
  try {
    const res = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_user_id: KICK_BROADCASTER_ID,
        events: [
          { name: 'chat.message.sent', version: 1 },
          { name: 'channel.reward.redemption.updated', version: 1 }
        ],
        method: 'webhook'
      })
    });
    
    const data = await res.json();
    console.log('Webhook aboneliği:', JSON.stringify(data));
  } catch (err) {
    console.error('Webhook abonelik hatası:', err.message);
  }
}

// === Webhook Handler ===

// Komut cooldown sistemi
const commandCooldowns = {};
function checkCooldown(user, cmd, seconds) {
  const key = `${user}:${cmd}`;
  const now = Date.now();
  if (commandCooldowns[key] && now - commandCooldowns[key] < seconds * 1000) return false;
  commandCooldowns[key] = now;
  return true;
}

// Son webhook logları (debug için)
const webhookLogs = [];

app.post('/webhook/kick', async (req, res) => {
  // Kick'e hemen 200 dön
  res.status(200).send('OK');
  
  try {
    const eventType = req.headers['kick-event-type'] || 'unknown';
    const body = req.body;
    
    // Debug log
    const logEntry = {
      time: new Date().toISOString(),
      eventType,
      headers: {
        'kick-event-type': req.headers['kick-event-type'],
        'kick-event-version': req.headers['kick-event-version'],
        'kick-event-message-id': req.headers['kick-event-message-id'],
      },
      body: JSON.stringify(body).substring(0, 500)
    };
    webhookLogs.unshift(logEntry);
    if (webhookLogs.length > 20) webhookLogs.pop();
    console.log('[WEBHOOK]', JSON.stringify(logEntry));
    
    // === ÖDÜL REDEMPTİON HANDLER ===
    if (eventType === 'channel.reward.redemption.updated') {
      const rewardTitle = body?.reward?.title || '';
      const redeemer = body?.redeemer?.username || 'bilinmeyen';
      const redemptionId = body?.id || '';
      const status = body?.status || '';
      
      console.log(`[REWARD] ${redeemer} redeemed: ${rewardTitle} (status: ${status})`);
      
      // Sadece pending durumundaki loadout ödülünü işle
      if (status === 'pending' && rewardTitle.toLowerCase().includes('loadout')) {
        const weapon = pick(LOADOUT_WEAPONS);
        const armor = pick(LOADOUT_ARMOR);
        const backpack = pick(LOADOUT_BACKPACKS);
        const map = pick(LOADOUT_MAPS);
        const challenge = pick(LOADOUT_CHALLENGES);
        const tierBudget = { ucuz: '50-100K₽', orta: '150-250K₽', pahalı: '300-500K₽', troll: '???₽' };
        const budget = tierBudget[weapon.tier] || '100-200K₽';
        
        await sendKickMessage(`🎲 @${redeemer} LOADOUT CHALLENGE → ${weapon.name} | ${armor.name} | ${backpack} | ${map} | ${budget} | 🔥 ${challenge}`);
        
        // Ödülü otomatik kabul et
        try {
          const token = await getKickAccessToken();
          if (token && redemptionId) {
            await fetch('https://api.kick.com/public/v1/channels/rewards/redemptions/accept', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: [redemptionId] })
            });
          }
        } catch (e) { console.error('Reward accept hatası:', e.message); }
      }
      return;
    }
    
    // === CHAT MESAJ HANDLER ===
    if (eventType !== 'chat.message.sent') return;
    
    // Resmi payload: { message_id, content, sender: { username, user_id }, broadcaster: {...} }
    const content = body?.content || '';
    const sender = body?.sender?.username || 'bilinmeyen';
    const senderId = body?.sender?.user_id || 0;
    
    // Bot kendi mesajlarını yoksay (sonsuz döngü önleme)
    if (sender === 'OMbot' || senderId === 100063968) return;
    
    // Komut mu kontrol et
    if (!content.startsWith('!')) return;
    
    const parts = content.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    
    console.log(`[CMD] ${sender}: ${content}`);
    
    // Komut yönlendirme
    switch (command) {
      case '!tarkovsaat': {
        if (!checkCooldown(sender, 'tarkovsaat', 5)) return;
        const left = getTarkovTime(true);
        const right = getTarkovTime(false);
        await sendKickMessage(`🌅 ${left} | 🌙 ${right}`);
        break;
      }
      
      case '!goons': {
        if (!checkCooldown(sender, 'goons', 10)) return;
        try {
          const { mapNameTR, time } = await getGoonLocation();
          let timeStr = '';
          if (time) {
            const diffMs = Date.now() - time.getTime();
            const diffMin = Math.round(diffMs / 60000);
            timeStr = diffMin < 60 ? `(${diffMin} dk önce)` : `(${Math.round(diffMin/60)} saat önce)`;
          }
          await sendKickMessage(`👹 Goons: ${mapNameTR} ${timeStr}`);
        } catch (err) {
          console.error('Goons hatası:', err.message);
          await sendKickMessage('❌ Goon bilgisi alınamadı.');
        }
        break;
      }
      
      case '!etkinlik': {
        if (!checkCooldown(sender, 'etkinlik', 15)) return;
        try {
          const { eventNameTR, bullets } = await getLatestEvent();
          const shortBullets = bullets.slice(0, 3).join(' | ');
          await sendKickMessage(`📢 ${eventNameTR} → ${shortBullets}`);
        } catch (err) {
          console.error('Etkinlik hatası:', err.message);
          await sendKickMessage('❌ Etkinlik bilgisi alınamadı.');
        }
        break;
      }
      
      case '!quiz': {
        // Sadece mod/yayıncı (şimdilik herkese açık, sonra kısıtlanır)
        if (!checkCooldown(sender, 'quiz', 5)) return;
        const question = await generateQuestion();
        await redis(['SET', 'quiz:active', JSON.stringify(question)]);
        await redis(['SET', 'quiz:answered', 'false']);
        await sendKickMessage(`❓ ${question.q} (💡 İpucu: ${question.hint}) — !c ile cevapla`);
        break;
      }
      
      case '!c': {
        if (!args || !checkCooldown(sender, 'c', 3)) return;
        const activeJson = await redis(['GET', 'quiz:active']);
        if (!activeJson) {
          await sendKickMessage(`❌ Aktif soru yok. !quiz yazarak yeni soru al.`);
          return;
        }
        const answered = await redis(['GET', 'quiz:answered']);
        if (answered === 'true') {
          await sendKickMessage(`⏰ Bu soru cevaplanmış. !quiz ile yeni soru al.`);
          return;
        }
        const question = JSON.parse(activeJson);
        if (isCorrectAnswer(args, question.a)) {
          await redis(['SET', 'quiz:answered', 'true']);
          await redis(['ZINCRBY', 'quiz:scores', 1, sender]);
          const score = await redis(['ZSCORE', 'quiz:scores', sender]);
          await sendKickMessage(`✅ @${sender} doğru bildi! +1 puan (Toplam: ${Math.floor(score)} puan) 🎉`);
        } else {
          await sendKickMessage(`❌ @${sender} yanlış! Tekrar dene.`);
        }
        break;
      }
      
      case '!skor': {
        if (!checkCooldown(sender, 'skor', 5)) return;
        const scores = await redis(['ZREVRANGE', 'quiz:scores', 0, 4, 'WITHSCORES']);
        if (!scores || scores.length === 0) {
          await sendKickMessage('🏆 Henüz skor yok. !quiz ile başla!');
          return;
        }
        let board = '🏆 ';
        const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
        for (let i = 0; i < scores.length; i += 2) {
          const rank = i / 2;
          board += `${medals[rank]} ${scores[i]}: ${Math.floor(scores[i + 1])}p `;
          if (rank < (scores.length / 2) - 1) board += '| ';
        }
        await sendKickMessage(board.trim());
        break;
      }
      
      case '!loadout': {
        if (!checkCooldown(sender, 'loadout', 10)) return;
        const weapon = pick(LOADOUT_WEAPONS);
        const armor = pick(LOADOUT_ARMOR);
        const backpack = pick(LOADOUT_BACKPACKS);
        const map = pick(LOADOUT_MAPS);
        const challenge = pick(LOADOUT_CHALLENGES);
        const tierBudget = { ucuz: '50-100K₽', orta: '150-250K₽', pahalı: '300-500K₽', troll: '???₽' };
        const budget = tierBudget[weapon.tier] || '100-200K₽';
        await sendKickMessage(`🎲 LOADOUT → ${weapon.name} | ${armor.name} | ${backpack} | ${map} | ${budget} | 🔥 ${challenge}`);
        break;
      }
      
      case '!bahane': {
        if (!checkCooldown(sender, 'bahane', 5)) return;
        const p2 = (arr) => arr[Math.floor(Math.random() * arr.length)];
        let sebep;
        if (Math.random() < 0.3) {
          let s1 = p2(BAHANE_SEBEP);
          let s2 = p2(BAHANE_SEBEP);
          while (s2 === s1) s2 = p2(BAHANE_SEBEP);
          sebep = `${s1} + ${s2.toLowerCase()}`;
        } else {
          sebep = p2(BAHANE_SEBEP);
        }
        await sendKickMessage(`😤 Resmi Bahane: ${sebep}, ${p2(BAHANE_DETAY)}. ${p2(BAHANE_FINAL)}`);
        break;
      }
      
      case '!bot': {
        if (!checkCooldown(sender, 'bot', 5)) return;
        const roast = BOT_ROASTS[Math.floor(Math.random() * BOT_ROASTS.length)];
        await sendKickMessage(`🤖 aFaTSuMNiDyA: "${roast}"`);
        break;
      }
      
      default:
        break;
    }
  } catch (err) {
    console.error('Webhook handler hatası:', err.message);
  }
});

// Webhook log debug
app.get('/webhook/logs', (req, res) => {
  res.json({ count: webhookLogs.length, logs: webhookLogs });
});

// Kanal ödülü oluştur (broadcaster token gerekli!)
app.get('/bot/setup-rewards', async (req, res) => {
  try {
    const token = await redis(['GET', 'kick:broadcaster_token']);
    if (!token) return res.json({ error: 'Broadcaster token yok! Önce /auth/broadcaster ile kendi hesabınla yetkilendir.' });
    
    const cost = parseInt(req.query.cost) || 500;
    
    const kickRes = await fetch('https://api.kick.com/public/v1/channels/rewards', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: '🎲 Loadout Challenge',
        description: 'Rastgele silah, zırh, harita ve challenge ile loadout al!',
        cost: cost,
        background_color: '#FF4500',
        is_enabled: true,
        is_user_input_required: false,
        should_redemptions_skip_request_queue: false
      })
    });
    
    const data = await kickRes.json();
    res.json({ status: kickRes.status, data });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Test mesaj gönder
app.get('/bot/test', async (req, res) => {
  try {
    const token = await getKickAccessToken();
    if (!token) return res.json({ error: 'Token yok' });
    
    const kickRes = await fetch('https://api.kick.com/public/v1/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_user_id: KICK_BROADCASTER_ID,
        content: '🤖 FurkanBot test mesajı!',
        type: 'user'
      })
    });
    
    const data = await kickRes.text();
    res.json({ status: kickRes.status, response: data });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Bot durumu
app.get('/bot/status', async (req, res) => {
  const token = await redis(['GET', 'kick:access_token']);
  const expires = await redis(['GET', 'kick:token_expires']);
  const hasToken = !!token;
  const expiresIn = expires ? Math.round((parseInt(expires) - Date.now()) / 60000) : 0;
  
  res.json({
    status: hasToken ? 'aktif' : 'yetkilendirilmemiş',
    tokenExpires: expiresIn > 0 ? `${expiresIn} dakika` : 'süresi dolmuş',
    channel: KICK_CHANNEL_SLUG,
    authUrl: hasToken ? null : '/auth/kick'
  });
});

// Health check
app.get('/api/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Root
app.get('/', (req, res) => {
  res.type('text/plain').send('FurkanBot - Kick Chat Bot | /auth/kick ile yetkilendir | /bot/status ile durumu kontrol et');
});

app.listen(PORT, () => {
  console.log(`FurkanBot running on port ${PORT}`);
});
