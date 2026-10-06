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
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  q: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
  cloud: svg('<path d="M7 18a4 4 0 0 1-.6-7.9A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>'),
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
  const auto = document.documentElement.dataset.os === 'mac' ? 1
    : Math.min(1.5, Math.max(1, Math.min(window.innerWidth / 1000, window.innerHeight / 700)));
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

let devices = [];       // one entry per phone (connections merged)
let rawDevices = [];    // one entry per adb connection
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
let fixOpen = false, fixFor = '';
let wifiMode = false, wifiPrefill = '';
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
const connIcons = (d) => (d.hasUsb ? ICON.usb : '') + (d.wifiHandle ? ICON.wifi : '');
const connLabel = (d) => (d.hasUsb && d.wifiHandle ? 'USB + Wi-Fi' : d.wifiHandle ? 'Wi-Fi' : 'USB');
const classOf = (h) => picked[h] || suggestClassFor(((devices.find((x) => x.handle === h)) || {}).serial) || store.get('class', 'dongle');
const iconOf = (d) => (d.status === 'unauthorized' ? ICON.help : ICON[d.class] || (d.status === 'firmware' ? ICON.tablet : ICON.phone));
const GLYPH = { dongle: '#5e5ce6', pos: '#ff9f0a', kds: '#28b463', kiosk: '#0a84ff', t7: '#f9674e', tablet: '#f9674e', mpos: '#bf5af2', payment: '#30b0c7' };
const glyphOf = (d) => (d.status === 'blocked' ? '#8e8e93' : GLYPH[d.class] || (d.status === 'firmware' ? '#f9674e' : '#8e8e93'));
const stateLine = (d) => ({
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
const serialFromName = (s) => { const m = /^adb-(.+)-[A-Za-z0-9]{4,8}$/.exec(s.name || ''); return m ? m[1] : ''; };
const clsOf = (svc) => (classCache.get(serialFromName(svc)) || {}).c || null;
const isOurs = (c) => !!c && ['fleet', 'production', 'family', 'lookalike'].includes(c.class);
const classKnown = () => classCache.size > 0;
async function classifyFor(list) {
  const serials = [...new Set(list.map(serialFromName).filter(Boolean))];
  const now = Date.now();
  const need = serials.filter((s) => !classCache.has(s) || now - classCache.get(s).t > 30000);
  if (!need.length || now < classOffUntil) return;
  try {
    const m = await invoke('classify_serials', { serials: need });
    need.forEach((s) => classCache.set(s, { c: m[s] || { class: 'other' }, t: now }));
  } catch { classOffUntil = now + 60000; }      // older server / offline: no labels, nothing breaks
}
const classChipHTML = (c) => {
  if (!c) return '';
  const k = { fleet: ['fleet', CHECK_I + ' In your fleet' + (c.device_class ? ' · ' + c.device_class : '')], production: ['prod', 'AIO · ' + (c.production || 'production')],
    family: ['prod', 'Like your ' + (c.family || 'enrolled devices') + (c.device_class ? ' · ' + c.device_class : '')],
    lookalike: ['look', 'Looks like ours?'], other: ['oth', 'Other phone'] }[c.class];
  return k ? `<span class="nb-chip ${k[0]}">${k[1]}</span>` : '';
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
  } catch {} finally { discBusy = false; }
}
// A phone is already connected if any connection has the same address, the same discovery name, or
// the same IP: one phone has several ports (5555 after "Switch to Wi-Fi", another for Wireless debugging).
const hostOf = (a) => (a.includes(':') ? a.slice(0, a.lastIndexOf(':')) : '');
const isConnected = (f) => rawDevices.some((x) => x.handle === f.addr || x.handle.startsWith(f.name) || (hostOf(x.handle) && hostOf(x.handle) === hostOf(f.addr)));

let nearOpen = store.get('nearOpen', '0') === '1', nearPrev = 0;
const CHEV = '<svg class="ic" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

// One quiet, collapsed row ("Nearby phones (5)") instead of a card per phone.
function renderFound() {
  const box = $('foundNet');
  let list = found.filter((f) => !isConnected(f));
  const nameOf = (f) => (savedPhones.find((p) => f.addr.startsWith(p.host + ':')) || {}).name || (clsOf(f) || {}).name || 'Phone';
  const known = classKnown();
  const total = list.length;
  if (known) {
    list = [...list].sort((x, y) => isOurs(clsOf(y)) - isOurs(clsOf(x)));          // ours first (stable)
    if (onlyOurs) list = list.filter((f) => isOurs(clsOf(f)));
  }
  const sig = list.map((f) => f.addr + nameOf(f) + ((clsOf(f) || {}).class || '') + ((clsOf(f) || {}).device_class || '')).join('|') + '|' + nearOpen + '|' + onlyOurs + '|' + known + '|' + total;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  nearPrev = total;
  if (!total) { box.innerHTML = ''; return; }
  const sw = known && nearOpen ? `<label class="sw ${onlyOurs ? 'on' : ''}" data-only title="Hide phones that are not ours">Only ours<i></i></label>` : '';
  box.innerHTML = `<div class="sec toggle" data-grp role="button" aria-expanded="${nearOpen}">${CHEVR(nearOpen)}Nearby <span class="count">${known && onlyOurs ? list.length + '/' + total : total}</span>${sw}</div>` +
    (nearOpen ? (list.length ? list.map((f, i) => {
      const c = clsOf(f), sn = serialFromName(f);
      return `<button class="sitem in ${known && !isOurs(c) ? 'other' : ''}" data-addr="${esc(f.addr)}" style="animation-delay:${i * 35}ms" title="Pair this phone"><span class="glyph" style="--g:${c && c.class === 'fleet' ? '#f9674e' : '#8e8e93'}">${ICON.phone}</span><span class="two"><b>${esc(nameOf(f))}</b><small>${esc(f.addr.split(':')[0])}${sn ? ' · ' + esc(sn) : ''}</small>${classChipHTML(c)}</span><span class="go" data-go>Pair</span></button>`;
    }).join('') : '<div class="sec" style="font-weight:400">None of these are ours.</div>') : '');
}
$('foundNet').addEventListener('click', async (e) => {
  if (e.target.closest('[data-only]')) { onlyOurs = !onlyOurs; store.set('onlyOurs', onlyOurs ? '1' : '0'); return renderFound(); }
  if (e.target.closest('[data-grp]')) { nearOpen = !nearOpen; store.set('nearOpen', nearOpen ? '1' : '0'); return renderFound(); }
  if (e.target.closest('[data-addr]')) openPair();
});


// ---- Pairing screens: listed in the rail, and a popup asks for the code ----
const serialOfSvc = (s) => { const m = /^adb-(.+)-[A-Za-z0-9]{4,8}$/.exec(s.name || ''); return m ? m[1] : ''; };
const pairName = (s) => (savedPhones.find((p) => s.addr.startsWith(p.host + ':')) || {}).name || (clsOf(s) || {}).name || 'Phone';
let pairAddr = '', pairBusy = false;
const pairDismissed = new Set();    // closed by the person: don't pop up again until it goes away and returns
const pairAutoOpened = new Set();   // already popped up once

function renderPairing() {
  const box = $('pairNet');
  const ordered = classKnown() ? [...pairScreens].sort((x, y) => isOurs(clsOf(y)) - isOurs(clsOf(x))) : pairScreens;
  const sig = ordered.map((s) => s.addr + pairName(s) + ((clsOf(s) || {}).class || '') + ((clsOf(s) || {}).device_class || '')).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = ordered.length ? `<div class="sec"><span class="livedot"></span>Pairing requests</div>` + ordered.map((s) => {
    const sn = serialOfSvc(s);
    return `<button class="sitem pair in" data-addr="${esc(s.addr)}"><span class="glyph" style="--g:#0a84ff">${ICON.phone}</span><span class="two"><b>${esc(pairName(s))}</b><small>${esc(s.addr.split(':')[0])}${sn ? ' · ' + esc(sn) : ''}</small>${classChipHTML(clsOf(s))}</span><span class="go">Enter code</span></button>`;
  }).join('') : '';
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
  const hc = clsOf(s), hint = $('pmHint');
  hint.hidden = !hc || hc.class === 'other';
  hint.innerHTML = hc && hc.class !== 'other' ? classChipHTML(hc) : '';
  $('pmCode').value = ''; $('pmCode').disabled = false;
  $('pmMsg').innerHTML = '';
  $('pmConn').hidden = true; $('pmGo').hidden = false;
  $('pmGo').disabled = true; $('pmGo').textContent = 'Pair';
  $('pairModal').hidden = false;
  setTimeout(() => $('pmCode').focus(), 50);
}
function closePairModal() { $('pairModal').hidden = true; pairAddr = ''; pairBusy = false; }
function dismissPairModal() { if (pairAddr) pairDismissed.add(pairAddr); closePairModal(); }
$('pmCancel').addEventListener('click', dismissPairModal);
$('pairModal').addEventListener('click', (e) => { if (e.target === $('pairModal') && !pairBusy) dismissPairModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pairModal').hidden && !pairBusy) dismissPairModal(); });
$('pmCode').addEventListener('input', () => {
  const c = $('pmCode'); c.value = c.value.replace(/\D/g, '').slice(0, 6);
  $('pmGo').disabled = pairBusy || c.value.length !== 6;
});
$('pmCode').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('pmGo').disabled) $('pmGo').click(); });
function pairSucceeded(handle) {
  $('pmIc').innerHTML = CHECK; $('pmTitle').textContent = 'Paired and connected';
  $('pmAsk').textContent = ''; $('pmMsg').innerHTML = '';
  $('pmCode').hidden = true; $('pmGo').hidden = true; $('pmCancel').hidden = true; $('pmConn').hidden = true;
  unignore(String(handle).split(':')[0]);
  setTimeout(() => {
    $('pmCode').hidden = false; $('pmGo').hidden = false; $('pmCancel').hidden = false;
    closePairModal(); selected = handle; wifiMode = false; heroKey = ''; tick();
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
  const live = new Set(pairScreens.map((s) => s.addr));
  for (const a of [...pairAutoOpened]) if (!live.has(a)) { pairAutoOpened.delete(a); pairDismissed.delete(a); }
  if (pairAddr && !live.has(pairAddr) && !pairBusy) {
    // The dialog on the phone was closed while the popup was open.
    $('pmMsg').innerHTML = '<div class="wmsg" style="background:var(--surface-3)">The pairing screen on the phone closed. Open “Pair device with pairing code” again.</div>';
    $('pmCode').disabled = true; $('pmGo').disabled = true;
    return;
  }
  if (!$('pairModal').hidden || wifiMode) return;
  const fresh = pairScreens.find((s) => !pairAutoOpened.has(s.addr) && !pairDismissed.has(s.addr));
  if (fresh) { pairAutoOpened.add(fresh.addr); openPairModal(fresh); }
}

function openPair() { wifiMode = true; wifiPrefill = ''; heroKey = ''; refresh(); }

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
    return `<div class="sitem sv" data-host="${esc(p.host)}" title="${esc(tip)}"><span class="glyph" style="--g:#aeaeb2">${ICON.phone}</span><span class="two"><b>${esc(p.name || 'Unknown phone')}</b><small>${esc(p.serial || p.host)}</small></span><span class="go" data-re>Pair again</span><span class="x" data-rm title="Forget" aria-label="Forget">${ICON.x}</span></div>`;
  }).join('') : '';
}
$('saved').addEventListener('click', async (e) => {
  const row = e.target.closest('.sv');
  if (!row) return;
  const host = row.dataset.host;
  if (e.target.closest('[data-rm]')) {
    savedPhones = savedPhones.filter((p) => p.host !== host); saveSaved();
    if (!ignoredHosts.includes(host)) { ignoredHosts.push(host); saveIgnored(); }
    delete $('saved').dataset.sig;      // an empty list has the same signature as before; force the redraw
    return renderSaved();
  }
  if (e.target.closest('[data-re]')) openPair();
});
$('addWifi').addEventListener('click', () => { wifiMode = true; wifiPrefill = ''; heroKey = ''; refresh(); });

