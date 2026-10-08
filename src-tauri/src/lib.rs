use enroll_core::adb::{self, Adb, Details, Firmware, Owner};
use enroll_core::api::{self, ApiError, Session};
use enroll_core::enroll::{enroll_device, Outcome};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const KEYRING_SERVICE: &str = "com.aioapp.enroll";

#[derive(Default)]
struct State {
    session: Mutex<Option<Session>>,
    adb: Mutex<Option<Adb>>,
    /// Per-handle adb probe results; owner/accounts are re-read every 10 s, not every poll.
    probes: Mutex<HashMap<String, (Instant, Probe)>>,
    busy: Mutex<Vec<String>>,
    adb_version: Mutex<String>,
    /// Phone (mDNS name without the "(2)" clash suffix) → the connect address it last answered on.
    /// adb's list flips a phone between its real IP and another phone's; this keeps it steady.
    confirmed: Mutex<HashMap<String, enroll_core::adb::MdnsService>>,
}

#[derive(Clone, Default)]
struct Probe {
    details: Details,
    owner: Owner,
    accounts: usize,
    users: usize,
    firmware: Option<Firmware>,
    /// Version of our DPC agent when it is already Device Owner, else "" / 0.
    dpc_version: String,
    dpc_code: i64,
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
    /// Our DPC agent is already Device Owner (version below) — e.g. enrolled to another server before.
    dpc_owner: bool,
    dpc_version: String,
    /// The installed agent's versionCode, to offer an update when the server hosts a newer one.
    dpc_code: i64,
    /// The MDM is hearing from it now (null: the server is too old to say), and where it is placed.
    online: Option<bool>,
    restaurant: String,
    /// Who enrolled it through the enroll app (display name), if the MDM knows.
    enrolled_by: String,
    server_status: String,
    last_seen: String,
}

/// All the read-only checks for one device. Short timeouts: a phone that never answers
/// comes back `unresponsive` instead of hanging the list.
fn probe_device(q: &Adb, handle: &str) -> Probe {
    // One shell command for the lot: over Wi-Fi each round trip costs, and this used to be eleven.
    let Some(s) = q.scan(handle) else {
        return Probe { details: q.details(handle), unresponsive: true, ..Default::default() };
    };
    // The agent's version is only shown when it is the Device Owner, as before.
    let (dpc_version, dpc_code) = if s.owner.ours { (s.dpc_version, s.dpc_code) } else { (String::new(), 0) };
    Probe {
        owner: s.owner,
        accounts: s.account_count,
        users: s.users,
        firmware: s.firmware,
        details: s.details,
        dpc_version,
        dpc_code,
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
                dpc_owner: false, dpc_version: String::new(), dpc_code: 0,
                online: None, restaurant: String::new(),
                enrolled_by: String::new(),
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
                    let name = adb::device_name(&probe.details.manufacturer, &probe.details.model);
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
                    } else if let Some(why) = enroll_core::adb::blocked_reason(probe.accounts, probe.users, &probe.owner) {
                        row.status = "blocked".into();
                        row.note = why;
                    } else {
                        row.status = "ready".into();
                        row.dpc_owner = probe.owner.ours;
                    }
                    if probe.owner.ours {
                        row.dpc_version = probe.dpc_version.clone();
                        row.dpc_code = probe.dpc_code;
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
                r.enrolled_by = if s.enrolled_by_name.is_empty() { s.enrolled_by.clone() } else { s.enrolled_by_name.clone() };
                r.online = s.online;
                r.restaurant = s.restaurant.clone();
                r.note.clear();
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
async fn enroll(app: AppHandle, state: tauri::State<'_, State>, handle: String, class: String, restaurant_id: Option<String>) -> Result<Outcome, String> {
    let restaurant_id = restaurant_id.unwrap_or_default();
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
        enroll_device(&adb, &session, &h2, &class, &restaurant_id, &apk, &mut log)
    })
    .await
    .map_err(|e| e.to_string());
    state.busy.lock().unwrap().retain(|h| h != &handle);
    state.probes.lock().unwrap().remove(&handle);
    res?
}

