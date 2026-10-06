const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const CLASSES = ['dongle', 'pos', 'kds', 'kiosk'];
const STEPS = ['Checking the device', 'Getting a token', 'Installing the agent', 'Setting Device Owner',
  'Granting permissions', 'Starting the agent', 'Waiting for the server'];
const svg = (inner) => `<svg class="ic" viewBox="0 0 24 24">${inner}</svg>`;
const ICON = {
  phone: svg('<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>'),
  dongle: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  pos: svg('<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"/><path d="M9 8h6M9 12h6"/>'),
  kds: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 9h5M7 12.5h8M9 21h6"/>'),
  kiosk: svg('<rect x="6" y="2.5" width="12" height="16" rx="2"/><path d="M9 21.5h6M12 18.5v3"/>'),
  tablet: svg('<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M10.5 17h3"/>'),
  usb: svg('<path d="M12 3v14M12 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 9l4-2v3M12 12l-4-2V7"/>'),
  wifi: svg('<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
};
const PHONE = ICON.phone;
const CHECK = '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Follow the OS light/dark setting (style.css themes via data-theme).
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
applyTheme(); mq.addEventListener('change', applyTheme);

// Scale the whole UI with the window (the dashboard CSS is in fixed px), and let people
// nudge it with Ctrl/Cmd + / - / 0. The nudge is remembered.
let userZoom = parseFloat(store.get('zoom', '1')) || 1;
function applyZoom() {
  const auto = Math.min(1.6, Math.max(1, Math.min(window.innerWidth / 820, window.innerHeight / 620)));
  document.documentElement.style.zoom = String(+(auto * userZoom).toFixed(3));
}
window.addEventListener('resize', applyZoom);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key;
  if (k === '+' || k === '=') userZoom = Math.min(1.6, userZoom + 0.1);
  else if (k === '-') userZoom = Math.max(0.7, userZoom - 0.1);
  else if (k === '0') userZoom = 1;
  else return;
  e.preventDefault();
  store.set('zoom', String(+userZoom.toFixed(2)));
  applyZoom();
});
applyZoom();

let devices = [];
let selected = null;           // handle
let timer = null, polling = false;
const picked = {};             // handle -> class chosen
const run = {};                // handle -> { step, error, done }  (this session's enroll attempts)
let todayCount = 0;
let heroKey = '';
let adb = { found: true, os: 'linux', version: '' };   // from adb_status
let guideOs = null;            // OS tab shown in the adb help (defaults to this computer)
let emptySince = 0, tipShown = false;
let heroTok = {};
let wifiMode = false, wifiPrefill = '';
let savedPhones = [];
try { savedPhones = JSON.parse(store.get('saved', '[]')); } catch {}
const saveSaved = () => store.set('saved', JSON.stringify(savedPhones.slice(0, 8)));              // cancels the phone animation when the hero is redrawn

const isNet = (d) => d.handle.includes(':') || d.handle.includes('._adb-tls-');
const classOf = (h) => picked[h] || store.get('class', 'dongle');
const iconOf = (d) => (d.status === 'unauthorized' ? ICON.help : ICON[d.class] || (d.status === 'firmware' ? ICON.tablet : ICON.phone));
const dotOf = (d) => ({ ready: '', enrolled: '', firmware: '', enrolling: 'wait', blocked: 'bad', unauthorized: 'wait', offline: 'none' }[d.status] ?? 'none');

function renderSaved() {
  const box = $('saved');
  // Give saved phones the name the device list learned for them.
  savedPhones.forEach((p) => { const d = devices.find((x) => x.handle.startsWith(p.host + ':')); if (d && d.name && p.name !== d.name) { p.name = d.name; saveSaved(); } });
  const online = (p) => devices.some((x) => x.handle.startsWith(p.host + ':'));
  const list = savedPhones.filter((p) => !online(p));
  const sig = list.map((p) => p.host + p.name).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = list.length ? `<div class="sh">Saved phones</div>` + list.map((p) => `<div class="sv" data-host="${esc(p.host)}"><span class="nm">${esc(p.name || p.host)}</span><button class="cc-btn sm" data-re>Connect</button><button class="x" data-rm title="Forget" aria-label="Forget">×</button></div>`).join('') : '';
}
$('saved').addEventListener('click', async (e) => {
  const row = e.target.closest('.sv');
  if (!row) return;
  const host = row.dataset.host;
  if (e.target.closest('[data-rm]')) { savedPhones = savedPhones.filter((p) => p.host !== host); saveSaved(); $('saved').dataset.sig = ''; return renderSaved(); }
  const btn = e.target.closest('[data-re]');
  if (!btn) return;
  btn.innerHTML = '<span class="spin"></span>';
  // Ports change, so look up the phone's current one before trying.
  let addr = '';
  try { addr = ((await invoke('wifi_discover')).find((s) => s.kind === 'connect' && s.addr.startsWith(host + ':')) || {}).addr || ''; } catch {}
  if (addr) {
    try { await invoke('wifi_connect', { addr }); selected = addr; wifiMode = false; heroKey = ''; return tick(); } catch {}
  }
  btn.textContent = 'Connect';
  wifiMode = true; wifiPrefill = host + ':'; heroKey = ''; refresh();
});
$('addWifi').addEventListener('click', () => { wifiMode = true; wifiPrefill = ''; heroKey = ''; refresh(); });

