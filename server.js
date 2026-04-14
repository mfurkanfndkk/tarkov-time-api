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

const MONTHS_TR = {
  'January': 'Ocak', 'February': 'Şubat', 'March': 'Mart',
  'April': 'Nisan', 'May': 'Mayıs', 'June': 'Haziran',
  'July': 'Temmuz', 'August': 'Ağustos', 'September': 'Eylül',
  'October': 'Ekim', 'November': 'Kasım', 'December': 'Aralık'
};

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

  // Tarihi Türkçe'ye çevir
  let eventNameTR = eventName;
  for (const [en, tr] of Object.entries(MONTHS_TR)) {
    eventNameTR = eventNameTR.replace(en, tr);
  }

  // Açıklamaları Türkçeye çevir
  const bulletsTR = bullets.map(b => translateToTR(b));

  return { eventNameTR, bullets: bulletsTR };
}

function translateToTR(text) {
  // Tam cümle kalıpları (önce bunlar uygulanır)
  const sentencePatterns = [
    [/They can be found in groups of (\d+)-(\d+) on (.+)\./gi, (_, a, b, maps) => `${a}-${b} kişilik gruplar halinde ${translateMaps(maps)} haritalarında bulunabilirler.`],
    [/They spawn in groups of (\d+)-(\d+) on (.+)\./gi, (_, a, b, maps) => `${a}-${b} kişilik gruplar halinde ${translateMaps(maps)} haritalarında doğarlar.`],
    [/can now also spawn with (.+?) in their pockets/gi, (_, item) => `artık ceplerinde ${item} ile de doğabilir`],
    [/(.+?) have their value increased/gi, (_, item) => `${item} değerleri artırıldı`],
    [/(.+?) can now be found on (.+)/gi, (_, item, maps) => `${item} artık ${translateMaps(maps)} haritalarında bulunabilir`],
    [/(.+?) can now be found in (.+)/gi, (_, item, loc) => `${item} artık ${loc} içinde bulunabilir`],
    [/Spawn rate.+?increased to (\d+)%/gi, (_, pct) => `Doğma oranı %${pct}'e yükseltildi`],
    [/Spawn rate.+?decreased to (\d+)%/gi, (_, pct) => `Doğma oranı %${pct}'e düşürüldü`],
  ];

  let result = text;
  for (const [pattern, replacement] of sentencePatterns) {
    result = result.replace(pattern, replacement);
  }

  // Kelime/ifade bazlı çeviriler
  const wordPatterns = [
    [/\bNew enemy type\b/gi, 'Yeni düşman tipi'],
    [/\bhas been added\b/gi, 'eklendi'],
    [/\bhas been removed\b/gi, 'kaldırıldı'],
    [/\bhas been changed\b/gi, 'değiştirildi'],
    [/\bhas been updated\b/gi, 'güncellendi'],
    [/\bhas been enabled\b/gi, 'aktif edildi'],
    [/\bhas been disabled\b/gi, 'devre dışı bırakıldı'],
    [/\bhas been increased\b/gi, 'artırıldı'],
    [/\bhas been decreased\b/gi, 'azaltıldı'],
    [/\bhas been reduced\b/gi, 'azaltıldı'],
    [/\bhas been fixed\b/gi, 'düzeltildi'],
    [/\bhas been introduced\b/gi, 'tanıtıldı'],
    [/\bhave been added\b/gi, 'eklendi'],
    [/\bhave been removed\b/gi, 'kaldırıldı'],
    [/\bhave been changed\b/gi, 'değiştirildi'],
    [/\bhave been updated\b/gi, 'güncellendi'],
    [/\bhave been increased\b/gi, 'artırıldı'],
    [/\bhave been decreased\b/gi, 'azaltıldı'],
    [/\bare now available\b/gi, 'artık mevcut'],
    [/\bis now available\b/gi, 'artık mevcut'],
    [/\bnow spawns?\b/gi, 'artık doğuyor'],
    [/\bno longer spawns?\b/gi, 'artık doğmuyor'],
    [/\bQuest\b/g, 'Görev'],
    [/\bquest\b/g, 'görev'],
    [/\bTrader\b/g, 'Tüccar'],
    [/\btrader\b/g, 'tüccar'],
    [/\bBosses\b/gi, 'Patronlar'],
    [/\bScavs\b/gi, "Scav'lar"],
    [/\bspawn rate\b/gi, 'doğma oranı'],
    [/\bflea market\b/gi, 'bit pazarı'],
    [/\bfound in raid\b/gi, 'baskında bulunmuş'],
    [/\bhideout\b/gi, 'sığınak'],
    [/\bon all maps\b/gi, 'tüm haritalarda'],
    [/\bon maps\b/gi, 'haritalarda'],
    [/\bincreased\b/gi, 'artırıldı'],
    [/\bdecreased\b/gi, 'azaltıldı'],
    [/\benabled\b/gi, 'aktif edildi'],
    [/\bdisabled\b/gi, 'devre dışı'],
    [/\band\b/g, 've'],
  ];

  for (const [pattern, replacement] of wordPatterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function translateMaps(mapStr) {
  const mapNames = {
    'Customs': 'Gümrük',
    'Woods': 'Orman',
    'Shoreline': 'Kıyı Şeridi',
    'Lighthouse': 'Deniz Feneri',
    'Interchange': 'Interchange',
    'Factory': 'Fabrika',
    'Reserve': 'Rezerv',
    'Streets of Tarkov': 'Tarkov Sokakları',
    'Streets': 'Sokaklar',
    'Ground Zero': 'Sıfır Noktası',
    'Lab': 'Laboratuvar',
    'The Lab': 'Laboratuvar',
  };
  let result = mapStr;
  for (const [en, tr] of Object.entries(mapNames)) {
    result = result.replace(new RegExp(en, 'gi'), tr);
  }
  return result;
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
