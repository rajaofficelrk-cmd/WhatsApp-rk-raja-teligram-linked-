const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

process.on('uncaughtException', (e) => console.error('⚠', e.message));
process.on('unhandledRejection', (e) => console.error('⚠', e?.message || e));

const PORT = process.env.PORT || 25152;
const HOST = '0.0.0.0';
const LOGO = 'https://i.ibb.co/Dgr33g9z/166448.jpg';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '8592499421:AAF066PLyHaizP6NsWwwm7uOOV32pJqwSFE';
const TG_CHAT = process.env.TELEGRAM_OWNER_ID || '@RKRAJA7065';
const START = Date.now();
const DATA_DIR = path.join(__dirname, 'users_data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let tgBot = null;
const users = new Map(); // userId -> user object
const logs = { list: [], id: 0 };

// ===== HELPERS =====
function log(type, msg) {
  logs.list.push({ id: ++logs.id, ts: Date.now(), type, msg });
  if (logs.list.length > 500) logs.list.splice(0, 100);
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
function userDir(uid) {
  const d = path.join(DATA_DIR, uid);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function saveUser(u) {
  try {
    fs.writeFileSync(path.join(userDir(u.userId), 'user.json'), JSON.stringify({
      username: u.username, password: u.password, createdAt: u.createdAt,
    }));
  } catch (_) {}
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
          userId: uid, username: m.username || uid, password: m.password || '',
          createdAt: m.createdAt || Date.now(), sessions: new Map(),
          logs: { list: [], id: 0 },
        });
        log('info', `👤 Loaded: ${m.username}`);
      } catch (_) {}
    }
  } catch (_) {}
}
function uLog(user, type, msg) {
  if (!user) return;
  user.logs.list.push({ id: ++user.logs.id, ts: Date.now(), type, msg });
  if (user.logs.list.length > 300) user.logs.list.splice(0, 100);
}
async function notify(text) {
  if (!tgBot || !TG_CHAT) return;
  try { await tgBot.sendMessage(TG_CHAT, text, { parse_mode: 'Markdown' }); } catch (_) {}
}

// ===== SESSION =====
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

function sessInfo(user) {
  const out = [];
  user.sessions.forEach(s => {
    out.push({
      id: s.id, phone: s.phone, phoneMasked: maskPhone(s.phone),
      paired: s.isPaired, connecting: s.isConnecting,
      registered: s.isRegistered, code: s.isPaired ? null : s.pairingCode,
      suspended: s.suspended, error: s.lastError, connectedAt: s.connectedAt,
      groupCount: Object.keys(s.groups).length,
      bulkRunning: !!(s.bulk?.running),
      bulkStartedAt: s.bulk?.running ? s.bulk.startedAt : null,
      bulkSent: s.bulk?.sent || 0,
      bulkFailed: s.bulk?.failed || 0,
      bulkCycle: s.bulk?.cycle || 0,
    });
  });
  return out.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
}