function renderRail() {
  $('addWifi').classList.toggle('on', wifiMode);
  renderSaved();
  const rail = $('rail');
  const have = new Map([...rail.children].map((el) => [el.dataset.h, el]));
  devices.forEach((d, i) => {
    let el = have.get(d.handle);
    if (!el) {
      el = document.createElement('button');
      el.className = 'ri in';
      el.dataset.h = d.handle;
      el.addEventListener('click', () => { selected = d.handle; wifiMode = false; refresh(); });
    }
    have.delete(d.handle);
    el.classList.toggle('on', d.handle === selected && !wifiMode);
    // Enrolled, or firmware the MDM has registered: a tick instead of the status dot.
    const ticked = d.status === 'enrolled' || (d.status === 'firmware' && d.server_seen);
    // Only redraw when something visible changed, so the tick animates once, not on every poll.
    const sig = [d.name, d.status, d.class, ticked, iconOf(d).length, isNet(d)].join('|');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = `<div class="ph">${iconOf(d)}</div><span class="nm">${esc(d.name || 'Unknown device')}</span><span class="conn" title="${isNet(d) ? 'Connected over Wi-Fi' : 'Connected by USB cable'}">${isNet(d) ? ICON.wifi : ICON.usb}</span>${
        ticked ? `<span class="tick" title="Enrolled">${CHECK}</span>` : `<i class="${dotOf(d)}"></i>`}`;
    }
    if (rail.children[i] !== el) rail.insertBefore(el, rail.children[i] || null);
  });
  have.forEach((el) => el.remove());
}

function timeline(step) {
  return `<ul class="tl">${STEPS.map((s, i) => `<li class="${i < step ? 'ok' : i === step ? 'on' : ''}">${s}</li>`).join('')}</ul>`;
}

function setStep(handle, step) {
  const ul = document.querySelector(`#hero [data-tl="${CSS.escape(handle)}"] .tl`) || document.querySelector('#hero .tl');
  if (!ul) return;
  [...ul.children].forEach((li, i) => { li.className = i < step ? 'ok' : i === step ? 'on' : ''; });
}

