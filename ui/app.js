const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const CLASSES = ['dongle', 'pos', 'kds', 'kiosk'];
const STEPS = ['Checking the device', 'Getting a token', 'Installing the agent', 'Setting Device Owner',
  'Granting permissions', 'Starting the agent', 'Registering with the MDM', 'First check-in'];
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
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  q: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
  cloud: svg('<path d="M7 18a4 4 0 0 1-.6-7.9A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
  store: svg('<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  stack: svg('<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>'),
};
const PHONE = ICON.phone;
const CHECK = '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Follow the OS light/dark setting, and tell the CSS which OS we are on (the Mac sidebar is translucent).
// Appearance: Auto (follow the system), Light or Dark — chosen in the account menu, remembered.
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const themeChoice = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
function applyTheme(animate) {
  const t = themeChoice();
  const dark = t === 'dark' || (t === 'system' && mq.matches);
  const root = document.documentElement;
  if (animate) { root.classList.add('theming'); setTimeout(() => root.classList.remove('theming'), 350); }
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}
applyTheme(false); mq.addEventListener('change', () => applyTheme(true));
const UA = navigator.platform || navigator.userAgent || '';
document.documentElement.dataset.os = /Mac/i.test(UA) ? 'mac' : /Win/i.test(UA) ? 'win' : 'linux';

// Size: see applyZoom. People can nudge it with Cmd/Ctrl + / - / 0; the nudge is remembered.
let userZoom = parseFloat(store.get('zoom', '1')) || 1;
function applyZoom() {
  // macOS: native size (the system already scales for Retina). Linux/Windows: grow with the window,
  // so a maximised window on a big screen is not a small app in a sea of space.
  // Linux/Windows render the Mac's 13 px text small, so they start at 1.15× and grow from there
  // (a narrow-but-tall tiled window still gets the 1.15× base).
  const auto = document.documentElement.dataset.os === 'mac' ? 1
    : Math.min(1.5, Math.max(1.15, Math.min(window.innerWidth / 900, window.innerHeight / 640)));
  document.documentElement.style.zoom = String(+(auto * userZoom).toFixed(3));
}
window.addEventListener('resize', applyZoom);

// ---- The sidebar's width: drag the line between it and the page, double-click to put it back ----
// Everything here is in CSS pixels. The window is zoomed (above), and pointer coordinates come back
// in the zoomed space, so each measurement is divided by the zoom before it becomes --sidew.
const SIDE_DEFAULT = 250, SIDE_MIN = 190, SIDE_MAX = 520;
const zoomNow = () => parseFloat(document.documentElement.style.zoom) || 1;
const clampSide = (w) => Math.round(Math.max(SIDE_MIN, Math.min(w, SIDE_MAX, (window.innerWidth / zoomNow()) * 0.55)));
let sideW = parseFloat(store.get('sidew', '')) || 0;     // 0 = never dragged: the stylesheet decides
function applySide(save) {
  if (!sideW) return;
  const w = clampSide(sideW);
  document.documentElement.style.setProperty('--sidew', w + 'px');
  if (save) store.set('sidew', String(sideW));
}
function setSide(w, save = true) { sideW = clampSide(w); applySide(save); }
applySide(false);
window.addEventListener('resize', () => applySide(false));   // a narrow window squeezes it, the choice is kept

{
  const grip = $('sidegrip'), side = document.querySelector('.side');
  let from = 0, startW = 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    from = e.clientX; startW = side.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('on'); document.documentElement.classList.add('resizing');
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => { if (from) setSide((startW + e.clientX - from) / zoomNow()); });
  const stop = (e) => {
    if (!from) return;
    from = 0; grip.classList.remove('on'); document.documentElement.classList.remove('resizing');
    try { grip.releasePointerCapture(e.pointerId); } catch {}
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
  grip.addEventListener('dblclick', () => { sideW = 0; store.set('sidew', ''); document.documentElement.style.removeProperty('--sidew'); });
  grip.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    setSide((sideW || side.getBoundingClientRect().width / zoomNow()) + step);
  });
}
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
const IS_MAC = document.documentElement.dataset.os === 'mac';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (ts) => {
  const t = typeof ts === 'number' ? ts : Date.parse(ts || '');
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  return s < 45 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString();
};

let devices = [];       // one entry per phone (connections merged)
let rawDevices = [];    // one entry per adb connection
let selected = null;           // handle
// A nearby phone being looked at in the right pane (its address). It is not connected, so the pane
// shows what the MDM knows about it and a Pair button — the same shape as a connected device's page.
let peek = null, peekAddr = '';
const statusCache = new Map();  // serial -> MDM status, filled only for the phone being looked at
let timer = null, polling = false;
const picked = {};             // handle -> class chosen
const run = {};                // handle -> { step, error, done }  (this session's enroll attempts)
let heroKey = '';
let adb = { found: true, os: 'linux', version: '' };   // from adb_status
let guideOs = null;            // OS tab shown in the adb help (defaults to this computer)
let emptySince = 0, tipShown = false;
let heroTok = {};
let fixOpen = false, fixFor = '';
let todayMode = false;                 // the "Enrolled today" page is showing
let query = '';                        // the sidebar search
let batch = null;                      // { handles, done, ok, follow } while "Enrol all" runs
let agentLatest = null;                // the agent build the server hosts ({version, version_code})
let restaurantsList = [];              // for the "Goes to" picker ([] = none, or an older server)
let site = { id: '', name: '' };       // where enrolled devices go ('' = the onboarding inbox)
let siteRecent = [];
let savedPhones = [];
try { savedPhones = JSON.parse(store.get('saved', '[]')); } catch {}
const saveSaved = () => store.set('saved', JSON.stringify(savedPhones.slice(0, 8)));
// Phones the user explicitly forgot: not auto-saved again until they connect to one on purpose.
let ignoredHosts = [];
try { ignoredHosts = JSON.parse(store.get('ignored', '[]')); } catch {}
const saveIgnored = () => store.set('ignored', JSON.stringify(ignoredHosts.slice(-30)));
const unignore = (host) => { if (ignoredHosts.includes(host)) { ignoredHosts = ignoredHosts.filter((h) => h !== host); saveIgnored(); } };              // cancels the phone animation when the hero is redrawn

