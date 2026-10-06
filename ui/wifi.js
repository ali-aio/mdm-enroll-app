// "Add over Wi-Fi" panel. Pairing and connecting are not a fixed sequence:
//  - a phone this computer already trusts just connects (no code);
//  - an unpaired one needs a code once, and most phones then connect by themselves.
// So: Connect is the main action; Pair appears when it is needed (or on request), and after
// pairing the panel waits for the phone to show up before asking for anything.
const Wifi = (() => {
  const CHECKSVG = '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const PH = '<svg class="ic" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>';
  const NOT_PAIRED = /authenticate|unauthori|not paired|pairing/i;

  function draw(body, ctx) {
    const { invoke, esc, Guide, alive } = ctx;
    const steps = [
      ['Same Wi-Fi', 'Phone and this computer on the <b>same network</b> (no guest Wi-Fi, no VPN).', 'wifi'],
      ['Turn on Wireless debugging', 'Developer options → <b>Wireless debugging</b> on.', 'wd'],
      ['Connect', 'Pick the phone below. <b>Paired it before? That’s all.</b> First time? It will ask you to pair with a code.', 'connect'],
    ];
    body.innerHTML = `<div class="wsplit"><div class="steps">${steps.map((s, i) =>
      `<div class="cs" data-i="${i}"><div class="n">${i + 1}</div><div style="flex:1;min-width:0"><b>${s[0]}</b><span class="d">${s[1]}</span><div class="extra"></div></div></div>`).join('')}
      </div><div class="pcol"><div class="ph-slot"></div><div class="cap"></div></div></div>`;
    const cs = [...body.querySelectorAll('.cs')], slot = body.querySelector('.ph-slot'), cap = body.querySelector('.cap');
    const done = [false, false, false];
    let sceneTok = {};

    const scene = (name) => {
      const tok = (sceneTok = {});
      cap.textContent = Guide.CAP[name];
      Guide.phone(slot, name, () => alive() && sceneTok === tok);
    };
    const mark = (i, st) => {
      cs[i].classList.remove('on', 'ok', 'bad');
      if (st) cs[i].classList.add(st);
      cs[i].querySelector('.n').innerHTML = st === 'ok' ? CHECKSVG : String(i + 1);
    };
    const show = (i) => {
      cs.forEach((_, k) => mark(k, done[k] ? 'ok' : k === i ? 'on' : ''));
      scene(steps[i][2]);
    };
    cs.forEach((c, i) => c.addEventListener('click', (e) => { if (!e.target.closest('input,button,summary,details')) show(i); }));
    [0, 1].forEach((i) => {
      cs[i].querySelector('.extra').innerHTML = '<button class="cc-btn sm" style="margin-top:6px">Done — next ›</button>';
      cs[i].querySelector('button').onclick = () => { done[i] = true; show(i + 1); };
    });

    // ---- step 3: connect, with pairing folded in ----
    const ex = cs[2].querySelector('.extra');
    ex.innerHTML = `<div class="foundlist"></div>
      <div class="wform"><label>Or type it<input id="ca" placeholder="192.168.1.20:41231" autocomplete="off" spellcheck="false"></label><button class="cc-btn primary sm" id="cb">Connect</button></div>
      <div class="hint" style="font-size:11px;color:var(--muted);margin-top:4px">Use the address on the main Wireless debugging screen. It changes whenever Wireless debugging is switched off and on.</div>
      <div class="cmsg"></div>
      <details class="pairbox" style="margin-top:10px"><summary style="font-size:12px;font-weight:700;cursor:pointer;color:var(--accent-text)">Not paired yet? Pair with a code</summary>
        <div class="hint" style="font-size:11px;color:var(--muted);margin:6px 0 0">Once per phone and computer. Tap “Pair device with pairing code” on the phone, then enter its <b>pairing</b> address and 6 digits. Most phones then connect by themselves.</div>
        <div class="wform"><label>Pairing address<input id="pa" placeholder="192.168.1.20:37215" autocomplete="off" spellcheck="false"></label>
        <label>6-digit code<input id="pc" class="code" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off"></label>
        <button class="cc-btn primary sm" id="pb">Pair</button></div><div class="pmsg"></div></details>`;
    const ca = ex.querySelector('#ca'), cb = ex.querySelector('#cb'), cmsg = ex.querySelector('.cmsg'), list = ex.querySelector('.foundlist');
    const pairbox = ex.querySelector('.pairbox'), pa = ex.querySelector('#pa'), pc = ex.querySelector('#pc'), pb = ex.querySelector('#pb'), pmsg = ex.querySelector('.pmsg');

    const finished = (handle, msg) => {
      done[2] = true; mark(2, 'ok');
      cmsg.innerHTML = `<div class="wmsg ok">${esc(msg)}</div>`;
      pmsg.innerHTML = '';
      ctx.onConnected(handle);
    };
    const openPair = (why) => {
      pairbox.open = true;
      if (why) pmsg.innerHTML = `<div class="wmsg" style="background:var(--surface-3)">${esc(why)}</div>`;
      scene('pair');
    };
    // Network phones the app currently sees (ip:port or Wireless-debugging names).
    const netHandles = () => new Set((ctx.devices() || []).filter((d) => d.handle.includes(':') || d.handle.includes('._adb-tls-')).map((d) => d.handle));

    async function connect(addr, btn) {
      const label = btn.textContent;
      cb.disabled = true; btn.innerHTML = '<span class="spin"></span> Connecting…';
      cmsg.innerHTML = '<div class="wmsg" style="background:var(--surface-3)">Trying — it retries up to 3 times.</div>';
      mark(2, 'on');
      try {
        const m = await invoke('wifi_connect', { addr });
        btn.textContent = 'Connected ✓';
        finished(addr, m + ' It now shows up in your device list.');
      } catch (err) {
        const raw = String(err).split('adb said:')[1] || '';
        btn.textContent = label; cb.disabled = false;
        if (NOT_PAIRED.test(raw)) {
          // Not trusted yet: this is the "first time" path, so go straight to pairing.
          cmsg.innerHTML = '<div class="wmsg" style="background:var(--surface-3)">This computer isn’t paired with that phone yet. Pair it with a code below — it usually connects by itself afterwards.</div>';
          openPair();
          return;
        }
        cs[2].classList.add('bad');
        cmsg.innerHTML = `<div class="wmsg bad">Couldn’t connect to ${esc(addr)}. Most likely one of these:</div><div class="diag">
          <div><em>1</em><span><b>The port changed</b>It changes every time Wireless debugging is switched off and on. Re-read it on the phone.</span></div>
          <div><em>2</em><span><b>Different network or VPN</b>The phone and computer must share one Wi-Fi. Turn VPNs off.</span></div>
          <div><em>3</em><span><b>Phone asleep</b>Wake the screen and keep it on while connecting.</span></div>
          <div><em>4</em><span><b>Not paired with this computer</b><a class="lnk" data-pair>Pair it with a code</a>.</span></div>
          <div style="align-items:center"><span style="flex:1"><b>Still stuck?</b>Restart the adb helper.</span><button class="cc-btn sm" id="rs">Reset adb and try again</button></div></div>
          ${raw.trim() ? `<div class="raw mono">adb said: ${esc(raw.trim())}</div>` : ''}`;
        cmsg.querySelector('[data-pair]').onclick = () => openPair();
        const rs = cmsg.querySelector('#rs');
        rs.onclick = async () => { rs.innerHTML = '<span class="spin"></span> Resetting…'; try { await invoke('wifi_reset'); } catch {} cs[2].classList.remove('bad'); connect(addr, cb); };
      }
    }
    cb.onclick = () => { cs[2].classList.remove('bad'); connect(ca.value.trim(), cb); };

    pb.onclick = async () => {
      const before = netHandles();
      pb.disabled = true; pb.innerHTML = '<span class="spin"></span> Pairing…'; pmsg.innerHTML = '';
      try {
        await invoke('wifi_pair', { addr: pa.value, code: pc.value });
      } catch (err) {
        pmsg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
        pb.disabled = false; pb.textContent = 'Pair';
        return;
      }
      pc.value = '';
      pb.innerHTML = '<span class="spin"></span> Paired — waiting for it to connect…';
      pmsg.innerHTML = '<div class="wmsg ok">Paired. Most phones connect by themselves now — checking…</div>';
      // After pairing, many phones show up on their own within a few seconds.
      for (let i = 0; i < 10 && alive(); i++) {
        await Guide.sleep(1000);
        const now = [...netHandles()].find((h) => !before.has(h));
        if (now) { pb.textContent = 'Paired ✓'; finished(now, 'Paired and connected by itself. It now shows up in your device list.'); return; }
      }
      if (!alive()) return;
      pb.disabled = false; pb.textContent = 'Pair';
      pmsg.innerHTML = '<div class="wmsg ok">Paired. It didn’t connect by itself, so pick it in the list above (or type its address) and press Connect.</div>';
      scene('connect');
    };

    // Discovery: phones with Wireless debugging on, plus the pairing dialog's address.
    (async () => {
      while (alive()) {
        let svcs = [];
        try { svcs = await invoke('wifi_discover'); } catch {}
        if (!alive()) return;
        const pairing = svcs.find((x) => x.kind === 'pairing');
        if (pairing && !pa.value) { pa.value = pairing.addr; if (!pairbox.open) pairbox.open = true; }
        const conns = svcs.filter((x) => x.kind === 'connect');
        list.innerHTML = conns.length
          ? conns.map((x) => `<div class="found"><div class="ph2">${PH}</div><div class="m"><b>Phone on your network</b><span class="mono">${esc(x.addr)}</span></div><button class="cc-btn primary sm" data-addr="${esc(x.addr)}">Connect</button></div>`).join('')
          : '<div class="found"><div class="wave"><b></b><b></b></div><div class="m"><b>Looking for phones on your network…</b><span>Or type the address below.</span></div></div>';
        list.querySelectorAll('[data-addr]').forEach((b) => { b.onclick = () => connect(b.dataset.addr, b); });
        await Guide.sleep(3000);
      }
    })();

    if (ctx.prefill) { ca.value = ctx.prefill; done[0] = done[1] = true; show(2); ca.focus(); } else show(0);
  }
  return { draw };
})();
