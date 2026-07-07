use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use actix_web::{
    Error, HttpResponse, Responder,
    body::{BoxBody, MessageBody},
    delete, get,
    dev::{ServiceRequest, ServiceResponse},
    http::header,
    middleware::Next,
    post,
    web::{Data, Json},
};
use data_encoding::BASE32_NOPAD;
use log::{error, info, warn};
use openssl::rand::rand_bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use totp_rs::{Algorithm, TOTP};

/// Sessions last 90 days.
const SESSION_DURATION_MS: u64 = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand_bytes(&mut buf).expect("openssl rand failed");
    hex::encode(buf)
}

/// Generate a 160-bit TOTP secret encoded as RFC 4648 base32 (no padding).
fn generate_totp_secret() -> String {
    let mut bytes = [0u8; 20];
    rand_bytes(&mut bytes).expect("openssl rand failed");
    BASE32_NOPAD.encode(&bytes)
}

/// Build an `otpauth://totp/` URI that any TOTP authenticator app accepts.
fn totp_uri(secret_base32: &str) -> String {
    format!(
        "otpauth://totp/Moonlight%20Web?secret={secret_base32}&issuer=Moonlight+Web&algorithm=SHA1&digits=6&period=30"
    )
}

/// Compare secrets without leaking their length or a matching prefix through
/// timing: hashing first makes the `memcmp` input length fixed.
fn constant_time_str_eq(a: &str, b: &str) -> bool {
    let a = openssl::sha::sha256(a.as_bytes());
    let b = openssl::sha::sha256(b.as_bytes());
    openssl::memcmp::eq(&a, &b)
}

