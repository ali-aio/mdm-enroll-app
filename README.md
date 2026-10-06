# AIO Enroll

Desktop app (Tauri 2: Rust core + web UI) for macOS, Windows and Linux. Open it, sign in
with your MDM account once, plug in Android devices, click **Enroll**. Runs on the local
machine only: no SSH, no Tailscale. adb is bundled.

- `enroll-core/` — adb, MDM API client and the enroll steps (no GUI dependency; `cargo test -p enroll-core`)
- `src-tauri/` — the window, OS keystore (Keychain / Credential Manager / Secret Service), commands
- `ui/` — plain HTML/JS using the dashboard's `style.css`
- UI designs and demos live in the MDM repo, `static/enroll-app-*-demos.html`

## Server side
Signs in through `POST /api/v1/app/login` (dashboard account; roles admin, dev, user_manager,
super_op, operator) and uses `GET /api/v1/app/enroll-status` and `POST /api/v1/app/enroll-token`.
No admin key and no class tokens ship in the app.

## Build
```
scripts/fetch-platform-tools.sh linux      # or darwin / windows
cargo install tauri-cli --version "^2" --locked
cargo tauri build
cargo test -p enroll-core
cargo run -p enroll-core --example probe   # read-only: lists adb devices and their state
```
Linux needs `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev`.
macOS/Windows builds come from `.github/workflows/build.yml` (manual run).

## First open (builds are unsigned)
- macOS: right-click the app → Open, or `xattr -cr "/Applications/AIO Enroll.app"`.
- Windows: SmartScreen → More info → Run anyway. Some phones also need their vendor USB driver.
- Linux: add a udev rule, or run once with a user in the `plugdev` group, if adb lists no device.

Part of the AIO MDM: checked out as a submodule at `aio-mdm-enroll-app` in `AIOApp/mdm`.
