const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

process.on('uncaughtException', (err) => console.error('⚠', err.message));
process.on('unhandledRejection', (err) => console.error('⚠', err && err.message ? err.message : err));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || '';
let tgBot = null;

const PORT = process.env.PORT || 26014;
const HOST = '0.0.0.0';
const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

let serverStartTime = Date.now();
const DATA_DIR = path.join(__dirname, 'users_data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let ownerPassword = process.env.SERVER_PASSWORD || 'Rkraja00';

// ===== USERS =====
const users = new Map();

function userDir(userId) {
  const d = path.join(DATA_DIR, userId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadUsers() {
  try {
    const dirs = fs.readdirSync(DATA_DIR).filter(d => fs.statSync(path.join(DATA_DIR, d)).isDirectory());
    for (const uid of dirs) {
      const metaFile = path.join(DATA_DIR, uid, 'user.json');
      if (!fs.existsSync(metaFile)) continue;
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const u = {
        userId: uid,
        username: meta.username || uid,
        password: meta.password || '',
        createdAt: meta.createdAt || Date.now(),
        sessions: new Map(),
        logs: { list: [], id: 0 },
      };
      users.set(uid, u);
      console.log(`👤 Loaded user: ${u.username} (${uid})`);
    }
  } catch (e) { console.error('loadUsers error:', e.message); }
}

function saveUser(user) {
  try {
    fs.writeFileSync(path.join(userDir(user.userId), 'user.json'), JSON.stringify({
      username: user.username, password: user.password, createdAt: user.createdAt,
    }));
  } catch (e) { console.error('saveUser error:', e.message); }
}

function pushLog(user, type, msg) {
  if (!user) return;
  user.logs.list.push({ id: ++user.logs.id, ts: Date.now(), type, msg });
  if (user.logs.list.length > 300) user.logs.list.splice(0, user.logs.list.length - 300);
  const icons = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  console.log(`[${user.username}] ${icons[type] || '•'} ${msg}`);
}

function createSessionState(user, sid) {
  return {
    userId: user.userId, id: String(sid), sock: null, isPaired: false, phone: null,
    pairingCode: null, isConnecting: false, pairingRequested: false, connectedAt: null,
    lastError: null, authDir: path.join(userDir(user.userId), `auth_info_baileys_${sid}`),
    groupsCache: {}, bulk: null, sessionStartedAt: Date.now(), suspended: false,
  };
}

function getSession(user, sid) {
  if (!user) return null;
  if (sid === undefined || sid === null) sid = '1';
  return user.sessions.get(String(sid));
}

function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function getSessionsInfo(user) {
  const out = [];
  user.sessions.forEach((s) => {
    out.push({
      id: s.id, phone: s.phone, phoneMasked: maskPhone(s.phone),
      paired: s.isPaired, connecting: s.isConnecting, code: s.isPaired ? null : s.pairingCode,
      connectedAt: s.connectedAt, error: s.lastError, suspended: s.suspended,
      groupCount: Object.keys(s.groupsCache).length,
      bulkRunning: s.bulk ? s.bulk.running : false,
      bulkStartedAt: s.bulk && s.bulk.running ? s.bulk.startedAt : null,
      bulkSent: s.bulk ? s.bulk.sent : 0, bulkFailed: s.bulk ? s.bulk.failed : 0,
      bulkCycle: s.bulk ? s.bulk.cycle : 0,
    });
  });
  return out.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isSocketReady(sess) { return !!(sess && sess.sock && sess.isPaired && !sess.suspended); }

function parseMessagesFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const seen = new Set(); const out = [];
  content.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || seen.has(t)) return;
    seen.add(t); out.push(t);
  });
  return out;
}

function normalizeJid(tok) {
  const t = tok.trim();
  if (!t) return null;
  if (/@g\.us$/i.test(t)) return t;
  if (/@s\.whatsapp\.net$/i.test(t) || /@c\.us$/i.test(t)) return t;
  const digits = t.replace(/[^\d]/g, '');
  if (!digits || digits.length < 8 || digits.length > 15) return null;
  return digits + '@s.whatsapp.net';
}

function parseNumbers(raw) {
  if (!raw) return [];
  const out = []; const seen = new Set();
  String(raw).split(/[\r\n,;\s]+/).forEach((tok) => {
    const jid = normalizeJid(tok);
    if (!jid || seen.has(jid)) return;
    seen.add(jid);
    out.push({ jid, label: jid.endsWith('@g.us') ? '[G] ' + jid : '[N] +' + jid.split('@')[0] });
  });
  return out;
}

async function safeSend(sess, jid, text) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SEND_RETRY; attempt++) {
    try {
      if (!isSocketReady(sess)) throw new Error('socket not ready');
      await sess.sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (attempt < SEND_RETRY) await sleep(RETRY_WAIT_MS);
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown' };
}

function isForbiddenError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('forbidden') || s.includes('not-authorized') || s.includes('401');
}

// ===== WORKER — NONSTOP =====
async function runWorker(user, sess) {
  const b = sess.bulk;
  if (!b || b.workerAlive) return;
  b.workerAlive = true;
  pushLog(user, 'info', `[S${sess.id}] Worker started — NONSTOP mode`);

  try {
    while (!b.stopFlag) {
      // Suspended check
      if (sess.suspended) {
        pushLog(user, 'warn', `[S${sess.id}] ⚠ Number suspended — worker paused`);
        break;
      }
      if (!isSocketReady(sess)) { b.lastBeat = Date.now(); await sleep(3000); continue; }

      for (let mi = 0; mi < b.messages.length && !b.stopFlag; mi++) {
        const msg = b.messages[mi];
        b.msgIndex = mi; b.currentMessage = msg;
        for (let ti = 0; ti < b.targets.length && !b.stopFlag; ti++) {
          const t = b.targets[ti];
          if (t._forbiddenUntil && Date.now() < t._forbiddenUntil) continue;
          if (sess.suspended) break;

          b.targetIndex = ti; b.currentTarget = t.label; b.lastBeat = Date.now();
          if (!isSocketReady(sess)) break;

          try {
            const res = await safeSend(sess, t.jid, msg);
            if (res.ok) {
              b.sent++;
              t._failCount = 0;
              pushLog(user, 'ok', `[S${sess.id}] C${b.cycle+1} | Msg ${mi+1}/${b.messages.length} → ${t.label}`);
            } else {
              b.failed++;
              pushLog(user, 'err', `[S${sess.id}] Msg ${mi+1} → ${t.label}: ${res.error}`);
              // Suspended detection
              const errLower = String(res.error).toLowerCase();
              if (errLower.includes('banned') || errLower.includes('suspended') || errLower.includes('account has been')) {
                sess.suspended = true;
                pushLog(user, 'err', `[S${sess.id}] 🚫 Number SUSPENDED — worker stopping`);
                break;
              }
              if (isForbiddenError(res.error)) {
                t._forbiddenUntil = Date.now() + 3600000;
                pushLog(user, 'warn', `[S${sess.id}] "${t.label}" skip 1h`);
              }
            }
          } catch (e) {
            b.failed++;
            pushLog(user, 'err', `[S${sess.id}] ${t.label}: ${e.message}`);
          }
          b.remaining = b.messages.length - (mi + 1);
          if (!b.stopFlag && !sess.suspended) await sleep(b.delayMs);
        }
        if (!isSocketReady(sess) && !b.stopFlag) break;
        if (sess.suspended) break;
      }
      if (!b.stopFlag && !sess.suspended) {
        b.cycle++; b.remaining = b.messages.length; b.msgIndex = 0; b.targetIndex = 0;
        pushLog(user, 'info', `[S${sess.id}] Cycle ${b.cycle} completed — restarting`);
      }
    }
  } catch (loopErr) {
    pushLog(user, 'err', `[S${sess.id}] Worker crashed: ${loopErr.message}`);
    if (!b.stopFlag && !sess.suspended) {
      b.workerAlive = false; b.running = true;
      setTimeout(() => runWorker(user, sess), 3000);
      return;
    }
  } finally {
    if (b.stopFlag) {
      b.running = false; b.stopFlag = false; b.workerAlive = false;
      b.currentMessage = ''; b.currentTarget = '';
      pushLog(user, 'info', `[S${sess.id}] Stopped — Sent: ${b.sent}, Failed: ${b.failed}, Cycles: ${b.cycle}`);
    } else {
      b.workerAlive = false;
      if (sess.suspended) b.running = false;
    }
  }
}

