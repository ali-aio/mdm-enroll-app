// First-run guidance: animated phone, OS-specific adb help, help drawer content.
const Guide = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ic = (i) => `<svg class="ic" viewBox="0 0 24 24">${i}</svg>`;
  const I = {
    warn: ic('<path d="M12 3l10 18H2zM12 10v4.5M12 18h.01"/>'),
    cable: ic('<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>'),
  };
  const OSN = { mac: 'macOS', linux: 'Linux', win: 'Windows' };
  const CAP = {
    about: 'Settings → About phone → tap “Build number” 7 times',
    usb: 'Settings → Developer options → switch on “USB debugging”',
    allow: 'Plug in the cable and tap “Allow” on the phone',
    wifi: 'Phone on the same Wi-Fi as this computer',
    wd: 'Developer options → turn on Wireless debugging',
    pair: 'Pairing dialog: the code and the pairing address',
    connect: 'Main screen: this is the connect address',
  };
  const GUIDE = {
    mac: { title: 'Install adb on macOS', steps: [
      ['Open <b>Terminal</b> (Spotlight → “Terminal”).'],
      ['Install Android platform-tools with Homebrew:', ['brew install android-platform-tools']],
      ['No Homebrew? Download “SDK Platform-Tools for Mac” from developer.android.com, unzip it and put the folder in <span class="mono">~/Downloads</span>. The app finds it there.'],
      ['Come back and press <b>Retry</b>.']],
      note: 'macOS needs no USB driver.' },
    linux: { title: 'Install adb on Linux', steps: [
      ['Install it with your package manager:', ['sudo apt install adb', 'sudo dnf install android-tools', 'sudo pacman -S android-tools']],
      ['Let your user use USB devices, then <b>log out and back in</b>:', ['sudo usermod -aG plugdev $USER']],
      ['Come back and press <b>Retry</b>.']],
      note: 'Phone still not listed? Install the udev rules: sudo apt install android-sdk-platform-tools-common.' },
    win: { title: 'Install adb on Windows', steps: [
      ['Open <b>Windows Terminal</b> or PowerShell and run:', ['winget install Google.PlatformTools']],
      ['No winget? Download “SDK Platform-Tools for Windows” from developer.android.com and unzip it to <span class="mono">C:\\platform-tools</span>. The app finds it there.'],
      ['Come back and press <b>Retry</b>.']],
      note: 'Samsung, Xiaomi, Huawei and some others also need their own USB driver. Pixels work with the built-in one.' },
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function guideHTML(os, detected) {
    const g = GUIDE[os] || GUIDE.linux;
    const tabs = `<div class="ostabs">${['mac', 'linux', 'win'].map((k) =>
      `<button data-os="${k}" class="${k === os ? 'on' : ''}">${OSN[k]}${k === detected ? ' <em>this computer</em>' : ''}</button>`).join('')}</div>`;
    return tabs + `<b style="font-size:12.5px">${g.title}</b><ol style="padding-left:18px;margin:6px 0 0;font-size:12px;line-height:1.5">${
      g.steps.map((s) => `<li style="margin-bottom:6px">${s[0]}${(s[1] || []).map((c) =>
        `<div class="cmd"><code>${esc(c)}</code><button data-copy="${esc(c)}">Copy</button></div>`).join('')}</li>`).join('')}</ol><div class="gnote">${g.note}</div>`;
  }

  /** Makes the OS tabs and Copy buttons inside `root` work. `rerender(os)` redraws. */
  function wire(root, rerender) {
    root.querySelectorAll('[data-os]').forEach((b) => { b.onclick = () => rerender(b.dataset.os); });
    root.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; }
        catch { b.textContent = 'Select & copy'; }
        setTimeout(() => { b.textContent = 'Copy'; }, 1400);
      };
    });
  }

  function adbCard(os, detected) {
    return `<div class="adbcard"><h3>${I.warn}adb was not found</h3>
      <p>The app needs Android’s “adb” tool to talk to phones. It normally ships inside the app, so something removed it. Follow the steps for your computer:</p>
      <div class="gb">${guideHTML(os, detected)}</div>
      <div style="margin-top:10px"><button class="cc-btn primary sm" data-retry>↻ Retry</button></div></div>`;
  }

  /** Draws one phone scene into `el`; stops quietly when `alive()` turns false. */
  async function phone(el, scene, alive) {
    el.innerHTML = '<div class="phone"><div class="scr"></div></div>';
    const s = el.querySelector('.scr');
    if (scene === 'about') {
      s.innerHTML = '<h6>About phone</h6><div class="li">Device name<span>Phone</span></div><div class="li">Android version<span>14</span></div><div class="li hl">Build number<span class="n7">tap ×7</span><i class="tap"></i></div><div class="li">Legal info<span>›</span></div>';
      const tap = s.querySelector('.tap'), n = s.querySelector('.n7');
      for (let i = 1; i <= 7; i++) {
        if (!alive()) return;
        tap.classList.remove('go'); void tap.offsetWidth; tap.classList.add('go');
        n.textContent = i < 7 ? `${i}/7` : '✓';
        await sleep(380);
      }
      if (alive()) s.insertAdjacentHTML('beforeend', '<div class="ptoast">You are now a developer!</div>');
    } else if (scene === 'wifi') {
      s.innerHTML = '<h6>Wi-Fi</h6><div class="li hl">Office-Wifi <span>✓</span></div><div class="li">Guest <span></span></div><div class="li">Home <span></span></div>';
    } else if (scene === 'wd') {
      s.innerHTML = '<h6>Developer options</h6><div class="li">USB debugging<div class="tog on"></div></div><div class="li hl">Wireless debugging<div class="tog" id="tg"></div></div>';
      await sleep(900);
      if (alive()) s.querySelector('#tg').classList.add('on');
    } else if (scene === 'pair') {
      s.innerHTML = '<h6>Wireless debugging</h6><div class="dlg" style="margin-top:0"><b>Pair with device</b><p style="margin:0">Wi-Fi pairing code</p><div class="bigc">482 913</div><p style="margin:0">IP address &amp; Port<br><b class="mono" style="font-size:9.5px;display:inline;white-space:nowrap">192.168.1.20:37215</b></p></div><div class="li" style="margin-top:8px">Pair with QR code<span>›</span></div>';
    } else if (scene === 'connect') {
      s.innerHTML = '<h6>Wireless debugging</h6><div class="li">Device name<span>Phone</span></div><div class="li hl" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="color:var(--muted);font-size:9.5px">IP address &amp; Port</span><b class="mono" style="font-size:9.5px;letter-spacing:-.2px;white-space:nowrap">192.168.1.20:41231</b></div><div class="li">Pair device with pairing code<span>›</span></div>';
    } else if (scene === 'usb') {
      s.innerHTML = '<h6>Developer options</h6><div class="li">Stay awake<div class="tog"></div></div><div class="li hl">USB debugging<div class="tog" id="tg"></div></div><div class="li">Wireless debugging<div class="tog"></div></div>';
      await sleep(900);
      if (alive()) s.querySelector('#tg').classList.add('on');
    } else {
      s.innerHTML = '<div class="cable"></div><div class="dlg"><b>Allow USB debugging?</b><p>The computer’s RSA key fingerprint is …</p><div class="btns"><span>Cancel</span><span class="allow">Allow</span></div></div>';
      await sleep(1100);
      if (alive()) s.querySelector('.allow').classList.add('press');
    }
  }

  /** Loops about → usb → allow while `alive()`; calls `onScene(name)` as each starts. */
  async function loop(el, alive, onScene) {
    const seq = ['about', 'usb', 'allow'];
    for (let k = 0; alive(); k++) {
      const sc = seq[k % 3];
      onScene && onScene(sc);
      phone(el, sc, alive);
      await sleep(sc === 'about' ? 4300 : 3000);
    }
  }

  const troubleHTML = `
    <div class="tcard"><b>Device not listed?</b><span>Try another cable — many only charge. Unplug and replug, and make sure “USB debugging” is on.</span></div>
    <div class="tcard"><b>Says “Unauthorized”?</b><span>Look at the phone and tap Allow. Tick “Always allow from this computer”.</span></div>
    <div class="tcard"><b>Blocked — has an account?</b><span>Factory reset the phone, do not sign in to Google, then plug it in again.</span></div>
    <div class="tcard"><b>Windows, phone still missing?</b><span>Install the phone maker’s USB driver (Samsung, Xiaomi, Huawei…).</span></div>
    <div class="tcard"><b>Linux, phone still missing?</b><span>Add your user to <span class="mono">plugdev</span> and install the udev rules, then log out and in.</span></div>`;

  return { CAP, I, OSN, guideHTML, wire, adbCard, phone, loop, troubleHTML, sleep };
})();