function renderHero() {
  const hero = $('hero');
  const d = devices.find((x) => x.handle === selected);
  const r = d && run[d.handle];
  const key = !adb.found ? 'adb|' + (guideOs || adb.os)
    : wifiMode ? 'wifi'
    : d ? [d.handle, d.status, classOf(d.handle), r?.error || '', r?.done ? 'd' : '', d.server_seen ? 's' : '', d.server_status || ''].join('|') : 'empty';
  if (key === heroKey) return;          // nothing visible changed: don't restart animations
  heroKey = key;
  const tok = (heroTok = {});
  const alive = () => heroTok === tok;

  if (!adb.found) {
    hero.classList.remove('wifi');
    const os = guideOs || adb.os;
    hero.innerHTML = Guide.adbCard(os, adb.os);
    const redraw = (o) => { guideOs = o; heroKey = ''; renderHero(); };
    Guide.wire(hero, redraw);
    return;
  }
  hero.classList.toggle('wifi', wifiMode);
  if (wifiMode) {
    hero.innerHTML = '<div class="wh">Add a phone over Wi-Fi</div><div class="wsub">Android 11 or newer. USB is still the most reliable way.</div><div class="wbody"></div>';
    Wifi.draw(hero.querySelector('.wbody'), {
      invoke, esc, Guide, alive, prefill: wifiPrefill,
      onConnected: (addr) => {
        const host = String(addr).split(':')[0];
        if (!savedPhones.some((p) => p.host === host)) { savedPhones.unshift({ host, name: '' }); saveSaved(); }
        setTimeout(() => { wifiMode = false; selected = addr; heroKey = ''; tick(); }, 1600);
      },
    });
    wifiPrefill = '';
    return;
  }
  if (!d) {
    hero.innerHTML = `<div class="split"><div class="chk">
      <div class="ct">Let’s connect your first device</div>
      <div class="cs2">Three quick things. The first ticks itself.</div>
      <div class="cs ok" data-i="0"><div class="n">${CHECK}</div><div><b>Computer is ready</b><span>adb found${adb.version ? ' · ' + esc(adb.version.replace(/^Android Debug Bridge version /, '')) : ''}</span></div></div>
      <div class="cs" data-i="1"><div class="n">2</div><div><b>Turn on USB debugging</b><span>Tap Build number 7 times, then switch on USB debugging.</span></div></div>
      <div class="cs" data-i="2"><div class="n">3</div><div><b>Plug in and tap Allow</b><span>Use a data cable. The phone asks once: tap Allow.</span></div></div>
      </div><div class="pcol"><div class="ph-slot"></div><div class="cap"></div></div></div><div class="tipslot"></div>`;
    const cs = [...hero.querySelectorAll('.cs')], slot = hero.querySelector('.ph-slot'), cap = hero.querySelector('.cap');
    Guide.loop(slot, alive, (sc) => {
      cap.textContent = Guide.CAP[sc];
      cs[1].classList.toggle('on', sc !== 'allow');
      cs[2].classList.toggle('on', sc === 'allow');
    });
    tipShown = false;
    return;
  }
  const head = `<div class="bigph">${iconOf(d)}</div><h2>${esc(d.name || 'Unknown device')}</h2>
    <div class="mono" style="color:var(--muted)">${esc(d.serial || d.handle)}${d.android ? ' · Android ' + esc(d.android) : ''} · ${isNet(d) ? 'Wi-Fi' : 'USB'}</div>`;

  if (d.status === 'enrolling') {
    hero.innerHTML = `<div class="bigph">${iconOf(d)}</div><h2>Enrolling ${esc(d.name)}…</h2><div data-tl="${esc(d.handle)}">${timeline(r?.step ?? 0)}</div>`;
  } else if (d.status === 'enrolled') {
    const burst = r?.done ? '<div class="ring"></div>' : '';
    hero.innerHTML = `<div class="okbig">${CHECK}</div><h2 style="margin-top:8px">Enrolled</h2>
      <div class="mono" style="color:var(--muted)">${esc(d.name)} · ${esc(d.class || 'device')}${d.agent_version ? ' · agent ' + esc(d.agent_version) : ''}</div>
      <button class="cc-btn primary" id="next" style="margin-top:12px">Next device</button>${burst}`;
    if (r) r.done = false;
    heroKey = [d.handle, d.status, classOf(d.handle), '', ''].join('|');
  } else if (d.status === 'firmware') {
    const gone = d.server_status === 'retired' || d.server_status === 'wiped';
    const seen = d.server_seen
      ? `<div class="wmsg ok">Registered in the MDM${d.class ? ' as <b>' + esc(d.class) + '</b>' : ''}. Nothing to do here.</div>`
      : gone
        ? `<div class="wmsg bad">The MDM has this device marked <b>${esc(d.server_status)}</b>. Restore it from the dashboard if it should be active.</div>`
        : '<div class="wmsg" style="background:var(--surface-3)">Not seen by the MDM yet. It enrolls itself the first time it checks in over the network, so make sure it has internet.</div>';
    hero.innerHTML = `${head}<div class="okbig" style="margin-top:6px">${CHECK}</div><h2 style="margin-top:6px">Already runs AIO MDM firmware</h2>
      <div class="mono" style="color:var(--muted)">MDM client ${esc(d.firmware_version || '—')}${d.build ? ' · build ' + esc(d.build) : ''}</div>
      <div class="amsg" style="margin-top:4px">${seen}</div>
      ${isNet(d) ? '<div class="acts"><button class="cc-btn sm" data-forget>Forget this device</button></div>' : ''}`;
  } else if (d.status === 'blocked') {
    hero.innerHTML = `${head}<div class="fix">${esc(d.note)}<br>Then plug it in again.</div>`;
  } else if (d.status === 'unauthorized') {
    hero.innerHTML = `${head}<p class="msg" style="margin-top:10px">Look at the device screen and tap <b>Allow</b> on the USB debugging prompt.</p>
      <div class="acts"><button class="cc-btn primary" data-reprompt>Show the popup again</button>${isNet(d) ? '<button class="cc-btn" data-forget>Forget this device</button>' : ''}</div><div class="amsg"></div>
      <div class="ph-slot" style="margin-top:8px"></div>`;
    Guide.phone(hero.querySelector('.ph-slot'), 'allow', alive);
  } else if (d.status === 'ready') {
    const cls = classOf(d.handle);
    const err = r?.error ? `<div class="fix shake">${esc(r.error)}</div>` : '';
    hero.innerHTML = `${head}<div class="q">What is this device used for?</div>
      <div class="chips">${CLASSES.map((c) => `<button data-c="${c}" class="${c === cls ? 'on' : ''}">${c}</button>`).join('')}</div>
      <button class="cc-btn primary bigbtn" id="go">${r?.error ? 'Try again' : 'Enroll this device'}</button>${err}
      ${isNet(d) ? '<div class="acts"><button class="cc-btn sm" data-forget>Forget this device</button></div><div class="amsg"></div>' : ''}`;
  } else {
    hero.innerHTML = `${head}<p class="msg" style="margin-top:10px">${esc(d.note || d.status)}</p>`;
  }
  // Any phone connected over the network can be forgotten, whatever its state.
  if (isNet(d) && d.status !== 'enrolling' && !hero.querySelector('[data-forget]')) {
    hero.insertAdjacentHTML('beforeend', '<div class="acts"><button class="cc-btn sm" data-forget title="Disconnects it from this computer. Its MDM enrollment is not affected.">Forget this device</button></div><div class="amsg" style="font-size:11px;color:var(--muted)">Only disconnects it from this computer. It stays enrolled in the MDM.</div>');
  }
}

