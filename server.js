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
