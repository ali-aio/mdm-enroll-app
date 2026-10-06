use enroll_core::adb::{Adb, Details, Firmware, Owner};
use enroll_core::api::{self, ApiError, Session};
use enroll_core::enroll::enroll_device;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const KEYRING_SERVICE: &str = "com.aioapp.enroll";

#[derive(Default)]
struct State {
    session: Mutex<Option<Session>>,
    adb: Mutex<Option<Adb>>,
    /// Per-handle adb probe results; owner/accounts are re-read every 10 s, not every poll.
    probes: Mutex<HashMap<String, (Instant, Probe)>>,
    busy: Mutex<Vec<String>>,
    adb_version: Mutex<String>,
}

#[derive(Clone, Default)]
struct Probe {
    details: Details,
    owner: Owner,
    accounts: usize,
    firmware: Option<Firmware>,
    /// The phone is on the list but answers nothing.
    unresponsive: bool,
}

#[derive(Serialize)]
struct DeviceRow {
    handle: String,
    adb_state: String,
    name: String,
    serial: String,
    android: String,
    /// ready | enrolling | enrolled | firmware | blocked | unauthorized | offline
    status: String,
    note: String,
    class: String,
    agent_version: String,
    /// Our own firmware (client `com.aioapp.mdm`): version, build, and whether the MDM has seen it.
    firmware_version: String,
    build: String,
    server_seen: bool,
    server_status: String,
    last_seen: String,
}

/// All the read-only checks for one device. Short timeouts: a phone that never answers
/// comes back `unresponsive` instead of hanging the list.
fn probe_device(q: &Adb, handle: &str) -> Probe {
    let details = q.details(handle);
    if !details.responsive() {
        return Probe { details, unresponsive: true, ..Default::default() };
    }
    Probe {
        owner: q.owner(handle),
        accounts: q.account_count(handle),
        firmware: q.firmware(handle),
        details,
        unresponsive: false,
    }
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, "session").map_err(|e| e.to_string())
}

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

/// Writes a file only the owner can read (the session token lives here when the OS
/// keystore is unavailable, e.g. a Linux box with no Secret Service running).
fn write_private(path: &std::path::Path, data: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path) {
            let _ = f.write_all(data.as_bytes());
        }
    }
    #[cfg(not(unix))]
    let _ = std::fs::write(path, data);
}

/// Keeps the session across restarts: OS keystore first, 0600 file as the fallback.
fn save_session(app: &AppHandle, s: &Session) {
    let Ok(j) = serde_json::to_string(s) else { return };
    let stored = entry().and_then(|e| e.set_password(&j).map_err(|e| e.to_string())).is_ok();
    if let Some(d) = config_dir(app) {
        if stored {
            let _ = std::fs::remove_file(d.join("session.json"));
        } else {
            write_private(&d.join("session.json"), &j);
        }
        // Not secret: lets the sign-in form come back pre-filled after a session expires.
        let last = serde_json::json!({ "server": s.server, "username": s.username });
        let _ = std::fs::write(d.join("last-login.json"), last.to_string());
    }
}

