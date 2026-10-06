//! Read-only check against whatever adb sees: `cargo run -p enroll-core --example probe`
//! Prints each probe step with its timing, to spot a command that hangs on a device.
use enroll_core::adb::Adb;
use std::time::Instant;

fn timed<T: std::fmt::Debug>(label: &str, f: impl FnOnce() -> T) {
    let t = Instant::now();
    let r = f();
    println!("  {label:<10} {:>6} ms  {r:?}", t.elapsed().as_millis());
}

fn main() {
    let adb = Adb::find(None).expect("adb not found").quick();
    println!("adb: {}", adb.bin.display());
    for d in adb.devices().expect("adb devices") {
        println!("{d:?}");
        if d.state == "device" {
            timed("details", || adb.details(&d.handle));
            timed("owner", || adb.owner(&d.handle));
            timed("accounts", || adb.account_count(&d.handle));
            timed("firmware", || adb.firmware(&d.handle));
            if !d.handle.contains(':') && !d.handle.contains("._adb-tls-") {
                timed("wifi ip", || adb.device_ip(&d.handle)); // read-only; to_wifi itself is not run here
            }
        }
    }
}