const isNet = (d) => d.handle.includes(':') || d.handle.includes('._adb-tls-');
const connKind = (h) => (h.includes(':') || h.includes('._adb-tls-') ? 'wifi' : 'usb');
// A phone can be on the cable and on Wi-Fi at once and adb lists each connection separately.
// Merge them by serial into one entry; actions go through the cable while it is in.
function mergeDevices(rows) {
  const rank = (h) => (connKind(h) === 'usb' ? 0 : h.includes(':') ? 1 : 2);
  // How to tell two connections are one phone when a sleeping phone won't say its serial:
  //  - an adb-<SERIAL>-xxxxxx._adb-tls-… name carries the serial in the name itself;
  //  - the discovery list maps such a name to the phone's IP;
  //  - one phone has one IP, whatever port a connection uses.
  const nameSerial = (h) => { const m = /^adb-(.+)-[A-Za-z0-9]{4,8}\._adb-tls-/.exec(h); return m ? m[1] : ''; };
  const hostOfHandle = (h) => {
    if (h.includes('._adb-tls-')) { const f = found.find((x) => h.startsWith(x.name)); return f ? hostOf(f.addr) : ''; }
    return h.includes(':') ? hostOf(h) : '';
  };
  const hostSerial = new Map();                       // IP -> serial, from every connection that knows both
  savedPhones.forEach((p) => { if (p.host && p.serial) hostSerial.set(p.host, p.serial); });   // remembered from earlier sightings
  rows.forEach((d) => { const h = hostOfHandle(d.handle), s = d.serial || nameSerial(d.handle); if (h && s) hostSerial.set(h, s); });
  const keyOf = (d) => {
    // Offline transports (a phone that went to sleep) still belong to their phone: merge them too.
    const h = hostOfHandle(d.handle);
    const s = d.serial || nameSerial(d.handle) || (h && hostSerial.get(h)) || '';
    return s ? 's:' + s : h ? 'h:' + h : '';
  };
  const by = new Map(), out = [];
  rows.forEach((d) => {
    const k = keyOf(d), conn = { handle: d.handle, kind: connKind(d.handle) };
    if (!k) { out.push({ ...d, conns: [conn] }); return; }
    const g = by.get(k);
    if (!g) { const m = { ...d, conns: [conn] }; by.set(k, m); out.push(m); return; }
    const conns = [...g.conns, conn];
    // Prefer a connection that answers (it has the serial/details), then the cable, then ip:port.
    const better = (d.serial && !g.serial) || (!!d.serial === !!g.serial && rank(d.handle) < rank(g.handle));
    if (better) Object.assign(g, d);
    g.conns = conns;
  });
  out.forEach((d) => {
    const w = d.conns.find((c) => c.kind === 'wifi');
    d.wifiHandle = w ? w.handle : '';
    d.hasUsb = d.conns.some((c) => c.kind === 'usb');
  });
  return out;
}
// Plain adb on port 5555 (AIO firmware with the key built in, or after "Switch to Wi-Fi"): trusted by
// key, not by pairing, so there is nothing to unpair.
const plainAdb = (d) => { const w = (d.conns || []).filter((c) => c.kind === 'wifi').map((c) => c.handle); return w.length > 0 && w.every((h) => /:5555$/.test(h)); };
const connIcons = (d) => (d.hasUsb ? ICON.usb : '') + (d.wifiHandle ? ICON.wifi : '');
const connLabel = (d) => (d.hasUsb && d.wifiHandle ? 'USB + Wi-Fi' : d.wifiHandle ? 'Wi-Fi' : 'USB');
// What this device will be enrolled as: the person's pick, else the class the MDM already uses for
// this model. **Never** the last class used on some other device — a KDS enrolled as a dongle
// because nobody looked at the control is worse than being made to choose.
const classOf = (h) => picked[h] || suggestClassFor(((devices.find((x) => x.handle === h)) || {}).serial) || '';
const iconOf = (d) => (d.status === 'unauthorized' ? ICON.help : ICON[d.class] || (d.status === 'firmware' ? ICON.tablet : ICON.phone));
const GLYPH = { dongle: '#5e5ce6', pos: '#ff9f0a', kds: '#28b463', kiosk: '#0a84ff', t7: '#f9674e', tablet: '#f9674e', mpos: '#bf5af2', payment: '#30b0c7' };
const glyphOf = (d) => (d.status === 'blocked' ? '#8e8e93' : GLYPH[d.class] || (d.status === 'firmware' ? '#f9674e' : '#8e8e93'));
const stateLine = (d) => (d.status === 'ready' && d.dpc_owner ? 'Our agent, not registered here' : null) || ({
  ready: 'Ready to enrol', enrolling: 'Enrolling…', enrolled: 'Enrolled' + (d.class ? ' as ' + d.class : ''),
  firmware: d.server_seen ? 'AIO firmware · registered' : 'AIO firmware', blocked: 'Can’t be enrolled',
  unauthorized: 'Waiting for Allow on the phone', offline: 'Not responding',
}[d.status] || d.status);
function setBar(title, sub) { $('tbTitle').textContent = title; $('tbSub').textContent = sub || ''; }
const CHEVR = (open) => `<svg class="ic disc ${open ? 'open' : ''}" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;
const dotOf = (d) => ({ ready: '', enrolled: '', firmware: '', enrolling: 'wait', blocked: 'bad', unauthorized: 'wait', offline: 'none' }[d.status] ?? 'none');

// Wi-Fi phones are remembered with whatever adb told us about them, so a saved entry still
// says what it is after it disconnects.
function learnPhones() {
  let changed = false;
  rawDevices.forEach((d) => {
    if (!d.handle.includes(':') || d.status === 'unauthorized' || d.status === 'offline') return;
    const host = d.handle.split(':')[0];
    if (ignoredHosts.includes(host)) return;
    let p = savedPhones.find((x) => x.host === host);
    if (!p) { p = { host }; savedPhones.unshift(p); changed = true; }
    const info = { name: d.name || '', serial: d.serial || '', android: d.android || '', firmware: d.status === 'firmware' };
    for (const k in info) if (info[k] && p[k] !== info[k]) { p[k] = info[k]; changed = true; }
  });
  if (changed) saveSaved();
}

// ---- Phones found on the network (Wireless debugging is on) ----
let found = [];            // [{ name, addr }]
let pairScreens = [];      // pairing dialogs open on phones: [{ name, addr }]
let discTimer = null, discBusy = false;
// ---- Which nearby phones are "ours" (asked of the MDM; quietly skipped if the server is older) ----
const classCache = new Map();          // serial -> { c: {class,…}, t }
let classOffUntil = 0;
let onlyOurs = store.get('onlyOurs', '0') === '1';
// adb-<SERIAL>-<random> (Wireless debugging) or adb-<SERIAL> (plain adb on port 5555, e.g. AIO firmware).
const serialFromName = (s) => { const n = s.name || ''; const m = /^adb-(.+)-[A-Za-z0-9]{4,8}$/.exec(n) || /^adb-([A-Za-z0-9]{8,20})$/.exec(n); return m ? m[1] : ''; };
const clsOf = (svc) => (classCache.get(serialFromName(svc)) || {}).c || null;
const isOurs = (c) => !!c && ['fleet', 'production', 'family', 'lookalike'].includes(c.class);
const classKnown = () => classCache.size > 0;
const classifyFor = (list) => classifySerials(list.map(serialFromName));
// Asks the MDM about a batch of serials and caches the answers. Used for the phones on the Wi-Fi
// (for their labels) *and* for the connected ones, whose known-model class pre-fills "Used as".
async function classifySerials(list) {
  const serials = [...new Set(list.filter(Boolean))];
  const now = Date.now();
  const need = serials.filter((s) => !classCache.has(s) || now - classCache.get(s).t > 30000);
  if (!need.length || now < classOffUntil) return false;
  try {
    const m = await invoke('classify_serials', { serials: need });
    // A device the MDM knows may still not be managed now (e.g. reflashed with firmware that has no
    // MDM client): ask when it last checked in, so the label can say so.
    const fleet = need.filter((s) => (m[s] || {}).class === 'fleet');
    let seen = {};
    if (fleet.length) { try { seen = await invoke('serial_statuses', { serials: fleet }); } catch {} }
    need.forEach((s) => {
      const c = { ...(m[s] || { class: 'other' }) };
      if (c.class === 'fleet' && seen[s]) { c.last_seen = seen[s].last_seen_at || ''; c.checked = true; }
      classCache.set(s, { c, t: now });
    });
    return true;
  } catch { classOffUntil = now + 60000; }      // older server / offline: no labels, nothing breaks
  return false;
}
const STALE_MS = 3600e3;                         // not heard from for an hour: not managed right now
const agoShort = (ts) => {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  return s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d';
};
// What the MDM knows about a nearby phone, in two or three words; the full sentence is the tooltip.
const classChipHTML = (c) => {
  if (!c) return '';
  const dc = c.device_class ? ' · ' + c.device_class : '';
  const n = c.family_count || 0;
  const k = {
    fleet: !c.checked || (c.last_seen && Date.now() - Date.parse(c.last_seen) < STALE_MS)
      ? ['fleet', CHECK_I + ' Enrolled' + dc, 'Already enrolled in the MDM' + (c.device_class ? ' as ' + c.device_class : '')]
      : ['look', c.last_seen ? 'Offline ' + agoShort(c.last_seen) : 'In MDM · never seen',
        `The MDM has this device on record${c.device_class ? ' as ' + c.device_class : ''}, but it hasn’t checked in ${c.last_seen ? 'since ' + new Date(c.last_seen).toLocaleString() : 'yet'}. Its MDM client may be missing (for example, firmware built without it).`],
    production: ['prod', 'AIO · new', `Serial is in production “${c.production || 'unknown batch'}”, not enrolled yet`],
    family: ['prod', 'Known model' + dc, `Same model as ${n || 'other'} enrolled device${n === 1 ? '' : 's'}${c.family ? ' (' + c.family + ')' : ''}${c.device_class ? ', used as ' + c.device_class : ''}`],
    lookalike: ['look', 'Serial like ours', 'Serial follows our pattern but matches no production'],
    other: ['oth', 'Not ours', 'The MDM knows nothing about this phone'],
  }[c.class];
  return k ? `<span class="nb-chip ${k[0]}" title="${esc(k[2])}">${k[1]}</span>` : '';
};
const CHECK_I = '<svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// The class a phone of a known family should get (learned from the enrolled devices of that family).
const suggestClassFor = (serial) => { const c = ((classCache.get(serial) || {}).c || {}).device_class; return CLASSES.includes(c) ? c : ''; };

async function discover() {
  if (discBusy || !adb.found || $('app').hidden) return;
  discBusy = true;
  try {
    const svcs = await invoke('wifi_discover');
    found = svcs.filter((x) => x.kind === 'connect');
    pairScreens = svcs.filter((x) => x.kind === 'pairing');
    await classifyFor([...found, ...pairScreens]);
    renderPairing();
    autoPairPopup();
    renderFound();
    if ((!devices.length || peek) && !todayMode) renderHero();
    autoConnect();
  } catch {} finally { discBusy = false; }
}

// ---- Connecting by itself ----------------------------------------------------------------
// A phone whose adb key we already hold (AIO firmware trusts the fleet key; a phone paired before
// trusts this computer's own) needs no code and no click. Try each one in the background, so the
// list is devices that are *ready*, not devices to go and fetch. Nothing is installed or changed
// by connecting — it is the same handshake the Pair button does.
const AUTO_RETRY_MS = 60000;      // a refusal is remembered this long: don't hammer a phone that said no
const AUTO_AT_ONCE = 4;
const autoTried = new Map();      // host -> when we last tried it
const autoBusy = new Set();       // hosts with an attempt in flight
function autoConnect() {
  if (!adb.found || $('app').hidden) return;
  const now = Date.now();
  for (const f of found) {
    const host = hostOf(f.addr);
    if (!host || autoBusy.size >= AUTO_AT_ONCE) break;
    // Not one we were told to leave alone, not already here, not tried a moment ago.
    if (autoBusy.has(host) || ignoredHosts.includes(host) || isConnected(f)) continue;
    if (now - (autoTried.get(host) || 0) < AUTO_RETRY_MS) continue;
    autoTried.set(host, now);
    autoBusy.add(host);
    const addrs = found.filter((x) => hostOf(x.addr) === host).map((x) => x.addr);
    invoke('wifi_connect_known', { host, addrs })
      .then((handle) => { if (handle) { autoTried.delete(host); tick(); } })
      .catch(() => {})
      .finally(() => autoBusy.delete(host));
  }
}
// A phone is already connected if any connection has the same address, the same discovery name, or
// the same IP: one phone has several ports (5555 after "Switch to Wi-Fi", another for Wireless debugging).
const hostOf = (a) => (a.includes(':') ? a.slice(0, a.lastIndexOf(':')) : '');
const isConnected = (f) => rawDevices.some((x) => x.handle === f.addr || x.handle.startsWith(f.name) || (hostOf(x.handle) && hostOf(x.handle) === hostOf(f.addr)));

// One row per phone: mDNS adds a " (2)" suffix when two phones claim the same name, and a phone's
// address can change between scans, so the name without that suffix is what identifies it.
const svcKey = (f) => (f.name || f.addr).replace(/ \(\d+\)$/, '');
const peekSvc = () => (peek ? found.find((f) => svcKey(f) === peek && !isConnected(f)) || null : null);

let nearOpen = store.get('nearOpen', '0') === '1', nearPrev = 0, nearAll = false;
/// How many phones on the Wi-Fi to show before "Show more".
const NEARBY_AT_FIRST = 5;
const CHEV = '<svg class="ic" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

// One quiet, collapsed row ("Nearby phones (5)") instead of a card per phone.
// Updates rows in place, keyed: a row that is still there keeps its element (no re-animation, no
// flicker on each scan); only a new one slides in, and a gone one is removed.
function syncRows(container, items, keyOf, rowOf) {
  const have = new Map([...container.children].filter((el) => el.dataset.key).map((el) => [el.dataset.key, el]));
  let prev = null;
  items.forEach((it, i) => {
    const k = keyOf(it), { cls, attrs, html } = rowOf(it);
    let el = have.get(k);
    if (el) have.delete(k);
    else {
      el = document.createElement('div');
      el.dataset.key = k;
      el.classList.add('in');
      el.style.animationDelay = Math.min(i, 6) * 35 + 'ms';
      el.addEventListener('animationend', () => el.classList.remove('in'), { once: true });
    }
    const want = cls + (el.classList.contains('in') ? ' in' : '');
    if (el.className !== want) el.className = want;
    for (const [a, v] of Object.entries(attrs || {})) if (el.getAttribute(a) !== v) el.setAttribute(a, v);
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    const at = prev ? prev.nextSibling : container.firstChild;
    if (at !== el) container.insertBefore(el, at);       // moved only when the order really changed
    prev = el;
  });
  have.forEach((el) => el.remove());
}

// One quiet, collapsed group ("Nearby (5)"); rows update in place on every scan.
function renderFound() {
  const box = $('foundNet');
  // Not the ones already shown above: connected, or enrolled-and-on-record under "Enrolled".
  let list = found.filter((f) => !isConnected(f) && !fleetSerial(serialFromName(f)));
  const nameOf = svcName;
  const known = classKnown();
  const total = list.length;
  if (known) {
    list = [...list].sort((x, y) => isOurs(clsOf(y)) - isOurs(clsOf(x)) || x.addr.localeCompare(y.addr));   // ours first, then a fixed order
    if (onlyOurs) list = list.filter((f) => isOurs(clsOf(f)));
  }
  nearPrev = total;
  if (!total) { box.innerHTML = ''; return; }
  let head = box.querySelector(':scope > .sec.toggle'), rows = box.querySelector(':scope > .nbrows');
  if (!head) {
    box.innerHTML = '<div class="sec toggle" data-grp role="button"></div><div class="nbrows"></div>';
    head = box.firstChild; rows = box.lastChild;
  }
  const sw = known && nearOpen ? `<label class="sw ${onlyOurs ? 'on' : ''}" data-only title="Hide phones that are not ours">Only ours<i></i></label>` : '';
  const headHtml = `${CHEVR(nearOpen)}Nearby <span class="count">${known && onlyOurs ? list.length + '/' + total : total}</span>${sw}`;
  if (head._html !== headHtml) { head.innerHTML = headHtml; head._html = headHtml; head.setAttribute('aria-expanded', nearOpen); }
  list = list.filter((f, i) => list.findIndex((g) => svcKey(g) === svcKey(f)) === i);    // one row per phone
  // Long lists are cut down until "Show more": on an office network this can be dozens of phones.
  const over = nearOpen && !nearAll && list.length > NEARBY_AT_FIRST ? list.length - NEARBY_AT_FIRST : 0;
  if (over) list = list.slice(0, NEARBY_AT_FIRST);
  const items = nearOpen ? (list.length ? [...list, ...(over ? [{ more: over }] : [])] : [{ none: true }]) : [];
  // Keyed by the phone (its mDNS name), not its address: an IP change updates the row, it doesn't replace it.
  syncRows(rows, items, (f) => (f.none ? '-none-' : f.more ? '-more-' : svcKey(f)), (f) => {
    if (f.none) return { cls: 'sec', html: 'None of these are ours.', attrs: { style: 'font-weight:400' } };
    if (f.more) return { cls: 'sec more', html: `Show ${f.more} more`, attrs: { 'data-more': '1', role: 'button' } };
    const c = clsOf(f), sn = serialFromName(f);
    return {
      cls: `sitem ${known && !isOurs(c) ? 'other' : ''} ${svcKey(f) === peek ? 'on' : ''}`.replace(/\s+/g, ' ').trim(),
      attrs: { 'data-addr': f.addr, role: 'button' },
      html: `<span class="glyph" style="--g:${c && c.class === 'fleet' ? '#f9674e' : '#8e8e93'}">${ICON.phone}</span><span class="two"><b>${esc(nameOf(f))}</b><small>${esc(f.addr.split(':')[0])}${sn ? ' · ' + esc(sn) : ''}</small>${classChipHTML(c)}</span><button class="cc-btn sm" data-go>Pair</button>`,
    };
  });
}
$('foundNet').addEventListener('click', async (e) => {
  if (e.target.closest('[data-only]')) { onlyOurs = !onlyOurs; store.set('onlyOurs', onlyOurs ? '1' : '0'); return renderFound(); }
  if (e.target.closest('[data-grp]')) { nearOpen = !nearOpen; nearAll = false; store.set('nearOpen', nearOpen ? '1' : '0'); return renderFound(); }
  if (e.target.closest('[data-more]')) { nearAll = true; return renderFound(); }
  const row = e.target.closest('[data-addr]');
  if (!row) return;
  const f = found.find((x) => x.addr === row.dataset.addr) || { addr: row.dataset.addr, name: '' };
  // Only the Pair button pairs. The row itself opens the phone in the right pane.
  if (e.target.closest('[data-go]')) return pairSvc(f);
  peek = svcKey(f); peekAddr = f.addr; selected = null; todayMode = false; heroKey = '';
  refresh();
});
// Everything needed to pair one nearby phone, from its discovery entry.
// The best name we have for a phone we haven't connected to: one we've seen before, else the model
// the MDM knows (a fleet device's own name, or the model of the family its serial belongs to).
const svcName = (f) => { const c = clsOf(f) || {}; return (savedPhones.find((p) => f.addr.startsWith(p.host + ':')) || {}).name || c.name || c.family || 'Phone'; };
const pairSvc = (f) => openPairFor(hostOf(f.addr), svcName(f), serialFromName(f), clsOf(f));


// ---- Pairing screens: listed in the rail, and a popup asks for the code ----
const serialOfSvc = serialFromName;
const pairName = (s) => (savedPhones.find((p) => s.addr.startsWith(p.host + ':')) || {}).name || (clsOf(s) || {}).name || 'Phone';
let pairAddr = '', pairBusy = false;
const pairDismissed = new Set();    // closed by the person: don't pop up again until it goes away and returns
const pairAutoOpened = new Set();   // already popped up once

function renderPairing() {
  const box = $('pairNet');
  const ordered = [...pairScreens].sort((x, y) => (classKnown() ? isOurs(clsOf(y)) - isOurs(clsOf(x)) : 0) || x.addr.localeCompare(y.addr));
  if (!ordered.length) { box.innerHTML = ''; return; }
  if (!box.querySelector(':scope > .sec')) box.innerHTML = '<div class="sec"><span class="livedot"></span>Pairing requests</div><div class="nbrows"></div>';
  syncRows(box.lastChild, ordered, (sv) => sv.addr, (sv) => {
    const sn = serialOfSvc(sv);
    return { cls: 'sitem pair', attrs: { 'data-addr': sv.addr, role: 'button' },
      html: `<span class="glyph" style="--g:#0a84ff">${ICON.phone}</span><span class="two"><b>${esc(pairName(sv))}</b><small>${esc(sv.addr.split(':')[0])}${sn ? ' · ' + esc(sn) : ''}</small>${classChipHTML(clsOf(sv))}</span><span class="go">Enter code</span>` };
  });
}
$('pairNet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-addr]');
  if (!b) return;
  const s = pairScreens.find((x) => x.addr === b.dataset.addr);
  if (s) { pairDismissed.delete(s.addr); openPairModal(s); }
});

function openPairModal(s) {
  pairAddr = s.addr; pairBusy = false;
  const sn = serialOfSvc(s);
  $('pmIc').innerHTML = ICON.phone;
  $('pmTitle').textContent = 'Pair with ' + pairName(s);
  $('pmMeta').textContent = s.addr.split(':')[0] + (sn ? ' · ' + sn : '');
  $('pmAsk').textContent = 'Enter the 6-digit code shown on the phone.';
  $('pmCode').hidden = false;
  const hc = clsOf(s), hint = $('pmHint');
  hint.hidden = !hc || hc.class === 'other';
  hint.innerHTML = hc && hc.class !== 'other' ? classChipHTML(hc) : '';
  $('pmCode').value = ''; $('pmCode').disabled = false;
  $('pmMsg').innerHTML = '';
  $('pmConn').hidden = true; $('pmGo').hidden = false;
  $('pmGo').disabled = true; $('pmGo').textContent = 'Pair';
  $('pairModal').hidden = false;
  setTimeout(() => $('pmCode').focus(), 50);
  $('pmCode').animate([{ boxShadow: '0 0 0 0 rgba(249,103,78,.5)' }, { boxShadow: '0 0 0 8px rgba(249,103,78,0)' }], { duration: 700 });
}
// Pair one particular phone (from Nearby or Saved). Its pairing screen may not be open yet: show the
// sheet straight away with the instructions, and fill in the address the moment that phone (same IP)
// announces its pairing screen.
let pairWantHost = '', quickTok = null;
// Pair from Nearby / Saved. A phone that already trusts this computer's adb key (AIO firmware has it
// built in; a phone paired before does too) connects without a code, so try that first and only
// ask for the code when it fails.
async function openPairFor(host, name, serial, cls) {
  const tok = (quickTok = {});
  pairWantHost = ''; pairAddr = ''; pairBusy = false;
  $('pmIc').innerHTML = ICON.phone;
  $('pmTitle').textContent = 'Connecting to ' + name;
  $('pmMeta').textContent = host + (serial ? ' · ' + serial : '');
  const hint = $('pmHint'); hint.hidden = !cls || cls.class === 'other'; hint.innerHTML = cls && cls.class !== 'other' ? classChipHTML(cls) : '';
  $('pmAsk').textContent = '';
  $('pmCode').hidden = true; $('pmConn').hidden = true; $('pmGo').hidden = true;
  $('pmMsg').innerHTML = '<div class="wmsg waitmsg"><span class="spin"></span> Trying without a code first…</div>';
  $('pairModal').hidden = false;
  let handle = null;
  try { handle = await invoke('wifi_connect_known', { host, addrs: found.filter((f) => hostOf(f.addr) === host).map((f) => f.addr) }); } catch {}
  if (quickTok !== tok || $('pairModal').hidden) return;      // cancelled meanwhile
  $('pmCode').hidden = false; $('pmGo').hidden = false;
  if (handle) return pairSucceeded(handle, 'Connected — no code needed');
  askPairFor(host, name, serial, cls, true);
}
// `tried` = we already offered this computer's adb key and it was refused, so say so rather than
// leaving an unexplained spinner.
function askPairFor(host, name, serial, cls, tried) {
  const s = pairScreens.find((x) => hostOf(x.addr) === host);
  if (s) { pairWantHost = ''; pairDismissed.delete(s.addr); return openPairModal(s); }
  pairWantHost = host; pairAddr = ''; pairBusy = false;
  $('pmIc').innerHTML = ICON.phone;
  $('pmTitle').textContent = 'Pair with ' + name;
  $('pmMeta').textContent = host + (serial ? ' · ' + serial : '');
  const hint = $('pmHint'); hint.hidden = !cls || cls.class === 'other'; hint.innerHTML = cls && cls.class !== 'other' ? classChipHTML(cls) : '';
  $('pmAsk').innerHTML = 'On the phone: <b>Developer options → Wireless debugging → Pair device with pairing code</b>.';
  $('pmCode').value = ''; $('pmCode').disabled = true; $('pmCode').hidden = false;
  $('pmMsg').innerHTML = `<div class="wmsg waitmsg"><span class="spin"></span> ${tried ? 'It doesn’t trust this computer’s adb key yet. ' : ''}Waiting for its pairing screen…</div>`;
  $('pmConn').hidden = true; $('pmGo').hidden = false; $('pmGo').disabled = true; $('pmGo').textContent = 'Pair';
  $('pairModal').hidden = false;
}
function closePairModal() { $('pairModal').hidden = true; pairAddr = ''; pairBusy = false; quickTok = null; }
function dismissPairModal() { if (pairAddr) pairDismissed.add(pairAddr); pairWantHost = ''; closePairModal(); }
$('pmCancel').addEventListener('click', dismissPairModal);
$('pairModal').addEventListener('click', (e) => { if (e.target === $('pairModal') && !pairBusy) dismissPairModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pairModal').hidden && !pairBusy) dismissPairModal(); });
$('pmCode').addEventListener('input', () => {
  const c = $('pmCode'); c.value = c.value.replace(/\D/g, '').slice(0, 6);
  $('pmGo').disabled = pairBusy || c.value.length !== 6;
});
$('pmCode').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('pmGo').disabled) $('pmGo').click(); });
function pairSucceeded(handle, title = 'Paired and connected') {
  $('pmIc').innerHTML = CHECK; $('pmTitle').textContent = title;
  $('pmAsk').textContent = ''; $('pmMsg').innerHTML = '';
  $('pmCode').hidden = true; $('pmGo').hidden = true; $('pmCancel').hidden = true; $('pmConn').hidden = true;
  unignore(String(handle).split(':')[0]);
  setTimeout(() => {
    $('pmCode').hidden = false; $('pmGo').hidden = false; $('pmCancel').hidden = false;
    closePairModal(); selected = handle; peek = null; todayMode = false; heroKey = ''; tick();
  }, 1100);
}
$('pmGo').addEventListener('click', async () => {
  if (!pairAddr || pairBusy) return;
  pairBusy = true; $('pmCode').disabled = true; $('pmGo').disabled = true;
  $('pmGo').innerHTML = '<span class="spin"></span> Pairing…'; $('pmMsg').innerHTML = '';
  const t = setTimeout(() => { if (pairBusy) $('pmGo').innerHTML = '<span class="spin"></span> Connecting…'; }, 2500);
  try {
    pairSucceeded(await invoke('wifi_pair_connect', { addr: pairAddr, code: $('pmCode').value }));
    clearTimeout(t);
  } catch (err) {
    clearTimeout(t);
    pairBusy = false; $('pmGo').textContent = 'Pair';
    const [main, details] = String(err).split('\nDetails: ');
    $('pmMsg').innerHTML = `<div class="wmsg bad">${esc(main)}${details ? `<div class="wdet mono">${esc(details)}</div>` : ''}</div>`;
    if (String(err).startsWith('Paired, but')) {
      // The code is spent and the phone IS paired; all that is left is `adb connect` to its own address.
      $('pmGo').hidden = true; $('pmCode').disabled = true;
      $('pmAddr').value = pairAddr.split(':')[0] + ':';
      $('pmConn').hidden = false; setTimeout(() => { $('pmAddr').focus(); $('pmAddr').setSelectionRange(99, 99); }, 50);
    } else {
      $('pmCode').disabled = false;
      $('pmGo').disabled = $('pmCode').value.length !== 6;
      $('pmCode').select();
    }
  }
});
$('pmAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pmConnBtn').click(); });
$('pmConnBtn').addEventListener('click', async () => {
  const addr = $('pmAddr').value.trim();
  if (!addr || pairBusy) return;
  pairBusy = true; $('pmConnBtn').disabled = true; $('pmConnBtn').innerHTML = '<span class="spin"></span> Connecting…';
  $('pmMsg').innerHTML = '';
  try {
    await invoke('wifi_connect', { addr });       // sends `adb connect <addr>` (retried, restarts adb on the last try)
    pairBusy = false; pairSucceeded(addr);
  } catch (err) {
    pairBusy = false; $('pmConnBtn').disabled = false; $('pmConnBtn').textContent = 'Connect';
    $('pmMsg').innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
  }
});

// A NEW pairing screen pops the code popup up by itself (not while the Add-over-Wi-Fi panel is
// open, which handles it); one the person closed stays closed until it goes away and comes back.
function autoPairPopup() {
  if (pairWantHost && !$('pairModal').hidden && !pairAddr) {
    const s = pairScreens.find((x) => hostOf(x.addr) === pairWantHost);
    if (s) { pairWantHost = ''; pairAutoOpened.add(s.addr); openPairModal(s); }
    return;
  }
  const live = new Set(pairScreens.map((s) => s.addr));
  for (const a of [...pairAutoOpened]) if (!live.has(a)) { pairAutoOpened.delete(a); pairDismissed.delete(a); }
  if (pairAddr && !live.has(pairAddr) && !pairBusy && !$('pairModal').hidden) {
    // The dialog on the phone was closed (pairing cancelled, or Back) while the popup was open.
    closePairModal();
    alertBanner('Pairing was cancelled on the phone.');
    return;
  }
  if (!$('pairModal').hidden) return;
  const fresh = pairScreens.find((s) => !pairAutoOpened.has(s.addr) && !pairDismissed.has(s.addr));
  if (fresh) { pairAutoOpened.add(fresh.addr); openPairModal(fresh); }
}


function renderSaved() {
  const box = $('saved');
  learnPhones();
  const online = (p) => rawDevices.some((x) => x.handle.startsWith(p.host + ':')) || found.some((f) => f.addr.startsWith(p.host + ':'));
  const list = savedPhones.filter((p) => !online(p));
  const sig = list.map((p) => [p.host, p.name, p.serial, p.android, p.firmware].join('~')).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = list.length ? `<div class="sec">Saved</div>` + list.map((p) => {
    const tip = [p.name || 'Unknown phone', p.serial ? 'S/N ' + p.serial : '', p.host, p.android ? 'Android ' + p.android : '', p.name ? '' : 'not authorized yet'].filter(Boolean).join(' · ');
    return `<div class="sitem sv" data-host="${esc(p.host)}" title="${esc(tip)}"><span class="glyph" style="--g:#aeaeb2">${ICON.phone}</span><span class="two"><b>${esc(p.name || 'Unknown phone')}</b><small>${esc(p.serial || p.host)}</small></span><span class="go" data-re>Pair again</span><span class="x" data-rm title="Unpair and remove" aria-label="Unpair and remove">${ICON.x}</span></div>`;
  }).join('') : '';
}
$('saved').addEventListener('click', async (e) => {
  const row = e.target.closest('.sv');
  if (!row) return;
  const host = row.dataset.host;
  if (e.target.closest('[data-rm]')) {
    const p = savedPhones.find((x) => x.host === host) || {};
    if (!(await confirmSheet(`Unpair ${p.name || 'this phone'}?`, UNPAIR_BODY, 'Unpair'))) return;
    try { alertBanner(await invoke('device_unpair', { serial: p.serial || '', handles: [] })); } catch (err) { alertBanner(String(err), true); }
    savedPhones = savedPhones.filter((p) => p.host !== host); saveSaved();
    if (!ignoredHosts.includes(host)) { ignoredHosts.push(host); saveIgnored(); }
    delete $('saved').dataset.sig;      // an empty list has the same signature as before; force the redraw
    return renderSaved();
  }
  if (e.target.closest('[data-re]')) {
    const p = savedPhones.find((x) => x.host === host) || {};
    openPairFor(host, p.name || 'Phone', p.serial || '', null);
  }
});

// Search: a device matches on its name, serial or adb address.
const matches = (d) => { const q = query.trim().toLowerCase(); return !q || [d.name, d.serial, d.handle].some((x) => String(x || '').toLowerCase().includes(q)); };
const visibleDevices = () => devices.filter(matches);
const hl = (text) => {
  const q = query.trim(), t = String(text || '');
  const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
};
// Enrol progress for the list: 0..1 while queued or enrolling, null otherwise.
const progressOf = (d) => {
  const r = run[d.handle];
  if (r?.queued) return 0;
  if (d.status === 'enrolling') return Math.min(1, (r?.step ?? 0) / STEPS.length);
  return null;
};
const RING = (p) => `<svg class="ring" viewBox="0 0 16 16"><circle class="bg" cx="8" cy="8" r="6.3"/><circle class="fg" cx="8" cy="8" r="6.3" stroke-dasharray="39.6" stroke-dashoffset="${(39.6 * (1 - p)).toFixed(1)}"/></svg>`;

// ---- The sidebar's sections, the same five the Android app shows -------------------------
// Pairing request · Ready to enrol · Enrolled · Connected · Nearby. Which one a device is in is a
// fact about the device, not about whether we happen to hold a socket to it — an enrolled phone
// seen on the Wi-Fi belongs under Enrolled even when nothing is connected to it.
const fleetSerial = (sn) => sn && ((classCache.get(sn) || {}).c || {}).class === 'fleet';
const isDone = (d) => d.status === 'enrolled' || (d.status === 'firmware' && d.server_seen) || fleetSerial(d.serial);
// Our agent already owns it but this MDM has no record: that still needs enrolling, so it stays
// under "Ready to enrol" rather than being filed as done (the Android app counts it as done).
const sectionOf = (d) => (isDone(d) ? 'enrolled' : ['ready', 'enrolling'].includes(d.status) ? 'ready' : 'connected');

const SECTIONS = [['ready', 'Ready to enrol'], ['enrolled', 'Enrolled'], ['connected', 'Connected']];
const rowHTML = (d) => {
  const ticked = d.status === 'enrolled' || (d.status === 'firmware' && d.server_seen);
  const p = progressOf(d), q = query.trim(), r = run[d.handle];
  const qline = r?.queued ? 'Waiting…' : d.status === 'enrolling' ? (STEPS[r?.step ?? 0] || 'Enrolling') + '…' : '';
  const label = q || qline
    ? `<span class="two"><b>${hl(d.name || 'Unknown device')}</b><small class="${qline ? 'qstep' : ''}">${qline ? esc(qline) : hl(d.serial || d.handle)}</small></span>`
    : `<span class="nm">${esc(d.name || 'Unknown device')}</span>`;
  return `<span class="glyph" style="--g:${glyphOf(d)}">${iconOf(d)}</span>${label}<span class="conn">${connIcons(d)}</span><span class="stat">${
    p !== null ? RING(p) : ticked ? `<span class="tick">${CHECK}</span>` : `<i class="${dotOf(d)}"></i>`}</span>`;
};

function renderRail() {
  renderFound();
  renderSaved();
  renderTodayNav();
  const rail = $('rail');
  let selEl = rail.querySelector('.rsel');
  if (!selEl) { selEl = document.createElement('div'); selEl.className = 'rsel'; rail.prepend(selEl); }
  const shown = visibleDevices();
  $('devCount').textContent = query.trim() ? `${shown.length} of ${devices.length}` : devices.length ? String(devices.length) : '';

  // Enrolled phones the MDM knows that are on the Wi-Fi but nothing is connected to: on record,
  // not reachable from here. They belong with the other enrolled ones, not in a list of strangers.
  let onRecord = [];
  if (!query.trim()) {
    const here = new Set(devices.flatMap((d) => [hostOf(d.handle), ...(d.conns || []).map((c) => hostOf(c.handle))]).filter(Boolean));
    onRecord = found.filter((f) => !here.has(hostOf(f.addr)) && !isConnected(f) && fleetSerial(serialFromName(f)))
      .filter((f, i, a) => a.findIndex((g) => svcKey(g) === svcKey(f)) === i);
  }
  // One flat list of labels and rows, so a device moving between sections just moves its row.
  const items = [];
  for (const [key, title] of SECTIONS) {
    const list = shown.filter((d) => sectionOf(d) === key);
    const extra = key === 'enrolled' ? onRecord : [];
    if (!list.length && !extra.length) continue;
    items.push({ head: key, title });
    list.forEach((d) => items.push({ d }));
    extra.forEach((f) => items.push({ svc: f }));
  }

  syncRows(rail, items, (x) => (x.head ? 'h:' + x.head : x.d ? 'd:' + x.d.handle : 's:' + svcKey(x.svc)), (x) => {
    if (x.head) return { cls: 'sec', html: esc(x.title) };
    if (x.svc) {
      const c = clsOf(x.svc), sn = serialFromName(x.svc);
      return { cls: 'sitem off' + (svcKey(x.svc) === peek ? ' on' : ''), attrs: { 'data-svc': x.svc.addr, role: 'button', title: 'Enrolled in the MDM; nothing is connected to it from here' },
        html: `<span class="glyph" style="--g:#8e8e93">${ICON.phone}</span><span class="two"><b>${esc(svcName(x.svc))}</b><small>${esc(hostOf(x.svc.addr))}${sn ? ' · ' + esc(sn) : ''}</small></span><span class="stat"><span class="tick">${CHECK}</span></span>` };
    }
    const d = x.d;
    return { cls: 'sitem' + (d.handle === selected && !todayMode ? ' on' : ''),
      attrs: { 'data-h': d.handle, role: 'button', title: `${d.name || 'Unknown device'} · ${stateLine(d)} · ${connLabel(d)}` },
      html: rowHTML(d) };
  });

  let none = rail.querySelector('.none');
  if (!shown.length) {
    if (!none) { none = document.createElement('div'); none.className = 'none'; rail.appendChild(none); }
    none.textContent = devices.length ? 'No match' : 'None connected';
  } else if (none) none.remove();
  let hint = rail.querySelector('.addhint');
  if (devices.length && !query.trim()) {
    if (!hint) { hint = document.createElement('div'); hint.className = 'addhint'; hint.innerHTML = 'To add another: <b>plug it in</b>, or open <b>Pair device with pairing code</b> on it.'; }
    rail.appendChild(hint);
  } else if (hint) hint.remove();
  // The selection glides to the selected row instead of jumping.
  const on = rail.querySelector('.sitem.on');
  if (on) { selEl.style.transform = `translateY(${on.offsetTop}px)`; selEl.style.height = on.offsetHeight + 'px'; selEl.style.opacity = 1; }
  else selEl.style.opacity = 0;
  renderBatchBtn();
}
$('rail').addEventListener('click', (e) => {
  const row = e.target.closest('[data-h]');
  if (row) { selected = row.dataset.h; peek = null; todayMode = false; if (batch) batch.follow = false; return refresh(); }
  // An enrolled phone we hold no connection to: show what the MDM knows, same as a nearby one.
  const svc = e.target.closest('[data-svc]');
  if (svc) {
    const f = found.find((x) => x.addr === svc.dataset.svc);
    if (f) { peek = svcKey(f); peekAddr = f.addr; selected = null; todayMode = false; heroKey = ''; refresh(); }
  }
});

const stepRow = (s, i, step) => `<div class="row steprow ${i < step ? 'done' : i === step ? 'now' : 'todo'}" data-i="${i}"><span class="k">${s}</span><span class="state">${i < step ? CHECK : i === step ? '<span class="spin"></span>' : ''}</span></div>`;

function setStep(handle, step) {
  // Several devices can be enrolling (Enrol all): only the one on screen moves its rows.
  const rows = selected === handle ? [...document.querySelectorAll('#hero .steprow')] : [];
  rows.forEach((r, i) => {
    const want = i < step ? 'done' : i === step ? 'now' : 'todo';
    if (r.classList.contains(want)) return;                      // only touch rows that changed
    r.classList.remove('done', 'now', 'todo'); r.classList.add(want);
    r.querySelector('.state').innerHTML = want === 'done' ? CHECK : want === 'now' ? '<span class="spin"></span>' : '';
  });
  $('pbar').style.opacity = 1;
  $('pbar').style.width = Math.min(100, (step / STEPS.length) * 100) + '%';
}
function finishBar() {
  const pb = $('pbar'); pb.style.width = '100%';
  setTimeout(() => { pb.style.opacity = 0; setTimeout(() => { pb.style.width = '0'; }, 450); }, 450);
}
// The segmented control's thumb slides under the chosen class.
function placeThumb(animate) {
  const seg = $('seg'); if (!seg) return;
  const on = seg.querySelector('button.on'), th = seg.querySelector('.th');
  if (!on || !th) return;
  if (!animate) th.style.transition = 'none';
  th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px';
  if (!animate) { void th.offsetWidth; th.style.transition = ''; }
}
function restartFade(el) { el.classList.remove('fade'); void el.offsetWidth; el.classList.add('fade'); }
// The right pane, System Settings style: a header, then grouped label/value rows.
const row = (k, v, extra = '', cls = '') => `<div class="row ${cls}"><span class="k">${k}</span>${v !== '' ? `<span class="v">${v}</span>` : ''}${extra}</div>`;
const group = (title, rows, foot = '') => `<div class="ghead">${title}</div><div class="group">${rows.filter(Boolean).join('')}</div>${foot ? `<div class="gfoot">${foot}</div>` : ''}`;
const pill = (cls, html, tip = '') => `<span class="pill ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${html}</span>`;

