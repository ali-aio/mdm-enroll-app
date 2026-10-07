//! Read-only: lists this computer's paired phones. `cargo run -p enroll-core --example paired`
fn main() {
    let p = enroll_core::known_hosts::path().expect("no home directory");
    let b = std::fs::read(&p).unwrap_or_default();
    let g = enroll_core::known_hosts::guids(&b);
    println!("{} ({} entries)", p.display(), g.len());
    for x in g { println!("  {x}"); }
}
