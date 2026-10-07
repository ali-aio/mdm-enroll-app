use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_SERVER: &str = "https://mdm.dev.aioapp.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub server: String,
    pub token: String,
    pub username: String,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Status {
    #[serde(default)]
    pub enrolled: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub agent_version: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    /// Username of the account that enrolled it through the enroll app ("" if unknown).
    #[serde(default)]
    pub enrolled_by: String,
    /// That account's display name ("First Last"), or the username when it has none.
    #[serde(default)]
    pub enrolled_by_name: String,
    /// Checking in now (the server's own "online" window). `None` from a server too old to say.
    #[serde(default)]
    pub online: Option<bool>,
    #[serde(default)]
    pub battery_pct: i64,
    /// false = mains powered (kiosk, KDS, POS…), so `battery_pct` means nothing.
    #[serde(default)]
    pub has_battery: bool,
    /// The restaurant it is placed in ("" = onboarding inbox / bench).
    #[serde(default)]
    pub restaurant: String,
}

impl Status {
    /// The MDM knows this device and has not retired or wiped it. Firmware devices register
    /// themselves with status `auto` (not `enrolled`), so `enrolled` alone misses them.
    /// A serial the server has never seen comes back with an empty status.
    pub fn known(&self) -> bool {
        !self.status.is_empty() && self.status != "retired" && self.status != "wiped"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub has_avatar: bool,
}

/// How the server sees a nearby phone's serial: fleet | production | family | lookalike | other.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct SerialClass {
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub production: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub family_count: u32,
    #[serde(default)]
    pub device_class: String,
    /// Fleet devices: what the phone is ("AIO T7"), from what it reports to the MDM.
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct EnrollToken {
    pub token: String,
    pub server_url: String,
}

/// A place a device can be enrolled straight into (the "Goes to" picker).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Restaurant {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub device_count: i64,
}

/// The DPC agent build the server hosts.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct AgentInfo {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub version_code: i64,
}

/// Why a call failed; `Unauthorized` means the stored session is dead and the app
/// should go back to the sign-in screen.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    Other(String),
}

impl ApiError {
    pub fn message(&self) -> &str {
        match self {
            ApiError::Unauthorized(m) | ApiError::Other(m) => m,
        }
    }
}

pub fn normalize_server(s: &str) -> Result<String, String> {
    let s = s.trim().trim_end_matches('/');
    let s = if s.is_empty() { DEFAULT_SERVER } else { s };
    if s.starts_with("https://") || s.starts_with("http://localhost") || s.starts_with("http://127.0.0.1") {
        Ok(s.to_string())
    } else {
        Err("server must be an https:// address".into())
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .build()
}

fn map_err(e: ureq::Error) -> ApiError {
    match e {
        ureq::Error::Status(code, resp) => {
            let body: serde_json::Value = resp.into_json().unwrap_or_default();
            let msg = body["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {code}"));
            if code == 401 {
                ApiError::Unauthorized(msg)
            } else if code == 404 {
                ApiError::Other("This server doesn't support the Enroll app yet. Check the Server address.".into())
            } else {
                ApiError::Other(msg)
            }
        }
        other => ApiError::Other(format!("cannot reach server: {other}")),
    }
}

pub fn login(server: &str, username: &str, password: &str) -> Result<Session, ApiError> {
    let server = normalize_server(server).map_err(ApiError::Other)?;
    let v: serde_json::Value = agent()
        .post(&format!("{server}/api/v1/app/login"))
        .send_json(serde_json::json!({"username": username, "password": password}))
        .map_err(|e| match e {
            // A wrong password is a sign-in failure, not "session expired".
            ureq::Error::Status(401, r) => {
                let b: serde_json::Value = r.into_json().unwrap_or_default();
                ApiError::Other(b["error"].as_str().unwrap_or("invalid credentials").to_string())
            }
            other => map_err(other),
        })?
        .into_json()
        .map_err(|e| ApiError::Other(e.to_string()))?;
    Ok(Session {
        server,
        token: v["token"].as_str().unwrap_or_default().to_string(),
        username: v["username"].as_str().unwrap_or(username).to_string(),
        role: v["role"].as_str().unwrap_or_default().to_string(),
    })
}

