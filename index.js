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

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8592499421:AAF066PLyHaizP6NsWwwm7uOOV32pJqwSFE';
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || '@RKRAJA7065';
let tgBot = null;

const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

let serverStartTime = Date.now();

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
  };
}

function getSession(sid) {
  if (sid === undefined || sid === null) sid = '1';
  return sessions.get(String(sid));
}

function getAllSessionsInfo() {
  const out = [];
  sessions.forEach((s) => {
    out.push({
      id: s.id,
      phone: s.phone,
      paired: s.isPaired,
      connecting: s.isConnecting,
      code: s.isPaired ? null : s.pairingCode,
      connectedAt: s.connectedAt,
      error: s.lastError,
      groupCount: Object.keys(s.groupsCache).length,
      bulkRunning: s.bulk ? s.bulk.running : false,
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

function parseBlacklist(raw) {
  const set = new Set();
  if (!raw) return set;
  String(raw).split(/[\r\n,;\s]+/).forEach((tok) => {
    const jid = normalizeJid(tok);
    if (jid) set.add(jid);
  });
  return set;
}

async function groupHasBlockedMember(sess, jid, blockedNumbersJids) {
  try {
    if (!sess || !sess.sock || !blockedNumbersJids || blockedNumbersJids.size === 0) return false;
    const meta = await sess.sock.groupMetadata(jid);
    if (!meta || !Array.isArray(meta.participants)) return false;
    for (const p of meta.participants) {
      let pid = p.id || '';
      if (!pid) continue;
      const numPart = pid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
      if (!numPart) continue;
      const normalizedJid = numPart + '@s.whatsapp.net';
      if (blockedNumbersJids.has(normalizedJid)) return true;
    }
    return false;
  } catch (_) { return false; }
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
      pushLog('info', `[S${sess.id}] Stopped — Sent: ${b.sent}, Failed: ${b.failed}, Blocked: ${b.blocked}, Cycles: ${b.cycle}`);
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
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#021007;color:#e2f5e8;min-height:100vh;overflow-x:hidden;position:relative}
  body::before{content:"";position:fixed;inset:-50px;z-index:-3;background-image:url('__LOGO_DATA__');background-size:cover;background-position:center center;background-repeat:no-repeat;filter:blur(10px) brightness(0.4);opacity:0.55}
  body::after{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(1200px 800px at 15% 10%, rgba(0,255,136,.18), transparent 60%),radial-gradient(900px 600px at 85% 90%, rgba(0,255,136,.14), transparent 65%),linear-gradient(135deg, rgba(2,16,7,.75) 0%, rgba(4,26,16,.6) 55%, rgba(2,16,7,.75) 100%);pointer-events:none}
  .streaks{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
  .streaks span{position:absolute;height:1px;width:220px;left:-30%;background:linear-gradient(90deg,transparent,#00ff88,transparent);filter:drop-shadow(0 0 6px #00ff88);opacity:.55;animation:streak 7s linear infinite}
  .streaks span:nth-child(2){top:25%;animation-delay:1.5s;animation-duration:9s}
  .streaks span:nth-child(3){top:55%;animation-delay:3s;animation-duration:8s}
  .streaks span:nth-child(4){top:78%;animation-delay:4.5s;animation-duration:10s}
  @keyframes streak{from{transform:translateX(0) rotate(-12deg)}to{transform:translateX(160vw) rotate(-12deg)}}
  .container{max-width:1180px;margin:0 auto;padding:28px 18px 60px;position:relative;z-index:1}
  .brand{text-align:center;margin-bottom:26px}
  .brand h1{font-size:clamp(22px,4vw,40px);font-weight:900;letter-spacing:4px;background:linear-gradient(180deg,#ffffff 0%,#c9ffdc 45%,#00ff88 130%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 26px rgba(0,255,136,.45);font-family:"Orbitron","Rajdhani",sans-serif;text-transform:uppercase}
  .brand h1 .x{color:#00ff88;-webkit-text-fill-color:#00ff88;text-shadow:0 0 18px #00ff88}
  .brand p{color:#6e9c7e;font-size:11px;letter-spacing:3px;margin-top:6px;text-transform:uppercase}
  .tabs{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;justify-content:center}
  .tab{padding:11px 20px;border-radius:12px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(0,255,136,.35);background:rgba(0,255,136,.05);color:#4be896;transition:.2s}
  .tab.active{background:linear-gradient(180deg,#00ff88,#00a854);color:#021007;border-color:#00ff88;box-shadow:0 8px 24px rgba(0,255,136,.35)}
  .tab:hover:not(.active){background:rgba(0,255,136,.12)}
  .panel{display:none}.panel.active{display:block}
  .layout{display:grid;grid-template-columns:420px 1fr;gap:20px}
  @media(max-width:900px){.layout{grid-template-columns:1fr}}
  .card{position:relative;background:linear-gradient(155deg, rgba(20,30,24,.85), rgba(8,18,12,.7));border:1px solid rgba(0,255,136,.28);border-radius:18px;padding:24px;margin-bottom:20px;backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)}
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase}
  .card h2 .dot{width:8px;height:8px;border-radius:50%;background:#00ff88;box-shadow:0 0 12px #00ff88}
  label{display:block;font-size:11px;color:#8fbca0;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:rgba(2,16,7,.75);border:1px solid rgba(0,255,136,.25);border-radius:12px;padding:12px 14px;color:#eaffef;font-size:14px;font-family:inherit;outline:none;transition:.25s}
  input:focus,textarea:focus,select:focus{border-color:#00ff88;box-shadow:0 0 0 3px rgba(0,255,136,.14)}
  input:disabled{color:#4a6a55}
  textarea{resize:vertical;min-height:80px}
  .field{margin-bottom:14px}
  button{background:linear-gradient(180deg,#00ff88,#00a854);color:#021007;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:.22s;margin-top:6px;width:100%;box-shadow:0 8px 24px rgba(0,255,136,.28)}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 30px rgba(0,255,136,.45)}
  button:disabled{background:#1a2a22;color:#4a6a55;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid rgba(0,255,136,.5);color:#4be896;box-shadow:none}
  button.ghost:hover:not(:disabled){background:rgba(0,255,136,.1)}
  button.danger{background:linear-gradient(180deg,#ff4040,#a80000);color:#fff;border:1px solid #ff4040}
  .btnrow{display:flex;gap:10px}.btnrow button{margin-top:0}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .code-box{background:rgba(2,16,7,.85);border:2px dashed #00ff88;border-radius:16px;padding:20px;margin:14px 0;text-align:center}
  .code-value{font-size:32px;font-weight:900;letter-spacing:8px;color:#00ff88;font-family:'Courier New',monospace;text-shadow:0 0 24px rgba(0,255,136,.7)}
  .code-label{font-size:11px;color:#8fbca0;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase}
  .steps{background:rgba(2,16,7,.6);border:1px solid rgba(0,255,136,.18);border-radius:12px;padding:14px;font-size:12px;line-height:1.8;color:#c3e8ce}
  .msg{margin-top:14px;padding:12px 15px;border-radius:10px;font-size:13px;display:none}
  .msg.ok{background:rgba(0,255,136,.1);color:#7ff5b3;border:1px solid rgba(0,255,136,.4);display:block}
  .msg.err{background:rgba(255,80,80,.1);color:#ffa1a1;border:1px solid rgba(255,80,80,.4);display:block}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:520px){.grid2{grid-template-columns:1fr}}
  .stat{background:rgba(2,16,7,.7);border:1px solid rgba(0,255,136,.2);border-radius:14px;padding:14px;text-align:center}
  .stat .k{font-size:10px;color:#8fbca0;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .stat .v{font-size:20px;font-weight:900;color:#fff;word-break:break-all}
  .stat .v.green{color:#00ff88}
  .stat .v.red{color:#ff5252}
  .stat .v.small{font-size:14px;font-weight:700}
  .statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
  @media(max-width:520px){.statgrid{grid-template-columns:1fr 1fr}}
  .log{background:#000;border:1px solid rgba(0,255,136,.25);border-radius:14px;padding:14px;height:340px;overflow-y:auto;font-family:'Courier New',monospace;font-size:12px;line-height:1.75}
  .log::-webkit-scrollbar{width:8px}.log::-webkit-scrollbar-track{background:#04120a}.log::-webkit-scrollbar-thumb{background:#00ff88;border-radius:8px}
  .log .line{color:#8fbca0;border-bottom:1px dashed rgba(255,255,255,.04);padding:2px 0;word-break:break-all}
  .log .t{color:#4be896;margin-right:8px}
  .log .ok{color:#00ff88}.log .err{color:#ff6b6b}.log .info{color:#7fd0ff}.log .warn{color:#ffd655}
  .progress{height:8px;background:rgba(2,16,7,.8);border-radius:99px;overflow:hidden;border:1px solid rgba(0,255,136,.25);margin-top:12px}
  .progress>div{height:100%;width:0%;background:linear-gradient(90deg,#00ff88,#4be896,#00ff88);transition:width .4s ease}
  .groups-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .groups-toolbar button{width:auto;margin-top:0;padding:10px 16px;font-size:11px}
  .groups-toolbar .count{font-size:12px;color:#8fbca0;margin-left:auto}
  .groups-list{background:rgba(2,16,7,.6);border:1px solid rgba(0,255,136,.2);border-radius:14px;max-height:360px;overflow-y:auto;padding:8px}
  .group-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid transparent}
  .group-item:hover{background:rgba(0,255,136,.08)}
  .group-item.selected{background:rgba(0,255,136,.14);border-color:#00ff88}
  .group-item input[type=checkbox]{width:18px;height:18px;accent-color:#00ff88;cursor:pointer;flex-shrink:0}
  .group-info{flex:1;min-width:0}
  .group-name{color:#eaffef;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .group-jid{color:#4a6a55;font-size:11px;font-family:'Courier New',monospace;margin-top:2px}
  .hidden{display:none!important}
  .hint{font-size:11px;color:#4a6a55;margin-top:8px}
  .empty{padding:30px;text-align:center;color:#4a6a55;font-size:13px}
  .footer{text-align:center;color:#2f4a3a;font-size:11px;letter-spacing:3px;margin-top:30px;text-transform:uppercase}
  .session-item{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(2,16,7,.7);border:1px solid rgba(0,255,136,.25);border-radius:12px;margin-bottom:8px}
  .session-item.active{border-color:#00ff88;background:rgba(0,255,136,.08)}
  .session-info{flex:1;min-width:0}
  .session-name{color:#eaffef;font-size:13px;font-weight:700}
  .session-phone{color:#4be896;font-size:11px;font-family:'Courier New',monospace;margin-top:2px}
  .session-actions button{width:auto;padding:6px 12px;font-size:10px;margin:0}
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
      <h2><span class="dot"></span>Live Stats</h2>
      <div class="statgrid">
        <div class="stat"><div class="k">Total Sessions</div><div class="v green" id="statSessions">0</div></div>
        <div class="stat"><div class="k">Paired</div><div class="v green" id="statPaired">0</div></div>
        <div class="stat"><div class="k">Uptime</div><div class="v green" id="statUptime">00:00:00</div></div>
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
          <h2><span class="dot"></span>📤 Send From</h2>
          <div class="field">
            <label>Select Session</label>
            <select id="sessionSelect"><option value="">-- No sessions --</option></select>
            <div class="hint">Kis WhatsApp number se bhejna hai wo select karo</div>
          </div>
        </div>

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

          <div class="field" style="border-top:1px dashed rgba(255,80,80,.35);padding-top:14px">
            <label style="color:#ff8888">🚫 Block Numbers</label>
            <textarea id="userBlockInput" placeholder="919876543210&#10;918765432109&#10;917654321098"></textarea>
            <div class="hint" style="color:#ff8888">Ye numbers skip. Agar group me member hai to group bhi skip.</div>
            <div id="userBlockPreview" style="margin-top:6px"></div>
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
            <button id="stopBtn" class="danger" onclick="stopTask()" disabled>■ Stop</button>
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
            <div class="stat"><div class="k">Blocked</div><div class="v red" id="statBlocked">0</div></div>
            <div class="stat"><div class="k">Targets</div><div class="v" id="statTargets">0</div></div>
            <div class="stat"><div class="k">Cycle</div><div class="v" id="statCycle">0</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Current</div><div class="v small" id="statCurTarget">—</div></div>
            <div class="stat"><div class="k">Remaining</div><div class="v" id="statRemaining">0</div></div>
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
    renderSessionDropdown();
    document.getElementById('statSessions').textContent=allSessions.length;
    document.getElementById('statPaired').textContent=allSessions.filter(s=>s.paired).length;
  }catch(e){}
}

function renderSessions(){
  const listEl=document.getElementById('sessionsList');
  if(!allSessions.length){listEl.innerHTML='<div class="empty">No sessions yet. Add a number above.</div>';return;}
  listEl.innerHTML=allSessions.map(s=>{
    const cls=s.paired?'session-item active':'session-item';
    let statusBadge = s.paired ? '✅ Paired' : (s.connecting ? '⏳ Connecting' : (s.code ? '🔑 Code: '+s.code : '❌ Idle'));
    let phoneTxt = s.phone || '—';
    let groupsTxt = s.paired ? (s.groupCount+' groups') : '';
    return '<div class="'+cls+'">'+
      '<div class="session-info">'+
        '<div class="session-name">Session '+escapeHtml(s.id)+' — '+escapeHtml(phoneTxt)+'</div>'+
        '<div class="session-phone">'+statusBadge+(groupsTxt?' | '+groupsTxt:'')+'</div>'+
      '</div>'+
      '<div class="session-actions">'+
        (s.paired?'<button class="ghost" onclick="logoutSession(\\''+escapeHtml(s.id)+'\\')">Logout</button>':'')+
      '</div>'+
    '</div>';
  }).join('');
}

function renderSessionDropdown(){
  const sel=document.getElementById('sessionSelect');
  const pairedSessions=allSessions.filter(s=>s.paired);
  if(!pairedSessions.length){sel.innerHTML='<option value="">-- No paired sessions --</option>';return;}
  const oldVal=sel.value;
  sel.innerHTML=pairedSessions.map(s=>'<option value="'+escapeHtml(s.id)+'">Session '+escapeHtml(s.id)+' — '+escapeHtml(s.phone||'')+'</option>').join('');
  if(oldVal && pairedSessions.some(s=>s.id===oldVal)) sel.value=oldVal;
}

async function logoutSession(sid){
  if(!confirm('Logout Session '+sid+'?'))return;
  try{await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid})});refreshSessions();}catch(e){alert(e.message);}
}

let bulkSelected=new Set();

async function fetchGroupsForBulk(){
  const sid=document.getElementById('sessionSelect').value;
  if(!sid){alert('Pehle session select karo');return;}
  const listEl=document.getElementById('bulkGroupsList');
  listEl.innerHTML='<div class="empty">Loading...</div>';
  try{
    const res=await fetch('/api/groups?sessionId='+sid);
    const d=await res.json();
    if(!d.success)throw new Error(d.error||'Failed');
    currentSessionGroups=d.groups||[];
    renderBulkGroups();
    log('info','Fetched '+currentSessionGroups.length+' groups from Session '+sid);
  }catch(e){listEl.innerHTML='<div class="empty" style="color:#ff8888">'+escapeHtml(e.message)+'</div>';}
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

function updateBlockPreview(){
  const raw=document.getElementById('userBlockInput').value||'';
  const nums=[];const seen=new Set();
  raw.split(/[\\r\\n,;\\s]+/).forEach(tok=>{const t=tok.trim();if(!t)return;if(seen.has(t))return;seen.add(t);nums.push(t);});
  const box=document.getElementById('userBlockPreview');
  if(!nums.length){box.innerHTML='';return;}
  box.innerHTML='<span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;background:rgba(255,80,80,.15);color:#ff8888;border:1px solid rgba(255,80,80,.4);margin:2px 4px;font-family:monospace">🚫 '+nums.length+' numbers blocked</span>';
}
document.getElementById('userBlockInput').addEventListener('input',updateBlockPreview);

async function startServer(){
  const sid=document.getElementById('sessionSelect').value;
  if(!sid){alert('Pehle session select karo');return;}
  const file=document.getElementById('fileInput').files[0];
  if(!file){alert('Message file upload karo');return;}
  const hasGroups=bulkSelected.size>0;
  const numsRaw=document.getElementById('numbersInput').value.trim();
  const hasNums=numsRaw.length>0;
  if(!hasGroups&&!hasNums){alert('Koi group select karo ya number daalo');return;}
  
  let delay=parseInt(document.getElementById('delayInput').value)||10;if(delay<3)delay=3;
  const startBtn=document.getElementById('startBtn');const stopBtn=document.getElementById('stopBtn');
  startBtn.disabled=true;startBtn.textContent='Starting...';
  
  const fd=new FormData();
  fd.append('file',file);
  fd.append('sessionId',sid);
  fd.append('groupIds',JSON.stringify([...bulkSelected]));
  fd.append('numbers',numsRaw);
  fd.append('hater',document.getElementById('haterInput').value.trim());
  fd.append('lastHater',document.getElementById('lastHaterInput').value.trim());
  fd.append('delay',String(delay));
  fd.append('userBlock',document.getElementById('userBlockInput').value.trim());
  
  try{
    const res=await fetch('/api/bulk/start',{method:'POST',body:fd});
    const d=await res.json();
    if(!d.success)throw new Error(d.error||'Failed');
    log('ok','Bulk started — '+d.total+' msgs, '+d.totalTargets+' targets');
    stopBtn.disabled=false;
  }catch(e){log('err','Start failed: '+e.message);alert('Start failed: '+e.message);}
  finally{startBtn.disabled=false;startBtn.textContent='▶ Start Bulk';}
}

async function stopTask(){
  const sid=document.getElementById('sessionSelect').value;
  if(!sid){alert('Session select karo');return;}
  try{await fetch('/api/bulk/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid})});}catch(e){alert(e.message);}
}

let lastLogId=0;
async function pollStats(){
  try{
    const res=await fetch('/api/bulk/status-all');
    const d=await res.json();
    document.getElementById('statUptime').textContent=d.uptimeFormatted||'00:00:00';
    const sid=document.getElementById('sessionSelect').value;
    if(sid){
      const sess=d.sessions.find(s=>s.id===sid);
      if(sess){
        const b=sess.bulk||{};
        document.getElementById('statStatus').textContent=b.running?'Running':'Idle';
        document.getElementById('statStatus').style.color=b.running?'#00ff88':'#fff';
        document.getElementById('statSent').textContent=b.sent||0;
        document.getElementById('statFailed').textContent=b.failed||0;
        document.getElementById('statBlocked').textContent=b.blocked||0;
        document.getElementById('statTargets').textContent=b.totalTargets||0;
        document.getElementById('statCycle').textContent=b.cycle||0;
        document.getElementById('statRemaining').textContent=b.remaining||0;
        document.getElementById('statCurTarget').textContent=(b.currentTarget||'—').slice(0,25);
        const pct=(b.total&&b.total>0)?Math.round(((b.total-b.remaining)/b.total)*100):0;
        document.getElementById('statProgress').textContent=pct+'%';
        document.getElementById('progBar').style.width=pct+'%';
        const startBtn=document.getElementById('startBtn');const stopBtn=document.getElementById('stopBtn');
        if(b.running){startBtn.disabled=true;stopBtn.disabled=false;}else{startBtn.disabled=false;stopBtn.disabled=true;}
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
    const { sessionId } = req.body;
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

    const { groupIds, numbers, hater, lastHater, delay, userBlock } = req.body;

    let messages = [];
    try { messages = parseMessagesFile(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });

    let parsedGroups = [];
    try { parsedGroups = JSON.parse(groupIds || '[]'); } catch (_) {}

    const userBlockSet = parseBlacklist(userBlock || '');
    const userBlockNumbers = new Set();
    userBlockSet.forEach((b) => {
      const num = b.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
      if (num && num.length >= 8) userBlockNumbers.add(num + '@s.whatsapp.net');
    });

    let filteredOutByBlockedMember = 0;
    let groupsToUse = parsedGroups;
    if (userBlockNumbers.size > 0 && groupsToUse.length > 0) {
      pushLog('info', `[S${sid}] Checking ${userBlockNumbers.size} blocked in ${groupsToUse.length} groups...`);
      const keptGroups = [];
      for (const jid of groupsToUse) {
        const hasBlocked = await groupHasBlockedMember(sess, jid, userBlockNumbers);
        if (hasBlocked) {
          filteredOutByBlockedMember++;
          const gname = (sess.groupsCache[jid] && sess.groupsCache[jid].name) || jid;
          pushLog('warn', `[S${sid}] 🚫 Skipped "${gname}" — blocked member`);
        } else {
          keptGroups.push(jid);
        }
      }
      groupsToUse = keptGroups;
    }

    const targets = []; const seen = new Set();
    let filteredOutByBlacklist = 0;

    groupsToUse.forEach((jid) => {
      if (!jid || seen.has(jid)) return;
      if (userBlockSet.has(jid)) { filteredOutByBlacklist++; return; }
      seen.add(jid);
      const meta = sess.groupsCache[jid];
      targets.push({ jid, label: meta && meta.name ? `[G] ${meta.name}` : `[G] ${jid}` });
    });

    const numberTargets = parseNumbers(numbers || '');
    numberTargets.forEach((n) => {
      if (seen.has(n.jid)) return;
      if (userBlockSet.has(n.jid)) { filteredOutByBlacklist++; pushLog('warn', `[S${sid}] 🚫 Skipped ${n.label}`); return; }
      seen.add(n.jid);
      targets.push({ jid: n.jid, label: n.label });
    });

    if (!targets.length) return res.status(400).json({ success: false, error: 'No targets after filters' });

    let delaySec = parseInt(delay) || DEFAULT_DELAY_SECONDS;
    if (delaySec < MIN_DELAY_SECONDS) delaySec = MIN_DELAY_SECONDS;
    const waitMs = delaySec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const preparedMessages = messages.map((m) => prefix + m + suffix);

    sess.bulk = {
      running: true, stopFlag: false,
      sent: 0, failed: 0, blocked: filteredOutByBlacklist + filteredOutByBlockedMember,
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
      groups: groupCount, numbers: numCount,
      blocked: filteredOutByBlacklist + filteredOutByBlockedMember,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bulk/stop', (req, res) => {
  const sid = String((req.body && req.body.sessionId) || '1');
  const sess = getSession(sid);
  if (!sess || !sess.bulk || !sess.bulk.running) return res.status(400).json({ success: false, error: 'No task' });
  sess.bulk.stopFlag = true;
  pushLog('warn', `[S${sid}] Stop requested`);
  res.json({ success: true });
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

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

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
          send(chatId, '*RK RAJA XWD Bot*\n\n/status — Status\n/sessions — Paired numbers\n/msg <num> <text> — Send\n/stop <sid> — Stop bulk');
          break;
        case '/status': {
          const sess = getAllSessionsInfo();
          let s = `📊 *Status*\n\nSessions: ${sess.length}\n`;
          sess.forEach(x => { s += `• S${x.id}: ${x.paired?'✅ '+x.phone:'❌ Not paired'}\n`; });
          send(chatId, s);
          break;
        }
        case '/sessions': {
          const ss = getAllSessionsInfo();
          if (!ss.length) { send(chatId, 'No sessions'); break; }
          let txt = '*Sessions:*\n\n';
          ss.forEach(x => { txt += `S${x.id} — ${x.paired?'✅ '+x.phone:'❌'}\n`; });
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
          const sid = args.trim() || '1';
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

app.listen(PORT, HOST, () => {
  console.log('\n🟢 RK RAJA XWD — Server running');
  console.log('🌐 Dashboard: http://' + HOST + ':' + PORT + '/\n');
  pushLog('info', 'Server started — RK RAJA XWD');
  initTelegramBot();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