function refresh() { renderRail(); renderHero(); }

const hero_amsg = () => document.querySelector('#hero .amsg');

async function retryAdb(btn) {
  if (btn) btn.innerHTML = '<span class="spin"></span> Checking…';
  adb = await invoke('adb_status', { retry: true });
  heroKey = ''; refresh(); tick();
}

$('hero').addEventListener('click', async (e) => {
  const retry = e.target.closest('[data-retry]');
  if (retry) return retryAdb(retry);
  if (e.target.closest('[data-openhelp]')) { e.preventDefault(); return openHelp('tr'); }
  const d = devices.find((x) => x.handle === selected);
  if (!d) return;
  const act = e.target.closest('[data-reprompt],[data-forget]');
  if (act) {
    const forget = act.hasAttribute('data-forget'), label = act.textContent, msg = hero_amsg();
    act.disabled = true; act.innerHTML = '<span class="spin"></span> Working…';
    try {
      const m = await invoke(forget ? 'device_forget' : 'device_reprompt', { handle: d.handle });
      if (msg) msg.innerHTML = `<div class="wmsg ok">${esc(m)}</div>`;
      if (forget) { selected = null; heroKey = ''; devices = devices.filter((x) => x.handle !== d.handle); refresh(); }
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
    }
    act.disabled = false; act.textContent = label;
    return tick();
  }
  const chip = e.target.closest('[data-c]');
  if (chip) {
    picked[d.handle] = chip.dataset.c;
    store.set('class', chip.dataset.c);
    return refresh();
  }
  if (e.target.closest('#next')) {
    const nxt = devices.find((x) => x.status === 'ready' && x.handle !== d.handle);
    if (nxt) selected = nxt.handle;
    return refresh();
  }
  const go = e.target.closest('#go');
  if (!go) return;
  go.classList.add('press');
  run[d.handle] = { step: 0 };
  d.status = 'enrolling';
  refresh();
  try {
    await invoke('enroll', { handle: d.handle, class: classOf(d.handle) });
    run[d.handle] = { step: 7, done: true };
    todayCount++; store.set('today', JSON.stringify({ day: new Date().toDateString(), n: todayCount }));
    showToday();
  } catch (err) {
    run[d.handle] = { error: String(err) };
  }
  heroKey = '';
  tick();
});

listen('enroll-step', (e) => {
  const { handle, step } = e.payload;
  run[handle] = { ...(run[handle] || {}), step };
  setStep(handle, step);
});

function showToday() { $('today').textContent = todayCount ? `${todayCount} enrolled today` : ''; }
try {
  const t = JSON.parse(store.get('today', 'null'));
  if (t && t.day === new Date().toDateString()) todayCount = t.n;
} catch {}