// ===== CONNECT SESSION =====
async function startSession(user, sid, phone) {
  sid = String(sid);
  let s = getSess(user, sid);
  if (!s) { s = newSess(user, sid); user.sessions.set(sid, s); }

  if (s.sock) { try { s.sock.ev.removeAllListeners(); s.sock.end(undefined); } catch (_) {} s.sock = null; }
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }

  const cf = path.join(s.authDir, 'creds.json');
  let registered = false;
  try {
    if (fs.existsSync(cf)) {
      const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (c?.me?.id) { registered = true; s.phone = c.me.id.split(':')[0].split('@')[0]; }
    }
  } catch (_) {}
  s.isRegistered = registered;

  if (phone && registered) {
    s.lastError = 'Already registered. Logout first.';
    log('err', `[${user.username}/S${sid}] Already registered`);
    return { ok: false, error: 'Session already registered. Logout first.' };
  }

  s.isConnecting = true;
  s.intentionalClose = false;
  if (phone) s.phone = phone;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
    const { version } = await fetchLatestBaileysVersion();

    s.sock = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.0'],
      mobile: false, syncFullHistory: false,
      getMessage: async () => ({ conversation: '' }),
    });

    s.sock.ev.on('creds.update', saveCreds);
    s.sock.ev.on('groups.upsert', (gs) => gs.forEach(g => { s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants?.length || 0 }; }));
    s.sock.ev.on('groups.update', (us) => us.forEach(u => { if (s.groups[u.id] && u.subject) s.groups[u.id].name = u.subject; }));

    s.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'connecting' && !s.sock.authState.creds.registered && !s.pairingRequested && phone) {
        s.pairingRequested = true;
        try {
          await sleep(1500);
          const code = await s.sock.requestPairingCode(String(phone).replace(/[^\d]/g, ''));
          s.pairingCode = code;
          s.lastError = null;
          log('info', `[${user.username}/S${sid}] 🔑 Code: ${code}`);
          uLog(user, 'info', `[S${sid}] Code: ${code}`);
          await notify(`🔑 *Pairing Code*\n\n👤 User: *${user.username}*\n📱 Session: *${sid}*\n📞 Phone: \`${phone}\`\n🔢 Code: \`${code}\``);
        } catch (e) {
          s.pairingCode = null;
          s.pairingRequested = false;
          s.isConnecting = false;
          s.lastError = 'Pair failed: ' + e.message;
          log('err', `[${user.username}/S${sid}] Pair error: ${e.message}`);
        }
      }

      if (connection === 'open') {
        s.isPaired = true; s.isConnecting = false;
        s.pairingCode = null; s.pairingRequested = false;
        s.suspended = false; s.reconnectAttempts = 0;
        s.connectedAt = new Date().toISOString(); s.lastError = null;
        log('ok', `[${user.username}/S${sid}] ✅ Connected`);
        uLog(user, 'ok', `[S${sid}] Connected (${s.phone})`);
        await notify(`✅ *Connected*\n\n👤 User: *${user.username}*\n📱 Session: *${sid}*\n📞 Phone: \`${s.phone}\``);

        setTimeout(async () => {
          try {
            if (s.sock && typeof s.sock.groupFetchAllParticipating === 'function') {
              const all = await s.sock.groupFetchAllParticipating();
              Object.values(all).forEach(g => {
                s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants?.length || 0 };
              });
            }
          } catch (_) {}
        }, 3000);

        if (s.bulk?.running && !s.bulk.alive) runWorker(user, s);
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        s.isPaired = false; s.isConnecting = false;

        if (code === DisconnectReason.loggedOut || code === 401) {
          s.suspended = true; s.lastError = 'Logged out';
          if (s.bulk?.running) s.bulk.stopFlag = true;
          await notify(`⚠️ *Logged out* — User: ${user.username}, S${sid}`);
          return;
        }
        if (code === 403 || code === 405) {
          s.suspended = true; s.lastError = 'Suspended';
          if (s.bulk?.running) s.bulk.stopFlag = true;
          await notify(`🚫 *SUSPENDED* — User: ${user.username}, S${sid}`);
          return;
        }

        if (!s.intentionalClose && s.phone && !s.suspended) {
          s.reconnectAttempts++;
          if (s.reconnectAttempts > 15) { s.suspended = true; s.lastError = 'Too many reconnects'; return; }
          const wait = Math.min(2000 + s.reconnectAttempts * 1500, 20000);
          log('warn', `[${user.username}/S${sid}] Reconnect in ${Math.round(wait/1000)}s`);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            startSession(user, sid, null).catch(() => {});
          }, wait);
        }
      }
    });

  } catch (e) {
    s.isConnecting = false; s.lastError = e.message;
    log('err', `[${user.username}/S${sid}] Init: ${e.message}`);
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// ===== WORKER =====
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
            if (em.includes('banned') || em.includes('suspended') || em.includes('401')) { s.suspended = true; break; }
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
    log('err', `[${user.username}/S${s.id}] Worker crash: ${e.message}`);
    if (!b.stopFlag && !s.suspended) { b.alive = false; setTimeout(() => runWorker(user, s), 3000); return; }
  } finally {
    if (b.stopFlag) { b.running = false; b.stopFlag = false; b.alive = false; }
    else { b.alive = false; if (s.suspended) b.running = false; }
  }
}

setInterval(() => {
  users.forEach(user => {
    user.sessions.forEach(s => {
      if (s.bulk?.running && !s.bulk.alive && !s.suspended) runWorker(user, s);
    });
  });
}, 20000);

// ===== AUTO LOAD =====
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
        await sleep(1200);
      }
    } catch (_) {}
  }
}

// ===== HELPERS =====
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

