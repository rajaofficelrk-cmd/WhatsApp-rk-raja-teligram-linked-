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
const START_TIME = Date.now();

// ===== STATE =====
const sessions = new Map();  // sid -> session
const logs = { list: [], id: 0 };

function log(type, msg) {
  const entry = { id: ++logs.id, ts: Date.now(), type, msg };
  logs.list.push(entry);
  if (logs.list.length > 400) logs.list.splice(0, 100);
  const icons = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtMs(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function newSession(sid) {
  return {
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
    authDir: `auth_info_baileys_${sid}`,
    groups: {},
    bulk: null,
    suspended: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    intentionalClose: false,
  };
}

function getSession(sid) {
  return sessions.get(String(sid || '1'));
}

function isReady(s) {
  return !!(s && s.sock && s.isPaired && !s.suspended);
}

function maskPhone(p) {
  if (!p) return '—';
  const s = String(p);
  return s.length <= 4 ? '****' : s.slice(0, 2) + '****' + s.slice(-2);
}

// ===== CONNECT SESSION =====
async function startSession(sid, phone) {
  sid = String(sid);
  let s = getSession(sid);
  if (!s) {
    s = newSession(sid);
    sessions.set(sid, s);
  }

  // Clean previous socket
  if (s.sock) {
    try { s.sock.ev.removeAllListeners(); s.sock.end(undefined); } catch (_) {}
    s.sock = null;
  }
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }

  // Read existing creds
  const credsFile = path.join(s.authDir, 'creds.json');
  let hasCreds = false;
  let registered = false;
  try {
    if (fs.existsSync(credsFile)) {
      const c = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (c && c.me && c.me.id) {
        registered = true;
        hasCreds = true;
        s.phone = c.me.id.split(':')[0].split('@')[0];
      }
    }
  } catch (_) {}

  s.isRegistered = registered;

  // Agar pairing code chahiye but already registered
  if (phone && registered) {
    s.lastError = 'Session already registered. Logout first.';
    s.isConnecting = false;
    log('err', `[S${sid}] Already registered — logout first`);
    return { ok: false, error: 'Session already registered. Logout first.' };
  }

  s.isConnecting = true;
  s.intentionalClose = false;
  if (phone) s.phone = phone;
  if (!phone && !registered) {
    s.isConnecting = false;
    return { ok: false, error: 'Phone required for new session' };
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
    const { version } = await fetchLatestBaileysVersion();

    s.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.0'],
      mobile: false,
      syncFullHistory: false,
      getMessage: async () => ({ conversation: '' }),
    });

    s.sock.ev.on('creds.update', saveCreds);

    s.sock.ev.on('groups.upsert', (gs) => {
      gs.forEach(g => {
        s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants?.length || 0 };
      });
    });

    s.sock.ev.on('groups.update', (us) => {
      us.forEach(u => {
        if (s.groups[u.id]) { if (u.subject) s.groups[u.id].name = u.subject; }
        else if (u.id) s.groups[u.id] = { id: u.id, name: u.subject || '', size: 0 };
      });
    });

    s.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      // PAIRING CODE
      if (connection === 'connecting' && !s.sock.authState.creds.registered && !s.pairingRequested && phone) {
        s.pairingRequested = true;
        try {
          await sleep(1500);
          const code = await s.sock.requestPairingCode(String(phone).replace(/[^\d]/g, ''));
          s.pairingCode = code;
          s.lastError = null;
          log('info', `[S${sid}] ✅ Code: ${code}`);
        } catch (e) {
          s.pairingCode = null;
          s.pairingRequested = false;
          s.isConnecting = false;
          s.lastError = 'Pairing failed: ' + e.message;
          log('err', `[S${sid}] Pairing error: ${e.message}`);
        }
      }

      // CONNECTED
      if (connection === 'open') {
        s.isPaired = true;
        s.isConnecting = false;
        s.pairingCode = null;
        s.pairingRequested = false;
        s.suspended = false;
        s.reconnectAttempts = 0;
        s.connectedAt = new Date().toISOString();
        s.lastError = null;
        log('ok', `[S${sid}] ✅ Connected`);

        // Fetch groups in background
        setTimeout(async () => {
          try {
            if (s.sock && typeof s.sock.groupFetchAllParticipating === 'function') {
              const all = await s.sock.groupFetchAllParticipating();
              Object.values(all).forEach(g => {
                s.groups[g.id] = { id: g.id, name: g.subject || '', size: g.participants?.length || 0 };
              });
              log('info', `[S${sid}] Loaded ${Object.keys(s.groups).length} groups`);
            }
          } catch (_) {}
        }, 3000);

        // Resume bulk if was running
        if (s.bulk && s.bulk.running && !s.bulk.alive) {
          s.bulk.alive = false;
          runWorker(s);
        }
      }

      // CLOSED
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        s.isPaired = false;
        s.isConnecting = false;

        if (code === DisconnectReason.loggedOut || code === 401) {
          s.suspended = true;
          s.lastError = 'Logged out';
          log('warn', `[S${sid}] Logged out`);
          if (s.bulk && s.bulk.running) s.bulk.stopFlag = true;
          return;
        }

        if (code === 403 || code === 405) {
          s.suspended = true;
          s.lastError = 'Account suspended';
          log('err', `[S${sid}] 🚫 SUSPENDED (${code})`);
          if (s.bulk && s.bulk.running) s.bulk.stopFlag = true;
          return;
        }

        // Reconnect
        if (!s.intentionalClose && s.phone && !s.suspended) {
          s.reconnectAttempts++;
          if (s.reconnectAttempts > 15) {
            s.suspended = true;
            s.lastError = 'Too many reconnects';
            log('err', `[S${sid}] Max reconnects reached`);
            return;
          }
          const wait = Math.min(2000 + s.reconnectAttempts * 1500, 20000);
          log('warn', `[S${sid}] Closed (${code}) — reconnecting in ${Math.round(wait/1000)}s`);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            startSession(sid, null).catch(e => log('err', `[S${sid}] Reconnect err: ${e.message}`));
          }, wait);
        }
      }
    });

  } catch (e) {
    s.isConnecting = false;
    s.lastError = e.message;
    log('err', `[S${sid}] Init error: ${e.message}`);
    return { ok: false, error: e.message };
  }

  return { ok: true };
}

