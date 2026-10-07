//! Read-only: what the app's network discovery returns (after fixing pairing addresses).
//! `cargo run -p enroll-core --example discover`
fn main() {
    let adb = enroll_core::adb::Adb::find(None).expect("adb not found").quick();
    for s in adb.mdns_services() { println!("{:<9} {:<24} {}", s.kind, s.addr, s.name); }
}