let pollSince = 0;
async function tick() {
  // A poll that never came back must not stop all later ones.
  if (polling && Date.now() - pollSince < 45000) return;
  polling = true; pollSince = Date.now();
  try {
    adb = await invoke('adb_status', { retry: false });
    if (!adb.found) { if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; } devices = []; selected = null; refresh(); $('foot').textContent = 'adb not found'; return; }
    const next = await invoke('list_devices');
    // A device the UI is mid-enroll on stays "enrolling" even if adb blips.
    next.forEach((d) => { if (run[d.handle] && run[d.handle].step !== undefined && !run[d.handle].done && !run[d.handle].error && d.status === 'ready') d.status = 'enrolling'; });
    devices = next;
    if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; }
    if (!devices.some((d) => d.handle === selected)) {
      selected = (devices.find((d) => d.status === 'ready') || devices[0])?.handle ?? null;
    }
    $('foot').textContent = 'Watching for devices';
    refresh();
    nudge();
  } catch (err) {
    if (String(err) === 'signed-out') {
      try { return goApp(await invoke('sign_in_saved', { username: currentUser })); } catch {}
      return goSignIn('Session expired. Sign in again.');
    }
    $('foot').textContent = String(err);
  } finally { polling = false; }
}

// Nothing seen for 10 s: bob the "?" and show a tip. Never nags once a device appears.
function nudge() {
  if (devices.length || !adb.found) { emptySince = 0; $('helpBtn').classList.remove('hint'); return; }
  if (!emptySince) emptySince = Date.now();
  if (!tipShown && Date.now() - emptySince > 10000) {
    const slot = document.querySelector('#hero .tipslot');
    if (!slot) return;
    tipShown = true;
    $('helpBtn').classList.add('hint');
    slot.innerHTML = `<div class="tip">${Guide.I.cable}<span><b>Nothing seen yet.</b> Try another cable — some only charge. <a data-openhelp>Open help</a></span></div>`;
  }
}

