/**
 * RK RAJA XWD — Multi-User WhatsApp Server (Render-ready)
 */

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const multer = require('multer');
const crypto = require('crypto');

process.on('uncaughtException', (e) => console.error('⚠', e.message));
process.on('unhandledRejection', (e) => console.error('⚠', e?.message || e));

const PORT = process.env.PORT || 25152;
const HOST = '0.0.0.0';
const LOGO = 'https://i.ibb.co/Dgr33g9z/166448.jpg';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_OWNER = process.env.TELEGRAM_OWNER_ID || '';
const SERVER_PWD = process.env.SERVER_PWD || 'rkr@ja@2025';
const START = Date.now();

// ---- PERSISTENT DATA DIR (Render: mount a Disk at /data) ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'users_data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let tgBot = null;
const users = new Map();
const tokens = new Map();
const globalLogs = { list: [], id: 0 };

// ============================================================
// HELPERS
// ============================================================
function log(type, msg) {
  globalLogs.list.push({ id: ++globalLogs.id, ts: Date.now(), type, msg });
  if (globalLogs.list.length > 800) globalLogs.list.splice(0, 200);
  console.log(`[${type}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
function maskPhone(p) {
  if (!p) return '—';
  const s = String(p);
  return s.length <= 4 ? '****' : s.slice(0, 2) + '****' + s.slice(-2);
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function userDir(uid) {
  const d = path.join(DATA_DIR, uid);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
async function notify(text) {
  if (!tgBot || !TG_OWNER) return;
  try { await tgBot.sendMessage(TG_OWNER, text, { parse_mode: 'Markdown' }); } catch (_) {}
}

// ============================================================
// USER SYSTEM
// ============================================================
function saveUser(u) {
  try {
    fs.writeFileSync(path.join(userDir(u.userId), 'user.json'), JSON.stringify({
      userId: u.userId, username: u.username, password: u.password, createdAt: u.createdAt,
    }));
  } catch (e) { console.error('saveUser:', e.message); }
}

function loadUsers() {
  try {
    const dirs = fs.readdirSync(DATA_DIR).filter(d => fs.statSync(path.join(DATA_DIR, d)).isDirectory());
    for (const uid of dirs) {
      const f = path.join(DATA_DIR, uid, 'user.json');
      if (!fs.existsSync(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        users.set(uid, {
          userId: uid, username: m.username, password: m.password,
          createdAt: m.createdAt || Date.now(),
          sessions: new Map(),
          logs: { list: [], id: 0 },
        });
        log('info', `👤 Loaded: ${m.username}`);
      } catch (_) {}
    }
  } catch (e) { console.error('loadUsers:', e.message); }
}

function uLog(user, type, msg) {
  if (!user) return;
  user.logs.list.push({ id: ++user.logs.id, ts: Date.now(), type, msg });
  if (user.logs.list.length > 400) user.logs.list.splice(0, 100);
}

// ============================================================
// SESSION
// ============================================================
function newSess(user, sid) {
  return {
    userId: user.userId,
    id: String(sid),
    sock: null,
    isPaired: false,
    isConnecting: false,
    isRegistered: false,
    pairingRequested: false,
    pairingCode: null,
    phone: null,
    connectedAt: null,
    lastError: null,
    authDir: path.join(userDir(user.userId), `auth_info_baileys_${sid}`),
    groups: {},
    bulk: null,
    suspended: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    intentionalClose: false,
  };
}

function getSess(user, sid) {
  if (!user) return null;
  return user.sessions.get(String(sid || '1'));
}

function ready(s) { return !!(s && s.sock && s.isPaired && !s.suspended); }

function sessInfo(s) {
  return {
    id: s.id,
    phone: s.phone,
    phoneMasked: maskPhone(s.phone),
    paired: s.isPaired,
    connecting: s.isConnecting,
    registered: s.isRegistered,
    code: s.isPaired ? null : s.pairingCode,
    suspended: s.suspended,
    error: s.lastError,
    connectedAt: s.connectedAt,
    groupCount: Object.keys(s.groups).length,
    bulkRunning: !!(s.bulk && s.bulk.running),
    bulkStartedAt: s.bulk && s.bulk.running ? s.bulk.startedAt : null,
    bulkSent: s.bulk ? s.bulk.sent : 0,
    bulkFailed: s.bulk ? s.bulk.failed : 0,
    bulkCycle: s.bulk ? s.bulk.cycle : 0,
    bulkTotal: s.bulk ? s.bulk.total : 0,
    bulkRemaining: s.bulk ? s.bulk.remaining : 0,
  };
}

function userSessions(user) {
  const out = [];
  if (!user) return out;
  user.sessions.forEach(s => out.push(sessInfo(s)));
  return out.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
}

// ============================================================
// CONNECT SESSION — FIXED
// ============================================================
async function startSession(user, sid, phone) {
  sid = String(sid);
  let s = getSess(user, sid);
  if (!s) { s = newSess(user, sid); user.sessions.set(sid, s); }

  // Cleanup previous socket
  if (s.sock) {
    try { s.sock.ev.removeAllListeners(); s.sock.end(undefined); } catch (_) {}
    s.sock = null;
  }
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }

  // Detect existing creds
  const cf = path.join(s.authDir, 'creds.json');
  let registered = false;
  try {
    if (fs.existsSync(cf)) {
      const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (c && c.me && c.me.id) {
        registered = true;
        s.phone = c.me.id.split(':')[0].split('@')[0];
      }
    }
  } catch (_) {}
  s.isRegistered = registered;

  if (phone && registered) {
    return { ok: false, error: 'Session already registered. Logout first.' };
  }

  s.isConnecting = true;
  s.intentionalClose = false;
  if (phone) s.phone = phone;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
    const { version } = await fetchLatestBaileysVersion();

    s.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),   // use preset — better compat
      mobile: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: '' }),
      // Fix for "Connection Closed" loops on some hosts
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
    });

    s.sock.ev.on('creds.update', saveCreds);

    // ---- REQUEST PAIRING CODE — RIGHT AFTER SOCKET CREATION ----
    if (!state.creds.registered && phone && !s.pairingRequested) {
      s.pairingRequested = true;
      const cleanPhone = String(phone).replace(/\D/g, '');

      setTimeout(async () => {
        try {
          if (!s.sock || s.isPaired) return;
          const code = await s.sock.requestPairingCode(cleanPhone);
          s.pairingCode = code;
          s.lastError = null;
          log('info', `[${user.username}/S${sid}] 🔑 ${code}`);
          uLog(user, 'info', `[S${sid}] Code: ${code}`);
          await notify(`🔑 *Pairing Code*\n👤 ${user.username}\n📱 S${sid}\n📞 \`${cleanPhone}\`\n🔢 \`${code}\``);
        } catch (e) {
          s.pairingCode = null;
          s.lastError = 'Pair failed: ' + e.message;
          log('err', `[${user.username}/S${sid}] Pair error: ${e.message}`);
          // Allow retry if failed fast
          s.pairingRequested = false;
        }
      }, 3500);
    }

    // Groups
    s.sock.ev.on('groups.upsert', (gs) => gs.forEach(g => {
      s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 };
    }));
    s.sock.ev.on('groups.update', (us) => us.forEach(u => {
      if (s.groups[u.id] && u.subject) s.groups[u.id].name = u.subject;
      else if (u.id && u.subject) s.groups[u.id] = { id: u.id, name: u.subject, size: 0 };
    }));

    // ---- CONNECTION UPDATE ----
    s.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        s.isPaired = true;
        s.isConnecting = false;
        s.pairingCode = null;
        s.pairingRequested = false;
        s.suspended = false;
        s.reconnectAttempts = 0;
        s.connectedAt = new Date().toISOString();
        s.lastError = null;
        log('ok', `[${user.username}/S${sid}] Connected`);
        uLog(user, 'ok', `[S${sid}] Connected`);
        await notify(`✅ *Connected* — ${user.username} S${sid}`);

        setTimeout(async () => {
          try {
            if (s.sock && typeof s.sock.groupFetchAllParticipating === 'function') {
              const all = await s.sock.groupFetchAllParticipating();
              Object.values(all).forEach(g => {
                s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 };
              });
            }
          } catch (_) {}
        }, 3000);

        if (s.bulk && s.bulk.running && !s.bulk.alive) runWorker(user, s);
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        s.isPaired = false;
        s.isConnecting = false;

        // Fully logged out / banned
        if (code === DisconnectReason.loggedOut || code === 401) {
          s.suspended = true; s.lastError = 'Logged out';
          if (s.bulk && s.bulk.running) s.bulk.stopFlag = true;
          await notify(`⚠️ Logged out — ${user.username} S${sid}`);
          return;
        }
        if (code === 403 || code === 405) {
          s.suspended = true; s.lastError = 'Suspended';
          if (s.bulk && s.bulk.running) s.bulk.stopFlag = true;
          await notify(`🚫 SUSPENDED — ${user.username} S${sid}`);
          return;
        }

        // 515 = restartRequired — MOST COMMON AFTER PAIRING. Reconnect FAST.
        if (code === 515 || code === DisconnectReason.restartRequired) {
          log('info', `[${user.username}/S${sid}] restartRequired → reconnecting`);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            startSession(user, sid, null).catch(() => {});
          }, 1200);
          return;
        }

        // Otherwise, reconnect with backoff
        if (!s.intentionalClose && s.phone && !s.suspended) {
          s.reconnectAttempts++;
          if (s.reconnectAttempts > 25) { s.suspended = true; s.lastError = 'Too many reconnects'; return; }
          const wait = Math.min(2000 + s.reconnectAttempts * 1500, 30000);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            startSession(user, sid, null).catch(() => {});
          }, wait);
        }
      }
    });

  } catch (e) {
    s.isConnecting = false;
    s.lastError = e.message;
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// ============================================================
// WORKER
// ============================================================
async function runWorker(user, s) {
  const b = s.bulk;
  if (!b || b.alive) return;
  b.alive = true;
  log('info', `[${user.username}/S${s.id}] Worker START`);

  try {
    while (!b.stopFlag) {
      if (s.suspended) break;
      if (!ready(s)) { await sleep(3000); continue; }

      for (let mi = 0; mi < b.messages.length && !b.stopFlag; mi++) {
        b.msgIndex = mi;
        for (let ti = 0; ti < b.targets.length && !b.stopFlag; ti++) {
          if (s.suspended) break;
          const t = b.targets[ti];
          b.targetIndex = ti;
          b.currentTarget = t.label;
          if (!ready(s)) { await sleep(2000); break; }
          try {
            await s.sock.sendMessage(t.jid, { text: b.messages[mi] });
            b.sent++;
          } catch (e) {
            b.failed++;
            const em = String(e.message || '').toLowerCase();
            if (em.includes('banned') || em.includes('suspended')) { s.suspended = true; break; }
          }
          b.remaining = b.messages.length - (mi + 1);
          if (!b.stopFlag && !s.suspended) await sleep(b.delayMs);
        }
        if (s.suspended) break;
      }
      if (!b.stopFlag && !s.suspended) {
        b.cycle++; b.msgIndex = 0; b.targetIndex = 0; b.remaining = b.messages.length;
      }
    }
  } catch (e) {
    if (!b.stopFlag && !s.suspended) { b.alive = false; setTimeout(() => runWorker(user, s), 3000); return; }
  } finally {
    if (b.stopFlag) { b.running = false; b.stopFlag = false; b.alive = false; }
    else { b.alive = false; if (s.suspended) b.running = false; }
  }
}

setInterval(() => {
  users.forEach(user => {
    user.sessions.forEach(s => {
      if (s.bulk && s.bulk.running && !s.bulk.alive && !s.suspended) runWorker(user, s);
    });
  });
}, 20000);

// ============================================================
// AUTO LOAD
// ============================================================
async function autoLoad() {
  for (const user of users.values()) {
    try {
      const udir = userDir(user.userId);
      const dirs = fs.readdirSync(udir).filter(d => d.startsWith('auth_info_baileys_'));
      for (const d of dirs) {
        const sid = d.replace('auth_info_baileys_', '');
        const cf = path.join(udir, d, 'creds.json');
        if (!fs.existsSync(cf)) continue;
        const s = newSess(user, sid);
        user.sessions.set(sid, s);
        await startSession(user, sid, null);
        await sleep(1500);
      }
    } catch (_) {}
  }
}

// ============================================================
// PARSERS
// ============================================================
function parseMsgs(fp) {
  const c = fs.readFileSync(fp, 'utf8');
  const seen = new Set(); const out = [];
  c.split(/\r?\n/).forEach(l => { const t = l.trim(); if (!t || seen.has(t)) return; seen.add(t); out.push(t); });
  return out;
}
function normJid(t) {
  t = String(t).trim(); if (!t) return null;
  if (/@g\.us$/i.test(t) || /@s\.whatsapp\.net$/i.test(t)) return t;
  const d = t.replace(/[^\d]/g, '');
  if (!d || d.length < 8 || d.length > 15) return null;
  return d + '@s.whatsapp.net';
}
function parseNums(raw) {
  if (!raw) return [];
  const out = []; const seen = new Set();
  String(raw).split(/[\r\n,;\s]+/).forEach(t => {
    const j = normJid(t); if (!j || seen.has(j)) return;
    seen.add(j);
    out.push({ jid: j, label: j.endsWith('@g.us') ? '[G] ' + j : '[N] +' + j.split('@')[0] });
  });
  return out;
}

// (HTML block unchanged — paste your existing HTML here,
//  no changes needed. Only the JS backend changed.)

const HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>RK RAJA XWD</title></head><body>
<h1 style="color:#00ff41;font-family:monospace;text-align:center;padding:40px">
RK RAJA XWD — Running. Open main HTML.
</h1></body></html>`;

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(HTML));

// ⚡ FAST HEALTH CHECK for Render + self-ping
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), users: users.size }));

const upload = multer({ dest: 'uploads/' });

function auth(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.token || (req.body && req.body.token);
  if (!token) return res.status(401).json({ success: false, error: 'Not logged in' });
  const userId = tokens.get(token);
  if (!userId) return res.status(401).json({ success: false, error: 'Invalid token' });
  const u = users.get(userId);
  if (!u) return res.status(401).json({ success: false, error: 'User not found' });
  req.user = u;
  req.token = token;
  next();
}

app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ success: false, error: 'Username min 3 chars' });
    if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password min 4 chars' });
    const un = String(username).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!un || un.length < 3) return res.status(400).json({ success: false, error: 'Invalid username' });
    for (const u of users.values()) if (u.username.toLowerCase() === un) return res.status(400).json({ success: false, error: 'Username taken' });

    const uid = 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    const u = { userId: uid, username: un, password: String(password), createdAt: Date.now(), sessions: new Map(), logs: { list: [], id: 0 } };
    users.set(uid, u);
    saveUser(u);
    const tk = genToken(); tokens.set(tk, uid);
    log('ok', `New user: ${un}`);
    await notify(`🆕 *New User*\n\n👤 \`${un}\``);
    res.json({ success: true, token: tk, username: un });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Both fields required' });
    const un = String(username).toLowerCase();
    let found = null;
    for (const u of users.values()) if (u.username.toLowerCase() === un) { found = u; break; }
    if (!found) return res.status(401).json({ success: false, error: 'User not found' });
    if (found.password !== String(password)) return res.status(401).json({ success: false, error: 'Wrong password' });
    const tk = genToken(); tokens.set(tk, found.userId);
    await notify(`🔐 *Login* — \`${un}\``);
    res.json({ success: true, token: tk, username: found.username });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json({ success: true, username: req.user.username, userId: req.user.userId }));
