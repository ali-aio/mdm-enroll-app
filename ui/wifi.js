// "Add over Wi-Fi": always pair, never a separate connect step.
// The phone's pairing screen is found over the network (address filled in for you); the
// person only types the 6-digit code. The app then connects by itself.
const Wifi = (() => {
  const CHECKSVG = '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const PH = '<svg class="ic" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>';

  function draw(body, ctx) {
    const { invoke, esc, Guide, alive } = ctx;
    const steps = [
      ['Same Wi-Fi', 'Phone and this computer on the <b>same network</b> (no guest Wi-Fi, no VPN).', 'wifi'],
      ['Turn on Wireless debugging', 'Developer options → <b>Wireless debugging</b> on.', 'wd'],
      ['Pair', 'Tap <b>Pair device with pairing code</b>. Enter the 6 digits it shows. That’s it — the app connects by itself.', 'pair'],
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

    // ---- step 3: pair (and connect, automatically) ----
    const ex = cs[2].querySelector('.extra');
    ex.innerHTML = `<div class="foundlist"></div>
      <div class="wform"><label>6-digit code<input id="pc" class="code" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off"></label>
        <button class="cc-btn primary sm" id="pb">Pair</button></div>
      <div class="pmsg"></div>
      <details class="pairbox" style="margin-top:8px"><summary style="font-size:11.5px;color:var(--muted);cursor:pointer">Pairing screen not found? Enter its address</summary>
        <div class="wform"><label>Pairing address<input id="pa" placeholder="192.168.1.20:37215" autocomplete="off" spellcheck="false"></label></div></details>`;
    const list = ex.querySelector('.foundlist'), pc = ex.querySelector('#pc'), pb = ex.querySelector('#pb'), pmsg = ex.querySelector('.pmsg');
    const pa = ex.querySelector('#pa'), pairbox = ex.querySelector('.pairbox');
    let detected = '';      // pairing address found on the network
    let busy = false;
    // The code box and Pair button wake up only once there is a pairing screen to pair with
    // (found on the network, or its address typed), and Pair only once all 6 digits are in.
    const syncEnable = () => {
      const have = !!(pa.value.trim() || detected);
      pc.disabled = busy || !have;
      pc.placeholder = have ? '••••••' : 'waiting…';
      pb.disabled = busy || !have || pc.value.length !== 6;
    };
    pc.addEventListener('input', () => { pc.value = pc.value.replace(/\D/g, '').slice(0, 6); syncEnable(); });
    pa.addEventListener('input', syncEnable);
    pc.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !pb.disabled) pb.click(); });

    pb.onclick = async () => {
      const addr = (pa.value.trim() || detected);
      if (!addr) return;
      busy = true; syncEnable(); pb.innerHTML = '<span class="spin"></span> Pairing…'; pmsg.innerHTML = '';
      mark(2, 'on');
      // Backend pairs, then connects by itself; the label only tells the person what is going on.
      const t = setTimeout(() => { if (alive()) pb.innerHTML = '<span class="spin"></span> Connecting…'; }, 2500);
      try {
        const handle = await invoke('wifi_pair_connect', { addr, code: pc.value });
        clearTimeout(t);
        pc.value = ''; busy = false; done[2] = true; mark(2, 'ok'); pc.disabled = true;
        pb.textContent = 'Connected ✓';
        pmsg.innerHTML = '<div class="wmsg ok">Paired and connected. It now shows up in your device list.</div>';
        ctx.onConnected(handle);
      } catch (err) {
        clearTimeout(t);
        busy = false; pb.textContent = 'Pair'; syncEnable();
        cs[2].classList.add('bad');
        pmsg.innerHTML = `<div class="wmsg bad">${esc(err)}</div>`;
        setTimeout(() => cs[2].classList.remove('bad'), 600);
      }
    };

    // Watch for pairing screens. Several phones can be in pairing mode at once, so list them all
    // and let the person pick theirs (a lone one is chosen for them).
    let pairings = [], chosen = '', sig = '';
    const serialOf = (svc) => { const m = /^adb-(.+)-[A-Za-z0-9]{4,8}$/.exec(svc.name || ''); return m ? m[1] : ''; };
    const nameOf = (svc) => (ctx.nameForHost ? ctx.nameForHost(svc.addr.split(':')[0]) : '') || 'Phone';
    function drawPairings() {
      const s = pairings.map((p) => p.addr).join('|') + '#' + chosen;
      if (s === sig) return;
      sig = s;
      if (!pairings.length) {
        list.innerHTML = '<div class="found"><div class="wave"><b></b><b></b></div><div class="m"><b>Waiting for the pairing screen…</b><span>Open “Pair device with pairing code” on the phone.</span></div></div>';
        return;
      }
      list.innerHTML = (pairings.length > 1 ? '<div class="hint" style="font-size:11px;color:var(--muted);margin-top:6px">Several phones are showing a pairing screen. Pick the one you are pairing.</div>' : '') +
        pairings.map((p) => {
          const sn = serialOf(p), on = p.addr === chosen;
          return `<button class="found pick ${on ? 'sel' : ''}" data-addr="${esc(p.addr)}" aria-pressed="${on}"><div class="ph2">${PH}</div><div class="m"><b>${esc(nameOf(p))}${pairings.length > 1 ? '' : ' · pairing screen found'}</b><span class="mono">${esc(p.addr.split(':')[0])}${sn ? ' · ' + esc(sn) : ''}</span></div><span class="radio ${on ? 'on' : ''}">${on ? CHECKSVG : ''}</span></button>`;
        }).join('');
      list.querySelectorAll('[data-addr]').forEach((b) => { b.onclick = () => { if (busy) return; chosen = b.dataset.addr; detected = chosen; sig = ''; drawPairings(); syncEnable(); pc.focus(); }; });
    }
    (async () => {
      while (alive()) {
        let svcs = [];
        try { svcs = await invoke('wifi_discover'); } catch {}
        if (!alive()) return;
        pairings = svcs.filter((x) => x.kind === 'pairing');
        if (pairings.length === 1) chosen = pairings[0].addr;               // only one: no choice to make
        else if (!pairings.some((p) => p.addr === chosen)) chosen = '';     // the chosen one went away
        detected = chosen;
        drawPairings();
        if (!busy) syncEnable();
        if (chosen && !cs[2].classList.contains('on') && !done[2]) { done[0] = done[1] = true; show(2); }
        await Guide.sleep(2000);
      }
    })();

    syncEnable();
    show(0);
  }
  return { draw };
})();
