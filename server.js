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