/// Restaurants for the "Goes to" picker.
#[tauri::command]
async fn restaurants(app: AppHandle, state: tauri::State<'_, State>) -> Result<Vec<api::Restaurant>, String> {
    let session = session_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || session.restaurants())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| auth_failed(&app, &state, e))
}

/// The agent build the server hosts (null when none, or the server is older).
#[tauri::command]
async fn agent_info(state: tauri::State<'_, State>) -> Result<Option<api::AgentInfo>, String> {
    let session = session_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || session.agent_info()).await.map_err(|e| e.to_string())
}

/// Live state of serials this app enrolled (the Today log's "Now" column).
#[tauri::command]
async fn serial_statuses(app: AppHandle, state: tauri::State<'_, State>, serials: Vec<String>) -> Result<HashMap<String, api::Status>, String> {
    let session = session_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || session.statuses(&serials))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| auth_failed(&app, &state, e))
}

#[derive(Serialize)]
struct Checks {
    /// "name (type)" for each account on the phone.
    accounts: Vec<String>,
    users: usize,
    /// Another app is Device Owner ("" when none, or when it is ours).
    other_owner: String,
}

/// What stands between a blocked phone and enrolling; the UI re-asks every few seconds.
#[tauri::command]
async fn device_checks(app: AppHandle, handle: String) -> Result<Checks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        let q = adb_of(&app, &st)?.quick();
        let owner = q.owner(&handle);
        let checks = Checks {
            accounts: if owner.ours { Vec::new() } else { q.accounts(&handle) },
            users: if owner.ours { 1 } else { q.user_count(&handle) },
            other_owner: if owner.set && !owner.ours { owner.package } else { String::new() },
        };
        // The list re-reads this phone on its next poll, so it turns "ready" as soon as it is clean.
        st.probes.lock().unwrap().remove(&handle);
        Ok(checks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_accounts(app: AppHandle, handle: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        Ok(adb_of(&app, &st)?.open_accounts(&handle))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs the server's current agent over the one on the device (keeps Device Owner and data).
/// Returns the version now installed.
#[tauri::command]
async fn agent_update(app: AppHandle, state: tauri::State<'_, State>, handle: String) -> Result<String, String> {
    let adb = adb_of(&app, &state)?;
    let session = session_of(&state)?;
    // Not marked busy: that would show the device as "enrolling". The UI disables the button instead.
    let h2 = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let apk = std::env::temp_dir().join("aio-mdm-dpc-update.apk");
        let _ = std::fs::remove_file(&apk);
        session.download_apk(&apk)?;
        let out = adb.patient(180).run_on(&h2, &["install", "-r", apk.to_str().ok_or("bad APK path")?]).map_err(|e| format!("Update failed: {e}"))?;
        if !out.contains("Success") {
            return Err(format!("Update failed: {}", out.trim()));
        }
        Ok(adb.quick().package_version(&h2, enroll_core::DPC_PKG))
    })
    .await
    .map_err(|e| e.to_string());
    state.probes.lock().unwrap().remove(&handle);
    res?
}

/// Opens the device's page on the dashboard in the default browser.
#[tauri::command]
fn open_dashboard(state: tauri::State<State>, serial: String) -> Result<(), String> {
    let session = session_of(&state)?;
    if serial.is_empty() || !serial.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("invalid serial".into());
    }
    open_url(&format!("{}/devices/{serial}", session.server))
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

