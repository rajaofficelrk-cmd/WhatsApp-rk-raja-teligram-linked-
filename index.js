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

const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const AUTH_DIR = 'auth_info_baileys';
const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

let sock = null, pairingCode = null, isPaired = false, currentPhone = null;
let pairingRequested = false, isConnecting = false, lastError = null;
let connectedAt = null, serverStartTime = Date.now();
let groupsCache = {};

const bulkState = {
  running: false, stopFlag: false, sent: 0, failed: 0, blocked: 0, tasks: 0,
  total: 0, remaining: 0, cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: 0,
  currentMessage: '', currentTarget: '', targets: [], messages: [],
  delayMs: DEFAULT_DELAY_SECONDS * 1000, logs: [], logId: 0,
  startedAt: null, workerAlive: false, lastBeat: 0,
  groupNameLock: '', groupPhotoLock: 'any',
};

const watcherState = {
  enabled: false, message: '', watchName: true, watchPhoto: true,
  intervalSec: 45, snapshots: {}, events: [], eventId: 0,
  stats: { nameChanges: 0, photoChanges: 0, sent: 0, failed: 0 },
  timer: null, lastCheck: 0,
};

const masterLock = { enabled: false, password: '', setAt: null };

function checkOwnerAuth(req) {
  if (!masterLock.enabled) return true;
  const key = req.headers['x-owner-key'] || (req.body && req.body.ownerKey) || req.query.ownerKey;
  return key === masterLock.password;
}

function pushLog(type, msg) {
  bulkState.logs.push({ id: ++bulkState.logId, ts: Date.now(), type, msg });
  if (bulkState.logs.length > 500) bulkState.logs.splice(0, bulkState.logs.length - 500);
  const icons = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function getGroupsFromStore() {
  const out = [];
  try {
    if (sock && sock.store && sock.store.groupMetadata) {
      sock.store.groupMetadata.forEach((v) => out.push({ id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 }));
    }
  } catch (_) {}
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isSocketReady() { return !!(sock && isPaired); }

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

async function groupHasPhoto(jid) {
  try { if (!sock) return false; return !!(await sock.profilePictureUrl(jid, 'image')); }
  catch (_) { return false; }
}

async function groupHasBlockedMember(jid, blockedNumbersJids) {
  try {
    if (!sock || !blockedNumbersJids || blockedNumbersJids.size === 0) return false;
    const meta = await sock.groupMetadata(jid);
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

function addWatcherEvent(jid, gname, type, oldVal, newVal, ok, err) {
  watcherState.events.push({ id: ++watcherState.eventId, ts: Date.now(), jid, gname, type, oldVal: oldVal || '', newVal: newVal || '', ok: !!ok, err: err || '' });
  if (watcherState.events.length > 300) watcherState.events.splice(0, watcherState.events.length - 300);
  const icon = type === 'name' ? '📝' : '📷';
  pushLog(ok ? 'ok' : 'err', `${icon} ${type} change in "${gname}"${ok ? ' → message sent' : ' → FAILED: ' + (err || '')}`);
}

async function buildGroupSnapshot() {
  const out = {};
  const jids = Object.keys(groupsCache).filter((j) => j.endsWith('@g.us'));
  for (const jid of jids) {
    const meta = groupsCache[jid];
    let photo = null;
    try { photo = await sock.profilePictureUrl(jid, 'image'); } catch (_) { photo = null; }
    out[jid] = { name: (meta && meta.name) || '', photo };
  }
  return out;
}

async function fireWatcherEvent(jid, type, oldVal, newVal) {
  const meta = groupsCache[jid];
  const gname = (meta && meta.name) || jid;
  let text = watcherState.message || '';
  if (!text.trim()) { pushLog('warn', `Watcher event in "${gname}" but no message set`); return; }
  text = text.replace(/\{\{group\}\}/g, gname).replace(/\{\{type\}\}/g, type === 'name' ? 'name' : 'photo')
             .replace(/\{\{old\}\}/g, oldVal || '—').replace(/\{\{new\}\}/g, newVal || '—');
  try {
    await sock.sendMessage(jid, { text });
    watcherState.stats.sent++;
    if (type === 'name') watcherState.stats.nameChanges++; else watcherState.stats.photoChanges++;
    addWatcherEvent(jid, gname, type, oldVal, newVal, true);
  } catch (e) { watcherState.stats.failed++; addWatcherEvent(jid, gname, type, oldVal, newVal, false, e.message); }
}

async function runWatcherCheck() {
  if (!watcherState.enabled || !isSocketReady()) return;
  try {
    const fresh = await buildGroupSnapshot();
    const old = watcherState.snapshots;
    for (const jid of Object.keys(fresh)) {
      const n = fresh[jid]; const o = old[jid];
      if (!o) continue;
      if (watcherState.watchName && o.name !== n.name && n.name) await fireWatcherEvent(jid, 'name', o.name, n.name);
      if (watcherState.watchPhoto && o.photo !== n.photo) await fireWatcherEvent(jid, 'photo', o.photo ? 'old-photo' : 'none', n.photo ? 'new-photo' : 'removed');
    }
    watcherState.snapshots = fresh; watcherState.lastCheck = Date.now();
  } catch (e) { pushLog('warn', 'Watcher check failed: ' + e.message); }
}

function startWatcherLoop() { if (watcherState.timer) clearInterval(watcherState.timer); watcherState.timer = setInterval(runWatcherCheck, watcherState.intervalSec * 1000); }
function stopWatcherLoop() { if (watcherState.timer) { clearInterval(watcherState.timer); watcherState.timer = null; } }

async function safeSend(jid, text) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SEND_RETRY; attempt++) {
    try {
      if (!isSocketReady()) throw new Error('socket not ready');
      await sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (attempt < SEND_RETRY) { pushLog('warn', `Retry → ${jid}: ${e.message}`); await sleep(RETRY_WAIT_MS); }
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown' };
}

async function runWorker() {
  if (bulkState.workerAlive) return;
  bulkState.workerAlive = true;
  pushLog('info', 'Worker started — 24/7 loop active');
  try {
    while (!bulkState.stopFlag) {
      if (!isSocketReady()) { bulkState.lastBeat = Date.now(); await sleep(3000); continue; }
      for (let mi = 0; mi < bulkState.messages.length && !bulkState.stopFlag; mi++) {
        const msg = bulkState.messages[mi];
        bulkState.msgIndex = mi; bulkState.currentMessage = msg;
        for (let ti = 0; ti < bulkState.targets.length && !bulkState.stopFlag; ti++) {
          const t = bulkState.targets[ti];
          bulkState.targetIndex = ti; bulkState.currentTarget = t.label; bulkState.lastBeat = Date.now();
          if (!isSocketReady()) { pushLog('warn', 'Socket unavailable — waiting'); break; }
          try {
            const res = await safeSend(t.jid, msg);
            if (res.ok) { bulkState.sent++; pushLog('ok', `Cycle ${bulkState.cycle + 1} | Msg ${mi + 1}/${bulkState.messages.length} → ${t.label}`); }
            else { bulkState.failed++; pushLog('err', `Msg ${mi + 1} → ${t.label}: ${res.error}`); }
          } catch (e) { bulkState.failed++; pushLog('err', `Error → ${t.label}: ${e.message}`); }
          bulkState.remaining = bulkState.messages.length - (mi + 1);
          if (!bulkState.stopFlag) await sleep(bulkState.delayMs);
        }
        if (!isSocketReady() && !bulkState.stopFlag) break;
      }
      if (!bulkState.stopFlag) {
        bulkState.cycle++; bulkState.remaining = bulkState.messages.length; bulkState.msgIndex = 0; bulkState.targetIndex = 0;
        pushLog('info', `Cycle ${bulkState.cycle} completed — restarting`);
      }
    }
  } catch (loopErr) {
    pushLog('err', 'Worker crashed: ' + loopErr.message);
    if (!bulkState.stopFlag) {
      bulkState.workerAlive = false; bulkState.running = true;
      setTimeout(() => runWorker(), 3000); return;
    }
  } finally {
    if (bulkState.stopFlag) {
      bulkState.running = false; bulkState.stopFlag = false; bulkState.workerAlive = false;
      bulkState.currentMessage = ''; bulkState.currentTarget = '';
      pushLog('info', `Stopped — Sent: ${bulkState.sent}, Failed: ${bulkState.failed}, Blocked: ${bulkState.blocked}, Cycles: ${bulkState.cycle}`);
    } else bulkState.workerAlive = false;
  }
}

setInterval(() => {
  if (bulkState.running && !bulkState.workerAlive) { pushLog('warn', 'Watchdog restart'); runWorker(); }
}, WATCHDOG_INTERVAL_MS);

async function connectToWhatsApp(phone) {
  if (!phone) throw new Error('Phone required');
  if (isConnecting) throw new Error('Already connecting');
  if (isPaired) throw new Error('Already paired');
  isConnecting = true; currentPhone = phone; pairingCode = null; lastError = null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['Ubuntu', 'Chrome', '20.0.04'], mobile: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('groups.upsert', (groups) => groups.forEach((g) => { groupsCache[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }; }));
    sock.ev.on('groups.update', (updates) => {
      updates.forEach((u) => {
        if (groupsCache[u.id]) { if (u.subject) groupsCache[u.id].name = u.subject; }
        else if (u.id) groupsCache[u.id] = { id: u.id, name: u.subject || '', size: 0 };
      });
      if (watcherState.enabled && watcherState.watchName) {
        updates.forEach((u) => {
          if (!u.subject || !u.id) return;
          const prev = watcherState.snapshots[u.id];
          if (prev && prev.name && prev.name !== u.subject) { const oldName = prev.name; prev.name = u.subject; fireWatcherEvent(u.id, 'name', oldName, u.subject); }
          else if (!prev) watcherState.snapshots[u.id] = { name: u.subject, photo: null };
        });
      }
    });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          await sleep(1000);
          pairingCode = await sock.requestPairingCode(phone);
          console.log(`\n📱 PAIRING CODE for ${phone}: ${pairingCode}\n`);
          pushLog('info', `Pairing code: ${pairingCode}`);
          if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
            try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `📱 *Pairing Code*\n\nNumber: \`${phone}\`\nCode: \`${pairingCode}\`\n\nWhatsApp → Linked Devices → Link with phone number`, { parse_mode: 'Markdown' }); } catch (_) {}
          }
          lastError = null;
        } catch (err) { lastError = err.message; pairingCode = null; pairingRequested = false; isConnecting = false; }
      }
      if (connection === 'open') {
        isPaired = true; pairingCode = null; pairingRequested = false; isConnecting = false;
        connectedAt = new Date().toISOString(); lastError = null;
        pushLog('ok', `WhatsApp connected (${phone})`);
        if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
          try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `✅ *WhatsApp Connected*\n\nNumber: \`${phone}\``, { parse_mode: 'Markdown' }); } catch (_) {}
        }
        setTimeout(() => { try { const gs = getGroupsFromStore(); gs.forEach((g) => { groupsCache[g.id] = g; }); pushLog('info', `Loaded ${gs.length} groups`); } catch (e) {} }, 3000);
        setTimeout(async () => { try { watcherState.snapshots = await buildGroupSnapshot(); pushLog('info', `Watcher snapshot ready (${Object.keys(watcherState.snapshots).length} groups)`); } catch (_) {} }, 5000);
        if (bulkState.running && !bulkState.workerAlive) { pushLog('info', 'Reconnect — resuming worker'); runWorker(); }
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        pushLog('warn', `Connection closed (${statusCode})`);
        isPaired = false; isConnecting = false;
        if (shouldReconnect && currentPhone) { pairingRequested = false; setTimeout(() => connectToWhatsApp(currentPhone).catch(console.error), 3000); }
        else if (statusCode === DisconnectReason.loggedOut) {
          pairingCode = null; pairingRequested = false; currentPhone = null;
          if (bulkState.running) { bulkState.stopFlag = true; pushLog('warn', 'Logged out — stopping worker'); }
        }
      }
    });
  } catch (err) { isConnecting = false; lastError = err.message; throw err; }
}