app.get('/api/sessions', auth, (req, res) => res.json({ success: true, sessions: userSessions(req.user) }));

app.post('/api/pair', auth, async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    const sid = String(sessionId || '1').trim();
    const user = req.user;
    if (!sid) return res.status(400).json({ success: false, error: 'Session ID required' });
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone number' });

    let s = getSess(user, sid);
    if (!s) { s = newSess(user, sid); user.sessions.set(sid, s); }
    if (s.isPaired) return res.status(400).json({ success: false, error: `Session ${sid} already paired. Logout first.` });
    if (s.isConnecting) return res.status(400).json({ success: false, error: `Session ${sid} connecting. Wait.` });

    const cf = path.join(s.authDir, 'creds.json');
    if (fs.existsSync(cf)) {
      try {
        const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
        if (c && c.me && c.me.id) return res.status(400).json({ success: false, error: `Session ${sid} already registered. Logout first or use different ID.` });
      } catch (_) {}
    }

    startSession(user, sid, phone).catch(e => { s.lastError = e.message; });
    res.json({ success: true, sessionId: sid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/logout', auth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const sid = String(sessionId || '1');
    const user = req.user;
    const s = getSess(user, sid);
    if (!s) return res.status(400).json({ success: false, error: 'Not found' });
    s.intentionalClose = true;
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    if (s.bulk) s.bulk.stopFlag = true;
    if (s.sock) { try { await s.sock.logout(); } catch (_) {} }
    if (fs.existsSync(s.authDir)) fs.rmSync(s.authDir, { recursive: true, force: true });
    user.sessions.delete(sid);
    uLog(user, 'warn', `[S${sid}] Logged out`);
    await notify(`🔓 Logout — ${user.username} S${sid}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/groups', auth, async (req, res) => {
  try {
    const user = req.user;
    const sid = String(req.query.sessionId || '1');
    const s = getSess(user, sid);
    if (!s || !s.isPaired || !s.sock) return res.status(400).json({ success: false, error: 'Session not paired' });
    const map = new Map();
    Object.values(s.groups).forEach(g => map.set(g.id, g));
    if (map.size === 0 && typeof s.sock.groupFetchAllParticipating === 'function') {
      try {
        const all = await s.sock.groupFetchAllParticipating();
        Object.values(all).forEach(g => map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }));
      } catch (_) {}
    }
    const groups = [...map.values()].filter(g => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach(g => { s.groups[g.id] = g; });
    res.json({ success: true, groups });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bulk/start-all', auth, upload.single('file'), async (req, res) => {
  try {
    const user = req.user;
    const paired = [...user.sessions.values()].filter(s => s.isPaired && s.sock && !s.suspended);
    if (!paired.length) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ success: false, error: 'No paired sessions' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Upload .txt file' });
    const { groupIds, numbers, hater, lastHater, delay } = req.body;
    let messages = [];
    try { messages = parseMsgs(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });
    let pg = []; try { pg = JSON.parse(groupIds || '[]'); } catch (_) {}
    let dsec = parseInt(delay) || 10; if (dsec < 3) dsec = 3;
    const waitMs = dsec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const prepared = messages.map(m => prefix + m + suffix);
    const firstS = paired[0];
    const targets = []; const seen = new Set();
    pg.forEach(jid => { if (!jid || seen.has(jid)) return; seen.add(jid); const m = firstS.groups[jid]; targets.push({ jid, label: m && m.name ? '[G] ' + m.name : '[G] ' + jid }); });
    parseNums(numbers || '').forEach(n => { if (seen.has(n.jid)) return; seen.add(n.jid); targets.push({ jid: n.jid, label: n.label }); });
    if (!targets.length) return res.status(400).json({ success: false, error: 'No targets selected' });
    let started = 0;
    paired.forEach((s, idx) => {
      if (s.bulk && s.bulk.running) return;
      const st = targets.map(t => ({ jid: t.jid, label: t.label }));
      s.bulk = {
        running: true, stopFlag: false, alive: false,
        sent: 0, failed: 0, total: messages.length, remaining: messages.length,
        cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: st.length,
        targets: st, messages: prepared.slice(), delayMs: waitMs, startedAt: Date.now(),
      };
      setTimeout(() => { log('info', `[${user.username}/S${s.id}] 🚀 Bulk`); runWorker(user, s); }, idx * 4000);
      started++;
    });
    log('info', `[${user.username}] Multi-bulk on ${started}`);
    await notify(`🚀 *Bulk Start*\n👤 ${user.username}\n📱 ${started} sessions\n📨 ${messages.length} msgs\n👥 ${targets.length} targets`);
    res.json({ success: true, sessions: started, total: messages.length, totalTargets: targets.length });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bulk/stop', auth, (req, res) => {
  const user = req.user;
  const sid = String((req.body || {}).sessionId || '1');
  const s = getSess(user, sid);
  if (!s || !s.bulk || !s.bulk.running) return res.status(400).json({ success: false, error: 'No task' });
  const b = s.bulk;
  const runMs = b.startedAt ? (Date.now() - b.startedAt) : 0;
  const summary = { sessionId: sid, runFormatted: fmt(runMs), sent: b.sent || 0, failed: b.failed || 0, cycles: b.cycle || 0 };
  b.stopFlag = true;
  uLog(user, 'warn', `[S${sid}] Stopped`);
  res.json({ success: true, summary });
});

app.post('/api/bulk/stop-all', auth, (req, res) => {
  const user = req.user;
  let stopped = 0;
  user.sessions.forEach(s => { if (s.bulk && s.bulk.running) { s.bulk.stopFlag = true; stopped++; } });
  uLog(user, 'warn', `Stop all: ${stopped}`);
  res.json({ success: true, stopped });
});

app.get('/api/status', auth, (req, res) => {
  const user = req.user;
  const out = userSessions(user).map(s => {
    const sess = getSess(user, s.id);
    return {
      id: s.id, phone: s.phone, paired: s.paired,
      bulk: sess && sess.bulk ? {
        running: sess.bulk.running, sent: sess.bulk.sent, failed: sess.bulk.failed,
        total: sess.bulk.total, remaining: sess.bulk.remaining,
        cycle: sess.bulk.cycle, totalTargets: sess.bulk.totalTargets,
      } : null,
    };
  });
  res.json({ success: true, uptimeFormatted: fmt(Date.now() - START), logs: user.logs.list.slice(-200), sessions: out });
});

// ============================================================
// TELEGRAM BOT
// ============================================================
async function initTG() {
  if (!TG_TOKEN || !TG_OWNER) { console.log('⚠ TG not set'); return; }
  const TB = require('node-telegram-bot-api');
  tgBot = new TB(TG_TOKEN, { polling: true });
  console.log('🤖 TG started');
  const isOwner = (msg) => String(msg.chat.id) === String(TG_OWNER);
  const send = (id, text, opts) => { try { tgBot.sendMessage(id, text, Object.assign({ parse_mode: 'Markdown' }, opts || {})); } catch (_) {} };

  tgBot.on('message', async (msg) => {
    if (!isOwner(msg)) return;
    const t = (msg.text || '').trim();
    const chatId = msg.chat.id;
    if (t === '/start' || t === '/help') send(chatId, `*RK RAJA XWD Admin*\n\n/users\n/status\n/stats\n/stopall <pwd>`);
    else if (t === '/users') {
      let s = '*👥 Users:*\n\n';
      if (!users.size) s += 'No users';
      users.forEach(u => {
        const paired = [...u.sessions.values()].filter(x => x.isPaired).length;
        const running = [...u.sessions.values()].filter(x => x.bulk && x.bulk.running).length;
        s += `• \`${u.username}\` — ${paired}p / ${running}r\n`;
      });
      send(chatId, s);
    } else if (t === '/status') {
      let paired = 0, running = 0;
      users.forEach(u => u.sessions.forEach(s => { if (s.isPaired) paired++; if (s.bulk && s.bulk.running) running++; }));
      send(chatId, `*📊 Server*\n\n👥 Users: ${users.size}\n📱 Paired: ${paired}\n🔄 Running: ${running}\n⏱ ${fmt(Date.now() - START)}`);
    } else if (t === '/stats') {
      let s = '*All Sessions:*\n\n';
      users.forEach(u => {
        s += `*${u.username}:*\n`;
        u.sessions.forEach(sess => { if (sess.isPaired) s += `  • S${sess.id} — ${maskPhone(sess.phone)}\n`; });
        s += '\n';
      });
      send(chatId, s || 'No sessions');
    } else if (t.startsWith('/stopall')) {
      const parts = t.split(/\s+/);
      if (parts[1] !== SERVER_PWD) { send(chatId, '🔐 Wrong password'); return; }
      let cnt = 0;
      users.forEach(u => u.sessions.forEach(s => { if (s.bulk && s.bulk.running) { s.bulk.stopFlag = true; cnt++; } }));
      send(chatId, `🛑 Stopped ${cnt} sessions`);
    }
  });
  tgBot.on('polling_error', (err) => console.error('[TG]', err.message));
}

