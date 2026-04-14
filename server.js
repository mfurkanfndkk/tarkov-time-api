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
