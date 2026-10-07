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

// ===== TELEGRAM CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YAHAN_APNA_TOKEN_DALO';
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || 'YAHAN_APNA_CHAT_ID_DALO';
let tgBot = null;

const PORT = process.env.PORT || 26014;
const HOST = '0.0.0.0';
const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

let serverStartTime = Date.now();

// ===== SERVER PASSWORD =====
let serverPassword = process.env.SERVER_PASSWORD || 'Rkraja00';
const PASSWORD_FILE = path.join(__dirname, 'password.json');
try {
  if (fs.existsSync(PASSWORD_FILE)) {
    const data = JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8'));
    if (data && data.password) serverPassword = data.password;
  }
} catch (_) {}

console.log('\n╔══════════════════════════════════════╗');
console.log('║  🔐 SERVER PASSWORD: ' + serverPassword);
console.log('║  Dashboard se change kar sakte ho    ║');
console.log('╚══════════════════════════════════════╝\n');

// ===== MULTIPLE SESSIONS =====
const sessions = new Map();

function createSessionState(sid) {
  return {
    id: String(sid),
    sock: null,
    isPaired: false,
    phone: null,
    pairingCode: null,
    isConnecting: false,
    pairingRequested: false,
    connectedAt: null,
    lastError: null,
    authDir: `auth_info_baileys_${sid}`,
    groupsCache: {},
    bulk: null,
    sessionStartedAt: Date.now(),
  };
}

function getSession(sid) {
  if (sid === undefined || sid === null) sid = '1';
  return sessions.get(String(sid));
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
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function getAllSessionsInfo() {
  const out = [];
  sessions.forEach((s) => {
    out.push({
      id: s.id,
      phone: s.phone,
      phoneMasked: maskPhone(s.phone),
      paired: s.isPaired,
      connecting: s.isConnecting,
      code: s.isPaired ? null : s.pairingCode,
      connectedAt: s.connectedAt,
      error: s.lastError,
      groupCount: Object.keys(s.groupsCache).length,
      bulkRunning: s.bulk ? s.bulk.running : false,
      sessionStartedAt: s.sessionStartedAt || null,
      bulkStartedAt: s.bulk && s.bulk.running ? s.bulk.startedAt : null,
      bulkSent: s.bulk ? s.bulk.sent : 0,
      bulkFailed: s.bulk ? s.bulk.failed : 0,
      bulkCycle: s.bulk ? s.bulk.cycle : 0,
    });
  });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const logs = { list: [], id: 0 };

function pushLog(type, msg) {
  logs.list.push({ id: ++logs.id, ts: Date.now(), type, msg });
  if (logs.list.length > 500) logs.list.splice(0, logs.list.length - 500);
  const icons = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isSocketReady(sess) { return !!(sess && sess.sock && sess.isPaired); }

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
    const label = jid.endsWith('@g.us') ? '[G] ' + jid : '[N] +' + jid.split('@')[0];
    out.push({ jid, label });
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
      if (attempt < SEND_RETRY) { pushLog('warn', `Retry → ${jid}: ${e.message}`); await sleep(RETRY_WAIT_MS); }
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown' };
}

async function runWorker(sess) {
  const b = sess.bulk;
  if (!b || b.workerAlive) return;
  b.workerAlive = true;
  pushLog('info', `[S${sess.id}] Worker started`);
  try {
    while (!b.stopFlag) {
      if (!isSocketReady(sess)) { b.lastBeat = Date.now(); await sleep(3000); continue; }
      for (let mi = 0; mi < b.messages.length && !b.stopFlag; mi++) {
        const msg = b.messages[mi];
        b.msgIndex = mi; b.currentMessage = msg;
        for (let ti = 0; ti < b.targets.length && !b.stopFlag; ti++) {
          const t = b.targets[ti];
          b.targetIndex = ti; b.currentTarget = t.label; b.lastBeat = Date.now();
          if (!isSocketReady(sess)) { pushLog('warn', `[S${sess.id}] Socket unavailable`); break; }
          try {
            const res = await safeSend(sess, t.jid, msg);
            if (res.ok) { b.sent++; pushLog('ok', `[S${sess.id}] Cycle ${b.cycle + 1} | Msg ${mi + 1}/${b.messages.length} → ${t.label}`); }
            else { b.failed++; pushLog('err', `[S${sess.id}] Msg ${mi + 1} → ${t.label}: ${res.error}`); }
          } catch (e) { b.failed++; pushLog('err', `[S${sess.id}] Error → ${t.label}: ${e.message}`); }
          b.remaining = b.messages.length - (mi + 1);
          if (!b.stopFlag) await sleep(b.delayMs);
        }
        if (!isSocketReady(sess) && !b.stopFlag) break;
      }
      if (!b.stopFlag) {
        b.cycle++; b.remaining = b.messages.length; b.msgIndex = 0; b.targetIndex = 0;
        pushLog('info', `[S${sess.id}] Cycle ${b.cycle} completed — restarting`);
      }
    }
  } catch (loopErr) {
    pushLog('err', `[S${sess.id}] Worker crashed: ${loopErr.message}`);
    if (!b.stopFlag) { b.workerAlive = false; b.running = true; setTimeout(() => runWorker(sess), 3000); return; }
  } finally {
    if (b.stopFlag) {
      b.running = false; b.stopFlag = false; b.workerAlive = false;
      b.currentMessage = ''; b.currentTarget = '';
      pushLog('info', `[S${sess.id}] Stopped — Sent: ${b.sent}, Failed: ${b.failed}, Cycles: ${b.cycle}`);
    } else b.workerAlive = false;
  }
}

setInterval(() => {
  sessions.forEach((sess) => {
    const b = sess.bulk;
    if (b && b.running && !b.workerAlive) { pushLog('warn', `[S${sess.id}] Watchdog restart`); runWorker(sess); }
  });
}, WATCHDOG_INTERVAL_MS);

async function connectSession(sid, phone) {
  let sess = getSession(sid);
  if (!sess) { sess = createSessionState(sid); sessions.set(String(sid), sess); }
  if (!phone) throw new Error('Phone required');
  if (sess.isConnecting) throw new Error('Already connecting');
  if (sess.isPaired) throw new Error('Already paired');
  sess.isConnecting = true; sess.phone = phone; sess.pairingCode = null; sess.lastError = null;
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
      if (connection === 'connecting' && !sess.sock.authState.creds.registered && !sess.pairingRequested) {
        sess.pairingRequested = true;
        try {
          await sleep(1000);
          sess.pairingCode = await sess.sock.requestPairingCode(phone);
          console.log(`\n📱 [S${sess.id}] PAIRING CODE for ${phone}: ${sess.pairingCode}\n`);
          pushLog('info', `[S${sess.id}] Pairing code: ${sess.pairingCode}`);
          if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
            try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `📱 *Pairing Code [Session ${sess.id}]*\n\nNumber: \`${phone}\`\nCode: \`${sess.pairingCode}\``, { parse_mode: 'Markdown' }); } catch (_) {}
          }
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
        pushLog('ok', `[S${sess.id}] WhatsApp connected (${phone})`);
        if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
          try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `✅ *Connected [Session ${sess.id}]*\n\nNumber: \`${phone}\``, { parse_mode: 'Markdown' }); } catch (_) {}
        }
        setTimeout(() => {
          try {
            if (sess.sock && sess.sock.store && sess.sock.store.groupMetadata) {
              sess.sock.store.groupMetadata.forEach((v) => {
                sess.groupsCache[v.id] = { id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 };
              });
              pushLog('info', `[S${sess.id}] Loaded ${Object.keys(sess.groupsCache).length} groups`);
            }
          } catch (_) {}
        }, 3000);
        if (sess.bulk && sess.bulk.running && !sess.bulk.workerAlive) { runWorker(sess); }
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        pushLog('warn', `[S${sess.id}] Connection closed (${statusCode})`);
        sess.isPaired = false; sess.isConnecting = false;
        if (shouldReconnect && sess.phone) {
          sess.pairingRequested = false;
          setTimeout(() => connectSession(sess.id, sess.phone).catch(console.error), 3000);
        } else if (statusCode === DisconnectReason.loggedOut) {
          sess.pairingCode = null; sess.pairingRequested = false; sess.phone = null;
          if (sess.bulk && sess.bulk.running) { sess.bulk.stopFlag = true; }
        }
      }
    });
  } catch (err) {
    sess.isConnecting = false; sess.lastError = err.message; throw err;
  }
}

