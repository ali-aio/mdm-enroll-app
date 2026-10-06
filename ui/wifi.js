// "Wi-Fi" tab of the help drawer: pair + connect to a phone over wireless debugging.
const Wifi = (() => {
  const SCENES = ['wifi', 'wd', 'pair', 'connect'];
  const STEPS = [
    ['Same Wi-Fi', 'Phone and this computer must be on the <b>same network</b> (no guest Wi-Fi, no VPN).'],
    ['Turn on Wireless debugging', 'Settings → Developer options → <b>Wireless debugging</b> on.'],
    ['Pair (once per computer)', 'Tap “Pair device with pairing code”. Enter the <b>pairing</b> address and the 6 digits.'],
    ['Connect', 'Pick the phone below, or type the <b>IP address &amp; port</b> from the Wireless debugging screen.'],
  ];
  const CHECKSVG = '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const PH = '<svg class="ic" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>';

  function draw(body, ctx) {
    const { invoke, esc, Guide, alive } = ctx;
    document.getElementById('drawer').classList.add('wide');
    body.innerHTML = `<div class="wsplit"><div class="steps">${STEPS.map((s, i) =>
      `<div class="cs" data-i="${i}"><div class="n">${i + 1}</div><div style="flex:1;min-width:0"><b>${s[0]}</b><span class="d">${s[1]}</span><div class="extra"></div></div></div>`).join('')}
      </div><div class="pcol"><div class="ph-slot"></div><div class="cap"></div></div></div>`;
    const cs = [...body.querySelectorAll('.cs')], slot = body.querySelector('.ph-slot'), cap = body.querySelector('.cap');
    const done = [false, false, false, false];
    let cur = 0, sceneTok = {};

    const show = (i) => {
      cur = i;
      const tok = (sceneTok = {});
      cs.forEach((c, k) => {
        c.classList.remove('on', 'ok');
        c.classList.toggle('ok', done[k]);
        c.classList.toggle('on', k === cur && !done[k]);
        c.querySelector('.n').innerHTML = done[k] ? CHECKSVG : String(k + 1);
      });
      cap.textContent = Guide.CAP[SCENES[i]];
      Guide.phone(slot, SCENES[i], () => alive() && sceneTok === tok);
    };
    cs.forEach((c, i) => c.addEventListener('click', (e) => { if (!e.target.closest('input,button')) show(i); }));

    // Steps 1-2: just a Next button.
    [0, 1].forEach((i) => {
      cs[i].querySelector('.extra').innerHTML = '<button class="cc-btn sm" style="margin-top:6px">Done — next ›</button>';
      cs[i].querySelector('button').onclick = () => { done[i] = true; show(i + 1); };
    });

    // Step 3: pair.
    const ex2 = cs[2].querySelector('.extra');
    ex2.innerHTML = `<div class="wform"><label>Pairing address<input id="pa" placeholder="192.168.1.20:37215" autocomplete="off" spellcheck="false"></label>
      <label>6-digit code<input id="pc" class="code" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off"></label>
      <button class="cc-btn primary sm" id="pb">Pair</button></div><div class="pmsg"></div>`;
    const pa = ex2.querySelector('#pa'), pc = ex2.querySelector('#pc'), pb = ex2.querySelector('#pb'), pmsg = ex2.querySelector('.pmsg');
    pb.onclick = async () => {
      pb.disabled = true; pb.innerHTML = '<span class="spin"></span> Pairing…'; pmsg.innerHTML = '';
      try {
        const m = await invoke('wifi_pair', { addr: pa.value, code: pc.value });
        pmsg.innerHTML = `<div class="wmsg ok">${esc(m)}</div>`;
        done[2] = true; pb.innerHTML = 'Paired ✓'; pc.value = '';
        show(3);
      } catch (err) {
        pmsg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
        pb.disabled = false; pb.textContent = 'Pair';
      }
    };

    // Step 4: connect.
    const ex3 = cs[3].querySelector('.extra');
    ex3.innerHTML = `<div class="foundlist"></div>
      <div class="wform"><label>Or type it<input id="ca" placeholder="192.168.1.20:41231" autocomplete="off" spellcheck="false"></label><button class="cc-btn primary sm" id="cb">Connect</button></div>
      <div class="hint" style="font-size:11px;color:var(--muted);margin-top:4px">This is the address on the main Wireless debugging screen — not the pairing one. It changes whenever Wireless debugging is switched off and on.</div><div class="cmsg"></div>`;
    const ca = ex3.querySelector('#ca'), cb = ex3.querySelector('#cb'), cmsg = ex3.querySelector('.cmsg'), list = ex3.querySelector('.foundlist');

    async function connect(addr, btn) {
      const label = btn.textContent;
      cb.disabled = true; btn.innerHTML = '<span class="spin"></span> Connecting…';
      cmsg.innerHTML = '<div class="wmsg" style="background:var(--surface-3)">Trying — it retries up to 3 times.</div>';
      try {
        const m = await invoke('wifi_connect', { addr });
        done[3] = true; cs[3].classList.add('ok'); cs[3].classList.remove('on');
        cs[3].querySelector('.n').innerHTML = CHECKSVG;
        cmsg.innerHTML = `<div class="wmsg ok">${esc(m)} It now shows up in your device list.</div>`;
        btn.textContent = 'Connected ✓';
        ctx.onConnected();
      } catch (err) {
        const raw = String(err).split('adb said:')[1] || '';
        cs[3].classList.add('bad');
        cmsg.innerHTML = `<div class="wmsg bad">Couldn’t connect to ${esc(addr)}. Most likely one of these:</div><div class="diag">
          <div><em>1</em><span><b>The port changed</b>It changes every time Wireless debugging is switched off and on. Re-read it on the phone.</span></div>
          <div><em>2</em><span><b>Different network or VPN</b>The phone and computer must share one Wi-Fi. Turn VPNs off.</span></div>
          <div><em>3</em><span><b>Phone asleep</b>Wake the screen and keep it on while connecting.</span></div>
          <div><em>4</em><span><b>Not paired with this computer</b>Do step 3 again.</span></div>
          <div style="align-items:center"><span style="flex:1"><b>Still stuck?</b>Restart the adb helper.</span><button class="cc-btn sm" id="rs">Reset adb and try again</button></div></div>
          ${raw.trim() ? `<div class="raw mono">adb said: ${esc(raw.trim())}</div>` : ''}`;
        btn.textContent = label; cb.disabled = false;
        const rs = cmsg.querySelector('#rs');
        rs.onclick = async () => { rs.innerHTML = '<span class="spin"></span> Resetting…'; try { await invoke('wifi_reset'); } catch {} cs[3].classList.remove('bad'); connect(addr, cb); };
      }
    }
    cb.onclick = () => { cs[3].classList.remove('bad'); connect(ca.value.trim(), cb); };

    // Discovery: phones with Wireless debugging on, plus the pairing dialog's address.
    (async () => {
      while (alive()) {
        if (cur >= 2) {
          let svcs = [];
          try { svcs = await invoke('wifi_discover'); } catch {}
          if (!alive()) return;
          const pairing = svcs.find((x) => x.kind === 'pairing');
          if (pairing && !pa.value) pa.value = pairing.addr;
          const conns = svcs.filter((x) => x.kind === 'connect');
          list.innerHTML = conns.length ? conns.map((x) => `<div class="found"><div class="ph2">${PH}</div><div class="m"><b>Phone on your network</b><span class="mono">${esc(x.addr)}</span></div><button class="cc-btn primary sm" data-addr="${esc(x.addr)}">Connect</button></div>`).join('')
            : (cur === 3 ? '<div class="found"><div class="wave"><b></b><b></b></div><div class="m"><b>Looking for phones on your network…</b><span>Or type the address below.</span></div></div>' : '');
          list.querySelectorAll('[data-addr]').forEach((b) => { b.onclick = () => connect(b.dataset.addr, b); });
        }
        await Guide.sleep(3000);
      }
    })();

    show(0);
  }
  return { draw };
})();