/// Writes the Today log as a CSV into Downloads; returns the path.
#[tauri::command]
fn save_csv(app: AppHandle, name: String, content: String) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') || !name.ends_with(".csv") {
        return Err("bad file name".into());
    }
    let dir = app.path().download_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// A desktop notification (the UI sends it when the window is in the background).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
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
    use enroll_core::adb::{base_name, tcp_probe, Tcp};
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        let checked = adb_of(&app, &st)?.quick().mdns_services_checked();
        let mut confirmed = st.confirmed.lock().unwrap().clone();
        for (s, t) in &checked {
            if s.kind == "connect" && *t == Tcp::Open {
                confirmed.insert(base_name(&s.name).to_string(), s.clone());
            }
        }
        let mut out: Vec<_> = checked.into_iter().map(|(s, _)| s).collect();
        // A phone this scan lost (or listed under a wrong IP that was dropped) but that still answers
        // where it was confirmed stays in the list. Pairing screens are never kept: a closed one must go.
        let missing: Vec<_> = confirmed
            .iter()
            .filter(|(n, _)| !out.iter().any(|s| s.kind == "connect" && base_name(&s.name) == n.as_str()))
            .map(|(n, s)| (n.clone(), s.clone()))
            .collect();
        let back: Vec<(String, Tcp, enroll_core::adb::MdnsService)> = std::thread::scope(|sc| {
            let jobs: Vec<_> = missing.iter().map(|(n, s)| sc.spawn(move || (n.clone(), tcp_probe(&s.addr, 400), s.clone()))).collect();
            jobs.into_iter().filter_map(|j| j.join().ok()).collect()
        });
        for (n, t, s) in back {
            match t {
                Tcp::Open => {
                    out.retain(|o| !(o.kind == "connect" && base_name(&o.name) == n));
                    out.push(s);
                }
                _ => {
                    confirmed.remove(&n); // gone from where it was: forget it
                }
            }
        }
        // The list is shown as-is, so a steady order keeps rows from swapping places.
        out.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
        *st.confirmed.lock().unwrap() = confirmed;
        Ok(out)
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

/// Before asking for a pairing code: try connecting without one (see Adb::connect_known).
/// `addrs` are the phone's advertised connect address(es); port 5555 on its IP is always tried too.
/// Returns the connected handle, or null when a code is needed.
#[tauri::command]
async fn wifi_connect_known(app: AppHandle, host: String, addrs: Vec<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        let mut list: Vec<String> = addrs.into_iter().filter(|a| a.starts_with(&format!("{host}:"))).collect();
        let legacy = format!("{host}:5555");
        if !list.contains(&legacy) {
            list.push(legacy);
        }
        Ok(adb_of(&app, &st)?.quick().connect_known(&list))
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

/// Unpair: see Adb::unpair. `serial` identifies the phone in this computer's paired list.
#[tauri::command]
async fn device_unpair(app: AppHandle, state: tauri::State<'_, State>, serial: String, handles: Vec<String>) -> Result<String, String> {
    for h in &handles {
        state.probes.lock().unwrap().remove(h);
    }
    let (removed, opened) = tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<State>();
        adb_of(&app, &st)?.unpair(&serial, &handles)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut msg = String::from("Unpaired on this computer");
    if removed == 0 { msg.push_str(" (it was not in the paired list)"); }
    msg.push('.');
    msg.push_str(if opened {
        " On the phone, Wireless debugging is now open: tap this computer under Paired devices, then Forget."
    } else {
        " To finish on the phone: Wireless debugging → Paired devices → this computer → Forget."
    });
    Ok(msg)
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
        .plugin(tauri_plugin_notification::init())
        .manage(State::default())
        .invoke_handler(tauri::generate_handler![me, sign_in, sign_in_saved, accounts, account_remove, sign_out, list_devices, enroll, adb_version, adb_status, wifi_discover, wifi_pair, wifi_pair_connect, classify_serials, wifi_connect, wifi_reset, device_forget, device_reprompt, device_to_wifi, device_unpair, profile, last_login, restaurants, agent_info, serial_statuses, device_checks, open_accounts, agent_update, notify, open_dashboard, save_csv, wifi_connect_known])
        .run(tauri::generate_context!())
        .expect("error while running AIO Enroll");
}