impl Session {
    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub fn logout(&self) {
        let _ = agent()
            .post(&format!("{}/api/v1/app/logout", self.server))
            .set("Authorization", &self.auth())
            .call();
    }

    /// Enrollment state for up to 100 serials; unknown serials come back not enrolled.
    pub fn statuses(&self, serials: &[String]) -> Result<HashMap<String, Status>, ApiError> {
        if serials.is_empty() {
            return Ok(HashMap::new());
        }
        let v: serde_json::Value = agent()
            .get(&format!("{}/api/v1/app/enroll-status", self.server))
            .set("Authorization", &self.auth())
            .query("serials", &serials.join(","))
            .call()
            .map_err(map_err)?
            .into_json()
            .map_err(|e| ApiError::Other(e.to_string()))?;
        serde_json::from_value(v["devices"].clone()).map_err(|e| ApiError::Other(e.to_string()))
    }

    /// The signed-in user's display name; `None` fields when the server has no data.
    pub fn profile(&self) -> Result<Profile, ApiError> {
        agent()
            .get(&format!("{}/api/v1/app/me", self.server))
            .set("Authorization", &self.auth())
            .call()
            .map_err(map_err)?
            .into_json()
            .map_err(|e| ApiError::Other(e.to_string()))
    }

    /// Profile picture PNG, or `None` when the user has none (or the server is older).
    pub fn avatar(&self) -> Option<Vec<u8>> {
        use std::io::Read;
        let resp = agent()
            .get(&format!("{}/api/v1/app/avatar", self.server))
            .set("Authorization", &self.auth())
            .call()
            .ok()?;
        let mut buf = Vec::new();
        resp.into_reader().take(2 << 20).read_to_end(&mut buf).ok()?;
        (buf.len() > 8 && buf.starts_with(&[0x89, b'P', b'N', b'G'])).then_some(buf)
    }

    /// Which of these serials are "ours" (see [`SerialClass`]). Up to 100 per call.
    pub fn classify(&self, serials: &[String]) -> Result<HashMap<String, SerialClass>, ApiError> {
        if serials.is_empty() {
            return Ok(HashMap::new());
        }
        let v: serde_json::Value = agent()
            .post(&format!("{}/api/v1/app/classify", self.server))
            .set("Authorization", &self.auth())
            .send_json(serde_json::json!({ "serials": serials }))
            .map_err(map_err)?
            .into_json()
            .map_err(|e| ApiError::Other(e.to_string()))?;
        serde_json::from_value(v["serials"].clone()).map_err(|e| ApiError::Other(e.to_string()))
    }

    /// `restaurant_id` "" = no restaurant (the device waits in the onboarding inbox).
    pub fn enroll_token(&self, class: &str, restaurant_id: &str) -> Result<EnrollToken, ApiError> {
        let mut body = serde_json::json!({ "device_class": class });
        if !restaurant_id.is_empty() {
            body["restaurant_id"] = restaurant_id.into();
        }
        agent()
            .post(&format!("{}/api/v1/app/enroll-token", self.server))
            .set("Authorization", &self.auth())
            .send_json(body)
            .map_err(map_err)?
            .into_json()
            .map_err(|e| ApiError::Other(e.to_string()))
    }

    pub fn restaurants(&self) -> Result<Vec<Restaurant>, ApiError> {
        let v: serde_json::Value = agent()
            .get(&format!("{}/api/v1/app/restaurants", self.server))
            .set("Authorization", &self.auth())
            .call()
            .map_err(map_err)?
            .into_json()
            .map_err(|e| ApiError::Other(e.to_string()))?;
        serde_json::from_value(v["restaurants"].clone()).map_err(|e| ApiError::Other(e.to_string()))
    }

    /// The agent build the server hosts; `None` when it hosts none (or the server is older).
    pub fn agent_info(&self) -> Option<AgentInfo> {
        agent()
            .get(&format!("{}/api/v1/app/agent", self.server))
            .set("Authorization", &self.auth())
            .call()
            .ok()?
            .into_json()
            .ok()
    }

