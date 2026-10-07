use crate::adb::{valid_handle, Adb};
use crate::api::Session;
use crate::{CLASSES, DPC_ADMIN, DPC_PKG};
use std::path::Path;
use std::time::{Duration, Instant};

/// The steps the UI shows, in order.
pub const STEPS: [&str; 8] = [
    "Checking the device",
    "Getting a token",
    "Installing the agent",
    "Setting Device Owner",
    "Granting permissions",
    "Starting the agent",
    "Registering with the MDM",
    "First check-in",
];

/// How long to wait for the device's first check-in once it has registered. A device that
/// stays quiet longer is still enrolled; the app says it hasn't been heard from yet.
pub const FIRST_CHECKIN_WAIT: Duration = Duration::from_secs(60);

/// What an enrollment ended with.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Outcome {
    /// The MDM heard from the device after it enrolled (it is checking in).
    pub live: bool,
    /// The server reports check-ins at all (an older one doesn't, and then `live` means nothing).
    pub checked: bool,
    pub serial: String,
    /// Where it was placed ("" = onboarding inbox).
    pub restaurant: String,
    pub battery_pct: i64,
    pub has_battery: bool,
    pub agent_version: String,
}

/// Enrolls one device over adb. Same steps as tools/enroll-adb.sh, with each failure
/// stated in terms of what the person should do. `progress(step, text)` is called as each
/// of the steps in [`STEPS`] starts (a step may report more than once). `restaurant_id` ""
/// leaves the device in the onboarding inbox.
pub fn enroll_device(
    adb: &Adb,
    session: &Session,
    handle: &str,
    class: &str,
    restaurant_id: &str,
    apk: &Path,
    progress: &mut dyn FnMut(usize, &str),
) -> Result<Outcome, String> {
    if !valid_handle(handle) {
        return Err("invalid device handle".into());
    }
    if !CLASSES.contains(&class) {
        return Err(format!("unknown class {class}"));
    }

    progress(0, "Checking the device…");
    let owner = adb.owner(handle);
    if let Some(why) = crate::adb::blocked_reason(adb.account_count(handle), adb.user_count(handle), &owner) {
        return Err(format!("Can’t be enrolled: {why}."));
    }

    progress(1, "Getting an enrollment token…");
    let tok = session.enroll_token(class, restaurant_id).map_err(|e| e.message().to_string())?;

    if !apk.is_file() {
        progress(2, "Downloading the agent…");
        session.download_apk(apk)?;
    }
    let apk_s = apk.to_str().ok_or("bad APK path")?;

    progress(2, "Installing the agent…");
    let out = adb.patient(180).run_on(handle, &["install", "-r", apk_s]).map_err(|e| format!("Install failed: {e}"))?;
    if !out.contains("Success") {
        return Err(format!("Install failed: {}", out.trim()));
    }

    let component = format!("{DPC_PKG}/{DPC_ADMIN}");
    if owner.set {
        progress(3, "Already our Device Owner, skipping.");
    } else {
        progress(3, "Setting Device Owner…");
        let out = adb
            .patient(60)
            .shell(handle, &["dpm", "set-device-owner", &component])
            .map_err(|e| format!("set-device-owner failed: {e}"))?;
        if !out.contains("Success") {
            return Err(format!("set-device-owner failed: {}", out.trim()));
        }
    }

    progress(4, "Granting permissions…");
    let _ = adb.shell(handle, &["pm", "grant", DPC_PKG, "android.permission.READ_LOGS"]);
    let _ = adb.shell(handle, &["pm", "grant", DPC_PKG, "android.permission.WRITE_SECURE_SETTINGS"]);
    let _ = adb.shell(handle, &["appops", "set", DPC_PKG, "GET_USAGE_STATS", "allow"]);
    let _ = adb.shell(handle, &["appops", "set", DPC_PKG, "PROJECT_MEDIA", "allow"]);

    let serial = adb.prop(handle, "ro.serialno");
    // A re-enrolled device was already checking in: its first check-in is a newer one than this.
    let seen_before = session.statuses(&[serial.clone()]).ok().and_then(|m| m.get(&serial).and_then(|s| s.last_seen_at.clone()));
    progress(5, &format!("Starting the agent (class {class})…"));
    let main = format!("{DPC_PKG}/.ui.MainActivity");
    adb.shell(
        handle,
        &["am", "start", "-W", "-n", &main, "--es", "server_url", &tok.server_url, "--es", "enroll_token", &tok.token],
    )
    .map_err(|e| format!("Could not start the agent: {e}"))?;

    progress(6, "Waiting for the MDM to register it…");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut registered = false;
    while Instant::now() < deadline {
        if let Ok(m) = session.statuses(&[serial.clone()]) {
            if m.get(&serial).map(|s| s.enrolled).unwrap_or(false) {
                registered = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if !registered {
        return Err("The server did not confirm within 30 s. Check the device has internet.".into());
    }

    progress(7, "Waiting for its first check-in…");
    let mut out = Outcome { serial: serial.clone(), ..Default::default() };
    let deadline = Instant::now() + FIRST_CHECKIN_WAIT;
    loop {
        if let Ok(m) = session.statuses(&[serial.clone()]) {
            if let Some(s) = m.get(&serial) {
                out.restaurant = s.restaurant.clone();
                out.battery_pct = s.battery_pct;
                out.has_battery = s.has_battery;
                out.agent_version = s.agent_version.clone();
                let Some(online) = s.online else {
                    return Ok(out); // an older server can't tell: don't wait for nothing
                };
                out.checked = true;
                if online && s.last_seen_at.is_some() && s.last_seen_at != seen_before {
                    out.live = true;
                    return Ok(out);
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(out); // enrolled; just not heard from yet
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