// ===== HTML =====
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>RK RAJA XWD</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Share Tech Mono',monospace;background:#000;color:#00ff41;min-height:100vh;padding:14px;position:relative}
body::before{content:"";position:fixed;inset:0;z-index:-2;background:url('${LOGO}') center top/cover no-repeat;filter:blur(3px) brightness(.4) hue-rotate(90deg) saturate(1.4)}
body::after{content:"";position:fixed;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(0,0,0,.78),rgba(0,0,0,.95));pointer-events:none}
.container{max-width:900px;margin:0 auto;position:relative;z-index:1}
.hero{text-align:center;margin-bottom:14px;position:relative;padding:10px 0}
.hero-img{max-width:140px;width:42vw;border-radius:12px;filter:drop-shadow(0 0 30px #00ff41) brightness(1.1);position:relative;z-index:2;display:inline-block}
.hero-glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:220px;height:220px;background:radial-gradient(circle,rgba(0,255,65,.45) 0%,transparent 70%);z-index:1;pointer-events:none;animation:pg 3s ease-in-out infinite}
@keyframes pg{0%,100%{opacity:.7}50%{opacity:1}}
h1{font-size:28px;color:#00ff41;text-shadow:0 0 15px #00ff41,0 0 30px rgba(0,255,65,.6);letter-spacing:4px;text-align:center;margin:12px 0 4px;text-transform:uppercase;font-weight:900}
h1 .x{color:#fff}
.sub{text-align:center;color:#009922;font-size:11px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px}
.tbar-top{display:flex;justify-content:space-between;align-items:center;padding:9px 13px;background:rgba(0,20,5,.9);border:1px solid rgba(0,255,65,.4);border-radius:6px;margin-bottom:14px;font-size:12px}
.tbar-top b{color:#00ff41}
.tbar-top button{width:auto;padding:6px 12px;font-size:10px;margin:0;background:transparent;border:1px solid rgba(0,255,65,.5);color:#00ff41}
.term{background:rgba(0,0,0,.9);border:1px solid rgba(0,255,65,.5);border-radius:8px;overflow:hidden;margin-bottom:14px;box-shadow:0 0 30px rgba(0,255,65,.3)}
.tbar{background:#001500;padding:8px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(0,255,65,.3)}
.dot{width:11px;height:11px;border-radius:50%}
.dr{background:#ff5f56}.dy{background:#ffbd2e}.dg{background:#27c93f}
.ttitle{margin-left:8px;color:#00ff41;font-size:11px;letter-spacing:1.5px}
.tbody{padding:12px 14px;font-size:12px;line-height:1.8}
.ok{color:#00ff41;text-shadow:0 0 8px #00ff41}
.cur{background:#00ff41;display:inline-block;width:9px;height:14px;vertical-align:middle;animation:bl 1s infinite}
@keyframes bl{0%,50%{opacity:1}51%,100%{opacity:0}}
.card{background:rgba(0,15,0,.85);border:1px solid rgba(0,255,65,.35);border-radius:8px;padding:16px;margin-bottom:12px}
.card h2{font-size:13px;color:#00ff41;letter-spacing:2px;margin-bottom:12px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.card h2::before{content:"";width:8px;height:8px;border-radius:50%;background:#00ff41;box-shadow:0 0 12px #00ff41;animation:bl 1.5s infinite}
label{display:block;font-size:11px;color:#009922;margin-bottom:5px;letter-spacing:1.5px;text-transform:uppercase}
input,textarea,select{width:100%;background:rgba(0,20,5,.9);border:1px solid rgba(0,255,65,.4);border-radius:6px;padding:11px 13px;color:#00ff41;font-size:16px;font-family:inherit;outline:none}
input:focus,textarea:focus{border-color:#00ff41;box-shadow:0 0 15px rgba(0,255,65,.4)}
input::placeholder,textarea::placeholder{color:#005518}
textarea{resize:vertical;min-height:70px}
.field{margin-bottom:11px}
button{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000;border:none;border-radius:6px;padding:13px 20px;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;margin-top:6px;width:100%;font-family:inherit}
button:disabled{background:#0a1a0a;color:#005518;cursor:not-allowed}
button.ghost{background:transparent;border:1px solid rgba(0,255,65,.5);color:#00ff41}
button.danger{background:linear-gradient(180deg,#ff003c,#aa0022);color:#fff}
.btnrow{display:flex;gap:8px}.btnrow button{margin-top:0}
.msg{margin-top:10px;padding:10px 13px;border-radius:6px;font-size:12px;display:none}
.msg.ok{background:rgba(0,255,65,.12);color:#00ff41;border:1px solid rgba(0,255,65,.5);display:block}
.msg.err{background:rgba(255,0,60,.12);color:#ff5f7f;border:1px solid rgba(255,0,60,.5);display:block}
.code{background:rgba(0,20,5,.9);border:2px dashed #00ff41;border-radius:8px;padding:18px;margin:12px 0;text-align:center;box-shadow:0 0 30px rgba(0,255,65,.4);animation:cp 1.5s ease-in-out infinite}
@keyframes cp{0%,100%{box-shadow:0 0 30px rgba(0,255,65,.4)}50%{box-shadow:0 0 50px rgba(0,255,65,.8)}}
.codev{font-size:34px;font-weight:900;letter-spacing:8px;color:#00ff41;text-shadow:0 0 25px #00ff41;font-family:'Courier New',monospace}
.codel{font-size:11px;color:#009922;letter-spacing:3px;margin-bottom:8px;text-transform:uppercase}
.steps{background:rgba(0,15,0,.6);border:1px solid rgba(0,255,65,.25);border-radius:6px;padding:11px;font-size:12px;line-height:1.8;color:#009922;margin-top:10px}
.steps b{color:#00ff41}
.stat{background:rgba(0,15,0,.75);border:1px solid rgba(0,255,65,.25);border-radius:8px;padding:12px;text-align:center}
.stat .k{font-size:10px;color:#009922;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
.stat .v{font-size:18px;font-weight:900;color:#00ff41}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.log{background:#000;border:1px solid rgba(0,255,65,.3);border-radius:8px;padding:12px;height:260px;overflow-y:auto;font-size:12px;line-height:1.7}
.log .line{color:#009922;border-bottom:1px dashed rgba(0,255,65,.08);padding:2px 0;word-break:break-all}
.log .t{color:#00ff41;margin-right:6px}
.log .ok{color:#00ff41}.log .err{color:#ff5f7f}.log .info{color:#00aaff}.log .warn{color:#ffcc00}
.hint{font-size:11px;color:#006622;margin-top:5px}
.empty{padding:22px;text-align:center;color:#005518;font-size:12px}
.session{padding:13px;background:rgba(0,15,0,.75);border:1px solid rgba(0,255,65,.3);border-radius:8px;margin-bottom:9px}
.session.active{border-color:#00ff41;background:rgba(0,255,65,.08)}
.session.susp{border-color:#ff003c;background:rgba(255,0,60,.1)}
.shead{display:flex;justify-content:space-between;align-items:center;gap:10px}
.sname{color:#00ff41;font-size:14px;font-weight:700}
.sstatus{color:#009922;font-size:11px;margin-top:2px}
.sactions{display:flex;gap:6px;flex-wrap:wrap}
.sactions button{width:auto;padding:7px 11px;font-size:10px;margin:0}
.foot{text-align:center;color:#005518;font-size:11px;letter-spacing:3px;margin-top:22px;text-transform:uppercase;line-height:1.8}
.lock{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.95);display:flex;align-items:center;justify-content:center;padding:18px;overflow-y:auto}
.lock::before{content:"";position:absolute;inset:0;background:url('${LOGO}') center/cover;filter:blur(8px) brightness(.3) hue-rotate(90deg);z-index:-1}
.lock-box{max-width:400px;width:100%;background:rgba(0,15,0,.95);border:1px solid rgba(0,255,65,.5);border-radius:12px;padding:26px 22px;box-shadow:0 0 40px rgba(0,255,65,.4);margin:auto}
.lock-box h2{color:#00ff41;text-align:center;font-size:20px;letter-spacing:3px;margin-bottom:4px;text-transform:uppercase}
.lock-box .sub2{text-align:center;color:#009922;font-size:11px;letter-spacing:2px;margin-bottom:20px}
.lock-switch{text-align:center;color:#009922;font-size:12px;margin-top:12px;cursor:pointer;padding:8px}
.lock-switch b{color:#00ff41;text-decoration:underline}
.hide{display:none !important}
</style>
</head>
<body>

<div class="lock" id="lockScreen">
  <div class="lock-box">
    <h2>RK RAJA <span style="color:#fff">XWD</span></h2>
    <div class="sub2">WHATSAPP SERVER</div>

    <div id="loginBox">
      <div class="field"><label>Username</label><input id="loginUser" type="text" placeholder="username" autocomplete="off"/></div>
      <div class="field"><label>Password</label><input id="loginPass" type="password" placeholder="password" autocomplete="off"/></div>
      <button onclick="doLogin()">Login</button>
      <div class="lock-switch" onclick="showSignup()">New user? <b>Create Account →</b></div>
    </div>

    <div id="signupBox" class="hide">
      <div class="field"><label>Username (min 3)</label><input id="signupUser" type="text" placeholder="choose username"/></div>
      <div class="field"><label>Password (min 4)</label><input id="signupPass" type="password" placeholder="choose password"/></div>
      <div class="field"><label>Confirm Password</label><input id="signupPass2" type="password" placeholder="confirm"/></div>
      <button onclick="doSignup()">Create Account</button>
      <div class="lock-switch" onclick="showLogin()">← Back to Login</div>
    </div>

    <div id="lockMsg" class="msg"></div>
  </div>
</div>

<div class="container hide" id="app">
  <div class="tbar-top">
    <div>👤 <b id="topUser">—</b></div>
    <button onclick="doLogout()">Logout</button>
  </div>

  <div class="hero"><div class="hero-glow"></div><img src="${LOGO}" class="hero-img" onerror="this.style.display='none'"/></div>
  <h1>RK RAJA <span class="x">XWD</span></h1>
  <div class="sub">WHATSAPP SERVER</div>

  <div class="term">
    <div class="tbar"><span class="dot dr"></span><span class="dot dy"></span><span class="dot dg"></span><span class="ttitle">root@rk-raja — whatsapp-server</span></div>
    <div class="tbody">
      <div><span style="color:#00ff41">root@rk-raja:~#</span> <span style="color:#fff">whatsapp-server</span></div>
      <div><span class="ok">[+]</span> Checking environment ... <span class="ok">OK</span></div>
      <div><span class="ok">[+]</span> Connecting to WhatsApp ... <span class="ok">OK</span></div>
      <div><span class="ok">[+]</span> Server is running ...</div>
      <div><span style="color:#00ff41">root@rk-raja:~#</span> <span class="cur"></span></div>
    </div>
  </div>

  <div class="card">
    <h2>Add WhatsApp Number</h2>
    <div class="field">
      <label>Session ID (1, 2, 3...)</label>
      <input id="sid" type="text" value="1"/>
      <div class="hint">Har number ke liye alag ID</div>
    </div>
    <div class="field">
      <label>Phone (country code, no + or spaces)</label>
      <input id="phone" type="tel" placeholder="919876543210"/>
    </div>
    <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
    <div id="pairMsg" class="msg"></div>
    <div id="codeSec" class="hide">
      <div class="code">
        <div class="codel">🔑 Pairing Code — Session <span id="codeSid">1</span></div>
        <div class="codev" id="codeVal">--------</div>
      </div>
      <div class="steps"><b>Steps:</b><br/>1. WhatsApp kholo us number me<br/>2. Settings → <b>Linked Devices</b><br/>3. <b>Link a Device</b> → <b>Link with phone number</b><br/>4. Code daalo (2 min me)</div>
    </div>
  </div>

  <div class="card">
    <h2>Your Numbers</h2>
    <div id="sessList"><div class="empty">No sessions yet. Add a number above.</div></div>
  </div>

  <div class="card">
    <h2>Stats</h2>
    <div class="sgrid">
      <div class="stat"><div class="k">Sessions</div><div class="v" id="stSess">0</div></div>
      <div class="stat"><div class="k">Paired</div><div class="v" id="stPaired">0</div></div>
      <div class="stat"><div class="k">Uptime</div><div class="v" id="stUp" style="font-size:14px">00:00:00</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Your Log</h2>
    <div class="log" id="logBox"><div class="line"><span class="t">[boot]</span>Ready</div></div>
    <div class="btnrow" style="margin-top:10px"><button class="ghost" onclick="clearLog()">Clear</button></div>
  </div>

  <div class="foot">── 👑 RK RAJA 👑 ──<br/>● SERVER ONLINE</div>
</div>

<script>
var userToken = localStorage.getItem('rk_token') || '';
var curUser = localStorage.getItem('rk_user') || '';
var allSess = [];
var lastLogId = 0;
var codePoller = null;

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showMsg(el, t, x) { el.textContent = x; el.style.display = t ? 'block' : 'none'; el.className = 'msg' + (t ? ' ' + t : ''); }
function clearLog() { document.getElementById('logBox').innerHTML = ''; }
function authHeaders(extra) { var h = Object.assign({}, extra || {}); h['X-User-Token'] = userToken; return h; }

function showSignup() { document.getElementById('loginBox').classList.add('hide'); document.getElementById('signupBox').classList.remove('hide'); }
function showLogin() { document.getElementById('signupBox').classList.add('hide'); document.getElementById('loginBox').classList.remove('hide'); }

async function doLogin() {
  var u = document.getElementById('loginUser').value.trim();
  var p = document.getElementById('loginPass').value;
  var m = document.getElementById('lockMsg');
  if (!u || !p) { showMsg(m, 'err', 'Both fields required'); return; }
  try {
    var r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    userToken = d.token; curUser = d.username;
    localStorage.setItem('rk_token', userToken);
    localStorage.setItem('rk_user', curUser);
    showApp();
  } catch (e) { showMsg(m, 'err', e.message); }
}

async function doSignup() {
  var u = document.getElementById('signupUser').value.trim();
  var p = document.getElementById('signupPass').value;
  var p2 = document.getElementById('signupPass2').value;
  var m = document.getElementById('lockMsg');
  if (!u || u.length < 3) { showMsg(m, 'err', 'Username min 3 chars'); return; }
  if (!p || p.length < 4) { showMsg(m, 'err', 'Password min 4 chars'); return; }
  if (p !== p2) { showMsg(m, 'err', 'Passwords match nahi karte'); return; }
  try {
    var r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    userToken = d.token; curUser = d.username;
    localStorage.setItem('rk_token', userToken);
    localStorage.setItem('rk_user', curUser);
    showApp();
  } catch (e) { showMsg(m, 'err', e.message); }
}

function doLogout() {
  localStorage.removeItem('rk_token');
  localStorage.removeItem('rk_user');
  location.reload();
}

async function checkAuth() {
  if (!userToken) return;
  try {
    var r = await fetch('/api/me', { headers: authHeaders() });
    var d = await r.json();
    if (d.success) { curUser = d.username; showApp(); }
    else { localStorage.removeItem('rk_token'); localStorage.removeItem('rk_user'); }
  } catch (_) {}
}

function showApp() {
  document.getElementById('lockScreen').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.getElementById('topUser').textContent = curUser;
  refresh(); pollStats();
}

async function startPair() {
  var phone = document.getElementById('phone').value.trim();
  var sid = document.getElementById('sid').value.trim() || '1';
  var btn = document.getElementById('pairBtn');
  var msg = document.getElementById('pairMsg');
  if (!phone || !/^\d{10,15}$/.test(phone)) { showMsg(msg, 'err', 'Valid number daalo'); return; }
  btn.disabled = true; btn.textContent = 'Sending...'; showMsg(msg, '', '');

  document.getElementById('codeSec').classList.remove('hide');
  document.getElementById('codeSid').textContent = sid;
  document.getElementById('codeVal').textContent = 'Wait...';

  try {
    var r = await fetch('/api/pair', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ phone: phone, sessionId: sid }) });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    showMsg(msg, 'ok', '⏳ Code generate ho raha...');

    if (codePoller) clearInterval(codePoller);
    var tries = 0;
    codePoller = setInterval(async function() {
      tries++;
      if (tries > 30) { clearInterval(codePoller); codePoller = null; document.getElementById('codeVal').textContent = 'TIMEOUT'; return; }
      try {
        var rr = await fetch('/api/sessions', { headers: authHeaders() });
        var dd = await rr.json();
        var s = (dd.sessions || []).find(x => x.id === sid);
        if (s && s.code) {
          document.getElementById('codeVal').textContent = s.code;
          showMsg(msg, 'ok', '✅ Code ready — WhatsApp me daalo!');
          clearInterval(codePoller); codePoller = null;
        } else if (s && s.paired) {
          document.getElementById('codeVal').textContent = 'PAIRED';
          showMsg(msg, 'ok', '✅ Paired!');
          clearInterval(codePoller); codePoller = null;
          setTimeout(refresh, 800);
        } else if (s && s.error) {
          document.getElementById('codeVal').textContent = 'ERROR';
          showMsg(msg, 'err', s.error);
          clearInterval(codePoller); codePoller = null;
        }
      } catch (_) {}
    }, 1000);
  } catch (e) { showMsg(msg, 'err', e.message); document.getElementById('codeVal').textContent = 'ERR'; }
  finally { btn.disabled = false; btn.textContent = 'Get Pairing Code'; }
}

async function refresh() {
  if (!userToken) return;
  try {
    var r = await fetch('/api/sessions', { headers: authHeaders() });
    var d = await r.json();
    if (!d.success) return;
    allSess = d.sessions || [];
    renderSess();
    document.getElementById('stSess').textContent = allSess.length;
    document.getElementById('stPaired').textContent = allSess.filter(s => s.paired).length;
  } catch (_) {}
}

function renderSess() {
  var el = document.getElementById('sessList');
  if (!allSess.length) { el.innerHTML = '<div class="empty">No sessions yet. Add a number above.</div>'; return; }
  el.innerHTML = allSess.map(s => {
    var cls = 'session';
    if (s.paired && !s.suspended) cls += ' active';
    if (s.suspended) cls += ' susp';
    var badge = s.suspended ? '🚫 SUSPENDED' : (s.paired ? '✅ Paired' : (s.connecting ? '⏳ Connecting' : (s.code ? '🔑 Code: ' + esc(s.code) : (s.registered ? '⚠ Registered' : '❌ Idle'))));
    var g = s.paired ? (s.groupCount + ' groups') : '';
    var bulkHtml = '';
    if (s.bulkRunning && s.bulkStartedAt) {
      var bs = Math.floor((Date.now() - s.bulkStartedAt) / 1000);
      var bt = String(Math.floor(bs/3600)).padStart(2,'0') + ':' + String(Math.floor((bs%3600)/60)).padStart(2,'0') + ':' + String(bs%60).padStart(2,'0');
      bulkHtml = '<div style="padding:8px 10px;background:rgba(0,255,65,.1);border:1px solid rgba(0,255,65,.4);border-radius:6px;font-size:11px;margin-top:8px"><div style="color:#00ff41;font-weight:700">🔄 Running — ' + bt + '</div><div style="color:#009922">📤 ' + s.bulkSent + ' | ❌ ' + s.bulkFailed + ' | 🔁 ' + s.bulkCycle + '</div></div>';
    }
    return '<div class="' + cls + '"><div class="shead"><div><div class="sname">Session ' + esc(s.id) + '</div><div class="sstatus">' + badge + (g ? ' | ' + g : '') + '</div></div><div class="sactions">' +
      (s.paired || s.registered ? '<button class="ghost" onclick="doLogoutSess(\'' + esc(s.id) + '\')">Logout</button>' : '') +
      (s.bulkRunning ? '<button class="danger" onclick="stopSess(\'' + esc(s.id) + '\')">Stop</button>' : '') +
    '</div></div>' + bulkHtml + '</div>';
  }).join('');
}

async function doLogoutSess(sid) {
  if (!confirm('Logout Session ' + sid + '?')) return;
  try {
    var r = await fetch('/api/logout', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sessionId: sid }) });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    refresh();
  } catch (e) { alert(e.message); }
}

async function stopSess(sid) {
  try {
    var r = await fetch('/api/bulk/stop', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sessionId: sid }) });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    if (d.summary) alert('🛑 Stopped!\nRun: ' + d.summary.runFormatted + '\nSent: ' + d.summary.sent + '\nFailed: ' + d.summary.failed);
    setTimeout(refresh, 1000);
  } catch (e) { alert(e.message); }
}

async function pollStats() {
  if (!userToken) return;
  try {
    var r = await fetch('/api/status', { headers: authHeaders() });
    var d = await r.json();
    if (!d.success) return;
    document.getElementById('stUp').textContent = d.uptimeFormatted || '00:00:00';
    if (d.logs && d.logs.length) {
      var box = document.getElementById('logBox');
      d.logs.forEach(l => {
        if (l.id > lastLogId) {
          var div = document.createElement('div');
          div.className = 'line ' + (l.type || 'info');
          div.innerHTML = '<span class="t">[' + new Date(l.ts).toLocaleTimeString() + ']</span>' + esc(l.msg);
          box.appendChild(div);
        }
      });
      lastLogId = d.logs[d.logs.length - 1].id;
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 500) box.removeChild(box.firstChild);
    }
  } catch (_) {}
}

setInterval(function(){ if (userToken) refresh(); }, 3000);
setInterval(function(){ if (userToken) pollStats(); }, 1500);
checkAuth();
</script>
</body>
</html>`;

// ===== EXPRESS =====
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(HTML));
const upload = multer({ dest: 'uploads/' });

function auth(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.token || (req.body && req.body.token);
  if (!token) return res.status(401).json({ success: false, error: 'Not logged in' });
  const u = users.get(token);
  if (!u) return res.status(401).json({ success: false, error: 'Invalid session' });
  req.user = u;
  next();
}

app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ success: false, error: 'Username min 3 chars' });
    if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password min 4 chars' });
    const un = String(username).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!un) return res.status(400).json({ success: false, error: 'Invalid username' });
    for (const u of users.values()) if (u.username.toLowerCase() === un) return res.status(400).json({ success: false, error: 'Username taken' });
    const uid = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const u = { userId: uid, username: un, password: String(password), createdAt: Date.now(), sessions: new Map(), logs: { list: [], id: 0 } };
    users.set(uid, u);
    saveUser(u);
    log('ok', `New user: ${un}`);
    await notify(`🆕 *New User Signup*\n\n👤 Username: \`${un}\`\n🆔 ID: \`${uid}\`\n🕐 ${new Date().toLocaleString()}`);
    res.json({ success: true, token: uid, username: un });
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
    await notify(`🔐 *User Login*\n\n👤 \`${found.username}\``);
    res.json({ success: true, token: found.userId, username: found.username });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json({ success: true, username: req.user.username, userId: req.user.userId }));

app.get('/api/sessions', auth, (req, res) => res.json({ success: true, sessions: sessInfo(req.user) }));

app.post('/api/pair', auth, async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    const sid = String(sessionId || '1').trim();
    const user = req.user;
    if (!sid) return res.status(400).json({ success: false, error: 'Session ID required' });
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone' });

    let s = getSess(user, sid);
    if (!s) { s = newSess(user, sid); user.sessions.set(sid, s); }
    if (s.isPaired) return res.status(400).json({ success: false, error: `Session ${sid} already paired. Logout first.` });
    if (s.isConnecting) return res.status(400).json({ success: false, error: `Session ${sid} is connecting. Wait.` });

    const cf = path.join(s.authDir, 'creds.json');
    if (fs.existsSync(cf)) {
      try {
        const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
        if (c?.me?.id) return res.status(400).json({ success: false, error: `Session ${sid} already registered. Logout first.` });
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
    await notify(`🔓 *Logout* — User: ${user.username}, S${sid}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bulk/stop', auth, (req, res) => {
  const sid = String((req.body || {}).sessionId || '1');
  const user = req.user;
  const s = getSess(user, sid);
  if (!s?.bulk?.running) return res.status(400).json({ success: false, error: 'No task' });
  const b = s.bulk;
  const runMs = b.startedAt ? (Date.now() - b.startedAt) : 0;
  const summary = { sessionId: sid, runFormatted: fmt(runMs), sent: b.sent || 0, failed: b.failed || 0, cycles: b.cycle || 0 };
  b.stopFlag = true;
  uLog(user, 'warn', `[S${sid}] Stopped`);
  notify(`🛑 *Stopped* — User: ${user.username}, S${sid}\nRun: ${summary.runFormatted}, Sent: ${summary.sent}`);
  res.json({ success: true, summary });
});

app.get('/api/status', auth, (req, res) => {
  const user = req.user;
  res.json({ success: true, uptimeFormatted: fmt(Date.now() - START), logs: user.logs.list.slice(-200) });
});

app.get('/health', (req, res) => res.json({ status: 'ok', users: users.size }));

// ===== TELEGRAM (Owner only) =====
async function initTG() {
  if (!TG_TOKEN || !TG_CHAT) { console.log('⚠ TG not set'); return; }
  try {
    const TB = require('node-telegram-bot-api');
    tgBot = new TB(TG_TOKEN, { polling: true });
    console.log('🤖 TG bot started');

    tgBot.on('message', async (msg) => {
      if (String(msg.chat.id) !== String(TG_CHAT)) return;
      const t = (msg.text || '').trim();
      if (t === '/start' || t === '/help') {
        tgBot.sendMessage(msg.chat.id, '*RK RAJA XWD Admin*\n\n/users — All users\n/status — Server status\n/stats — Sessions count\n/stopall <sid> — Stop a session', { parse_mode: 'Markdown' });
      } else if (t === '/users') {
        let s = '*👥 All Users:*\n\n';
        if (!users.size) s += 'No users yet';
        users.forEach(u => {
          const paired = [...u.sessions.values()].filter(x => x.isPaired).length;
          const running = [...u.sessions.values()].filter(x => x.bulk?.running).length;
          s += `• \`${u.username}\` — ${paired}p / ${running}r\n`;
        });
        tgBot.sendMessage(msg.chat.id, s, { parse_mode: 'Markdown' });
      } else if (t === '/status') {
        let paired = 0, running = 0;
        users.forEach(u => { u.sessions.forEach(s => { if (s.isPaired) paired++; if (s.bulk?.running) running++; }); });
        tgBot.sendMessage(msg.chat.id, `*Server Status*\n\n👥 Users: ${users.size}\n📱 Paired: ${paired}\n🔄 Running: ${running}\n⏱ Uptime: ${fmt(Date.now() - START)}`, { parse_mode: 'Markdown' });
      } else if (t === '/stats') {
        let ss = '*All Sessions:*\n\n';
        users.forEach(u => { u.sessions.forEach(s => { if (s.isPaired) ss += `• ${u.username} S${s.id} — ${s.phone || '?'}\n`; }); });
        tgBot.sendMessage(msg.chat.id, ss || 'No sessions', { parse_mode: 'Markdown' });
      }
    });
  } catch (e) { console.log('TG error:', e.message); }
}

// ===== START =====
loadUsers();
app.listen(PORT, HOST, async () => {
  console.log('\n🟢 RK RAJA XWD — Port ' + PORT + ' | Users: ' + users.size + '\n');
  await initTG();
  await autoLoad();
});

process.on('SIGTERM', () => { try { users.forEach(u => u.sessions.forEach(s => { s.intentionalClose = true; s.sock?.end(undefined); })); } catch(_){} process.exit(0); });
process.on('SIGINT', () => { try { users.forEach(u => u.sessions.forEach(s => { s.intentionalClose = true; s.sock?.end(undefined); })); } catch(_){} process.exit(0); });
