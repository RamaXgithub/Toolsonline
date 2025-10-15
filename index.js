const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const SESSION_DIR = './session';

let zippy;

async function startSocket() {
  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let waVersion = [2, 2204, 13];
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version)) waVersion = version;
  } catch (e) {
    // gunakan default
  }

  zippy = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    version: waVersion
  });

  zippy.ev.on('creds.update', saveCreds);

  zippy.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed, status:', status);
      if (status !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(() => startSocket().catch(console.error), 3000);
      } else {
        console.log('Session logout — perlu re-auth.');
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected using existing session.');
    }
  });
}

function normalizeNumber(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^0-9+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);  // default ke +62 (Indonesia)
  return s;
}

async function checkSingle(number) {
  if (!zippy) return { number, error: 'socket_not_ready' };
  const normalized = normalizeNumber(number);
  if (!normalized) return { number, error: 'invalid_number' };
  const jid = `${normalized}@s.whatsapp.net`;

  try {
    // cek apakah nomor aktif di WhatsApp
    let onRes = await zippy.onWhatsApp(jid);
    let exists = false;
    // Beberapa versi onWhatsApp bisa return array, bisa objek langsung
    if (Array.isArray(onRes)) {
      exists = onRes[0]?.exists || false;
    } else {
      exists = onRes?.exists || false;
    }
    if (!exists) {
      return { number: normalized, exists: false, type: 'not_on_whatsapp' };
    }

    // Ambil kontak dari cache (jika ada)
    const contact = zippy.contacts?.[jid] || {};

    // Mulai membangun hasil
    const result = {
      number: normalized,
      exists: true,
      isBusinessFlag: contact.isBusiness || false,
      isEnterpriseFlag: contact.isEnterprise || false,
      businessProfile: null,
      type: null
    };

    // Jika flag sudah menunjukkan bisnis / enterprise
    if (result.isEnterpriseFlag) {
      result.type = 'official_enterprise';
    } else if (result.isBusinessFlag) {
      result.type = 'business';
    }

    // Coba panggil getBusinessProfile untuk info lebih lanjut
    try {
      if (zippy.getBusinessProfile) {
        const bp = await zippy.getBusinessProfile(jid);
        if (bp) {
          result.businessProfile = bp;
          // bp biasanya berisi fields seperti verified_name, description, website, etc.
          // Tentukan type berdasarkan data profil
          if (bp.verified_name) {
            result.type = 'business_verified';
          } else {
            // jika belum terdeteksi sebelum, set ke business
            if (!result.type) result.type = 'business_profile_exists';
          }
        }
      }
    } catch (e) {
      // kalau error, kita abaikan dan lanjut fallback
      // console.warn('getBusinessProfile failed for', jid, e.message);
    }

    // Kalau hingga sini type belum ditentukan, pakai fallback heuristik
    if (!result.type) {
      // heuristik sederhana berdasarkan nama kontak / description / keywords
      const nameLower = (contact?.name || contact?.notify || '').toLowerCase();
      const desc = result.businessProfile?.description?.toLowerCase() || '';
      const keywords = ['official', 'business', 'store', 'shop', 'toko', 'co.', 'enterprise'];

      const foundName = keywords.some(k => nameLower.includes(k));
      const foundDesc = keywords.some(k => desc.includes(k));

      if (foundName || foundDesc) {
        result.type = 'business_heuristic';
      } else {
        result.type = 'personal';
      }
    }

    return result;
  } catch (err) {
    return { number: normalized, error: err.message };
  }
}

async function bulkCheck(numbers = [], concurrency = 5) {
  const results = [];
  const q = numbers.slice();
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (q.length) {
      const no = q.shift();
      const res = await checkSingle(no);
      results.push(res);
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  await startSocket();

  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));

  app.get('/', (req, res) => res.json({ ok: true }));

  app.post('/bulk-check', async (req, res) => {
    if (!zippy) return res.status(500).json({ error: 'socket_not_ready' });
    const nums = req.body.numbers;
    if (!Array.isArray(nums) || nums.length === 0) {
      return res.status(400).json({ error: 'numbers array required' });
    }
    const concurrency = Number(req.body.concurrency) || 5;
    const normalized = nums.map(n => normalizeNumber(n)).filter(Boolean);

    const start = Date.now();
    const out = await bulkCheck(normalized, concurrency);
    const took = Date.now() - start;
    return res.json({ took_ms: took, results: out });
  });

  app.listen(PORT, () => {
    console.log(`🚀 Business-detector API running at http://localhost:${PORT}`);
    console.log(`POST /bulk-check  body { numbers: [...], concurrency: N }`);
  });
})();