const peekKeyFor = (f) => {
  const sn = serialFromName(f), c = clsOf(f);
  const st = sn ? statusCache.get(sn) : null;
  return ['peek', svcKey(f), f.addr, c ? [c.class, c.device_class, c.production, c.family, c.family_count, c.last_seen].join(',') : '',
    st === undefined ? '' : st === null ? 'none' : [st.status, st.class, st.restaurant, st.agent_version, st.online, st.battery_pct, st.last_seen_at, st.enrolled_by_name].join(',')].join('|');
};
const heroKeyFor = (d) => {
  const r = d && run[d.handle];
  const pk = !d && peekSvc();
  return !adb.found ? 'adb|' + (guideOs || adb.os)
    : todayMode ? 'today'
    : pk ? peekKeyFor(pk)
    : d ? [d.handle, d.status, classOf(d.handle), r?.error || '', r?.done ? 'd' : '', r?.queued ? 'q' : '', r?.out ? 'o' + r.out.live : '', d.server_seen ? 's' : '', d.server_status || '', d.wifiHandle ? 'w' : '', d.hasUsb ? 'u' : '', d.enrolled_by || '', d.name,
      d.firmware_version || '', d.agent_version || '', d.dpc_owner ? 'o' : '', d.dpc_version || '', d.dpc_code || 0, d.online ? 'on' : '', d.restaurant || '', site.id, restaurantsList.length ? 'R' : '', agentLatest?.version_code || 0, batch ? 'B' : ''].join('|') : 'empty|' + (pairScreens.length ? 'p' : '');
};