fn load_session(app: &AppHandle) -> Option<Session> {
    if let Some(s) = entry().ok().and_then(|e| e.get_password().ok()).and_then(|p| serde_json::from_str(&p).ok()) {
        return Some(s);
    }
    let raw = std::fs::read_to_string(config_dir(app)?.join("session.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn clear_session(app: &AppHandle) {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
    if let Some(d) = config_dir(app) {
        let _ = std::fs::remove_file(d.join("session.json"));
    }
}

fn adb_of(app: &AppHandle, st: &State) -> Result<Adb, String> {
    let mut g = st.adb.lock().unwrap();
    if g.is_none() {
        let res: Option<PathBuf> = app.path().resource_dir().ok();
        *g = Adb::find(res.as_deref());
        if let Some(a) = g.as_ref() {
            a.start_server();
        }
    }
    g.clone().ok_or_else(|| "adb was not found. Reinstall the app, or set AIO_ADB to your adb path.".to_string())
}

#[derive(Serialize)]
struct Me {
    username: String,
    role: String,
    server: String,
}


// ---- Saved accounts (the "who's signing in" picker) ----
// Metadata (name, picture) is not secret and lives in accounts.json. Passwords go to the OS
// keystore; only when there is none (a Linux box without Secret Service) do they fall back to
// a 0600 file in the app's config folder.

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    username: String,
    name: String,
    avatar: Option<String>,
    server: String,
    /// A password is stored, so one click signs in.
    saved: bool,
}

fn accounts_path(app: &AppHandle) -> Option<PathBuf> {
    Some(config_dir(app)?.join("accounts.json"))
}

fn load_accounts(app: &AppHandle) -> Vec<Account> {
    accounts_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default()
}

fn store_accounts(app: &AppHandle, list: &[Account]) {
    if let (Some(p), Ok(j)) = (accounts_path(app), serde_json::to_string(list)) {
        let _ = std::fs::write(p, j);
    }
}

fn pw_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("pw:{user}")).map_err(|e| e.to_string())
}

fn secrets_path(app: &AppHandle) -> Option<PathBuf> {
    Some(config_dir(app)?.join("secrets.json"))
}

fn read_secrets(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    secrets_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default()
}

fn pw_save(app: &AppHandle, user: &str, pw: &str) -> bool {
    if pw_entry(user).and_then(|e| e.set_password(pw).map_err(|e| e.to_string())).is_ok() {
        return true;
    }
    let mut m = read_secrets(app);
    m.insert(user.to_string(), serde_json::Value::String(pw.to_string()));
    match (secrets_path(app), serde_json::to_string(&m)) {
        (Some(p), Ok(j)) => {
            write_private(&p, &j);
            true
        }
        _ => false,
    }
}

fn pw_load(app: &AppHandle, user: &str) -> Option<String> {
    if let Some(p) = pw_entry(user).ok().and_then(|e| e.get_password().ok()) {
        return Some(p);
    }
    read_secrets(app).get(user).and_then(|v| v.as_str()).map(str::to_string)
}

fn pw_delete(app: &AppHandle, user: &str) {
    if let Ok(e) = pw_entry(user) {
        let _ = e.delete_credential();
    }
    let mut m = read_secrets(app);
    if m.remove(user).is_some() {
        if let (Some(p), Ok(j)) = (secrets_path(app), serde_json::to_string(&m)) {
            write_private(&p, &j);
        }
    }
}