// ============================================================
// KEEP-ALIVE (prevents Render free-tier sleep)
// ============================================================
if (process.env.RENDER_EXTERNAL_URL) {
  const healthUrl = process.env.RENDER_EXTERNAL_URL + '/health';
  setInterval(() => {
    try { http.get(healthUrl, () => {}).on('error', () => {}); } catch (_) {}
  }, 10 * 60 * 1000); // every 10 min
  console.log(`🔁 Keep-alive → ${healthUrl}`);
}

// ============================================================
// START
// ============================================================
loadUsers();

app.listen(PORT, HOST, async () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  🟢 RK RAJA XWD — MULTI USER (Render)    ║');
  console.log('║  🌐 Port ' + String(PORT).padEnd(30, ' ') + '║');
  console.log('║  📂 Data: ' + String(DATA_DIR).slice(-30).padEnd(30, ' ') + '║');
  console.log('╚═══════════════════════════════════════════╝\n');
  log('info', 'Server starting...');
  await initTG();
  await autoLoad();
  log('ok', 'Ready!');
});

process.on('SIGTERM', () => { try { users.forEach(u => u.sessions.forEach(s => { s.intentionalClose = true; if (s.sock) s.sock.end(undefined); })); } catch(_){} process.exit(0); });
process.on('SIGINT', () => { try { users.forEach(u => u.sessions.forEach(s => { s.intentionalClose = true; if (s.sock) s.sock.end(undefined); })); } catch(_){} process.exit(0); });