function renderHero() {
  const hero = $('hero');
  const d = devices.find((x) => x.handle === selected);
  const r = d && run[d.handle];
  const key = heroKeyFor(d);
  if (key === heroKey) return;          // nothing visible changed: don't restart animations
  heroKey = key;
  const tok = (heroTok = {});
  const alive = () => heroTok === tok;

  if (!adb.found) {
    setBar('AIO Enroll', 'adb was not found');
    hero.classList.remove('wifi');
    const os = guideOs || adb.os;
    hero.innerHTML = Guide.adbCard(os, adb.os);
    const redraw = (o) => { guideOs = o; heroKey = ''; renderHero(); };
    Guide.wire(hero, redraw);
    return;
  }
  if (todayMode) return renderToday(alive);
  if (!d && peek) {
    const pk = peekSvc();
    if (pk) return renderPeek(pk, alive);
    // It went off the Wi-Fi, or it is connected now: in that case show it as a connected device.
    const host = hostOf(peekAddr);
    const now = host && devices.find((x) => hostOf(x.handle) === host || (x.conns || []).some((c) => hostOf(c.handle) === host));
    peek = null; peekAddr = '';
    if (now) { selected = now.handle; heroKey = ''; return renderHero(); }
  }
  if (!d) {
    // Two ways in, side by side. Nothing to click: a cable or a pairing screen is picked up by itself.
    setBar('AIO Enroll', 'No devices connected');
    const seen = pairScreens.length > 0;
    hero.innerHTML = `<div class="ehead"><h2>Connect a device</h2><p>Either way, it shows up on the left by itself.</p></div>
      <div class="ways">
        <div class="way"><h3><span class="glyph" style="--g:#8e8e93">${ICON.usb}</span>With a cable</h3>
          <ol><li>Turn on <b>USB debugging</b> (Build number ×7 → Developer options).</li><li>Plug in and tap <b>Allow</b>.</li></ol>
          <div class="ph-mini"><div class="ph-slot" id="phUsb"></div></div>
          <div class="listen"><span class="livedot"></span>Watching USB · adb ${esc((adb.version || '').replace(/^Android Debug Bridge version /, ''))}</div></div>
        <div class="way ${seen ? 'hot' : ''}"><h3><span class="glyph" style="--g:#0a84ff">${ICON.wifi}</span>Over Wi-Fi</h3>
          <ol><li>Same Wi-Fi as this computer.</li><li>Developer options → <b>Wireless debugging</b> → <b>Pair device with pairing code</b>.</li><li>Type the code when it pops up here.</li></ol>
          <div class="ph-mini"><div class="ph-slot" id="phWifi"></div></div>
          <div class="listen"><span class="livedot"></span>${seen ? 'Pairing screen found' : 'Watching for pairing screens'}</div></div>
      </div><div class="tipslot"></div>`;
    Guide.loop($('phUsb'), alive);
    if (seen) Guide.phone($('phWifi'), 'pair', alive);
    else $('phWifi').innerHTML = Guide.WD_PAIR;
    tipShown = false;
    return;
  }
  // ---- the device pane, System Settings style: a header, then grouped label/value rows.
  const sub = stateLine(d);
  setBar(d.name || 'Unknown device', sub);
  const justDone = d.status === 'enrolled' && r?.done;
  const placedAt = d.status === 'enrolled' ? d.restaurant || r?.out?.restaurant || '' : '';
  const hdr = `<div class="dhdr"><div class="dicon ${justDone ? 'done' : ''}" style="--g:${glyphOf(d)}">${justDone ? CHECK : iconOf(d)}</div><div><h1>${esc(d.name || 'Unknown device')}</h1><p>${esc(sub)}${placedAt ? ' · ' + esc(placedAt) : d.android ? ' · Android ' + esc(d.android) : ''}</p></div></div>`;
  const deviceG = group('Device', [row('Model', esc(d.name || '—')), row('Serial number', `<span class="mono">${esc(d.serial || d.handle)}</span>`), d.android ? row('Android', esc(d.android)) : '']);
  const wifiAddr = d.wifiHandle ? (d.wifiHandle.includes(':') ? d.wifiHandle : 'Wireless debugging') : '';
  const canSwitch = !isNet(d) && !d.wifiHandle && ['ready', 'enrolled', 'firmware', 'blocked'].includes(d.status);
  const connG = group('Connection', [
    d.hasUsb ? row(ICON.usb + 'USB cable', '', pill('ok', 'Connected')) : '',
    d.wifiHandle ? row(ICON.wifi + 'Wi-Fi', `<span class="mono">${esc(wifiAddr)}</span>`, `<button class="lnk" data-forget ${d.hasUsb ? `data-h="${esc(d.wifiHandle)}"` : ''} title="${d.hasUsb ? 'Disconnects the Wi-Fi link only; the cable stays connected' : 'Disconnects it for now; Pair under Nearby connects it again'}">Disconnect</button>${
        plainAdb(d) ? '' : '<button class="lnk danger" data-unpair title="Disconnects and removes the pairing, so it no longer reconnects by itself">Unpair…</button>'}`)
      : canSwitch ? row(ICON.wifi + 'Wi-Fi', 'Not connected', `<button class="lnk" data-towifi title="No pairing needed: reads the phone’s address over the cable and connects to it">Switch to Wi-Fi</button>`) : '',
  ], d.hasUsb && d.wifiHandle ? 'It’s safe to unplug the cable — the phone stays connected over Wi-Fi.' : '');

  let enrolG = '', extra = '', acts = '';
  const goesTo = site.id ? `<b style="color:var(--text);font-weight:500">${esc(site.name)}</b>` : 'Onboarding inbox';
  const agentV = d.dpc_version || d.agent_version || '';
  const behind = !!(agentLatest && d.dpc_code && agentLatest.version_code > d.dpc_code);
  const agentRow = (suffix = '') => agentV || behind ? row('Agent', esc(agentV + suffix),
    behind ? `<button class="cc-btn sm primary" data-update title="Installs it over USB/Wi-Fi now; keeps Device Owner and settings">${ICON.up} Update to ${esc(agentLatest.version)}</button>`
      : agentLatest && d.dpc_code ? pill('ok', 'Up to date') : '') : '';
  if (d.status === 'ready' && r?.queued) {
    enrolG = group('Enrollment', [row('Status', '', pill('warn', 'Waiting in the queue')), row('Used as', esc(classOf(d.handle))), row('Goes to', goesTo)],
      'It starts as soon as the devices ahead of it finish.');
  } else if (d.status === 'ready') {
    const cls = classOf(d.handle);
    const ours = d.dpc_owner;
    enrolG = group('Enrollment', [
      row('Status', '', ours ? pill('warn', 'Not registered with this MDM') : pill('warn', 'Not enrolled')),
      ours ? agentRow(' · Device Owner') : '',
      row('Used as', '', `<div class="seg" id="seg"><span class="th"></span>${CLASSES.map((c) => `<button data-c="${c}" class="${c === cls ? 'on' : ''}">${c}</button>`).join('')}</div>`),
      restaurantsList.length ? row('Goes to', goesTo, `<button class="lnk" data-site>Change</button>`) : '',
      row('Enrolled by', esc($('whoName').textContent || 'You')),
    ], ours ? 'Our agent already manages this phone, but this MDM has no record of it — it was probably enrolled to another server, or removed here. Re-enrolling registers it here and updates the agent; nothing is reset.'
      : !cls ? 'Pick what this device is used as. The MDM fills this in by itself only for a model it already knows.'
      : site.id ? 'It skips the onboarding inbox and shows up in this restaurant right away.' : 'The class tells the MDM what this device is. It can be changed later on the dashboard.');
    acts = `<div class="dacts">${r?.error ? `<span class="err shake">${esc(r.error)}</span>` : ''}<button class="cc-btn primary lg" id="go" ${batch || !cls ? 'disabled' : ''} ${
      cls ? '' : 'title="Pick what this device is used as first"'}>${r?.error ? 'Try Again' : ours ? 'Re-enrol' : 'Enrol'} <span class="kbd">${MOD}↩</span></button></div>`;
  } else if (d.status === 'enrolling') {
    enrolG = group('Enrolling', STEPS.map((s, i) => stepRow(s, i, r?.step ?? 0)));
  } else if (d.status === 'enrolled') {
    const out = r?.out;
    const placed = d.restaurant || out?.restaurant || '';
    enrolG = group('Enrollment', [
      row('Status', '', pill('ok' + (justDone ? ' pop' : ''), ICON.check + ' Enrolled')),
      row('Used as', esc(d.class || '—')),
      row('Restaurant', placed ? esc(placed) : 'Onboarding inbox'),
      agentRow(),
      d.enrolled_by ? row('Enrolled by', esc(d.enrolled_by)) : '',
    ]);
    const online = d.online || out?.live;
    const battery = out ? (out.has_battery ? out.battery_pct + '%' : 'Mains powered') : '';
    // An older server says nothing about check-ins: show nothing rather than a wrong "Offline".
    const knows = d.online !== null && d.online !== undefined || out?.checked;
    extra = !knows ? '' : group('On the MDM', [
      row('Status', '', online ? `<span class="pill ok${justDone ? ' pop' : ''}"><span class="live"><i></i>Online</span></span>` : pill('warn', out ? 'Not heard from yet' : 'Offline')),
      out ? row('First check-in', out.live ? rel(r.at) : 'Not yet') : '',
      battery ? row('Battery', esc(battery)) : '',
    ], online ? '' : out ? 'It is enrolled but hasn’t checked in yet. Make sure it has internet; it turns Online here when it does.'
      : 'Not checking in right now. It may be switched off or offline.');
    const nxt = devices.find((x) => x.status === 'ready' && x.handle !== d.handle);
    acts = `<div class="dacts">${d.serial ? `<button class="cc-btn" data-dash>${ICON.ext} Open on Dashboard</button>` : ''}${nxt && !batch ? `<button class="cc-btn primary lg" id="next">Next: ${esc(nxt.name || 'device')}</button>` : ''}</div>`;
    if (justDone) finishBar();
    if (r) r.done = false;          // animate once; the page itself stays
  } else if (d.status === 'firmware') {
    const gone = d.server_status === 'retired' || d.server_status === 'wiped';
    const mdm = d.server_seen ? pill('ok', ICON.check + ' Registered') : gone ? pill('bad', esc(d.server_status)) : pill('warn', 'Not registered yet');
    const foot = d.server_seen ? 'This device runs AIO firmware and enrolls itself. Nothing to do here.'
      : gone ? `The MDM has it marked ${esc(d.server_status)}. Restore it from the dashboard if it should be active.`
      : 'It enrolls itself the first time it checks in over the network, so make sure it has internet.';
    enrolG = group('Enrollment', [row('Managed by', 'AIO firmware client'), row('Client version', esc(d.firmware_version || '—')),
      d.build ? row('Build', `<span class="mono">${esc(d.build)}</span>`) : '', row('MDM', '', mdm), d.server_seen && d.class ? row('Used as', esc(d.class)) : ''], foot);
  } else if (d.status === 'blocked') {
    const why = String(d.note || 'Blocked').split(' — ')[0];
    const isAccount = /account/i.test(d.note || ''), isOwner = /owned by/i.test(d.note || ''), isUser = /user/i.test(d.note || '');
    // Filled in by pollChecks a moment later; this is the first guess from the list's own reading.
    const fix = (id, state, title, sub, btn = '') => `<div class="row fixrow ${state}" id="${id}"><span class="state">${state === 'ok' ? CHECK : '!'}</span><span class="k"><span>${title}</span><small>${sub}</small></span>${btn}</div>`;
    enrolG = group('Before it can be enrolled', [
      fix('fxAcc', isAccount ? 'bad' : 'ok', 'Remove the accounts on the phone', isAccount ? 'Checking…' : 'None', isAccount ? '<button class="cc-btn sm" data-accounts>Open Accounts on Phone</button>' : ''),
      fix('fxOwn', isOwner ? 'bad' : 'ok', 'No other device admin', isOwner ? esc(why) : 'Nothing else manages this phone'),
      fix('fxUsr', isUser ? 'bad' : 'ok', 'Single user', isUser ? 'Has a work profile or guest user' : 'No work profile or guest user'),
    ], '<span class="waitmsg" id="fxWait"><span class="spin"></span>Checking again every few seconds…</span>');
    const steps = ['Factory reset the phone.', ...(isAccount ? ['Don’t sign in to Google during setup.'] : []), 'Turn on USB debugging and plug it in again.'];
    extra = `<details class="reset" ${isOwner ? 'open' : ''}><summary>${isOwner ? 'How to fix' : 'Can’t remove them? Factory reset instead…'}</summary>${group('Factory reset', steps.map((s, i) => `<div class="row howto"><span class="n">${i + 1}</span><span class="k">${s}</span></div>`), 'Android only lets an app become Device Owner on a phone with no accounts and one user.')}</details>`;
    acts = `<div class="dacts"><button class="cc-btn primary lg" disabled>Enrol</button></div>`;
  } else if (d.status === 'unauthorized') {
    enrolG = group('Connection', [row('Status', '', pill('warn', 'Waiting for Allow'))],
      'Look at the phone and tap Allow on “Allow USB debugging?”. Tick “Always allow from this computer”.');
    extra = '<div class="illus"><div class="ph-slot"></div></div>';
    acts = '<div class="dacts"><button class="cc-btn" data-reprompt>Show the Prompt Again</button></div>';
  } else {
    enrolG = group('Status', [row('Status', '', pill('warn', esc(String(d.note || d.status).split('.')[0])))]);
  }
  const showConn = !['enrolling', 'unauthorized'].includes(d.status);
  hero.innerHTML = `<div class="dwrap">${hdr}${enrolG}${extra}${acts}${acts ? '<div style="height:18px"></div>' : ''}${showConn ? connG : ''}${d.status === 'enrolling' ? '' : deviceG}<div class="amsg towifi"></div></div>`;
  restartFade(hero);
  if (d.status === 'unauthorized') Guide.phone(hero.querySelector('.ph-slot'), 'allow', alive);
  if (d.status === 'enrolling') setStep(d.handle, r?.step ?? 0);
  if (d.status === 'blocked') pollChecks(d.handle, alive);
  placeThumb(false);
}

