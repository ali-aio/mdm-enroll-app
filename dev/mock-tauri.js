// Dev-only: stands in for the Tauri backend so the UI can be previewed and screenshotted in a
// plain browser. Pick a scenario with ?s=devices | empty | signin | picker | pair | noadb | enrolling.
// Never shipped: tauri.conf.json bundles ../ui only.
(() => {
  const S = new URLSearchParams(location.search).get('s') || 'devices';
  const handlers = {};
  const emit = (ev, payload) => (handlers[ev] || []).forEach((f) => f({ payload }));
  const row = (o) => Object.assign({ adb_state: 'device', name: '', serial: '', android: '', status: 'ready', note: '', class: '', agent_version: '',
    firmware_version: '', build: '', server_seen: false, dpc_owner: false, dpc_version: '', dpc_code: 0, online: false, restaurant: '', enrolled_by: '', server_status: '', last_seen: '' }, o);
  const DEVICES = S === 'empty' || S === 'noadb' ? [] : [
    row({ handle: '18121FDF60022T', name: 'Google Pixel 6', serial: '18121FDF60022T', android: '17' }),
    row({ handle: '10.32.2.210:5555', name: 'Google Pixel 6', serial: '18121FDF60022T', android: '17' }),
    row({ handle: '10.32.0.113:43213', name: 'AIO T7', serial: 'AT070AA2600030', android: '15', status: 'firmware', firmware_version: '1.8.8', build: 'v2.1.025-aio-glance-22', server_seen: true, class: 't7', server_status: 'auto' }),
    row({ handle: 'adb-DK19256F40580-Ab12Cd._adb-tls-connect._tcp', name: 'SUNMI D2s_KDS_STGL', serial: 'DK19256F40580', android: '11', status: 'enrolled', class: 'kds', agent_version: '0.2.4', dpc_version: '0.2.4', dpc_code: 204, online: true, restaurant: 'Burger Hub · Gulberg', enrolled_by: 'Shahrukh Bashir' }),
    row({ handle: 'P3121C30418', name: 'SUNMI D3 Pro', serial: 'P3121C30418', android: '11' }),
    row({ handle: '10.32.1.70:42719', name: 'Google Pixel 3a XL', serial: '93RAX0A0ZY', android: '12', status: 'ready', dpc_owner: true, dpc_version: '0.2.4' }),
    row({ handle: 'ADRB0AAMY00187', name: 'Google HK1 RBOX D8', serial: 'ADRB0AAMY00187', android: '11', status: 'blocked', note: 'Has an account — factory reset, don’t add an account' }),
  ];
  const DISC = [
    { name: 'adb-DP02256HJ0342-VoAlNv', kind: 'connect', addr: '10.32.1.13:40801' },
    { name: 'adb-AT070AABU00875-Qq11Ww', kind: 'connect', addr: '10.32.2.167:41001' },
    { name: 'adb-R95Y405MG3X-XGrWQf', kind: 'connect', addr: '10.32.1.211:44793' },
    { name: 'adb-AT070AA2600030', kind: 'connect', addr: '10.32.2.75:5555' },
  ].concat(S === 'pair' ? [{ name: 'adb-AT070AA2600031-Zz99Yy', kind: 'pairing', addr: '10.32.0.120:37971' }] : []);
  const RESTAURANTS = [
    { id: 'r1', name: 'Burger Hub · Gulberg', address: 'Main Blvd, Lahore', device_count: 12 },
    { id: 'r2', name: 'Burger Hub · DHA Ph 6', address: 'Lahore', device_count: 9 },
    { id: 'r3', name: 'Chai Point · F-7', address: 'Islamabad', device_count: 4 },
    { id: 'r4', name: 'Pizza Lab · Clifton', address: 'Karachi', device_count: 7 },
  ];
  const CLASS = {
    DP02256HJ0342: { class: 'other' }, R95Y405MG3X: { class: 'family', family: 'SUNMI D3 Pro', family_count: 3, device_class: 'pos' },
    AT070AABU00875: { class: 'production', production: 'T7 batch BU', model: '07' },
    AT070AA2600030: { class: 'fleet', name: 'AIO T7', device_class: 't7' },
    AT070AA2600031: { class: 'fleet', name: 'AIO T7', device_class: 't7' },
  };
  const signedIn = !['signin', 'picker'].includes(S);
  const api = {
    me: () => (signedIn ? { username: 'muhammadali.hassan@aioapp.com', role: 'admin', server: 'https://mdm.dev.aioapp.com' } : null),
    profile: () => ({ name: 'Ali Hassan', avatar: null }),
    accounts: () => (S === 'signin' ? [] : [{ username: 'muhammadali.hassan@aioapp.com', name: 'Ali Hassan', avatar: null, server: '', saved: true },
      { username: 'shahrukh.bashir@aioapp.com', name: 'Shahrukh Bashir', avatar: null, server: '', saved: false }]),
    last_login: () => null,
    adb_status: () => ({ found: S !== 'noadb', path: '/Applications/AIO Enroll.app/Contents/Resources/platform-tools/adb', version: 'Android Debug Bridge version 1.0.41', os: 'mac' }),
    list_devices: () => DEVICES,
    wifi_discover: () => DISC,
    classify_serials: ({ serials }) => Object.fromEntries(serials.map((s) => [s, CLASS[s] || { class: 'other' }])),
    enroll: async ({ handle, class: cls, restaurantId }) => {
      for (let i = 0; i < 8; i++) { emit('enroll-step', { handle, step: i, line: '' }); await new Promise((r) => setTimeout(r, +(window.__mockStepMs || 400))); }
      const rest = (RESTAURANTS.find((r) => r.id === restaurantId) || {}).name || '';
      const d = DEVICES.find((x) => x.handle === handle) || {};
      DEVICES.filter((x) => x.serial && x.serial === d.serial).forEach((x) => Object.assign(x, { status: 'enrolled', class: cls, online: true, restaurant: rest, agent_version: '0.2.8', dpc_version: '0.2.8', dpc_code: 208, enrolled_by: 'Ali Hassan' }));
      return { live: true, checked: true, serial: d.serial, restaurant: rest, battery_pct: 0, has_battery: false, agent_version: '0.2.8' };
    },
    // AIO firmware trusts our adb key: 10.32.2.167 connects without a code; anything else needs one.
    wifi_connect_known: async ({ host }) => { await new Promise((r) => setTimeout(r, 900)); if (host !== '10.32.2.167') return null;
      DEVICES.push(row({ handle: host + ':5555', name: 'AIO T7', serial: 'AT070AABU00875', android: '15', status: 'firmware', firmware_version: '1.8.8', server_seen: false })); return host + ':5555'; },
    restaurants: () => RESTAURANTS,
    agent_info: () => ({ version: '0.2.8', version_code: 208 }),
    serial_statuses: ({ serials }) => Object.fromEntries(serials.map((s) => { if (s === 'AT070AA2600030') return [s, { enrolled: false, status: 'auto', last_seen_at: new Date(Date.now() - 3 * 86400e3).toISOString() }]; const d = DEVICES.find((x) => x.serial === s); return [s, d ? { enrolled: d.status === 'enrolled', status: d.status, online: !!d.online, restaurant: d.restaurant } : { enrolled: false }]; })),
    device_checks: ({ handle }) => {
      const left = Math.max(0, 2 - (window.__checks = (window.__checks || 0) + (window.__accountsOpened ? 1 : 0)));
      if (!left) DEVICES.filter((x) => x.handle === handle).forEach((x) => Object.assign(x, { status: 'ready', note: '' }));
      return { accounts: ['ali@gmail.com (Google)', 'work@aioapp.com (workaccount)'].slice(0, left), users: 1, other_owner: '' };
    },
    open_accounts: () => { window.__accountsOpened = true; return true; },
    agent_update: async ({ handle }) => { await new Promise((r) => setTimeout(r, 1500)); DEVICES.filter((x) => x.handle === handle).forEach((x) => Object.assign(x, { dpc_version: '0.2.8', dpc_code: 208, agent_version: '0.2.8' })); return '0.2.8'; },
    notify: (a) => { (window.__notes = window.__notes || []).push(a); },
    open_dashboard: ({ serial }) => { window.__opened = serial; },
    save_csv: ({ name, content }) => { window.__csv = content; return '/Users/ali/Downloads/' + name; },
    device_unpair: ({ serial, handles }) => { window.__unpaired = { serial, handles }; const h = new Set(handles); DEVICES.splice(0, DEVICES.length, ...DEVICES.filter((d) => !h.has(d.handle))); return 'Unpaired on this computer. On the phone, Wireless debugging is now open: tap this computer under Paired devices, then Forget.'; },
    sign_in: () => ({ username: 'muhammadali.hassan@aioapp.com', role: 'admin', server: '' }),
    sign_in_saved: () => ({ username: 'muhammadali.hassan@aioapp.com', role: 'admin', server: '' }),
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { const f = api[cmd]; if (!f) return ''; return f(args || {}); } },
    event: { listen: async (ev, f) => { (handlers[ev] = handlers[ev] || []).push(f); return () => {}; } },
  };
  window.__mockEmit = emit;
  // Tests: make a phone open its pairing screen, e.g. __mockAddPairing('10.32.2.167:37001', 'adb-AT070AABU00875-Pp00Qq')
  window.__mockAddPairing = (addr, name) => DISC.push({ name, kind: 'pairing', addr });
  window.__mockRemovePairing = (addr) => { const i = DISC.findIndex((d) => d.addr === addr); if (i >= 0) DISC.splice(i, 1); };
})();
