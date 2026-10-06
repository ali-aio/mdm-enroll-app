use serde::Serialize;
use std::path::{Path, PathBuf};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Adb {
    pub bin: PathBuf,
    /// Longest any single adb call may take. A phone that accepts the connection but never
    /// answers (asleep over Wi-Fi) would otherwise block the whole app forever.
    pub timeout: Duration,
}

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
/// For the per-device checks that run on every refresh.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RawDevice {
    pub handle: String,
    pub state: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Details {
    pub serial: String,
    pub manufacturer: String,
    pub model: String,
    pub android: String,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
pub struct Owner {
    pub set: bool,
    pub ours: bool,
    pub package: String,
}

/// adb handles end up as `-s <handle>` arguments (never in a shell string), but keep
/// them to the characters adb itself produces so a hostile value can't smuggle anything.
pub fn valid_handle(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 128
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

/// Package of the in-house firmware client (a platform-signed system app in our AOSP images).
pub const FIRMWARE_PKG: &str = "com.aioapp.mdm";

/// An in-house device: our own firmware, with the MDM client baked in. It enrolls itself.
#[derive(Clone, Debug, Serialize, Default, PartialEq)]
pub struct Firmware {
    pub version: String,
    pub build: String,
}

/// `pm list packages <filter>` matches substrings (it would also list `.dpc`), so look
/// for the exact package line.
pub fn package_listed(out: &str, pkg: &str) -> bool {
    let want = format!("package:{pkg}");
    out.lines().any(|l| l.trim() == want)
}

/// `versionName=1.6.2` out of `dumpsys package <pkg>`.
pub fn parse_version_name(dump: &str) -> String {
    dump.lines()
        .find_map(|l| l.trim().strip_prefix("versionName="))
        .and_then(|v| v.split_whitespace().next())
        .unwrap_or("")
        .to_string()
}

/// A phone found on the network by `adb mdns services`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MdnsService {
    pub name: String,
    /// "connect" (the Wireless debugging screen's IP:port) or "pairing" (the pairing-code dialog's).
    pub kind: String,
    pub addr: String,
}

/// Connected over the network rather than USB: `ip:port`, or the `adb-…._adb-tls-connect._tcp`
/// name adb gives a phone it found through Wireless debugging.
pub fn is_network_handle(h: &str) -> bool {
    h.contains(':') || h.contains("._adb-tls-")
}

/// The phone's Wi-Fi IPv4 address out of `ip -f inet addr show wlan0` (`inet 192.168.1.20/24 …`)
/// or `ip route` (`… dev wlan0 … src 192.168.1.20`). Loopback and link-local are ignored.
pub fn parse_wlan_ip(out: &str) -> Option<String> {
    let ok = |ip: &str| {
        ip.split('.').count() == 4
            && ip.split('.').all(|o| o.parse::<u8>().is_ok())
            && !ip.starts_with("127.")
            && !ip.starts_with("169.254.")
            && ip != "0.0.0.0"
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("inet ") {
            if let Some(ip) = rest.split(|c| c == '/' || c == ' ').next() {
                if ok(ip) {
                    return Some(ip.to_string());
                }
            }
        }
        if t.contains(" dev wlan") || t.contains(" dev wifi") {
            if let Some(after) = t.split(" src ").nth(1) {
                if let Some(ip) = after.split_whitespace().next() {
                    if ok(ip) {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

/// The host part of `host:port`.
pub fn host_of(addr: &str) -> &str {
    addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr)
}

/// `host:port` where host is an IPv4 address or a plain hostname. Anything adb would
/// treat as a flag, or a shell would, is rejected.
pub fn valid_hostport(a: &str) -> bool {
    let Some((host, port)) = a.rsplit_once(':') else { return false };
    let port_ok = port.parse::<u32>().map(|p| (1..=65535).contains(&p)).unwrap_or(false);
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && port_ok
}

/// What `adb connect` printed means it worked ("connected to …" / "already connected to …").
pub fn connect_ok(out: &str) -> bool {
    let o = out.to_lowercase();
    (o.contains("connected to") || o.contains("already connected")) && !o.contains("failed") && !o.contains("cannot")
}

pub fn parse_mdns(out: &str) -> Vec<MdnsService> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let (name, svc, addr) = (it.next()?, it.next()?, it.next()?);
            let kind = if svc.contains("_adb-tls-pairing") {
                "pairing"
            } else if svc.contains("_adb-tls-connect") {
                "connect"
            } else {
                return None;
            };
            valid_hostport(addr).then(|| MdnsService { name: name.to_string(), kind: kind.into(), addr: addr.to_string() })
        })
        .collect()
}

impl Details {
    /// False when the phone answered none of the property reads (asleep, or a dead Wi-Fi link).
    pub fn responsive(&self) -> bool {
        !(self.serial.is_empty() && self.model.is_empty() && self.manufacturer.is_empty() && self.android.is_empty())
    }
}

impl Adb {
    /// Phones on this network with Wireless debugging on (empty when mDNS is unavailable).
    pub fn mdns_services(&self) -> Vec<MdnsService> {
        parse_mdns(&self.run(&["mdns", "services"]).unwrap_or_default())
    }

    /// Forgets a device that is connected over the network (`adb disconnect`).
    /// A USB device cannot be forgotten from software: unplug it.
    pub fn disconnect_device(&self, handle: &str) -> Result<String, String> {
        if !valid_handle(handle) {
            return Err("invalid device handle".into());
        }
        if !is_network_handle(handle) {
            return Err("This phone is on a USB cable. Unplug it to remove it from the list.".into());
        }
        let out = self.run(&["disconnect", handle]).unwrap_or_else(|e| e);
        // Phones found through Wireless debugging reconnect by themselves while it is on.
        if handle.contains("._adb-tls-") {
            std::thread::sleep(std::time::Duration::from_millis(800));
            if self.devices().map(|d| d.iter().any(|x| x.handle == handle && x.state == "device")).unwrap_or(false) {
                return Err("It reconnects by itself because Wireless debugging is still on. Turn Wireless debugging off on the phone to forget it.".into());
            }
        } else if out.to_lowercase().contains("no such device") {
            return Err(format!("adb could not disconnect it: {}", out.trim()));
        }
        Ok("Disconnected.".into())
    }

    /// The phone's Wi-Fi address, read over the cable.
    pub fn device_ip(&self, handle: &str) -> Option<String> {
        for cmd in [vec!["ip", "-f", "inet", "addr", "show", "wlan0"], vec!["ip", "route"]] {
            if let Some(ip) = self.shell(handle, &cmd).ok().and_then(|o| parse_wlan_ip(&o)) {
                return Some(ip);
            }
        }
        None
    }

    /// For a phone on a USB cable: switches its adb to TCP port 5555 and connects to it over
    /// Wi-Fi. No pairing and no code, works on any Android version; lasts until the phone
    /// restarts. The cable can then be unplugged.
    pub fn to_wifi(&self, handle: &str) -> Result<String, String> {
        if !valid_handle(handle) {
            return Err("invalid device handle".into());
        }
        if is_network_handle(handle) {
            return Err("This phone is already connected over Wi-Fi.".into());
        }
        let ip = self
            .device_ip(handle)
            .ok_or("Couldn't read the phone's Wi-Fi address. Make sure it is connected to Wi-Fi, on the same network as this computer.")?;
        let out = self.run_on(handle, &["tcpip", "5555"]).map_err(|e| format!("The phone refused to switch: {e}"))?;
        if !out.to_lowercase().contains("restarting in tcp mode") {
            return Err(format!("The phone didn't switch to Wi-Fi mode: {}", out.trim()));
        }
        std::thread::sleep(std::time::Duration::from_millis(2000)); // adbd restarts; the USB link blips
        let addr = format!("{ip}:5555");
        self.connect(&addr)
            .map(|_| format!("On Wi-Fi at {addr}. You can unplug the cable."))
            .map_err(|e| format!("The phone switched, but connecting failed. Is this computer on the same Wi-Fi as the phone? ({e})"))
    }

    /// Makes the phone ask "Allow USB debugging?" again: drops the connection and
    /// reconnects, which re-triggers the authorization prompt when the key is not trusted.
    pub fn reprompt(&self, handle: &str) -> Result<String, String> {
        if !valid_handle(handle) {
            return Err("invalid device handle".into());
        }
        if valid_hostport(handle) {
            let _ = self.run(&["disconnect", handle]);
            self.connect(handle)?;
        } else {
            // USB, or a wireless-debugging mDNS name: kick the connection from our side.
            self.run_on(handle, &["reconnect"])?;
        }
        Ok("Asked the phone again. Look at its screen and tap Allow.".into())
    }

    /// Pair with the phone's pairing code, then get connected without asking the person
    /// anything more: many phones connect by themselves right after pairing; for the rest the
    /// phone's own connect address (found over the network, same IP) is used. Returns the
    /// handle the phone is now listed under.
    pub fn pair_and_connect(&self, addr: &str, code: &str) -> Result<String, String> {
        if !valid_hostport(addr) {
            return Err("Enter the IP address and port exactly as the pairing screen shows them, like 192.168.1.20:37215.".into());
        }
        let is_net = |h: &str| is_network_handle(h);
        let before: Vec<String> = self.devices().unwrap_or_default().into_iter().map(|d| d.handle).filter(|h| is_net(h)).collect();
        self.pair(addr, code)?;
        let host = host_of(addr).to_string();
        let deadline = Instant::now() + Duration::from_secs(18);
        let mut tried: Vec<String> = Vec::new();
        while Instant::now() < deadline {
            // 1. It connected by itself.
            if let Ok(devs) = self.devices() {
                if let Some(d) = devs.iter().find(|d| is_net(&d.handle) && !before.contains(&d.handle) && d.state != "offline") {
                    return Ok(d.handle.clone());
                }
            }
            // 2. Connect to the address the phone advertises for itself (its port changes, so look it up now).
            for svc in self.mdns_services() {
                if svc.kind == "connect" && host_of(&svc.addr) == host && !tried.contains(&svc.addr) {
                    tried.push(svc.addr.clone());
                    if self.connect(&svc.addr).is_ok() {
                        return Ok(svc.addr);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
        Err("Paired, but it didn't connect. Make sure the phone and this computer are on the same Wi-Fi, keep the phone awake, and try again.".into())
    }

    /// Restarts the adb helper: clears stuck or half-open connections.
    pub fn reset(&self) {
        let _ = self.run(&["kill-server"]);
        self.start_server();
    }

    /// `adb pair <ip:pairing-port> <6-digit code>`. The code and port come from the phone's
    /// "Pair device with pairing code" dialog and expire when it closes.
    pub fn pair(&self, addr: &str, code: &str) -> Result<String, String> {
        if !valid_hostport(addr) {
            return Err("Enter the IP address and port exactly as the phone shows them, like 192.168.1.20:37215.".into());
        }
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            return Err("The pairing code is 6 digits.".into());
        }
        let out = self.run(&["pair", addr, code]).unwrap_or_else(|e| e);
        if out.to_lowercase().contains("successfully paired") {
            Ok("Paired. Now connect using the other IP address and port on the Wireless debugging screen.".into())
        } else {
            Err(format!("Pairing failed. Check the code is current (it changes if you close the dialog) and use the pairing port from that dialog, not the connect port. adb said: {}", out.trim()))
        }
    }

    /// `adb connect`, retried: the first attempt often fails right after pairing or after the
    /// phone woke up. Failure explains the usual causes in plain words.
    pub fn connect(&self, addr: &str) -> Result<String, String> {
        if !valid_hostport(addr) {
            return Err("Enter the IP address and port as the phone shows them, like 192.168.1.20:41231.".into());
        }
        let _ = self.run(&["disconnect", addr]); // drop a stale half-open entry first
        let mut last = String::new();
        for attempt in 0..3 {
            if attempt == 2 {
                let _ = self.run(&["kill-server"]); // last resort: restart the adb helper
                self.start_server();
            }
            last = self.run(&["connect", addr]).unwrap_or_else(|e| e);
            if connect_ok(&last) {
                return Ok(format!("Connected to {addr}."));
            }
            std::thread::sleep(std::time::Duration::from_millis(1200));
        }
        Err(format!(
            "Could not connect to {addr}. Usual causes: the phone and this computer are on different Wi-Fi networks; \
             the port changed (it changes every time Wireless debugging is switched off and on, so re-read it on the phone); \
             the phone went to sleep; or it was never paired. adb said: {}",
            last.trim()
        ))
    }

    /// Looks for adb in: `$AIO_ADB`, a bundled `platform-tools/` next to the app, then PATH
    /// and the usual SDK locations.
    pub fn find(bundled_dir: Option<&Path>) -> Option<Adb> {
        let exe = if cfg!(windows) { "adb.exe" } else { "adb" };
        let mut cands: Vec<PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("AIO_ADB") {
            cands.push(PathBuf::from(p));
        }
        if let Some(d) = bundled_dir {
            cands.push(d.join("platform-tools").join(exe));
            cands.push(d.join(exe));
        }
        if let Some(path) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&path) {
                cands.push(d.join(exe));
            }
        }
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let h = PathBuf::from(home);
            for rel in [
                "Library/Android/sdk/platform-tools",
                "Android/Sdk/platform-tools",
                "AppData/Local/Android/Sdk/platform-tools",
                "Downloads/platform-tools",
            ] {
                cands.push(h.join(rel).join(exe));
            }
        }
        cands.push(PathBuf::from("/opt/homebrew/bin").join(exe));
        cands.push(PathBuf::from("/usr/local/bin").join(exe));
        cands
            .into_iter()
            .find(|p| p.is_file())
            .map(|bin| Adb { bin, timeout: DEFAULT_TIMEOUT })
    }

    fn cmd(&self) -> Command {
        #[allow(unused_mut)] // only mutated on Windows
        let mut c = Command::new(&self.bin);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c
    }

    /// Same adb, but with the short timeout used for the checks that run on every refresh.
    pub fn quick(&self) -> Adb {
        Adb { bin: self.bin.clone(), timeout: PROBE_TIMEOUT }
    }

    /// Same adb with a longer limit, for installs.
    pub fn patient(&self, secs: u64) -> Adb {
        Adb { bin: self.bin.clone(), timeout: Duration::from_secs(secs) }
    }

    /// Runs adb with the given args; returns stdout. Errors carry stderr. Killed and
    /// reported as "adb timed out" if it takes longer than `self.timeout`.
    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut child = self
            .cmd()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run adb: {e}"))?;
        // Drain both pipes on their own threads so a large dumpsys cannot fill a pipe and stall.
        let mut so = child.stdout.take().ok_or("no stdout")?;
        let mut se = child.stderr.take().ok_or("no stderr")?;
        let t_out = std::thread::spawn(move || { let mut b = Vec::new(); let _ = so.read_to_end(&mut b); b });
        let t_err = std::thread::spawn(move || { let mut b = Vec::new(); let _ = se.read_to_end(&mut b); b });
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("adb timed out".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                Err(e) => return Err(format!("adb failed: {e}")),
            }
        };
        let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
        if status.success() {
            Ok(stdout)
        } else {
            Err(format!("{}{}", stdout.trim(), stderr.trim()).trim().to_string())
        }
    }

    /// `adb -s <handle> <args...>`; the handle is validated first.
    pub fn run_on(&self, handle: &str, args: &[&str]) -> Result<String, String> {
        if !valid_handle(handle) {
            return Err("invalid device handle".into());
        }
        let mut full = vec!["-s", handle];
        full.extend_from_slice(args);
        self.run(&full)
    }

    pub fn shell(&self, handle: &str, args: &[&str]) -> Result<String, String> {
        let mut full = vec!["shell"];
        full.extend_from_slice(args);
        self.run_on(handle, &full)
    }

    pub fn start_server(&self) {
        let _ = self.run(&["start-server"]);
    }

    pub fn devices(&self) -> Result<Vec<RawDevice>, String> {
        Ok(parse_devices(&self.run(&["devices", "-l"])?))
    }

    pub fn prop(&self, handle: &str, name: &str) -> String {
        self.shell(handle, &["getprop", name]).unwrap_or_default().trim().to_string()
    }

    pub fn details(&self, handle: &str) -> Details {
        Details {
            serial: self.prop(handle, "ro.serialno"),
            manufacturer: self.prop(handle, "ro.product.manufacturer"),
            model: self.prop(handle, "ro.product.model"),
            android: self.prop(handle, "ro.build.version.release"),
        }
    }

    pub fn owner(&self, handle: &str) -> Owner {
        let out = self.shell(handle, &["dumpsys", "device_policy"]).unwrap_or_default();
        parse_owner(&out)
    }

    /// Present when the device runs our firmware with the MDM client installed.
    pub fn firmware(&self, handle: &str) -> Option<Firmware> {
        let listed = self.shell(handle, &["pm", "list", "packages", FIRMWARE_PKG]).unwrap_or_default();
        if !package_listed(&listed, FIRMWARE_PKG) {
            return None;
        }
        let dump = self.shell(handle, &["dumpsys", "package", FIRMWARE_PKG]).unwrap_or_default();
        let mut build = self.prop(handle, "ro.build.display.id");
        if build.is_empty() {
            build = self.prop(handle, "ro.build.id");
        }
        Some(Firmware { version: parse_version_name(&dump), build })
    }

    pub fn account_count(&self, handle: &str) -> usize {
        let out = self.shell(handle, &["dumpsys", "account"]).unwrap_or_default();
        out.matches("Account {").count()
    }
}

pub fn parse_devices(out: &str) -> Vec<RawDevice> {
    out.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let handle = it.next()?.to_string();
            let state = it.next().unwrap_or("?").to_string();
            let model = it
                .find_map(|t| t.strip_prefix("model:"))
                .unwrap_or("")
                .replace('_', " ");
            Some(RawDevice { handle, state, model })
        })
        .collect()
}