let helpTab = 'phone', helpTok = {};
function openHelp(tab) {
  if (tab) helpTab = tab;
  $('drawer').classList.add('open');
  $('helpBtn').classList.remove('hint');
  drawTab();
}
function closeHelp() { $('drawer').classList.remove('open'); helpTok = {}; }
function drawTab() {
  const body = $('drawerBody'), tok = (helpTok = {});
  const alive = () => helpTok === tok && $('drawer').classList.contains('open') && helpTab === 'phone';
  document.querySelectorAll('#drawer .dt button').forEach((b) => b.classList.toggle('on', b.dataset.t === helpTab));
  if (helpTab === 'phone') {
    body.innerHTML = `<div class="pcol"><div class="ph-slot"></div><div class="cap"></div></div>
      <ol><li>Settings → About phone → tap <b>Build number</b> 7 times.</li><li>Settings → Developer options → <b>USB debugging</b> on.</li><li>Plug in, tap <b>Allow</b>.</li></ol>`;
    const cap = body.querySelector('.cap');
    Guide.loop(body.querySelector('.ph-slot'), alive, (sc) => { cap.textContent = Guide.CAP[sc]; });
  } else if (helpTab === 'pc') {
    const os = guideOs || adb.os;
    const status = adb.found ? `<p style="margin:0 0 8px;color:var(--ok);font-weight:700">adb found ✓ <span class="mono" style="font-weight:400;color:var(--muted)">${esc(adb.path || '')}</span></p>` : '<p style="margin:0 0 8px;color:var(--warn);font-weight:700">adb was not found</p>';
    body.innerHTML = status + Guide.guideHTML(os, adb.os) + '<button class="cc-btn primary sm" data-retry style="margin-top:10px">↻ Retry</button>';
    Guide.wire(body, (o) => { guideOs = o; drawTab(); });
    body.querySelector('[data-retry]').onclick = async (e) => { await retryAdb(e.currentTarget); drawTab(); };
  } else {
    body.innerHTML = Guide.troubleHTML;
  }
}
$('helpBtn').addEventListener('click', () => ($('drawer').classList.contains('open') ? closeHelp() : openHelp()));
$('drawerX').addEventListener('click', closeHelp);
document.querySelectorAll('#drawer .dt button').forEach((b) => b.addEventListener('click', () => { helpTab = b.dataset.t; drawTab(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

function showWho(name, avatar) {
  $('whoName').textContent = name;
  const el = $('pfp');
  el.classList.remove('sk');
  if (avatar) { el.innerHTML = `<img alt="" src="${avatar}">`; return; }
  el.textContent = (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function goApp(me) {
  showWho(me.username, null);
  invoke('profile').then((p) => showWho(p.name || me.username, p.avatar)).catch(() => {});
  currentUser = me.username;
  showScreen('app');
  $('pfp').className = 'pfp sk'; $('pfp').textContent = '';
  renderSkeleton();
  showToday(); heroKey = ''; clearInterval(timer);
  tick(); timer = setInterval(tick, 2500);
}
const PALETTE = ['#f9674e', '#7a80f6', '#2f9e6f', '#d98a1c', '#c24a8e', '#3b82c4'];
const colorOf = (u) => PALETTE[[...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
let currentUser = '';
let loaded = false;   // first device list received?

// Shimmer placeholders until the first device list arrives.
function renderSkeleton() {
  loaded = false;
  $('rail').innerHTML = Array.from({ length: 3 }, () => '<div class="ri skrow"><div class="ph sk"></div><span class="nm sk"></span></div>').join('');
  const hero = $('hero');
  hero.className = 'hero loading';
  hero.innerHTML = '<div class="sk" style="width:84px;height:84px;border-radius:22px"></div><div class="sk" style="width:180px;height:18px"></div><div class="sk" style="width:130px;height:12px"></div><div class="sk" style="width:260px;height:44px;margin-top:10px;border-radius:12px"></div>';
  heroKey = 'skeleton';
}

function showScreen(which) {
  $('picker').hidden = which !== 'picker';
  $('signin').hidden = which !== 'signin';
  $('app').hidden = which !== 'app';
}

function showForm(username = '', msg = '', canGoBack = false) {
  clearInterval(timer);
  $('u').value = username; $('p').value = '';
  $('signinErr').textContent = msg;
  $('backToPicker').hidden = !canGoBack;
  showScreen('signin');
  ($('u').value ? $('p') : $('u')).focus();
}

async function goSignIn(msg = '') {
  clearInterval(timer);
  let list = [];
  try { list = await invoke('accounts'); } catch {}
  if (!list.length) return showForm('', msg, false);
  $('pickMsg').textContent = msg;
  $('tiles').innerHTML = list.map((a, i) => `<button class="tile" data-u="${esc(a.username)}" style="animation-delay:${i * 60}ms" title="${esc(a.username)}">
      <div class="av" style="background:${colorOf(a.username)}">${a.avatar ? `<img alt="" src="${a.avatar}">` : esc(initials(a.name))}</div>
      <span class="nm">${esc(a.name)}</span>${a.saved ? '' : '<span class="sub2">password needed</span>'}
      <span class="rm" data-rm title="Remove this account">×</span></button>`).join('')
    + `<button class="tile add" id="addAcc" style="animation-delay:${list.length * 60}ms"><div class="av">+</div><span class="nm">Add account</span></button>`;
  showScreen('picker');
  const first = document.querySelector('#tiles .tile'); if (first) first.focus();
}

$('tiles').addEventListener('click', async (e) => {
  if (e.target.closest('#addAcc')) return showForm('', '', true);
  const tile = e.target.closest('.tile[data-u]');
  if (!tile) return;
  const u = tile.dataset.u;
  if (e.target.closest('[data-rm]')) { await invoke('account_remove', { username: u }); return goSignIn(); }
  const acc = (await invoke('accounts')).find((x) => x.username === u);
  if (!acc || !acc.saved) return showForm(u, 'Enter your password.', true);
  tile.classList.add('busy'); tile.querySelector('.nm').textContent = 'Signing in…';
  try { currentUser = u; goApp(await invoke('sign_in_saved', { username: u })); }
  catch (err) { tile.classList.remove('busy'); showForm(u, String(err), true); }
});
$('backToPicker').addEventListener('click', () => goSignIn());

$('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('signinBtn'), label = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Signing in…';
  $('signinForm').classList.add('working');
  $('signinErr').textContent = '';
  try { goApp(await invoke('sign_in', { server: '', username: $('u').value, password: $('p').value, remember: $('remember').checked })); }
  catch (err) { $('signinErr').textContent = String(err); }
  btn.disabled = false; btn.textContent = label;
  $('signinForm').classList.remove('working');
});
$('signOut').addEventListener('click', async () => { await invoke('sign_out'); goSignIn(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && document.activeElement === document.body) $('go')?.click(); });

(async () => { const me = await invoke('me'); me ? goApp(me) : goSignIn(); })();