function renderRail() {
  $('addWifi').classList.toggle('on', wifiMode);
  renderFound();
  renderSaved();
  const rail = $('rail');
  let selEl = rail.querySelector('.rsel');
  if (!selEl) { selEl = document.createElement('div'); selEl.className = 'rsel'; rail.prepend(selEl); }
  const have = new Map([...rail.querySelectorAll('.sitem[data-h]')].map((el) => [el.dataset.h, el]));
  devices.forEach((d, i) => {
    let el = have.get(d.handle);
    if (!el) {
      el = document.createElement('button');
      el.className = 'sitem in';
      el.dataset.h = d.handle;
      el.addEventListener('click', () => { selected = d.handle; wifiMode = false; refresh(); });
    }
    have.delete(d.handle);
    el.classList.toggle('on', d.handle === selected && !wifiMode);
    // Enrolled, or firmware the MDM has registered: a green tick instead of the status dot.
    const ticked = d.status === 'enrolled' || (d.status === 'firmware' && d.server_seen);
    // Only redraw when something visible changed, so the tick animates once, not on every poll.
    const sig = [d.name, d.status, d.class, ticked, iconOf(d).length, connLabel(d), glyphOf(d)].join('|');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.title = `${d.name || 'Unknown device'} · ${stateLine(d)} · ${connLabel(d)}`;
      el.innerHTML = `<span class="glyph" style="--g:${glyphOf(d)}">${iconOf(d)}</span><span class="nm">${esc(d.name || 'Unknown device')}</span><span class="conn">${connIcons(d)}</span><span class="stat">${
        ticked ? `<span class="tick">${CHECK}</span>` : `<i class="${dotOf(d)}"></i>`}</span>`;
    }
    const want = rail.children[i + 1];      // +1: the selection highlight is the first child
    if (want !== el) rail.insertBefore(el, want || null);
  });
  have.forEach((el) => el.remove());
  let none = rail.querySelector('.none');
  if (!devices.length && !none) { none = document.createElement('div'); none.className = 'none'; none.textContent = 'None connected'; rail.appendChild(none); }
  else if (devices.length && none) none.remove();
  // The selection glides to the selected row instead of jumping.
  const on = rail.querySelector('.sitem.on');
  if (on) { selEl.style.transform = `translateY(${on.offsetTop}px)`; selEl.style.height = on.offsetHeight + 'px'; selEl.style.opacity = 1; }
  else selEl.style.opacity = 0;
}