async function autoLoadSessions() {
  try {
    const dirs = fs.readdirSync(__dirname).filter(d => d.startsWith('auth_info_baileys_'));
    if (!dirs.length) { console.log('📂 No saved sessions found'); return; }
    console.log(`📂 Found ${dirs.length} saved session(s) — auto connecting...`);
    for (const dir of dirs) {
      const sid = dir.replace('auth_info_baileys_', '');
      const credsFile = path.join(__dirname, dir, 'creds.json');
      if (!fs.existsSync(credsFile)) continue;
      let creds = {};
      try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (_) {}
      const phone = creds.me && creds.me.id ? creds.me.id.split(':')[0].split('@')[0] : null;
      let sess = getSession(sid);
      if (!sess) { sess = createSessionState(sid); sessions.set(sid, sess); }
      sess.phone = phone;
      pushLog('info', `🔄 Auto-loading Session ${sid}${phone ? ' (' + phone + ')' : ''}...`);
      connectSession(sid, phone).catch((e) => { pushLog('err', `[S${sid}] Auto-load failed: ${e.message}`); });
      await sleep(1500);
    }
  } catch (e) { console.error('Auto-load error:', e.message); }
}

// ============================================================
// EMBEDDED HTML
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>RK RAJA XWD</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#050507;color:#e2e8f0;min-height:100vh;overflow-x:hidden;position:relative}
  body::before{content:"";position:fixed;inset:-50px;z-index:-3;background-image:url('__LOGO_DATA__');background-size:cover;background-position:center center;background-repeat:no-repeat;filter:blur(10px) brightness(0.4);opacity:0.55}
  body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(1200px 800px at 15% 10%, rgba(255,0,60,.18), transparent 60%),radial-gradient(900px 600px at 85% 90%, rgba(255,0,60,.14), transparent 65%),linear-gradient(135deg, rgba(5,5,10,.75) 0%, rgba(11,11,18,.6) 55%, rgba(5,5,10,.75) 100%);pointer-events:none}
  .streaks{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
  .streaks span{position:absolute;height:1px;width:220px;left:-30%;background:linear-gradient(90deg,transparent,#ff003c,transparent);filter:drop-shadow(0 0 6px #ff003c);opacity:.55;animation:streak 7s linear infinite}
  .streaks span:nth-child(2){top:25%;animation-delay:1.5s;animation-duration:9s}
  .streaks span:nth-child(3){top:55%;animation-delay:3s;animation-duration:8s}
  .streaks span:nth-child(4){top:78%;animation-delay:4.5s;animation-duration:10s}
  @keyframes streak{from{transform:translateX(0) rotate(-12deg)}to{transform:translateX(160vw) rotate(-12deg)}}
  .container{max-width:1180px;margin:0 auto;padding:28px 18px 60px;position:relative;z-index:1}
  .brand{text-align:center;margin-bottom:26px}
  .brand h1{font-size:clamp(22px,4vw,40px);font-weight:900;letter-spacing:4px;background:linear-gradient(180deg,#ffffff 0%,#c9c9d6 45%,#ff003c 130%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 26px rgba(255,0,60,.45);font-family:"Orbitron","Rajdhani",sans-serif;text-transform:uppercase}
  .brand h1 .x{color:#ff003c;-webkit-text-fill-color:#ff003c;text-shadow:0 0 18px #ff003c}
  .brand p{color:#8b8b9c;font-size:11px;letter-spacing:3px;margin-top:6px;text-transform:uppercase}
  .tabs{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;justify-content:center}
  .tab{padding:11px 20px;border-radius:12px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,0,60,.35);background:rgba(255,0,60,.05);color:#ff5277;transition:.2s}
  .tab.active{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border-color:#ff003c;box-shadow:0 8px 24px rgba(255,0,60,.35)}
  .tab:hover:not(.active){background:rgba(255,0,60,.12)}
  .panel{display:none}.panel.active{display:block}
  .layout{display:grid;grid-template-columns:420px 1fr;gap:20px}
  @media(max-width:900px){.layout{grid-template-columns:1fr}}
  .card{position:relative;background:linear-gradient(155deg, rgba(20,20,28,.85), rgba(10,10,15,.7));border:1px solid rgba(255,0,60,.28);border-radius:18px;padding:24px;margin-bottom:20px;backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)}
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase}
  .card h2 .dot{width:8px;height:8px;border-radius:50%;background:#ff003c;box-shadow:0 0 12px #ff003c}
  label{display:block;font-size:11px;color:#9a9aab;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:rgba(5,5,10,.75);border:1px solid rgba(255,0,60,.25);border-radius:12px;padding:12px 14px;color:#f1f1f6;font-size:14px;font-family:inherit;outline:none;transition:.25s}
  input:focus,textarea:focus,select:focus{border-color:#ff003c;box-shadow:0 0 0 3px rgba(255,0,60,.14)}
  input:disabled{color:#6b6b7a}
  textarea{resize:vertical;min-height:80px}
  .field{margin-bottom:14px}
  button{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:.22s;margin-top:6px;width:100%;box-shadow:0 8px 24px rgba(255,0,60,.28)}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 30px rgba(255,0,60,.45)}
  button:disabled{background:#2a2a34;color:#6b6b7a;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid rgba(255,0,60,.5);color:#ff5277;box-shadow:none}
  button.ghost:hover:not(:disabled){background:rgba(255,0,60,.1)}
  button.danger{background:linear-gradient(180deg,#ff0040,#a80028);color:#fff;border:1px solid #ff003c}
  .btnrow{display:flex;gap:10px}.btnrow button{margin-top:0}
  .msg{margin-top:14px;padding:12px 15px;border-radius:10px;font-size:13px;display:none}
  .msg.ok{background:rgba(255,0,60,.1);color:#ff8ba6;border:1px solid rgba(255,0,60,.4);display:block}
  .msg.err{background:rgba(255,60,60,.1);color:#ffa1a1;border:1px solid rgba(255,60,60,.4);display:block}
  .code-box{background:rgba(5,5,10,.85);border:2px dashed #ff003c;border-radius:16px;padding:20px;margin:14px 0;text-align:center}
  .code-value{font-size:32px;font-weight:900;letter-spacing:8px;color:#ff003c;font-family:'Courier New',monospace;text-shadow:0 0 24px rgba(255,0,60,.7)}
  .code-label{font-size:11px;color:#8b8b9c;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase}
  .steps{background:rgba(5,5,10,.6);border:1px solid rgba(255,0,60,.18);border-radius:12px;padding:14px;font-size:12px;line-height:1.8;color:#c3c3d1}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:520px){.grid2{grid-template-columns:1fr}}
  .stat{background:rgba(5,5,10,.7);border:1px solid rgba(255,0,60,.2);border-radius:14px;padding:14px;text-align:center}
  .stat .k{font-size:10px;color:#8b8b9c;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .stat .v{font-size:20px;font-weight:900;color:#fff;word-break:break-all}
  .stat .v.red{color:#ff003c}
  .stat .v.green{color:#38ef7d}
  .stat .v.small{font-size:14px;font-weight:700}
  .statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
  @media(max-width:520px){.statgrid{grid-template-columns:1fr 1fr}}
  .log{background:#000;border:1px solid rgba(255,0,60,.25);border-radius:14px;padding:14px;height:340px;overflow-y:auto;font-family:'Courier New',monospace;font-size:12px;line-height:1.75}
  .log::-webkit-scrollbar{width:8px}.log::-webkit-scrollbar-track{background:#0a0a0f}.log::-webkit-scrollbar-thumb{background:#ff003c;border-radius:8px}
  .log .line{color:#9a9aab;border-bottom:1px dashed rgba(255,255,255,.04);padding:2px 0;word-break:break-all}
  .log .t{color:#ff5277;margin-right:8px}
  .log .ok{color:#38ef7d}.log .err{color:#ff6b6b}.log .info{color:#6bc6ff}.log .warn{color:#ffc655}
  .progress{height:8px;background:rgba(5,5,10,.8);border-radius:99px;overflow:hidden;border:1px solid rgba(255,0,60,.25);margin-top:12px}
  .progress>div{height:100%;width:0%;background:linear-gradient(90deg,#ff003c,#ff5277,#ff003c);transition:width .4s ease}
  .groups-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .groups-toolbar button{width:auto;margin-top:0;padding:10px 16px;font-size:11px}
  .groups-toolbar .count{font-size:12px;color:#8b8b9c;margin-left:auto}
  .groups-list{background:rgba(5,5,10,.6);border:1px solid rgba(255,0,60,.2);border-radius:14px;max-height:360px;overflow-y:auto;padding:8px}
  .group-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid transparent}
  .group-item:hover{background:rgba(255,0,60,.08)}
  .group-item.selected{background:rgba(255,0,60,.14);border-color:#ff003c}
  .group-item input[type=checkbox]{width:18px;height:18px;accent-color:#ff003c;cursor:pointer;flex-shrink:0}
  .group-info{flex:1;min-width:0}
  .group-name{color:#f1f1f6;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .group-jid{color:#6b6b7a;font-size:11px;font-family:'Courier New',monospace;margin-top:2px}
  .hidden{display:none!important}
  .hint{font-size:11px;color:#6b6b7a;margin-top:8px}
  .empty{padding:30px;text-align:center;color:#6b6b7a;font-size:13px}
  .footer{text-align:center;color:#4b4b5a;font-size:11px;letter-spacing:3px;margin-top:30px;text-transform:uppercase}
  .session-item{display:flex;flex-direction:column;gap:8px;padding:14px;background:rgba(5,5,10,.7);border:1px solid rgba(255,0,60,.25);border-radius:12px;margin-bottom:10px}
  .session-item.active{border-color:#ff003c;background:rgba(255,0,60,.08)}
  .session-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .session-name{color:#f1f1f6;font-size:14px;font-weight:700}
  .session-status{color:#ff5277;font-size:11px;font-family:'Courier New',monospace;margin-top:2px}
  .session-actions{display:flex;gap:8px}
  .session-actions button{width:auto;padding:8px 14px;font-size:10px;margin:0}
</style>
</head>
<body>
<div class="streaks"><span></span><span></span><span></span><span></span></div>
<div class="container">
  <div class="brand">
    <h1>RK RAJA <span class="x">XWD</span></h1>
    <p>Multi-Session WhatsApp Control Center</p>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="dashboard" onclick="switchTab('dashboard')">Dashboard</div>
    <div class="tab" data-tab="sender" onclick="switchTab('sender')">Bulk Sender</div>
  </div>

  <div class="panel active" id="panel-dashboard">
    <div class="card">
      <h2><span class="dot"></span>➕ Add WhatsApp Number</h2>
      <div class="field">
        <label>Session ID (1, 2, 3...)</label>
        <input id="newSessionId" type="text" placeholder="1" value="1"/>
        <div class="hint">Har number ka alag session ID</div>
      </div>
      <div class="field">
        <label>Phone Number (country code, no + or spaces)</label>
        <input id="phoneInput" type="tel" placeholder="e.g. 919876543210"/>
      </div>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="pairMsg" class="msg"></div>
      <div id="codeSection" class="hidden">
        <div class="code-box">
          <div class="code-label">Pairing Code for <span id="codeSessionLabel">Session</span></div>
          <div id="codeValue" class="code-value">------</div>
        </div>
        <div class="steps">
          <b>Steps:</b><br/>
          1. Open WhatsApp on that number<br/>
          2. Go to <b>Linked Devices</b><br/>
          3. <b>Link a Device</b> → <b>Link with phone number</b><br/>
          4. Enter the code above
        </div>
      </div>
    </div>

    <div class="card">
      <h2><span class="dot"></span>📱 Paired Numbers</h2>
      <div id="sessionsList"><div class="empty">No sessions yet. Add a number above.</div></div>
    </div>

    <div class="card">
      <h2><span class="dot"></span>🔐 Set Stop Password</h2>
      <div class="hint" style="margin-bottom:12px">Ye password Stop karne ke liye chahiye hoga.</div>
      <div class="field">
        <label>Current Password</label>
        <input id="pwdCurrent" type="password" placeholder="Default: Rkraja00"/>
      </div>
      <div class="field">
        <label>New Password (min 4 chars)</label>
        <input id="pwdNew" type="password" placeholder="New password"/>
      </div>
      <button onclick="setPassword()">🔐 Change Password</button>
      <div id="pwdMsg" class="msg"></div>
    </div>

    <div class="card">
      <h2><span class="dot"></span>Live Stats</h2>
      <div class="statgrid">
        <div class="stat"><div class="k">Total Sessions</div><div class="v red" id="statSessions">0</div></div>
        <div class="stat"><div class="k">Paired</div><div class="v red" id="statPaired">0</div></div>
        <div class="stat"><div class="k">Uptime</div><div class="v red" id="statUptime">00:00:00</div></div>
      </div>
    </div>

    <div class="card">
      <h2><span class="dot"></span>Live Log</h2>
      <div class="log" id="logBox"><div class="line"><span class="t">[boot]</span> Waiting...</div></div>
      <div class="btnrow" style="margin-top:12px">
        <button class="ghost" onclick="clearLog()">Clear Log</button>
      </div>
    </div>
  </div>

  <div class="panel" id="panel-sender">
    <div class="layout">
      <div>
        <div class="card">
          <h2><span class="dot"></span>Message Queue & Targets</h2>
          <div class="field">
            <label>Upload Messages File (.txt)</label>
            <input id="fileInput" type="file" accept=".txt"/>
            <div class="hint" id="fileHint">No file chosen</div>
          </div>

          <div class="field">
            <label>Send to Groups</label>
            <div class="groups-toolbar" style="margin-bottom:8px">
              <button class="ghost" onclick="fetchGroupsForBulk()">Fetch Groups</button>
              <button class="ghost" onclick="selectAllBulkGroups()">All</button>
              <button class="ghost" onclick="clearBulkGroups()">Clear</button>
              <span class="count" id="bulkGroupsCount">0 selected</span>
            </div>
            <div class="groups-list" id="bulkGroupsList" style="max-height:200px">
              <div class="empty">Click "Fetch Groups" to load</div>
            </div>
          </div>

          <div class="field">
            <label>📱 Send to Phone Numbers (optional)</label>
            <textarea id="numbersInput" placeholder="919876543210&#10;918765432109"></textarea>
          </div>

          <div class="field">
            <label>Hater Name (optional prefix)</label>
            <input id="haterInput" type="text" placeholder="e.g. RK RAJA XWD"/>
          </div>
          <div class="field">
            <label>Delay (seconds) — min 3s</label>
            <input id="delayInput" type="number" min="3" value="10"/>
          </div>
          <div class="field">
            <label>Last Hater Name (optional suffix)</label>
            <input id="lastHaterInput" type="text" placeholder="e.g. XWD"/>
          </div>

          <div class="btnrow">
            <button id="startBtn" onclick="startServer()">▶ Start Bulk</button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h2><span class="dot"></span>Live Stats</h2>
          <div class="statgrid">
            <div class="stat"><div class="k">Status</div><div class="v" id="statStatus">Idle</div></div>
            <div class="stat"><div class="k">Sent</div><div class="v green" id="statSent">0</div></div>
            <div class="stat"><div class="k">Failed</div><div class="v red" id="statFailed">0</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Cycle</div><div class="v" id="statCycle">0</div></div>
            <div class="stat"><div class="k">Targets</div><div class="v" id="statTargets">0</div></div>
            <div class="stat"><div class="k">Remaining</div><div class="v" id="statRemaining">0</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Current</div><div class="v small" id="statCurTarget">—</div></div>
            <div class="stat"><div class="k">Progress</div><div class="v" id="statProgress">0%</div></div>
          </div>
          <div class="progress"><div id="progBar"></div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">RK RAJA XWD © — Secure Session</div>
</div>

<script>
function switchTab(name){document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));}
function showMsg(el,type,text){el.textContent=text;el.style.display=type?'block':'none';el.className='msg'+(type?' '+type:'');}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clearLog(){document.getElementById('logBox').innerHTML='';}
function log(type,msg){const box=document.getElementById('logBox');const t=new Date().toLocaleTimeString();const el=document.createElement('div');el.className='line '+type;el.innerHTML='<span class="t">['+t+']</span>'+escapeHtml(msg);box.appendChild(el);box.scrollTop=box.scrollHeight;while(box.children.length>500)box.removeChild(box.firstChild);}

let allSessions=[];let currentSessionGroups=[];

async function setPassword(){
  const cur = document.getElementById('pwdCurrent').value;
  const nw = document.getElementById('pwdNew').value;
  const msg = document.getElementById('pwdMsg');
  if(!cur){showMsg(msg,'err','Current password daalo');return;}
  if(!nw || nw.length < 4){showMsg(msg,'err','New password min 4 chars');return;}
  try {
    const res = await fetch('/api/password/set', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ currentPassword: cur, newPassword: nw })
    });
    const d = await res.json();
    if(!d.success) throw new Error(d.error);
    showMsg(msg,'ok','✅ Password changed');
    document.getElementById('pwdCurrent').value='';
    document.getElementById('pwdNew').value='';
  } catch(e){ showMsg(msg,'err',e.message); }
}

async function startPair(){
  const phone=document.getElementById('phoneInput').value.trim();
  const sid=document.getElementById('newSessionId').value.trim()||'1';
  const btn=document.getElementById('pairBtn');
  const msgEl=document.getElementById('pairMsg');
  const codeSection=document.getElementById('codeSection');
  if(!phone||!/^\\d{10,15}$/.test(phone)){showMsg(msgEl,'err','Enter a valid number');return;}
  btn.disabled=true;btn.textContent='Starting...';showMsg(msgEl,'','');
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,sessionId:sid})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error||'Failed');
    codeSection.classList.remove('hidden');
    document.getElementById('codeSessionLabel').textContent='Session '+sid;
    document.getElementById('codeValue').textContent='Generating...';
    showMsg(msgEl,'ok','Pairing started');
    setTimeout(refreshSessions, 2500);
  }catch(e){showMsg(msgEl,'err',e.message);}
  finally{btn.disabled=false;btn.textContent='Get Pairing Code';}
}

async function refreshSessions(){
  try{
    const res=await fetch('/api/sessions');
    const d=await res.json();
    allSessions=d.sessions||[];
    renderSessions();
    document.getElementById('statSessions').textContent=allSessions.length;
    document.getElementById('statPaired').textContent=allSessions.filter(s=>s.paired).length;
  }catch(e){}
}

function renderSessions(){
  const listEl=document.getElementById('sessionsList');
  if(!allSessions.length){listEl.innerHTML='<div class="empty">No sessions yet. Add a number above.</div>';return;}
  listEl.innerHTML=allSessions.map(s=>{
    const cls=s.paired?'session-item active':'session-item';
    let statusBadge = s.paired ? '✅ Paired' : (s.connecting ? '⏳ Connecting' : (s.code ? '🔑 Code' : '❌ Idle'));
    let groupsTxt = s.paired ? (s.groupCount+' groups') : '';
    
    let bulkHtml = '';
    if(s.bulkRunning){
      let bulkTxt = '';
      if(s.bulkStartedAt){
        const bSec = Math.floor((Date.now()-s.bulkStartedAt)/1000);
        const bh = String(Math.floor(bSec/3600)).padStart(2,'0');
        const bm = String(Math.floor((bSec%3600)/60)).padStart(2,'0');
        const bs = String(bSec%60).padStart(2,'0');
        bulkTxt = bh+':'+bm+':'+bs;
      }
      bulkHtml = '<div style="padding:8px 10px;background:rgba(255,0,60,.1);border:1px solid rgba(255,0,60,.4);border-radius:8px;font-size:11px">'+
        '<div style="color:#ff003c;font-weight:700;letter-spacing:1px">🔄 BULK RUNNING — '+bulkTxt+'</div>'+
        '<div style="color:#9a9aab;margin-top:2px">📤 '+s.bulkSent+' | ❌ '+s.bulkFailed+' | 🔁 '+s.bulkCycle+'</div>'+
      '</div>';
    }
    
    return '<div class="'+cls+'">'+
      '<div class="session-header">'+
        '<div>'+
          '<div class="session-name">Session '+escapeHtml(s.id)+'</div>'+
          '<div class="session-status">'+statusBadge+(groupsTxt?' | '+groupsTxt:'')+'</div>'+
        '</div>'+
        '<div class="session-actions">'+
          (s.paired?'<button class="ghost" onclick="askPassword(\\''+escapeHtml(s.id)+'\\',\\'logout\\')">Logout</button>':'')+
          (s.bulkRunning?'<button class="danger" onclick="askPassword(\\''+escapeHtml(s.id)+'\\',\\'stop\\')">Stop</button>':'')+
        '</div>'+
      '</div>'+
      bulkHtml+
    '</div>';
  }).join('');
}

async function askPassword(sid, action){
  const pwd = prompt('🔐 Enter SERVER PASSWORD to ' + (action === 'stop' ? 'STOP bulk' : 'LOGOUT') + ' on Session ' + sid + ':');
  if (pwd === null) return;
  if (!pwd.trim()) { alert('Password required'); return; }
  
  try {
    if (action === 'stop') {
      const res = await fetch('/api/bulk/stop', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionId: sid, password: pwd })
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'Failed');
      log('warn', 'Stop requested for Session ' + sid);
      showStopSummary(d.summary);
      setTimeout(refreshSessions, 1200);
    } else if (action === 'logout') {
      if (!confirm('Logout Session ' + sid + '?')) return;
      const res = await fetch('/api/logout', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionId: sid, password: pwd })
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'Failed');
      log('warn', 'Logged out Session ' + sid);
      setTimeout(refreshSessions, 1000);
    }
  } catch(e) {
    alert('❌ ' + e.message);
  }
}

function showStopSummary(s){
  if(!s) return;
  const overlay=document.createElement('div');
  overlay.id='stopSummaryOverlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:center;justify-content:center;padding:18px;overflow-y:auto;backdrop-filter:blur(6px)';
  
  const box=document.createElement('div');
  box.style.cssText='background:linear-gradient(155deg,rgba(40,15,20,.97),rgba(15,8,10,.97));border:1px solid rgba(255,0,60,.5);border-radius:18px;padding:22px;max-width:620px;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.85),0 0 40px rgba(255,0,60,.25)';
  
  const targetsHtml = (s.targets||[]).map(t=>{
    const icon = t.type==='group' ? '👥' : '📱';
    const jid = t.jid.endsWith('@g.us') 
      ? t.jid.split('@')[0].slice(0,14)+'...' 
      : '+'+t.jid.split('@')[0];
    return '<div style="padding:7px 10px;background:rgba(255,0,60,.07);border:1px solid rgba(255,0,60,.22);border-radius:8px;margin-bottom:5px;font-size:12px;display:flex;align-items:center;gap:8px">'+
      '<span style="flex-shrink:0">'+icon+'</span>'+
      '<span style="flex:1;color:#f1f1f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escapeHtml(t.label)+'</span>'+
      '<span style="color:#6b6b7a;font-family:monospace;font-size:10px;flex-shrink:0">'+escapeHtml(jid)+'</span>'+
    '</div>';
  }).join('');
  
  box.innerHTML=''+
    '<div style="text-align:center;margin-bottom:20px">'+
      '<div style="font-size:32px;margin-bottom:6px">🛑</div>'+
      '<h2 style="color:#fff;font-size:18px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Task Stopped</h2>'+
      '<div style="color:#9a9aab;font-size:12px">Session '+escapeHtml(s.sessionId)+'</div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">'+
      '<div style="padding:12px;background:rgba(255,0,60,.08);border:1px solid rgba(255,0,60,.35);border-radius:12px;text-align:center">'+
        '<div style="color:#9a9aab;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Run Time</div>'+
        '<div style="color:#ff003c;font-size:22px;font-weight:900;font-family:monospace;text-shadow:0 0 12px rgba(255,0,60,.5)">'+escapeHtml(s.runFormatted)+'</div>'+
      '</div>'+
      '<div style="padding:12px;background:rgba(56,239,125,.08);border:1px solid rgba(56,239,125,.35);border-radius:12px;text-align:center">'+
        '<div style="color:#9a9aab;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Sent</div>'+
        '<div style="color:#38ef7d;font-size:22px;font-weight:900;text-shadow:0 0 12px rgba(56,239,125,.5)">'+(s.sent||0)+'</div>'+
      '</div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">'+
      '<div style="padding:10px;background:rgba(255,60,60,.08);border:1px solid rgba(255,60,60,.3);border-radius:10px;text-align:center">'+
        '<div style="color:#9a9aab;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px">Failed</div>'+
        '<div style="color:#ff6b6b;font-size:18px;font-weight:900">'+(s.failed||0)+'</div>'+
      '</div>'+
      '<div style="padding:10px;background:rgba(255,180,0,.08);border:1px solid rgba(255,180,0,.3);border-radius:10px;text-align:center">'+
        '<div style="color:#9a9aab;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px">Cycles</div>'+
        '<div style="color:#ffd655;font-size:18px;font-weight:900">'+(s.cycles||0)+'</div>'+
      '</div>'+
      '<div style="padding:10px;background:rgba(107,198,255,.08);border:1px solid rgba(107,198,255,.3);border-radius:10px;text-align:center">'+
        '<div style="color:#9a9aab;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px">Targets</div>'+
        '<div style="color:#6bc6ff;font-size:18px;font-weight:900">'+(s.totalTargets||0)+'</div>'+
      '</div>'+
    '</div>'+
    '<div style="padding:10px 12px;background:rgba(5,5,10,.65);border:1px solid rgba(255,0,60,.22);border-radius:10px;margin-bottom:14px;font-size:11px;color:#9a9aab">'+
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>▶ Started:</span><span style="color:#f1f1f6">'+new Date(s.startedAt).toLocaleString()+'</span></div>'+
      '<div style="display:flex;justify-content:space-between"><span>⏹ Stopped:</span><span style="color:#f1f1f6">'+new Date(s.stoppedAt).toLocaleString()+'</span></div>'+
    '</div>'+
    '<div style="padding:10px 12px;background:rgba(107,198,255,.06);border:1px solid rgba(107,198,255,.25);border-radius:10px;margin-bottom:14px;font-size:12px;color:#6bc6ff;display:flex;justify-content:space-between">'+
      '<span>📨 Total Messages in Queue:</span><span style="color:#fff;font-weight:700">'+(s.totalMessages||0)+'</span>'+
    '</div>'+
    (targetsHtml?'<div style="margin-bottom:14px"><div style="color:#9a9aab;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">📍 Ran On ('+s.targets.length+' targets):</div><div style="max-height:220px;overflow-y:auto;padding-right:4px;border:1px solid rgba(255,0,60,.15);border-radius:10px;padding:8px;background:rgba(0,0,0,.3)">'+targetsHtml+'</div></div>':'<div style="padding:14px;text-align:center;color:#6b6b7a;font-size:12px">No targets recorded</div>')+
    '<button onclick="document.getElementById(\\'stopSummaryOverlay\\').remove()" style="width:100%;padding:13px;background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;border-radius:12px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 8px 24px rgba(255,0,60,.35)">Close</button>';
  
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

let bulkSelected=new Set();

async function fetchGroupsForBulk(){
  const pairedSessions = allSessions.filter(s => s.paired);
  if(!pairedSessions.length){alert('Pehle WhatsApp pair karo');return;}
  const sid = pairedSessions[0].id;
  const listEl=document.getElementById('bulkGroupsList');
  listEl.innerHTML='<div class="empty">Loading...</div>';
  try{
    const res=await fetch('/api/groups?sessionId='+sid);
    const d=await res.json();
    if(!d.success)throw new Error(d.error||'Failed');
    currentSessionGroups=d.groups||[];
    renderBulkGroups();
    log('info','Fetched '+currentSessionGroups.length+' groups');
  }catch(e){listEl.innerHTML='<div class="empty" style="color:#ff6b6b">'+escapeHtml(e.message)+'</div>';}
}

function renderBulkGroups(){
  const listEl=document.getElementById('bulkGroupsList');
  document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';
  if(!currentSessionGroups.length){listEl.innerHTML='<div class="empty">No groups</div>';return;}
  listEl.innerHTML=currentSessionGroups.map(g=>{
    const sel=bulkSelected.has(g.id)?' selected':'';
    const checked=bulkSelected.has(g.id)?' checked':'';
    return '<label class="group-item'+sel+'" data-jid="'+escapeHtml(g.id)+'"><input type="checkbox"'+checked+' onchange="toggleBulkGroup(\\''+escapeHtml(g.id)+'\\',this.checked)"/><div class="group-info"><div class="group-name">'+escapeHtml(g.name||'(no name)')+'</div><div class="group-jid">'+escapeHtml(g.id)+'</div></div></label>';
  }).join('');
}
function toggleBulkGroup(jid,checked){
  if(checked)bulkSelected.add(jid);else bulkSelected.delete(jid);
  document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';
  document.querySelectorAll('#bulkGroupsList .group-item').forEach(el=>{if(el.dataset.jid===jid)el.classList.toggle('selected',checked);});
}
function selectAllBulkGroups(){currentSessionGroups.forEach(g=>bulkSelected.add(g.id));renderBulkGroups();}
function clearBulkGroups(){bulkSelected.clear();renderBulkGroups();}

document.getElementById('fileInput').addEventListener('change',(e)=>{
  const f=e.target.files[0];
  document.getElementById('fileHint').textContent=f?f.name:'No file chosen';
});

async function startServer(){
  const pairedSessions = allSessions.filter(s => s.paired);
  if(!pairedSessions.length){
    alert('❌ Koi WhatsApp number paired nahi hai. Pehle Dashboard se pair karo.');
    return;
  }
  const sid = pairedSessions[0].id;
  
  const file=document.getElementById('fileInput').files[0];
  if(!file){alert('Message file upload karo');return;}
  const hasGroups=bulkSelected.size>0;
  const numsRaw=document.getElementById('numbersInput').value.trim();
  const hasNums=numsRaw.length>0;
  if(!hasGroups&&!hasNums){alert('Koi group select karo ya number daalo');return;}
  
  let delay=parseInt(document.getElementById('delayInput').value)||10;if(delay<3)delay=3;
  const startBtn=document.getElementById('startBtn');
  startBtn.disabled=true;startBtn.textContent='Starting...';
  
  const fd=new FormData();
  fd.append('file',file);
  fd.append('sessionId',sid);
  fd.append('groupIds',JSON.stringify([...bulkSelected]));
  fd.append('numbers',numsRaw);
  fd.append('hater',document.getElementById('haterInput').value.trim());
  fd.append('lastHater',document.getElementById('lastHaterInput').value.trim());
  fd.append('delay',String(delay));
  
  try{
    const res=await fetch('/api/bulk/start',{method:'POST',body:fd});
    const d=await res.json();
    if(!d.success)throw new Error(d.error||'Failed');
    log('ok','Bulk started — '+d.total+' msgs, '+d.totalTargets+' targets');
    setTimeout(refreshSessions, 1000);
  }catch(e){log('err','Start failed: '+e.message);alert('Start failed: '+e.message);}
  finally{startBtn.disabled=false;startBtn.textContent='▶ Start Bulk';}
}

let lastLogId=0;
async function pollStats(){
  try{
    const res=await fetch('/api/bulk/status-all');
    const d=await res.json();
    document.getElementById('statUptime').textContent=d.uptimeFormatted||'00:00:00';
    const pairedSessions = allSessions.filter(s => s.paired);
    if(pairedSessions.length){
      const sid = pairedSessions[0].id;
      const sess=d.sessions.find(s=>s.id===sid);
      if(sess){
        const b=sess.bulk||{};
        document.getElementById('statStatus').textContent=b.running?'Running':'Idle';
        document.getElementById('statStatus').style.color=b.running?'#38ef7d':'#fff';
        document.getElementById('statSent').textContent=b.sent||0;
        document.getElementById('statFailed').textContent=b.failed||0;
        document.getElementById('statCycle').textContent=b.cycle||0;
        document.getElementById('statTargets').textContent=b.totalTargets||0;
        document.getElementById('statRemaining').textContent=b.remaining||0;
        document.getElementById('statCurTarget').textContent=(b.currentTarget||'—').slice(0,25);
        const pct=(b.total&&b.total>0)?Math.round(((b.total-b.remaining)/b.total)*100):0;
        document.getElementById('statProgress').textContent=pct+'%';
        document.getElementById('progBar').style.width=pct+'%';
      }
    }
    if(d.logs&&d.logs.length){
      const box=document.getElementById('logBox');
      d.logs.forEach(l=>{
        if(l.id>lastLogId){
          const el=document.createElement('div');el.className='line '+(l.type||'info');
          el.innerHTML='<span class="t">['+new Date(l.ts).toLocaleTimeString()+']</span>'+escapeHtml(l.msg);
          box.appendChild(el);
        }
      });
      lastLogId=d.logs[d.logs.length-1].id;
      box.scrollTop=box.scrollHeight;
      while(box.children.length>500)box.removeChild(box.firstChild);
    }
  }catch(e){}
}

setInterval(refreshSessions,3000);
setInterval(pollStats,1500);
refreshSessions();
pollStats();
</script>
</body>
</html>`;

// ============================================================
// Express app
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
      html = html.replace('__LOGO_DATA__', 'data:image/jpeg;base64,' + b64);
      console.log('✅ Logo embedded (' + Math.round(b64.length / 1024) + ' KB)');
    } else {
      console.log('⚠ logo.jpg not found');
      html = html.replace('__LOGO_DATA__', '');
    }
  } catch (e) { html = html.replace('__LOGO_DATA__', ''); }
  FINAL_HTML = html;
  return FINAL_HTML;
}

app.get('/', (req, res) => res.type('html').send(buildHtmlWithLogo()));

const upload = multer({ dest: 'uploads/' });

// ===== SESSIONS =====
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: getAllSessionsInfo() });
});

app.post('/api/pair', async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    const sid = String(sessionId || '1');
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone' });
    let sess = getSession(sid);
    if (!sess) { sess = createSessionState(sid); sessions.set(sid, sess); }
    if (sess.isPaired) return res.status(400).json({ success: false, error: 'Already paired' });
    if (sess.isConnecting) return res.status(400).json({ success: false, error: 'Already connecting' });
    if (fs.existsSync(sess.authDir)) fs.rmSync(sess.authDir, { recursive: true, force: true });
    connectSession(sid, phone).catch((e) => { sess.lastError = e.message; });
    res.json({ success: true, sessionId: sid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    const { sessionId, password } = req.body || {};
    if (password !== serverPassword) return res.status(401).json({ success: false, error: '🔐 Wrong password' });
    const sid = String(sessionId || '1');
    const sess = getSession(sid);
    if (!sess) return res.status(400).json({ success: false, error: 'Session not found' });
    if (sess.bulk && sess.bulk.running) sess.bulk.stopFlag = true;
    if (sess.sock) { try { await sess.sock.logout(); } catch (_) {} }
    if (fs.existsSync(sess.authDir)) fs.rmSync(sess.authDir, { recursive: true, force: true });
    sessions.delete(sid);
    pushLog('warn', `[S${sid}] Logged out`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/groups', async (req, res) => {
  try {
    const sid = String(req.query.sessionId || '1');
    const sess = getSession(sid);
    if (!sess || !sess.isPaired || !sess.sock) return res.status(400).json({ success: false, error: 'Session not paired' });
    const map = new Map();
    Object.values(sess.groupsCache).forEach((g) => map.set(g.id, g));
    try {
      if (sess.sock.store && sess.sock.store.groupMetadata) {
        sess.sock.store.groupMetadata.forEach((v) => {
          if (!map.has(v.id)) map.set(v.id, { id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 });
        });
      }
    } catch (_) {}
    if (map.size === 0 && typeof sess.sock.groupFetchAllParticipating === 'function') {
      try {
        const all = await sess.sock.groupFetchAllParticipating();
        Object.values(all).forEach((g) => map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }));
      } catch (_) {}
    }
    const groups = [...map.values()].filter((g) => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach((g) => { sess.groupsCache[g.id] = g; });
    res.json({ success: true, groups });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== BULK START =====
app.post('/api/bulk/start', upload.single('file'), async (req, res) => {
  try {
    const sid = String((req.body && req.body.sessionId) || '1');
    const sess = getSession(sid);
    if (!sess || !sess.isPaired || !sess.sock) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ success: false, error: 'Session not paired' });
    }
    if (sess.bulk && sess.bulk.running) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ success: false, error: 'Task already running' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Upload .txt file' });

    const { groupIds, numbers, hater, lastHater, delay } = req.body;

    let messages = [];
    try { messages = parseMessagesFile(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });

    let parsedGroups = [];
    try { parsedGroups = JSON.parse(groupIds || '[]'); } catch (_) {}

    const targets = []; const seen = new Set();

    parsedGroups.forEach((jid) => {
      if (!jid || seen.has(jid)) return;
      seen.add(jid);
      const meta = sess.groupsCache[jid];
      targets.push({ jid, label: meta && meta.name ? `[G] ${meta.name}` : `[G] ${jid}` });
    });

    const numberTargets = parseNumbers(numbers || '');
    numberTargets.forEach((n) => {
      if (seen.has(n.jid)) return;
      seen.add(n.jid);
      targets.push({ jid: n.jid, label: n.label });
    });

    if (!targets.length) return res.status(400).json({ success: false, error: 'No targets' });

    let delaySec = parseInt(delay) || DEFAULT_DELAY_SECONDS;
    if (delaySec < MIN_DELAY_SECONDS) delaySec = MIN_DELAY_SECONDS;
    const waitMs = delaySec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const preparedMessages = messages.map((m) => prefix + m + suffix);

    sess.bulk = {
      running: true, stopFlag: false,
      sent: 0, failed: 0, blocked: 0,
      total: messages.length, remaining: messages.length,
      cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: targets.length,
      currentMessage: '', currentTarget: '',
      targets, messages: preparedMessages, delayMs: waitMs,
      workerAlive: false, lastBeat: Date.now(), startedAt: Date.now(),
    };

    const groupCount = targets.filter((t) => t.jid.endsWith('@g.us')).length;
    const numCount = targets.length - groupCount;
    pushLog('info', `[S${sid}] Task started — ${messages.length} msgs × ${targets.length} targets`);

    runWorker(sess);

    res.json({
      success: true, total: messages.length, totalTargets: targets.length,
      groups: groupCount, numbers: numCount, blocked: 0,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

// ===== BULK STOP (with summary) =====
app.post('/api/bulk/stop', (req, res) => {
  const { sessionId, password } = req.body || {};
  if (password !== serverPassword) {
    return res.status(401).json({ success: false, error: '🔐 Wrong password' });
  }
  const sid = String(sessionId || '1');
  const sess = getSession(sid);
  if (!sess || !sess.bulk || !sess.bulk.running) {
    return res.status(400).json({ success: false, error: 'No task running' });
  }
  
  const b = sess.bulk;
  const stoppedAt = Date.now();
  const runMs = b.startedAt ? (stoppedAt - b.startedAt) : 0;
  
  const targetsSummary = (b.targets || []).map(t => ({
    label: t.label,
    jid: t.jid,
    type: t.jid.endsWith('@g.us') ? 'group' : 'number',
  }));
  
  const summary = {
    sessionId: sid,
    phone: maskPhone(sess.phone),
    startedAt: b.startedAt,
    stoppedAt: stoppedAt,
    runMs: runMs,
    runFormatted: formatDuration(runMs),
    totalMessages: b.messages ? b.messages.length : 0,
    totalTargets: b.targets ? b.targets.length : 0,
    sent: b.sent || 0,
    failed: b.failed || 0,
    blocked: b.blocked || 0,
    cycles: b.cycle || 0,
    currentMessage: b.currentMessage || '',
    targets: targetsSummary,
  };
  
  sess.lastStopSummary = summary;
  b.stopFlag = true;
  
  pushLog('warn', `[S${sid}] 🔐 Stopped — Ran: ${summary.runFormatted}, Sent: ${b.sent}, Failed: ${b.failed}, Cycles: ${b.cycle}`);
  
  res.json({ success: true, summary });
});

app.get('/api/bulk/status-all', (req, res) => {
  const out = getAllSessionsInfo().map((s) => {
    const sess = getSession(s.id);
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
  res.json({ sessions: out, uptimeFormatted: formatUptime(Date.now() - serverStartTime), logs: logs.list.slice(-200) });
});

// ===== PASSWORD MANAGEMENT =====
app.post('/api/password/set', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (currentPassword !== serverPassword) {
      return res.status(401).json({ success: false, error: '🔐 Current password wrong' });
    }
    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ success: false, error: 'New password min 4 chars' });
    }
    serverPassword = String(newPassword);
    try { fs.writeFileSync(PASSWORD_FILE, JSON.stringify({ password: serverPassword })); } catch (_) {}
    pushLog('warn', '🔐 Server password changed');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

// ============================================================
// TELEGRAM BOT
// ============================================================
function initTelegramBot() {
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes('YAHAN')) { console.log('⚠ TG token not set'); return; }
  if (!TELEGRAM_OWNER_ID || TELEGRAM_OWNER_ID.includes('YAHAN')) { console.log('⚠ TG owner ID not set'); return; }
  const TelegramBot = require('node-telegram-bot-api');
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('🤖 Telegram bot started');
  const isOwner = (msg) => String(msg.chat.id) === String(TELEGRAM_OWNER_ID);
  const send = (chatId, text) => { try { tgBot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch (_) {} };

  tgBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!isOwner(msg)) { send(chatId, '🚫 Unauthorized'); return; }
    if (!text) return;
    const [cmd, ...rest] = text.split(/\s+/);
    const args = rest.join(' ');
    try {
      switch (cmd.toLowerCase()) {
        case '/start':
        case '/help':
          send(chatId, '*RK RAJA XWD Bot*\n\n/status — Status\n/sessions — Paired numbers\n/msg <num> <text> — Send\n/stop <sid> <password>');
          break;
        case '/status': {
          const sess = getAllSessionsInfo();
          let s = `📊 *Status*\n\nSessions: ${sess.length}\n`;
          sess.forEach(x => { s += `• S${x.id}: ${x.paired?'✅ '+x.phoneMasked:'❌'}\n`; });
          send(chatId, s);
          break;
        }
        case '/sessions': {
          const ss = getAllSessionsInfo();
          if (!ss.length) { send(chatId, 'No sessions'); break; }
          let txt = '*Sessions:*\n\n';
          ss.forEach(x => { txt += `S${x.id} — ${x.paired?'✅ '+x.phoneMasked:'❌'}\n`; });
          send(chatId, txt);
          break;
        }
        case '/msg': {
          const m = args.match(/^(\d+)\s+([\s\S]+)$/);
          if (!m) { send(chatId, 'Usage: /msg <number> <text>'); break; }
          const sess1 = getAllSessionsInfo().find(x => x.paired);
          if (!sess1) { send(chatId, 'No paired session'); break; }
          const s1 = getSession(sess1.id);
          try { await s1.sock.sendMessage(m[1]+'@s.whatsapp.net', {text: m[2]}); send(chatId, '✅ Sent to +'+m[1]); }
          catch(e) { send(chatId, '❌ '+e.message); }
          break;
        }
        case '/stop': {
          const parts = args.trim().split(/\s+/);
          const sid = parts[0] || '1';
          const pwd = parts.slice(1).join(' ');
          if (!pwd) { send(chatId, 'Usage: /stop <sid> <password>'); break; }
          if (pwd !== serverPassword) { send(chatId, '🔐 Wrong password'); break; }
          const sessStop = getSession(sid);
          if (sessStop && sessStop.bulk && sessStop.bulk.running) { sessStop.bulk.stopFlag = true; send(chatId, '🛑 Stopped S'+sid); }
          else send(chatId, 'No task on S'+sid);
          break;
        }
        default: send(chatId, 'Unknown command');
      }
    } catch (e) { send(chatId, '❌ '+e.message); }
  });
  tgBot.on('polling_error', (err) => console.error('[TG]', err.message));
}

app.listen(PORT, HOST, async () => {
  console.log('\n🟢 RK RAJA XWD — Server running');
  console.log('🌐 Dashboard: http://' + HOST + ':' + PORT + '/\n');
  pushLog('info', 'Server started — RK RAJA XWD');
  initTelegramBot();
  await autoLoadSessions();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