setInterval(() => {
  users.forEach(user => {
    user.sessions.forEach(sess => {
      const b = sess.bulk;
      if (b && b.running && !b.workerAlive && !sess.suspended) {
        pushLog(user, 'warn', `[S${sess.id}] Watchdog restart`);
        runWorker(user, sess);
      }
    });
  });
}, WATCHDOG_INTERVAL_MS);

async function connectSession(user, sid, phone) {
  let sess = getSession(user, sid);
  if (!sess) { sess = createSessionState(user, sid); user.sessions.set(String(sid), sess); }
  if (sess.isConnecting) throw new Error('Already connecting');
  if (sess.isPaired) throw new Error('Already paired');
  sess.isConnecting = true;
  if (phone) sess.phone = phone;
  sess.pairingCode = null; sess.lastError = null; sess.suspended = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sess.authDir);
    const { version } = await fetchLatestBaileysVersion();
    sess.sock = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      mobile: false, syncFullHistory: false,
    });
    sess.sock.ev.on('creds.update', saveCreds);
    sess.sock.ev.on('groups.upsert', (groups) => {
      groups.forEach((g) => { sess.groupsCache[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }; });
    });
    sess.sock.ev.on('groups.update', (updates) => {
      updates.forEach((u) => {
        if (sess.groupsCache[u.id]) { if (u.subject) sess.groupsCache[u.id].name = u.subject; }
        else if (u.id) sess.groupsCache[u.id] = { id: u.id, name: u.subject || '', size: 0 };
      });
    });
    sess.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting' && !sess.sock.authState.creds.registered && !sess.pairingRequested && phone) {
        sess.pairingRequested = true;
        try {
          await sleep(1000);
          sess.pairingCode = await sess.sock.requestPairingCode(phone);
          pushLog(user, 'info', `[S${sess.id}] Pairing code: ${sess.pairingCode}`);
          sess.lastError = null;
        } catch (err) {
          sess.lastError = err.message; sess.pairingCode = null;
          sess.pairingRequested = false; sess.isConnecting = false;
        }
      }
      if (connection === 'open') {
        sess.isPaired = true; sess.pairingCode = null;
        sess.pairingRequested = false; sess.isConnecting = false;
        sess.connectedAt = new Date().toISOString(); sess.lastError = null;
        pushLog(user, 'ok', `[S${sess.id}] Connected (${sess.phone || 'unknown'})`);
        setTimeout(() => {
          try {
            if (sess.sock && sess.sock.store && sess.sock.store.groupMetadata) {
              sess.sock.store.groupMetadata.forEach((v) => {
                sess.groupsCache[v.id] = { id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 };
              });
              pushLog(user, 'info', `[S${sess.id}] Loaded ${Object.keys(sess.groupsCache).length} groups`);
            }
          } catch (_) {}
        }, 3000);
        if (sess.bulk && sess.bulk.running && !sess.bulk.workerAlive) runWorker(user, sess);
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        // Suspended detection
        if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
          sess.suspended = true;
          pushLog(user, 'err', `[S${sess.id}] 🚫 SUSPENDED (code ${statusCode}) — auto-reconnect disabled`);
          if (sess.bulk && sess.bulk.running) sess.bulk.stopFlag = true;
          sess.isPaired = false; sess.isConnecting = false;
          return;
        }
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        pushLog(user, 'warn', `[S${sess.id}] Closed (${statusCode})`);
        sess.isPaired = false; sess.isConnecting = false;
        if (shouldReconnect && sess.phone && !sess.suspended) {
          sess.pairingRequested = false;
          setTimeout(() => connectSession(user, sess.id, sess.phone).catch(()=>{}), 3000);
        }
      }
    });
  } catch (err) {
    sess.isConnecting = false; sess.lastError = err.message; throw err;
  }
}

async function autoLoadUserSessions(user) {
  try {
    const udir = userDir(user.userId);
    const dirs = fs.readdirSync(udir).filter(d => d.startsWith('auth_info_baileys_'));
    for (const dir of dirs) {
      const sid = dir.replace('auth_info_baileys_', '');
      const credsFile = path.join(udir, dir, 'creds.json');
      if (!fs.existsSync(credsFile)) continue;
      let creds = {};
      try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (_) {}
      const phone = creds.me && creds.me.id ? creds.me.id.split(':')[0].split('@')[0] : null;
      let sess = getSession(user, sid);
      if (!sess) { sess = createSessionState(user, sid); user.sessions.set(sid, sess); }
      sess.phone = phone;
      pushLog(user, 'info', `🔄 Auto-loading S${sid}${phone ? ' (' + phone + ')' : ''}...`);
      connectSession(user, sid, phone).catch(() => {});
      await sleep(1200);
    }
  } catch (e) { console.error('autoLoad error:', e.message); }
}

async function autoLoadAll() {
  for (const user of users.values()) await autoLoadUserSessions(user);
}