// ===== WORKER (Non-stop) =====
async function runWorker(s) {
  const b = s.bulk;
  if (!b || b.alive) return;
  b.alive = true;
  log('info', `[S${s.id}] Worker START (non-stop)`);

  try {
    while (!b.stopFlag) {
      if (s.suspended) {
        log('warn', `[S${s.id}] Worker paused (suspended)`);
        break;
      }

      if (!isReady(s)) {
        await sleep(3000);
        continue;
      }

      // Loop through messages
      for (let mi = 0; mi < b.messages.length && !b.stopFlag; mi++) {
        b.msgIndex = mi;
        b.currentMsg = b.messages[mi];

        for (let ti = 0; ti < b.targets.length && !b.stopFlag; ti++) {
          if (s.suspended) break;
          const t = b.targets[ti];
          b.targetIndex = ti;
          b.currentTarget = t.label;

          if (!isReady(s)) {
            await sleep(2000);
            break;
          }

          try {
            await s.sock.sendMessage(t.jid, { text: b.messages[mi] });
            b.sent++;
            log('ok', `[S${s.id}] C${b.cycle+1} | ${mi+1}/${b.messages.length} → ${t.label}`);
          } catch (e) {
            b.failed++;
            const em = String(e.message || '').toLowerCase();
            log('err', `[S${s.id}] ${t.label}: ${e.message}`);

            if (em.includes('banned') || em.includes('suspended') || em.includes('401')) {
              s.suspended = true;
              break;
            }
          }

          b.remaining = b.messages.length - (mi + 1);
          if (!b.stopFlag && !s.suspended) await sleep(b.delayMs);
        }

        if (s.suspended) break;
      }

      if (!b.stopFlag && !s.suspended) {
        b.cycle++;
        b.msgIndex = 0;
        b.targetIndex = 0;
        b.remaining = b.messages.length;
        log('info', `[S${s.id}] Cycle ${b.cycle} complete — restarting`);
      }
    }
  } catch (e) {
    log('err', `[S${s.id}] Worker crash: ${e.message}`);
    if (!b.stopFlag && !s.suspended) {
      b.alive = false;
      setTimeout(() => runWorker(s), 3000);
      return;
    }
  } finally {
    if (b.stopFlag) {
      b.running = false;
      b.stopFlag = false;
      b.alive = false;
      log('info', `[S${s.id}] Stopped — Sent: ${b.sent}, Failed: ${b.failed}`);
    } else {
      b.alive = false;
      if (s.suspended) b.running = false;
    }
  }
}

// Watchdog — non-stop
setInterval(() => {
  sessions.forEach(s => {
    if (s.bulk && s.bulk.running && !s.bulk.alive && !s.suspended) {
      log('warn', `[S${s.id}] Watchdog restart`);
      runWorker(s);
    }
  });
}, 20000);