    /// Downloads the agent APK (public on the server) to `dest`, via a temp file so a
    /// half download is never mistaken for a good one.
    pub fn download_apk(&self, dest: &Path) -> Result<(), String> {
        let resp = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .timeout(Duration::from_secs(180))
            .build()
            .get(&format!("{}/agent/aio-mdm-dpc.apk", self.server))
            .call()
            .map_err(|e| format!("APK download failed: {e}"))?;
        let tmp = dest.with_extension("part");
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut r = resp.into_reader();
        let n = std::io::copy(&mut r, &mut f).map_err(|e| format!("APK download failed: {e}"))?;
        f.flush().map_err(|e| e.to_string())?;
        if n < 100_000 {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("APK download too small ({n} bytes)"));
        }
        std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmware_devices_registered_as_auto_are_known() {
        let by: Status = serde_json::from_str(r#"{"enrolled":true,"status":"enrolled","enrolled_by":"shahrukh","enrolled_by_name":"Shahrukh Bashir"}"#).unwrap();
        assert_eq!(by.enrolled_by_name, "Shahrukh Bashir");
        let old: Status = serde_json::from_str(r#"{"enrolled":true,"status":"enrolled"}"#).unwrap();
        assert_eq!(old.enrolled_by_name, ""); // an older server sends no such field
        let auto: Status = serde_json::from_str(r#"{"enrolled":false,"status":"auto","class":"t7","last_seen_at":"2026-10-06T10:00:00Z"}"#).unwrap();
        assert!(auto.known() && !auto.enrolled);
        let live: Status = serde_json::from_str(r#"{"enrolled":true,"status":"enrolled","online":true,"battery_pct":0,"has_battery":false,"restaurant":"Burger Hub"}"#).unwrap();
        assert!(live.online == Some(true) && !live.has_battery && live.restaurant == "Burger Hub");
        let unseen: Status = serde_json::from_str(r#"{"enrolled":false}"#).unwrap();
        assert!(unseen.online.is_none()); // older server: unknown, not "offline"
        assert!(!unseen.known());
        let gone: Status = serde_json::from_str(r#"{"enrolled":false,"status":"retired"}"#).unwrap();
        assert!(!gone.known());
    }

    #[test]
    fn parses_the_classify_answer() {
        let v: serde_json::Value = serde_json::from_str(r#"{"serials":{
            "AT070AA2600030":{"class":"fleet","device_class":"t7","name":"AIO T7"},
            "AT070AABU00875":{"class":"production","production":"T7 batch BU","model":"07"},
            "DK19248T41099":{"class":"family","family":"SUNMI D2s_KDS_STGL","family_count":3,"device_class":"kds"},
            "18121FDF60022T":{"class":"other"}}}"#).unwrap();
        let m: HashMap<String, SerialClass> = serde_json::from_value(v["serials"].clone()).unwrap();
        assert_eq!(m["AT070AA2600030"].class, "fleet");
        assert_eq!(m["AT070AA2600030"].name, "AIO T7");
        assert_eq!(m["AT070AABU00875"].production, "T7 batch BU");
        assert_eq!(m["DK19248T41099"].device_class, "kds");
        assert_eq!(m["DK19248T41099"].family_count, 3);
        assert_eq!(m["18121FDF60022T"], SerialClass { class: "other".into(), ..Default::default() });
    }

    #[test]
    fn parses_restaurants_and_agent() {
        let v: serde_json::Value = serde_json::from_str(r#"{"restaurants":[{"id":"6f1c","name":"Burger Hub · Gulberg","address":"Lahore","device_count":4},{"id":"77aa","name":"Chai Point"}]}"#).unwrap();
        let r: Vec<Restaurant> = serde_json::from_value(v["restaurants"].clone()).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].address, "Lahore");
        assert_eq!(r[1].address, "");
        let a: AgentInfo = serde_json::from_str(r#"{"version":"0.2.8","version_code":208,"url":"x","sha256":"y"}"#).unwrap();
        assert_eq!((a.version.as_str(), a.version_code), ("0.2.8", 208));
    }

    #[test]
    fn server_urls() {
        assert_eq!(normalize_server("").unwrap(), DEFAULT_SERVER);
        assert_eq!(normalize_server("https://x.com/ ").unwrap(), "https://x.com");
        assert!(normalize_server("http://evil.com").is_err());
        assert!(normalize_server("http://localhost:8080").is_ok());
    }
}
