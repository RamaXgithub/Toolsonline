// full script: business-detector with admin apikey generation + list + revoke
// NOTE: conversation in Indonesian, script in English as requested

const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const SESSION_DIR = './session';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://jisami:tiktoklookup09@cluster0.lmqpvci.mongodb.net/tiktokbot?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'whatsapp_api';
const APIKEY_COLLECTION = 'apikeys';

// Default admin key - change this in production or set via env
const DEFAULT_ADMIN_KEY = process.env.ADMIN_API_KEY || 'jisamikeys01';

let zippy;
let db, apiCollection;

// ====== START SOCKET ======
async function startSocket() {
  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let waVersion = [2, 2204, 13];
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version)) waVersion = version;
  } catch (e) {
    // use default version if fetch fails
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
        console.log('Session logout — need re-auth.');
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected using existing session.');
    }
  });
}

// ====== NORMALIZE NUMBER ======
function normalizeNumber(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^0-9+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);  // default to +62 (Indonesia)
  return s;
}

// ====== CHECK SINGLE NUMBER ======
async function checkSingle(number) {
  if (!zippy) return { number, error: 'socket_not_ready' };
  const normalized = normalizeNumber(number);
  if (!normalized) return { number, error: 'invalid_number' };
  const jid = `${normalized}@s.whatsapp.net`;

  try {
    let onRes = await zippy.onWhatsApp(jid);
    let exists = Array.isArray(onRes) ? onRes[0]?.exists || false : onRes?.exists || false;

    if (!exists) {
      return { number: normalized, exists: false, type: 'not_on_whatsapp' };
    }

    const contact = zippy.contacts?.[jid] || {};

    const result = {
      number: normalized,
      exists: true,
      isBusinessFlag: contact.isBusiness || false,
      isEnterpriseFlag: contact.isEnterprise || false,
      businessProfile: null,
      type: null
    };

    if (result.isEnterpriseFlag) {
      result.type = 'official_enterprise';
    } else if (result.isBusinessFlag) {
      result.type = 'business';
    }

    try {
      if (zippy.getBusinessProfile) {
        const bp = await zippy.getBusinessProfile(jid);
        if (bp) {
          result.businessProfile = bp;
          if (bp.verified_name) {
            result.type = 'business_verified';
          } else {
            if (!result.type) result.type = 'business_profile_exists';
          }
        }
      }
    } catch (e) {
      // ignore business profile errors
    }

    if (!result.type) {
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

// ====== BULK CHECK ======
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

// ====== UTIL: generate secure apikey ======
function generateApiKey() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars
}

// ====== MIDDLEWARE: validate API KEY for normal endpoints ======
async function apiKeyMiddleware(req, res, next) {
  // ambil dari header x-api-key atau query param apikey
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (!key) return res.status(401).json({ error: 'API key required' });

  const apiDoc = await apiCollection.findOne({ key });
  if (!apiDoc) return res.status(403).json({ error: 'Invalid API key' });

  // cek limit
  if (!apiDoc.isAdmin && typeof apiDoc.limit === 'number' && apiDoc.usage >= apiDoc.limit) {
    return res.status(429).json({ error: 'API key usage limit reached' });
  }

  // increment usage
  await apiCollection.updateOne(
    { key },
    { $inc: { usage: 1 }, $set: { lastUsedAt: new Date() } }
  );

  req.apiKeyDoc = apiDoc;
  next();
}

// ====== MIDDLEWARE: admin-only routes ======
async function adminMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Admin API key required' });

  const apiDoc = await apiCollection.findOne({ key });
  if (!apiDoc) return res.status(403).json({ error: 'Invalid API key' });
  if (!apiDoc.isAdmin) return res.status(403).json({ error: 'Admin privileges required' });

  req.adminApiKeyDoc = apiDoc;
  next();
}

// ====== START APP & DB ======
(async () => {
  // connect to mongo
  const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  apiCollection = db.collection(APIKEY_COLLECTION);

  // ensure index on key
  await apiCollection.createIndex({ key: 1 }, { unique: true });

  // create default admin key if not exists
  const existsAdmin = await apiCollection.findOne({ key: DEFAULT_ADMIN_KEY });
  if (!existsAdmin) {
    await apiCollection.insertOne({
      key: DEFAULT_ADMIN_KEY,
      isAdmin: true,
      usage: 0,
      limit: null, // unlimited
      note: 'default-admin',
      createdAt: new Date()
    });
    console.log('Admin API key created:', DEFAULT_ADMIN_KEY);
  } else {
    console.log('Admin API key exists.');
  }

  // start whatsapp socket
  await startSocket();

  // create express app
  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));

  // health
  app.get('/', (req, res) => res.json({ ok: true }));

  // ----- ADMIN ENDPOINT: generate apikey for other users -----
  // body: { limit: number|null, note: string, userId: string }
  app.post('/generate-apikey', adminMiddleware, async (req, res) => {
    try {
      const { limit = 100, note = '', userId = '' } = req.body || {};

      // allow null to mean unlimited; else ensure number or default 100
      const actualLimit = limit === null ? null : (typeof limit === 'number' && limit >= 0 ? limit : 100);

      const newKey = generateApiKey();
      const doc = {
        key: newKey,
        isAdmin: false,
        usage: 0,
        limit: actualLimit,
        note,
        userId,
        createdBy: req.adminApiKeyDoc.key,
        createdAt: new Date(),
        lastUsedAt: null
      };

      await apiCollection.insertOne(doc);

      return res.json({
        success: true,
        key: newKey,
        limit: actualLimit,
        note,
        userId
      });
    } catch (err) {
      console.error('generate-apikey error', err);
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ----- ADMIN: list apikeys -----
  // optional query param: ?showAll=true to include admin keys (by default show all but you may filter)
  app.get('/apikeys', adminMiddleware, async (req, res) => {
    try {
      const docs = await apiCollection.find({}).project({ key: 1, isAdmin: 1, usage: 1, limit: 1, note: 1, userId: 1, createdAt: 1, lastUsedAt: 1 }).toArray();
      return res.json({ success: true, keys: docs });
    } catch (err) {
      console.error('list apikeys error', err);
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ----- ADMIN: revoke apikey -----
  // body: { key: 'key_to_revoke' }
  app.post('/revoke-apikey', adminMiddleware, async (req, res) => {
    try {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });

      const del = await apiCollection.deleteOne({ key });
      if (del.deletedCount === 0) {
        return res.status(404).json({ error: 'key_not_found' });
      }
      return res.json({ success: true, revoked: key });
    } catch (err) {
      console.error('revoke-apikey error', err);
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ----- USER-FACING: bulk check (protected by apiKeyMiddleware) -----
  // ====== USER-FACING: bulk check (POST + GET) ======
// ====== USER-FACING: bulk check (POST + GET) with usage info ======
app.post('/bulk-check', apiKeyMiddleware, async (req, res) => {
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

  // tambahkan info usage & sisa limit
  const usageInfo = {
    usage: req.apiKeyDoc.usage,
    limit: req.apiKeyDoc.limit,
    remaining: req.apiKeyDoc.limit !== null ? Math.max(req.apiKeyDoc.limit - req.apiKeyDoc.usage, 0) : null
  };

  return res.json({ took_ms: took, results: out, usage: usageInfo });
});

app.get('/bulk-check', apiKeyMiddleware, async (req, res) => {
  if (!zippy) return res.status(500).json({ error: 'socket_not_ready' });

  const nums = (req.query.numbers || '').split(',').map(n => n.trim()).filter(Boolean);
  if (!nums.length) return res.status(400).json({ error: 'numbers query param required' });

  const concurrency = Number(req.query.concurrency) || 5;
  const normalized = nums.map(n => normalizeNumber(n)).filter(Boolean);

  const start = Date.now();
  const out = await bulkCheck(normalized, concurrency);
  const took = Date.now() - start;

  const usageInfo = {
    usage: req.apiKeyDoc.usage,
    limit: req.apiKeyDoc.limit,
    remaining: req.apiKeyDoc.limit !== null ? Math.max(req.apiKeyDoc.limit - req.apiKeyDoc.usage, 0) : null
  };

  return res.json({ took_ms: took, results: out, usage: usageInfo });
});

  // ----- OPTIONAL: check single number endpoint (protected) -----
  app.post('/check', apiKeyMiddleware, async (req, res) => {
    if (!zippy) return res.status(500).json({ error: 'socket_not_ready' });
    const number = req.body.number;
    if (!number) return res.status(400).json({ error: 'number required' });

    const result = await checkSingle(number);
    return res.json({ result });
  });

  // ----- Start server -----
  app.listen(PORT, () => {
    console.log(`Business-detector API running at http://localhost:${PORT}`);
    console.log(`Use header 'x-api-key' for authentication.`);
    console.log(`Admin endpoints: POST /generate-apikey, GET /apikeys, POST /revoke-apikey`);
  });

})().catch(err => {
  console.error('Fatal error starting app', err);
  process.exit(1);
});