// A nearby phone that isn't connected yet, in the same page shape as a connected one: a header,
// what the MDM knows about it, and the button that connects it. Nothing here touches the phone —
// it is all the MDM's record, looked up by the serial its mDNS name carries.
const peekPending = new Set();
function renderPeek(f, alive) {
  const hero = $('hero');
  const name = svcName(f), sn = serialFromName(f), c = clsOf(f);
  const st = sn ? statusCache.get(sn) : undefined;
  const plain = /:5555$/.test(f.addr);
  const sub = 'On this Wi-Fi · not connected';
  setBar(name, sub);
  const glyph = c && c.class === 'fleet' ? '#f9674e' : '#8e8e93';
  const hdr = `<div class="dhdr"><div class="dicon" style="--g:${glyph}">${ICON.phone}</div><div><h1>${esc(name)}</h1><p>${esc(sub)}</p></div></div>`;

  // The MDM's record. Asked for once, by serial, and kept until the app restarts.
  if (sn && st === undefined && !peekPending.has(sn)) {
    peekPending.add(sn);
    invoke('serial_statuses', { serials: [sn] })
      .then((m) => statusCache.set(sn, m[sn] || null))
      .catch(() => statusCache.set(sn, null))
      .finally(() => { peekPending.delete(sn); if (alive()) { heroKey = ''; renderHero(); } });
  }
  const onMdm = !!(st && st.status && st.status !== 'retired' && st.status !== 'wiped');
  let knownG, foot = '';
  if (!sn) {
    knownG = group('What the MDM knows', [row('Serial number', 'Not advertised')],
      'Its Wi-Fi name doesn’t carry a serial, so the MDM can’t be asked about it until it is connected.');
  } else {
    const rows = [row('Status', '', classChipHTML(c) || `<span class="waitmsg"><span class="spin"></span>Asking the MDM…</span>`)];
    if (c && c.class === 'production' && c.production) rows.push(row('Production', esc(c.production)));
    if (c && c.class === 'family') rows.push(row('Same model as', `${c.family_count || 0} enrolled device${c.family_count === 1 ? '' : 's'}${c.family ? ' · ' + esc(c.family) : ''}`));
    if (onMdm) {
      rows.push(st.class ? row('Used as', esc(st.class)) : '');
      rows.push(row('Restaurant', st.restaurant ? esc(st.restaurant) : 'Onboarding inbox'));
      rows.push(st.agent_version ? row('Agent', esc(st.agent_version)) : '');
      rows.push(st.enrolled_by_name ? row('Enrolled by', esc(st.enrolled_by_name)) : '');
    } else if (c && c.class !== 'other' && st !== undefined) {
      foot = 'The MDM has no device record for this serial yet. Connecting it here is how it gets one.';
    }
    knownG = group('What the MDM knows', rows, foot);
  }
  // Only for a device the MDM already has: how it is doing right now.
  const liveG = !onMdm || st.online === null || st.online === undefined ? '' : group('On the MDM', [
    row('Status', '', st.online ? '<span class="pill ok"><span class="live"><i></i>Online</span></span>' : pill('warn', 'Offline')),
    row('Last check-in', st.last_seen_at ? agoShort(st.last_seen_at) + ' ago' : 'Never', '', ''),
    st.has_battery ? row('Battery', st.battery_pct + '%') : row('Power', 'Mains powered'),
  ], st.online ? '' : 'Not checking in right now. It may be switched off, offline, or running firmware without the MDM client.');

  const connG = group('Connection', [
    row(ICON.wifi + 'Wi-Fi', `<span class="mono">${esc(f.addr)}</span>`, pill('warn', 'Not connected')),
  ], plain ? 'Plain adb is open on this phone (port 5555). It connects without a code if it already trusts this computer’s key.'
    : 'Wireless debugging is on. It connects without a code if it already trusts this computer’s key; otherwise it asks for a pairing code.');
  const deviceG = group('Device', [row('Serial number', sn ? `<span class="mono">${esc(sn)}</span>` : '—'), row('Address', `<span class="mono">${esc(f.addr)}</span>`)]);
  const acts = `<div class="dacts">${onMdm && sn ? `<button class="cc-btn" data-peekdash>${ICON.ext} Open on Dashboard</button>` : ''}<button class="cc-btn primary lg" data-peekpair>${plain ? 'Connect' : 'Pair'}</button></div>`;

  hero.innerHTML = `<div class="dwrap">${hdr}${knownG}${liveG}${acts}<div style="height:18px"></div>${connG}${deviceG}</div>`;
  restartFade(hero);
}