fn avatar_uri(bytes: Vec<u8>) -> String {
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Adds or refreshes the account tile after a successful sign-in. `password` is saved only
/// when given (the "Save my password" box).
fn remember_account(app: &AppHandle, s: &Session, password: Option<&str>) {
    let p = s.profile().unwrap_or_default();
    let avatar = if p.has_avatar { s.avatar().map(avatar_uri) } else { None };
    let mut list = load_accounts(app);
    let prev_saved = list.iter().find(|a| a.username == s.username).map(|a| a.saved).unwrap_or(false);
    let saved = match password {
        Some(pw) => pw_save(app, &s.username, pw),
        None => prev_saved,
    };
    let acc = Account {
        username: s.username.clone(),
        name: if p.name.is_empty() { s.username.clone() } else { p.name },
        avatar,
        server: s.server.clone(),
        saved,
    };
    list.retain(|a| a.username != acc.username);
    list.insert(0, acc);
    list.truncate(8);
    store_accounts(app, &list);
}

#[tauri::command]
fn accounts(app: AppHandle) -> Vec<Account> {
    load_accounts(&app)
}

#[tauri::command]
fn account_remove(app: AppHandle, username: String) {
    let mut list = load_accounts(&app);
    list.retain(|a| a.username != username);
    store_accounts(&app, &list);
    pw_delete(&app, &username);
}

#[tauri::command]
async fn sign_in_saved(app: AppHandle, state: tauri::State<'_, State>, username: String) -> Result<Me, String> {
    let pw = pw_load(&app, &username).ok_or_else(|| "No saved password for this account. Enter it again.".to_string())?;
    sign_in_inner(app, state, String::new(), username, pw, true).await
}

#[tauri::command]
fn me(app: AppHandle, state: tauri::State<State>) -> Option<Me> {
    let mut g = state.session.lock().unwrap();
    if g.is_none() {
        *g = load_session(&app);
    }
    g.as_ref().map(|s| Me { username: s.username.clone(), role: s.role.clone(), server: s.server.clone() })
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: tauri::State<'_, State>, server: String, username: String, password: String, remember: bool) -> Result<Me, String> {
    sign_in_inner(app, state, server, username, password, remember).await
}

async fn sign_in_inner(app: AppHandle, state: tauri::State<'_, State>, server: String, username: String, password: String, remember: bool) -> Result<Me, String> {
    // Live unless AIO_MDM_SERVER says otherwise (for testing against stage); there is no field for it.
    let server = if server.trim().is_empty() { std::env::var("AIO_MDM_SERVER").unwrap_or_default() } else { server };
    let pw = password.clone();
    let s = tauri::async_runtime::spawn_blocking(move || api::login(&server, &username, &password))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message().to_string())?;
    save_session(&app, &s);
    let me = Me { username: s.username.clone(), role: s.role.clone(), server: s.server.clone() };
    let (app2, s2) = (app.clone(), s.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || remember_account(&app2, &s2, if remember { Some(&pw) } else { None })).await;
    *state.session.lock().unwrap() = Some(s);
    Ok(me)
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: tauri::State<'_, State>) -> Result<(), String> {
    let s = state.session.lock().unwrap().take();
    clear_session(&app);
    if let Some(s) = s {
        let _ = tauri::async_runtime::spawn_blocking(move || s.logout()).await;
    }
    Ok(())
}

fn session_of(state: &State) -> Result<Session, String> {
    state.session.lock().unwrap().clone().ok_or_else(|| "signed-out".to_string())
}

fn auth_failed(app: &AppHandle, state: &State, e: ApiError) -> String {
    if matches!(e, ApiError::Unauthorized(_)) {
        *state.session.lock().unwrap() = None;
        clear_session(app);
        return "signed-out".into();
    }
    e.message().to_string()
}

