use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub struct Adb {
    pub bin: PathBuf,
}

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
            .map(|bin| Adb { bin })
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

    /// Runs adb with the given args; returns stdout. Errors carry stderr.
    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        let out = self.cmd().args(args).output().map_err(|e| format!("cannot run adb: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if out.status.success() {
            Ok(stdout)
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("{}{}", stdout.trim(), err.trim()).trim().to_string())
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
        let a = Adb { bin: PathBuf::from("/nonexistent/adb") };
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
    fn handle_validation() {
        assert!(valid_handle("192.168.1.5:5555"));
        assert!(valid_handle("A1B2C3"));
        assert!(!valid_handle("x; rm -rf /"));
        assert!(!valid_handle(""));
    }
}