// The blocked checklist re-reads the phone every few seconds, so each item ticks off as it is fixed.
// Once it is clean the device list sees it as ready and the page turns into the Enrol page.
async function pollChecks(handle, alive) {
  while (alive()) {
    try {
      const c = await invoke('device_checks', { handle });
      if (!alive()) return;
      const set = (id, ok, sub) => {
        const el = $(id); if (!el) return;
        el.classList.toggle('ok', ok); el.classList.toggle('bad', !ok);
        el.querySelector('.state').innerHTML = ok ? CHECK : '!';
        el.querySelector('small').innerHTML = sub;
        const b = el.querySelector('[data-accounts]'); if (b && ok) b.remove();
      };
      set('fxAcc', !c.accounts.length, c.accounts.length ? `${c.accounts.length} left: ${c.accounts.map(esc).join(', ')}` : 'All removed');
      set('fxOwn', !c.other_owner, c.other_owner ? `Owned by ${esc(c.other_owner)}: only a factory reset removes it` : 'Nothing else manages this phone');
      set('fxUsr', c.users <= 1, c.users > 1 ? `${c.users} users: remove the work profile or guest user` : 'No work profile or guest user');
      if (!c.accounts.length && !c.other_owner && c.users <= 1) $('fxWait').innerHTML = '<span class="spin"></span>All clear. Getting it ready…';
    } catch {}
    await sleep(3000);
  }
}

document.addEventListener('click', (e) => {
  if (fixOpen && !e.target.closest('.hpop,[data-fix]')) { fixOpen = false; heroKey = ''; renderHero(); }
});

function refresh() { renderRail(); renderHero(); }