const stepRow = (s, i, step) => `<div class="row steprow ${i < step ? 'done' : i === step ? 'now' : 'todo'}" data-i="${i}"><span class="k">${s}</span><span class="state">${i < step ? CHECK : i === step ? '<span class="spin"></span>' : ''}</span></div>`;

function setStep(handle, step) {
  const rows = [...document.querySelectorAll('#hero .steprow')];
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
const heroKeyFor = (d) => {
  const r = d && run[d.handle];
  return !adb.found ? 'adb|' + (guideOs || adb.os)
    : wifiMode ? 'wifi'
    : d ? [d.handle, d.status, classOf(d.handle), r?.error || '', r?.done ? 'd' : '', d.server_seen ? 's' : '', d.server_status || '', d.wifiHandle ? 'w' : '', d.hasUsb ? 'u' : '', d.enrolled_by || '', d.name, d.firmware_version || '', d.agent_version || ''].join('|') : 'empty';
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
  hero.classList.toggle('wifi', wifiMode);
  if (wifiMode) {
    setBar('Add over Wi-Fi', 'Pair a phone with its 6-digit code');
    hero.innerHTML = '<div class="wh">Add a phone over Wi-Fi</div><div class="wsub">Android 11 or newer. USB is still the most reliable way.</div><div class="wbody"></div>';
    Wifi.draw(hero.querySelector('.wbody'), {
      invoke, esc, Guide, alive, devices: () => devices,
      nameForHost: (host) => (savedPhones.find((p) => p.host === host) || {}).name || '',
      onConnected: (addr) => {
        const host = String(addr).split(':')[0];
        unignore(host);
        if (String(addr).includes(':') && !savedPhones.some((p) => p.host === host)) { savedPhones.unshift({ host, name: '' }); saveSaved(); }
        setTimeout(() => { wifiMode = false; selected = addr; heroKey = ''; tick(); }, 1600);
      },
    });
    wifiPrefill = '';
    return;
  }
  if (!d) {
    setBar('AIO Enroll', 'No devices connected');
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
  // ---- the device pane, System Settings style: a header, then grouped label/value rows.
  const sub = stateLine(d);
  setBar(d.name || 'Unknown device', sub);
  const row = (k, v, extra = '', cls = '') => `<div class="row ${cls}"><span class="k">${k}</span>${v !== '' ? `<span class="v">${v}</span>` : ''}${extra}</div>`;
  const group = (title, rows, foot = '') => `<div class="ghead">${title}</div><div class="group">${rows.filter(Boolean).join('')}</div>${foot ? `<div class="gfoot">${foot}</div>` : ''}`;
  const pill = (cls, html, tip = '') => `<span class="pill ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${html}</span>`;
  const justDone = d.status === 'enrolled' && r?.done;
  const hdr = `<div class="dhdr"><div class="dicon ${justDone ? 'done' : ''}" style="--g:${glyphOf(d)}">${justDone ? CHECK : iconOf(d)}</div><div><h1>${esc(d.name || 'Unknown device')}</h1><p>${esc(sub)}${d.android ? ' · Android ' + esc(d.android) : ''}</p></div></div>`;
  const deviceG = group('Device', [row('Model', esc(d.name || '—')), row('Serial number', `<span class="mono">${esc(d.serial || d.handle)}</span>`), d.android ? row('Android', esc(d.android)) : '']);
  const wifiAddr = d.wifiHandle ? (d.wifiHandle.includes(':') ? d.wifiHandle : 'Wireless debugging') : '';
  const canSwitch = !isNet(d) && !d.wifiHandle && ['ready', 'enrolled', 'firmware', 'blocked'].includes(d.status);
  const connG = group('Connection', [
    d.hasUsb ? row(ICON.usb + 'USB cable', '', pill('ok', 'Connected')) : '',
    d.wifiHandle ? row(ICON.wifi + 'Wi-Fi', `<span class="mono">${esc(wifiAddr)}</span>`, `<button class="lnk danger" data-forget ${d.hasUsb ? `data-h="${esc(d.wifiHandle)}"` : ''} title="${d.hasUsb ? 'Disconnects the Wi-Fi link only; the cable stays connected' : 'Disconnects it from this computer; it stays enrolled in the MDM'}">Forget</button>`)
      : canSwitch ? row(ICON.wifi + 'Wi-Fi', 'Not connected', `<button class="lnk" data-towifi title="No pairing needed: reads the phone’s address over the cable and connects to it">Switch to Wi-Fi</button>`) : '',
  ], d.hasUsb && d.wifiHandle ? 'It’s safe to unplug the cable — the phone stays connected over Wi-Fi.' : '');

  let enrolG = '', extra = '', acts = '';
  if (d.status === 'ready') {
    const cls = classOf(d.handle);
    enrolG = group('Enrollment', [
      row('Status', '', pill('warn', 'Not enrolled')),
      row('Used as', '', `<div class="seg" id="seg"><span class="th"></span>${CLASSES.map((c) => `<button data-c="${c}" class="${c === cls ? 'on' : ''}">${c}</button>`).join('')}</div>`),
      row('Enrolled by', esc($('whoName').textContent || 'You')),
    ], 'The class tells the MDM what this device is. It can be changed later on the dashboard.');
    acts = `<div class="dacts">${r?.error ? `<span class="err shake">${esc(r.error)}</span>` : ''}<button class="cc-btn primary lg" id="go">${r?.error ? 'Try Again' : 'Enrol'}</button></div>`;
  } else if (d.status === 'enrolling') {
    enrolG = group('Enrolling', STEPS.map((s, i) => stepRow(s, i, r?.step ?? 0)));
  } else if (d.status === 'enrolled') {
    enrolG = group('Enrollment', [
      row('Status', '', pill('ok' + (justDone ? ' pop' : ''), ICON.check + ' Enrolled')),
      row('Used as', esc(d.class || '—')),
      d.agent_version ? row('Agent', esc(d.agent_version)) : '',
      d.enrolled_by ? row('Enrolled by', esc(d.enrolled_by)) : '',
    ]);
    const nxt = devices.find((x) => x.status === 'ready' && x.handle !== d.handle);
    acts = nxt ? `<div class="dacts"><button class="cc-btn primary lg" id="next">Next: ${esc(nxt.name || 'device')}</button></div>` : '';
    if (justDone) finishBar();
    if (r) r.done = false;
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
    const isAccount = /account/i.test(d.note || '');
    enrolG = group('Enrollment', [row('Status', '', pill('bad', 'Can’t be enrolled')), row('Reason', esc(why))],
      'Android only lets an app become Device Owner on a phone with no accounts.');
    const steps = ['Factory reset the phone.', ...(isAccount ? ['Don’t sign in to Google during setup.'] : []), 'Turn on USB debugging and plug it in again.'];
    extra = group('How to fix', steps.map((s, i) => `<div class="row howto"><span class="n">${i + 1}</span><span class="k">${s}</span></div>`));
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
  placeThumb(false);
}

document.addEventListener('click', (e) => {
  if (fixOpen && !e.target.closest('.hpop,[data-fix]')) { fixOpen = false; heroKey = ''; renderHero(); }
});

function refresh() { renderRail(); renderHero(); }

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
  const chip = e.target.closest('[data-c]');
  if (chip) {
    picked[d.handle] = chip.dataset.c;
    store.set('class', chip.dataset.c);
    chip.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === chip));
    placeThumb(true);
    heroKey = heroKeyFor(d);           // the pane already shows it
    return;
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
    $('pbar').style.width = '0';
  }
  heroKey = '';
  tick();
});

listen('enroll-step', (e) => {
  const { handle, step } = e.payload;
  run[handle] = { ...(run[handle] || {}), step };
  setStep(handle, step);
});

function showToday() { $('today').textContent = todayCount ? `${todayCount} today` : ''; }
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
    document.querySelector('.status').classList.toggle('bad', !adb.found);
    if (!adb.found) { if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; } devices = []; selected = null; refresh(); $('foot').textContent = 'adb not found'; return; }
    const next = await invoke('list_devices');
    // A device the UI is mid-enroll on stays "enrolling" even if adb blips.
    next.forEach((d) => { if (run[d.handle] && run[d.handle].step !== undefined && !run[d.handle].done && !run[d.handle].error && d.status === 'ready') d.status = 'enrolling'; });
    rawDevices = next;
    const prevSerial = (devices.find((x) => x.handle === selected) || {}).serial;
    devices = mergeDevices(next);
    if (!loaded) { loaded = true; $('rail').innerHTML = ''; $('hero').className = 'hero'; heroKey = ''; }
    if (!devices.some((d) => d.handle === selected)) {
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