// ===== AUTO LOAD =====
async function autoLoad() {
  try {
    const dirs = fs.readdirSync(__dirname).filter(d => d.startsWith('auth_info_baileys_'));
    if (!dirs.length) return;
    log('info', `Found ${dirs.length} session(s) — loading`);
    for (const d of dirs) {
      const sid = d.replace('auth_info_baileys_', '');
      const credsFile = path.join(__dirname, d, 'creds.json');
      if (!fs.existsSync(credsFile)) continue;
      const s = newSession(sid);
      sessions.set(sid, s);
      await startSession(sid, null);
      await sleep(1500);
    }
  } catch (e) { log('err', 'Auto-load: ' + e.message); }
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
  if (/@g\.us$/i.test(t)) return t;
  if (/@s\.whatsapp\.net$/i.test(t)) return t;
  const d = t.replace(/[^\d]/g, '');
  if (!d || d.length < 8 || d.length > 15) return null;
  return d + '@s.whatsapp.net';
}

function parseNums(raw) {
  if (!raw) return [];
  const out = []; const seen = new Set();
  String(raw).split(/[\r\n,;\s]+/).forEach(t => {
    const j = normJid(t);
    if (!j || seen.has(j)) return;
    seen.add(j);
    out.push({ jid: j, label: j.endsWith('@g.us') ? '[G] ' + j : '[N] +' + j.split('@')[0] });
  });
  return out;
}

