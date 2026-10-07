//! This computer's list of phones it has paired with over Wi-Fi: `~/.android/adb_known_hosts.pb`,
//! written by adb when pairing. The adb server reconnects to these by itself whenever they show up
//! on the network. Format (adb's own proto): `AdbKnownHosts { repeated HostInfo host_infos = 1; }`,
//! `HostInfo { string guid = 1; }`, where guid is the phone's `adb-<SERIAL>-<random>` service name.
//! Removing a phone's entries is the computer half of unpairing; the phone keeps its own list.

use std::path::{Path, PathBuf};

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let (mut v, mut shift) = (0u64, 0);
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        v |= ((c & 0x7f) as u64) << shift;
        if c < 0x80 {
            return Some(v);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Each top-level entry as (raw bytes of the whole field, guid if it has one). Raw bytes are kept so
/// that rewriting the file never drops anything we do not understand.
fn entries(b: &[u8]) -> Option<Vec<(Vec<u8>, Option<String>)>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let key = varint(b, &mut i)?;
        let len = match key & 7 {
            2 => varint(b, &mut i)? as usize,
            0 => { varint(b, &mut i)?; 0 }
            _ => return None,
        };
        let body = b.get(i..i + len)?;
        i += len;
        let mut guid = None;
        if key >> 3 == 1 && key & 7 == 2 {
            let mut j = 0;
            while j < body.len() {
                let k = varint(body, &mut j)?;
                if k & 7 != 2 { return None; }
                let l = varint(body, &mut j)? as usize;
                let v = body.get(j..j + l)?;
                j += l;
                if k >> 3 == 1 { guid = Some(String::from_utf8_lossy(v).into_owned()); }
            }
        }
        out.push((b[start..i].to_vec(), guid));
    }
    Some(out)
}

/// The phone service names in the file, in order (duplicates kept).
pub fn guids(b: &[u8]) -> Vec<String> {
    entries(b).unwrap_or_default().into_iter().filter_map(|(_, g)| g).collect()
}

/// A guid belongs to the phone with this serial: `adb-<serial>-<random>`.
pub fn guid_is_serial(guid: &str, serial: &str) -> bool {
    !serial.is_empty()
        && guid.strip_prefix("adb-").and_then(|r| r.strip_prefix(serial)).map(|r| r.starts_with('-') && !r[1..].contains('-')).unwrap_or(false)
}

/// The file without the phone's entries, and how many were removed. None if the file is not in the
/// expected format (then nothing is touched).
pub fn without_serial(b: &[u8], serial: &str) -> Option<(Vec<u8>, usize)> {
    let mut out = Vec::with_capacity(b.len());
    let mut removed = 0;
    for (raw, guid) in entries(b)? {
        if guid.as_deref().map(|g| guid_is_serial(g, serial)).unwrap_or(false) {
            removed += 1;
        } else {
            out.extend_from_slice(&raw);
        }
    }
    Some((out, removed))
}

/// Where adb keeps the file: $ANDROID_USER_HOME, else $ANDROID_SDK_HOME/.android, else ~/.android.
pub fn path() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("ANDROID_USER_HOME") {
        return Some(PathBuf::from(d).join("adb_known_hosts.pb"));
    }
    if let Some(d) = std::env::var_os("ANDROID_SDK_HOME") {
        return Some(PathBuf::from(d).join(".android").join("adb_known_hosts.pb"));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".android").join("adb_known_hosts.pb"))
}

/// Removes the phone from the file at `p` (written via a temp file, so a crash never leaves it
/// half-written). Returns how many entries went.
pub fn remove_serial_at(p: &Path, serial: &str) -> Result<usize, String> {
    let b = match std::fs::read(p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("can't read {}: {e}", p.display())),
    };
    let (nb, n) = without_serial(&b, serial).ok_or("the list of paired phones is in an unexpected format; left untouched")?;
    if n > 0 {
        let tmp = p.with_extension("pb.tmp");
        std::fs::write(&tmp, &nb).map_err(|e| format!("can't write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, p).map_err(|e| format!("can't update {}: {e}", p.display()))?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(guid: &str) -> Vec<u8> {
        let mut inner = vec![0x0a, guid.len() as u8];
        inner.extend_from_slice(guid.as_bytes());
        let mut e = vec![0x0a, inner.len() as u8];
        e.extend(inner);
        e
    }
    fn file(gs: &[&str]) -> Vec<u8> { gs.iter().flat_map(|g| entry(g)).collect() }

    #[test]
    fn reads_guids() {
        let f = file(&["adb-18121FDF60022T-0RshFc", "adb-AT070AA2600030-qS7GN1"]);
        assert_eq!(guids(&f), vec!["adb-18121FDF60022T-0RshFc", "adb-AT070AA2600030-qS7GN1"]);
    }

    #[test]
    fn removes_every_entry_of_one_phone_only() {
        let f = file(&["adb-18121FDF60022T-0RshFc", "adb-AT070AA2600030-qS7GN1", "adb-18121FDF60022T-fbnpOu", "adb-18121FDF60022T-fbnpOu"]);
        let (nb, n) = without_serial(&f, "18121FDF60022T").unwrap();
        assert_eq!(n, 3);
        assert_eq!(guids(&nb), vec!["adb-AT070AA2600030-qS7GN1"]);
        // the remaining bytes are exactly the untouched entry
        assert_eq!(nb, entry("adb-AT070AA2600030-qS7GN1"));
    }

    #[test]
    fn a_serial_that_is_a_prefix_of_another_is_not_confused() {
        // AT070AA2600030 must not remove AT070AA26000301 (a longer serial)
        let f = file(&["adb-AT070AA26000301-aaaaaa", "adb-AT070AA2600030-bbbbbb"]);
        let (nb, n) = without_serial(&f, "AT070AA2600030").unwrap();
        assert_eq!(n, 1);
        assert_eq!(guids(&nb), vec!["adb-AT070AA26000301-aaaaaa"]);
        assert!(!guid_is_serial("adb-AT070AA2600030-x-y", "AT070AA2600030"));
        assert!(!guid_is_serial("adb-x", ""));
    }

    #[test]
    fn unknown_format_is_left_alone() {
        assert!(without_serial(&[0x0b, 0x01], "X").is_none());          // wire type 3: not ours
        assert!(without_serial(&[0x0a, 0x10, 0x0a], "X").is_none());    // truncated
        assert_eq!(without_serial(&[], "X"), Some((vec![], 0)));        // empty file is fine
    }

    #[test]
    fn writes_the_file_in_place() {
        let dir = std::env::temp_dir().join(format!("kh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("adb_known_hosts.pb");
        std::fs::write(&p, file(&["adb-AAA111-xxxxxx", "adb-BBB222-yyyyyy"])).unwrap();
        assert_eq!(remove_serial_at(&p, "AAA111").unwrap(), 1);
        assert_eq!(guids(&std::fs::read(&p).unwrap()), vec!["adb-BBB222-yyyyyy"]);
        assert_eq!(remove_serial_at(&p, "AAA111").unwrap(), 0);          // nothing left to remove
        assert_eq!(remove_serial_at(&dir.join("missing.pb"), "AAA111").unwrap(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