// A Mac-style confirmation sheet. Resolves true when the person confirms.
function alertBanner(text, bad) {
  let b = document.querySelector('.banner');
  if (!b) { b = document.createElement('div'); b.className = 'banner'; document.body.appendChild(b); }
  b.className = 'banner' + (bad ? ' bad' : ''); b.textContent = text;
  requestAnimationFrame(() => b.classList.add('show'));
  clearTimeout(alertBanner.t); alertBanner.t = setTimeout(() => b.classList.remove('show'), 6000);
}
const CF_ICON = $('cfIc').innerHTML;      // the unlink icon of the destructive (Unpair) sheet
function confirmSheet(title, bodyHTML, yesLabel, { danger = true, icon = '' } = {}) {
  return new Promise((resolve) => {
    $('cfTitle').textContent = title; $('cfBody').innerHTML = bodyHTML; $('cfYes').textContent = yesLabel;
    $('cfYes').classList.toggle('danger', danger);
    $('cfIc').classList.toggle('plain', !danger); $('cfIc').innerHTML = icon || CF_ICON;
    $('confirm').hidden = false; setTimeout(() => $('cfNo').focus(), 30);
    const done = (v) => { $('confirm').hidden = true; document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', key);
    $('cfYes').onclick = () => done(true); $('cfNo').onclick = () => done(false);
    $('confirm').onclick = (e) => { if (e.target === $('confirm')) done(false); };
  });
}
const UNPAIR_BODY = 'This computer disconnects and stops reconnecting to it by itself. Pairing again needs a new code.<br><br>The phone keeps its own list: to remove this computer there too, tap it under <b>Wireless debugging → Paired devices</b> and choose <b>Forget</b>. The app opens that screen on the phone if it is still connected.';
const serialFromHandles = (hs) => hs.map((h) => (/^adb-(.+)-[A-Za-z0-9]{4,8}\._adb-tls-/.exec(h) || [])[1]).find(Boolean) || '';
// Every Wi-Fi connection a phone currently has (an entry may stand for several).
const wifiHandlesOf = (d) => { const w = (d.conns || []).filter((c) => c.kind === 'wifi').map((c) => c.handle); return w.length ? w : isNet(d) ? [d.handle] : []; };
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
  // The nearby-phone page: it has no connection, so only these two buttons.
  const pk = !selected && peekSvc();
  if (pk) {
    if (e.target.closest('[data-peekpair]')) return pairSvc(pk);
    if (e.target.closest('[data-peekdash]')) return invoke('open_dashboard', { serial: serialFromName(pk) }).catch(() => {});
  }
  const d = devices.find((x) => x.handle === selected);
  if (!d) return;
  if (e.target.closest('[data-fix]')) { fixOpen = !fixOpen; heroKey = ''; return renderHero(); }
  const sw = e.target.closest('[data-towifi]');
  if (sw) {
    const label = sw.innerHTML, msg = document.querySelector('#hero .towifi');
    sw.disabled = true; sw.innerHTML = '<span class="spin"></span> Switching…';
    try {
      const m = await invoke('device_to_wifi', { handle: d.handle });
      msg.innerHTML = `<div class="wmsg ok" style="font-size:12px">${esc(m)}</div>`;
      sw.innerHTML = ICON.check + 'On Wi-Fi';
      setTimeout(() => { heroKey = ''; tick(); }, 800);
    } catch (err) {
      msg.innerHTML = `<div class="wmsg bad" style="font-size:12px">${esc(err)}</div>`;
      sw.disabled = false; sw.innerHTML = label;
    }
    return;
  }
  if (e.target.closest('[data-unpair]')) {
    const ok = await confirmSheet(`Unpair ${d.name || 'this phone'}?`, UNPAIR_BODY, 'Unpair');
    if (!ok) return;
    const msg = hero_amsg(), handles = wifiHandlesOf(d), serial = d.serial || serialFromHandles(handles);
    if (msg) msg.innerHTML = '<div class="wmsg waitmsg"><span class="spin"></span> Unpairing…</div>';
    try {
      const m = await invoke('device_unpair', { serial, handles });
      const hosts = handles.filter((h) => h.includes(':')).map(hostOf);
      savedPhones = savedPhones.filter((p) => !hosts.includes(p.host) && !(serial && p.serial === serial)); saveSaved();
      hosts.forEach((hh) => { if (!ignoredHosts.includes(hh)) ignoredHosts.push(hh); }); saveIgnored();
      rawDevices = rawDevices.filter((x) => !handles.includes(x.handle));
      if (!d.hasUsb) { selected = null; devices = devices.filter((x) => x.handle !== d.handle); }
      heroKey = ''; refresh();
      const m2 = hero_amsg(); if (m2) m2.innerHTML = `<div class="wmsg ok">${esc(m)}</div>`;
      else alertBanner(m);
    } catch (err) { if (msg) msg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`; }
    return tick();
  }
  const act = e.target.closest('[data-reprompt],[data-forget]');
  if (act) {
    const forget = act.hasAttribute('data-forget'), label = act.innerHTML, msg = hero_amsg();
    act.disabled = true; act.innerHTML = '<span class="spin"></span> Working…';
    try {
      if (forget) {
        // A phone is often connected several ways at once (ip:5555, the Wireless-debugging port, the
        // discovery name). Forgetting only the one in use left the others, so it popped straight back.
        const handles = wifiHandlesOf(d);
        const res = await Promise.allSettled(handles.map((h) => invoke('device_forget', { handle: h })));
        const bad = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason));
        const okN = res.length - bad.length;
        if (msg) msg.innerHTML = bad.length
          ? `<div class="wmsg bad">${okN ? `Disconnected ${okN} of ${res.length}. ` : ''}${esc(bad[0])}</div>`
          : `<div class="wmsg ok">${res.length > 1 ? `Disconnected all ${res.length} Wi-Fi connections.` : 'Disconnected.'}</div>`;
        if (okN) {
          rawDevices = rawDevices.filter((x) => !handles.includes(x.handle));
          if (!d.hasUsb) { selected = null; devices = devices.filter((x) => x.handle !== d.handle); }
          heroKey = ''; refresh();
        }
      } else {
        const m = await invoke('device_reprompt', { handle: d.handle });
        if (msg) msg.innerHTML = `<div class="wmsg ok">${esc(m)}</div>`;
      }
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
    }
    act.disabled = false; act.innerHTML = label;
    return tick();
  }
  if (e.target.closest('[data-site]')) { e.stopPropagation(); return openSitePop(); }
  if (e.target.closest('[data-dash]')) {
    try { await invoke('open_dashboard', { serial: d.serial }); } catch (err) { alertBanner(String(err), true); }
    return;
  }
  const acc = e.target.closest('[data-accounts]');
  if (acc) {
    acc.disabled = true; acc.innerHTML = '<span class="spin"></span> Opening…';
    let ok = false;
    try { ok = await invoke('open_accounts', { handle: d.handle }); } catch {}
    acc.disabled = false; acc.textContent = ok ? 'Opened on Phone ✓' : 'Open Accounts on Phone';
    if (!ok) alertBanner('Couldn’t open the Accounts screen. On the phone: Settings → Accounts (or Passwords & accounts).', true);
    return;
  }
  const upd = e.target.closest('[data-update]');
  if (upd) {
    const msg = hero_amsg();
    upd.outerHTML = '<span class="upd" id="updBusy"><span class="upbar"><i></i></span>Updating…</span>';
    try {
      const v = await invoke('agent_update', { handle: d.handle });
      alertBanner(`${d.name || 'Device'}: agent updated to ${v || agentLatest?.version || 'the latest'}.`);
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
      $('updBusy')?.remove();
    }
    heroKey = ''; return tick();
  }
  const chip = e.target.closest('[data-c]');
  if (chip) {
    picked[d.handle] = chip.dataset.c;
    chip.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === chip));
    placeThumb(true);
    heroKey = '';                      // the Enrol button turns on with the first pick
    return renderHero();
  }
  if (e.target.closest('#next')) {
    const nxt = devices.find((x) => x.status === 'ready' && x.handle !== d.handle);
    if (nxt) selected = nxt.handle;
    return refresh();
  }
  const go = e.target.closest('#go');
  if (!go || go.disabled || batch) return;
  go.classList.add('press');
  const ok = await runEnroll(d);
  if (ok) tellDone([d.handle]);
});

// adb's words for a dead link ("device 'x' not found", "closed", "protocol fault") mean nothing to
// the person holding the phone. It has almost always gone to sleep or left the Wi-Fi: say that.
const LINK_DIED = /device (?:'[^']*' )?not found|device offline|closed|protocol fault|connection (?:reset|refused)|broken pipe|no devices\/emulators found|transport|timed? ?out/i;
const humanError = (e) => {
  const s = String(e).replace(/^Error:\s*/, '').trim();
  return LINK_DIED.test(s) ? 'The device stopped answering — it may have gone to sleep, or left the Wi-Fi. Wake it and try again.' : s;
};

// Enrols one device; shared by the Enrol button and "Enrol all". True when it worked.
async function runEnroll(d) {
  const cls = classOf(d.handle), dest = { ...site };
  run[d.handle] = { step: 0 };
  d.status = 'enrolling';
  refresh();
  let ok = false;
  try {
    const out = await invoke('enroll', { handle: d.handle, class: cls, restaurantId: dest.id || null });
    run[d.handle] = { step: STEPS.length, done: true, out, at: Date.now() };
    logEnrolled({ name: d.name || 'Device', serial: out.serial || d.serial || '', cls, restaurant: out.restaurant || dest.name || '', live: out.live });
    ok = true;
  } catch (err) {
    run[d.handle] = { error: humanError(err) };
    $('pbar').style.width = '0';
  }
  heroKey = '';
  tick();
  return ok;
}

// A desktop notification when the window is in the background, so long installs can be left alone.
function tellDone(handles) {
  if (document.hasFocus()) return;
  const done = handles.map((h) => ({ d: devices.find((x) => x.handle === h), r: run[h] })).filter((x) => x.r?.out);
  if (!done.length) return;
  const one = done[0], dest = one.r.out.restaurant;
  const title = done.length > 1 ? `${done.length} devices enrolled` : `${one.d?.name || 'Device'} is ${one.r.out.live ? 'live' : 'enrolled'}`;
  const body = done.length > 1 ? done.map((x) => x.d?.name || 'Device').join(', ') : `Enrolled as ${classOf(one.d?.handle || '')}${dest ? ' · ' + dest : ''}`;
  invoke('notify', { title, body }).catch(() => {});
}

listen('enroll-step', (e) => {
  const { handle, step } = e.payload;
  run[handle] = { ...(run[handle] || {}), step };
  setStep(handle, step);
  renderRail();
});

// ---- Today's log: what this computer enrolled, kept for a week ----
let hist = [];
try { hist = JSON.parse(store.get('hist', '[]')); } catch {}
const dayOf = (t) => new Date(t).toDateString();
const todays = () => hist.filter((h) => dayOf(h.t) === new Date().toDateString());
function logEnrolled(e) {
  const week = Date.now() - 7 * 86400e3;
  hist = [{ t: Date.now(), by: $('whoName').textContent || currentUser, ...e }, ...hist.filter((h) => h.t > week && !(h.serial && h.serial === e.serial && dayOf(h.t) === dayOf(Date.now())))].slice(0, 500);
  store.set('hist', JSON.stringify(hist));
  showToday();
}
function showToday() {
  const n = todays().length;
  $('today').textContent = n ? `${n} today` : '';
  $('today').title = n ? 'Show what was enrolled today' : '';
  renderTodayNav();
}
function renderTodayNav() {
  const n = todays().length, box = $('todayNav');
  const sig = n + '|' + todayMode;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = n ? `<div class="sec">Today</div><button class="sitem ${todayMode ? 'on' : ''}" id="todayItem" style="${todayMode ? 'background:var(--sel);color:var(--accent-text)' : ''}"><span class="glyph" style="--g:#34c759">${ICON.clock}</span><span class="nm">Enrolled today</span><span class="cnt">${n}</span></button>` : '';
}
const openToday = () => { if (!todays().length) return; todayMode = true; peek = null; heroKey = ''; refresh(); };
$('todayNav').addEventListener('click', (e) => { if (e.target.closest('#todayItem')) openToday(); });
$('today').addEventListener('click', openToday);

let todayLive = {};      // serial -> status from the MDM, refreshed while the page is open
function renderToday(alive) {
  const list = todays();
  setBar('Enrolled today', `${list.length} device${list.length === 1 ? '' : 's'} · ${$('whoName').textContent || currentUser}`);
  const hero = $('hero');
  const draw = () => {
    if (!list.length) { hero.innerHTML = '<div class="tempty"><b>Nothing enrolled yet today</b>Devices you enrol show up here.</div>'; return; }
    const now = (h) => {
      const st = todayLive[h.serial];
      if (!st) return '<span class="pill">…</span>';
      return st.online ? '<span class="pill ok"><span class="live"><i></i>Online</span></span>' : st.enrolled ? '<span class="pill warn">Not heard from</span>' : `<span class="pill bad">${esc(st.status || 'Unknown')}</span>`;
    };
    const where = (h) => { const st = todayLive[h.serial]; return esc((st && st.enrolled ? st.restaurant : h.restaurant) || 'Onboarding inbox'); };
    hero.innerHTML = `<div class="dwrap" style="max-width:820px"><div class="thead"><span class="sp"></span><button class="cc-btn" data-copy>${ICON.copy} Copy Serials</button><button class="cc-btn" data-csv>Export CSV</button></div>
      <div class="group tgrp"><table class="tlist"><tr><th>Time</th><th>Device</th><th>Serial</th><th>Used as</th><th>Restaurant</th><th>Now</th></tr>${list.map((h) => `<tr>
        <td class="mono">${new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td><span class="dn"><span class="glyph" style="--g:${GLYPH[h.cls] || '#8e8e93'}">${ICON[h.cls] || ICON.phone}</span>${esc(h.name)}</span></td>
        <td class="mono">${esc(h.serial)}</td><td>${esc(h.cls)}</td><td>${where(h)}</td><td>${now(h)}</td></tr>`).join('')}</table></div>
      <div class="gfoot" style="margin-top:8px">Kept on this computer. The dashboard’s “Enrolled by” filter shows everything you enrolled anywhere.</div></div>`;
  };
  draw();
  restartFade(hero);
  (async () => {
    while (alive()) {
      const serials = [...new Set(list.map((h) => h.serial).filter(Boolean))].slice(0, 100);
      if (serials.length) {
        try { todayLive = await invoke('serial_statuses', { serials }); if (alive()) draw(); } catch {}
      }
      await sleep(10000);
    }
  })();
}
const csvCell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
$('hero').addEventListener('click', async (e) => {
  if (!todayMode) return;
  const list = todays();
  if (e.target.closest('[data-copy]')) {
    const ok = await copyText(list.map((h) => h.serial).filter(Boolean).join('\n'));
    alertBanner(ok ? `Copied ${list.length} serial${list.length === 1 ? '' : 's'}.` : 'Couldn’t copy to the clipboard.', !ok);
  }
  if (e.target.closest('[data-csv]')) {
    const rows = [['time', 'device', 'serial', 'class', 'restaurant', 'enrolled_by', 'online_now']].concat(list.map((h) => {
      const st = todayLive[h.serial] || {};
      return [new Date(h.t).toISOString(), h.name, h.serial, h.cls, (st.enrolled ? st.restaurant : h.restaurant) || '', h.by || '', st.online ? 'yes' : 'no'];
    }));
    const name = `aio-enrolled-${new Date().toISOString().slice(0, 10)}.csv`;
    try { alertBanner('Saved to ' + await invoke('save_csv', { name, content: rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n' })); }
    catch (err) { alertBanner(String(err), true); }
  }
});

// ---- Enrol all: every ready device, one after another ----
// A device with no class yet is not in the batch: it would have nothing to be enrolled as.
const readyForBatch = () => devices.filter((d) => d.status === 'ready' && !run[d.handle]?.queued && classOf(d.handle));
function renderBatchBtn() {
  const b = $('batchBtn'), n = readyForBatch().length;
  if (batch) {
    b.hidden = false; b.disabled = true;
    b.innerHTML = `<span class="spin"></span> Enrolling ${Math.min(batch.done + 1, batch.handles.length)} of ${batch.handles.length}`;
  } else {
    b.hidden = n < 2; b.disabled = false;
    b.innerHTML = `${ICON.stack} Enrol ${n} Ready`;
  }
}
$('batchBtn').addEventListener('click', async () => {
  if (batch) return;
  const list = readyForBatch();
  if (list.length < 2) return;
  const items = list.map((d) => `<li><span class="glyph" style="--g:${GLYPH[classOf(d.handle)] || '#8e8e93'}">${ICON[classOf(d.handle)] || ICON.phone}</span>${esc(d.name || 'Device')}<span>${esc(classOf(d.handle))}</span></li>`).join('');
  const ok = await confirmSheet(`Enrol ${list.length} devices?`,
    `Each one is enrolled as the class shown${site.id ? ` and goes to <b>${esc(site.name)}</b>` : ''}. To change a class, cancel and pick it on that device’s page.<ul class="cflist">${items}</ul>`,
    `Enrol ${list.length}`, { danger: false, icon: ICON.stack });
  if (!ok) return;
  batch = { handles: list.map((d) => d.handle), done: 0, ok: 0, follow: true };
  list.forEach((d) => { run[d.handle] = { queued: true }; });
  todayMode = false; heroKey = ''; refresh();
  for (const h of batch.handles) {
    const d = devices.find((x) => x.handle === h);
    if (d && d.status === 'ready') {
      delete run[h].queued;
      if (batch.follow) { selected = h; heroKey = ''; }
      if (await runEnroll(d)) batch.ok++;
    } else delete run[h];
    batch.done++;
    renderBatchBtn();
  }
  const done = batch.handles, okN = batch.ok;
  batch = null; heroKey = ''; refresh();
  alertBanner(okN === done.length ? `All ${okN} devices enrolled.` : `${okN} of ${done.length} enrolled. Open the others to see what went wrong.`, okN !== done.length);
  tellDone(done);
});

// ---- Where enrolled devices go: one restaurant for the session, picked in the toolbar ----
function loadSite() {
  try { site = JSON.parse(store.get('site:' + currentUser, 'null')) || { id: '', name: '' }; } catch { site = { id: '', name: '' }; }
  try { siteRecent = JSON.parse(store.get('siteRecent:' + currentUser, '[]')); } catch { siteRecent = []; }
}
function setSite(s) {
  site = s && s.id ? { id: s.id, name: s.name } : { id: '', name: '' };
  store.set('site:' + currentUser, JSON.stringify(site));
  if (site.id) { siteRecent = [site, ...siteRecent.filter((x) => x.id !== site.id)].slice(0, 3); store.set('siteRecent:' + currentUser, JSON.stringify(siteRecent)); }
  renderSiteBtn(); heroKey = ''; renderHero();
}
function renderSiteBtn() {
  $('siteWrap').hidden = !restaurantsList.length;
  const b = $('siteBtn');
  b.classList.toggle('none', !site.id);
  b.innerHTML = `${ICON.store}<span>${esc(site.id ? site.name : 'No restaurant')}</span>${ICON.down.replace('class="ic"', 'class="ic car"')}`;
}
async function loadRestaurants() {
  try { restaurantsList = await invoke('restaurants'); } catch { restaurantsList = []; }
  // A restaurant that was deleted (or renamed) since it was picked.
  if (site.id) { const r = restaurantsList.find((x) => x.id === site.id); if (!r && restaurantsList.length) setSite(null); else if (r && r.name !== site.name) setSite(r); }
  renderSiteBtn(); heroKey = ''; renderHero();
}
function drawSiteList() {
  const q = $('siteQ').value.trim().toLowerCase();
  const hit = (r) => !q || r.name.toLowerCase().includes(q) || (r.address || '').toLowerCase().includes(q);
  const opt = (r) => `<button class="opt ${site.id === r.id ? 'on' : ''}" data-sid="${esc(r.id)}" role="option">${ICON.store}<b>${esc(r.name)}</b><small>${esc(r.address || (r.device_count ? r.device_count + ' devices' : ''))}</small></button>`;
  const recent = q ? [] : siteRecent.map((x) => restaurantsList.find((r) => r.id === x.id)).filter(Boolean);
  const all = restaurantsList.filter(hit).filter((r) => !recent.includes(r));
  $('siteList').innerHTML = (recent.length ? '<div class="psep">RECENT</div>' + recent.map(opt).join('') : '') +
    (all.length ? (recent.length ? '<div class="psep">ALL</div>' : '') + all.map(opt).join('') : q ? '<div class="pnone">No restaurant matches</div>' : '') +
    (q ? '' : `<div class="psep"></div><button class="opt ${site.id ? '' : 'on'}" data-sid="" role="option"><b>Onboarding inbox</b><small>decide later</small></button>`);
}
function openSitePop() {
  if (!restaurantsList.length) return;
  const pop = $('sitePop');
  if (!pop.hidden) { pop.hidden = true; return; }
  $('siteQ').value = ''; drawSiteList(); pop.hidden = false;
  setTimeout(() => $('siteQ').focus(), 30);
  loadRestaurants().then(() => { if (!pop.hidden) drawSiteList(); });
}
$('siteBtn').addEventListener('click', (e) => { e.stopPropagation(); openSitePop(); });
$('siteQ').addEventListener('input', drawSiteList);
$('siteQ').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('sitePop').hidden = true; e.stopPropagation(); }
  if (e.key === 'Enter') $('siteList').querySelector('.opt')?.click();
});
$('sitePop').addEventListener('click', (e) => {
  e.stopPropagation();
  const o = e.target.closest('[data-sid]'); if (!o) return;
  setSite(o.dataset.sid ? restaurantsList.find((r) => r.id === o.dataset.sid) : null);
  $('sitePop').hidden = true;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.sitewrap')) $('sitePop').hidden = true; });

// ---- Search + keyboard ----
$('qKey').textContent = MOD + 'F';
$('q').addEventListener('input', () => {
  query = $('q').value;
  const shown = visibleDevices();
  if (shown.length && !peek && !shown.some((d) => d.handle === selected)) { selected = shown[0].handle; todayMode = false; }
  refresh();
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('q').value = ''; query = ''; $('q').blur(); refresh(); e.stopPropagation(); }
  if (e.key === 'Enter') { const f = visibleDevices()[0]; if (f) { selected = f.handle; peek = null; todayMode = false; refresh(); } $('q').blur(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1); }
});
function moveSel(dir) {
  const list = visibleDevices(); if (!list.length) return;
  const i = list.findIndex((d) => d.handle === selected);
  const n = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir))];
  selected = n.handle; peek = null; todayMode = false; if (batch) batch.follow = false; refresh();
}
const sheetOpen = () => !$('pairModal').hidden || !$('confirm').hidden;
document.addEventListener('keydown', (e) => {
  if ($('app').hidden || sheetOpen()) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (mod && k === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); const g = $('go'); if (g && !g.disabled) g.click(); return; }
  if (mod && e.shiftKey && k === 'w') { e.preventDefault(); document.querySelector('#hero [data-towifi]')?.click(); return; }
  if (!typing && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1); }
});

let pollSince = 0;
async function tick() {
  // A poll that never came back must not stop all later ones.
  if (polling && Date.now() - pollSince < 45000) return;
  polling = true; pollSince = Date.now();
  try {
    adb = await invoke('adb_status', { retry: false });
    document.querySelector('.status').classList.toggle('bad', !adb.found);
    if (!adb.found) { if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; } devices = []; selected = null; refresh(); $('foot').textContent = 'adb not found'; return; }
    const next = await invoke('list_devices');
    // A device the UI is mid-enroll on stays "enrolling" even if adb blips.
    next.forEach((d) => { if (run[d.handle] && run[d.handle].step !== undefined && !run[d.handle].done && !run[d.handle].error && d.status === 'ready') d.status = 'enrolling'; });
    rawDevices = next;
    const prevSerial = (devices.find((x) => x.handle === selected) || {}).serial;
    devices = mergeDevices(next);
    // So "Used as" can pre-fill with the class the MDM already gives this model. Fire and forget:
    // the answer lands in the cache and the next redraw picks it up.
    classifySerials(devices.filter((d) => d.status === 'ready').map((d) => d.serial))
      .then((fresh) => { if (fresh) { heroKey = ''; refresh(); } })
      .catch(() => {});
    if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; }
    if (!peek && !devices.some((d) => d.handle === selected)) {
      const same = prevSerial && devices.find((x) => x.serial === prevSerial);   // e.g. the cable was unplugged
      selected = (same || devices.find((d) => d.status === 'ready') || devices[0])?.handle ?? null;
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
      <ol><li>Settings → About phone → tap <b>Build number</b> 7 times.</li><li>Settings → Developer options → <b>USB debugging</b> on.</li><li>Plug in, tap <b>Allow</b>.</li></ol>
      <div class="tcard" style="margin-top:16px"><b>Keyboard</b><div class="keys">
        <span class="kbd">${MOD}F</span><span>Search by name or serial</span>
        <span class="kbd">↑ ↓</span><span>Move through the devices</span>
        <span class="kbd">${MOD}↩</span><span>Enrol the selected device</span>
        <span class="kbd">${MOD}${IS_MAC ? '⇧' : 'Shift+'}W</span><span>Switch it to Wi-Fi</span></div></div>`;
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
  todayMode = false; query = ''; $('q').value = ''; batch = null;
  loadSite(); renderSiteBtn();
  loadRestaurants();
  invoke('agent_info').then((a) => { agentLatest = a && a.version_code ? a : null; heroKey = ''; renderHero(); }).catch(() => {});
  showToday(); heroKey = ''; clearInterval(timer);
  tick(); timer = setInterval(tick, 2500);
  clearInterval(discTimer); discover(); discTimer = setInterval(discover, 2500);
}
const PALETTE = ['#f9674e', '#7a80f6', '#2f9e6f', '#d98a1c', '#c24a8e', '#3b82c4'];
const colorOf = (u) => PALETTE[[...u].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
let currentUser = '';
let loaded = false;   // first device list received?

// Shimmer placeholders until the first device list arrives.
function renderSkeleton() {
  loaded = false;
  $('rail').innerHTML = Array.from({ length: 3 }, () => '<div class="sitem skrow"><span class="glyph sk" style="--g:transparent"></span><span class="nm"><span class="sk" style="display:block;height:10px;width:70%"></span></span></div>').join('');
  const hero = $('hero');
  hero.className = 'hero loading';
  hero.innerHTML = '<div class="dwrap"><div class="dhdr"><div class="dicon sk" style="--g:transparent"></div><div style="flex:1"><div class="sk" style="width:200px;height:18px"></div><div class="sk" style="width:130px;height:11px;margin-top:8px"></div></div></div>' +
    '<div class="sk" style="height:118px;border-radius:10px;margin-bottom:18px"></div><div class="sk" style="height:80px;border-radius:10px"></div></div>';
  setBar('AIO Enroll', 'Looking for devices…');
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
  clearInterval(timer); clearInterval(discTimer); found = []; pairScreens = []; closePairModal();
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
$('signOut').addEventListener('click', async () => { $('acctMenu').hidden = true; await invoke('sign_out'); goSignIn(); });
function syncThemeSeg(animate) {
  const seg = $('themeSeg'), t = themeChoice();
  seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.theme === t); b.setAttribute('aria-checked', b.dataset.theme === t); });
  const on = seg.querySelector('button.on'), th = seg.querySelector('.th');
  if (!on || !th) return;
  if (!animate) th.style.transition = 'none';
  th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px';
  if (!animate) { void th.offsetWidth; th.style.transition = ''; }
}
$('acctBtn').addEventListener('click', (e) => {
  e.stopPropagation(); $('acctMail').textContent = currentUser; $('acctMenu').hidden = !$('acctMenu').hidden;
  if (!$('acctMenu').hidden) syncThemeSeg(false);
});
$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]'); if (!b) return;
  e.stopPropagation();
  try { localStorage.setItem('theme', b.dataset.theme); } catch {}
  syncThemeSeg(true); applyTheme(true);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.acctwrap')) $('acctMenu').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && document.activeElement === document.body) $('go')?.click(); });

(async () => { const me = await invoke('me'); me ? goApp(me) : goSignIn(); })();