#[tauri::command]
async fn list_devices(app: AppHandle, state: tauri::State<'_, State>) -> Result<Vec<DeviceRow>, String> {
    let adb = adb_of(&app, &state)?;
    let session = session_of(&state)?;
    let app2 = app.clone();

    let (rows, serials) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let st = app2.state::<State>();
        let raw = adb.devices()?;
        // Probe every device whose cached result is stale, all at once, so one slow phone
        // costs one timeout rather than blocking the rest.
        let stale: Vec<String> = raw
            .iter()
            .filter(|d| d.state == "device")
            .filter(|d| !matches!(st.probes.lock().unwrap().get(&d.handle), Some((t, _)) if t.elapsed() < Duration::from_secs(10)))
            .map(|d| d.handle.clone())
            .collect();
        let fresh: Vec<(String, Probe)> = std::thread::scope(|sc| {
            let jobs: Vec<_> = stale
                .iter()
                .map(|h| {
                    let q = adb.quick();
                    sc.spawn(move || (h.clone(), probe_device(&q, h)))
                })
                .collect();
            jobs.into_iter().filter_map(|j| j.join().ok()).collect()
        });
        for (h, p) in fresh {
            st.probes.lock().unwrap().insert(h, (Instant::now(), p));
        }
        let mut rows = Vec::new();
        let mut serials = Vec::new();
        for d in raw {
            let mut row = DeviceRow {
                handle: d.handle.clone(), adb_state: d.state.clone(), name: d.model.clone(),
                serial: String::new(), android: String::new(), status: "offline".into(),
                note: String::new(), class: String::new(), agent_version: String::new(),
                firmware_version: String::new(), build: String::new(), server_seen: false,
                server_status: String::new(), last_seen: String::new(),
            };
            match d.state.as_str() {
                "unauthorized" => {
                    row.status = "unauthorized".into();
                    row.note = "Accept the USB debugging prompt on the device".into();
                }
                "device" => {
                    let probe = st.probes.lock().unwrap().get(&d.handle).map(|(_, p)| p.clone()).unwrap_or_default();
                    if probe.unresponsive {
                        row.status = "offline".into();
                        row.note = "Not responding. Wake the phone, or check it is on the same Wi-Fi.".into();
                        rows.push(row);
                        continue;
                    }
                    row.serial = probe.details.serial.clone();
                    row.android = probe.details.android.clone();
                    let name = format!("{} {}", probe.details.manufacturer, probe.details.model).trim().to_string();
                    if !name.is_empty() {
                        row.name = name;
                    }
                    if !row.serial.is_empty() {
                        serials.push(row.serial.clone());
                    }
                    if let Some(fw) = &probe.firmware {
                        // In-house firmware: the client is part of the image and enrolls itself, and it
                        // is the Device Owner, so the checks below would wrongly call it blocked.
                        row.status = "firmware".into();
                        row.firmware_version = fw.version.clone();
                        row.build = fw.build.clone();
                    } else if probe.accounts > 0 {
                        row.status = "blocked".into();
                        row.note = "Has an account — factory reset, don't add an account".into();
                    } else if probe.owner.set && !probe.owner.ours {
                        row.status = "blocked".into();
                        row.note = format!("Owned by {} — factory reset", probe.owner.package);
                    } else {
                        row.status = "ready".into();
                    }
                }
                other => row.note = other.to_string(),
            }
            rows.push(row);
        }
        Ok((rows, serials))
    })
    .await
    .map_err(|e| e.to_string())??;

    let statuses = {
        let session = session.clone();
        tauri::async_runtime::spawn_blocking(move || session.statuses(&serials))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| auth_failed(&app, &state, e))?
    };
    let busy = state.busy.lock().unwrap().clone();
    let mut rows = rows;
    for r in rows.iter_mut() {
        if busy.contains(&r.handle) {
            r.status = "enrolling".into();
        } else if r.status == "firmware" {
            if let Some(s) = statuses.get(&r.serial) {
                r.server_seen = s.known();
                r.server_status = s.status.clone();
                r.last_seen = s.last_seen_at.clone().unwrap_or_default();
                if s.known() {
                    r.class = s.class.clone();
                }
            }
        } else if let Some(s) = statuses.get(&r.serial) {
            if s.enrolled {
                r.status = "enrolled".into();
                r.class = s.class.clone();
                r.agent_version = s.agent_version.clone();
                r.note.clear();
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
async fn enroll(app: AppHandle, state: tauri::State<'_, State>, handle: String, class: String) -> Result<(), String> {
    let adb = adb_of(&app, &state)?;
    let session = session_of(&state)?;
    {
        let mut b = state.busy.lock().unwrap();
        if b.contains(&handle) {
            return Err("already enrolling this device".into());
        }
        b.push(handle.clone());
    }
    let apk = std::env::temp_dir().join("aio-mdm-dpc.apk");
    let (h2, app2) = (handle.clone(), app.clone());
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut log = |step: usize, l: &str| {
            let _ = app2.emit("enroll-step", serde_json::json!({ "handle": h2, "step": step, "line": l }));
        };
        // A stale cached APK from an earlier version must not be installed.
        let _ = std::fs::remove_file(&apk);
        enroll_device(&adb, &session, &h2, &class, &apk, &mut log)
    })
    .await
    .map_err(|e| e.to_string());
    state.busy.lock().unwrap().retain(|h| h != &handle);
    state.probes.lock().unwrap().remove(&handle);
    res?
}

#[derive(Serialize)]
struct ProfileOut {
    name: String,
    /// `data:image/png;base64,…`, or null when the account has no picture.
    avatar: Option<String>,
}

#[tauri::command]
async fn profile(state: tauri::State<'_, State>) -> Result<ProfileOut, String> {
    use base64::Engine;
    let session = session_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = session.profile().unwrap_or_default();
        let avatar = if p.has_avatar { session.avatar() } else { None }
            .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
        ProfileOut { name: p.name, avatar }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Server + username from the last sign-in, to pre-fill the form (never the password).
#[tauri::command]
fn last_login(app: AppHandle) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(config_dir(&app)?.join("last-login.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

#[derive(Serialize)]
struct AdbInfo {
    found: bool,
    path: String,
    version: String,
    /// mac | linux | win, so the UI can show the right install steps.
    os: String,
}

/// Is adb usable? `retry` forgets the cached lookup first (the Retry button).
#[tauri::command]
async fn adb_status(app: AppHandle, retry: bool) -> AdbInfo {
    let os = match std::env::consts::OS {
        "macos" => "mac",
        "windows" => "win",
        _ => "linux",
    }
    .to_string();
    let os2 = os.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        if retry {
            *st.adb.lock().unwrap() = None;
            st.adb_version.lock().unwrap().clear();
        }
        match adb_of(&app, &st) {
            Ok(a) => {
                let mut v = st.adb_version.lock().unwrap();
                if v.is_empty() {
                    *v = a.run(&["version"]).ok().and_then(|o| o.lines().next().map(str::to_string)).unwrap_or_default();
                }
                AdbInfo { found: true, path: a.bin.display().to_string(), version: v.clone(), os }
            }
            Err(_) => AdbInfo { found: false, path: String::new(), version: String::new(), os },
        }
    })
    .await
    .unwrap_or(AdbInfo { found: false, path: String::new(), version: String::new(), os: os2 })
}

#[tauri::command]
async fn wifi_discover(app: AppHandle) -> Result<Vec<enroll_core::adb::MdnsService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        Ok(adb_of(&app, &st)?.quick().mdns_services())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wifi_pair(app: AppHandle, addr: String, code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.pair(addr.trim(), code.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Server's verdict on each serial ("ours?"). Fails quietly in the UI when the server is older.
#[tauri::command]
async fn classify_serials(app: AppHandle, state: tauri::State<'_, State>, serials: Vec<String>) -> Result<HashMap<String, enroll_core::api::SerialClass>, String> {
    let session = session_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || session.classify(&serials))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| auth_failed(&app, &state, e))
}

#[tauri::command]
async fn wifi_pair_connect(app: AppHandle, addr: String, code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.patient(25).pair_and_connect(addr.trim(), code.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wifi_connect(app: AppHandle, addr: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.connect(addr.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wifi_reset(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.reset();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn device_forget(app: AppHandle, state: tauri::State<'_, State>, handle: String) -> Result<String, String> {
    state.probes.lock().unwrap().remove(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.disconnect_device(&handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn device_reprompt(app: AppHandle, state: tauri::State<'_, State>, handle: String) -> Result<String, String> {
    state.probes.lock().unwrap().remove(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.reprompt(&handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn device_to_wifi(app: AppHandle, state: tauri::State<'_, State>, handle: String) -> Result<String, String> {
    state.probes.lock().unwrap().remove(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.patient(60).to_wifi(&handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn adb_version(app: AppHandle, state: tauri::State<State>) -> Result<String, String> {
    let adb = adb_of(&app, &state)?;
    let v = adb.run(&["version"])?;
    Ok(v.lines().next().unwrap_or("").to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(State::default())
        .invoke_handler(tauri::generate_handler![me, sign_in, sign_in_saved, accounts, account_remove, sign_out, list_devices, enroll, adb_version, adb_status, wifi_discover, wifi_pair, wifi_pair_connect, classify_serials, wifi_connect, wifi_reset, device_forget, device_reprompt, device_to_wifi, profile, last_login])
        .run(tauri::generate_context!())
        .expect("error while running AIO Enroll");
}