// ============================================================
// EMBEDDED HTML
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Yamdhud Ata Ke RK Raja XWD</title>
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
  .brand h1{font-size:clamp(18px,3.5vw,32px);font-weight:900;letter-spacing:3px;background:linear-gradient(180deg,#ffffff 0%,#c9ffdc 45%,#00ff88 130%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 26px rgba(0,255,136,.45);font-family:"Orbitron","Rajdhani",sans-serif;text-transform:uppercase}
  .brand h1 .x{color:#00ff88;-webkit-text-fill-color:#00ff88;text-shadow:0 0 18px #00ff88}
  .brand p{color:#6e9c7e;font-size:11px;letter-spacing:3px;margin-top:6px;text-transform:uppercase}
  .tabs{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;justify-content:center}
  .tab{padding:11px 20px;border-radius:12px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(0,255,136,.35);background:rgba(0,255,136,.05);color:#4be896;transition:.2s}
  .tab.active{background:linear-gradient(180deg,#00ff88,#00a854);color:#021007;border-color:#00ff88;box-shadow:0 8px 24px rgba(0,255,136,.35),inset 0 1px 0 rgba(255,255,255,.25)}
  .tab:hover:not(.active){background:rgba(0,255,136,.12)}
  .panel{display:none}.panel.active{display:block;animation:fade .3s ease}
  @keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .layout{display:grid;grid-template-columns:420px 1fr;gap:20px}
  @media(max-width:900px){.layout{grid-template-columns:1fr}}
  .card{position:relative;background:linear-gradient(155deg, rgba(20,30,24,.85), rgba(8,18,12,.7));border:1px solid rgba(0,255,136,.28);border-radius:18px;padding:24px;margin-bottom:20px;backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);box-shadow:0 20px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05),0 0 32px rgba(0,255,136,.06)}
  .card::before{content:"";position:absolute;inset:-1px;border-radius:18px;padding:1px;background:linear-gradient(135deg, rgba(0,255,136,.55), transparent 40%, transparent 60%, rgba(0,255,136,.35));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;opacity:.7}
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase}
  .card h2 .dot{width:8px;height:8px;border-radius:50%;background:#00ff88;box-shadow:0 0 12px #00ff88}
  label{display:block;font-size:11px;color:#8fbca0;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea,select{width:100%;background:rgba(2,16,7,.75);border:1px solid rgba(0,255,136,.25);border-radius:12px;padding:12px 14px;color:#eaffef;font-size:14px;font-family:inherit;outline:none;transition:.25s}
  input:focus,textarea:focus,select:focus{border-color:#00ff88;box-shadow:0 0 0 3px rgba(0,255,136,.14),0 0 22px rgba(0,255,136,.25)}
  input:disabled{color:#4a6a55;cursor:not-allowed}
  textarea{resize:vertical;min-height:96px}
  .field{margin-bottom:14px}
  button{background:linear-gradient(180deg,#00ff88,#00a854);color:#021007;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:.22s;margin-top:6px;width:100%;box-shadow:0 8px 24px rgba(0,255,136,.28),inset 0 1px 0 rgba(255,255,255,.25)}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 30px rgba(0,255,136,.45)}
  button:disabled{background:#1a2a22;color:#4a6a55;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid rgba(0,255,136,.5);color:#4be896;box-shadow:none}
  button.ghost:hover:not(:disabled){background:rgba(0,255,136,.1)}
  button.danger{background:linear-gradient(180deg,#ff4040,#a80000);color:#fff;border:1px solid #ff4040}
  .btnrow{display:flex;gap:10px}.btnrow button{margin-top:0}
  .status-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap}
  .badge{display:inline-block;padding:7px 16px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .b-idle{background:rgba(120,140,130,.15);color:#a8c8b4;border:1px solid rgba(120,140,130,.35)}
  .b-wait{background:rgba(255,200,0,.12);color:#ffd655;border:1px solid rgba(255,200,0,.4);animation:pulse 1.6s infinite}
  .b-paired{background:rgba(0,255,136,.14);color:#4be896;border:1px solid rgba(0,255,136,.55);box-shadow:0 0 18px rgba(0,255,136,.25)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  .code-box{background:rgba(2,16,7,.85);border:2px dashed #00ff88;border-radius:16px;padding:26px 20px;margin:18px 0;text-align:center;box-shadow:inset 0 0 40px rgba(0,255,136,.12),0 0 30px rgba(0,255,136,.15)}
  .code-label{font-size:11px;color:#8fbca0;letter-spacing:3px;margin-bottom:12px;text-transform:uppercase}
  .code-value{font-size:38px;font-weight:900;letter-spacing:8px;color:#00ff88;font-family:'Courier New',monospace;text-shadow:0 0 24px rgba(0,255,136,.7)}
  .code-value.loading{font-size:16px;letter-spacing:0;color:#8fbca0;font-style:italic;text-shadow:none}
  .steps{background:rgba(2,16,7,.6);border:1px solid rgba(0,255,136,.18);border-radius:12px;padding:16px 18px;font-size:13px;line-height:1.95;color:#c3e8ce}
  .steps b{color:#fff}
  .msg{margin-top:14px;padding:12px 15px;border-radius:10px;font-size:13px;display:none;letter-spacing:.4px}
  .msg.ok{background:rgba(0,255,136,.1);color:#7ff5b3;border:1px solid rgba(0,255,136,.4);display:block}
  .msg.err{background:rgba(255,80,80,.1);color:#ffa1a1;border:1px solid rgba(255,80,80,.4);display:block}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:520px){.grid2{grid-template-columns:1fr}}
  .stat{background:rgba(2,16,7,.7);border:1px solid rgba(0,255,136,.2);border-radius:14px;padding:14px 16px;text-align:center}
  .stat .k{font-size:10px;color:#8fbca0;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .stat .v{font-size:22px;font-weight:900;color:#fff;text-shadow:0 0 14px rgba(0,255,136,.35);word-break:break-all}
  .stat .v.green{color:#00ff88;text-shadow:0 0 14px rgba(0,255,136,.5)}
  .stat .v.red{color:#ff5252}
  .stat .v.small{font-size:14px;font-weight:700}
  .statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
  @media(max-width:520px){.statgrid{grid-template-columns:1fr 1fr}}
  .log{background:#000;border:1px solid rgba(0,255,136,.25);border-radius:14px;padding:14px;height:340px;overflow-y:auto;font-family:'Courier New',monospace;font-size:12px;line-height:1.75;box-shadow:inset 0 0 40px rgba(0,255,136,.08)}
  .log::-webkit-scrollbar{width:8px}.log::-webkit-scrollbar-track{background:#04120a}.log::-webkit-scrollbar-thumb{background:#00ff88;border-radius:8px}
  .log .line{color:#8fbca0;border-bottom:1px dashed rgba(255,255,255,.04);padding:2px 0;word-break:break-all}
  .log .t{color:#4be896;margin-right:8px}
  .log .ok{color:#00ff88}.log .err{color:#ff6b6b}.log .info{color:#7fd0ff}.log .warn{color:#ffd655}
  .progress{height:8px;background:rgba(2,16,7,.8);border-radius:99px;overflow:hidden;border:1px solid rgba(0,255,136,.25);margin-top:12px}
  .progress>div{height:100%;width:0%;background:linear-gradient(90deg,#00ff88,#4be896,#00ff88);background-size:200% 100%;transition:width .4s ease;animation:shine 2s linear infinite}
  @keyframes shine{0%{background-position:0 0}100%{background-position:200% 0}}
  .groups-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .groups-toolbar button{width:auto;margin-top:0;padding:10px 16px;font-size:11px}
  .groups-toolbar .count{font-size:12px;color:#8fbca0;margin-left:auto;letter-spacing:1px}
  .groups-list{background:rgba(2,16,7,.6);border:1px solid rgba(0,255,136,.2);border-radius:14px;max-height:360px;overflow-y:auto;padding:8px}
  .groups-list::-webkit-scrollbar{width:8px}.groups-list::-webkit-scrollbar-track{background:#04120a}.groups-list::-webkit-scrollbar-thumb{background:#00ff88;border-radius:8px}
  .group-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:.15s;border:1px solid transparent}
  .group-item:hover{background:rgba(0,255,136,.08);border-color:rgba(0,255,136,.25)}
  .group-item.selected{background:rgba(0,255,136,.14);border-color:#00ff88}
  .group-item input[type=checkbox]{width:18px;height:18px;accent-color:#00ff88;cursor:pointer;flex-shrink:0}
  .group-info{flex:1;min-width:0}
  .group-name{color:#eaffef;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .group-jid{color:#4a6a55;font-size:11px;font-family:'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .group-meta{color:#4be896;font-size:10px;letter-spacing:1px;text-transform:uppercase;flex-shrink:0}
  .hidden{display:none!important}
  .hint{font-size:11px;color:#4a6a55;margin-top:8px;letter-spacing:.5px}
  .empty{padding:30px 20px;text-align:center;color:#4a6a55;font-size:13px}
  .footer{text-align:center;color:#2f4a3a;font-size:11px;letter-spacing:3px;margin-top:30px;text-transform:uppercase}
  .queue-box{background:rgba(2,16,7,.7);border:1px solid rgba(0,255,136,.25);border-radius:12px;padding:12px 14px;margin-top:8px;font-size:12px;color:#c3e8ce;max-height:140px;overflow-y:auto;font-family:'Courier New',monospace;line-height:1.6}
  .queue-box .qi{color:#7fd0ff;margin-right:8px}
  .lock-badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;background:rgba(0,255,136,.15);color:#4be896;border:1px solid rgba(0,255,136,.45);margin-left:8px}
  .block-badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;background:rgba(255,80,80,.15);color:#ff8888;border:1px solid rgba(255,80,80,.45);margin-left:8px}
  .num-chip{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;background:rgba(0,255,136,.12);color:#4be896;border:1px solid rgba(0,255,136,.4);margin:2px 4px 2px 0;font-family:'Courier New',monospace}
  .blk-chip{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;background:rgba(255,80,80,.1);color:#ff8888;border:1px solid rgba(255,80,80,.4);margin:2px 4px 2px 0;font-family:'Courier New',monospace}
  .trigger-info{background:rgba(0,255,136,.06);border:1px dashed rgba(0,255,136,.35);border-radius:10px;padding:10px 12px;font-size:11px;color:#4be896;margin-bottom:12px;letter-spacing:.4px;line-height:1.5}
  .checkline{display:flex;align-items:center;gap:6px;font-size:12px;color:#c3e8ce;text-transform:none;letter-spacing:0;margin-bottom:0}
  .checkline input[type=checkbox]{width:16px;height:16px;accent-color:#00ff88}
  .danger-zone{border-color:rgba(255,80,80,.4)!important;background:linear-gradient(155deg, rgba(40,15,15,.7), rgba(20,8,8,.55))!important}
  .danger-zone::before{background:linear-gradient(135deg, rgba(255,80,80,.55), transparent 40%, transparent 60%, rgba(255,80,80,.35))!important}
  .danger-zone h2 .dot{background:#ff5252!important;box-shadow:0 0 12px #ff5252!important}
  .tg-banner{background:linear-gradient(90deg, rgba(0,136,204,.15), rgba(0,136,204,.05));border:1px solid rgba(0,136,204,.4);border-radius:12px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px;font-size:12px;color:#7dd3fc;letter-spacing:.5px}
  .tg-banner .tg-dot{width:8px;height:8px;border-radius:50%;background:#0088cc;box-shadow:0 0 12px #0088cc;flex-shrink:0}
</style>
</head>
<body>
<div class="streaks"><span></span><span></span><span></span><span></span></div>
<div class="container">
  <div class="brand">
    <h1>Yamdhud Ata Ke <span class="x">RK Raja XWD</span></h1>
    <p>WhatsApp + Telegram Control Center</p>
  </div>

  <div class="tg-banner">
    <span class="tg-dot"></span>
    <span>🤖 Telegram bot active — <b>@BotFather</b> se bot banao aur commands bhejo</span>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="dashboard" onclick="switchTab('dashboard')">Dashboard</div>
    <div class="tab" data-tab="sender" onclick="switchTab('sender')">Bulk Sender</div>
  </div>
  <div class="panel active" id="panel-dashboard">
    <div class="card">
      <div class="status-row">
        <h2 style="margin:0"><span class="dot"></span>Connection Status</h2>
        <span id="badge" class="badge b-idle">Idle</span>
      </div>
      <div class="grid2">
        <div class="stat"><div class="k">Number</div><div class="v" id="infoPhone">—</div></div>
        <div class="stat"><div class="k">Connected At</div><div class="v" id="infoTime">—</div></div>
      </div>
      <div id="errBox" class="msg err hidden"></div>
    </div>
    <div class="card" id="pairCard">
      <h2><span class="dot"></span>Pair WhatsApp</h2>
      <label>Phone Number (country code, no + or spaces)</label>
      <input id="phoneInput" type="tel" placeholder="e.g. 919876543210"/>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="codeSection" class="hidden">
        <div class="code-box">
          <div class="code-label">Your Pairing Code</div>
          <div id="codeValue" class="code-value loading">Generating...</div>
        </div>
        <div class="steps"><b>Steps:</b><br/>1. Open WhatsApp<br/>2. Go to <b>Linked Devices</b><br/>3. <b>Link a Device</b> → <b>Link with phone number</b><br/>4. Enter the code above</div>
      </div>
      <div id="pairMsg" class="msg"></div>
    </div>
    <div class="card" id="groupsCard">
      <h2><span class="dot"></span>Your WhatsApp Groups</h2>
      <div class="groups-toolbar">
        <button class="ghost" id="refreshGroupsBtn" onclick="fetchGroups()">Refresh Groups</button>
        <button class="ghost" onclick="selectAllGroups()">Select All</button>
        <button class="ghost" onclick="clearGroupSelection()">Clear</button>
        <span class="count" id="groupsCount">0 groups</span>
      </div>
      <div class="groups-list" id="groupsList"><div class="empty">Pair WhatsApp first, then click "Refresh Groups"</div></div>
      <div class="field" style="margin-top:16px">
        <label>Message to send to selected groups</label>
        <textarea id="groupMsgInput" placeholder="Enter message to send..."></textarea>
      </div>
      <button id="groupSendBtn" onclick="sendToSelectedGroups()">Send to Selected Groups</button>
      <div id="groupSendMsg" class="msg"></div>
    </div>
    <div class="card danger-zone">
      <h2><span class="dot"></span>Danger Zone</h2>
      <p class="hint">Logout deletes auth — you'll need to pair again.</p>
      <button class="ghost" onclick="logout()">Logout / Reset</button>
    </div>
  </div>
  <div class="panel" id="panel-sender">
    <div class="layout">
      <div>
        <div class="card">
          <h2><span class="dot"></span>🔐 Master Lock (Owner Only)</h2>
          <div class="trigger-info">Lock ON → sirf <b>aap</b> (owner key ke saath) bulk start/stop/pair/logout kar paoge. Baaki sab <b>401 reject</b>.</div>
          <div id="lockStatusBox" class="hint" style="margin-bottom:10px">Status: <b style="color:#ffd655">OFF</b></div>
          <div id="lockSetSection">
            <div class="field"><label>Set Owner Password (min 4 chars)</label><input id="lockPwdInput" type="password" placeholder="Owner password"/></div>
            <button onclick="enableLock()">🔐 Enable Lock</button>
          </div>
          <div id="lockUnlockSection" style="display:none">
            <div class="field"><label>Enter Owner Password to Unlock</label><input id="lockPwdInput2" type="password" placeholder="Owner password"/></div>
            <button class="danger" onclick="disableLock()">🔓 Unlock</button>
          </div>
          <div id="lockMsg" class="msg"></div>
        </div>
        <div class="card">
          <h2><span class="dot"></span>Message Queue & Targets</h2>
          <div class="field">
            <label>Upload Messages File (.txt) — each line = one message</label>
            <input id="fileInput" type="file" accept=".txt"/>
            <div class="hint" id="fileHint">No file chosen</div>
            <div class="queue-box" id="queuePreview" style="display:none"></div>
          </div>
          <div class="field">
            <label>Send to Groups (fetch & pick)</label>
            <div class="groups-toolbar" style="margin-bottom:8px">
              <button class="ghost" onclick="fetchGroupsForBulk()">Fetch Groups</button>
              <button class="ghost" onclick="selectAllBulkGroups()">All</button>
              <button class="ghost" onclick="clearBulkGroups()">Clear</button>
              <span class="count" id="bulkGroupsCount">0 selected</span>
            </div>
            <div class="groups-list" id="bulkGroupsList" style="max-height:200px"><div class="empty">Click "Fetch Groups" to load</div></div>
          </div>
          <div class="field">
            <label>🔒 Group Name Lock (optional)</label>
            <input id="groupLockInput" type="text" placeholder="e.g. YAMDHUD (leave empty = all selected)"/>
            <div class="hint">Sirf unhi groups me jayega jinke naam me ye text hoga.</div>
          </div>
          <div class="field">
            <label>🖼️ Group Profile Photo Lock</label>
            <select id="photoLockInput">
              <option value="any">Any — don't care</option>
              <option value="has">Only groups WITH profile photo</option>
              <option value="none">Only groups WITHOUT profile photo</option>
            </select>
          </div>
          <div class="field">
            <label>📱 Send to Phone Numbers OR Group UIDs (auto-filled on select)</label>
            <textarea id="numbersInput" placeholder="Multiple numbers — ek line me ek:&#10;919876543210&#10;918765432109&#10;917654321098&#10;Group UID auto aayega jab select karoge."></textarea>
            <div class="hint">Multiple numbers — ek line me ek ya comma se. Group select karoge to UID khud aa jayenge.</div>
            <div id="numbersPreview" style="margin-top:6px"></div>
          </div>
          <div class="field" style="border-top:1px dashed rgba(255,80,80,.35);padding-top:14px;margin-top:6px">
            <label style="color:#ff8888">🚫 BLOCKED NUMBERS (message nahi jayega)</label>
            <textarea id="blockedNumbersInput" placeholder="919876543210&#10;919876543211"></textarea>
            <div class="hint" style="color:#ff8888">Ye numbers skip honge. Agar kisi group me member hai, us group me bhi nahi jayega.</div>
            <div id="blockedNumbersPreview" style="margin-top:6px"></div>
          </div>
          <div class="field">
            <label style="color:#ff8888">🚫 BLOCKED GROUP UIDs (skip these groups)</label>
            <textarea id="blockedGroupsInput" placeholder="1203630xxxxxxxx@g.us&#10;1203630yyyyyyyy@g.us"></textarea>
            <div id="blockedGroupsPreview" style="margin-top:6px"></div>
          </div>
          <div class="field">
            <label>Hater Name (optional prefix)</label>
            <input id="haterInput" type="text" placeholder="e.g. RK RAJA XWD"/>
          </div>
          <div class="field">
            <label>Delay (seconds) — minimum 3s</label>
            <input id="delayInput" type="number" min="3" value="10"/>
          </div>
          <div class="field">
            <label>Last Hater Name (optional suffix)</label>
            <input id="lastHaterInput" type="text" placeholder="e.g. YAMDHUD"/>
          </div>
          <div class="btnrow">
            <button id="startBtn" onclick="startServer()">Start Server</button>
            <button id="stopBtn" class="danger" onclick="stopTask()" disabled>Emergency Stop</button>
          </div>
        </div>
        <div class="card">
          <h2><span class="dot"></span>🔔 Group Change Watcher</h2>
          <div class="trigger-info">Jab koi group ka <b>naam</b> ya <b>photo</b> change karega, neeche diya message automatically usi group me bhej diya jayega.</div>
          <div class="field">
            <label style="display:flex;gap:16px;margin-bottom:8px">
              <span class="checkline"><input type="checkbox" id="watchNameChk" checked/> 📝 Watch Name</span>
              <span class="checkline"><input type="checkbox" id="watchPhotoChk" checked/> 📷 Watch Photo</span>
            </label>
          </div>
          <div class="field">
            <label>Event Message</label>
            <textarea id="watchMsgInput" placeholder="Group {{group}} ka {{type}} change ho gaya!&#10;Old: {{old}}&#10;New: {{new}}"></textarea>
            <div class="hint">Variables: <b>{{group}}</b>, <b>{{type}}</b>, <b>{{old}}</b>, <b>{{new}}</b></div>
          </div>
          <div class="grid2">
            <div><label style="font-size:10px">Interval (sec, min 15)</label><input id="watchIntervalInput" type="number" min="15" value="45"/></div>
            <div style="display:flex;gap:8px;align-items:flex-end">
              <button id="watchStartBtn" onclick="startWatcher()">🔒 Enable</button>
              <button id="watchStopBtn" class="danger" onclick="stopWatcher()" disabled>Disable</button>
            </div>
          </div>
          <div class="hint" id="watchStatusHint" style="margin-top:10px">Watcher: OFF</div>
          <div class="queue-box" id="watchEventBox" style="display:none;max-height:180px"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h2><span class="dot"></span>Live Stats</h2>
          <div class="statgrid">
            <div class="stat"><div class="k">Status</div><div class="v" id="statStatus">Idle</div></div>
            <div class="stat"><div class="k">Paired</div><div class="v" id="statPaired">—</div></div>
            <div class="stat"><div class="k">Uptime</div><div class="v green" id="statUptime">00:00:00</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Sent</div><div class="v green" id="statSent">0</div></div>
            <div class="stat"><div class="k">Failed</div><div class="v red" id="statFailed">0</div></div>
            <div class="stat"><div class="k">Cycle</div><div class="v" id="statCycle">0</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Messages</div><div class="v" id="statTotal">0</div></div>
            <div class="stat"><div class="k">Remaining</div><div class="v" id="statRemaining">0</div></div>
            <div class="stat"><div class="k">Progress</div><div class="v" id="statProgress">0%</div></div>
          </div>
          <div class="statgrid">
            <div class="stat"><div class="k">Targets</div><div class="v" id="statTargets">0</div></div>
            <div class="stat"><div class="k">Blocked</div><div class="v red" id="statBlocked">0</div></div>
            <div class="stat"><div class="k">Filtered</div><div class="v small" id="statFiltered">0</div></div>
          </div>
          <div class="progress"><div id="progBar"></div></div>
        </div>
        <div class="card">
          <h2><span class="dot"></span>Live Log</h2>
          <div class="log" id="logBox"><div class="line"><span class="t">[boot]</span> Waiting for commands...</div></div>
          <div class="btnrow" style="margin-top:12px">
            <button class="ghost" onclick="clearLog()">Clear Log</button>
            <button class="danger" onclick="stopTask()">Stop Task</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="footer">Yamdhud Ata Ke RK Raja XWD © — Secure Session</div>
</div>
<script>
function switchTab(name){document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));}
function showMsg(el,type,text){el.textContent=text;el.style.display=type?'block':'none';el.className='msg'+(type?' '+type:'');}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clearLog(){document.getElementById('logBox').innerHTML='';}
function log(type,msg){const box=document.getElementById('logBox');const t=new Date().toLocaleTimeString();const el=document.createElement('div');el.className='line '+type;el.innerHTML='<span class="t">['+t+']</span>'+escapeHtml(msg);box.appendChild(el);box.scrollTop=box.scrollHeight;while(box.children.length>500)box.removeChild(box.firstChild);}
let ownerKey=localStorage.getItem('ownerKey')||'';
function authHeaders(extra){const h=Object.assign({},extra||{});if(ownerKey)h['X-Owner-Key']=ownerKey;return h;}
async function refreshLockStatus(){try{const res=await fetch('/api/lock/status');const d=await res.json();const box=document.getElementById('lockStatusBox');const setSec=document.getElementById('lockSetSection');const unSec=document.getElementById('lockUnlockSection');if(!box)return;if(d.enabled){box.innerHTML='Status: <b style="color:#00ff88">🔐 LOCKED</b>'+(ownerKey?' (key saved)':'');setSec.style.display='none';unSec.style.display='block';}else{box.innerHTML='Status: <b style="color:#ffd655">OFF</b>';setSec.style.display='block';unSec.style.display='none';}}catch(e){}}
async function enableLock(){const pwd=document.getElementById('lockPwdInput').value;const msg=document.getElementById('lockMsg');if(!pwd||pwd.length<4){showMsg(msg,'err','Password min 4 characters');return;}try{const res=await fetch('/api/lock/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});const d=await res.json();if(!d.success)throw new Error(d.error);ownerKey=pwd;localStorage.setItem('ownerKey',pwd);showMsg(msg,'ok','🔐 Lock ENABLED');log('ok','🔐 Lock ON');document.getElementById('lockPwdInput').value='';refreshLockStatus();}catch(e){showMsg(msg,'err',e.message);}}
async function disableLock(){const pwd=document.getElementById('lockPwdInput2').value;const msg=document.getElementById('lockMsg');if(!pwd){showMsg(msg,'err','Enter password');return;}try{const res=await fetch('/api/lock/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});const d=await res.json();if(!d.success)throw new Error(d.error);ownerKey='';localStorage.removeItem('ownerKey');showMsg(msg,'ok','🔓 Lock disabled');log('warn','🔓 Lock OFF');document.getElementById('lockPwdInput2').value='';refreshLockStatus();}catch(e){showMsg(msg,'err',e.message);}}
async function startPair(){const phone=document.getElementById('phoneInput').value.trim();const btn=document.getElementById('pairBtn');const msgEl=document.getElementById('pairMsg');const codeSection=document.getElementById('codeSection');if(!phone||!/^\\d{10,15}$/.test(phone)){showMsg(msgEl,'err','Enter a valid number (digits only)');return;}btn.disabled=true;btn.textContent='Starting...';showMsg(msgEl,'','');try{const res=await fetch('/api/pair',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({phone})});const data=await res.json();if(!data.success)throw new Error(data.error||'Failed');codeSection.classList.remove('hidden');document.getElementById('codeValue').textContent='Generating...';document.getElementById('codeValue').classList.add('loading');showMsg(msgEl,'ok','Pairing started — code appears shortly');}catch(e){showMsg(msgEl,'err',e.message);}finally{btn.disabled=false;btn.textContent='Get Pairing Code';}}
async function logout(){if(!confirm('Logout? Auth will be deleted.'))return;try{await fetch('/api/logout',{method:'POST',headers:authHeaders()});location.reload();}catch(e){alert(e.message);}}
let allGroups=[];let dashSelected=new Set();let bulkSelected=new Set();
async function fetchGroups(){const btn=document.getElementById('refreshGroupsBtn');const listEl=document.getElementById('groupsList');btn.disabled=true;btn.textContent='Fetching...';listEl.innerHTML='<div class="empty">Loading groups...</div>';try{const res=await fetch('/api/groups');const d=await res.json();if(!d.success)throw new Error(d.error||'Failed');allGroups=d.groups||[];renderDashGroups();renderBulkGroups();log('info','Fetched '+allGroups.length+' groups');}catch(e){listEl.innerHTML='<div class="empty" style="color:#ff8888">'+escapeHtml(e.message)+'</div>';log('err','Fetch groups: '+e.message);}finally{btn.disabled=false;btn.textContent='Refresh Groups';}}
function renderDashGroups(){const listEl=document.getElementById('groupsList');document.getElementById('groupsCount').textContent=allGroups.length+' groups';if(!allGroups.length){listEl.innerHTML='<div class="empty">No groups found</div>';return;}listEl.innerHTML=allGroups.map(g=>{const sel=dashSelected.has(g.id)?' selected':'';const checked=dashSelected.has(g.id)?' checked':'';return '<label class="group-item'+sel+'" data-jid="'+escapeHtml(g.id)+'"><input type="checkbox"'+checked+' onchange="toggleDashGroup(\\''+escapeHtml(g.id)+'\\',this.checked)"/><div class="group-info"><div class="group-name">'+escapeHtml(g.name||'(no name)')+'</div><div class="group-jid">'+escapeHtml(g.id)+'</div></div><div class="group-meta">'+(g.size?g.size+' m':'')+'</div></label>';}).join('');}
function toggleDashGroup(jid,checked){if(checked)dashSelected.add(jid);else dashSelected.delete(jid);document.querySelectorAll('#groupsList .group-item').forEach(el=>{if(el.dataset.jid===jid)el.classList.toggle('selected',checked);});}
function selectAllGroups(){allGroups.forEach(g=>dashSelected.add(g.id));renderDashGroups();}
function clearGroupSelection(){dashSelected.clear();renderDashGroups();}
async function sendToSelectedGroups(){const msg=document.getElementById('groupMsgInput').value.trim();const box=document.getElementById('groupSendMsg');const btn=document.getElementById('groupSendBtn');if(!dashSelected.size){showMsg(box,'err','Select at least one group');return;}if(!msg){showMsg(box,'err','Enter a message');return;}btn.disabled=true;btn.textContent='Sending...';showMsg(box,'','');try{const res=await fetch('/api/send-groups',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({groupIds:[...dashSelected],message:msg})});const d=await res.json();if(!d.success)throw new Error(d.error||'Failed');showMsg(box,'ok','Sent to '+d.sent+'/'+d.total+' groups'+(d.failed?' ('+d.failed+' failed)':''));log('ok','Group send: '+d.sent+'/'+d.total);if(d.errors&&d.errors.length)d.errors.forEach(e=>log('err',e));}catch(e){showMsg(box,'err',e.message);log('err','Group send: '+e.message);}finally{btn.disabled=false;btn.textContent='Send to Selected Groups';}}
async function fetchGroupsForBulk(){if(allGroups.length){renderBulkGroups();return;}await fetchGroups();}
function renderBulkGroups(){const listEl=document.getElementById('bulkGroupsList');document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';if(!allGroups.length){listEl.innerHTML='<div class="empty">No groups loaded. Click "Fetch Groups"</div>';return;}listEl.innerHTML=allGroups.map(g=>{const sel=bulkSelected.has(g.id)?' selected':'';const checked=bulkSelected.has(g.id)?' checked':'';return '<label class="group-item'+sel+'" data-jid="'+escapeHtml(g.id)+'"><input type="checkbox"'+checked+' onchange="toggleBulkGroup(\\''+escapeHtml(g.id)+'\\',this.checked)"/><div class="group-info"><div class="group-name">'+escapeHtml(g.name||'(no name)')+'</div><div class="group-jid">'+escapeHtml(g.id)+'</div></div><div class="group-meta">'+(g.size?g.size+' m':'')+'</div></label>';}).join('');syncNumbersWithGroups();}
function toggleBulkGroup(jid,checked){if(checked)bulkSelected.add(jid);else bulkSelected.delete(jid);document.getElementById('bulkGroupsCount').textContent=bulkSelected.size+' selected';document.querySelectorAll('#bulkGroupsList .group-item').forEach(el=>{if(el.dataset.jid===jid)el.classList.toggle('selected',checked);});syncNumbersWithGroups();}
function selectAllBulkGroups(){allGroups.forEach(g=>bulkSelected.add(g.id));renderBulkGroups();syncNumbersWithGroups();}
function clearBulkGroups(){bulkSelected.clear();renderBulkGroups();syncNumbersWithGroups();}
function syncNumbersWithGroups(){const ta=document.getElementById('numbersInput');if(!ta)return;const uids=[...bulkSelected];const currentVal=ta.value.trim();const looksAuto=currentVal===''||currentVal.split(/\\s+/).every(x=>/@g\\.us$/i.test(x));if(!looksAuto)return;ta.value=uids.join('\\n');updateNumbersPreview();}
function updateNumbersPreview(){const raw=document.getElementById('numbersInput').value||'';const nums=[];const seen=new Set();raw.split(/[\\r\\n,;\\s]+/).forEach(tok=>{const t=tok.trim();if(!t)return;if(seen.has(t))return;seen.add(t);nums.push(t);});const box=document.getElementById('numbersPreview');if(!box)return;if(!nums.length){box.innerHTML='';return;}box.innerHTML='<span class="lock-badge">'+nums.length+' targets</span> '+nums.slice(0,8).map(n=>{if(/@g\\.us$/i.test(n))return '<span class="num-chip">[G] '+escapeHtml(n.split('@')[0])+'</span>';return '<span class="num-chip">+'+escapeHtml(n.replace(/[^\\d]/g,''))+'</span>';}).join('')+(nums.length>8?'<span class="num-chip">+more</span>':'');}
function updateBlockedNumbersPreview(){const raw=document.getElementById('blockedNumbersInput').value||'';const nums=[];const seen=new Set();raw.split(/[\\r\\n,;\\s]+/).forEach(tok=>{const t=tok.trim();if(!t)return;if(seen.has(t))return;seen.add(t);nums.push(t);});const box=document.getElementById('blockedNumbersPreview');if(!box)return;if(!nums.length){box.innerHTML='';return;}box.innerHTML='<span class="block-badge">🚫 '+nums.length+' blocked</span> '+nums.slice(0,8).map(n=>'<span class="blk-chip">+'+escapeHtml(n.replace(/[^\\d]/g,''))+'</span>').join('')+(nums.length>8?'<span class="blk-chip">+more</span>':'');}
function updateBlockedGroupsPreview(){const raw=document.getElementById('blockedGroupsInput').value||'';const uids=[];const seen=new Set();raw.split(/[\\r\\n,;\\s]+/).forEach(tok=>{const t=tok.trim();if(!t)return;if(seen.has(t))return;seen.add(t);uids.push(t);});const box=document.getElementById('blockedGroupsPreview');if(!box)return;if(!uids.length){box.innerHTML='';return;}box.innerHTML='<span class="block-badge">🚫 '+uids.length+' groups</span> '+uids.slice(0,6).map(n=>'<span class="blk-chip">'+escapeHtml(n.split('@')[0])+'</span>').join('')+(uids.length>6?'<span class="blk-chip">+more</span>':'');}
document.getElementById('fileInput').addEventListener('change',async (e)=>{const f=e.target.files[0];document.getElementById('fileHint').textContent=f?f.name:'No file chosen';const box=document.getElementById('queuePreview');if(!f){box.style.display='none';return;}try{const text=await f.text();const seen=new Set();const msgs=[];text.split(/\\r?\\n/).forEach(line=>{const t=line.trim();if(!t)return;if(seen.has(t))return;seen.add(t);msgs.push(t);});if(!msgs.length){box.style.display='none';return;}box.style.display='block';box.innerHTML='<div style="color:#8fbca0;margin-bottom:6px">Queue ('+msgs.length+' messages)</div>'+msgs.map((m,i)=>'<div><span class="qi">'+(i+1)+'.</span>'+escapeHtml(m.slice(0,80))+(m.length>80?'…':'')+'</div>').join('');}catch(_){box.style.display='none';}});
document.getElementById('numbersInput').addEventListener('input',updateNumbersPreview);
document.getElementById('blockedNumbersInput').addEventListener('input',updateBlockedNumbersPreview);
document.getElementById('blockedGroupsInput').addEventListener('input',updateBlockedGroupsPreview);
async function startServer(){
  const file=document.getElementById('fileInput').files[0];
  const hater=document.getElementById('haterInput').value.trim();
  let delay=parseInt(document.getElementById('delayInput').value)||10;if(delay<3)delay=3;
  const lastHater=document.getElementById('lastHaterInput').value.trim();
  const groupLock=document.getElementById('groupLockInput').value.trim();
  const photoLock=document.getElementById('photoLockInput').value;
  const numbersRaw=document.getElementById('numbersInput').value.trim();
  const blockedNumbers=document.getElementById('blockedNumbersInput').value.trim();
  const blockedGroups=document.getElementById('blockedGroupsInput').value.trim();
  if(!file){alert('Please upload a .txt file');return;}
  const hasGroups=bulkSelected.size>0;const hasNumbers=numbersRaw.length>0;
  if(!hasGroups&&!hasNumbers){alert('Select at least one group OR enter a phone number');return;}
  const startBtn=document.getElementById('startBtn');const stopBtn=document.getElementById('stopBtn');
  startBtn.disabled=true;startBtn.textContent='Starting...';
  const fd=new FormData();
  fd.append('file',file);fd.append('hater',hater);fd.append('delay',String(delay));
  fd.append('lastHater',lastHater);fd.append('groupIds',JSON.stringify([...bulkSelected]));
  fd.append('numbers',numbersRaw);fd.append('groupNameLock',groupLock);fd.append('groupPhotoLock',photoLock);
  fd.append('blockedNumbers',blockedNumbers);fd.append('blockedGroups',blockedGroups);
  log('info','Starting bulk task...');
  try{const res=await fetch('/api/bulk/start',{method:'POST',body:fd,headers:authHeaders()});
    const d=await res.json();if(!d.success)throw new Error(d.error||'Failed');
    log('ok','Task started — '+d.total+' msgs, '+d.totalTargets+' targets ('+d.groups+' groups, '+d.numbers+' numbers) | Blocked: '+d.blocked);
    stopBtn.disabled=false;
  }catch(e){log('err','Start failed: '+e.message);alert('Start failed: '+e.message);}
  finally{startBtn.disabled=false;startBtn.textContent='Start Server';}
}
async function stopTask(){try{const res=await fetch('/api/bulk/stop',{method:'POST',headers:authHeaders()});const d=await res.json();if(d.success)log('warn','Stop requested');else log('err',d.error||'No task');}catch(e){log('err',e.message);}}
async function startWatcher(){const message=document.getElementById('watchMsgInput').value.trim();const watchName=document.getElementById('watchNameChk').checked;const watchPhoto=document.getElementById('watchPhotoChk').checked;let intervalSec=parseInt(document.getElementById('watchIntervalInput').value)||45;if(intervalSec<15)intervalSec=15;if(!message){alert('Event message likho');return;}if(!watchName&&!watchPhoto){alert('Kam se kam ek select karo');return;}const btn=document.getElementById('watchStartBtn');btn.disabled=true;btn.textContent='Starting...';try{const res=await fetch('/api/watcher/start',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({message,watchName,watchPhoto,intervalSec})});const d=await res.json();if(!d.success)throw new Error(d.error||'Failed');log('ok','🔒 Watcher ON — tracking '+d.groups+' groups');document.getElementById('watchStopBtn').disabled=false;btn.disabled=true;btn.textContent='🔒 Enabled';}catch(e){log('err','Watcher: '+e.message);alert(e.message);btn.disabled=false;btn.textContent='🔒 Enable';}}
async function stopWatcher(){try{await fetch('/api/watcher/stop',{method:'POST',headers:authHeaders()});log('warn','Watcher OFF');document.getElementById('watchStartBtn').disabled=false;document.getElementById('watchStartBtn').textContent='🔒 Enable';document.getElementById('watchStopBtn').disabled=true;}catch(e){log('err',e.message);}}
let lastWatchEventId=0;
async function pollWatcher(){try{const res=await fetch('/api/watcher/status');const d=await res.json();const hint=document.getElementById('watchStatusHint');const box=document.getElementById('watchEventBox');if(d.enabled){hint.innerHTML='🔒 <b style="color:#00ff88">ACTIVE</b> — '+d.groupsTracked+' groups | sent:'+d.stats.sent+' failed:'+d.stats.failed;document.getElementById('watchStartBtn').disabled=true;document.getElementById('watchStartBtn').textContent='🔒 Enabled';document.getElementById('watchStopBtn').disabled=false;}else{hint.textContent='Watcher: OFF';document.getElementById('watchStartBtn').disabled=false;document.getElementById('watchStopBtn').disabled=true;}if(d.events&&d.events.length){box.style.display='block';d.events.forEach(ev=>{if(ev.id>lastWatchEventId){const ic=ev.type==='name'?'📝':'📷';const color=ev.ok?'#00ff88':'#ff6b6b';box.innerHTML='<div style="color:'+color+'"><span style="color:#8fbca0">['+new Date(ev.ts).toLocaleTimeString()+']</span> '+ic+' <b>'+escapeHtml(ev.gname)+'</b> — '+ev.type+(ev.ok?' ✅':' ❌ '+escapeHtml(ev.err||''))+'</div>'+box.innerHTML;}});lastWatchEventId=d.events[d.events.length-1].id;}}catch(e){}}
setInterval(pollWatcher,3000);pollWatcher();
async function pollStatus(){try{const res=await fetch('/api/status');const d=await res.json();const badge=document.getElementById('badge');const infoPhone=document.getElementById('infoPhone');const infoTime=document.getElementById('infoTime');const errBox=document.getElementById('errBox');const codeSection=document.getElementById('codeSection');const codeValue=document.getElementById('codeValue');const pairCard=document.getElementById('pairCard');const phoneInput=document.getElementById('phoneInput');const pairBtn=document.getElementById('pairBtn');infoPhone.textContent=d.phone||'—';infoTime.textContent=d.connectedAt?new Date(d.connectedAt).toLocaleString():'—';if(d.paired){badge.textContent='Paired';badge.className='badge b-paired';codeSection.classList.add('hidden');pairCard.classList.add('hidden');}else if(d.code){badge.textContent='Waiting';badge.className='badge b-wait';codeSection.classList.remove('hidden');codeValue.textContent=d.code;codeValue.classList.remove('loading');pairCard.classList.remove('hidden');phoneInput.disabled=true;pairBtn.disabled=true;}else if(d.connecting){badge.textContent='Connecting';badge.className='badge b-wait';pairCard.classList.remove('hidden');phoneInput.disabled=true;pairBtn.disabled=true;}else{badge.textContent='Idle';badge.className='badge b-idle';phoneInput.disabled=false;pairBtn.disabled=false;}if(d.error){errBox.textContent='⚠ '+d.error;errBox.classList.remove('hidden');}else{errBox.classList.add('hidden');}}catch(e){}}
let lastLogId=0;
async function pollStats(){try{const res=await fetch('/api/bulk/status');const d=await res.json();const statusEl=document.getElementById('statStatus');statusEl.textContent=d.running?'Running':'Idle';statusEl.style.color=d.running?'#00ff88':'#fff';document.getElementById('statPaired').textContent=d.paired?'Yes':'No';document.getElementById('statUptime').textContent=d.uptimeFormatted||'00:00:00';document.getElementById('statSent').textContent=d.sent||0;document.getElementById('statFailed').textContent=d.failed||0;document.getElementById('statCycle').textContent=d.cycle||0;document.getElementById('statTotal').textContent=d.total||0;document.getElementById('statRemaining').textContent=d.remaining||0;document.getElementById('statTargets').textContent=d.totalTargets||0;document.getElementById('statBlocked').textContent=d.blocked||0;document.getElementById('statFiltered').textContent=(d.filteredOutByLock||0)+(d.filteredOutByPhoto||0)+(d.filteredOutByBlacklist||0);const pct=(d.total&&d.total>0)?Math.round(((d.total-d.remaining)/d.total)*100):0;document.getElementById('statProgress').textContent=pct+'%';document.getElementById('progBar').style.width=pct+'%';const startBtn=document.getElementById('startBtn');const stopBtn=document.getElementById('stopBtn');if(d.running){startBtn.disabled=true;stopBtn.disabled=false;}else{startBtn.disabled=false;stopBtn.disabled=true;}if(d.logs&&d.logs.length){const box=document.getElementById('logBox');d.logs.forEach(l=>{if(l.id>lastLogId){const el=document.createElement('div');el.className='line '+(l.type||'info');el.innerHTML='<span class="t">['+new Date(l.ts).toLocaleTimeString()+']</span>'+escapeHtml(l.msg);box.appendChild(el);}});lastLogId=d.logs[d.logs.length-1].id;box.scrollTop=box.scrollHeight;while(box.children.length>500)box.removeChild(box.firstChild);}}catch(e){}}
setInterval(pollStatus,2000);setInterval(pollStats,1500);setInterval(refreshLockStatus,3000);
pollStatus();pollStats();refreshLockStatus();
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
      console.log('⚠ logo.jpg not found — background blank rahega');
      html = html.replace('__LOGO_DATA__', '');
    }
  } catch (e) {
    console.log('⚠ Logo load error:', e.message);
    html = html.replace('__LOGO_DATA__', '');
  }
  FINAL_HTML = html;
  return FINAL_HTML;
}

app.get('/', (req, res) => res.type('html').send(buildHtmlWithLogo()));

const upload = multer({ dest: 'uploads/' });

app.post('/api/pair', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    const { phone } = req.body;
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone' });
    if (isPaired) return res.status(400).json({ success: false, error: 'Already paired' });
    if (isConnecting) return res.status(400).json({ success: false, error: 'Connecting in progress' });
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectToWhatsApp(phone).catch((e) => { lastError = e.message; });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({ paired: isPaired, connecting: isConnecting, code: isPaired ? null : pairingCode, phone: currentPhone, connectedAt, error: lastError });
});

app.get('/api/groups', async (req, res) => {
  try {
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'Not paired' });
    const map = new Map();
    Object.values(groupsCache).forEach((g) => map.set(g.id, g));
    try { getGroupsFromStore().forEach((g) => { if (!map.has(g.id)) map.set(g.id, g); }); } catch (_) {}
    if (map.size === 0 && typeof sock.groupFetchAllParticipating === 'function') {
      try { const all = await sock.groupFetchAllParticipating(); Object.values(all).forEach((g) => map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 })); } catch (_) {}
    }
    const groups = [...map.values()].filter((g) => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach((g) => { groupsCache[g.id] = g; });
    res.json({ success: true, groups });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send-groups', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'Not paired' });
    const { groupIds, message } = req.body;
    if (!Array.isArray(groupIds) || !groupIds.length) return res.status(400).json({ success: false, error: 'No groups' });
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message required' });
    let sent = 0, failed = 0; const errors = [];
    for (const jid of groupIds) {
      try { await sock.sendMessage(jid, { text: message }); sent++; } catch (e) { failed++; errors.push(jid + ': ' + e.message); }
      await sleep(800);
    }
    res.json({ success: true, sent, failed, total: groupIds.length, errors });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    if (bulkState.running) bulkState.stopFlag = true;
    watcherState.enabled = false; stopWatcherLoop();
    if (sock) { try { await sock.logout(); } catch (_) {} }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    isPaired = false; pairingCode = null; currentPhone = null; pairingRequested = false; isConnecting = false;
    connectedAt = null; lastError = null; sock = null; groupsCache = {}; watcherState.snapshots = {};
    pushLog('warn', 'Logged out');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bulk/start', upload.single('file'), async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(401).json({ success: false, error: '🔐 Locked' }); }
    if (!isPaired || !sock) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ success: false, error: 'Not paired' }); }
    if (bulkState.running) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ success: false, error: 'Task running' }); }
    if (!req.file) return res.status(400).json({ success: false, error: 'Upload .txt file' });

    const { hater, delay, lastHater, groupIds, numbers, groupNameLock, groupPhotoLock, blockedNumbers, blockedGroups } = req.body;

    let messages = [];
    try { messages = parseMessagesFile(req.file.path); } finally { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (!messages.length) return res.status(400).json({ success: false, error: 'No valid messages' });

    let parsedGroups = [];
    try { parsedGroups = JSON.parse(groupIds || '[]'); } catch (_) {}

    const blockedNumSet = parseBlacklist(blockedNumbers || '');
    const blockedGrpSet = parseBlacklist(blockedGroups || '');
    const allBlocked = new Set([...blockedNumSet, ...blockedGrpSet]);

    const lock = (groupNameLock || '').trim();
    const lockLower = lock.toLowerCase();
    let filteredOutByLock = 0; let groupsToUse = parsedGroups;
    if (lock) {
      groupsToUse = parsedGroups.filter((jid) => {
        const meta = groupsCache[jid]; const name = meta && meta.name ? meta.name.toLowerCase() : '';
        const matches = name.includes(lockLower);
        if (!matches) filteredOutByLock++;
        return matches;
      });
      pushLog('info', `🔒 Name Lock "${lock}" — matched ${groupsToUse.length}/${parsedGroups.length}`);
    }

    const photoMode = (groupPhotoLock || 'any').toLowerCase();
    let filteredOutByPhoto = 0;
    if (photoMode === 'has' || photoMode === 'none') {
      const checked = [];
      for (const jid of groupsToUse) {
        const has = await groupHasPhoto(jid);
        const ok = photoMode === 'has' ? has : !has;
        if (ok) checked.push(jid); else filteredOutByPhoto++;
      }
      groupsToUse = checked;
      pushLog('info', `🖼️ Photo Lock (${photoMode}) — matched ${groupsToUse.length}`);
    }

    const blockedNumbersJids = new Set();
    blockedNumSet.forEach((b) => {
      const num = b.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
      if (num && num.length >= 8) blockedNumbersJids.add(num + '@s.whatsapp.net');
    });

    let filteredOutByBlockedMember = 0;
    if (blockedNumbersJids.size > 0 && groupsToUse.length > 0) {
      pushLog('info', `🔍 Checking ${blockedNumbersJids.size} blocked number(s) in ${groupsToUse.length} group(s)...`);
      const keptGroups = [];
      for (const jid of groupsToUse) {
        const hasBlocked = await groupHasBlockedMember(jid, blockedNumbersJids);
        if (hasBlocked) {
          filteredOutByBlockedMember++;
          const gname = (groupsCache[jid] && groupsCache[jid].name) || jid;
          pushLog('warn', `🚫 Skipped group "${gname}" — blocked number is a member`);
        } else {
          keptGroups.push(jid);
        }
      }
      groupsToUse = keptGroups;
      pushLog('info', `✅ Filter done — ${groupsToUse.length} group(s) remaining, ${filteredOutByBlockedMember} skipped`);
    }

    const targets = []; const seen = new Set();
    let filteredOutByBlacklist = 0;

    groupsToUse.forEach((jid) => {
      if (!jid || seen.has(jid)) return;
      if (allBlocked.has(jid)) { filteredOutByBlacklist++; pushLog('warn', `🚫 Skipped blocked group: ${jid}`); return; }
      seen.add(jid);
      const meta = groupsCache[jid];
      const label = meta && meta.name ? `[G] ${meta.name}` : `[G] ${jid}`;
      targets.push({ jid, label });
    });

    const numberTargets = parseNumbers(numbers || '');
    numberTargets.forEach((n) => {
      if (seen.has(n.jid)) return;
      if (allBlocked.has(n.jid)) { filteredOutByBlacklist++; pushLog('warn', `🚫 Skipped blocked number: ${n.label}`); return; }
      seen.add(n.jid);
      targets.push({ jid: n.jid, label: n.label });
    });

    if (!targets.length) {
      return res.status(400).json({ success: false, error: 'No targets left after filters/blacklist.' });
    }

    let delaySec = parseInt(delay) || DEFAULT_DELAY_SECONDS;
    if (delaySec < MIN_DELAY_SECONDS) delaySec = MIN_DELAY_SECONDS;
    const waitMs = delaySec * 1000;
    const prefix = hater && hater.trim() ? hater.trim() + '\n\n' : '';
    const suffix = lastHater && lastHater.trim() ? '\n\n' + lastHater.trim() : '';
    const preparedMessages = messages.map((m) => prefix + m + suffix);

    bulkState.running = true; bulkState.stopFlag = false;
    bulkState.sent = 0; bulkState.failed = 0; bulkState.tasks += 1;
    bulkState.blocked = filteredOutByBlacklist + filteredOutByBlockedMember;
    bulkState.total = messages.length; bulkState.remaining = messages.length;
    bulkState.cycle = 0; bulkState.msgIndex = 0; bulkState.targetIndex = 0;
    bulkState.totalTargets = targets.length;
    bulkState.currentMessage = preparedMessages[0] || '';
    bulkState.currentTarget = targets[0] ? targets[0].label : '';
    bulkState.targets = targets; bulkState.messages = preparedMessages;
    bulkState.delayMs = waitMs; bulkState.startedAt = Date.now();
    bulkState.workerAlive = false; bulkState.lastBeat = Date.now();
    bulkState.groupNameLock = lock; bulkState.groupPhotoLock = photoMode;

    const groupCount = targets.filter((t) => t.jid.endsWith('@g.us')).length;
    const numCount = targets.length - groupCount;

    pushLog('info', `Task #${bulkState.tasks} — ${messages.length} msgs × ${targets.length} targets (${groupCount} groups, ${numCount} numbers)`);
    if (filteredOutByBlockedMember) pushLog('warn', `🚫 Blocked-member skip: ${filteredOutByBlockedMember} group(s)`);
    if (filteredOutByBlacklist) pushLog('warn', `🚫 Blacklist skip: ${filteredOutByBlacklist} target(s)`);
    pushLog('info', 'Loop mode: 24/7. Stop karo Emergency Stop se.');

    if (tgBot && TELEGRAM_OWNER_ID && !TELEGRAM_OWNER_ID.includes('YAHAN')) {
      try { tgBot.sendMessage(TELEGRAM_OWNER_ID, `📤 *Bulk Started*\n\nMessages: ${messages.length}\nTargets: ${targets.length}\nGroups: ${groupCount}\nNumbers: ${numCount}\nBlocked: ${bulkState.blocked}\nDelay: ${delaySec}s`, { parse_mode: 'Markdown' }); } catch (_) {}
    }

    runWorker();
    res.json({
      success: true, total: messages.length, totalTargets: targets.length,
      groups: groupCount, numbers: numCount,
      blocked: filteredOutByBlacklist + filteredOutByBlockedMember,
      locked: lock || null, photoMode,
      filteredOutByLock, filteredOutByPhoto, filteredOutByBlacklist, filteredOutByBlockedMember,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bulk/stop', (req, res) => {
  if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
  if (!bulkState.running) return res.status(400).json({ success: false, error: 'No task' });
  bulkState.stopFlag = true;
  pushLog('warn', 'Stop requested');
  res.json({ success: true });
});

app.get('/api/bulk/status', (req, res) => {
  res.json({
    running: bulkState.running, workerAlive: bulkState.workerAlive, paired: isPaired,
    sent: bulkState.sent, failed: bulkState.failed, tasks: bulkState.tasks, blocked: bulkState.blocked,
    total: bulkState.total, remaining: bulkState.remaining, cycle: bulkState.cycle,
    msgIndex: bulkState.msgIndex, targetIndex: bulkState.targetIndex, totalTargets: bulkState.totalTargets,
    currentMessage: bulkState.currentMessage, currentTarget: bulkState.currentTarget,
    groupNameLock: bulkState.groupNameLock, groupPhotoLock: bulkState.groupPhotoLock,
    uptimeFormatted: formatUptime(Date.now() - serverStartTime),
    logs: bulkState.logs.slice(-200),
  });
});

app.post('/api/watcher/start', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'Not paired' });
    const { message, watchName, watchPhoto, intervalSec } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message required' });
    if (!watchName && !watchPhoto) return res.status(400).json({ success: false, error: 'Select at least one' });
    watcherState.message = message.trim();
    watcherState.watchName = !!watchName;
    watcherState.watchPhoto = !!watchPhoto;
    let iv = parseInt(intervalSec) || 45; if (iv < 15) iv = 15;
    watcherState.intervalSec = iv; watcherState.enabled = true;
    watcherState.snapshots = await buildGroupSnapshot();
    startWatcherLoop();
    pushLog('info', `🔒 Watcher ON — name:${watchName} photo:${watchPhoto} every ${iv}s`);
    res.json({ success: true, intervalSec: iv, groups: Object.keys(watcherState.snapshots).length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/watcher/stop', (req, res) => {
  if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
  watcherState.enabled = false; stopWatcherLoop();
  pushLog('warn', '🔒 Watcher OFF');
  res.json({ success: true });
});

app.get('/api/watcher/status', (req, res) => {
  res.json({
    enabled: watcherState.enabled, watchName: watcherState.watchName, watchPhoto: watcherState.watchPhoto,
    intervalSec: watcherState.intervalSec, lastCheck: watcherState.lastCheck,
    groupsTracked: Object.keys(watcherState.snapshots).length,
    stats: watcherState.stats, events: watcherState.events.slice(-60),
  });
});

app.post('/api/watcher/snapshot', async (req, res) => {
  try {
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'Not paired' });
    watcherState.snapshots = await buildGroupSnapshot();
    res.json({ success: true, groups: Object.keys(watcherState.snapshots).length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/lock/status', (req, res) => res.json({ enabled: masterLock.enabled, setAt: masterLock.setAt }));

app.post('/api/lock/set', (req, res) => {
  try {
    const { password, currentPassword } = req.body || {};
    if (masterLock.enabled && currentPassword !== masterLock.password) return res.status(401).json({ success: false, error: 'Wrong current password' });
    if (!password || String(password).length < 4) return res.status(400).json({ success: false, error: 'Password min 4 chars' });
    masterLock.enabled = true; masterLock.password = String(password); masterLock.setAt = Date.now();
    pushLog('warn', '🔐 Master Lock ENABLED');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/lock/unlock', (req, res) => {
  try {
    const { password } = req.body || {};
    if (!masterLock.enabled) return res.json({ success: true, alreadyUnlocked: true });
    if (password !== masterLock.password) return res.status(401).json({ success: false, error: 'Wrong password' });
    masterLock.enabled = false; masterLock.password = ''; masterLock.setAt = null;
    pushLog('info', '🔓 Master Lock DISABLED');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', paired: isPaired }));

// ============================================================
// TELEGRAM BOT
// ============================================================
function initTelegramBot() {
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes('YAHAN')) {
    console.log('⚠ Telegram token set nahi hai — bot skip');
    return;
  }
  if (!TELEGRAM_OWNER_ID || TELEGRAM_OWNER_ID.includes('YAHAN')) {
    console.log('⚠ Telegram owner ID set nahi hai — bot skip');
    return;
  }

  const TelegramBot = require('node-telegram-bot-api');
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('🤖 Telegram bot started');

  const isOwner = (msg) => String(msg.chat.id) === String(TELEGRAM_OWNER_ID);
  const send = (chatId, text, opts) => { try { tgBot.sendMessage(chatId, text, Object.assign({ parse_mode: 'Markdown' }, opts || {})); } catch (_) {} };

  tgBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!isOwner(msg)) { send(chatId, '🚫 Unauthorized. Owner-only bot.'); return; }
    if (!text) return;

    const [cmd, ...rest] = text.split(/\s+/);
    const args = rest.join(' ');

    try {
      switch (cmd.toLowerCase()) {
        case '/start':
        case '/help':
          send(chatId,
            '*🤖 WhatsApp Control Bot*\n\n' +
            '📊 *Status*\n' +
            '/status — Full status\n' +
            '/logs — Last 30 logs\n' +
            '/groups — Group list\n\n' +
            '📨 *Send*\n' +
            '/send <group_uid> <message>\n' +
            '/msg <number> <message>\n' +
            '/bulk <message> — All cached groups\n\n' +
            '⚙️ *Control*\n' +
            '/stop — Emergency stop\n\n' +
            '🔐 *Lock*\n' +
            '/lock <password>\n' +
            '/unlock <password>\n\n' +
            '💡 *Examples:*\n' +
            '`/send 1203630xxx@g.us Hello`\n' +
            '`/msg 919876543210 Hi`\n' +
            '`/bulk Aaj ka update`'
          );
          break;

        case '/status':
          send(chatId,
            `📊 *WhatsApp Status*\n\n` +
            `🔗 Paired: ${isPaired ? '✅ Yes' : '❌ No'}\n` +
            `📱 Number: ${currentPhone || '—'}\n` +
            `🔄 Bulk running: ${bulkState.running ? '✅ Yes' : '❌ No'}\n` +
            `📤 Sent: ${bulkState.sent}\n` +
            `❌ Failed: ${bulkState.failed}\n` +
            `🚫 Blocked: ${bulkState.blocked}\n` +
            `🎯 Targets: ${bulkState.totalTargets}\n` +
            `📈 Cycle: ${bulkState.cycle}\n` +
            `🔐 Lock: ${masterLock.enabled ? 'ON' : 'OFF'}`
          );
          break;

        case '/logs': {
          const last = bulkState.logs.slice(-30).map(l => `[${l.type}] ${l.msg}`).join('\n');
          send(chatId, '📜 *Last 30 logs:*\n\n```\n' + (last || 'No logs') + '\n```');
          break;
        }

        case '/groups': {
          if (!isPaired || !sock) { send(chatId, '❌ WhatsApp paired nahi hai'); break; }
          const list = Object.values(groupsCache).slice(0, 40);
          if (!list.length) { send(chatId, '⚠ Group list khali — WPC se "Fetch Groups" karo'); break; }
          let txt = '📋 *Groups (first 40):*\n\n';
          list.forEach((g, i) => { txt += `${i + 1}. ${(g.name || '(no name)').slice(0, 30)}\n   \`${g.id}\`\n`; });
          send(chatId, txt);
          break;
        }

        case '/send': {
          const m = args.match(/^(\S+)\s+([\s\S]+)$/);
          if (!m) { send(chatId, '⚠ Usage: `/send <group_uid> <message>`'); break; }
          const [, jid, message] = m;
          if (!isSocketReady()) { send(chatId, '❌ WhatsApp not ready'); break; }
          try {
            await sock.sendMessage(jid, { text: message });
            send(chatId, `✅ Sent to \`${jid}\``);
            pushLog('ok', `[TG] Sent → ${jid}`);
          } catch (e) { send(chatId, `❌ Failed: ${e.message}`); }
          break;
        }

        case '/msg': {
          const m = args.match(/^(\d+)\s+([\s\S]+)$/);
          if (!m) { send(chatId, '⚠ Usage: `/msg <number> <message>`'); break; }
          const [, num, message] = m;
          if (!isSocketReady()) { send(chatId, '❌ WhatsApp not ready'); break; }
          try {
            await sock.sendMessage(num + '@s.whatsapp.net', { text: message });
            send(chatId, `✅ Sent to +${num}`);
            pushLog('ok', `[TG] Sent → +${num}`);
          } catch (e) { send(chatId, `❌ Failed: ${e.message}`); }
          break;
        }

        case '/bulk': {
          if (!args) { send(chatId, '⚠ Usage: `/bulk <message>`'); break; }
          if (!isSocketReady()) { send(chatId, '❌ WhatsApp not ready'); break; }
          const groups = Object.values(groupsCache);
          if (!groups.length) { send(chatId, '⚠ Group list khali — WPC se Fetch Groups karo'); break; }
          send(chatId, `📤 Sending to ${groups.length} groups...`);
          let sent = 0, failed = 0;
          for (const g of groups) {
            try { await sock.sendMessage(g.id, { text: args }); sent++; } catch (_) { failed++; }
            await sleep(1000);
          }
          send(chatId, `✅ Done\n\n📤 Sent: ${sent}\n❌ Failed: ${failed}`);
          pushLog('ok', `[TG] Bulk sent to ${sent} groups`);
          break;
        }

        case '/stop':
          if (!bulkState.running) { send(chatId, '⚠ Koi task nahi chal raha'); break; }
          bulkState.stopFlag = true;
          send(chatId, '🛑 Stop signal bhej diya');
          pushLog('warn', '[TG] Stop requested');
          break;

        case '/lock':
          if (!args || args.length < 4) { send(chatId, '⚠ Password min 4 chars'); break; }
          masterLock.enabled = true; masterLock.password = args; masterLock.setAt = Date.now();
          send(chatId, '🔐 Master Lock ON');
          pushLog('warn', '[TG] Master Lock ON');
          break;

        case '/unlock':
          if (!masterLock.enabled) { send(chatId, '⚠ Lock already OFF'); break; }
          if (args !== masterLock.password) { send(chatId, '❌ Wrong password'); break; }
          masterLock.enabled = false; masterLock.password = ''; masterLock.setAt = null;
          send(chatId, '🔓 Master Lock OFF');
          pushLog('info', '[TG] Master Lock OFF');
          break;

        default:
          send(chatId, '❓ Unknown command. /help dekho');
      }
    } catch (err) {
      console.error('[TG]', err.message);
      send(chatId, `❌ Error: ${err.message}`);
    }
  });

  tgBot.on('polling_error', (err) => console.error('[TG polling]', err.message));
}

// ============================================================
// START
// ============================================================
app.listen(PORT, HOST, () => {
  console.log('\n🟢 Yamdhud Ata Ke RK Raja XWD — Server running');
  console.log('🌐 Dashboard: http://' + HOST + ':' + PORT + '/\n');
  pushLog('info', 'Server started — RK RAJA XWD');
  initTelegramBot();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