// ============================================================
// HTML — HACKER THEME
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>RK RAJA XWD — WhatsApp Server</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:'Share Tech Mono','Courier New',monospace;background:#000;color:#00ff41;min-height:100vh;overflow-x:hidden;position:relative}
  body::before{content:"";position:fixed;inset:0;z-index:-3;background-image:url('__LOGO_DATA__');background-size:cover;background-position:center top;background-repeat:no-repeat;filter:blur(2px) brightness(0.45) hue-rotate(90deg) saturate(1.6);opacity:0.6}
  body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(circle at 50% 40%, rgba(0,255,65,.08) 0%, transparent 60%),linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.9) 100%);pointer-events:none}
  .matrix{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;opacity:.15}
  .matrix span{position:absolute;color:#00ff41;font-family:monospace;font-size:14px;top:-20px;animation:fall linear infinite;text-shadow:0 0 8px #00ff41}
  @keyframes fall{to{transform:translateY(110vh)}}
  .container{max-width:1180px;margin:0 auto;padding:20px 16px 60px;position:relative;z-index:1}
  .brand{text-align:center;margin-bottom:22px}
  .hero-image{position:relative;display:flex;justify-content:center;margin-bottom:18px}
  .hero-img{max-width:180px;width:45vw;border-radius:12px;filter:drop-shadow(0 0 30px #00ff41) brightness(1.15);position:relative;z-index:2}
  .hero-glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:280px;height:280px;background:radial-gradient(circle, rgba(0,255,65,.4) 0%, transparent 70%);z-index:1;pointer-events:none;animation:pulseGlow 3s ease-in-out infinite}
  @keyframes pulseGlow{0%,100%{opacity:.7}50%{opacity:1}}
  .brand h1{font-family:'Share Tech Mono',monospace;font-size:clamp(24px,5vw,42px);font-weight:900;letter-spacing:4px;color:#00ff41;text-shadow:0 0 15px #00ff41,0 0 30px rgba(0,255,65,.6);text-transform:uppercase;text-align:center;margin-bottom:6px}
  .brand h1 .x{color:#fff;text-shadow:0 0 15px #fff}
  .brand p{color:#009922;font-size:11px;letter-spacing:4px;margin-top:4px;text-transform:uppercase}
  .terminal-header{background:rgba(0,0,0,.92);border:1px solid rgba(0,255,65,.5);border-radius:8px;overflow:hidden;margin-bottom:22px;box-shadow:0 0 30px rgba(0,255,65,.3),inset 0 0 20px rgba(0,255,65,.05)}
  .terminal-bar{background:linear-gradient(180deg,#0a2a0a,#001500);padding:8px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(0,255,65,.3)}
  .dot{width:12px;height:12px;border-radius:50%;display:inline-block}
  .dot-r{background:#ff5f56}.dot-y{background:#ffbd2e}.dot-g{background:#27c93f}
  .terminal-title{margin-left:8px;color:#00ff41;font-size:11px;letter-spacing:1.5px;font-family:'Share Tech Mono',monospace}
  .terminal-body{padding:14px 16px;font-size:12.5px;line-height:1.9;color:#00ff41;font-family:'Share Tech Mono',monospace}
  .terminal-body .prompt{color:#00ff41;font-weight:700}
  .terminal-body .cmd{color:#fff}
  .terminal-body .ok{color:#00ff41;text-shadow:0 0 8px #00ff41}
  .cursor{background:#00ff41;display:inline-block;width:9px;height:14px;vertical-align:middle;animation:blink 1s infinite}
  @keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}
  .tabs{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;justify-content:center}
  .tab{padding:11px 20px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(0,255,65,.5);background:transparent;color:#00ff41;transition:.2s;font-family:'Share Tech Mono',monospace}
  .tab.active{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000;border-color:#00ff41;box-shadow:0 0 25px rgba(0,255,65,.7)}
  .tab:hover:not(.active){background:rgba(0,255,65,.1)}
  .panel{display:none}.panel.active{display:block}
  .layout{display:grid;grid-template-columns:420px 1fr;gap:18px}
  @media(max-width:900px){.layout{grid-template-columns:1fr}}
  .card{background:rgba(0,15,0,.78);border:1px solid rgba(0,255,65,.35);border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 0 20px rgba(0,255,65,.12),inset 0 0 20px rgba(0,255,65,.03);backdrop-filter:blur(6px)}
  .card h2{font-size:13px;margin-bottom:16px;color:#00ff41;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase;text-shadow:0 0 10px rgba(0,255,65,.7);font-family:'Share Tech Mono',monospace}
  .card h2 .dot2{width:8px;height:8px;border-radius:50%;background:#00ff41;box-shadow:0 0 12px #00ff41;animation:blink 1.5s infinite}
  label{display:block;font-size:11px;color:#009922;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:rgba(0,20,5,.85);border:1px solid rgba(0,255,65,.4);border-radius:6px;padding:11px 14px;color:#00ff41;font-size:14px;font-family:'Share Tech Mono',monospace;outline:none;transition:.2s}
  input:focus,textarea:focus,select:focus{border-color:#00ff41;box-shadow:0 0 15px rgba(0,255,65,.4)}
  input::placeholder,textarea::placeholder{color:#005518}
  textarea{resize:vertical;min-height:80px}
  .field{margin-bottom:14px}
  button{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000;border:none;border-radius:6px;padding:12px 22px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:.22s;margin-top:6px;width:100%;box-shadow:0 0 20px rgba(0,255,65,.4);font-family:'Share Tech Mono',monospace}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 0 30px rgba(0,255,65,.8)}
  button:disabled{background:#0a1a0a;color:#005518;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid rgba(0,255,65,.5);color:#00ff41;box-shadow:none}
  button.ghost:hover:not(:disabled){background:rgba(0,255,65,.1)}
  button.danger{background:linear-gradient(180deg,#ff003c,#aa0022);color:#fff;border:1px solid #ff003c;box-shadow:0 0 20px rgba(255,0,60,.5)}
  .btnrow{display:flex;gap:10px}.btnrow button{margin-top:0}
  .msg{margin-top:12px;padding:10px 14px;border-radius:6px;font-size:12px;display:none;letter-spacing:.5px}
  .msg.ok{background:rgba(0,255,65,.12);color:#00ff41;border:1px solid rgba(0,255,65,.5);display:block}
  .msg.err{background:rgba(255,0,60,.12);color:#ff5f7f;border:1px solid rgba(255,0,60,.5);display:block}
  .code-box{background:rgba(0,20,5,.9);border:2px dashed #00ff41;border-radius:8px;padding:20px;margin:14px 0;text-align:center;box-shadow:inset 0 0 30px rgba(0,255,65,.15)}
  .code-value{font-size:32px;font-weight:900;letter-spacing:8px;color:#00ff41;font-family:'Share Tech Mono',monospace;text-shadow:0 0 20px #00ff41}
  .code-label{font-size:11px;color:#009922;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase}
  .steps{background:rgba(0,15,0,.6);border:1px solid rgba(0,255,65,.25);border-radius:6px;padding:14px;font-size:12px;line-height:1.8;color:#009922}
  .steps b{color:#00ff41}
  .stat{background:rgba(0,15,0,.75);border:1px solid rgba(0,255,65,.25);border-radius:8px;padding:14px;text-align:center}
  .stat .k{font-size:10px;color:#009922;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .stat .v{font-size:20px;font-weight:900;color:#00ff41;word-break:break-all;text-shadow:0 0 12px rgba(0,255,65,.6)}
  .stat .v.red{color:#ff003c;text-shadow:0 0 12px rgba(255,0,60,.6)}
  .stat .v.green{color:#00ff41}
  .stat .v.small{font-size:14px;font-weight:700}
  .statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
  @media(max-width:520px){.statgrid{grid-template-columns:1fr 1fr}}
  .log{background:#000;border:1px solid rgba(0,255,65,.3);border-radius:8px;padding:14px;height:340px;overflow-y:auto;font-family:'Share Tech Mono',monospace;font-size:12px;line-height:1.75}
  .log::-webkit-scrollbar{width:8px}.log::-webkit-scrollbar-track{background:#001500}.log::-webkit-scrollbar-thumb{background:#00ff41;border-radius:8px}
  .log .line{color:#009922;border-bottom:1px dashed rgba(0,255,65,.08);padding:2px 0;word-break:break-all}
  .log .t{color:#00ff41;margin-right:8px}
  .log .ok{color:#00ff41}.log .err{color:#ff5f7f}.log .info{color:#00aaff}.log .warn{color:#ffcc00}
  .groups-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .groups-toolbar button{width:auto;margin-top:0;padding:9px 14px;font-size:11px}
  .groups-toolbar .count{font-size:11px;color:#009922;margin-left:auto}
  .groups-list{background:rgba(0,15,0,.6);border:1px solid rgba(0,255,65,.25);border-radius:8px;max-height:360px;overflow-y:auto;padding:8px}
  .groups-list::-webkit-scrollbar{width:8px}.groups-list::-webkit-scrollbar-thumb{background:#00ff41;border-radius:8px}
  .group-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:6px;cursor:pointer;border:1px solid transparent}
  .group-item:hover{background:rgba(0,255,65,.08)}
  .group-item.selected{background:rgba(0,255,65,.15);border-color:#00ff41}
  .group-item input[type=checkbox]{width:18px;height:18px;accent-color:#00ff41;cursor:pointer;flex-shrink:0}
  .group-info{flex:1;min-width:0}
  .group-name{color:#00ff41;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .group-jid{color:#006622;font-size:11px;font-family:monospace;margin-top:2px}
  .hint{font-size:11px;color:#006622;margin-top:6px}
  .empty{padding:30px;text-align:center;color:#005518;font-size:13px}
  .footer{text-align:center;color:#005518;font-size:11px;letter-spacing:3px;margin-top:30px;text-transform:uppercase;line-height:1.8}
  .session-item{display:flex;flex-direction:column;gap:8px;padding:14px;background:rgba(0,15,0,.78);border:1px solid rgba(0,255,65,.3);border-radius:8px;margin-bottom:10px}
  .session-item.active{border-color:#00ff41;background:rgba(0,255,65,.08);box-shadow:0 0 15px rgba(0,255,65,.2)}
  .session-item.suspended{border-color:#ff003c;background:rgba(255,0,60,.1)}
  .session-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .session-name{color:#00ff41;font-size:14px;font-weight:700}
  .session-status{color:#009922;font-size:11px;font-family:monospace;margin-top:2px}
  .session-actions{display:flex;gap:8px}
  .session-actions button{width:auto;padding:7px 12px;font-size:10px;margin:0}
  .login-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.95);display:flex;align-items:center;justify-content:center;padding:20px}
  .login-overlay::before{content:"";position:absolute;inset:0;background:url('__LOGO_DATA__') center/cover;filter:blur(8px) brightness(0.3) hue-rotate(90deg);z-index:-1}
  .login-box{max-width:400px;width:100%;background:rgba(0,15,0,.92);border:1px solid rgba(0,255,65,.5);border-radius:12px;padding:32px;box-shadow:0 0 40px rgba(0,255,65,.4),inset 0 0 40px rgba(0,255,65,.05)}
  .login-box h2{color:#00ff41;text-align:center;font-size:22px;letter-spacing:3px;margin-bottom:6px;text-transform:uppercase;text-shadow:0 0 15px #00ff41}
  .login-box .sub{text-align:center;color:#009922;font-size:11px;letter-spacing:3px;margin-bottom:24px;text-transform:uppercase}
  .login-tab{display:flex;gap:8px;margin-bottom:20px}
  .login-tab button{flex:1;padding:10px;font-size:11px;background:transparent;border:1px solid rgba(0,255,65,.4);color:#009922;border-radius:6px;cursor:pointer;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;box-shadow:none}
  .login-tab button.active{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000;border-color:#00ff41;box-shadow:0 0 15px rgba(0,255,65,.5)}
  .topbar{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:rgba(0,15,0,.9);border:1px solid rgba(0,255,65,.35);border-radius:8px;margin-bottom:16px;font-size:12px;box-shadow:0 0 15px rgba(0,255,65,.15)}
  .topbar .user{color:#00ff41;font-weight:700;letter-spacing:1.5px}
  .topbar button{width:auto;padding:6px 14px;font-size:10px;margin:0;background:transparent;border:1px solid rgba(0,255,65,.5);color:#00ff41;box-shadow:none}
  .status-bar{display:flex;justify-content:center;gap:18px;flex-wrap:wrap;font-size:10px;color:#00ff41;letter-spacing:1.5px;margin-bottom:18px;text-transform:uppercase}
  .status-bar span{display:flex;align-items:center;gap:5px}
  .status-bar .dot-s{width:6px;height:6px;border-radius:50%;background:#00ff41;box-shadow:0 0 8px #00ff41;animation:blink 1.5s infinite}
</style>
</head>
<body>

<div class="matrix" id="matrix"></div>

<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2>RK RAJA <span style="color:#fff">XWD</span></h2>
    <div class="sub">WhatsApp Server</div>
    <div class="login-tab">
      <button id="tabLogin" class="active" onclick="switchLoginTab('login')">Login</button>
      <button id="tabSignup" onclick="switchLoginTab('signup')">Sign Up</button>
    </div>
    <div id="loginForm">
      <div class="field"><label>Username</label><input id="loginUser" type="text" placeholder="your username"/></div>
      <div class="field"><label>Password</label><input id="loginPass" type="password" placeholder="your password"/></div>
      <button onclick="doLogin()">Login</button>
    </div>
    <div id="signupForm" style="display:none">
      <div class="field"><label>Username (min 3)</label><input id="signupUser" type="text" placeholder="choose username"/></div>
      <div class="field"><label>Password (min 4)</label><input id="signupPass" type="password" placeholder="choose password"/></div>
      <button onclick="doSignup()">Create Account</button>
    </div>
    <div id="loginMsg" class="msg"></div>
  </div>
</div>

<div class="container" id="appContainer" style="display:none">
  <div class="topbar">
    <div>👤 <span class="user" id="topUser">—</span></div>
    <button onclick="doLogout()">Logout</button>
  </div>

  <div class="brand">
    <div class="hero-image">
      <div class="hero-glow"></div>
      <img src="__LOGO_DATA__" alt="RK RAJA XWD" class="hero-img" onerror="this.style.display='none'"/>
    </div>
    <h1>RK RAJA <span class="x">XWD</span></h1>
    <p>WHATSAPP SERVER</p>
  </div>

  <div class="status-bar">
    <span><span class="dot-s"></span>SECURE</span>
    <span><span class="dot-s"></span>FAST</span>
    <span><span class="dot-s"></span>STABLE</span>
    <span><span class="dot-s"></span>ONLINE</span>
    <span><span class="dot-s"></span>24/7</span>
  </div>

  <div class="terminal-header">
    <div class="terminal-bar">
      <span class="dot dot-r"></span><span class="dot dot-y"></span><span class="dot dot-g"></span>
      <span class="terminal-title">root@rk-raja — whatsapp-server</span>
    </div>
    <div class="terminal-body">
      <div><span class="prompt">root@rk-raja:~#</span> <span class="cmd">whatsapp-server</span></div>
      <div><span class="ok">[+]</span> Checking environment ... <span class="ok">OK</span></div>
      <div><span class="ok">[+]</span> Connecting to WhatsApp ... <span class="ok">OK</span></div>
      <div><span class="ok">[+]</span> Initializing session ... <span class="ok">OK</span></div>
      <div><span class="ok">[+]</span> Server is running ...</div>
      <div><span class="prompt">root@rk-raja:~#</span> <span class="cursor"></span></div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="dashboard" onclick="switchTab('dashboard')">Dashboard</div>
    <div class="tab" data-tab="sender" onclick="switchTab('sender')">Bulk Sender</div>
  </div>

  <div class="panel active" id="panel-dashboard">
    <div class="card">
      <h2><span class="dot2"></span>➕ Add WhatsApp Number</h2>
      <div class="field">
        <label>Session ID (1, 2, 3, 4...)</label>
        <input id="newSessionId" type="text" placeholder="1" value="1"/>
        <div class="hint">Har number ke liye alag session ID</div>
      </div>
      <div class="field">
        <label>Phone Number (country code, no + or spaces)</label>
        <input id="phoneInput" type="tel" placeholder="e.g. 919876543210"/>
      </div>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="pairMsg" class="msg"></div>
      <div id="codeSection" style="display:none">
        <div class="code-box">
          <div class="code-label">Pairing Code for <span id="codeSessionLabel">Session</span></div>
          <div id="codeValue" class="code-value">------</div>
        </div>
        <div class="steps"><b>Steps:</b><br/>1. WhatsApp kholo us number me<br/>2. Settings → <b>Linked Devices</b><br/>3. <b>Link a Device</b> → <b>Link with phone number</b><br/>4. 2 min me code daalo</div>
      </div>
    </div>

    <div class="card">
      <h2><span class="dot2"></span>📱 Your Paired Numbers</h2>
      <div id="sessionsList"><div class="empty">No sessions yet.</div></div>
    </div>

    <div class="card">
      <h2><span class="dot2"></span>Live Stats</h2>
      <div class="statgrid">
        <div class="stat"><div class="k">Sessions</div><div class="v green" id="statSessions">0</div></div>
        <div class="stat"><div class="k">Paired</div><div class="v green" id="statPaired">0</div></div>
        <div class="stat"><div class="k">Server Uptime</div><div class="v green" id="statUptime">00:00:00</div></div>
      </div>
    </div>

    <div class="card">
      <h2><span class="dot2"></span>Your Log</h2>
      <div class="log" id="logBox"><div class="line"><span class="t">[boot]</span> Waiting...</div></div>
      <div class="btnrow" style="margin-top:12px"><button class="ghost" onclick="clearLog()">Clear</button></div>
    </div>
  </div>

  <div class="panel" id="panel-sender">
    <div class="layout">
      <div>
        <div class="card">
          <h2><span class="dot2"></span>Message Queue & Targets</h2>
          <div class="field">
            <label>Upload Messages File (.txt)</label>
            <input id="fileInput" type="file" accept=".txt"/>
            <div class="hint" id="fileHint">No file chosen</div>
          </div>
          <div class="field">
            <label>Send to Groups</label>
            <div class="groups-toolbar" style="margin-bottom:8px">
              <button class="ghost" onclick="fetchGroupsForBulk()">Fetch</button>
              <button class="ghost" onclick="selectAllBulkGroups()">All</button>
              <button class="ghost" onclick="clearBulkGroups()">Clear</button>
              <span class="count" id="bulkGroupsCount">0 selected</span>
            </div>
            <div class="groups-list" id="bulkGroupsList" style="max-height:200px">
              <div class="empty">Fetch groups to load</div>
            </div>
          </div>
          <div class="field">
            <label>📱 Send to Phone Numbers (optional)</label>
            <textarea id="numbersInput" placeholder="919876543210&#10;918765432109"></textarea>
          </div>
          <div class="field"><label>Hater Name (prefix)</label><input id="haterInput" type="text" placeholder="e.g. RK RAJA XWD"/></div>
          <div class="field"><label>Delay (seconds)</label><input id="delayInput" type="number" min="3" value="10"/></div>
          <div class="field"><label>Last Hater (suffix)</label><input id="lastHaterInput" type="text" placeholder="e.g. XWD"/></div>
          <div class="btnrow">
            <button id="startBtn" onclick="startServer()">▶ Start Bulk</button>
            <button id="stopAllBtn" class="danger" onclick="stopAll()" disabled>■ Stop All</button>
          </div>
        </div>
      </div>
      <div>
        <div class="card">
          <h2><span class="dot2"></span>Live Stats</h2>
          <div id="multiStats" style="font-size:12px"><div class="empty">Start bulk to see stats</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    ── 👑 RK RAJA 👑 ──<br/>
    HACK THE LIMITS 👑<br/>
    CONNECT | AUTOMATE | DOMINATE<br/>
    <span style="color:#00ff41">● SERVER ONLINE</span>
  </div>
</div>

<script>
// Matrix rain
(function(){
  const m = document.getElementById('matrix');
  const chars = '01アイウエオカキクケコサシスセソタチツテトRKRAJA';
  for(let i=0;i<30;i++){
    const s = document.createElement('span');
    s.textContent = chars.split('').sort(()=>Math.random()-.5).join('').slice(0,20);
    s.style.left = Math.random()*100+'%';
    s.style.animationDuration = (5+Math.random()*10)+'s';
    s.style.animationDelay = Math.random()*5+'s';
    m.appendChild(s);
  }
})();

let currentUser = null;
let userToken = localStorage.getItem('rk_token') || '';
let allSessions=[];
let currentSessionGroups=[];
let bulkSelected=new Set();

function switchLoginTab(t){
  document.getElementById('tabLogin').classList.toggle('active', t==='login');
  document.getElementById('tabSignup').classList.toggle('active', t==='signup');
  document.getElementById('loginForm').style.display = t==='login'?'block':'none';
  document.getElementById('signupForm').style.display = t==='signup'?'block':'none';
}

async function doLogin(){
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const msg = document.getElementById('loginMsg');
  if(!u||!p){showMsg(msg,'err','Enter username + password');return;}
  try{
    const res = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d = await res.json();
    if(!d.success) throw new Error(d.error);
    userToken = d.token; currentUser = d.username;
    localStorage.setItem('rk_token', userToken);
    localStorage.setItem('rk_user', currentUser);
    showApp();
  }catch(e){showMsg(msg,'err',e.message);}
}

async function doSignup(){
  const u = document.getElementById('signupUser').value.trim();
  const p = document.getElementById('signupPass').value;
  const msg = document.getElementById('loginMsg');
  if(!u||u.length<3){showMsg(msg,'err','Username min 3 chars');return;}
  if(!p||p.length<4){showMsg(msg,'err','Password min 4 chars');return;}
  try{
    const res = await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d = await res.json();
    if(!d.success) throw new Error(d.error);
    userToken = d.token; currentUser = d.username;
    localStorage.setItem('rk_token', userToken);
    localStorage.setItem('rk_user', currentUser);
    showApp();
  }catch(e){showMsg(msg,'err',e.message);}
}

function doLogout(){
  localStorage.removeItem('rk_token');
  localStorage.removeItem('rk_user');
  location.reload();
}

async function checkAuth(){
  if(!userToken){document.getElementById('loginOverlay').style.display='flex';return;}
  try{
    const res = await fetch('/api/me',{headers:{'X-User-Token':userToken}});
    const d = await res.json();
    if(d.success){ currentUser = d.username; showApp(); }
    else { localStorage.removeItem('rk_token'); localStorage.removeItem('rk_user'); document.getElementById('loginOverlay').style.display='flex'; }
  }catch(e){ document.getElementById('loginOverlay').style.display='flex'; }
}

function showApp(){
  document.getElementById('loginOverlay').style.display='none';
  document.getElementById('appContainer').style.display='block';
  document.getElementById('topUser').textContent = currentUser;
  refreshSessions(); pollStats();
}

function authHeaders(extra){const h=Object.assign({},extra||{});h['X-User-Token']=userToken;return h;}
function switchTab(name){document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));}
function showMsg(el,type,text){el.textContent=text;el.style.display=type?'block':'none';el.className='msg'+(type?' '+type:'');}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clearLog(){document.getElementById('logBox').innerHTML='';}

async function startPair(){
  const phone=document.getElementById('phoneInput').value.trim();
  const sid=document.getElementById('newSessionId').value.trim()||'1';
  const btn=document.getElementById('pairBtn');
  const msgEl=document.getElementById('pairMsg');
  const codeSection=document.getElementById('codeSection');
  if(!phone||!/^\d{10,15}$/.test(phone)){showMsg(msgEl,'err','Enter valid number');return;}
  btn.disabled=true;btn.textContent='Starting...';showMsg(msgEl,'','');
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({phone,sessionId:sid})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error||'Failed');
    codeSection.style.display='block';
    document.getElementById('codeSessionLabel').textContent='Session '+sid;
    document.getElementById('codeValue').textContent='Generating...';
    showMsg(msgEl,'ok','Pairing started');
    setTimeout(refreshSessions, 2500);
  }catch(e){showMsg(msgEl,'err',e.message);}
  finally{btn.disabled=false;btn.textContent='Get Pairing Code';}
}

async function refreshSessions(){
  if(!userToken) return;
  try{
    const res=await fetch('/api/sessions',{headers:authHeaders()});
    const d=await res.json();
    if(!d.success) return;
    allSessions=d.sessions||[];
    renderSessions();
    document.getElementById('statSessions').textContent=allSessions.length;
    document.getElementById('statPaired').textContent=allSessions.filter(s=>s.paired).length;
  }catch(e){}
}

function renderSessions(){
  const listEl=document.getElementById('sessionsList');
  if(!allSessions.length){listEl.innerHTML='<div class="empty">No sessions yet.</div>';return;}
  listEl.innerHTML=allSessions.map(s=>{
    let cls='session-item';
    if(s.paired && !s.suspended) cls+=' active';
    if(s.suspended) cls+=' suspended';
    let statusBadge = s.suspended ? '🚫 SUSPENDED' : (s.paired ? '✅ Paired' : (s.connecting ? '⏳ Connecting' : (s.code ? '🔑 Code: '+escapeHtml(s.code) : '❌ Idle')));
    let groupsTxt = s.paired ? (s.groupCount+' groups') : '';
    let bulkHtml = '';
    if(s.bulkRunning){
      let bulkTxt = '';
      if(s.bulkStartedAt){
        const bSec = Math.floor((Date.now()-s.bulkStartedAt)/1000);
        bulkTxt = String(Math.floor(bSec/3600)).padStart(2,'0')+':'+String(Math.floor((bSec%3600)/60)).padStart(2,'0')+':'+String(bSec%60).padStart(2,'0');
      }
      bulkHtml = '<div style="padding:8px 10px;background:rgba(0,255,65,.1);border:1px solid rgba(0,255,65,.4);border-radius:6px;font-size:11px"><div style="color:#00ff41;font-weight:700">🔄 BULK — '+bulkTxt+'</div><div style="color:#009922;margin-top:2px">📤 '+s.bulkSent+' | ❌ '+s.bulkFailed+' | 🔁 '+s.bulkCycle+'</div></div>';
    }
    return '<div class="'+cls+'"><div class="session-header"><div><div class="session-name">Session '+escapeHtml(s.id)+'</div><div class="session-status">'+statusBadge+(groupsTxt?' | '+groupsTxt:'')+'</div></div><div class="session-actions">'+
      (s.paired?'<button class="ghost" onclick="doLogoutSession(\''+escapeHtml(s.id)+'\')">Logout</button>':'')+
      (s.bulkRunning?'<button class="danger" onclick="stopSession(\''+escapeHtml(s.id)+'\')">Stop</button>':'')+
    '</div></div>'+bulkHtml+'</div>';
  }).join('');
}

async function doLogoutSession(sid){
  if(!confirm('Logout Session '+sid+'?'))return;
  try{
    const res=await fetch('/api/logout',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sessionId:sid})});
    const d=await res.json(); if(!d.success)throw new Error(d.error);
    refreshSessions();
  }catch(e){alert('❌ '+e.message);}
}

async function stopSession(sid){
  try{
    const res=await fetch('/api/bulk/stop',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({sessionId:sid})});
    const d=await res.json(); if(!d.success)throw new Error(d.error);
    if(d.summary) alert('🛑 Stopped\nRun: '+d.summary.runFormatted+'\nSent: '+d.summary.sent+'\nFailed: '+d.summary.failed);
    setTimeout(refreshSessions, 1000);
  }catch(e){alert('❌ '+e.message);}
}

async function fetchGroupsForBulk(){
  const paired = allSessions.filter(s => s.paired && !s.suspended);
  if(!paired.length){alert('Pehle WhatsApp pair karo');return;}
  const sid = paired[0].id;
  const listEl=document.getElementById('bulkGroupsList');
  listEl.innerHTML='<div class="empty">Loading...</div>';
  try{
    const res=await fetch('/api/groups?sessionId='+sid,{headers:authHeaders()});
    const d=await res.json(); if(!d.success)throw new Error(d.error||'Failed');
    currentSessionGroups=d.groups||[];
    renderBulkGroups();
  }catch(e){listEl.innerHTML='<div class="empty" style="color:#ff5f7f">'+escapeHtml(e.message)+'</div>';}
}

function renderBulkGroups(){
  const listEl=document.getElementById('bulkGroupsList');
  document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';
  if(!currentSessionGroups.length){listEl.innerHTML='<div class="empty">No groups</div>';return;}
  listEl.innerHTML=currentSessionGroups.map(g=>{
    const sel=bulkSelected.has(g.id)?' selected':'';const checked=bulkSelected.has(g.id)?' checked':'';
    return '<label class="group-item'+sel+'" data-jid="'+escapeHtml(g.id)+'"><input type="checkbox"'+checked+' onchange="toggleBulkGroup(\''+escapeHtml(g.id)+'\',this.checked)"/><div class="group-info"><div class="group-name">'+escapeHtml(g.name||'(no name)')+'</div><div class="group-jid">'+escapeHtml(g.id)+'</div></div></label>';
  }).join('');
}
function toggleBulkGroup(jid,checked){if(checked)bulkSelected.add(jid);else bulkSelected.delete(jid);document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';document.querySelectorAll('#bulkGroupsList .group-item').forEach(el=>{if(el.dataset.jid===jid)el.classList.toggle('selected',checked);});}
function selectAllBulkGroups(){currentSessionGroups.forEach(g=>bulkSelected.add(g.id));renderBulkGroups();}
function clearBulkGroups(){bulkSelected.clear();renderBulkGroups();}

document.getElementById('fileInput').addEventListener('change',(e)=>{const f=e.target.files[0];document.getElementById('fileHint').textContent=f?f.name:'No file chosen';});

async function startServer(){
  const paired = allSessions.filter(s => s.paired && !s.suspended);
  if(!paired.length){alert('❌ Pehle WhatsApp pair karo');return;}
  const file=document.getElementById('fileInput').files[0];
  if(!file){alert('Message file upload karo');return;}
  const hasGroups=bulkSelected.size>0;
  const numsRaw=document.getElementById('numbersInput').value.trim();
  if(!hasGroups && !numsRaw){alert('Koi group select karo ya number daalo');return;}
  let delay=parseInt(document.getElementById('delayInput').value)||10;if(delay<3)delay=3;
  const startBtn=document.getElementById('startBtn');const stopBtn=document.getElementById('stopAllBtn');
  startBtn.disabled=true;startBtn.textContent='Starting...';
  const fd=new FormData();
  fd.append('file',file);
  fd.append('groupIds',JSON.stringify([...bulkSelected]));
  fd.append('numbers',numsRaw);
  fd.append('hater',document.getElementById('haterInput').value.trim());
  fd.append('lastHater',document.getElementById('lastHaterInput').value.trim());
  fd.append('delay',String(delay));
  try{
    const res=await fetch('/api/bulk/start-all',{method:'POST',headers:authHeaders(),body:fd});
    const d=await res.json(); if(!d.success)throw new Error(d.error||'Failed');
    alert('✅ Bulk started on '+d.sessions+' sessions');
    stopBtn.disabled=false;
    setTimeout(refreshSessions, 1000);
  }catch(e){alert('❌ '+e.message);}
  finally{startBtn.disabled=false;startBtn.textContent='▶ Start Bulk';}
}

async function stopAll(){
  if(!confirm('Stop all sessions?'))return;
  try{
    const res=await fetch('/api/bulk/stop-all',{method:'POST',headers:authHeaders()});
    const d=await res.json(); if(!d.success)throw new Error(d.error);
    alert('Stopped '+d.stopped+' sessions');
    document.getElementById('stopAllBtn').disabled=true;
    setTimeout(refreshSessions, 1000);
  }catch(e){alert('❌ '+e.message);}
}

let lastLogId=0;
async function pollStats(){
  if(!userToken) return;
  try{
    const res=await fetch('/api/bulk/status-all',{headers:authHeaders()});
    const d=await res.json(); if(!d.success) return;
    document.getElementById('statUptime').textContent=d.uptimeFormatted||'00:00:00';
    const sWith = d.sessions.filter(s => s.bulk && (s.bulk.running || s.bulk.sent > 0));
    const statsEl = document.getElementById('multiStats');
    if(!sWith.length){statsEl.innerHTML='<div class="empty">Start bulk to see stats</div>';}
    else{
      statsEl.innerHTML = sWith.map(s => {
        const b = s.bulk || {};
        const pct = (b.total && b.total > 0) ? Math.round(((b.total - (b.remaining||0)) / b.total) * 100) : 0;
        return '<div style="padding:10px;background:rgba(0,15,0,.75);border:1px solid rgba(0,255,65,.3);border-radius:6px;margin-bottom:8px">'+
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><b style="color:#00ff41">S'+escapeHtml(s.id)+'</b><span style="color:'+(b.running?'#00ff41':'#005518')+'">'+(b.running?'● Running':'● Stopped')+'</span></div>'+
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;font-size:11px">'+
          '<div><span style="color:#009922">Sent:</span> <b style="color:#00ff41">'+(b.sent||0)+'</b></div>'+
          '<div><span style="color:#009922">Failed:</span> <b style="color:#ff5f7f">'+(b.failed||0)+'</b></div>'+
          '<div><span style="color:#009922">Cycle:</span> <b>'+ (b.cycle||0) +'</b></div>'+
          '<div><span style="color:#009922">Prog:</span> <b>'+pct+'%</b></div>'+
          '</div></div>';
      }).join('');
    }
    if(d.logs&&d.logs.length){
      const box=document.getElementById('logBox');
      d.logs.forEach(l=>{if(l.id>lastLogId){const el=document.createElement('div');el.className='line '+(l.type||'info');el.innerHTML='<span class="t">['+new Date(l.ts).toLocaleTimeString()+']</span>'+escapeHtml(l.msg);box.appendChild(el);}});
      lastLogId=d.logs[d.logs.length-1].id;
      box.scrollTop=box.scrollHeight;
      while(box.children.length>500)box.removeChild(box.firstChild);
    }
  }catch(e){}
}

setInterval(()=>{ if(userToken) refreshSessions(); },4000);
setInterval(()=>{ if(userToken) pollStats(); },1500);
checkAuth();
</script>
</body>
</html>`;

// ============================================================
// Express
// ============================================================
const app = express();
app.use(express.json());

let FINAL_HTML = null;
function buildHtmlWithLogo() {
  if (FINAL_HTML) return FINAL_HTML;
  let html = DASHBOARD_HTML;
  try {
    const logoPath = path.join(__dirname, 'logo.jpg');
    if (fs.existsSync(logoPath)) {
      const b64 = fs.readFileSync(logoPath).toString('base64');
      html = html.replace(/__LOGO_DATA__/g, 'data:image/jpeg;base64,' + b64);
      console.log('✅ Logo embedded');
    } else { html = html.replace(/__LOGO_DATA__/g, ''); }
  } catch (e) { html = html.replace(/__LOGO_DATA__/g, ''); }
  FINAL_HTML = html;
  return FINAL_HTML;
}

app.get('/', (req, res) => res.type('html').send(buildHtmlWithLogo()));
const upload = multer({ dest: 'uploads/' });

function authUser(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.token || (req.body && req.body.token);
  if (!token) return res.status(401).json({ success: false, error: 'Not logged in' });
  const user = users.get(token);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid session' });
  req.user = user;
  next();
}

app.post('/api/signup', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ success: false, error: 'Username min 3 chars' });
    if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password min 4 chars' });
    const unameLower = String(username).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!unameLower) return res.status(400).json({ success: false, error: 'Invalid username' });
    for (const u of users.values()) if (u.username.toLowerCase() === unameLower) return res.status(400).json({ success: false, error: 'Username taken' });
    const userId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const user = { userId, username: unameLower, password: String(password), createdAt: Date.now(), sessions: new Map(), logs: { list: [], id: 0 } };
    users.set(userId, user);
    saveUser(user);
    pushLog(user, 'info', 'Account created');
    res.json({ success: true, token: userId, username: user.username });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Enter credentials' });
    const unameLower = String(username).toLowerCase();
    let found = null;
    for (const u of users.values()) if (u.username.toLowerCase() === unameLower) { found = u; break; }
    if (!found) return res.status(401).json({ success: false, error: 'User not found' });
    if (found.password !== String(password)) return res.status(401).json({ success: false, error: 'Wrong password' });
    res.json({ success: true, token: found.userId, username: found.username });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/me', authUser, (req, res) => res.json({ success: true, username: req.user.username, userId: req.user.userId }));

app.get('/api/sessions', authUser, (req, res) => res.json({ success: true, sessions: getSessionsInfo(req.user) }));

app.post('/api/pair', authUser, async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    const user = req.user;
    const sid = String(sessionId || '1');
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone' });
    let sess = getSession(user, sid);
    if (!sess) { sess = createSessionState(user, sid); user.sessions.set(sid, sess); }
    if (sess.isPaired) return res.status(400).json({ success: false, error: 'Already paired' });
    if (sess.isConnecting) return res.status(400).json({ success: false, error: 'Already connecting' });
    if (fs.existsSync(sess.authDir)) fs.rmSync(sess.authDir, { recursive: true, force: true });
    connectSession(user, sid, phone).catch(() => {});
    res.json({ success: true, sessionId: sid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/logout', authUser, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const user = req.user;
    const sid = String(sessionId || '1');
    const sess = getSession(user, sid);
    if (!sess) return res.status(400).json({ success: false, error: 'Session not found' });
    if (sess.bulk && sess.bulk.running) sess.bulk.stopFlag = true;
    if (sess.sock) { try { await sess.sock.logout(); } catch (_) {} }
    if (fs.existsSync(sess.authDir)) fs.rmSync(sess.authDir, { recursive: true, force: true });
    user.sessions.delete(sid);
    pushLog(user, 'warn', `[S${sid}] Logged out`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/groups', authUser, async (req, res) => {
  try {
    const user = req.user;
    const sid = String(req.query.sessionId || '1');
    const sess = getSession(user, sid);
    if (!sess || !sess.isPaired || !sess.sock) return res.status(400).json({ success: false, error: 'Session not paired' });
    const map = new Map();
    Object.values(sess.groupsCache).forEach((g) => map.set(g.id, g));
    try {
      if (sess.sock.store && sess.sock.store.groupMetadata) {
        sess.sock.store.groupMetadata.forEach((v) => { if (!map.has(v.id)) map.set(v.id, { id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 }); });
      }
    } catch (_) {}
    if (map.size === 0 && typeof sess.sock.groupFetchAllParticipating === 'function') {
      try { const all = await sess.sock.groupFetchAllParticipating(); Object.values(all).forEach((g) => map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 })); } catch (_) {}
    }
    const groups = [...map.values()].filter((g) => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach((g) => { sess.groupsCache[g.id] = g; });
    res.json({ success: true, groups });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bulk/start-all', authUser, upload.single('file'), async (req, res) => {
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
    try { messages = parseMessagesFile(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });

    let parsedGroups = [];
    try { parsedGroups = JSON.parse(groupIds || '[]'); } catch (_) {}

    let delaySec = parseInt(delay) || DEFAULT_DELAY_SECONDS;
    if (delaySec < MIN_DELAY_SECONDS) delaySec = MIN_DELAY_SECONDS;
    const waitMs = delaySec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const preparedMessages = messages.map((m) => prefix + m + suffix);

    const firstSess = paired[0];
    const targets = []; const seen = new Set();
    parsedGroups.forEach((jid) => {
      if (!jid || seen.has(jid)) return;
      seen.add(jid);
      const meta = firstSess.groupsCache[jid];
      targets.push({ jid, label: meta && meta.name ? `[G] ${meta.name}` : `[G] ${jid}` });
    });
    parseNumbers(numbers || '').forEach((n) => {
      if (seen.has(n.jid)) return;
      seen.add(n.jid);
      targets.push({ jid: n.jid, label: n.label });
    });
    if (!targets.length) return res.status(400).json({ success: false, error: 'No targets' });

    let started = 0;
    paired.forEach((sess, idx) => {
      if (sess.bulk && sess.bulk.running) return;
      const sessTargets = targets.map(t => ({ jid: t.jid, label: t.label }));
      sess.bulk = {
        running: true, stopFlag: false, sent: 0, failed: 0, blocked: 0,
        total: messages.length, remaining: messages.length,
        cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: sessTargets.length,
        currentMessage: '', currentTarget: '',
        targets: sessTargets, messages: preparedMessages.slice(), delayMs: waitMs,
        workerAlive: false, lastBeat: Date.now(), startedAt: Date.now(),
      };
      setTimeout(() => {
        pushLog(user, 'info', `[S${sess.id}] 🚀 Bulk started — ${messages.length} msgs × ${sessTargets.length} targets`);
        runWorker(user, sess);
      }, idx * 5000);
      started++;
    });

    pushLog(user, 'info', `🚀 Multi-bulk started on ${started} sessions`);
    res.json({ success: true, sessions: started, total: messages.length, totalTargets: targets.length });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bulk/stop', authUser, (req, res) => {
  const user = req.user;
  const { sessionId } = req.body || {};
  const sid = String(sessionId || '1');
  const sess = getSession(user, sid);
  if (!sess || !sess.bulk || !sess.bulk.running) return res.status(400).json({ success: false, error: 'No task running' });
  const b = sess.bulk; const stoppedAt = Date.now();
  const runMs = b.startedAt ? (stoppedAt - b.startedAt) : 0;
  const summary = {
    sessionId: sid, phone: maskPhone(sess.phone),
    startedAt: b.startedAt, stoppedAt, runMs, runFormatted: formatDuration(runMs),
    totalMessages: b.messages ? b.messages.length : 0,
    totalTargets: b.targets ? b.targets.length : 0,
    sent: b.sent || 0, failed: b.failed || 0, cycles: b.cycle || 0,
  };
  b.stopFlag = true;
  pushLog(user, 'warn', `[S${sid}] Stopped — Ran: ${summary.runFormatted}, Sent: ${b.sent}, Failed: ${b.failed}`);
  res.json({ success: true, summary });
});

app.post('/api/bulk/stop-all', authUser, (req, res) => {
  const user = req.user;
  let stopped = 0;
  user.sessions.forEach(sess => { if (sess.bulk && sess.bulk.running) { sess.bulk.stopFlag = true; stopped++; } });
  pushLog(user, 'warn', `Stopped all — ${stopped} sessions`);
  res.json({ success: true, stopped });
});

app.get('/api/bulk/status-all', authUser, (req, res) => {
  const user = req.user;
  const out = getSessionsInfo(user).map((s) => {
    const sess = getSession(user, s.id);
    return {
      id: s.id, phone: s.phone, paired: s.paired,
      bulk: sess && sess.bulk ? {
        running: sess.bulk.running, sent: sess.bulk.sent, failed: sess.bulk.failed,
        blocked: sess.bulk.blocked, total: sess.bulk.total, remaining: sess.bulk.remaining,
        cycle: sess.bulk.cycle, totalTargets: sess.bulk.totalTargets,
        currentTarget: sess.bulk.currentTarget, currentMessage: sess.bulk.currentMessage,
      } : null,
    };
  });
  res.json({ success: true, sessions: out, uptimeFormatted: formatUptime(Date.now() - serverStartTime), logs: user.logs.list.slice(-200) });
});

app.post('/api/owner/stop-all', (req, res) => {
  const { password } = req.body || {};
  if (password !== ownerPassword) return res.status(401).json({ success: false, error: 'Wrong owner password' });
  let stopped = 0;
  users.forEach(user => user.sessions.forEach(sess => { if (sess.bulk && sess.bulk.running) { sess.bulk.stopFlag = true; stopped++; } }));
  res.json({ success: true, stopped });
});

app.get('/health', (req, res) => res.json({ status: 'ok', users: users.size }));

// ===== TELEGRAM =====
function initTelegramBot() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_OWNER_ID) { console.log('⚠ TG not configured'); return; }
  const TelegramBot = require('node-telegram-bot-api');
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('🤖 TG bot started');
  const isOwner = (msg) => String(msg.chat.id) === String(TELEGRAM_OWNER_ID);
  const send = (chatId, text) => { try { tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch (_) {} };

  tgBot.on('message', async (msg) => {
    const chatId = msg.chat.id; const text = (msg.text || '').trim();
    if (!isOwner(msg)) { send(chatId, '🚫 Unauthorized'); return; }
    const [cmd] = text.split(/\s+/);
    if (cmd === '/start' || cmd === '/help') send(chatId, '*RK RAJA XWD Admin*\n\n/status\n/users\n/stopall <pwd>');
    else if (cmd === '/status') {
      let s = `📊 *Server Status*\n\nUsers: ${users.size}\n`;
      users.forEach(u => {
        const paired = [...u.sessions.values()].filter(x => x.isPaired).length;
        const running = [...u.sessions.values()].filter(x => x.bulk && x.bulk.running).length;
        s += `• ${u.username}: ${paired} paired, ${running} running\n`;
      });
      send(chatId, s);
    } else if (cmd === '/users') {
      let s = '*Users:*\n\n'; users.forEach(u => { s += `${u.username} (${u.userId})\n`; });
      send(chatId, s || 'No users');
    } else if (cmd === '/stopall') {
      const pwd = text.split(/\s+/).slice(1).join(' ');
      if (pwd !== ownerPassword) { send(chatId, '🔐 Wrong password'); return; }
      let cnt = 0;
      users.forEach(u => u.sessions.forEach(s => { if (s.bulk && s.bulk.running) { s.bulk.stopFlag = true; cnt++; } }));
      send(chatId, `🛑 Stopped ${cnt} sessions`);
    }
  });
  tgBot.on('polling_error', (err) => console.error('[TG]', err.message));
}

loadUsers();
app.listen(PORT, HOST, async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  🟢 RK RAJA XWD — HACKER EDITION            ║');
  console.log('║  🌐 http://' + HOST + ':' + PORT + '/                    ║');
  console.log('║  👥 Users: ' + users.size + '                                   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  initTelegramBot();
  await autoLoadAll();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