/// Verify a 6-digit TOTP code. Allows ±1 step (±30 s) to tolerate clock skew.
fn verify_totp_code(secret_base32: &str, code: &str) -> bool {
    let upper = secret_base32.to_ascii_uppercase();
    let bytes = match BASE32_NOPAD.decode(upper.as_bytes()) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let totp = match TOTP::new(Algorithm::SHA1, 6, 1, 30, bytes) {
        Ok(t) => t,
        Err(_) => return false,
    };
    totp.check_current(code).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct PersistedSessions {
    sessions: HashMap<String, u64>, // token → expires_at_ms
}

fn sessions_path(config_path: &str) -> String {
    std::path::Path::new(config_path)
        .parent()
        .map(|p| p.join("sessions.json").to_string_lossy().into_owned())
        .unwrap_or_else(|| "sessions.json".to_owned())
}

async fn load_sessions_from_file(path: &str) -> HashMap<String, u64> {
    let now = now_ms();
    match tokio::fs::read_to_string(path).await {
        Ok(content) => serde_json::from_str::<PersistedSessions>(&content)
            .map(|s| s.sessions.into_iter().filter(|(_, exp)| *exp > now).collect())
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

async fn save_sessions_to_file(path: &str, sessions: &HashMap<String, u64>) {
    let stored = PersistedSessions { sessions: sessions.clone() };
    if let Ok(json) = serde_json::to_string_pretty(&stored) {
        let _ = tokio::fs::write(path, json).await;
    }
}

// ---------------------------------------------------------------------------
// ApiCredentials
// ---------------------------------------------------------------------------

pub struct ApiCredentials {
    credentials: Option<String>,
    /// Active TOTP secret (base32). `None` = 2FA disabled.
    totp_secret: RwLock<Option<String>>,
    /// Active sessions: token → expires_at_ms.
    sessions: Mutex<HashMap<String, u64>>,
    /// Pending TOTP secret awaiting user confirmation during setup.
    pending_totp: Mutex<Option<String>>,
    /// Path to config.json so TOTP changes can be persisted.
    config_path: String,
}

impl ApiCredentials {
    pub fn new(
        credentials: Option<String>,
        totp_secret: Option<String>,
        config_path: String,
    ) -> Self {
        Self {
            credentials,
            totp_secret: RwLock::new(totp_secret),
            sessions: Mutex::new(HashMap::new()),
            pending_totp: Mutex::new(None),
            config_path,
        }
    }

    /// Load persisted sessions from disk on startup.
    pub async fn load_sessions(&self) {
        let path = sessions_path(&self.config_path);
        let loaded = load_sessions_from_file(&path).await;
        let count = loaded.len();
        *self.sessions.lock().await = loaded;
        if count > 0 {
            info!("[Auth] Loaded {count} active session(s) from disk");
        }
    }

    async fn persist_sessions(&self) {
        let path = sessions_path(&self.config_path);
        let sessions = self.sessions.lock().await;
        save_sessions_to_file(&path, &sessions).await;
    }

    pub async fn create_session(&self) -> (String, u64) {
        let token = generate_token();
        let expires_at = now_ms() + SESSION_DURATION_MS;
        {
            let now = now_ms();
            let mut sessions = self.sessions.lock().await;
            sessions.retain(|_, exp| *exp > now); // prune expired
            sessions.insert(token.clone(), expires_at);
        }
        self.persist_sessions().await;
        (token, expires_at)
    }

    pub async fn validate_session(&self, token: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.get(token).is_some_and(|&exp| exp > now_ms())
    }

    pub fn enable_credential_authentication(&self) -> bool {
        self.credentials.is_some()
    }

    pub fn authenticate_with_credentials(&self, provided: Option<&str>) -> bool {
        match &self.credentials {
            None => true,
            Some(expected) => match provided {
                Some(provided) => constant_time_str_eq(provided, expected),
                None => false,
            },
        }
    }

    pub async fn is_totp_enabled(&self) -> bool {
        self.totp_secret.read().await.is_some()
    }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

pub async fn auth_middleware(
    req: ServiceRequest,
    next: Next<BoxBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let path = req.uri().path();

    // Public paths: stream websocket, login, and auth-info
    if path == "/api/host/stream"
        || path == "/api/auth/login"
        || path == "/api/auth/info"
    {
        return next.call(req).await;
    }

    let Some(creds_data) = req.app_data::<Data<ApiCredentials>>() else {
        error!("[Auth] ApiCredentials missing from app data");
        return Ok(req.into_response(HttpResponse::InternalServerError().finish()));
    };

    let creds = creds_data.as_ref();

    if !creds.enable_credential_authentication() {
        return next.call(req).await;
    }

    let bearer = req
        .head()
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);

    let Some(token) = bearer else {
        return Ok(req.into_response(HttpResponse::Unauthorized().finish()));
    };

    // Valid long-lived session token?
    if creds.validate_session(&token).await {
        return next.call(req).await;
    }

    // Fallback: raw password, but only when 2FA is NOT enabled (backward compat).
    if !creds.is_totp_enabled().await && creds.authenticate_with_credentials(Some(&token)) {
        return next.call(req).await;
    }

    Ok(req.into_response(HttpResponse::Unauthorized().finish()))
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
    pub totp_code: Option<String>,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub session_token: String,
    pub expires_at_ms: u64,
}

#[derive(Serialize)]
pub struct RequiresTotpResponse {
    pub requires_totp: bool,
}

#[derive(Serialize)]
pub struct AuthInfoResponse {
    pub totp_enabled: bool,
    pub credential_authentication_enabled: bool,
}

#[derive(Serialize)]
pub struct TotpSetupResponse {
    pub secret: String,
    pub uri: String,
}

#[derive(Deserialize)]
pub struct TotpEnableRequest {
    pub code: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/auth/login  (public)
///
/// Step 1: `{ password }` → `{ session_token, expires_at_ms }` if no 2FA
///                        → `{ requires_totp: true }` if 2FA enabled
/// Step 2: `{ password, totp_code }` → `{ session_token, expires_at_ms }` or 401
#[post("/auth/login")]
pub async fn post_auth_login(
    credentials: Data<ApiCredentials>,
    body: Json<LoginRequest>,
) -> HttpResponse {
    if !credentials.enable_credential_authentication() {
        let (token, expires_at_ms) = credentials.create_session().await;
        return HttpResponse::Ok().json(SessionResponse { session_token: token, expires_at_ms });
    }

    if !credentials.authenticate_with_credentials(Some(&body.password)) {
        warn!("[Auth] Login failed: wrong password");
        return HttpResponse::Unauthorized().finish();
    }

    let totp_secret = credentials.totp_secret.read().await.clone();
    if let Some(secret) = totp_secret {
        match &body.totp_code {
            None => {
                return HttpResponse::Ok().json(RequiresTotpResponse { requires_totp: true });
            }
            Some(code) => {
                if !verify_totp_code(&secret, code) {
                    warn!("[Auth] Login failed: invalid TOTP code");
                    return HttpResponse::Unauthorized().finish();
                }
            }
        }
    }

    let (token, expires_at_ms) = credentials.create_session().await;
    info!("[Auth] New session created (expires in 90 days)");
    HttpResponse::Ok().json(SessionResponse { session_token: token, expires_at_ms })
}

/// GET /api/auth/info  (public)
#[get("/auth/info")]
pub async fn get_auth_info(credentials: Data<ApiCredentials>) -> impl Responder {
    HttpResponse::Ok().json(AuthInfoResponse {
        totp_enabled: credentials.is_totp_enabled().await,
        credential_authentication_enabled: credentials.enable_credential_authentication(),
    })
}

/// GET /api/auth/totp/setup  (authenticated)
///
/// Generates (and holds in memory) a new TOTP secret.
/// Not saved until the user confirms with POST /api/auth/totp/enable.
#[get("/auth/totp/setup")]
pub async fn get_totp_setup(credentials: Data<ApiCredentials>) -> impl Responder {
    let secret = generate_totp_secret();
    let uri = totp_uri(&secret);
    *credentials.pending_totp.lock().await = Some(secret.clone());
    HttpResponse::Ok().json(TotpSetupResponse { secret, uri })
}

/// POST /api/auth/totp/enable  (authenticated)
#[post("/auth/totp/enable")]
pub async fn post_totp_enable(
    credentials: Data<ApiCredentials>,
    body: Json<TotpEnableRequest>,
) -> HttpResponse {
    let pending = credentials.pending_totp.lock().await.clone();
    let Some(pending_secret) = pending else {
        return HttpResponse::BadRequest()
            .body("No pending 2FA setup — call GET /api/auth/totp/setup first");
    };

    if !verify_totp_code(&pending_secret, &body.code) {
        warn!("[Auth] 2FA enable failed: invalid verification code");
        return HttpResponse::BadRequest().body("Invalid verification code");
    }

    if let Err(e) = save_totp_to_config(&credentials.config_path, Some(&pending_secret)).await {
        error!("[Auth] Failed to save TOTP secret to config: {e:?}");
        return HttpResponse::InternalServerError().finish();
    }

    *credentials.totp_secret.write().await = Some(pending_secret);
    *credentials.pending_totp.lock().await = None;

    info!("[Auth] Two-factor authentication enabled");
    HttpResponse::Ok().finish()
}

/// DELETE /api/auth/totp  (authenticated)
#[delete("/auth/totp")]
pub async fn delete_totp(credentials: Data<ApiCredentials>) -> HttpResponse {
    if let Err(e) = save_totp_to_config(&credentials.config_path, None).await {
        error!("[Auth] Failed to remove TOTP secret from config: {e:?}");
        return HttpResponse::InternalServerError().finish();
    }

    *credentials.totp_secret.write().await = None;
    *credentials.pending_totp.lock().await = None;

    info!("[Auth] Two-factor authentication disabled");
    HttpResponse::Ok().finish()
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async fn save_totp_to_config(
    config_path: &str,
    totp_secret: Option<&str>,
) -> Result<(), anyhow::Error> {
    let content = tokio::fs::read_to_string(config_path).await?;
    let mut json: serde_json::Value = serde_json::from_str(&content)?;

    if let Some(secret) = totp_secret {
        json["totp_secret"] = serde_json::Value::String(secret.to_owned());
    } else if let Some(obj) = json.as_object_mut() {
        obj.remove("totp_secret");
    }

    tokio::fs::write(config_path, serde_json::to_string_pretty(&json)?).await?;
    Ok(())
}