function sessionsInfo() {
  const out = [];
  sessions.forEach(s => {
    out.push({
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
    });
  });
  return out.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
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
.hero-img{max-width:150px;width:42vw;border-radius:12px;filter:drop-shadow(0 0 30px #00ff41) brightness(1.1);position:relative;z-index:2;display:inline-block}
.hero-glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:230px;height:230px;background:radial-gradient(circle,rgba(0,255,65,.45) 0%,transparent 70%);z-index:1;pointer-events:none;animation:pg 3s ease-in-out infinite}
@keyframes pg{0%,100%{opacity:.7}50%{opacity:1}}
h1{font-size:30px;color:#00ff41;text-shadow:0 0 15px #00ff41,0 0 30px rgba(0,255,65,.6);letter-spacing:4px;text-align:center;margin:12px 0 4px;text-transform:uppercase;font-weight:900}
h1 .x{color:#fff}
.sub{text-align:center;color:#009922;font-size:11px;letter-spacing:4px;text-transform:uppercase;margin-bottom:16px}
.term{background:rgba(0,0,0,.9);border:1px solid rgba(0,255,65,.5);border-radius:8px;overflow:hidden;margin-bottom:16px;box-shadow:0 0 30px rgba(0,255,65,.3)}
.tbar{background:#001500;padding:8px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(0,255,65,.3)}
.dot{width:11px;height:11px;border-radius:50%}
.dr{background:#ff5f56}.dy{background:#ffbd2e}.dg{background:#27c93f}
.ttitle{margin-left:8px;color:#00ff41;font-size:11px;letter-spacing:1.5px}
.tbody{padding:12px 14px;font-size:12px;line-height:1.8}
.ok{color:#00ff41;text-shadow:0 0 8px #00ff41}
.cur{background:#00ff41;display:inline-block;width:9px;height:14px;vertical-align:middle;animation:bl 1s infinite}
@keyframes bl{0%,50%{opacity:1}51%,100%{opacity:0}}
.tabs{display:flex;gap:10px;justify-content:center;margin-bottom:16px;flex-wrap:wrap}
.tab{padding:10px 20px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(0,255,65,.5);background:transparent;color:#00ff41;font-family:inherit}
.tab.active{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000}
.panel{display:none}.panel.active{display:block}
.card{background:rgba(0,15,0,.85);border:1px solid rgba(0,255,65,.35);border-radius:8px;padding:16px;margin-bottom:12px}
.card h2{font-size:13px;color:#00ff41;letter-spacing:2px;margin-bottom:12px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.card h2::before{content:"";width:8px;height:8px;border-radius:50%;background:#00ff41;box-shadow:0 0 12px #00ff41;animation:bl 1.5s infinite}
label{display:block;font-size:11px;color:#009922;margin-bottom:5px;letter-spacing:1.5px;text-transform:uppercase}
input,textarea,select{width:100%;background:rgba(0,20,5,.9);border:1px solid rgba(0,255,65,.4);border-radius:6px;padding:11px 13px;color:#00ff41;font-size:15px;font-family:inherit;outline:none}
input:focus,textarea:focus{border-color:#00ff41;box-shadow:0 0 15px rgba(0,255,65,.4)}
input::placeholder,textarea::placeholder{color:#005518}
textarea{resize:vertical;min-height:70px}
.field{margin-bottom:11px}
button{background:linear-gradient(180deg,#00ff41,#00aa2a);color:#000;border:none;border-radius:6px;padding:12px 20px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;margin-top:6px;width:100%;font-family:inherit}
button:disabled{background:#0a1a0a;color:#005518;cursor:not-allowed}
button.ghost{background:transparent;border:1px solid rgba(0,255,65,.5);color:#00ff41}
button.danger{background:linear-gradient(180deg,#ff003c,#aa0022);color:#fff}
.btnrow{display:flex;gap:8px}.btnrow button{margin-top:0}
.msg{margin-top:10px;padding:10px 13px;border-radius:6px;font-size:12px;display:none}
.msg.ok{background:rgba(0,255,65,.12);color:#00ff41;border:1px solid rgba(0,255,65,.5);display:block}
.msg.err{background:rgba(255,0,60,.12);color:#ff5f7f;border:1px solid rgba(255,0,60,.5);display:block}
.code{background:rgba(0,20,5,.9);border:2px dashed #00ff41;border-radius:8px;padding:16px;margin:12px 0;text-align:center}
.codev{font-size:30px;font-weight:900;letter-spacing:7px;color:#00ff41;text-shadow:0 0 20px #00ff41}
.codel{font-size:11px;color:#009922;letter-spacing:3px;margin-bottom:6px;text-transform:uppercase}
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
.groups-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.groups-toolbar button{width:auto;padding:8px 14px;font-size:11px;margin:0}
.groups-toolbar .count{font-size:11px;color:#009922;margin-left:auto}
.glist{background:rgba(0,15,0,.6);border:1px solid rgba(0,255,65,.25);border-radius:8px;max-height:280px;overflow-y:auto;padding:8px}
.gitem{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:6px;cursor:pointer;border:1px solid transparent}
.gitem.selected{background:rgba(0,255,65,.15);border-color:#00ff41}
.gitem input[type=checkbox]{width:18px;height:18px;accent-color:#00ff41;flex-shrink:0}
.ginfo{flex:1;min-width:0}
.gname{color:#00ff41;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gjid{color:#006622;font-size:11px;font-family:monospace;margin-top:2px}
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
</style>
</head>
<body>
<div class="container">
  <div class="hero"><div class="hero-glow"></div><img src="${LOGO}" alt="RK RAJA" class="hero-img"/></div>
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

  <div class="tabs">
    <div class="tab active" data-tab="dash" onclick="switchTab('dash')">Dashboard</div>
    <div class="tab" data-tab="bulk" onclick="switchTab('bulk')">Bulk Sender</div>
  </div>

  <div class="panel active" id="panel-dash">
    <div class="card">
      <h2>Add WhatsApp Number</h2>
      <div class="field">
        <label>Session ID (1, 2, 3, 4...)</label>
        <input id="sid" type="text" value="1"/>
        <div class="hint">Har number ke liye alag ID — 1, 2, 3, 4...</div>
      </div>
      <div class="field">
        <label>Phone (country code, no + or spaces)</label>
        <input id="phone" type="tel" placeholder="919876543210"/>
      </div>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="pairMsg" class="msg"></div>
      <div id="codeSec" style="display:none">
        <div class="code">
          <div class="codel">Pairing Code for Session <span id="codeSid">1</span></div>
          <div class="codev" id="codeVal">------</div>
        </div>
        <div class="steps"><b>Steps:</b><br/>1. WhatsApp kholo us number me<br/>2. Settings → <b>Linked Devices</b><br/>3. <b>Link a Device</b> → <b>Link with phone number</b><br/>4. Ye code daalo (2 min me)</div>
      </div>
    </div>

    <div class="card">
      <h2>Paired Numbers</h2>
      <div id="sessList"><div class="empty">No sessions yet.</div></div>
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
      <h2>Log</h2>
      <div class="log" id="logBox"><div class="line"><span class="t">[boot]</span>Ready</div></div>
      <div class="btnrow" style="margin-top:10px"><button class="ghost" onclick="clearLog()">Clear</button></div>
    </div>
  </div>

  <div class="panel" id="panel-bulk">
    <div class="card">
      <h2>Messages File (.txt)</h2>
      <input id="fileInput" type="file" accept=".txt"/>
      <div class="hint" id="fileHint">No file</div>
    </div>
    <div class="card">
      <h2>Groups</h2>
      <div class="groups-toolbar">
        <button class="ghost" onclick="fetchGroups()">Fetch</button>
        <button class="ghost" onclick="selAll()">All</button>
        <button class="ghost" onclick="clearSel()">Clear</button>
        <span class="count" id="gcount">0 selected</span>
      </div>
      <div class="glist" id="glist"><div class="empty">Click Fetch</div></div>
    </div>
    <div class="card">
      <h2>Numbers (optional)</h2>
      <textarea id="nums" placeholder="919876543210&#10;918765432109"></textarea>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <div class="field"><label>Hater Prefix</label><input id="hater" type="text" placeholder="RK RAJA XWD"/></div>
      <div class="field"><label>Delay (seconds, min 3)</label><input id="delay" type="number" min="3" value="10"/></div>
      <div class="field"><label>Hater Suffix</label><input id="lastHater" type="text" placeholder="XWD"/></div>
      <div class="btnrow">
        <button id="startBtn" onclick="startBulk()">▶ Start Bulk (All)</button>
        <button id="stopAllBtn" class="danger" onclick="stopAll()" disabled>■ Stop All</button>
      </div>
    </div>
    <div class="card">
      <h2>Live Stats</h2>
      <div id="multiStats"><div class="empty">Start bulk to see stats</div></div>
    </div>
  </div>

  <div class="foot">── 👑 RK RAJA 👑 ──<br/>● SERVER ONLINE</div>
</div>

<script>
var allSess = [];
var selGroups = new Set();
var cgroups = [];
var lastLogId = 0;

function switchTab(n) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === n));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + n));
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showMsg(el, t, x) { el.textContent = x; el.style.display = t ? 'block' : 'none'; el.className = 'msg' + (t ? ' ' + t : ''); }
function clearLog() { document.getElementById('logBox').innerHTML = ''; }

async function startPair() {
  var phone = document.getElementById('phone').value.trim();
  var sid = document.getElementById('sid').value.trim() || '1';
  var btn = document.getElementById('pairBtn');
  var msg = document.getElementById('pairMsg');
  if (!phone || !/^\d{10,15}$/.test(phone)) { showMsg(msg, 'err', 'Valid number daalo (country code ke saath)'); return; }
  btn.disabled = true; btn.textContent = 'Starting...'; showMsg(msg, '', '');
  try {
    var res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone, sessionId: sid }) });
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    document.getElementById('codeSec').style.display = 'block';
    document.getElementById('codeSid').textContent = sid;
    document.getElementById('codeVal').textContent = 'Generating...';
    showMsg(msg, 'ok', 'Pairing started — code aayega kuch sec me');
    setTimeout(refresh, 2000);
    setTimeout(refresh, 4000);
    setTimeout(refresh, 7000);
  } catch (e) { showMsg(msg, 'err', e.message); }
  finally { btn.disabled = false; btn.textContent = 'Get Pairing Code'; }
}

async function refresh() {
  try {
    var res = await fetch('/api/sessions');
    var d = await res.json();
    allSess = d.sessions || [];
    renderSess();
    document.getElementById('stSess').textContent = allSess.length;
    document.getElementById('stPaired').textContent = allSess.filter(s => s.paired).length;
  } catch (e) {}
}

function renderSess() {
  var el = document.getElementById('sessList');
  if (!allSess.length) { el.innerHTML = '<div class="empty">No sessions yet.</div>'; return; }
  el.innerHTML = allSess.map(s => {
    var cls = 'session';
    if (s.paired && !s.suspended) cls += ' active';
    if (s.suspended) cls += ' susp';
    var badge = s.suspended ? '🚫 SUSPENDED' : (s.paired ? '✅ Paired' : (s.connecting ? '⏳ Connecting...' : (s.code ? '🔑 Code: ' + esc(s.code) : (s.registered ? '⚠ Registered' : '❌ Idle'))));
    var g = s.paired ? (s.groupCount + ' groups') : '';
    var bulkHtml = '';
    if (s.bulkRunning && s.bulkStartedAt) {
      var bs = Math.floor((Date.now() - s.bulkStartedAt) / 1000);
      var bt = String(Math.floor(bs/3600)).padStart(2,'0') + ':' + String(Math.floor((bs%3600)/60)).padStart(2,'0') + ':' + String(bs%60).padStart(2,'0');
      bulkHtml = '<div style="padding:8px 10px;background:rgba(0,255,65,.1);border:1px solid rgba(0,255,65,.4);border-radius:6px;font-size:11px;margin-top:8px"><div style="color:#00ff41;font-weight:700">🔄 BULK — ' + bt + '</div><div style="color:#009922">📤 ' + s.bulkSent + ' | ❌ ' + s.bulkFailed + ' | 🔁 ' + s.bulkCycle + '</div></div>';
    }
    return '<div class="' + cls + '"><div class="shead"><div><div class="sname">Session ' + esc(s.id) + '</div><div class="sstatus">' + badge + (g ? ' | ' + g : '') + '</div></div><div class="sactions">' +
      (s.paired || s.registered ? '<button class="ghost" onclick="doLogout(\'' + esc(s.id) + '\')">Logout</button>' : '') +
      (s.bulkRunning ? '<button class="danger" onclick="stopSess(\'' + esc(s.id) + '\')">Stop</button>' : '') +
    '</div></div>' + bulkHtml + '</div>';
  }).join('');
}

async function doLogout(sid) {
  if (!confirm('Logout Session ' + sid + '?')) return;
  try {
    var res = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    refresh();
  } catch (e) { alert(e.message); }
}

async function stopSess(sid) {
  try {
    var res = await fetch('/api/bulk/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    if (d.summary) alert('Stopped!\nRun: ' + d.summary.runFormatted + '\nSent: ' + d.summary.sent + '\nFailed: ' + d.summary.failed);
    setTimeout(refresh, 1000);
  } catch (e) { alert(e.message); }
}

async function fetchGroups() {
  var p = allSess.filter(s => s.paired && !s.suspended);
  if (!p.length) { alert('Pehle WhatsApp pair karo'); return; }
  var el = document.getElementById('glist');
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    var res = await fetch('/api/groups?sessionId=' + p[0].id);
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    cgroups = d.groups || [];
    renderGroups();
  } catch (e) { el.innerHTML = '<div class="empty" style="color:#ff5f7f">' + esc(e.message) + '</div>'; }
}

function renderGroups() {
  var el = document.getElementById('glist');
  document.getElementById('gcount').textContent = selGroups.size + ' selected';
  if (!cgroups.length) { el.innerHTML = '<div class="empty">No groups</div>'; return; }
  el.innerHTML = cgroups.map(g => {
    var sel = selGroups.has(g.id) ? ' selected' : '';
    var chk = selGroups.has(g.id) ? ' checked' : '';
    return '<label class="gitem' + sel + '" data-jid="' + esc(g.id) + '"><input type="checkbox"' + chk + ' onchange="toggleG(\'' + esc(g.id) + '\',this.checked)"/><div class="ginfo"><div class="gname">' + esc(g.name || '(no name)') + '</div><div class="gjid">' + esc(g.id) + '</div></div></label>';
  }).join('');
}

function toggleG(jid, c) {
  if (c) selGroups.add(jid); else selGroups.delete(jid);
  document.getElementById('gcount').textContent = selGroups.size + ' selected';
  document.querySelectorAll('#glist .gitem').forEach(el => { if (el.dataset.jid === jid) el.classList.toggle('selected', c); });
}
function selAll() { cgroups.forEach(g => selGroups.add(g.id)); renderGroups(); }
function clearSel() { selGroups.clear(); renderGroups(); }

document.getElementById('fileInput').addEventListener('change', e => {
  var f = e.target.files[0];
  document.getElementById('fileHint').textContent = f ? f.name : 'No file';
});

async function startBulk() {
  var p = allSess.filter(s => s.paired && !s.suspended);
  if (!p.length) { alert('Pehle WhatsApp pair karo'); return; }
  var file = document.getElementById('fileInput').files[0];
  if (!file) { alert('Message file upload karo'); return; }
  var nr = document.getElementById('nums').value.trim();
  if (!selGroups.size && !nr) { alert('Group select karo ya number daalo'); return; }
  var delay = parseInt(document.getElementById('delay').value) || 10;
  if (delay < 3) delay = 3;

  var sb = document.getElementById('startBtn');
  var stb = document.getElementById('stopAllBtn');
  sb.disabled = true; sb.textContent = 'Starting...';

  var fd = new FormData();
  fd.append('file', file);
  fd.append('groupIds', JSON.stringify(Array.from(selGroups)));
  fd.append('numbers', nr);
  fd.append('hater', document.getElementById('hater').value.trim());
  fd.append('lastHater', document.getElementById('lastHater').value.trim());
  fd.append('delay', String(delay));

  try {
    var res = await fetch('/api/bulk/start-all', { method: 'POST', body: fd });
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    alert('✅ Bulk started on ' + d.sessions + ' sessions');
    stb.disabled = false;
    setTimeout(refresh, 1000);
  } catch (e) { alert('❌ ' + e.message); }
  finally { sb.disabled = false; sb.textContent = '▶ Start Bulk (All)'; }
}

async function stopAll() {
  if (!confirm('Stop ALL sessions?')) return;
  try {
    var res = await fetch('/api/bulk/stop-all', { method: 'POST' });
    var d = await res.json();
    if (!d.success) throw new Error(d.error);
    alert('Stopped ' + d.stopped + ' sessions');
    document.getElementById('stopAllBtn').disabled = true;
    setTimeout(refresh, 1000);
  } catch (e) { alert(e.message); }
}

async function pollStats() {
  try {
    var res = await fetch('/api/bulk/status-all');
    var d = await res.json();
    document.getElementById('stUp').textContent = d.uptimeFormatted || '00:00:00';
    var sw = d.sessions.filter(s => s.bulk && (s.bulk.running || s.bulk.sent > 0));
    var el = document.getElementById('multiStats');
    if (!sw.length) { el.innerHTML = '<div class="empty">Start bulk to see stats</div>'; }
    else {
      el.innerHTML = sw.map(s => {
        var b = s.bulk || {};
        var pct = (b.total && b.total > 0) ? Math.round(((b.total - (b.remaining || 0)) / b.total) * 100) : 0;
        return '<div style="padding:10px;background:rgba(0,15,0,.75);border:1px solid rgba(0,255,65,.3);border-radius:6px;margin-bottom:8px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><b style="color:#00ff41">S' + esc(s.id) + '</b><span style="color:' + (b.running ? '#00ff41' : '#005518') + '">' + (b.running ? '● Running' : '● Stopped') + '</span></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;font-size:11px"><div>Sent: <b style="color:#00ff41">' + (b.sent || 0) + '</b></div><div>Failed: <b style="color:#ff5f7f">' + (b.failed || 0) + '</b></div><div>Cycle: <b>' + (b.cycle || 0) + '</b></div><div>Prog: <b>' + pct + '%</b></div></div></div>';
      }).join('');
    }
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
  } catch (e) {}
}

setInterval(refresh, 4000);
setInterval(pollStats, 1500);
refresh();
pollStats();
</script>
</body>
</html>`;

// ===== EXPRESS =====
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(HTML));
const upload = multer({ dest: 'uploads/' });

app.get('/api/sessions', (req, res) => res.json({ sessions: sessionsInfo() }));

app.post('/api/pair', async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    const sid = String(sessionId || '1').trim();
    if (!sid) return res.status(400).json({ success: false, error: 'Session ID required' });
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone (10-15 digits, no + or spaces)' });

    let s = getSession(sid);
    if (!s) { s = newSession(sid); sessions.set(sid, s); }

    if (s.isPaired) return res.status(400).json({ success: false, error: `Session ${sid} already paired. Logout first or use different Session ID.` });
    if (s.isConnecting) return res.status(400).json({ success: false, error: `Session ${sid} is connecting. Please wait.` });

    // Check existing creds
    const credsFile = path.join(s.authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      try {
        const c = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        if (c && c.me && c.me.id) {
          return res.status(400).json({ success: false, error: `Session ${sid} already registered. Logout first or use different Session ID.` });
        }
      } catch (_) {}
    }

    startSession(sid, phone).catch(e => { s.lastError = e.message; });
    res.json({ success: true, sessionId: sid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const sid = String(sessionId || '1');
    const s = getSession(sid);
    if (!s) return res.status(400).json({ success: false, error: 'Not found' });
    s.intentionalClose = true;
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    if (s.bulk) s.bulk.stopFlag = true;
    if (s.sock) { try { await s.sock.logout(); } catch (_) {} }
    if (fs.existsSync(s.authDir)) fs.rmSync(s.authDir, { recursive: true, force: true });
    sessions.delete(sid);
    log('warn', `[S${sid}] Logged out`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/groups', async (req, res) => {
  try {
    const sid = String(req.query.sessionId || '1');
    const s = getSession(sid);
    if (!s || !s.isPaired || !s.sock) return res.status(400).json({ success: false, error: 'Not paired' });
    const map = new Map();
    Object.values(s.groups).forEach(g => map.set(g.id, g));
    try {
      if (s.sock.store && s.sock.store.groupMetadata) {
        s.sock.store.groupMetadata.forEach(v => {
          if (!map.has(v.id)) map.set(v.id, { id: v.id, name: v.subject || '', size: v.participants?.length || 0 });
        });
      }
    } catch (_) {}
    if (map.size === 0 && typeof s.sock.groupFetchAllParticipating === 'function') {
      try {
        const all = await s.sock.groupFetchAllParticipating();
        Object.values(all).forEach(g => map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants?.length || 0 }));
      } catch (_) {}
    }
    const groups = [...map.values()].filter(g => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach(g => { s.groups[g.id] = g; });
    res.json({ success: true, groups });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bulk/start-all', upload.single('file'), async (req, res) => {
  try {
    const paired = [...sessions.values()].filter(s => s.isPaired && s.sock && !s.suspended);
    if (!paired.length) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ success: false, error: 'No paired sessions found' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Upload .txt file' });

    const { groupIds, numbers, hater, lastHater, delay } = req.body;
    let messages = [];
    try { messages = parseMsgs(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });

    let pg = [];
    try { pg = JSON.parse(groupIds || '[]'); } catch (_) {}

    let dsec = parseInt(delay) || 10;
    if (dsec < 3) dsec = 3;
    const waitMs = dsec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const prepared = messages.map(m => prefix + m + suffix);

    const firstS = paired[0];
    const targets = [];
    const seen = new Set();
    pg.forEach(jid => {
      if (!jid || seen.has(jid)) return;
      seen.add(jid);
      const m = firstS.groups[jid];
      targets.push({ jid, label: m && m.name ? '[G] ' + m.name : '[G] ' + jid });
    });
    parseNums(numbers || '').forEach(n => {
      if (seen.has(n.jid)) return;
      seen.add(n.jid);
      targets.push({ jid: n.jid, label: n.label });
    });
    if (!targets.length) return res.status(400).json({ success: false, error: 'No targets selected' });

    let started = 0;
    paired.forEach((s, idx) => {
      if (s.bulk && s.bulk.running) return;
      const st = targets.map(t => ({ jid: t.jid, label: t.label }));
      s.bulk = {
        running: true, stopFlag: false, alive: false,
        sent: 0, failed: 0,
        total: messages.length, remaining: messages.length,
        cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: st.length,
        currentMsg: '', currentTarget: '',
        targets: st, messages: prepared.slice(), delayMs: waitMs,
        startedAt: Date.now(),
      };
      setTimeout(() => { log('info', `[S${s.id}] 🚀 Bulk started`); runWorker(s); }, idx * 4000);
      started++;
    });

    log('info', `Multi-bulk started on ${started} session(s)`);
    res.json({ success: true, sessions: started, total: messages.length, totalTargets: targets.length });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bulk/stop', (req, res) => {
  const { sessionId } = req.body || {};
  const sid = String(sessionId || '1');
  const s = getSession(sid);
  if (!s || !s.bulk || !s.bulk.running) return res.status(400).json({ success: false, error: 'No task running' });
  const b = s.bulk;
  const runMs = b.startedAt ? (Date.now() - b.startedAt) : 0;
  const summary = { sessionId: sid, runFormatted: fmtMs(runMs), sent: b.sent || 0, failed: b.failed || 0, cycles: b.cycle || 0 };
  b.stopFlag = true;
  log('warn', `[S${sid}] Stop requested`);
  res.json({ success: true, summary });
});

app.post('/api/bulk/stop-all', (req, res) => {
  let stopped = 0;
  sessions.forEach(s => { if (s.bulk && s.bulk.running) { s.bulk.stopFlag = true; stopped++; } });
  log('warn', `Stopped all: ${stopped}`);
  res.json({ success: true, stopped });
});

app.get('/api/bulk/status-all', (req, res) => {
  const out = sessionsInfo().map(s => {
    const sess = getSession(s.id);
    return {
      id: s.id, phone: s.phone, paired: s.paired,
      bulk: sess && sess.bulk ? {
        running: sess.bulk.running, sent: sess.bulk.sent, failed: sess.bulk.failed,
        total: sess.bulk.total, remaining: sess.bulk.remaining,
        cycle: sess.bulk.cycle, totalTargets: sess.bulk.totalTargets,
      } : null,
    };
  });
  res.json({ sessions: out, uptimeFormatted: fmtMs(Date.now() - START_TIME), logs: logs.list.slice(-200) });
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

// ===== START =====
app.listen(PORT, HOST, async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  🟢 RK RAJA XWD — Port ' + PORT + '              ║');
  console.log('╚══════════════════════════════════════════╝\n');
  await autoLoad();
});

process.on('SIGTERM', () => { try { sessions.forEach(s => { s.intentionalClose = true; s.sock?.end(undefined); }); } catch(_){} process.exit(0); });
process.on('SIGINT', () => { try { sessions.forEach(s => { s.intentionalClose = true; s.sock?.end(undefined); }); } catch(_){} process.exit(0); });