/// Mirrors `dumpsys device_policy | grep -A2 'Device Owner:'`: the block after the
/// heading names the admin component and package.
pub fn parse_owner(dump: &str) -> Owner {
    let mut lines = dump.lines();
    while let Some(l) = lines.next() {
        if l.contains("Device Owner:") {
            let block: String = lines.by_ref().take(3).collect::<Vec<_>>().join("\n");
            if !block.contains("admin=") {
                break;
            }
            let ours = block.contains(&format!("{}/{}", crate::DPC_PKG, crate::DPC_ADMIN));
            let package = block
                .split("package=")
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .unwrap_or("")
                .to_string();
            return Owner { set: true, ours, package };
        }
    }
    Owner::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devices_l() {
        let out = "List of devices attached\n\
            A1B2C3 device usb:1-2 product:rbox model:HK1_RBOX_D8 device:rbox transport_id:1\n\
            0123 unauthorized usb:1-3 transport_id:2\n\n";
        let d = parse_devices(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].model, "HK1 RBOX D8");
        assert_eq!(d[1].state, "unauthorized");
    }

    #[test]
    fn daemon_noise_is_skipped() {
        let out = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n";
        assert!(parse_devices(out).is_empty());
    }

    #[test]
    fn owner_ours_and_other() {
        let ours = "  Device Owner: \n    admin=ComponentInfo{aio.app.mdmclient.dpc/aio.app.mdmclient.dpc.MdmDeviceAdminReceiver}\n    name=x package=aio.app.mdmclient.dpc\n";
        let o = parse_owner(ours);
        assert!(o.set && o.ours);
        let other = "  Device Owner: \n    admin=ComponentInfo{com.other/com.other.Rx}\n    package=com.other\n";
        let o = parse_owner(other);
        assert!(o.set && !o.ours && o.package == "com.other");
        assert_eq!(parse_owner("nothing here"), Owner::default());
    }

    #[test]
    fn hostport_validation() {
        assert!(valid_hostport("192.168.1.20:41231"));
        assert!(valid_hostport("pixel.local:5555"));
        assert!(!valid_hostport("192.168.1.20"));
        assert!(!valid_hostport("192.168.1.20:0"));
        assert!(!valid_hostport("192.168.1.20:99999"));
        assert!(!valid_hostport("-x:5555"));
        assert!(!valid_hostport("a b:5555"));
        assert!(!valid_hostport("1.2.3.4:5555; rm -rf /"));
    }

    #[test]
    fn connect_output() {
        assert!(connect_ok("connected to 192.168.1.20:41231"));
        assert!(connect_ok("already connected to 192.168.1.20:41231"));
        assert!(!connect_ok("failed to connect to '192.168.1.20:41231': Connection refused"));
        assert!(!connect_ok("cannot connect to 192.168.1.20:41231: No route to host"));
        assert!(!connect_ok(""));
    }

    #[test]
    fn mdns_lines() {
        let out = "List of discovered mdns services\n\
            adb-ABC123-xyz\t_adb-tls-connect._tcp.\t192.168.1.20:41231\n\
            adb-ABC123-pp\t_adb-tls-pairing._tcp.\t192.168.1.20:37215\n\
            junk\t_other._tcp.\t1.2.3.4:5\n";
        let v = parse_mdns(out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].kind, "connect");
        assert_eq!(v[1].kind, "pairing");
        assert_eq!(v[1].addr, "192.168.1.20:37215");
    }

    #[test]
    fn forget_refuses_usb_and_bad_handles_without_running_adb() {
        let a = Adb { bin: PathBuf::from("/nonexistent/adb"), timeout: DEFAULT_TIMEOUT };
        assert!(a.disconnect_device("A1B2C3").unwrap_err().contains("USB"));
        assert!(a.disconnect_device("x; reboot").is_err());
        assert!(a.reprompt("x; reboot").is_err());
    }

    #[test]
    fn firmware_package_detection() {
        let both = "package:com.aioapp.mdm.dpc\npackage:other.app\n";
        assert!(!package_listed(both, FIRMWARE_PKG)); // the standard (DPC) agent is not firmware
        assert!(package_listed("package:com.aioapp.mdm\r\n", FIRMWARE_PKG));
        assert!(!package_listed("", FIRMWARE_PKG));
        assert_eq!(parse_version_name("  versionCode=161 minSdk=30\n  versionName=1.6.2\n"), "1.6.2");
        assert_eq!(parse_version_name("nothing"), "");
    }

    #[test]
    fn network_handles() {
        assert!(is_network_handle("192.168.1.5:5555"));
        assert!(is_network_handle("adb-DK19248T41010-FoT4PR._adb-tls-connect._tcp"));
        assert!(!is_network_handle("18121FDF60022T"));
    }

    #[test]
    fn a_hung_command_is_killed_at_the_timeout() {
        // `sleep` stands in for an adb call that never answers.
        let a = Adb { bin: PathBuf::from("sleep"), timeout: Duration::from_millis(300) };
        let t = Instant::now();
        assert_eq!(a.run(&["5"]).unwrap_err(), "adb timed out");
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn unanswered_property_reads_are_unresponsive() {
        assert!(!Details::default().responsive());
        assert!(Details { model: "T7".into(), ..Default::default() }.responsive());
    }

    #[test]
    fn wlan_ip_parsing() {
        let addr = "27: wlan0: <BROADCAST> mtu 1500\n    inet 192.168.1.20/24 brd 192.168.1.255 scope global wlan0\n";
        assert_eq!(parse_wlan_ip(addr).as_deref(), Some("192.168.1.20"));
        let route = "10.32.0.0/16 dev wlan0 proto kernel scope link src 10.32.2.167\n";
        assert_eq!(parse_wlan_ip(route).as_deref(), Some("10.32.2.167"));
        assert_eq!(parse_wlan_ip("    inet 127.0.0.1/8 scope host lo\n"), None);
        assert_eq!(parse_wlan_ip("inet 169.254.3.4/16 scope link wlan0"), None);
        assert_eq!(parse_wlan_ip(""), None);
    }

    #[test]
    fn to_wifi_refuses_network_and_bad_handles_without_running_adb() {
        let a = Adb { bin: PathBuf::from("/nonexistent/adb"), timeout: DEFAULT_TIMEOUT };
        assert!(a.to_wifi("192.168.1.5:5555").unwrap_err().contains("already"));
        assert!(a.to_wifi("x; reboot").is_err());
    }

    #[test]
    fn real_discovery_output_from_a_phone_in_pairing_mode() {
        // Captured from a T7 with "Pair device with pairing code" open, plus other phones around.
        let out = "List of discovered mdns services\n\
            adb-AT070AA2600030-KLVymJ\t_adb-tls-connect._tcp\t10.32.0.113:43213\n\
            adb-AT070AABU00875\t_adb._tcp\t10.32.2.167:5555\n\
            adb-18121FDF60022T-fbnpOu\t_adb-tls-pairing._tcp\t10.32.2.210:33717\n\
            adb-AT070AA2600030-KLVymJ\t_adb-tls-pairing._tcp\t10.32.0.113:37971\n";
        let v = parse_mdns(out);
        let pairing: Vec<_> = v.iter().filter(|s| s.kind == "pairing").collect();
        assert_eq!(pairing.len(), 2);
        assert!(pairing.iter().any(|s| s.addr == "10.32.0.113:37971"));
        assert_eq!(v.iter().filter(|s| s.kind == "connect").count(), 1); // plain _adb._tcp lines are ignored
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("192.168.1.20:37215"), "192.168.1.20");
        assert_eq!(host_of("pixel.local:5555"), "pixel.local");
        assert_eq!(host_of("nocolon"), "nocolon");
    }

    #[test]
    fn pair_and_connect_validates_before_touching_adb() {
        let a = Adb { bin: PathBuf::from("/nonexistent/adb"), timeout: DEFAULT_TIMEOUT };
        assert!(a.pair_and_connect("not an address", "123456").is_err());
    }

    #[test]
    fn handle_validation() {
        assert!(valid_handle("192.168.1.5:5555"));
        assert!(valid_handle("A1B2C3"));
        assert!(!valid_handle("x; rm -rf /"));
        assert!(!valid_handle(""));
    }
}
