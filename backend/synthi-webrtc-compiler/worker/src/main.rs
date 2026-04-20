#![allow(unused_imports)]
#![allow(unused_variables)]

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::env;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::Arc;

use worker::android;
use worker::compiler;
use worker::hmr;
use worker::infra;
use worker::runtime;
use worker::safety;
use worker::debug_log;
use worker::webrtc::{
    broadcast_build_log_text, PeerHandle, PeerRegistry, PeerRole, DEFAULT_BROWSER_PEER_ID,
};

use anyhow::{Context, Result};
use bytes::Bytes;
use futures::{FutureExt, SinkExt, StreamExt};

/*
use compiler::builder::{
    hash_content,
    hash_shared_header_semantic,
    ModuleHashes,
    RebuildScope,
    WidgetCompiler,
    WidgetDetector,
};

use runtime::capability::{detect_capabilities, HmrCapability, HmrStatus};

use compiler::error_parser::{parse_compiler_output, CompilerType, DiagnosticEvent};
*/

use hmr::fast_refresh::{
    BoundaryChecker,
    // BoundaryViolationEvent, // unused
    // RefreshAction, // unused
    // PreemptiveConfig, PreemptiveMessage, SpeculativeCache // These seem to be in watcher.rs?
};

use infra::observability::{
    LogEntry,
    LogFormat,
    LogLevel,
    MetricsAggregator,
    // ReloadMetricsTracker, // unused
    // ReloadId, // unused
    StructuredLogger,
};

use safety::hardened_ipc::IpcConfig;
use safety::quiescence::QuiescenceConfig;
use safety::restart_control::{BackoffConfig, KnownGoodStore, RestartController};
use safety::slot_isolation::{IsolationManager, IsolationModel};

use infra::watcher::{PreemptiveConfig, PreemptiveMessage, SpeculativeCache};

// use runtime::shim::{auto_shim, ShimMode, detect_shim_mode};

use gstreamer as gst;
use gstreamer::prelude::ElementExt;
#[allow(unused_imports)]
use hmr::incremental_cache::{compile_with_cache, link_objects, IncrementalCache};
// use gstreamer::prelude::{Cast, GstBinExt, GstObjectExt};
// use gstreamer_app as gst_app;

use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::interceptor::registry::Registry;
// use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
// use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTCRtpHeaderExtensionCapability, RTPCodecType,
};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
// use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
// use webrtc::track::track_local::TrackLocal;
// use webrtc::track::track_local::TrackLocalWriter;
// use webrtc::util::Unmarshal;
use serde::{Deserialize, Serialize};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::util::Unmarshal;

// use printer::compile_context::CompileContext; // Legacy path
use compiler::context::CompileContext;
use hmr::orchestrator::{HmrOrchestrator, OrchestratorConfig};
use infra::constants::{/*GUI_TOOLS,*/ REQUIRED_TOOLS};
use infra::lsp_util::{rewrite_uris, LspSessionState};
use infra::messages::{CompileRequest, /*FileEntry,*/ IceServerEnv, SignalMessage};
use infra::utils::{get_wsl_host_ip, make_chunks};
use runtime::runner_state::RunnerState;

use worker::compiler::builder;
use worker::infra::server;
use worker::infra::storage;
use worker::infra::watcher;
use worker::safety::security;

// Re-use the debug_log! macro and verbose flag from the library crate.
use worker::verbose_enabled;

// ── TURN credential fetch (Option B: worker → collab-server) ──────────────
/// Response shape from collab-server /turn-credentials.
#[derive(Debug, Deserialize)]
struct TurnCredentialResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceServerEnv>,
}

/// Fetches short-lived TURN credentials from the collab-server's internal
/// endpoint. Falls back to a plain STUN entry if the request fails or the
/// env var is not configured.
async fn fetch_turn_credentials() -> Vec<webrtc::ice_transport::ice_server::RTCIceServer> {
    let collab_url = match env::var("COLLAB_SERVER_URL") {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(_) => {
            debug_log!("[ICE] COLLAB_SERVER_URL not set — using default STUN");
            return vec![webrtc::ice_transport::ice_server::RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                ..Default::default()
            }];
        }
    };

    let url = format!("{}/turn-credentials", collab_url);
    match reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<TurnCredentialResponse>().await {
                Ok(data) => {
                    let mut servers = Vec::new();
                    for srv in data.ice_servers {
                        let mut server = webrtc::ice_transport::ice_server::RTCIceServer {
                            urls: srv.urls,
                            ..Default::default()
                        };

                        if let Some(username) = srv.username {
                            server.username = username;
                        }

                        if let Some(credential) = srv.credential {
                            if !credential.is_empty() {
                                server.credential = credential;
                                server.credential_type = webrtc::ice_transport::ice_credential_type::RTCIceCredentialType::Password;
                            }
                        }

                        servers.push(server);
                    }
                    if servers.is_empty() {
                        servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                            urls: vec!["stun:stun.l.google.com:19302".to_string()],
                            ..Default::default()
                        });
                    }
                    debug_log!("[ICE] Fetched {} ICE server(s) from collab-server", servers.len());
                    servers
                }
                Err(e) => {
                    eprintln!("[ICE] Failed to parse TURN response: {} — using default STUN", e);
                    vec![webrtc::ice_transport::ice_server::RTCIceServer {
                        urls: vec!["stun:stun.l.google.com:19302".to_string()],
                        ..Default::default()
                    }]
                }
            }
        }
        Ok(resp) => {
            debug_log!("[ICE] TURN endpoint returned {} — using default STUN", resp.status());
            vec![webrtc::ice_transport::ice_server::RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                ..Default::default()
            }]
        }
        Err(e) => {
            eprintln!("[ICE] TURN credential fetch error: {} — using default STUN", e);
            vec![webrtc::ice_transport::ice_server::RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                ..Default::default()
            }]
        }
    }
}

// Removed: `const GUI_TOOLS = &["Xvfb", "matchbox-window-manager"]` — the
// runner now handles input via stdin, no external GUI tooling needed.

/// Convert JavaScript `ev.key` names to SDL2 keycodes (SDLK_*)
/// The runner's `input key down/up <keycode>` protocol expects integer SDL keycodes.
fn js_key_to_sdl_keycode(key: &str) -> i32 {
    match key {
        // ASCII-compatible keys
        " " => 32,  // SDLK_SPACE
        "!" => 33, "\"" => 34, "#" => 35, "$" => 36, "%" => 37, "&" => 38,
        "'" => 39, "(" => 40, ")" => 41, "*" => 42, "+" => 43, "," => 44,
        "-" => 45, "." => 46, "/" => 47,
        "0" => 48, "1" => 49, "2" => 50, "3" => 51, "4" => 52,
        "5" => 53, "6" => 54, "7" => 55, "8" => 56, "9" => 57,
        ":" => 58, ";" => 59, "<" => 60, "=" => 61, ">" => 62, "?" => 63, "@" => 64,
        "[" => 91, "\\" => 92, "]" => 93, "^" => 94, "_" => 95, "`" => 96,
        // Navigation / editing keys
        "Enter" | "Return" => 13,   // SDLK_RETURN
        "Escape" => 27,             // SDLK_ESCAPE
        "Backspace" => 8,           // SDLK_BACKSPACE
        "Tab" => 9,                 // SDLK_TAB
        "Delete" => 127,            // SDLK_DELETE
        "Insert" => 0x40000049_u32 as i32,
        "Home" => 0x4000004A_u32 as i32,
        "End" => 0x4000004D_u32 as i32,
        "PageUp" => 0x4000004B_u32 as i32,
        "PageDown" => 0x4000004E_u32 as i32,
        // Arrow keys
        "ArrowRight" => 0x4000004F_u32 as i32,
        "ArrowLeft" => 0x40000050_u32 as i32,
        "ArrowDown" => 0x40000051_u32 as i32,
        "ArrowUp" => 0x40000052_u32 as i32,
        // Function keys
        "F1" => 0x4000003A_u32 as i32,
        "F2" => 0x4000003B_u32 as i32,
        "F3" => 0x4000003C_u32 as i32,
        "F4" => 0x4000003D_u32 as i32,
        "F5" => 0x4000003E_u32 as i32,
        "F6" => 0x4000003F_u32 as i32,
        "F7" => 0x40000040_u32 as i32,
        "F8" => 0x40000041_u32 as i32,
        "F9" => 0x40000042_u32 as i32,
        "F10" => 0x40000043_u32 as i32,
        "F11" => 0x40000044_u32 as i32,
        "F12" => 0x40000045_u32 as i32,
        // Modifier keys
        "Shift" | "ShiftLeft" | "ShiftRight" => 0x400000E1_u32 as i32,
        "Control" | "ControlLeft" | "ControlRight" => 0x400000E0_u32 as i32,
        "Alt" | "AltLeft" | "AltRight" => 0x400000E2_u32 as i32,
        "Meta" | "MetaLeft" | "MetaRight" => 0x400000E3_u32 as i32,
        "CapsLock" => 0x40000039_u32 as i32,
        "NumLock" => 0x40000053_u32 as i32,
        "ScrollLock" => 0x40000047_u32 as i32,
        // Single character — use lowercase ASCII value as SDL keycode
        other => {
            let lower = other.to_lowercase();
            let mut chars = lower.chars();
            if let Some(c) = chars.next() {
                if chars.next().is_none() && c.is_ascii() {
                    return c as i32;
                }
            }
            0 // Unknown key
        }
    }
}

/// Request to cancel a running mobile emulator job
#[derive(Debug, Deserialize)]
struct CancelMobileJobRequest {
    #[serde(rename = "type")]
    msg_type: String, // Should be "cancel-mobile-job"
    session_id: String,
}

/// Request to cancel a running build (all targets)
#[derive(Debug, Deserialize)]
struct CancelBuildRequest {
    #[serde(rename = "type")]
    msg_type: String, // Should be "cancel-build"
    #[serde(default)]
    session_id: Option<String>,
}

fn get_signaling_url() -> String {
    if let Ok(url) = std::env::var("SIGNALING_URL") {
        return url;
    }

    // In most setups, the signaling server runs alongside the worker (in WSL)
    // or is accessible via localhost forwarding.
    // We ONLY default to Host IP for the AI Backend which we know runs on Windows.
    "ws://localhost:9000".to_string()
}

fn extract_fingerprint(sdp: &str) -> Option<String> {
    for line in sdp.lines() {
        if let Some(rest) = line.strip_prefix("a=fingerprint:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Send data on a DataChannel with SCTP backpressure.
/// Waits for `buffered_amount()` to drop below the threshold before sending,
/// and retries on transient errors instead of breaking the forwarding loop.
const DC_BUFFER_THRESHOLD: usize = 256 * 1024; // 256 KB
const DC_BACKPRESSURE_POLL_MS: u64 = 10;
const DC_SEND_MAX_RETRIES: u32 = 5;

async fn dc_send_with_backpressure(
    dc: &Arc<RTCDataChannel>,
    data: &Bytes,
    label: &str,
) -> anyhow::Result<()> {
    // Wait for the SCTP send buffer to drain below the threshold
    let mut waited = 0u32;
    while dc.buffered_amount().await > DC_BUFFER_THRESHOLD {
        tokio::time::sleep(std::time::Duration::from_millis(DC_BACKPRESSURE_POLL_MS)).await;
        waited += 1;
        if waited % 100 == 0 {
            debug_log!(
                "[{}] backpressure: waited {}ms for DC buffer to drain (buffered={})",
                label,
                waited as u64 * DC_BACKPRESSURE_POLL_MS,
                dc.buffered_amount().await
            );
        }
        // Safety valve: after 10s of waiting, give up
        if waited > 1000 {
            debug_log!(
                "[{}] backpressure timeout after 10s, attempting send anyway",
                label
            );
            break;
        }
    }

    // Retry send on transient errors
    let mut retries = 0u32;
    loop {
        match dc.send(data).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                retries += 1;
                if retries > DC_SEND_MAX_RETRIES {
                    debug_log!(
                        "[{}] send failed after {} retries: {}",
                        label, DC_SEND_MAX_RETRIES, e
                    );
                    return Err(anyhow::anyhow!("{}", e));
                }
                debug_log!(
                    "[{}] send error (retry {}/{}): {}",
                    label, retries, DC_SEND_MAX_RETRIES, e
                );
                // Exponential backoff: 20ms, 40ms, 80ms, 160ms, 320ms
                tokio::time::sleep(std::time::Duration::from_millis(20 * (1 << (retries - 1))))
                    .await;
            }
        }
    }
}

async fn dc_send_text_with_backpressure(
    dc: &Arc<RTCDataChannel>,
    text: String,
    label: &str,
) -> anyhow::Result<()> {
    // Wait for buffer to drain
    let mut waited = 0u32;
    while dc.buffered_amount().await > DC_BUFFER_THRESHOLD {
        tokio::time::sleep(std::time::Duration::from_millis(DC_BACKPRESSURE_POLL_MS)).await;
        waited += 1;
        if waited > 1000 {
            debug_log!(
                "[{}] backpressure timeout after 10s, attempting send_text anyway",
                label
            );
            break;
        }
    }

    let mut retries = 0u32;
    loop {
        match dc.send_text(text.clone()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                retries += 1;
                if retries > DC_SEND_MAX_RETRIES {
                    debug_log!(
                        "[{}] send_text failed after {} retries: {}",
                        label, DC_SEND_MAX_RETRIES, e
                    );
                    return Err(anyhow::anyhow!("{}", e));
                }
                debug_log!(
                    "[{}] send_text error (retry {}/{}): {}",
                    label, retries, DC_SEND_MAX_RETRIES, e
                );
                tokio::time::sleep(std::time::Duration::from_millis(20 * (1 << (retries - 1))))
                    .await;
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    debug_log!("=== WORKER BUILD 2026-02-06-LSP-DEBUG ===");
    debug_log!("[Worker] Starting up (PID: {})", std::process::id());
    debug_log!("Worker starting...");
    debug_log!("Operating System: {}", std::env::consts::OS);

    // v2.1: Print security audit at startup (requirement #9)
    if std::env::var("SYNTHI_SECURITY_AUDIT")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        security::print_security_audit();
    } else {
        // Brief security notice
        let audit = security::audit_security();
        debug_log!("[Security] Status: {} enforced, {} partial, {} stub (set SYNTHI_SECURITY_AUDIT=1 for details)",
            audit.enforced_count, audit.partial_count, audit.stub_count);
    }

    // ============================================================
    // v2.1 HMR INFRASTRUCTURE INITIALIZATION (Requirements #1-10)
    // ============================================================
    // Initialize all HMR hardening infrastructure from dead code modules:
    // - StructuredLogger for observability (#10)
    // - IsolationManager for worker isolation (#7)
    // - RestartController for backoff/fallback (#8)
    // - IpcConfig for hardened communication (#4)
    // - HmrOrchestrator for central coordination
    // ============================================================

    // Initialize structured logging (requirement #10)
    let hmr_log_format = if std::env::var("SYNTHI_JSON_LOGS")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        LogFormat::Json
    } else {
        LogFormat::Human
    };
    let hmr_log_level = match std::env::var("SYNTHI_LOG_LEVEL")
        .unwrap_or_default()
        .as_str()
    {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };
    let structured_logger = Arc::new(StructuredLogger::new(hmr_log_format, hmr_log_level));

    // Initialize metrics aggregator for reload performance tracking
    let metrics_aggregator = Arc::new(tokio::sync::Mutex::new(MetricsAggregator::new()));

    // Log startup
    structured_logger.log(
        &LogEntry::new(
            LogLevel::Info,
            "main",
            "Worker starting with HMR v2.1 hardening",
        )
        .with_field("os", std::env::consts::OS)
        .with_field("log_format", format!("{:?}", hmr_log_format)),
    );

    // Initialize isolation manager (requirement #7)
    let isolation_model = match std::env::var("SYNTHI_ISOLATION_MODEL")
        .unwrap_or_default()
        .as_str()
    {
        "worker_per_slot" => IsolationModel::WorkerPerSlot,
        "grouped" => IsolationModel::GroupedWorkers,
        _ => IsolationModel::SingleWorker, // Default: simpler, lower overhead
    };
    let isolation_manager = Arc::new(tokio::sync::Mutex::new(IsolationManager::new(
        isolation_model,
    )));
    debug_log!("[HMR v2.1] Isolation model: {:?}", isolation_model);

    // Initialize restart controller with backoff (requirement #8)
    let known_good_dir = std::env::temp_dir().join("synthi_known_good");
    let _ = std::fs::create_dir_all(&known_good_dir);
    let known_good_store = KnownGoodStore::with_persistence(known_good_dir.join("known_good.json"));
    let backoff_config = BackoffConfig::default();
    let restart_controller = Arc::new(tokio::sync::Mutex::new(RestartController::new(
        backoff_config,
        known_good_store,
    )));
    debug_log!("[HMR v2.1] Restart controller initialized with backoff/fallback");

    // Initialize hardened IPC config (requirement #4)
    let ipc_config = Arc::new(IpcConfig::default());
    debug_log!(
        "[HMR v2.1] IPC config: max_frame_size={}MB, read_timeout={}s",
        ipc_config.max_frame_size / (1024 * 1024),
        ipc_config.read_timeout.as_secs()
    );

    // Initialize HMR orchestrator (central coordination)
    let orchestrator_config = OrchestratorConfig {
        prefer_binary_state: true,
        max_snapshots: 10,
        max_consecutive_crashes: 3,
        task_shutdown_timeout: std::time::Duration::from_secs(5),
        strict_abi: std::env::var("SYNTHI_STRICT_ABI")
            .map(|v| v == "1")
            .unwrap_or(false),
        max_boundaries_per_module: 20,
    };
    let hmr_orchestrator = Arc::new(tokio::sync::Mutex::new(HmrOrchestrator::with_config(
        orchestrator_config,
    )));
    debug_log!(
        "[HMR v2.1] Orchestrator initialized (binary_state={}, strict_abi={})",
        true,
        std::env::var("SYNTHI_STRICT_ABI")
            .map(|v| v == "1")
            .unwrap_or(false)
    );

    // Initialize quiescence config (requirement #6)
    let _quiescence_config = QuiescenceConfig::default();
    debug_log!("[HMR v2.1] Quiescence protocol ready");

    structured_logger.log(&LogEntry::new(
        LogLevel::Info,
        "main",
        "HMR v2.1 infrastructure initialized",
    ));

    // ============================================================
    // END v2.1 INFRASTRUCTURE
    // ============================================================

    // Cargo does not source shell rc files, so ensure Android SDK tools are visible
    // to this process deterministically before any SDK checks or emulator logic.
    android::ensure_android_sdk_env();
    android::log_android_env_diagnostics("startup");

    debug_log!("=== WORKER ENV DIAGNOSTIC (post-bootstrap) ===");
    debug_log!(
        "CARGO_MANIFEST_DIR = {:?}",
        std::env::var("CARGO_MANIFEST_DIR")
    );
    debug_log!("HOME = {:?}", std::env::var("HOME"));
    debug_log!("PATH = {:?}", std::env::var("PATH"));
    debug_log!("ANDROID_SDK_ROOT = {:?}", std::env::var("ANDROID_SDK_ROOT"));
    debug_log!("ANDROID_HOME = {:?}", std::env::var("ANDROID_HOME"));
    debug_log!("===========================================");

    debug_log!("[Worker] Initializing GStreamer...");
    match gst::init() {
        Ok(_) => debug_log!("[Worker] GStreamer initialized successfully"),
        Err(e) => {
            eprintln!("[Worker] FATAL: GStreamer initialization failed: {}", e);
            // We want to return the error to fail specifically
            return Err(anyhow::anyhow!("GStreamer init failed: {}", e));
        }
    }

    debug_log!("[Worker] Verifying tooling...");
    verify_tooling().await?;
    let signaling_url = get_signaling_url();
    // SESSION_ID scopes this worker to a single browser peer in the
    // session-multiplexed signaling server.  Unset → "__legacy__" compat mode.
    let session_id = env::var("SESSION_ID").ok();
    debug_log!("Connecting to signaling server at: {}", signaling_url);
    if let Some(ref sid) = session_id {
        debug_log!("Session ID: {sid}");
    }
    let (ws_stream, _) = connect_async(&signaling_url).await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel::<SignalMessage>();

    ws_write
        .send(Message::text(serde_json::to_string(&SignalMessage {
            msg_type: "register".into(),
            role: Some("worker".into()),
            session_id: session_id.clone(),
            sdp: None,
            sdp_type: None,
            candidate: None,
            peer_id: None,
        })?))
        .await?;

    tokio::spawn(async move {
        while let Some(msg) = signal_rx.recv().await {
            if let Ok(text) = serde_json::to_string(&msg) {
                let _ = ws_write.send(Message::text(text)).await;
            }
        }
    });

    // Per-session peer registry. Each attached peer (browser + zero or
    // more observers) gets its own `PeerHandle` with its own PC, per-peer
    // video/audio tracks, and per-peer build-log DC. The `TrackFanout`
    // instances below broadcast GStreamer RTP to every peer's track
    // through an abort-on-drop subscription, so teardown is automatic
    // when a peer disconnects.
    let peer_registry: Arc<PeerRegistry> = Arc::new(PeerRegistry::new());
    let video_fanout = Arc::new(worker::webrtc::TrackFanout::new(
        worker::webrtc::TrackKind::Video,
        worker::webrtc::track_fanout::DEFAULT_CAPACITY,
    ));
    let audio_fanout = Arc::new(worker::webrtc::TrackFanout::new(
        worker::webrtc::TrackKind::Audio,
        worker::webrtc::track_fanout::DEFAULT_CAPACITY,
    ));
    // Store of sessionId -> stdin sender so datachannel 'terminal' messages can be
    // routed to the running process's stdin.
    let terminal_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Store of sessionId -> sdl input sender for persistent SDL input
    let sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Store for persistent runner process
    let runner_store: Arc<Mutex<Option<RunnerState>>> = Arc::new(Mutex::new(None));
    // Store for currently running compile task (any target)
    let compile_task_store: Arc<Mutex<Option<(String, tokio::task::JoinHandle<()>)>>> =
        Arc::new(Mutex::new(None));
    // Simple in-memory cache for tracking compiled lib paths (legacy, used alongside IncrementalCache)
    let compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // VS Code Server Manager: holds kill sender
    // for the vscode-server-manager.js process.
    let vscode_server_kill_tx: Arc<
        Mutex<Option<(mpsc::UnboundedSender<()>, tokio::time::Instant)>>,
    > = Arc::new(Mutex::new(None));

    // Content-addressable incremental compilation cache (persists across sessions)
    // Uses /dev/shm on Linux for fast RAM-based caching
    let cache_dir = if cfg!(target_os = "linux") {
        std::path::PathBuf::from("/dev/shm/synthi_compile_cache")
    } else {
        std::env::temp_dir().join("synthi_compile_cache")
    };
    let incremental_cache = Arc::new(
        IncrementalCache::new(cache_dir)
            .await
            .expect("Failed to initialize incremental compile cache"),
    );
    debug_log!("[Cache] Initialized content-addressable compile cache");

    // Speculative compilation cache for preemptive builds
    let speculative_cache: Arc<Mutex<SpeculativeCache>> =
        Arc::new(Mutex::new(SpeculativeCache::new(32)));

    // Fast Refresh boundary checker (per-session)
    let boundary_checker: Arc<Mutex<BoundaryChecker>> =
        Arc::new(Mutex::new(BoundaryChecker::new()));

    // Create a persistent workspace directory for the session
    let workspace_dir = Arc::new(tempdir()?);
    let workspace_path = workspace_dir.path().to_owned();
    // Unconditional operator log: the user needs to know where compile
    // artifacts (including .synthi_split_meta.json with the architecture
    // cache) are actually written. `tempfile::tempdir()` picks a random
    // path under the system temp dir, and without this line the user has
    // no way to find the sidecar on disk to verify the cache.
    eprintln!("[WORKER] workspace tempdir: {}", workspace_path.display());
    let workspace_path_for_watcher = workspace_path.clone();
    let workspace_path_for_builder = workspace_path.clone();
    let workspace_path_arc = Arc::new(workspace_path);

    // --- Build System Initialization ---
    let (update_tx, _) = tokio::sync::broadcast::channel(16);
    let (preemptive_tx, preemptive_rx) = std::sync::mpsc::channel::<PreemptiveMessage>();

    // Start Preemptive Watcher (replaces standard watcher for speculative compilation)
    let preemptive_config = PreemptiveConfig {
        enabled: true,
        speculative_delay_ms: 150, // Start speculative compile 150ms after keystroke pause
        commit_delay_ms: 300,      // Commit final result 300ms after last change
        max_speculative_count: 5,  // Max speculative compiles before forcing commit
    };
    let (_watcher, cancel_flag) = watcher::setup_preemptive_watcher(
        &workspace_path_for_watcher,
        preemptive_tx,
        preemptive_config,
    )
    .context("Failed to setup preemptive watcher")?;

    // Start Build Loop
    let build_update_tx = update_tx.clone();

    let mut build_session = builder::BuildSession::new(workspace_path_for_builder);
    let session_hash = build_session.session_hash.clone();

    // Speculative cache for build loop
    let _build_speculative_cache = speculative_cache.clone();
    let build_cancel_flag = cancel_flag.clone();

    // Start WebSocket Server
    let server_update_rx = update_tx.subscribe();
    let server_hash = session_hash.clone();
    tokio::spawn(async move {
        server::start_server("0.0.0.0:8001".to_string(), server_update_rx, server_hash).await;
    });

    // Forward updates to DataChannel
    let mut dc_rx = update_tx.subscribe();
    let dc_registry = peer_registry.clone();
    tokio::spawn(async move {
        while let Ok(msg) = dc_rx.recv().await {
            // Fan out to every peer's build-log DC. With exactly one
            // peer (current pre-multi-PC reality) this is the same
            // wire as the legacy `log_channel_store` read; with N
            // peers it broadcasts. Per-DC 50ms timeout ensures a
            // wedged peer cannot throttle the rest.
            let _ = broadcast_build_log_text(&dc_registry, msg).await;
        }
    });

    // Build Loop Task with Preemptive/Speculative Compilation
    tokio::task::spawn_blocking(move || {
        use std::sync::atomic::Ordering;
        use std::time::Instant;

        loop {
            // `recv()` blocks until a message arrives or the sender is dropped.
            // The old `if let Ok(..)` here silently swallowed `Disconnected`
            // and spun the loop at 100% CPU once the watcher thread exited,
            // so the worker looked "alive but deaf" instead of surfacing the
            // problem. Exit cleanly instead — the watcher owning the sender
            // is tied to main()'s scope anyway.
            let message = match preemptive_rx.recv() {
                Ok(m) => m,
                Err(_) => {
                    eprintln!("[Build] preemptive channel closed — exiting build loop");
                    break;
                }
            };
            match message {
                PreemptiveMessage::StartSpeculative {
                    paths,
                    scope,
                    timestamp: _timestamp,
                } => {
                    debug_log!(
                        "[Build] Starting speculative compile for scope '{}': {:?}",
                        scope, paths
                    );

                    // Check cancellation flag periodically during compile
                    if build_cancel_flag.load(Ordering::SeqCst) {
                        debug_log!("[Build] Speculative compile cancelled before start");
                        continue;
                    }

                    // Perform speculative compilation
                    let start = Instant::now();
                    for path_str in &paths {
                        let path = std::path::Path::new(&path_str);
                        let relative_path =
                            if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                rel.to_string_lossy().to_string()
                            } else {
                                path_str.clone()
                            };

                        // Check for cancellation between files
                        if build_cancel_flag.load(Ordering::SeqCst) {
                            debug_log!(
                                "[Build] Speculative compile cancelled during compilation"
                            );
                            break;
                        }

                        // Do incremental compile but don't send update yet
                        if let Some(_payload) =
                            build_session.incremental_compile(vec![relative_path.clone()])
                        {
                            // Cache the speculative result
                            let _content_hash = {
                                let mut hasher =
                                    std::collections::hash_map::DefaultHasher::new();
                                relative_path.hash(&mut hasher);
                                hasher.finish()
                            };

                            // Store in speculative cache (blocking mutex)
                            // Note: In production, use a lock-free structure
                            debug_log!(
                                "[Build] Speculative compile complete in {}ms, cached",
                                start.elapsed().as_millis()
                            );
                        }
                    }
                }

                PreemptiveMessage::CancelSpeculative { reason } => {
                    debug_log!("[Build] Speculative compile cancelled: {}", reason);
                    // Cancel flag is already set by watcher
                }

                PreemptiveMessage::CommitSpeculative { paths, scope } => {
                    debug_log!(
                        "[Build] Committing speculative compile for scope '{}': {:?}",
                        scope, paths
                    );

                    // Send the cached result to frontend
                    let msg = serde_json::json!({
                        "type": "update",
                        "data": {
                            "hash": build_session.session_hash,
                            "scope": scope,
                            "speculative": true,
                            "message": format!("Speculative compile committed for {:?}", paths)
                        }
                    });
                    if let Ok(json) = serde_json::to_string(&msg) {
                        let _ = build_update_tx.send(json);
                    }
                }

                PreemptiveMessage::Changed { scope, paths } => {
                    // Standard (non-speculative) change - compile immediately
                    debug_log!(
                        "[Build] Standard compile for scope '{}': {:?}",
                        scope, paths
                    );

                    for path_str in paths {
                        let path = std::path::Path::new(&path_str);
                        let relative_path =
                            if let Ok(rel) = path.strip_prefix(&build_session.workspace_root) {
                                rel.to_string_lossy().to_string()
                            } else {
                                path_str
                            };

                        if let Some(payload) =
                            build_session.incremental_compile(vec![relative_path])
                        {
                            // Wrap with type="update" and include hash
                            let msg = serde_json::json!({
                                "type": "update",
                                "data": {
                                    "hash": build_session.session_hash,
                                    "manifest": payload.manifest,
                                    "modules": payload.modules
                                }
                            });
                            if let Ok(json) = serde_json::to_string(&msg) {
                                let _ = build_update_tx.send(json);
                            }
                        }
                    }
                }
            }
        }
    });
    // -----------------------------------

    // PCs are created lazily on the first offer from each peer; the
    // signal loop below handles get-or-create, wire_peer_channels, and
    // teardown on reset.
    while let Some(msg) = ws_read.next().await {
        let msg = msg?;
        if !msg.is_text() {
            continue;
        }
        let parsed: SignalMessage = match serde_json::from_str(&msg.into_text()?) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // peer_id stamped by the signaling-server on every forwarded SDP/ICE
        // message from a non-worker peer. Empty for legacy clients that
        // don't yet carry the field — we fall back to role-fanout routing.
        let incoming_peer_id = parsed.peer_id.clone();

        // Resolve which peer this message routes to. The signaling-server
        // stamps `peer_id` + `role` on every forwarded non-worker message
        // (see `rewrite_peer_fields` there). Legacy clients that omit
        // `peer_id` fall back to DEFAULT_BROWSER_PEER_ID so the pre-
        // Phase-B Synthi frontend keeps working byte-identical.
        let peer_id = parsed
            .peer_id
            .clone()
            .unwrap_or_else(|| DEFAULT_BROWSER_PEER_ID.to_string());
        let role_for_new_peer = parsed
            .role
            .as_deref()
            .map(PeerRole::from_wire)
            .unwrap_or(PeerRole::Browser);

        match parsed.msg_type.as_str() {
            "offer" => {
                // A single peer's handshake failure must not take down the
                // worker — this loop owns the filesystem watcher + build
                // thread via locals whose Drop fires when main returns, so
                // bubbling `?` here silently stops speculative compilation
                // for every other peer too. Scope the `?` to this handshake
                // and log on failure instead.
                let sdp_opt = parsed.sdp.clone();
                let sdp_type_opt = parsed.sdp_type.clone();
                let peer_id_h = peer_id.clone();
                let registry_h = peer_registry.clone();
                let signal_tx_h = signal_tx.clone();
                let workspace_path_arc_h = workspace_path_arc.clone();
                let terminal_input_store_h = terminal_input_store.clone();
                let sdl_input_store_h = sdl_input_store.clone();
                let runner_store_h = runner_store.clone();
                let compile_task_store_h = compile_task_store.clone();
                let compile_cache_h = compile_cache.clone();
                let boundary_checker_h = boundary_checker.clone();
                let incremental_cache_h = incremental_cache.clone();
                let hmr_orchestrator_h = hmr_orchestrator.clone();
                let structured_logger_h = structured_logger.clone();
                let metrics_aggregator_h = metrics_aggregator.clone();
                let restart_controller_h = restart_controller.clone();
                let ipc_config_h = ipc_config.clone();
                let vscode_server_kill_tx_h = vscode_server_kill_tx.clone();
                let video_fanout_h = video_fanout.clone();
                let audio_fanout_h = audio_fanout.clone();
                let role_h = role_for_new_peer;
                let handshake: anyhow::Result<()> = async move {
                    if let Some(sdp) = sdp_opt {
                        let sdp_type = match sdp_type_opt.as_deref().unwrap_or("offer") {
                            "offer" => RTCSdpType::Offer,
                            "answer" => RTCSdpType::Answer,
                            "pranswer" => RTCSdpType::Pranswer,
                            "rollback" => RTCSdpType::Rollback,
                            _ => RTCSdpType::Offer,
                        };

                        // Get-or-create a PC for this peer. A fresh peer (not
                        // yet in the registry) gets a new PC + per-peer tracks
                        // subscribed to the session fanouts, and then we wire
                        // the data channels. An existing peer re-offering (ICE
                        // restart) reuses its PC + DCs — just process the SDP.
                        let pc = if let Some(existing) = registry_h.get(&peer_id_h) {
                            existing.pc.clone()
                        } else {
                            let ice_servers = fetch_turn_credentials().await;
                            let new_pc = create_peer(
                                peer_id_h.clone(),
                                role_h,
                                signal_tx_h.clone(),
                                ice_servers,
                                registry_h.clone(),
                                video_fanout_h.clone(),
                                audio_fanout_h.clone(),
                            )
                            .await?;
                            wire_peer_channels(
                                &new_pc,
                                peer_id_h.clone(),
                                registry_h.clone(),
                                terminal_input_store_h.clone(),
                                sdl_input_store_h.clone(),
                                runner_store_h.clone(),
                                compile_task_store_h.clone(),
                                workspace_path_arc_h.clone(),
                                compile_cache_h.clone(),
                                boundary_checker_h.clone(),
                                incremental_cache_h.clone(),
                                hmr_orchestrator_h.clone(),
                                structured_logger_h.clone(),
                                metrics_aggregator_h.clone(),
                                restart_controller_h.clone(),
                                ipc_config_h.clone(),
                                vscode_server_kill_tx_h.clone(),
                                video_fanout_h.clone(),
                                audio_fanout_h.clone(),
                            )
                            .await?;
                            new_pc
                        };

                        debug_log!(
                            "[WebRTC-signal] Offer from peer {} (role={:?}, type={:?}, state={:?})",
                            peer_id_h,
                            role_h,
                            sdp_type,
                            pc.signaling_state()
                        );
                        let mut desc = RTCSessionDescription::default();
                        desc.sdp_type = sdp_type;
                        desc.sdp = sdp;
                        pc.set_remote_description(desc).await?;
                        let answer = pc.create_answer(None).await?;
                        pc.set_local_description(answer.clone()).await?;
                        if answer.sdp.find("transport-wide-cc").is_none() {
                            eprintln!("[WebRTC-signal] WARNING: TWCC missing from Answer SDP!");
                        }
                        signal_tx_h.send(SignalMessage {
                            msg_type: "answer".into(),
                            role: None,
                            session_id: None,
                            sdp: Some(answer.sdp),
                            sdp_type: Some(answer.sdp_type.to_string()),
                            candidate: None,
                            peer_id: Some(peer_id_h.clone()),
                        })?;
                    }
                    Ok(())
                }
                .await;
                if let Err(e) = handshake {
                    eprintln!(
                        "[WebRTC-signal] Offer handshake failed for peer {} (role={:?}): {:?}",
                        peer_id, role_for_new_peer, e
                    );
                    // Drop the half-built handle so a retry offer can rebuild
                    // from scratch instead of reusing a PC in a broken state.
                    if let Some(stale) = peer_registry.remove(&peer_id) {
                        let stale_pc = stale.pc.clone();
                        tokio::spawn(async move {
                            let _ = stale_pc.close().await;
                        });
                    }
                }
            }
            "candidate" => {
                if let Some(c) = parsed.candidate {
                    if let Some(handle) = peer_registry.get(&peer_id) {
                        let _ = handle.pc.add_ice_candidate(c).await;
                    } else {
                        debug_log!(
                            "[WebRTC-signal] Dropped candidate for unknown peer {}",
                            peer_id
                        );
                    }
                }
            }
            "reset" => {
                debug_log!(
                    "[WebRTC-signal] Received reset command, closing all peers..."
                );

                // Close every registered PC. Dropping the handle also
                // drops its FanoutSubscriptions, aborting per-peer
                // dispatch tasks. New offers after reset will recreate
                // handles lazily.
                for peer in peer_registry.all_peers() {
                    let _ = peer.pc.close().await;
                }
                peer_registry.clear();

                // Clear runner state (terminates emulator / GStreamer pipeline).
                {
                    let mut guard = runner_store.lock().await;
                    if guard.is_some() {
                        debug_log!("[WebRTC-signal] Dropping old RunnerState...");
                        *guard = None;
                    }
                }
                {
                    let mut guard = terminal_input_store.lock().await;
                    guard.clear();
                }
                {
                    let mut guard = sdl_input_store.lock().await;
                    guard.clear();
                }
                // Kill any running VS Code Server manager process.
                {
                    let mut guard = vscode_server_kill_tx.lock().await;
                    if let Some((tx, _)) = guard.take() {
                        debug_log!(
                            "[WebRTC-signal] Killing vscode-server-manager process during reset..."
                        );
                        let _ = tx.send(());
                    }
                }
                debug_log!("[WebRTC-signal] Reset complete — awaiting next offer to re-spawn peers");
            }
            _ => {}
        }
    }

    Ok(())
}

/// Construct a per-peer `RTCPeerConnection`, insert a matching
/// `PeerHandle` into the registry (evicting the prior Browser slot if
/// needed), and subscribe this peer's video+audio tracks to the session
/// fanouts. Returns the freshly-built peer connection.
///
/// Callers (the signal-loop offer arm) process the SDP/ICE themselves;
/// this function owns everything "set up a PC that can be subscribed to
/// and unsubscribed from the session" — ICE callback stamps peer_id on
/// outgoing candidates, connection-state callback removes the peer
/// from the registry on Closed/Failed so the fanout dispatch task dies.
async fn create_peer(
    peer_id: String,
    role: worker::webrtc::PeerRole,
    signal_tx: mpsc::UnboundedSender<SignalMessage>,
    ice_servers: Vec<webrtc::ice_transport::ice_server::RTCIceServer>,
    peer_registry: Arc<PeerRegistry>,
    video_fanout: Arc<worker::webrtc::TrackFanout>,
    audio_fanout: Arc<worker::webrtc::TrackFanout>,
) -> Result<Arc<RTCPeerConnection>> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    // Manually register H265 as it might not be in default codecs
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H265".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "".to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    // Explicitly register H264 (Baseline) with transport-cc
    // This matches standard Android emulator / RN output (profile-level-id=42001f)
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
                        .to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 103, // Match common dynamic PT
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    // Explicitly register H264 with transport-cc (Constrained Baseline - 42e01f)
    let _ = m.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_owned(),
                rtcp_feedback: vec![RTCPFeedback {
                    typ: "transport-cc".to_owned(),
                    parameter: "".to_owned(),
                }],
            },
            payload_type: 102,
            ..Default::default()
        },
        RTPCodecType::Video,
    );

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;

    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    let pc = Arc::new(api.new_peer_connection(config).await?);

    // Add transceivers for video and audio so they are negotiated initially
    pc.add_transceiver_from_kind(
        RTPCodecType::Video,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Sendonly,
            send_encodings: vec![],
        }),
    )
    .await?;

    pc.add_transceiver_from_kind(
        RTPCodecType::Audio,
        Some(RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Sendonly,
            send_encodings: vec![],
        }),
    )
    .await?;

    // Per-peer video + audio tracks. Each PC's transceiver gets its own
    // `TrackLocalStaticRTP`; the session's `TrackFanout` then writes every
    // RTP packet to every peer's track through an abort-on-drop task.
    // Dropping the `PeerHandle` drops the `FanoutSubscription`, which
    // aborts the per-peer dispatch task — no writes-to-a-detached-track.
    let per_peer_video = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: "video/H264".to_owned(),
            // Constrained Baseline Level 3.1 — universally supported by
            // browsers. Must match what the GStreamer pipeline emits so
            // the browser decoder accepts the RTP stream unchanged.
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_owned(),
            ..Default::default()
        },
        "video".to_owned(),
        format!("synthi-peer-{peer_id}"),
    ));
    let per_peer_audio = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".to_owned(),
            ..Default::default()
        },
        "audio".to_owned(),
        format!("synthi-peer-{peer_id}"),
    ));
    {
        let transceivers = pc.get_transceivers().await;
        for t in transceivers {
            let kind = t.kind();
            if kind == RTPCodecType::Video {
                let sender = t.sender().await;
                if let Err(e) = sender
                    .replace_track(Some(
                        Arc::clone(&per_peer_video) as Arc<dyn TrackLocal + Send + Sync>
                    ))
                    .await
                {
                    eprintln!("[WebRTC] Failed to attach video track for {peer_id}: {:?}", e);
                }
            } else if kind == RTPCodecType::Audio {
                let sender = t.sender().await;
                if let Err(e) = sender
                    .replace_track(Some(
                        Arc::clone(&per_peer_audio) as Arc<dyn TrackLocal + Send + Sync>
                    ))
                    .await
                {
                    eprintln!("[WebRTC] Failed to attach audio track for {peer_id}: {:?}", e);
                }
            }
        }
    }

    // Insert (or evict-then-insert) the handle BEFORE wiring callbacks +
    // fanout subs so a peer-connection-state callback firing during
    // `subscribe_track` finds a handle to remove. The Browser slot
    // evicts; Observer/McpAgent coexist.
    let handle = PeerHandle::new(&peer_id, role, pc.clone());
    let insert_outcome = peer_registry.insert(handle);
    if let worker::webrtc::RegistryInsertOutcome::Evicted(evicted) = insert_outcome {
        debug_log!(
            "[WebRTC] Evicted prior Browser peer {} for fresh session",
            evicted.peer_id
        );
        let old_pc = evicted.pc.clone();
        // Close the evicted PC out-of-band — `evicted` itself drops when
        // this block ends, which aborts its fanout subs and severs
        // dispatch for the old peer.
        tokio::spawn(async move {
            let _ = old_pc.close().await;
        });
    }
    peer_registry.attach_video_track(&peer_id, per_peer_video.clone());
    peer_registry.attach_audio_track(&peer_id, per_peer_audio.clone());
    peer_registry.attach_video_sub(&peer_id, video_fanout.subscribe_track(per_peer_video));
    peer_registry.attach_audio_sub(&peer_id, audio_fanout.subscribe_track(per_peer_audio));

    {
        let tx = signal_tx.clone();
        let peer_id_for_ice = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |candidate| {
            let tx = tx.clone();
            let peer_id_for_ice = peer_id_for_ice.clone();
            async move {
                if let Some(c) = candidate {
                    if let Ok(init) = c.to_json() {
                        // Stamp this peer's peer_id on every outgoing
                        // candidate so the signaling-server direct-routes
                        // the reply back to the right socket.
                        let _ = tx.send(SignalMessage {
                            msg_type: "candidate".into(),
                            role: None,
                            session_id: None,
                            sdp: None,
                            sdp_type: None,
                            candidate: Some(init),
                            peer_id: Some(peer_id_for_ice.clone()),
                        });
                    }
                }
            }
            .boxed()
        }));
    }

    {
        let peer_id_for_state = peer_id.clone();
        let registry_for_state = peer_registry.clone();
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            let peer_id = peer_id_for_state.clone();
            let registry = registry_for_state.clone();
            async move {
                debug_log!("Peer Connection State ({}): {s:?}", peer_id);
                if matches!(
                    s,
                    RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed | RTCPeerConnectionState::Disconnected
                ) {
                    // Dropping the Arc<PeerHandle> drops the fanout
                    // subscription tasks, aborting dispatch to this peer's
                    // tracks. Safe to call even if the peer was already
                    // removed by a reset() sweep.
                    if registry.remove(&peer_id).is_some() {
                        debug_log!("[WebRTC] Removed peer {} on state {:?}", peer_id, s);
                    }
                }
            }
            .boxed()
        }));
    }

    Ok(pc)
}

async fn wire_peer_channels(
    pc: &Arc<RTCPeerConnection>,
    peer_id: String,
    peer_registry: Arc<PeerRegistry>,
    terminal_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    runner_store: Arc<Mutex<Option<RunnerState>>>,
    compile_task_store: Arc<Mutex<Option<(String, tokio::task::JoinHandle<()>)>>>,
    workspace_path_arc: Arc<std::path::PathBuf>,
    compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>>,
    boundary_checker: Arc<Mutex<BoundaryChecker>>,
    incremental_cache: Arc<IncrementalCache>,
    hmr_orchestrator: Arc<tokio::sync::Mutex<HmrOrchestrator>>,
    structured_logger: Arc<StructuredLogger>,
    metrics_aggregator: Arc<tokio::sync::Mutex<MetricsAggregator>>,
    restart_controller: Arc<tokio::sync::Mutex<RestartController>>,
    ipc_config: Arc<IpcConfig>,
    vscode_server_kill_tx: Arc<Mutex<Option<(mpsc::UnboundedSender<()>, tokio::time::Instant)>>>,
    video_fanout: Arc<worker::webrtc::TrackFanout>,
    audio_fanout: Arc<worker::webrtc::TrackFanout>,
) -> Result<()> {
    let pc = pc.clone();
    let build_log_dc = pc
        .create_data_channel("build-log", Some(RTCDataChannelInit::default()))
        .await?;
    let build_log_dc_for_open = build_log_dc.clone();
    let peer_registry_for_open = peer_registry.clone();
    let peer_id_for_open = peer_id.clone();
    build_log_dc.on_open(Box::new(move || {
        let dc = build_log_dc_for_open.clone();
        let registry = peer_registry_for_open.clone();
        let peer_id = peer_id_for_open.clone();
        async move {
            // Attach to the per-session registry so emission paths
            // (`broadcast_build_log_text` + per-peer compile-DC replies)
            // can fan out correctly.
            registry.attach_build_log(&peer_id, dc);
        }
        .boxed()
    }));

    let term_store = terminal_input_store.clone();
    let pc_clone = pc.clone();
    let workspace_path_for_callback = workspace_path_arc.clone();
    let runner_store_for_callback = runner_store.clone();
    let compile_task_store_for_callback = compile_task_store.clone();
    let compile_cache_for_callback = compile_cache.clone();
    let boundary_checker_for_callback = boundary_checker.clone();
    let incremental_cache_for_callback = incremental_cache.clone();
    // v2.1 HMR Infrastructure clones for callback
    let hmr_orchestrator_for_callback = hmr_orchestrator.clone();
    let structured_logger_for_callback = structured_logger.clone();
    let metrics_aggregator_for_callback = metrics_aggregator.clone();
    let restart_controller_for_callback = restart_controller.clone();
    let ipc_config_for_callback = ipc_config.clone();
    let sdl_input_store_for_callback = sdl_input_store.clone();
    let vscode_server_kill_tx_for_callback = vscode_server_kill_tx.clone();
    let peer_registry_for_callback = peer_registry.clone();
    let peer_id_for_callback = peer_id.clone();
    let video_fanout_for_callback = video_fanout.clone();
    let audio_fanout_for_callback = audio_fanout.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let term_store = term_store.clone();
        let pc_for_callback = pc_clone.clone();
        let workspace_path_for_dc = workspace_path_for_callback.clone();
        let sdl_store_outer = sdl_input_store_for_callback.clone();
        let runner_store_outer = runner_store_for_callback.clone();
        let compile_task_store_outer = compile_task_store_for_callback.clone();
        let compile_cache_outer = compile_cache_for_callback.clone();
        let boundary_checker_outer = boundary_checker_for_callback.clone();
        let incremental_cache_outer = incremental_cache_for_callback.clone();
        // v2.1 outer clones
        let hmr_orchestrator_outer = hmr_orchestrator_for_callback.clone();
        let structured_logger_outer = structured_logger_for_callback.clone();
        let metrics_aggregator_outer = metrics_aggregator_for_callback.clone();
        let restart_controller_outer = restart_controller_for_callback.clone();
        let ipc_config_outer = ipc_config_for_callback.clone();
        let vscode_server_kill_tx_outer = vscode_server_kill_tx_for_callback.clone();
        let peer_registry_outer = peer_registry_for_callback.clone();
        let peer_id_outer = peer_id_for_callback.clone();
        let video_fanout_outer = video_fanout_for_callback.clone();
        let audio_fanout_outer = audio_fanout_for_callback.clone();
        async move {
            let label = dc.label();
            debug_log!("[on_data_channel] Received data channel: label='{}', id={}", label, dc.id());
                if label == "compile" {
                    // Clone terminal store out of the FnMut closure into a local
                    // that can be moved into the async block below without
                    // consuming the captured `term_store`.
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        let pc_for_compile = pc_for_callback.clone();
                        let workspace_path_for_compile = workspace_path_for_dc.clone();
                        let sdl_store = sdl_store_outer.clone();
                        let runner_store = runner_store_outer.clone();
                        let runner_store_for_msg = runner_store_outer.clone();
                        let compile_cache = compile_cache_outer.clone();
                        let boundary_checker = boundary_checker_outer.clone();
                        let incremental_cache = incremental_cache_outer.clone();
                        let compile_task_store_for_msg = compile_task_store_outer.clone();
                        let peer_registry_for_msg = peer_registry_outer.clone();
                        let peer_id_for_msg = peer_id_outer.clone();
                        let video_fanout_for_msg = video_fanout_outer.clone();
                        let audio_fanout_for_msg = audio_fanout_outer.clone();
                        // v2.1 inner clones
                        let hmr_orchestrator = hmr_orchestrator_outer.clone();
                        let structured_logger = structured_logger_outer.clone();
                        let metrics_aggregator = metrics_aggregator_outer.clone();
                        let restart_controller = restart_controller_outer.clone();
                        let ipc_config = ipc_config_outer.clone();
                        async move {
                            if msg.is_string {
                                debug_log!("[Main] Received message on 'compile' channel. Length: {}", msg.data.len());
                                // Try to parse as a CancelBuildRequest first
                                if let Ok(cancel_req) = serde_json::from_slice::<CancelBuildRequest>(&msg.data) {
                                    if cancel_req.msg_type == "cancel-build" {
                                        let target_session = cancel_req.session_id.clone();
                                        debug_log!(
                                            "[Main] Received cancel-build for session: {:?}",
                                            target_session
                                        );

                                        // For mobile sessions, also mark cancellation
                                        if let Some(ref sid) = target_session {
                                            crate::android::webrtc::input::cancel_session(sid);
                                            crate::android::webrtc::input::unregister_session_sync(sid);
                                        }

                                        // Abort active compile task if it matches
                                        let mut task_guard = compile_task_store_for_msg.lock().await;
                                        let mut cancelled_session = target_session.clone();
                                        if let Some((current_id, handle)) = task_guard.take() {
                                            if target_session.as_ref().map_or(true, |sid| sid == &current_id) {
                                                handle.abort();
                                                if cancelled_session.is_none() {
                                                    cancelled_session = Some(current_id.clone());
                                                }
                                            } else {
                                                *task_guard = Some((current_id, handle));
                                            }
                                        }

                                        // Stop any running runner process/pipeline
                                        {
                                            let mut guard = runner_store_for_msg.lock().await;
                                            if let Some(state) = guard.take() {
                                                if let Some(mut child) = state.process {
                                                    let _ = child.kill().await;
                                                }
                                                if let Some(mut child) = state.xvfb_process {
                                                    let _ = child.kill().await;
                                                }
                                                if let Some(pipeline) = state.gst_pipeline {
                                                    let _ = pipeline.set_state(gst::State::Null);
                                                }
                                            }
                                        }

                                        // Notify frontend via every registered build-log
                                        // DC. With one peer, identical to the legacy path;
                                        // with N peers the cancel notice fans out.
                                        if let Some(sid) = cancelled_session {
                                            let payload = serde_json::json!({
                                                "type": "build-status",
                                                "status": "cancelled",
                                                "sessionId": sid,
                                                "message": "Build cancelled by user"
                                            });
                                            let (sent, _dropped) = broadcast_build_log_text(
                                                &peer_registry_for_msg,
                                                serde_json::to_string(&payload).unwrap_or_default(),
                                            ).await;
                                            if sent == 0 {
                                                debug_log!("[Main] Build cancelled by user (session {})", sid);
                                            }
                                        }
                                        return;
                                    }
                                }

                                // Try to parse as a CancelMobileJobRequest next
                                if let Ok(cancel_req) = serde_json::from_slice::<CancelMobileJobRequest>(&msg.data) {
                                    if cancel_req.msg_type == "cancel-mobile-job" {
                                        debug_log!("[Main] Received cancel-mobile-job for session: {}", cancel_req.session_id);
                                        // Mark the session as cancelled
                                        crate::android::webrtc::input::cancel_session(&cancel_req.session_id);
                                        // Also unregister the input session
                                        crate::android::webrtc::input::unregister_session_sync(&cancel_req.session_id);
                                        return;
                                    }
                                }
                                
                                // Try to parse as a CompileRequest
                                if let Ok(req) = serde_json::from_slice::<CompileRequest>(&msg.data) {
                                    debug_log!("[Main] Received CompileRequest: is_gui={}, use_ai_split={}, lang={}, target={:?}",
                                        req.is_gui, req.use_ai_split, req.language, req.target);
                                    // Reply path: use the REQUESTING peer's own build-log DC
                                    // so compile status lands only on that peer. Observers
                                    // on the same session see broadcast messages (hmr, build
                                    // cancel, run-gui-end) via `broadcast_build_log_text`,
                                    // but per-request replies stay scoped to the requester.
                                    let log_dc = peer_registry_for_msg
                                        .get(&peer_id_for_msg)
                                        .and_then(|h| h.build_log_dc_snapshot());
                                    if let Some(log) = log_dc {
                                        debug_log!("[Main] Found active build-log channel, proceeding with build...");
                                        // Check if this is a mobile emulator target
                                        if let Some(ref target) = req.target {
                                            if target == "react-native-emulator" {
                                                let session_id = req.session_id.clone().unwrap_or_else(|| {
                                                    format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000)
                                                });
                                                let project_root = req.project_root.clone();
                                                let slug = req.slug.clone();
                                                let log_clone = log.clone();
                                                let rn_video_fanout = video_fanout_for_msg.clone();
                                                tokio::spawn(async move {
                                                    // Download/sync the workspace if slug is provided.
                                                    // IMPORTANT: do NOT delete the workspace by default.
                                                    // Reusing /synthi/<slug> preserves node_modules, Gradle outputs, and other build artifacts,
                                                    // dramatically speeding up subsequent mobile builds.
                                                    // To force a clean slate, set SYNTHI_MOBILE_FORCE_REDOWNLOAD=1.
                                                    let workspace_path = if let Some(s) = &slug {
                                                        let local_dir = std::path::PathBuf::from("/synthi").join(s);
                                                        let force_redownload = std::env::var("SYNTHI_MOBILE_FORCE_REDOWNLOAD")
                                                            .ok()
                                                            .map(|v| {
                                                                let v = v.trim().to_ascii_lowercase();
                                                                matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
                                                            })
                                                            .unwrap_or(false);

                                                        if force_redownload && local_dir.exists() {
                                                            if let Err(e) = std::fs::remove_dir_all(&local_dir) {
                                                                debug_log!(
                                                                    "[Mobile] Failed to clear existing workspace {}: {}",
                                                                    local_dir.display(),
                                                                    e
                                                                );
                                                            } else {
                                                                debug_log!(
                                                                    "[Mobile] Cleared existing workspace {} (force redownload)",
                                                                    local_dir.display()
                                                                );
                                                            }
                                                        }

                                                        match storage::download(&s, None).await {
                                                            Ok(path) => {
                                                                debug_log!("[Mobile] Workspace ready at: {}", path.display());
                                                                path
                                                            },
                                                            Err(e) => {
                                                                eprintln!("[Mobile] Failed to download workspace: {}", e);
                                                                let payload = serde_json::json!({
                                                                    "sessionId": session_id,
                                                                    "type": "mobile-status",
                                                                    "status": "error",
                                                                    "message": format!("Failed to download workspace: {}", e),
                                                                });
                                                                let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                                return;
                                                            }
                                                        }
                                                    } else {
                                                        debug_log!("[Mobile] No slug provided, cannot download workspace");
                                                        let payload = serde_json::json!({
                                                            "sessionId": session_id,
                                                            "type": "mobile-status",
                                                            "status": "error",
                                                            "message": "No workspace slug provided for mobile build",
                                                        });
                                                        let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                        return;
                                                    };

                                                    if let Err(e) = worker::android::job::handle_react_native_emulator_job(
                                                        log_clone,
                                                        session_id.clone(),
                                                        workspace_path,
                                                        project_root,
                                                        false, // debug build by default
                                                        pc_for_compile.clone(),
                                                        rn_video_fanout.clone(),
                                                    ).await {
                                                        eprintln!("[Main] Mobile emulator job failed: {:?}", e);
                                                    }
                                                });
                                                return;
                                            }

                                            // Flutter Android emulator target
                                            if target == "flutter-android-emulator" {
                                                let session_id = req.session_id.clone().unwrap_or_else(|| {
                                                    format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000)
                                                });
                                                let project_root = req.project_root.clone();
                                                let slug = req.slug.clone();
                                                let log_clone = log.clone();
                                                let flutter_video_fanout = video_fanout_for_msg.clone();
                                                tokio::spawn(async move {
                                                    let workspace_path = if let Some(s) = &slug {
                                                        let local_dir = std::path::PathBuf::from("/synthi").join(s);
                                                        let force_redownload = std::env::var("SYNTHI_MOBILE_FORCE_REDOWNLOAD")
                                                            .ok()
                                                            .map(|v| {
                                                                let v = v.trim().to_ascii_lowercase();
                                                                matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
                                                            })
                                                            .unwrap_or(false);

                                                        if force_redownload && local_dir.exists() {
                                                            if let Err(e) = std::fs::remove_dir_all(&local_dir) {
                                                                debug_log!(
                                                                    "[Flutter] Failed to clear existing workspace {}: {}",
                                                                    local_dir.display(),
                                                                    e
                                                                );
                                                            }
                                                        }

                                                        match storage::download(&s, None).await {
                                                            Ok(path) => {
                                                                debug_log!("[Flutter] Workspace ready at: {}", path.display());
                                                                path
                                                            },
                                                            Err(e) => {
                                                                eprintln!("[Flutter] Failed to download workspace: {}", e);
                                                                let payload = serde_json::json!({
                                                                    "sessionId": session_id,
                                                                    "type": "mobile-status",
                                                                    "status": "error",
                                                                    "message": format!("Failed to download workspace: {}", e),
                                                                });
                                                                let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                                return;
                                                            }
                                                        }
                                                    } else {
                                                        debug_log!("[Flutter] No slug provided, cannot download workspace");
                                                        let payload = serde_json::json!({
                                                            "sessionId": session_id,
                                                            "type": "mobile-status",
                                                            "status": "error",
                                                            "message": "No workspace slug provided for Flutter build",
                                                        });
                                                        let _ = log_clone.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                                        return;
                                                    };

                                                    if let Err(e) = crate::android::job::handle_flutter_emulator_job(
                                                        log_clone,
                                                        session_id.clone(),
                                                        workspace_path,
                                                        project_root,
                                                        false, // debug build by default
                                                        pc_for_compile.clone(),
                                                        flutter_video_fanout.clone(),
                                                    ).await {
                                                        eprintln!("[Main] Flutter emulator job failed: {:?}", e);
                                                    }
                                                });
                                                return;
                                            }
                                        }

                                        // Default: native compile flow
                                        let ts = term_store_for_msg.clone();
                                        let sdls = sdl_store.clone();
                                        let rs = runner_store.clone();
                                        let pc_clone = pc_for_compile.clone();
                                        let wp = workspace_path_for_compile.clone();
                                        let cc = compile_cache.clone();
                                        let bc = boundary_checker.clone();
                                        let ic = incremental_cache.clone();
                                        // v2.1 clones for spawn
                                        let ho = hmr_orchestrator.clone();
                                        let sl = structured_logger.clone();
                                        let ma = metrics_aggregator.clone();
                                        let rc = restart_controller.clone();
                                        let ipc = ipc_config.clone();
                                        let video_fanout_for_compile = video_fanout_for_msg.clone();
                                        let audio_fanout_for_compile = audio_fanout_for_msg.clone();
                                        let session_id = req
                                            .session_id
                                            .clone()
                                            .unwrap_or_else(|| format!("sess-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().as_u128() % 100000));
                                        let mut req = req;
                                        if req.session_id.is_none() {
                                            req.session_id = Some(session_id.clone());
                                        }
                                        let task_store = compile_task_store_for_msg.clone();
                                        let log_clone = log.clone();
                                        let task_session = session_id.clone();
                                        let handle = tokio::spawn(async move {
                                            if let Err(e) = handle_compile(req, log_clone, ts, sdls, rs, pc_clone, wp.to_path_buf(), cc, bc, ic, ho, sl, ma, rc, ipc, video_fanout_for_compile, audio_fanout_for_compile).await {
                                                eprintln!("[Main] Compile task failed: {:?}", e);
                                            }
                                            let mut guard = task_store.lock().await;
                                            if let Some((current_id, _)) = guard.as_ref() {
                                                if current_id == &task_session {
                                                    *guard = None;
                                                }
                                            }
                                        });
                                        {
                                            let mut guard = compile_task_store_for_msg.lock().await;
                                            if let Some((_, existing)) = guard.take() {
                                                existing.abort();
                                            }
                                            *guard = Some((session_id, handle));
                                        }
                                    }
                                    return;
                                }
                                // Not a compile request - ignore here. Terminal messages arrive on
                                // the separate 'terminal' datachannel.
                            }
                        }
                        .boxed()
                    }));
            } else if label == "build-log" {
                // Browser-opened build-log DC (alternative to the
                // worker-created one in `wire_peer_channels`). Either
                // attachment point is valid; whichever fires first wins
                // and the registry snapshot is used by all downstream
                // readers.
                peer_registry_outer.attach_build_log(&peer_id_outer, dc.clone());
            } else if label == "terminal" {
                    // Terminal datachannel - used to receive stdin messages for running
                    // processes. Messages are expected as JSON: { type: 'stdin', sessionId, data }
                    let sdl_store_for_msg = sdl_store_outer.clone();
                    let runner_store_for_term = runner_store_outer.clone();
                    let peer_registry_for_term = peer_registry_outer.clone();
                    let structured_logger_for_term = structured_logger_outer.clone();
                    let peer_id_for_term = peer_id_outer.clone();
                    // Track which sessions we've already warned about missing x11 senders
                    // to avoid flooding logs with repeated messages on every mouse/key event.
                    let x11_warned: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>> =
                        Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()));
                    dc.on_message(Box::new(move |msg| {
                        let term_store_for_msg = term_store.clone();
                        let sdl_store = sdl_store_for_msg.clone();
                        let runner_store_term = runner_store_for_term.clone();
                        let peer_registry_term = peer_registry_for_term.clone();
                        let structured_logger_term = structured_logger_for_term.clone();
                        let peer_id_term = peer_id_for_term.clone();
                        let x11_warned = x11_warned.clone();
                        async move {
                            if msg.is_string {
                                // diagnostic log
                                if let Ok(_s) = String::from_utf8(msg.data.to_vec()) {
                                    // debug_log!("[worker] terminal msg: {}", s);
                                }
                                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&msg.data) {
                                    if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
                                        if t == "stdin" {
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(d) = v.get("data").and_then(|x| x.as_str()) {
                                                    let guard = term_store_for_msg.lock().await;
                                                    if let Some(sender) = guard.get(sid) {
                                                        let _ = sender.send(d.to_string());
                                                    } else {
                                                        debug_log!("[worker] no stdin sender for session {}", sid);
                                                    }
                                                }
                                            }
                                        } else if t == "gui-event" {
                                            // Handle GUI event by sending to persistent SDL process.
                                            // Optional `dispatch_id` (string) lets MCP callers
                                            // correlate each input with an ack. Acks are emitted
                                            // on the build-log DC (not terminal) so the MCP's
                                            // existing log tap handles them alongside hmr/
                                            // frame-advance status messages.
                                            let dispatch_id_opt = v
                                                .get("dispatch_id")
                                                .and_then(|x| x.as_str())
                                                .map(|s| s.to_string());
                                            // Known at wire_peer_channels scope — the terminal DC
                                            // belongs to exactly one peer (the one whose PC owns
                                            // this data channel). Use the peer_id captured there
                                            // directly rather than a session-wide slot.
                                            let peer_id_for_event = peer_id_term.clone();
                                            // Record every gui-event to the structured logger,
                                            // tagged with the sending peer. A multi-peer session
                                            // is reconstructable post-hoc from these entries.
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(evt) = v.get("event") {
                                                    structured_logger_term.record_input_event(
                                                        &peer_id_for_event,
                                                        "browser",
                                                        sid,
                                                        evt,
                                                    );
                                                }
                                            }
                                            let ack_peer_id = peer_id_for_event.clone();
                                            let emit_ack = |accepted: bool, reason: Option<&str>| {
                                                if let Some(ref did) = dispatch_id_opt {
                                                    let did = did.clone();
                                                    let reason = reason.map(|s| s.to_string());
                                                    let registry = peer_registry_term.clone();
                                                    let pid = ack_peer_id.clone();
                                                    tokio::spawn(async move {
                                                        let msg = match reason {
                                                            Some(r) => serde_json::json!({
                                                                "type": "input-ack",
                                                                "dispatch_id": did,
                                                                "accepted": accepted,
                                                                "reason": r,
                                                                "peer_id": pid,
                                                            }),
                                                            None => serde_json::json!({
                                                                "type": "input-ack",
                                                                "dispatch_id": did,
                                                                "accepted": accepted,
                                                                "peer_id": pid,
                                                            }),
                                                        };
                                                        broadcast_build_log_text(
                                                            &registry,
                                                            msg.to_string(),
                                                        ).await;
                                                    });
                                                }
                                            };
                                            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                                                if let Some(evt) = v.get("event") {
                                                    // Handle stop-runner before SDL sender lookup
                                                    // (runner may not have an SDL sender registered)
                                                    if let Some(typ) = evt.get("type").and_then(|x| x.as_str()) {
                                                        if typ == "stop-runner" {
                                                            debug_log!("[worker] stop-runner requested for session {}", sid);
                                                            // Take and destroy runner state
                                                            let mut rg = runner_store_term.lock().await;
                                                            if let Some(mut state) = rg.take() {
                                                                // Stop GStreamer pipeline FIRST (before killing Xvfb)
                                                                // to avoid capture-from-dead-display crashes
                                                                if let Some(ref pipeline) = state.gst_pipeline {
                                                                    let _ = pipeline.set_state(gst::State::Null);
                                                                    debug_log!("[worker] GStreamer pipeline stopped");
                                                                }
                                                                state.gst_pipeline = None;
                                                                // Kill the runner process
                                                                if let Some(ref mut child) = state.process {
                                                                    let _ = child.kill().await;
                                                                    debug_log!("[worker] runner process killed");
                                                                }
                                                                // Kill Xvfb (safe now that GStreamer is stopped)
                                                                if let Some(ref mut xvfb) = state.xvfb_process {
                                                                    let _ = xvfb.kill().await;
                                                                    debug_log!("[worker] Xvfb killed");
                                                                }
                                                                // Drop the sdl_tx sender to close the xdotool channel
                                                                state.sdl_tx = None;
                                                                drop(state);
                                                            }
                                                            // Clean up SDL and terminal input senders for this session
                                                            {
                                                                let mut sdl_guard = sdl_store.lock().await;
                                                                sdl_guard.remove(sid);
                                                            }
                                                            {
                                                                let mut term_guard = term_store_for_msg.lock().await;
                                                                term_guard.remove(sid);
                                                            }
                                                            // Reset x11 warning so it fires again if session reconnects
                                                            {
                                                                let mut warned = x11_warned.lock().await;
                                                                warned.remove(sid);
                                                            }
                                                            // Notify every attached peer that
                                                            // the runner has ended. Legacy
                                                            // singleton DC -> registry fan-out.
                                                            let end_msg = serde_json::json!({
                                                                "type": "run-gui-end"
                                                            });
                                                            broadcast_build_log_text(
                                                                &peer_registry_term,
                                                                end_msg.to_string(),
                                                            ).await;
                                                            emit_ack(true, None);
                                                            // Early return - don't try SDL sender lookup
                                                            return;
                                                        }
                                                    }

                                                    let guard = sdl_store.lock().await;
                                                    if let Some(sender) = guard.get(sid) {
                                                        let mut cmd = String::new();
                                                        if let Some(typ) = evt.get("type").and_then(|x| x.as_str()) {
                                                            match typ {
                                                                "mouse" => {
                                                                    if let Some(action) = evt.get("action").and_then(|x| x.as_str()) {
                                                                        let x = evt.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
                                                                        let y = evt.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
                                                                        if action == "move" {
                                                                            cmd = format!("input motion {} {}", x, y);
                                                                        } else if action == "down" {
                                                                            if let Some(btn) = evt.get("button").and_then(|b| b.as_i64()) {
                                                                                cmd = format!("input button down {} {} {}", btn, x, y);
                                                                            }
                                                                        } else if action == "up" {
                                                                            if let Some(btn) = evt.get("button").and_then(|b| b.as_i64()) {
                                                                                cmd = format!("input button up {} {} {}", btn, x, y);
                                                                            }
                                                                        } else if action == "wheel" {
                                                                            if let Some(delta) = evt.get("deltaY").and_then(|d| d.as_f64()) {
                                                                                let btn = if delta > 0.0 { 5 } else { 4 };
                                                                                // Scroll: synthesize button down + up for scroll buttons
                                                                                cmd = format!("input button down {} {} {}\ninput button up {} {} {}", btn, x, y, btn, x, y);
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                                "key" => {
                                                                    if let Some(action) = evt.get("action").and_then(|x| x.as_str()) {
                                                                        if let Some(key) = evt.get("key").and_then(|k| k.as_str()) {
                                                                            let sdlk = js_key_to_sdl_keycode(key);
                                                                            if sdlk != 0 {
                                                                                let dir = if action == "down" || action == "press" { "down" } else { "up" };
                                                                                cmd = format!("input key {} {}", dir, sdlk);
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                                _ => {}
                                                            }
                                                        }
                                                        if !cmd.is_empty() {
                                                            let _ = sender.send(cmd);
                                                            emit_ack(true, None);
                                                        } else {
                                                            emit_ack(false, Some("unsupported_event"));
                                                        }
                                                    } else {
                                                        // Only warn once per session to avoid log spam
                                                        // (this fires on every mouse/key event)
                                                        let mut warned = x11_warned.lock().await;
                                                        if warned.insert(sid.to_string()) {
                                                            debug_log!("[worker] no x11 sender for session {} (further warnings suppressed)", sid);
                                                        }
                                                        drop(warned);
                                                        emit_ack(false, Some("no_sdl_sender"));
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        eprintln!("[Main] ERROR: No build-log channel found in store! Dropping compile request.");
                                    }
                                } else {
                                     eprintln!("[Main] Failed to parse CompileRequest. Data preview: {}", String::from_utf8_lossy(&msg.data).chars().take(100).collect::<String>());
                                }
                            }
                        }
                        .boxed()
                    }));
            } else if label.starts_with("lsp") {
                let rest = label.strip_prefix("lsp-").unwrap_or("cpp");
                let (lang_str, slug_opt) = if let Some((l, s)) = rest.split_once("?slug=") {
                    (l, Some(s.to_string()))
                } else {
                    (rest, None)
                };
                let lang = lang_str.to_string();

                // LSP stderr lines surface on the owning peer's build-log DC
                // so only the peer that opened the LSP channel sees them;
                // observers don't need LSP diagnostics cross-peer.
                let lsp_peer_registry = peer_registry_outer.clone();
                let lsp_peer_id = peer_id_outer.clone();
                let dc_clone = dc.clone();
                let workspace_path_for_lsp = workspace_path_for_dc.clone();

                // Create a channel to buffer incoming messages immediately
                let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<webrtc::data_channel::data_channel_message::DataChannelMessage>();

                let incoming_tx_clone = incoming_tx.clone();
                dc.on_message(Box::new(move |msg| {
                    let tx = incoming_tx_clone.clone();
                    async move {
                        let _ = tx.send(msg);
                    }
                    .boxed()
                }));

                debug_log!("[on_data_channel] LSP branch matched: lang='{}', spawning handler task...", lang);
                tokio::spawn(async move {
                    // Try to download the workspace files
                    let slug_to_use = slug_opt.as_deref().unwrap_or("test-workspace");
                    debug_log!("LSP Request: lang={}, slug={}", lang, slug_to_use);

                    let workspace_path = match storage::download(slug_to_use, None).await {
                        Ok(path) => {
                            let abs_path = if cfg!(target_os = "windows") {
                                if let Ok(full) = tokio::fs::canonicalize(&path).await {
                                    full
                                } else {
                                    path
                                }
                            } else {
                                path
                            };
                            debug_log!("Successfully downloaded workspace to: {}", abs_path.display());
                            abs_path
                        },
                        Err(e) => {
                            eprintln!("Failed to download workspace: {}", e);
                            debug_log!("Falling back to temp workspace: {}", workspace_path_for_lsp.display());
                            workspace_path_for_lsp.as_ref().clone()
                        }
                    };

                    // ── Install dependencies + language server in parallel ─────
                    // These two steps are independent: dep_installer scans
                    // manifest files and runs package managers, while
                    // lsp_installer downloads/installs the LSP binary.
                    // Running them concurrently shaves seconds off first-load.
                    // Both are idempotent (marker-file cached) so subsequent
                    // connections for other languages are near-instant.
                    //
                    // EXCEPTION: For Dart, we sequence the installs because
                    // dep_installer needs the `dart` binary to run `dart pub get`,
                    // and the binary may only become available after lsp_installer
                    // finishes installing the Dart SDK.
                    let lsp_result = if lang == "dart" {
                        // Sequential: install dart binary first, then run deps
                        let result = infra::lsp_installer::ensure_lsp_installed(&lang, &workspace_path).await;
                        infra::dep_installer::install_all_deps(&workspace_path, &lang, false).await;
                        result
                    } else {
                        // Parallel: independent install steps
                        let (_, lsp_res) = tokio::join!(
                            infra::dep_installer::install_all_deps(&workspace_path, &lang, false),
                            infra::lsp_installer::ensure_lsp_installed(&lang, &workspace_path),
                        );
                        lsp_res
                    };
                    match lsp_result {
                        Ok(bin) => debug_log!("[LSP] Server binary ready: {}", bin),
                        Err(ref e) => eprintln!("[LSP] Server install warning: {}", e),
                    }

                    // ── Generate minimal LSP config for standalone files ─────
                    // If the workspace has no project config for this language,
                    // create a minimal one so the language server provides
                    // useful intellisense (completions, go-to-def, etc.)
                    // even for a single file without a project manifest.
                    ensure_lsp_config(&workspace_path, &lang);

                    // Detect rust-src path BEFORE constructing the RA command.
                    // This path is:
                    //  1. Set as RUST_SRC_PATH env on the RA process (belt-and-suspenders)
                    //  2. Injected into initializationOptions.cargo.sysrootSrc
                    // Both tell RA where to find stdlib source (Vec::new, etc.)
                    // even if RA's own sysroot auto-detection points elsewhere.
                    let (rust_sysroot_src, rust_sysroot): (Option<String>, Option<String>) = if lang == "rust" {
                        let (src, root) = find_rust_sysroot_info();
                        match &src {
                            Some(p) => debug_log!("[LSP] Detected rust sysroot_src for injection: {}", p),
                            None => println!("[LSP] WARNING: rust-src not found — Vec:: completions may not work"),
                        }
                        if let Some(ref r) = root {
                            debug_log!("[LSP] Detected rust sysroot root: {}", r);
                        }
                        (src, root)
                    } else {
                        (None, None)
                    };

                    debug_log!("Starting LSP for language: {}", lang);
                    let mut cmd = match lang.as_str() {
                        "cpp" | "c" => {
                            // Create compile_flags.txt to enforce C++17
                            let flags_path = workspace_path.join("compile_flags.txt");
                            if let Ok(mut file) = std::fs::File::create(&flags_path) {
                                use std::io::Write;
                                let _ = writeln!(file, "-std=c++17");
                                // Force C++ mode to ensure headers are treated correctly
                                let _ = writeln!(file, "-xc++");
                            }

                            // Create .clang-tidy to disable the include-cleaner check.
                            // clang-tidy's misc-include-cleaner aggressively flags newly
                            // added includes as "unused" before the TU is fully re-indexed,
                            // which is confusing in an interactive editor.
                            let clang_tidy_path = workspace_path.join(".clang-tidy");
                            if !clang_tidy_path.exists() {
                                if let Ok(mut f) = std::fs::File::create(&clang_tidy_path) {
                                    use std::io::Write;
                                    let _ = f.write_all(b"Checks: '-misc-include-cleaner'\n");
                                    debug_log!("[LSP-CONFIG] Created .clang-tidy (disabled include-cleaner)");
                                }
                            }

                            let mut c = system_command("clangd");
                            c.arg("--background-index");
                            c.arg("--completion-style=detailed");
                            c.arg("--header-insertion=iwyu");
                            c.arg("--clang-tidy");
                            // c.arg("--all-scopes-completion");
                            // Allow clangd to query g++ and other compilers for system include paths
                            c.arg("--query-driver=*");
                            c
                        },
                        "rust" => {
                            if cfg!(target_os = "windows") {
                                // On Windows, system_command wraps in `wsl`. But env vars
                                // set via .env() only affect wsl.exe, NOT the Linux process
                                // inside WSL.  Instead, launch RA through bash with explicit
                                // env so CARGO_HOME/RUSTUP_HOME/PATH propagate correctly.
                                //
                                // Also inject RUST_SRC_PATH if we detected it, so RA can
                                // find stdlib source even if its sysroot auto-detection fails.
                                let src_env = rust_sysroot_src.as_ref()
                                    .map(|p| format!("export RUST_SRC_PATH='{}'; ", p))
                                    .unwrap_or_default();
                                let script = format!(
                                    "export CARGO_HOME=\"${{CARGO_HOME:-$HOME/.cargo}}\"; \
                                     export RUSTUP_HOME=\"${{RUSTUP_HOME:-$HOME/.rustup}}\"; \
                                     unset RUSTUP_TOOLCHAIN; \
                                     export PATH=\"$CARGO_HOME/bin:$PATH\"; \
                                     {}exec rust-analyzer",
                                    src_env
                                );
                                let mut c = Command::new("wsl");
                                c.arg("bash").arg("-lc").arg(&script);
                                c
                            } else {
                                let mut c = system_command("rust-analyzer");
                                // Ensure rust-analyzer can find cargo/rustc.
                                // In containers, rustup installs to /root/.cargo and /root/.rustup.
                                // If CARGO_HOME / RUSTUP_HOME aren't set, try common locations.
                                let cargo_home = std::env::var("CARGO_HOME")
                                    .unwrap_or_else(|_| "/root/.cargo".to_string());
                                let rustup_home = std::env::var("RUSTUP_HOME")
                                    .unwrap_or_else(|_| "/root/.rustup".to_string());
                                c.env("CARGO_HOME", &cargo_home);
                                c.env("RUSTUP_HOME", &rustup_home);
                                // Clear RUSTUP_TOOLCHAIN — if the container has a bare
                                // system rustc at /usr, RA auto-detects sysroot as /usr
                                // and sets RUSTUP_TOOLCHAIN="/usr" which breaks cargo.
                                c.env_remove("RUSTUP_TOOLCHAIN");
                                // Prepend cargo/rustup bin dirs to PATH so rust-analyzer
                                // can invoke `cargo metadata`, `rustc`, etc.
                                let current_path = std::env::var("PATH").unwrap_or_default();
                                let new_path = format!(
                                    "{}/bin:{}",
                                    cargo_home, current_path
                                );
                                c.env("PATH", new_path);
                                // Set RUST_SRC_PATH as a belt-and-suspenders fallback
                                // so RA can find stdlib source even if its sysroot
                                // auto-detection points to a toolchain without rust-src.
                                if let Some(ref src_path) = rust_sysroot_src {
                                    c.env("RUST_SRC_PATH", src_path);
                                }
                                c
                            }
                        },
                        "python" | "py" => system_command("pylsp"),
                        "typescript" | "ts" => {
                             let mut c = system_command("typescript-language-server");
                             c.arg("--stdio");
                             c
                        },
                        "javascript" | "js" => {
                            // Use typescript-language-server for JavaScript — provides
                            // full IntelliSense (completions, go-to-def, hover, references)
                            // via the TypeScript language service, which natively supports JS.
                            let mut c = system_command("typescript-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "java" => {
                            // Eclipse JDT Language Server
                            // Expects `jdtls` wrapper script on PATH (installed via jdtls or eclipse.jdt.ls)
                            let data_dir = workspace_path.join(".jdtls-data");
                            let _ = std::fs::create_dir_all(&data_dir);
                            let mut c = system_command("jdtls");
                            c.arg("-data").arg(data_dir.to_string_lossy().to_string());
                            c
                        },
                        "go" => {
                            // gopls — the official Go language server
                            let mut c = system_command("gopls");
                            c.arg("serve");
                            c
                        },
                        "csharp" | "cs" => {
                            // OmniSharp language server for C# / .NET
                            let mut c = system_command("OmniSharp");
                            c.arg("-lsp");
                            c.arg("--stdio");
                            c
                        },
                        "ruby" | "rb" => {
                            // ruby-lsp (Shopify) — modern Ruby language server
                            let c = system_command("ruby-lsp");
                            c
                        },
                        "php" => {
                            // phpactor — PHP language server
                            let mut c = system_command("phpactor");
                            c.arg("language-server");
                            c
                        },
                        "kotlin" | "kt" => {
                            // Kotlin Language Server
                            let c = system_command("kotlin-language-server");
                            c
                        },
                        "zig" => {
                            // ZLS — Zig Language Server
                            let c = system_command("zls");
                            c
                        },
                        "dart" => {
                            // Dart SDK language server
                            // The Dart SDK may be installed to /opt/dart-sdk/bin or
                            // /usr/lib/dart/bin which are not on the default PATH.
                            // Prepend these well-known locations so the spawn succeeds.
                            let current_path = std::env::var("PATH").unwrap_or_default();
                            let dart_path = format!(
                                "/opt/dart-sdk/bin:/usr/lib/dart/bin:{}",
                                current_path
                            );
                            let mut c = if cfg!(target_os = "windows") {
                                let mut cmd = Command::new("wsl");
                                cmd.arg("bash").arg("-lc").arg(
                                    "export PATH=\"/opt/dart-sdk/bin:/usr/lib/dart/bin:$PATH\"; exec dart language-server --protocol=lsp"
                                );
                                cmd
                            } else {
                                let mut cmd = Command::new("dart");
                                cmd.arg("language-server");
                                cmd.arg("--protocol=lsp");
                                cmd.env("PATH", &dart_path);
                                cmd
                            };
                            // If dart is not on default PATH, try the well-known locations directly
                            if !cfg!(target_os = "windows") {
                                let dart_on_path = std::process::Command::new("which")
                                    .arg("dart")
                                    .stdout(Stdio::null())
                                    .stderr(Stdio::null())
                                    .status()
                                    .map(|s| s.success())
                                    .unwrap_or(false);
                                if !dart_on_path {
                                    for candidate in &["/opt/dart-sdk/bin/dart", "/usr/lib/dart/bin/dart", "/usr/local/bin/dart"] {
                                        if std::path::Path::new(candidate).exists() {
                                            c = Command::new(candidate);
                                            c.arg("language-server");
                                            c.arg("--protocol=lsp");
                                            c.env("PATH", &dart_path);
                                            debug_log!("[LSP] Using dart binary at: {}", candidate);
                                            break;
                                        }
                                    }
                                }
                            }
                            c
                        },
                        "lua" => {
                            // lua-language-server (LuaLS)
                            let c = system_command("lua-language-server");
                            c
                        },
                        "elixir" | "ex" => {
                            // ElixirLS language server
                            let c = system_command("elixir-ls");
                            c
                        },
                        "svelte" => {
                            // Svelte Language Server
                            let mut c = system_command("svelteserver");
                            c.arg("--stdio");
                            c
                        },
                        "css" | "scss" | "less" => {
                            // VSCode CSS/SCSS/LESS language server (vscode-langservers-extracted)
                            let mut c = system_command("vscode-css-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "html" => {
                            // VSCode HTML language server (vscode-langservers-extracted)
                            let mut c = system_command("vscode-html-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "prisma" => {
                            // Prisma Language Server (Node.js based)
                            // Installed via: npm i -g @prisma/language-server
                            let mut c = system_command("prisma-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "tailwindcss" => {
                            // Tailwind CSS Language Server
                            // Installed via: npm i -g @tailwindcss/language-server
                            let mut c = system_command("tailwindcss-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "eslint" => {
                            // ESLint Language Server (vscode-langservers-extracted)
                            let mut c = system_command("vscode-eslint-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "yaml" => {
                            // YAML Language Server
                            // Installed via: npm i -g yaml-language-server
                            let mut c = system_command("yaml-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "toml" => {
                            // Taplo TOML Language Server
                            // Installed via: cargo install taplo-cli --features lsp
                            let mut c = system_command("taplo");
                            c.arg("lsp");
                            c.arg("stdio");
                            c
                        },
                        "json" | "jsonc" => {
                            // VSCode JSON language server (vscode-langservers-extracted)
                            let mut c = system_command("vscode-json-language-server");
                            c.arg("--stdio");
                            c
                        },
                        "graphql" => {
                            // GraphQL Language Server
                            // Installed via: npm i -g graphql-language-service-cli
                            let mut c = system_command("graphql-lsp");
                            c.arg("server");
                            c.arg("-m");
                            c.arg("stream");
                            c
                        },
                        "dockerfile" => {
                            // Dockerfile Language Server
                            // Installed via: npm i -g dockerfile-language-server-nodejs
                            let mut c = system_command("docker-langserver");
                            c.arg("--stdio");
                            c
                        },
                        _ => {
                            debug_log!("Unsupported language for LSP: {}", lang);
                            return;
                        }
                    };

                    cmd.current_dir(&workspace_path);
                    cmd.stdin(Stdio::piped());
                    cmd.stdout(Stdio::piped());
                    cmd.stderr(Stdio::piped());

                    // Pre-spawn check: verify the binary is actually executable.
                    // This prevents cryptic "Permission denied" errors from spawn()
                    // when a previous install left a non-executable file on disk.
                    let binary_name = cmd.as_std().get_program().to_string_lossy().to_string();
                    let pre_check = if cfg!(target_os = "windows") {
                        Command::new("wsl")
                            .args(["test", "-x", &format!("$(which {} 2>/dev/null || echo /nonexistent)", binary_name)])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await
                    } else {
                        Command::new("sh")
                            .args(["-c", &format!(
                                "BIN=$(which {} 2>/dev/null) && test -x \"$BIN\"",
                                binary_name
                            )])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await
                    };
                    if !matches!(pre_check, Ok(s) if s.success()) {
                        debug_log!("[LSP] Pre-spawn check: {} is not executable or not found — attempting chmod fix", binary_name);
                        // Try to fix permissions on well-known install locations
                        let fix_cmd = format!(
                            "BIN=$(which {bin} 2>/dev/null || echo /usr/local/bin/{bin}); \
                             test -f \"$BIN\" && chmod +x \"$BIN\" 2>/dev/null || true",
                            bin = binary_name
                        );
                        if cfg!(target_os = "windows") {
                            let _ = Command::new("wsl").args(["bash", "-lc", &fix_cmd])
                                .status().await;
                        } else {
                            let _ = Command::new("bash").args(["-lc", &fix_cmd])
                                .status().await;
                        }
                    }

                    match cmd.spawn() {
                        Ok(mut child) => {
                            let mut stdin = child.stdin.take().expect("Failed to open stdin");
                            let stdout = child.stdout.take().expect("Failed to open stdout");
                            let stderr = child.stderr.take().expect("Failed to open stderr");

                            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

                            // Calculate server root URI once
                            let path_str = workspace_path.to_string_lossy().replace("\\", "/");
                            // Strip UNC prefix if present (e.g. //?/C:/...)
                            let path_str = if path_str.starts_with("//?/") {
                                path_str[4..].to_string()
                            } else {
                                path_str
                            };

                            let mut server_root_uri = if cfg!(target_os = "windows") {
                                let mut wsl_path = path_str.clone();
                                if let Some(colon_idx) = wsl_path.find(':') {
                                    let drive = &wsl_path[0..colon_idx].to_lowercase();
                                    let rest = &wsl_path[colon_idx+1..];
                                    wsl_path = format!("/mnt/{}{}", drive, rest);
                                }
                                format!("file://{}", wsl_path)
                            } else if path_str.starts_with('/') {
                                format!("file://{}", path_str)
                            } else {
                                format!("file:///{}", path_str)
                            };

                            if !server_root_uri.ends_with('/') {
                                server_root_uri.push('/');
                            }

                            let state = Arc::new(Mutex::new(LspSessionState {
                                client_root_uri: None,
                                server_root_uri: server_root_uri.clone(),
                                doc_versions: std::collections::HashMap::new(),
                            }));

                            // Process incoming messages (buffered + new)
                            let state_for_incoming = state.clone();
                            let workspace_path_for_incoming = workspace_path.clone();
                            let stdin_tx_clone = stdin_tx.clone();
                            let rust_sysroot_src_for_incoming = rust_sysroot_src.clone();
                            let rust_sysroot_for_incoming = rust_sysroot.clone();

                            tokio::spawn(async move {
                                while let Some(msg) = incoming_rx.recv().await {
                                    let tx = stdin_tx_clone.clone();
                                    let state = state_for_incoming.clone();
                                    let workspace_path = workspace_path_for_incoming.clone();

                                    let mut data = msg.data.to_vec();

                                    // Determine if the message has headers or is raw JSON
                                    let (json_bytes, has_headers) = if let Some(json_start) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                                        (&data[json_start+4..], true)
                                    } else {
                                        (&data[..], false)
                                    };

                                    // Try to parse and process
                                    let mut processed = false;
                                    // Deferred version update: store (uri, version) AFTER
                                    // forwarding so we don't record a version the server
                                    // never received.
                                    let mut deferred_version_update: Option<(String, i64)> = None;
                                    // When an out-of-order didChange is detected, we skip
                                    // forwarding the stale message and instead send a
                                    // full-text resync from disk.
                                    let mut skip_forward = false;
                                    let mut deferred_resync: Option<(Vec<u8>, String, i64)> = None;

                                    if let Ok(mut json_val) = serde_json::from_slice::<serde_json::Value>(json_bytes) {
                                        let mut guard = state.lock().await;

                                        // 1. Capture client root URI from initialize
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("initialize") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(root_uri) = params.get("rootUri").and_then(|s| s.as_str()) {
                                                    let mut uri = root_uri.to_string();
                                                    if !uri.ends_with('/') {
                                                        uri.push('/');
                                                    }
                                                    guard.client_root_uri = Some(uri.clone());
                                                    debug_log!("Captured client root URI: {}", uri);
                                                } else if let Some(folders) = params.get("workspaceFolders").and_then(|f| f.as_array()) {
                                                    if let Some(first) = folders.first() {
                                                        if let Some(uri_str) = first.get("uri").and_then(|s| s.as_str()) {
                                                            let mut uri = uri_str.to_string();
                                                            if !uri.ends_with('/') {
                                                                uri.push('/');
                                                            }
                                                            guard.client_root_uri = Some(uri.clone());
                                                            debug_log!("Captured client root URI from folders: {}", uri);
                                                        }
                                                    }
                                                }
                                            }

                                            if guard.client_root_uri.is_none() {
                                                debug_log!("Client root URI not found in initialize, defaulting to file:///");
                                                guard.client_root_uri = Some("file:///".to_string());
                                            }

                                            // Inject rust-analyzer configuration for stdlib resolution.
                                            //
                                            // Three mechanisms (belt-and-suspenders):
                                            //  1. cargo.sysrootSrc — tells RA where stdlib source is
                                            //  2. cargo.sysroot — explicit sysroot path (avoids "discover" running cargo)
                                            //  3. linkedProjects — inline project definition that bypasses
                                            //     `cargo metadata` entirely, giving RA a complete crate graph
                                            //     with sysroot.  Without this, RA can autocomplete type *names*
                                            //     (Vec, String) but NOT associated items (Vec::new, Vec::push).
                                            if let Some(ref src_path) = rust_sysroot_src_for_incoming {
                                                if let Some(params) = json_val.get_mut("params") {
                                                    let init_opts = params
                                                        .as_object_mut()
                                                        .and_then(|p| p.entry("initializationOptions")
                                                            .or_insert_with(|| serde_json::json!({}))
                                                            .as_object_mut());
                                                    if let Some(opts) = init_opts {
                                                        // Derive sysroot root from the sysroot_for_incoming
                                                        // or from the sysroot_src path.
                                                        let sysroot_root = rust_sysroot_for_incoming.clone()
                                                            .or_else(|| {
                                                                // Derive from sysroot_src: strip /lib/rustlib/src/rust/library
                                                                src_path.strip_suffix("/lib/rustlib/src/rust/library")
                                                                    .or_else(|| src_path.strip_suffix("/lib/rustlib/src/rust"))
                                                                    .map(|s| s.to_string())
                                                            });

                                                        // 1. Configure cargo settings
                                                        {
                                                            let cargo = opts
                                                                .entry("cargo")
                                                                .or_insert_with(|| serde_json::json!({}));
                                                            if let Some(cargo_obj) = cargo.as_object_mut() {
                                                                cargo_obj.insert(
                                                                    "sysrootSrc".to_string(),
                                                                    serde_json::Value::String(src_path.clone()),
                                                                );
                                                                // Override "discover" with explicit sysroot path.
                                                                // "discover" causes RA to run `cargo metadata` for
                                                                // sysroot resolution, which fails without cargo.
                                                                if let Some(ref root) = sysroot_root {
                                                                    cargo_obj.insert(
                                                                        "sysroot".to_string(),
                                                                        serde_json::Value::String(root.clone()),
                                                                    );
                                                                }
                                                            }
                                                        }
                                                        debug_log!("[LSP] Injected cargo.sysrootSrc={}, cargo.sysroot={:?}", src_path, sysroot_root);

                                                        // 2. Inject linkedProjects with inline project.
                                                        //    Skip when Cargo.toml has real [dependencies].
                                                        let cargo_toml = workspace_path.join("Cargo.toml");
                                                        let has_real_deps = cargo_toml.exists()
                                                            && std::fs::read_to_string(&cargo_toml)
                                                                .map(|c| {
                                                                    if let Some(idx) = c.find("[dependencies]") {
                                                                        let after = &c[idx + "[dependencies]".len()..];
                                                                        for line in after.lines() {
                                                                            let trimmed = line.trim();
                                                                            if trimmed.is_empty() || trimmed.starts_with('#') {
                                                                                continue;
                                                                            }
                                                                            if trimmed.starts_with('[') {
                                                                                break;
                                                                            }
                                                                            return true;
                                                                        }
                                                                    }
                                                                    false
                                                                })
                                                                .unwrap_or(false);

                                                        if has_real_deps {
                                                            debug_log!("[LSP] Cargo.toml has [dependencies] — using cargo discovery, skipping linkedProjects");
                                                        } else {
                                                            let mut rs_crates: Vec<serde_json::Value> = Vec::new();
                                                            if let Ok(entries) = std::fs::read_dir(&workspace_path) {
                                                                for entry in entries.flatten() {
                                                                    let p = entry.path();
                                                                    if p.extension().map_or(false, |e| e == "rs") {
                                                                        let p_str = if cfg!(target_os = "windows") {
                                                                            let s = p.to_string_lossy().replace("\\", "/");
                                                                            if let Some(ci) = s.find(':') {
                                                                                let drive = s[..ci].to_lowercase();
                                                                                let rest = &s[ci+1..];
                                                                                format!("/mnt/{}{}", drive, rest)
                                                                            } else {
                                                                                s.to_string()
                                                                            }
                                                                        } else {
                                                                            p.to_string_lossy().to_string()
                                                                        };
                                                                        rs_crates.push(serde_json::json!({
                                                                            "root_module": p_str,
                                                                            "edition": "2021",
                                                                            "deps": []
                                                                        }));
                                                                    }
                                                                }
                                                            }
                                                            if rs_crates.is_empty() {
                                                                let fallback = workspace_path.join("main.rs");
                                                                let fb_str = fallback.to_string_lossy().to_string();
                                                                rs_crates.push(serde_json::json!({
                                                                    "root_module": fb_str,
                                                                    "edition": "2021",
                                                                    "deps": []
                                                                }));
                                                            }
                                                            let num_crates = rs_crates.len();
                                                            // Build the project JSON with both sysroot and sysroot_src.
                                                            // sysroot = root path (e.g., /usr) — needed for compiled libs
                                                            // sysroot_src = source path (e.g., /usr/lib/rustlib/src/rust/library)
                                                            let mut project_json = serde_json::json!({
                                                                "sysroot_src": src_path,
                                                                "crates": rs_crates,
                                                            });
                                                            if let Some(ref root) = sysroot_root {
                                                                project_json.as_object_mut().unwrap().insert(
                                                                    "sysroot".to_string(),
                                                                    serde_json::Value::String(root.clone()),
                                                                );
                                                            }
                                                            opts.insert(
                                                                "linkedProjects".to_string(),
                                                                serde_json::json!([project_json]),
                                                            );
                                                            debug_log!("[LSP] Injected linkedProjects with {} crate(s), sysroot_src={}, sysroot={:?}", num_crates, src_path, sysroot_root);
                                                        }

                                                        // Log the full initializationOptions for debugging
                                                        if let Ok(opts_json) = serde_json::to_string_pretty(&serde_json::Value::Object(opts.clone())) {
                                                            debug_log!("[LSP] Full initializationOptions for RA:\n{}", opts_json);
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // 2. Rewrite URIs (Client -> Server)
                                        rewrite_uris(&mut json_val, &guard, true);

                                        // 3. Handle didOpen file writing (skip empty content — the server reads from disk)
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("textDocument/didOpen") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(doc) = params.get("textDocument") {
                                                    // Initialize version tracking from didOpen.
                                                    // This seeds the monotonic version for this URI
                                                    // so subsequent didChange can be ordered correctly.
                                                    if let Some(uri) = doc.get("uri").and_then(|s| s.as_str()) {
                                                        let open_version = doc.get("version")
                                                            .and_then(|v| v.as_i64())
                                                            .unwrap_or(0); // default to 0 if null/missing
                                                        guard.doc_versions.insert(uri.to_string(), open_version);
                                                    }

                                                    if let (Some(uri), Some(text)) = (doc.get("uri").and_then(|s| s.as_str()), doc.get("text").and_then(|s| s.as_str())) {
                                                        if !text.is_empty() {
                                                            if let Some(rel) = uri.strip_prefix(&guard.server_root_uri) {
                                                                let rel = rel.trim_start_matches('/');
                                                                let file_path = workspace_path.join(rel);
                                                                if let Some(parent) = file_path.parent() {
                                                                    let _ = tokio::fs::create_dir_all(parent).await;
                                                                }
                                                                if let Err(e) = tokio::fs::write(&file_path, text).await {
                                                                    eprintln!("Failed to write file {}: {}", file_path.display(), e);
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // 4. Handle didChange file writing (full sync AND incremental)
                                        // Track document versions to reject out-of-order changes.
                                        if json_val.get("method").and_then(|m| m.as_str()) == Some("textDocument/didChange") {
                                            if let Some(params) = json_val.get("params") {
                                                if let Some(changes) = params.get("contentChanges").and_then(|c| c.as_array()) {
                                                    if let Some(doc) = params.get("textDocument") {
                                                        if let Some(uri) = doc.get("uri").and_then(|s| s.as_str()) {
                                                            // Version check: reject out-of-order didChange.
                                                            // Handle null/missing version gracefully — treat as 0
                                                            // (some clients may omit it).
                                                            let incoming_version = doc.get("version")
                                                                .and_then(|v| if v.is_null() { None } else { v.as_i64() })
                                                                .unwrap_or(0);
                                                            let last_version = guard.doc_versions.get(uri).copied();
                                                            // Out-of-order check:
                                                            // - If no prior version tracked (None), always accept.
                                                            // - If prior version exists, incoming must be strictly greater.
                                                            let is_out_of_order = match last_version {
                                                                Some(last) => incoming_version <= last,
                                                                None => false, // first change for this URI, always accept
                                                            };
                                                            if is_out_of_order {
                                                                debug_log!("[LSP] Rejecting out-of-order didChange for {} (version {} <= {:?}), triggering full resync from disk", uri, incoming_version, last_version);
                                                                // Do NOT forward stale message. Read current disk
                                                                // content and send a synthetic full-text didChange
                                                                // so the server re-syncs to the true file state.
                                                                skip_forward = true;
                                                                if let Some(rel) = uri.strip_prefix(&guard.server_root_uri) {
                                                                    let rel = rel.trim_start_matches('/');
                                                                    let file_path = workspace_path.join(rel);
                                                                    if let Ok(disk_content) = tokio::fs::read_to_string(&file_path).await {
                                                                        let resync_version = last_version.unwrap_or(0) + 1;
                                                                        let resync_msg = serde_json::json!({
                                                                            "jsonrpc": "2.0",
                                                                            "method": "textDocument/didChange",
                                                                            "params": {
                                                                                "textDocument": {
                                                                                    "uri": uri,
                                                                                    "version": resync_version
                                                                                },
                                                                                "contentChanges": [{ "text": disk_content }]
                                                                            }
                                                                        });
                                                                        if let Ok(content) = serde_json::to_vec(&resync_msg) {
                                                                            let header = format!("Content-Length: {}\r\n\r\n", content.len());
                                                                            let mut msg_bytes = Vec::with_capacity(header.len() + content.len());
                                                                            msg_bytes.extend_from_slice(header.as_bytes());
                                                                            msg_bytes.extend_from_slice(&content);
                                                                            deferred_resync = Some((msg_bytes, uri.to_string(), resync_version));
                                                                        }
                                                                    } else {
                                                                        eprintln!("[LSP] Resync failed: could not read {} from disk", file_path.display());
                                                                    }
                                                                }
                                                            } else {
                                                                // Defer version update until after forward to LSP stdin
                                                                deferred_version_update = Some((uri.to_string(), incoming_version));

                                                                if let Some(rel) = uri.strip_prefix(&guard.server_root_uri) {
                                                                    let rel = rel.trim_start_matches('/');
                                                                    let file_path = workspace_path.join(rel);

                                                                    if changes.len() == 1 && changes[0].get("range").is_none() {
                                                                        // Full sync: single change without range = entire file content
                                                                        // Use atomic write: write to temp file, then rename
                                                                        if let Some(text) = changes[0].get("text").and_then(|s| s.as_str()) {
                                                                            let tmp_path = file_path.with_extension("lsp_tmp");
                                                                            if let Some(parent) = tmp_path.parent() {
                                                                                let _ = tokio::fs::create_dir_all(parent).await;
                                                                            }
                                                                            match tokio::fs::write(&tmp_path, text).await {
                                                                                Ok(_) => {
                                                                                    if let Err(e) = tokio::fs::rename(&tmp_path, &file_path).await {
                                                                                        eprintln!("Failed to rename temp file {}: {}", file_path.display(), e);
                                                                                        // Fallback: direct write
                                                                                        let _ = tokio::fs::write(&file_path, text).await;
                                                                                    }
                                                                                }
                                                                                Err(e) => eprintln!("Failed to write temp file {}: {}", tmp_path.display(), e),
                                                                            }
                                                                        }
                                                                    } else {
                                                                        // Incremental sync: changes have range fields.
                                                                        // Read current file, apply each change, write back atomically.
                                                                        let current = tokio::fs::read_to_string(&file_path).await.unwrap_or_default();
                                                                        let mut lines: Vec<String> = current.split('\n').map(|s| s.to_string()).collect();

                                                                        // Apply changes in reverse order so earlier positions stay valid
                                                                        let mut sorted_changes = changes.clone();
                                                                        sorted_changes.sort_by(|a, b| {
                                                                            let a_start = a.get("range").and_then(|r| r.get("start"));
                                                                            let b_start = b.get("range").and_then(|r| r.get("start"));
                                                                            let a_line = a_start.and_then(|s| s.get("line")).and_then(|l| l.as_u64()).unwrap_or(0);
                                                                            let b_line = b_start.and_then(|s| s.get("line")).and_then(|l| l.as_u64()).unwrap_or(0);
                                                                            let a_char = a_start.and_then(|s| s.get("character")).and_then(|c| c.as_u64()).unwrap_or(0);
                                                                            let b_char = b_start.and_then(|s| s.get("character")).and_then(|c| c.as_u64()).unwrap_or(0);
                                                                            b_line.cmp(&a_line).then(b_char.cmp(&a_char))
                                                                        });

                                                                        for change in &sorted_changes {
                                                                            if let (Some(range), Some(text)) = (change.get("range"), change.get("text").and_then(|t| t.as_str())) {
                                                                                let start_line = range.get("start").and_then(|s| s.get("line")).and_then(|l| l.as_u64()).unwrap_or(0) as usize;
                                                                                let start_char = range.get("start").and_then(|s| s.get("character")).and_then(|c| c.as_u64()).unwrap_or(0) as usize;
                                                                                let end_line = range.get("end").and_then(|e| e.get("line")).and_then(|l| l.as_u64()).unwrap_or(0) as usize;
                                                                                let end_char = range.get("end").and_then(|e| e.get("character")).and_then(|c| c.as_u64()).unwrap_or(0) as usize;

                                                                                // Clamp to valid line range
                                                                                let sl = start_line.min(lines.len().saturating_sub(1));
                                                                                let el = end_line.min(lines.len().saturating_sub(1));

                                                                                // Build the prefix (before the edit) and suffix (after the edit)
                                                                                let prefix = if sl < lines.len() {
                                                                                    let line_content = &lines[sl];
                                                                                    let sc = start_char.min(line_content.len());
                                                                                    line_content[..sc].to_string()
                                                                                } else {
                                                                                    String::new()
                                                                                };
                                                                                let suffix = if el < lines.len() {
                                                                                    let line_content = &lines[el];
                                                                                    let ec = end_char.min(line_content.len());
                                                                                    line_content[ec..].to_string()
                                                                                } else {
                                                                                    String::new()
                                                                                };

                                                                                // Split the replacement text into lines
                                                                                let new_text_lines: Vec<&str> = text.split('\n').collect();

                                                                                // Build replacement lines
                                                                                let mut replacement = Vec::new();
                                                                                if new_text_lines.len() == 1 {
                                                                                    replacement.push(format!("{}{}{}", prefix, new_text_lines[0], suffix));
                                                                                } else {
                                                                                    replacement.push(format!("{}{}", prefix, new_text_lines[0]));
                                                                                    for mid in &new_text_lines[1..new_text_lines.len()-1] {
                                                                                        replacement.push(mid.to_string());
                                                                                    }
                                                                                    replacement.push(format!("{}{}", new_text_lines[new_text_lines.len()-1], suffix));
                                                                                }

                                                                                // Splice the lines array
                                                                                let remove_end = (el + 1).min(lines.len());
                                                                                lines.splice(sl..remove_end, replacement);
                                                                            }
                                                                        }

                                                                        let new_content = lines.join("\n");
                                                                        // Atomic write: temp file + rename
                                                                        let tmp_path = file_path.with_extension("lsp_tmp");
                                                                        match tokio::fs::write(&tmp_path, &new_content).await {
                                                                            Ok(_) => {
                                                                                if let Err(e) = tokio::fs::rename(&tmp_path, &file_path).await {
                                                                                    eprintln!("Failed to rename temp file {}: {}", file_path.display(), e);
                                                                                    let _ = tokio::fs::write(&file_path, &new_content).await;
                                                                                }
                                                                            }
                                                                            Err(e) => eprintln!("Failed to write temp file {}: {}", tmp_path.display(), e),
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Re-serialize and add headers (required for Stdin)
                                        if let Ok(new_content) = serde_json::to_vec(&json_val) {
                                            let new_len = new_content.len();
                                            let new_header = format!("Content-Length: {}\r\n\r\n", new_len);
                                            let mut new_msg = Vec::new();
                                            new_msg.extend_from_slice(new_header.as_bytes());
                                            new_msg.extend_from_slice(&new_content);
                                            data = new_msg;
                                            processed = true;
                                        }
                                    }

                                    if !processed && !has_headers {
                                        // If we didn't process it (maybe parse failed) but it didn't have headers,
                                        // we must add headers to forward to Stdin.
                                        let new_len = data.len();
                                        let new_header = format!("Content-Length: {}\r\n\r\n", new_len);
                                        let mut new_msg = Vec::new();
                                        new_msg.extend_from_slice(new_header.as_bytes());
                                        new_msg.extend_from_slice(&data);
                                        data = new_msg;
                                    }

                                    // Forward message (or resync) to LSP server stdin.
                                    if skip_forward {
                                        // Out-of-order detected: send resync instead of stale msg
                                        if let Some((resync_bytes, uri, version)) = deferred_resync {
                                            let _ = tx.send(resync_bytes);
                                            let mut guard = state.lock().await;
                                            guard.doc_versions.insert(uri, version);
                                        }
                                        // else: resync could not be built, message is simply dropped
                                    } else {
                                        let _ = tx.send(data);

                                        // Apply deferred version update now that the message
                                        // has been queued for forwarding to the LSP server.
                                        if let Some((uri, version)) = deferred_version_update {
                                            let mut guard = state.lock().await;
                                            guard.doc_versions.insert(uri, version);
                                        }
                                    }
                                }
                            });

                            tokio::spawn(async move {
                                while let Some(data) = stdin_rx.recv().await {
                                    if let Err(_) = stdin.write_all(&data).await { break; }
                                    if let Err(_) = stdin.flush().await { break; }
                                }
                            });

                            let dc_out = dc_clone.clone();
                            let state_for_outgoing = state.clone();
                            tokio::spawn(async move {
                                let mut reader = BufReader::new(stdout);
                                loop {
                                    let mut content_length = 0;
                                    let mut header_lines = Vec::new();
                                    loop {
                                        let mut line = String::new();
                                        match reader.read_line(&mut line).await {
                                            Ok(0) => return,
                                            Ok(_) => {
                                                if line == "\r\n" || line == "\n" {
                                                    break;
                                                }
                                                if line.to_lowercase().starts_with("content-length:") {
                                                    if let Some(idx) = line.find(':') {
                                                        if let Ok(len) = line[idx+1..].trim().parse::<usize>() {
                                                            content_length = len;
                                                        }
                                                    }
                                                }
                                                header_lines.push(line);
                                            }
                                            Err(_) => return,
                                        }
                                    }

                                    if content_length > 0 {
                                        let mut buf = vec![0u8; content_length];
                                        match reader.read_exact(&mut buf).await {
                                            Ok(_) => {
                                                if let Ok(mut json_val) = serde_json::from_slice::<serde_json::Value>(&buf) {
                                                    // Log initialize response capabilities (for debugging)
                                                    // Force textDocumentSync to Full(1) so the client always
                                                    // sends the entire file content on every change.  This
                                                    // avoids the incremental-sync disk-write codepath which
                                                    // has UTF-16-vs-byte-offset bugs that cause the worker's
                                                    // on-disk copy to diverge from the LSP server's in-memory
                                                    // state, leading to stale diagnostics (e.g. "header not
                                                    // used" right after adding an #include).
                                                    if let Some(result) = json_val.get_mut("result") {
                                                        if let Some(caps) = result.get_mut("capabilities") {
                                                            if let Some(sync) = caps.get("textDocumentSync") {
                                                                debug_log!("[LSP] Server textDocumentSync capability (original): {}", sync);
                                                            }
                                                            // Override to Full(1)
                                                            caps.as_object_mut().map(|m| {
                                                                m.insert("textDocumentSync".to_string(), serde_json::json!({
                                                                    "openClose": true,
                                                                    "change": 1,
                                                                    "save": { "includeText": true }
                                                                }));
                                                            });
                                                            debug_log!("[LSP] Forced textDocumentSync to Full(1)");
                                                        }
                                                    }

                                                    let guard = state_for_outgoing.lock().await;
                                                    rewrite_uris(&mut json_val, &guard, false);

                                                    if let Ok(new_content) = serde_json::to_vec(&json_val) {
                                                        // Send ONLY content (no headers) to WebRTC
                                                        let data_len = new_content.len();
                                                        if data_len > 60000 {
                                                            let msg_id = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 0xFFFFFFFF) as u32;
                                                            let chunks = make_chunks(&new_content, msg_id);
                                                            for chunk in chunks {
                                                                let data = Bytes::from(chunk);
                                                                if let Err(e) = dc_send_with_backpressure(&dc_out, &data, "lsp").await {
                                                                    eprintln!("[lsp] Failed to send chunk: {}", e);
                                                                    break;
                                                                }
                                                            }
                                                        } else {
                                                            let data = Bytes::copy_from_slice(&new_content);
                                                            if let Err(e) = dc_send_with_backpressure(&dc_out, &data, "lsp").await {
                                                                eprintln!("[lsp] Failed to send to WebRTC: {}", e);
                                                                break;
                                                            }
                                                        }
                                                    }
                                                } else {
                                                    // Failed to parse JSON — send raw body
                                                    eprintln!("[LSP] Failed to parse JSON from stdout, forwarding raw bytes");
                                                    let data = Bytes::copy_from_slice(&buf);
                                                    if let Err(e) = dc_send_with_backpressure(&dc_out, &data, "lsp").await {
                                                        eprintln!("[lsp] Failed to send raw bytes to WebRTC: {}", e);
                                                        break;
                                                    }
                                                }
                                            }
                                            Err(_) => break,
                                        }
                                    }
                                }
                            });

                            let lsp_peer_registry = lsp_peer_registry.clone();
                            let lsp_peer_id = lsp_peer_id.clone();
                            tokio::spawn(async move {
                                let mut reader = BufReader::new(stderr);
                                let mut line = String::new();
                                loop {
                                    line.clear();
                                    match reader.read_line(&mut line).await {
                                        Ok(0) => break,
                                        Ok(_) => {
                                            // Always print RA stderr to worker logs for diagnostics
                                            // (sysroot errors, cargo metadata failures, etc.)
                                            eprint!("[LSP-ERR/{}] {}", lang, line);
                                            let log_dc = lsp_peer_registry
                                                .get(&lsp_peer_id)
                                                .and_then(|h| h.build_log_dc_snapshot());
                                            if let Some(ldc) = log_dc {
                                                let payload = serde_json::json!({
                                                    "type": "lsp-stderr",
                                                    "language": lang,
                                                    "line": line
                                                });
                                                let _ = ldc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
                                            }
                                        }
                                        Err(_) => break,
                                    }
                                }
                            });

                            let _ = child.wait().await;
                        }
                        Err(e) => {
                            // Build helpful diagnostic info for the error message
                            let path_info = std::env::var("PATH").unwrap_or_else(|_| "<unavailable>".to_string());
                            let binary_hint = match lang.as_str() {
                                "dart" => {
                                    let paths = ["/opt/dart-sdk/bin/dart", "/usr/lib/dart/bin/dart", "/usr/local/bin/dart"];
                                    let found: Vec<&str> = paths.iter().filter(|p| std::path::Path::new(p).exists()).copied().collect();
                                    if found.is_empty() {
                                        "Dart SDK not found in any well-known location. Install via: apt-get install dart or download from dart.dev".to_string()
                                    } else {
                                        format!("Dart binary found at: {} — but not on PATH", found.join(", "))
                                    }
                                }
                                _ => String::new(),
                            };
                            eprintln!("Failed to spawn LSP for {}: {}", lang, e);
                            if !binary_hint.is_empty() {
                                debug_log!("[LSP] Hint: {}", binary_hint);
                            }
                            debug_log!("[LSP] Current PATH: {}", path_info);
                            // Send an LSP-shaped error response back so the frontend
                            // doesn't hang forever waiting for `initialize` to respond.
                            let error_response = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 1, // initialize is always id=1
                                "error": {
                                    "code": -32002, // ServerNotInitialized
                                    "message": format!(
                                        "Failed to start {} language server: {}. \
                                         The server binary may not be installed on the worker.",
                                        lang, e
                                    )
                                }
                            });
                            if let Ok(payload) = serde_json::to_vec(&error_response) {
                                let _ = dc_clone.send(&bytes::Bytes::from(payload)).await;
                            }
                        }
                    }
                });
            }
            else if label == "file-sync" {
                // ── Real-time file sync channel ──────────────────────────
                // The browser sends JSON messages when files are created,
                // edited, renamed, or deleted.  We write the changes to disk
                // so the LSP server (which indexes from the filesystem) sees
                // them immediately.  This closes the "staleness gap" where
                // files created in the browser editor don't exist on the
                // worker's disk.
                //
                // Message format:
                //   { "op": "write",  "path": "src/utils.py", "content": "..." }
                //   { "op": "delete", "path": "old_file.py" }
                //   { "op": "rename", "from": "a.py", "to": "b.py" }
                //   { "op": "mkdir",  "path": "src/new_dir" }
                //
                // Paths are workspace-relative (same convention as LSP URIs
                // without the `file:///synthi/` prefix).
                let workspace_path_for_sync = workspace_path_for_dc.clone();
                dc.on_message(Box::new(move |msg| {
                    let ws_path = workspace_path_for_sync.clone();
                    async move {
                        let data = if msg.is_string {
                            msg.data.clone()
                        } else {
                            msg.data.clone()
                        };

                        let json: serde_json::Value = match serde_json::from_slice(&data) {
                            Ok(v) => v,
                            Err(e) => {
                                eprintln!("[file-sync] Invalid JSON: {}", e);
                                return;
                            }
                        };

                        let op = json.get("op").and_then(|o| o.as_str()).unwrap_or("");

                        // Resolve workspace root.  The files were downloaded to
                        // /tmp/workspaces/{slug}/ by storage::download, but we may
                        // also have a slug in the message for safety.
                        let base = if let Some(slug) = json.get("slug").and_then(|s| s.as_str()) {
                            let p = std::path::PathBuf::from(format!("/tmp/workspaces/{}", slug));
                            if p.exists() { p } else { ws_path.as_ref().clone() }
                        } else {
                            ws_path.as_ref().clone()
                        };

                        match op {
                            "write" | "edit_delta" => {
                                if let (Some(rel_path), Some(content)) = (
                                    json.get("path").and_then(|p| p.as_str()),
                                    json.get("content").and_then(|c| c.as_str()),
                                ) {
                                    // Sanitize: prevent path traversal
                                    let rel = rel_path.trim_start_matches('/');
                                    if rel.contains("..") {
                                        debug_log!("[file-sync] Rejected path traversal: {}", rel);
                                        return;
                                    }
                                    let file_path = base.join(rel);

                                    if let Some(parent) = file_path.parent() {
                                        let _ = tokio::fs::create_dir_all(parent).await;
                                    }
                                    match tokio::fs::write(&file_path, content).await {
                                        Ok(()) => debug_log!("[file-sync] ✓ write {}", rel),
                                        Err(e) => debug_log!("[file-sync] ✗ write {}: {}", rel, e),
                                    }

                                    // ── Speculative diff_patch trigger ──────────
                                    // If this write is the user's main source (not
                                    // one of the split modules core.cpp/gui.cpp/
                                    // shared.h), fire a speculative diff_patch
                                    // against the current split baseline. The
                                    // result lands in the speculative cache and
                                    // gets consumed by handler.rs Tier 2 if the
                                    // source_hash still matches on compile.
                                    //
                                    // Split-file writes go through a different
                                    // handler.rs code path ("is_editing_split_file")
                                    // that never calls Tier 2 diff_patch, so
                                    // speculating would be wasted.
                                    let is_split_file = {
                                        let lower = rel.to_lowercase();
                                        lower.ends_with("core.cpp")
                                            || lower.ends_with("gui.cpp")
                                            || lower.ends_with("shared.h")
                                    };
                                    if !is_split_file {
                                        let spec_ws = ws_path.as_ref().clone();
                                        let spec_source = content.to_string();
                                        worker::hmr::speculative_diff_patch::trigger_speculative(
                                            spec_ws,
                                            spec_source,
                                        );
                                    }
                                }
                            }
                            "delete" => {
                                if let Some(rel_path) = json.get("path").and_then(|p| p.as_str()) {
                                    let rel = rel_path.trim_start_matches('/');
                                    if rel.contains("..") { return; }
                                    let file_path = base.join(rel);
                                    if file_path.is_dir() {
                                        match tokio::fs::remove_dir_all(&file_path).await {
                                            Ok(()) => debug_log!("[file-sync] ✓ rmdir {}", rel),
                                            Err(e) => debug_log!("[file-sync] ✗ rmdir {}: {}", rel, e),
                                        }
                                    } else {
                                        match tokio::fs::remove_file(&file_path).await {
                                            Ok(()) => debug_log!("[file-sync] ✓ delete {}", rel),
                                            Err(e) => debug_log!("[file-sync] ✗ delete {}: {}", rel, e),
                                        }
                                    }
                                }
                            }
                            "rename" => {
                                if let (Some(from), Some(to)) = (
                                    json.get("from").and_then(|f| f.as_str()),
                                    json.get("to").and_then(|t| t.as_str()),
                                ) {
                                    let from = from.trim_start_matches('/');
                                    let to = to.trim_start_matches('/');
                                    if from.contains("..") || to.contains("..") { return; }
                                    let from_path = base.join(from);
                                    let to_path = base.join(to);
                                    if let Some(parent) = to_path.parent() {
                                        let _ = tokio::fs::create_dir_all(parent).await;
                                    }
                                    match tokio::fs::rename(&from_path, &to_path).await {
                                        Ok(()) => debug_log!("[file-sync] ✓ rename {} → {}", from, to),
                                        Err(e) => debug_log!("[file-sync] ✗ rename {} → {}: {}", from, to, e),
                                    }
                                }
                            }
                            "mkdir" => {
                                if let Some(rel_path) = json.get("path").and_then(|p| p.as_str()) {
                                    let rel = rel_path.trim_start_matches('/');
                                    if rel.contains("..") { return; }
                                    let dir_path = base.join(rel);
                                    match tokio::fs::create_dir_all(&dir_path).await {
                                        Ok(()) => debug_log!("[file-sync] ✓ mkdir {}", rel),
                                        Err(e) => debug_log!("[file-sync] ✗ mkdir {}: {}", rel, e),
                                    }
                                }
                            }
                            _ => {
                                debug_log!("[file-sync] Unknown op: {}", op);
                            }
                        }
                    }
                    .boxed()
                }));
            }
            else if label == "emulator-input" {
                dc.on_message(Box::new(move |msg| {
                    async move {
                        if !msg.is_string {
                            return;
                        }
                        if let Ok(v) = serde_json::from_slice::<worker::android::webrtc::input::EmulatorInputMessage>(&msg.data) {
                            if let Err(e) = worker::android::webrtc::input::handle_input_message(v).await {
                                eprintln!("[emulator-input] error: {:#}", e);
                            }
                        } else {
                            eprintln!("[emulator-input] failed to deserialize message: {}", String::from_utf8_lossy(&msg.data));
                        }
                    }
                    .boxed()
                }));
            }
            // ── Remote Extension Host (DEPRECATED) ─────────────────
            // The legacy ext-host DataChannel used to spawn remote-ext-host.js
            // directly.  This has been replaced by the vscode-server DataChannel
            // which manages a real VS Code Server (code-server) with
            // ext-host-preload.js injected via NODE_OPTIONS for full API
            // compatibility.  If a browser still requests this DC, send back
            // a deprecation error so it knows to use vscode-server instead.
            else if label.starts_with("ext-host") {
                let dc_clone = dc.clone();
                debug_log!(
                    "[ext-host] DEPRECATED: ext-host DataChannel requested — \
                     use vscode-server DC instead.  Sending deprecation error."
                );
                tokio::spawn(async move {
                    let err = serde_json::json!({
                        "id": 0,
                        "type": "event",
                        "method": "error",
                        "args": ["ext-host DataChannel is deprecated. Use the vscode-server DataChannel instead."],
                        "generation": 0
                    });
                    let _ = dc_clone.send_text(
                        serde_json::to_string(&err).unwrap_or_default()
                    ).await;
                });
            }
            // ── VS Code Server Manager ───────────────────────────────
            // Spawns vscode-server-manager.js which downloads/starts a
            // real VS Code Server (code-server) with a genuine Extension
            // Host.  Same stdin/stdout JSON-RPC pattern as ext-host.
            else if label.starts_with("vscode-server") {
                let slug_opt = if let Some((_prefix, slug)) = label.split_once("?slug=") {
                    Some(slug.to_string())
                } else {
                    None
                };

                let dc_clone = dc.clone();

                // Deduplication: ignore if spawned recently (< 10s)
                {
                    let guard = vscode_server_kill_tx_outer.lock().await;
                    if let Some((_tx, spawned_at)) = guard.as_ref() {
                        let age = spawned_at.elapsed();
                        if age < std::time::Duration::from_secs(10) {
                            debug_log!(
                                "[vscode-server] Ignoring duplicate DC (current process only {}ms old)",
                                age.as_millis()
                            );
                            drop(guard);
                            return;
                        }
                    }
                }

                // Kill any previously running vscode-server-manager process
                {
                    let mut guard = vscode_server_kill_tx_outer.lock().await;
                    if let Some((old_tx, _)) = guard.take() {
                        debug_log!("[vscode-server] Killing previous vscode-server-manager process");
                        let _ = old_tx.send(());
                    }
                }

                // Create a kill channel for THIS instance
                let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();
                {
                    let mut guard = vscode_server_kill_tx_outer.lock().await;
                    *guard = Some((kill_tx, tokio::time::Instant::now()));
                }

                // Buffer incoming messages
                let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<webrtc::data_channel::data_channel_message::DataChannelMessage>();
                let incoming_tx_clone = incoming_tx.clone();
                dc.on_message(Box::new(move |msg| {
                    let tx = incoming_tx_clone.clone();
                    async move { let _ = tx.send(msg); }.boxed()
                }));

                debug_log!("[on_data_channel] vscode-server branch matched, spawning vscode-server-manager.js...");

                // Signal when DC opens
                let (dc_open_tx, dc_open_rx) = tokio::sync::oneshot::channel::<()>();
                let dc_open_tx = std::sync::Mutex::new(Some(dc_open_tx));
                dc.on_open(Box::new(move || {
                    debug_log!("[vscode-server] DataChannel is now open");
                    if let Some(tx) = dc_open_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    async {}.boxed()
                }));

                tokio::spawn(async move {
                    // Locate the script — same directory as the binary
                    let manager_script = {
                        let exe_dir = std::env::current_exe()
                            .ok()
                            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                        let candidates = vec![
                            exe_dir.as_ref().map(|d| d.join("vscode-server-manager.js")),
                            Some(std::path::PathBuf::from("vscode-server-manager.js")),
                            Some(std::path::PathBuf::from("../vscode-server-manager.js")),
                        ];
                        let mut found = None;
                        for c in candidates.into_iter().flatten() {
                            if c.exists() {
                                found = Some(c);
                                break;
                            }
                        }
                        match found {
                            Some(p) => p,
                            None => {
                                debug_log!("[vscode-server] vscode-server-manager.js not found");
                                let err = serde_json::json!({
                                    "id": 0, "type": "event", "method": "error",
                                    "args": ["vscode-server-manager.js not found on worker"],
                                    "generation": 0
                                });
                                let _ = dc_clone.send_text(serde_json::to_string(&err).unwrap_or_default()).await;
                                return;
                            }
                        }
                    };

                    debug_log!("[vscode-server] Using script: {}", manager_script.display());

                    let mut cmd = Command::new("node");
                    cmd.arg(&manager_script);
                    cmd.stdin(Stdio::piped());
                    cmd.stdout(Stdio::piped());
                    cmd.stderr(Stdio::piped());

                    match cmd.spawn() {
                        Ok(mut child) => {
                            let mut stdin = child.stdin.take().expect("[vscode-server] Failed to open stdin");
                            let stdout = child.stdout.take().expect("[vscode-server] Failed to open stdout");
                            let stderr = child.stderr.take().expect("[vscode-server] Failed to open stderr");

                            // DC → stdin
                            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
                            let stdin_tx_clone = stdin_tx.clone();
                            tokio::spawn(async move {
                                while let Some(msg) = incoming_rx.recv().await {
                                    let mut line = msg.data.to_vec();
                                    if !line.ends_with(b"\n") { line.push(b'\n'); }
                                    let _ = stdin_tx_clone.send(line);
                                }
                            });
                            tokio::spawn(async move {
                                while let Some(data) = stdin_rx.recv().await {
                                    if stdin.write_all(&data).await.is_err() { break; }
                                    if stdin.flush().await.is_err() { break; }
                                }
                            });

                            // stdout → DC (wait for DC open first)
                            let dc_out = dc_clone.clone();
                            tokio::spawn(async move {
                                match tokio::time::timeout(
                                    std::time::Duration::from_secs(15),
                                    dc_open_rx,
                                ).await {
                                    Err(_) => { debug_log!("[vscode-server] Timed out waiting for DC open"); return; }
                                    Ok(Err(_)) => { debug_log!("[vscode-server] DC open signal dropped"); return; }
                                    Ok(Ok(())) => {}
                                }
                                debug_log!("[vscode-server] DC open, starting stdout→DC forwarding");
                                let mut reader = BufReader::new(stdout);
                                let mut line = String::new();
                                loop {
                                    line.clear();
                                    match reader.read_line(&mut line).await {
                                        Ok(0) => break,
                                        Ok(_) => {
                                            let trimmed = line.trim();
                                            if trimmed.is_empty() { continue; }


                                            // Chunk large messages (>60KB) for WebRTC SCTP
                                            let data_bytes = trimmed.as_bytes();
                                            if data_bytes.len() > 60000 {
                                                let msg_id = (std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap().as_nanos() % 0xFFFFFFFF) as u32;
                                                let chunks = make_chunks(data_bytes, msg_id);
                                                debug_log!("[vscode-server] Chunking large message: {} bytes → {} chunks", data_bytes.len(), chunks.len());
                                                for chunk in chunks {
                                                    let data = Bytes::from(chunk);
                                                    if let Err(e) = dc_send_with_backpressure(&dc_out, &data, "vscode-server").await {
                                                        eprintln!("[vscode-server] chunk send failed permanently: {}", e);
                                                        // Don't break the outer loop — just skip this message
                                                        break;
                                                    }
                                                }
                                            } else {
                                                if let Err(e) = dc_send_text_with_backpressure(&dc_out, trimmed.to_string(), "vscode-server").await {
                                                    eprintln!("[vscode-server] send failed permanently: {}", e);
                                                    // Don't break — continue trying with next messages
                                                }
                                            }
                                        }
                                        Err(e) => { eprintln!("[vscode-server] stdout read error: {}", e); break; }
                                    }
                                }
                                debug_log!("[vscode-server] stdout reader exited");
                            });

                            // stderr → logs
                            tokio::spawn(async move {
                                let mut reader = BufReader::new(stderr);
                                let mut line = String::new();
                                loop {
                                    line.clear();
                                    match reader.read_line(&mut line).await {
                                        Ok(0) => break,
                                        Ok(_) => { eprint!("[vscode-server] {}", line); }
                                        Err(_) => break,
                                    }
                                }
                            });

                            let _ = tokio::select! {
                                status = child.wait() => {
                                    debug_log!("[vscode-server] Manager process exited: {:?}", status);
                                    status
                                }
                                _ = kill_rx.recv() => {
                                    debug_log!("[vscode-server] Received kill signal, terminating manager");
                                    let _ = child.kill().await;
                                    child.wait().await
                                }
                            };
                            debug_log!("[vscode-server] Manager process cleanup complete");
                        }
                        Err(e) => {
                            eprintln!("[vscode-server] Failed to spawn Node.js: {}", e);
                            let err = serde_json::json!({
                                "id": 0, "type": "event", "method": "error",
                                "args": [format!("Failed to spawn vscode-server-manager: {}", e)],
                                "generation": 0
                            });
                            let _ = dc_clone.send_text(serde_json::to_string(&err).unwrap_or_default()).await;
                        }
                    }
                });
            }
            // ── VS Code Server WebSocket Tunnel ──────────────────────
            // Bridges a DataChannel to the VS Code Server's TCP port so
            // the browser can establish a WebSocket connection to the real
            // Extension Host through the WebRTC transport.
            //
            // Label format: "vscode-ws-tunnel?port=18000"
            // Data flows bidirectionally: DC ↔ TCP (127.0.0.1:<port>)
            else if label.starts_with("vscode-ws-tunnel") {
                let port: u16 = label
                    .split_once("?port=")
                    .and_then(|(_, p)| p.parse().ok())
                    .unwrap_or(18000);

                let dc_clone = dc.clone();

                // Buffer incoming DC messages
                let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<webrtc::data_channel::data_channel_message::DataChannelMessage>();
                let incoming_tx_clone = incoming_tx.clone();
                dc.on_message(Box::new(move |msg| {
                    let tx = incoming_tx_clone.clone();
                    async move { let _ = tx.send(msg); }.boxed()
                }));

                // Wait for DC to open, then connect TCP
                let (dc_open_tx, dc_open_rx) = tokio::sync::oneshot::channel::<()>();
                let dc_open_tx = std::sync::Mutex::new(Some(dc_open_tx));
                dc.on_open(Box::new(move || {
                    debug_log!("[vscode-ws-tunnel] DataChannel opened, port={}", port);
                    if let Some(tx) = dc_open_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    async {}.boxed()
                }));

                tokio::spawn(async move {
                    // Wait for DC open
                    if dc_open_rx.await.is_err() {
                        debug_log!("[vscode-ws-tunnel] DC open signal dropped");
                        return;
                    }

                    // Connect to the VS Code Server's TCP port
                    let addr = format!("127.0.0.1:{}", port);
                    let tcp_stream = match tokio::net::TcpStream::connect(&addr).await {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[vscode-ws-tunnel] Failed to connect to {}: {}", addr, e);
                            let err = serde_json::json!({
                                "id": 0, "type": "event", "method": "error",
                                "args": [format!("TCP connect failed: {}", e)],
                                "generation": 0
                            });
                            let _ = dc_clone.send_text(serde_json::to_string(&err).unwrap_or_default()).await;
                            return;
                        }
                    };
                    debug_log!("[vscode-ws-tunnel] TCP connected to {}", addr);

                    let (tcp_read, mut tcp_write) = tcp_stream.into_split();

                    // DC → TCP: forward DataChannel binary data to TCP socket
                    let dc_to_tcp = tokio::spawn(async move {
                        while let Some(msg) = incoming_rx.recv().await {
                            if tcp_write.write_all(&msg.data).await.is_err() { break; }
                        }
                        debug_log!("[vscode-ws-tunnel] DC→TCP forwarder exited");
                    });

                    // TCP → DC: forward TCP data back to DataChannel
                    let dc_for_tcp = dc_clone.clone();
                    let tcp_to_dc = tokio::spawn(async move {
                        let mut reader = tokio::io::BufReader::new(tcp_read);
                        let mut buf = vec![0u8; 64 * 1024];
                        loop {
                            match reader.read(&mut buf).await {
                                Ok(0) => break, // EOF
                                Ok(n) => {
                                    let data = Bytes::copy_from_slice(&buf[..n]);
                                    if dc_for_tcp.send(&data).await.is_err() { break; }
                                }
                                Err(e) => {
                                    eprintln!("[vscode-ws-tunnel] TCP read error: {}", e);
                                    break;
                                }
                            }
                        }
                        debug_log!("[vscode-ws-tunnel] TCP→DC forwarder exited");
                    });

                    // Wait for either direction to finish
                    tokio::select! {
                        _ = dc_to_tcp => {}
                        _ = tcp_to_dc => {}
                    }
                    debug_log!("[vscode-ws-tunnel] Tunnel closed for port {}", port);
                });
            }
        }
        .boxed()
    }));

    Ok(())
}

async fn handle_compile(
    req: CompileRequest,
    log_dc: Arc<RTCDataChannel>,
    terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    runner_store: Arc<Mutex<Option<RunnerState>>>,
    pc: Arc<RTCPeerConnection>,
    workspace_path: std::path::PathBuf,
    compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>>,
    boundary_checker: Arc<Mutex<BoundaryChecker>>,
    incremental_cache: Arc<IncrementalCache>,
    hmr_orchestrator: Arc<tokio::sync::Mutex<HmrOrchestrator>>,
    structured_logger: Arc<StructuredLogger>,
    metrics_aggregator: Arc<tokio::sync::Mutex<MetricsAggregator>>,
    restart_controller: Arc<tokio::sync::Mutex<RestartController>>,
    ipc_config: Arc<IpcConfig>,
    video_fanout: Arc<worker::webrtc::TrackFanout>,
    audio_fanout: Arc<worker::webrtc::TrackFanout>,
) -> Result<()> {
    // Construct context object for cleaner passing
    let ctx = CompileContext {
        log_dc,
        terminal_store,
        sdl_input_store,
        runner_store,
        pc,
        workspace_path,
        compile_cache,
        boundary_checker,
        incremental_cache,
        hmr_orchestrator,
        structured_logger,
        metrics_aggregator,
        restart_controller,
        ipc_config,
        supervisor_store: Arc::new(tokio::sync::Mutex::new(None)),
        xvfb_allocator: Arc::new(tokio::sync::Mutex::new(
            crate::runtime::path_c::xvfb_allocator::XvfbAllocator::new(),
        )),
        video_fanout,
        audio_fanout,
    };

    // Call the unified handler
    // We ignore the return value (JSON graph) for now as the void return type expects
    let session_id = req
        .session_id
        .clone()
        .unwrap_or_else(|| "default_session".to_string());
    if let Err(e) = crate::compiler::handler::handle_compile_request(&ctx, req, session_id.clone()).await {
        eprintln!("[Main] handle_compile_request error for {}: {:?}", session_id, e);
        // Resolve the frontend compile() promise as a failure so the IDE doesn't
        // hang on "Compiling..." forever when the pipeline returns an error
        // (e.g. AI split timeout, verifier bail-out, missing tooling).
        let error_str = format!("{}", e);
        let payload = serde_json::json!({
            "sessionId": session_id,
            "status": "done",
            "success": false,
            "error": error_str,
            "message": format!("Compile pipeline error: {}", e),
            "stage": "pipeline",
        });
        let _ = ctx.log_dc.send_text(serde_json::to_string(&payload).unwrap_or_default()).await;
        return Err(e);
    }

    Ok(())
}

async fn verify_tooling() -> Result<()> {
    for tool in REQUIRED_TOOLS {
        let status = system_command(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("{tool} not found on PATH");
        }
    }
    Ok(())
}

fn system_command(program: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("wsl");
        cmd.arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

/// Find the Rust sysroot and standard library source paths.
///
/// Uses the **same PATH** that rust-analyzer will use (with `$CARGO_HOME/bin`
/// prepended) so the sysroot matches what RA actually detects at runtime.
/// Falls back to system locations if the primary sysroot check fails.
///
/// Returns `(sysroot_src, sysroot)` — either or both may be None.
fn find_rust_sysroot_info() -> (Option<String>, Option<String>) {
    if cfg!(target_os = "windows") {
        // On Windows, RA runs inside WSL — query WSL for the sysroot
        let wsl_sysroot = std::process::Command::new("wsl")
            .args([
                "bash",
                "-lc",
                "rustc --print sysroot 2>/dev/null || echo /usr",
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        let check_script = r#"
            SYSROOT=$(rustc --print sysroot 2>/dev/null || echo /usr);
            for d in \
                "$SYSROOT/lib/rustlib/src/rust/library" \
                "/usr/lib/rustlib/src/rust/library" \
                "$SYSROOT/lib/rustlib/src/rust"; do
                [ -d "$d" ] && echo "$d" && exit 0;
            done;
            # Try Debian-style /usr/src/rustc-*/library
            for d in /usr/src/rustc-*/library; do
                [ -d "$d" ] && echo "$d" && exit 0;
            done
        "#;
        let src = std::process::Command::new("wsl")
            .args(["bash", "-lc", check_script])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        return (src, wsl_sysroot);
    }

    // Linux: build the same PATH that rust-analyzer will use
    let cargo_home = std::env::var("CARGO_HOME").unwrap_or_else(|_| "/root/.cargo".to_string());
    let current_path = std::env::var("PATH").unwrap_or_default();
    let ra_path = format!("{}/bin:{}", cargo_home, current_path);

    // Ask rustc (with RA's PATH) for its sysroot
    let sysroot = std::process::Command::new("rustc")
        .args(["--print", "sysroot"])
        .env("PATH", &ra_path)
        .env_remove("RUSTUP_TOOLCHAIN")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "/usr".to_string());

    // Also check what the DEFAULT rustc (without RA PATH) reports —
    // helps diagnose sysroot mismatches between system and rustup.
    let system_sysroot = std::process::Command::new("rustc")
        .args(["--print", "sysroot"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    debug_log!(
        "[LSP] RA sysroot (with CARGO_HOME/bin in PATH): {}",
        sysroot
    );
    if !system_sysroot.is_empty() && system_sysroot != sysroot {
        debug_log!("[LSP] System sysroot (default PATH): {} — MISMATCH! This is likely the cause of missing Vec:: completions", system_sysroot);
    }

    // Check candidate locations in priority order
    let candidates = [
        format!("{}/lib/rustlib/src/rust/library", sysroot),
        // System rustc sysroot (may differ from rustup)
        "/usr/lib/rustlib/src/rust/library".to_string(),
        format!("{}/lib/rustlib/src/rust", sysroot),
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return (Some(candidate.clone()), Some(sysroot));
        }
    }

    // Debian/Ubuntu system packages: /usr/src/rustc-*/library
    if let Ok(entries) = std::fs::read_dir("/usr/src") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("rustc-") && entry.path().join("library").exists() {
                return (
                    Some(entry.path().join("library").to_string_lossy().to_string()),
                    Some(sysroot),
                );
            }
        }
    }

    (None, Some(sysroot))
}

/// Generate minimal LSP configuration files for standalone workspaces.
///
/// When a user has a single `main.py` or `index.js` without a project
/// structure, the language server still needs certain config files to provide
/// useful intellisense (completions, go-to-def, diagnostics).  This function
/// creates them **only if they don't already exist** — existing configs are
/// never overwritten.
fn ensure_lsp_config(workspace: &std::path::Path, lang: &str) {
    use std::io::Write;

    match lang {
        "javascript" | "js" => {
            // typescript-language-server uses jsconfig.json for JavaScript projects.
            // Create a sensible default so the LSP provides IntelliSense
            // (completions, go-to-def, hover) for standalone JS files.
            let config_path = workspace.join("jsconfig.json");
            if !config_path.exists() && !workspace.join("tsconfig.json").exists() {
                if let Ok(mut f) = std::fs::File::create(&config_path) {
                    let _ = f.write_all(
                        br#"{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "checkJs": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "baseUrl": "."
  },
  "include": ["**/*.js", "**/*.jsx"],
  "exclude": ["node_modules"]
}
"#,
                    );
                    debug_log!("[LSP-CONFIG] Created jsconfig.json for standalone JS workspace");
                }
            }
        }
        "typescript" | "ts" => {
            let config_path = workspace.join("tsconfig.json");
            if !config_path.exists() && !workspace.join("jsconfig.json").exists() {
                if let Ok(mut f) = std::fs::File::create(&config_path) {
                    let _ = f.write_all(
                        br#"{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "baseUrl": "."
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
"#,
                    );
                    debug_log!("[LSP-CONFIG] Created tsconfig.json for standalone TS workspace");
                }
            }
        }
        "go" => {
            // gopls requires a go.mod to provide module-aware completions.
            let go_mod = workspace.join("go.mod");
            if !go_mod.exists() {
                if let Ok(mut f) = std::fs::File::create(&go_mod) {
                    let _ = f.write_all(b"module synthi-workspace\n\ngo 1.21\n");
                    debug_log!("[LSP-CONFIG] Created go.mod for standalone Go workspace");
                }
            }
        }
        "rust" => {
            // rust-analyzer needs a project manifest to index the workspace.
            // If cargo is available, use Cargo.toml.  Otherwise, create a
            // rust-project.json so RA can work in "detached files" mode
            // without needing cargo (which may not be installed in the container).
            //
            // IMPORTANT: On Windows, rust-analyzer runs inside WSL (via
            // system_command), so we must check for cargo/rustup in WSL,
            // not on the Windows host.  The old code ran these checks on
            // Windows, found cargo there, installed rust-src on Windows,
            // and ran cargo metadata on Windows — but RA in WSL couldn't
            // use any of that.
            let has_cargo = if cfg!(target_os = "windows") {
                std::process::Command::new("wsl")
                    .args(["bash", "-lc", "command -v cargo"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            } else {
                std::process::Command::new("cargo")
                    .arg("--version")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };

            if has_cargo {
                // Ensure rust-src is installed — needed for RA to resolve
                // stdlib types like Vec, String, HashMap, etc.
                // Without rust-src, RA can complete type *names* from the
                // prelude but cannot index their impl blocks (Vec::new,
                // Vec::push, etc.).
                //
                // IMPORTANT: Use the same PATH that RA will use ($CARGO_HOME/bin
                // prepended) so rust-src gets installed for the correct toolchain.
                // On Windows, install in WSL since that's where RA runs.
                if cfg!(target_os = "windows") {
                    let _ = std::process::Command::new("wsl")
                        .args(["bash", "-lc",
                            ". \"$HOME/.cargo/env\" 2>/dev/null; rustup component add rust-src 2>/dev/null || true"])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                } else {
                    let cargo_home_cfg =
                        std::env::var("CARGO_HOME").unwrap_or_else(|_| "/root/.cargo".to_string());
                    let current_path_cfg = std::env::var("PATH").unwrap_or_default();
                    let ra_path_cfg = format!("{}/bin:{}", cargo_home_cfg, current_path_cfg);
                    let _ = std::process::Command::new("bash")
                        .args(["-lc", ". \"$HOME/.cargo/env\" 2>/dev/null; rustup component add rust-src 2>/dev/null || true"])
                        .env("PATH", &ra_path_cfg)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }

                let cargo_toml = workspace.join("Cargo.toml");
                let created_toml = if !cargo_toml.exists() {
                    // Collect ALL .rs files so rust-analyzer indexes everything
                    let mut rs_files: Vec<String> = std::fs::read_dir(workspace)
                        .ok()
                        .map(|entries| {
                            entries
                                .flatten()
                                .filter(|e| e.path().extension().map_or(false, |ext| ext == "rs"))
                                .map(|e| e.file_name().to_string_lossy().to_string())
                                .collect()
                        })
                        .unwrap_or_else(|| vec!["main.rs".to_string()]);

                    if rs_files.is_empty() {
                        rs_files.push("main.rs".to_string());
                    }

                    // Sort so main.rs comes first (if present)
                    rs_files.sort_by(|a, b| {
                        if a == "main.rs" {
                            std::cmp::Ordering::Less
                        } else if b == "main.rs" {
                            std::cmp::Ordering::Greater
                        } else {
                            a.cmp(b)
                        }
                    });

                    if let Ok(mut f) = std::fs::File::create(&cargo_toml) {
                        let _ = write!(
                            f,
                            r#"[package]
name = "synthi-workspace"
version = "0.1.0"
edition = "2021"
"#
                        );
                        for rs_file in &rs_files {
                            let bin_name = rs_file.trim_end_matches(".rs");
                            let _ = write!(
                                f,
                                r#"
[[bin]]
name = "{}"
path = "{}"
"#,
                                bin_name, rs_file
                            );
                        }
                        debug_log!("[LSP-CONFIG] Created Cargo.toml with {} bin targets for standalone Rust workspace", rs_files.len());
                    }
                    true
                } else {
                    false
                };

                // Run `cargo metadata` to generate Cargo.lock and warm the
                // metadata cache.  rust-analyzer calls `cargo metadata` on
                // startup to discover the project structure, sysroot, and
                // crate graph.  If we pre-warm this, RA starts with a hot
                // cache and can resolve stdlib immediately (Vec::new etc.).
                // Only run if we created the Cargo.toml or there's no Cargo.lock.
                let cargo_lock = workspace.join("Cargo.lock");
                if created_toml || !cargo_lock.exists() {
                    debug_log!("[LSP-CONFIG] Running cargo metadata to warm RA cache...");

                    if cfg!(target_os = "windows") {
                        // Run inside WSL where rust-analyzer lives.
                        // Convert Windows path to WSL /mnt/ path.
                        let ws_str = workspace.to_string_lossy().replace("\\", "/");
                        let wsl_ws = if let Some(colon_idx) = ws_str.find(':') {
                            let drive = ws_str[..colon_idx].to_lowercase();
                            let rest = &ws_str[colon_idx + 1..];
                            format!("/mnt/{}{}", drive, rest)
                        } else {
                            ws_str.to_string()
                        };
                        let script = format!(
                            ". \"$HOME/.cargo/env\" 2>/dev/null; cd '{}' && cargo metadata --format-version=1 --no-deps 2>&1",
                            wsl_ws
                        );
                        let meta_status = std::process::Command::new("wsl")
                            .args(["bash", "-lc", &script])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::piped())
                            .status();
                        match meta_status {
                            Ok(s) if s.success() => debug_log!(
                                "[LSP-CONFIG] cargo metadata (WSL) succeeded — Cargo.lock ready"
                            ),
                            Ok(s) => {
                                debug_log!("[LSP-CONFIG] cargo metadata (WSL) exited with {}", s)
                            }
                            Err(e) => eprintln!("[LSP-CONFIG] cargo metadata (WSL) failed: {}", e),
                        }
                    } else {
                        // Resolve CARGO_HOME/RUSTUP_HOME so cargo finds the
                        // right toolchain (mirrors the env set on the RA process).
                        let cargo_home = std::env::var("CARGO_HOME")
                            .unwrap_or_else(|_| "/root/.cargo".to_string());
                        let current_path = std::env::var("PATH").unwrap_or_default();
                        let cargo_path = format!("{}/bin:{}", cargo_home, current_path);

                        let meta_status = std::process::Command::new("cargo")
                            .args(["metadata", "--format-version=1", "--no-deps"])
                            .current_dir(workspace)
                            .env("PATH", &cargo_path)
                            .env("CARGO_HOME", &cargo_home)
                            .env_remove("RUSTUP_TOOLCHAIN")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::piped())
                            .status();
                        match meta_status {
                            Ok(s) if s.success() => {
                                debug_log!("[LSP-CONFIG] cargo metadata succeeded — Cargo.lock ready")
                            }
                            Ok(s) => debug_log!("[LSP-CONFIG] cargo metadata exited with {}", s),
                            Err(e) => eprintln!("[LSP-CONFIG] cargo metadata failed: {}", e),
                        }
                    }
                }
            } else {
                // No cargo — create rust-project.json for RA's non-cargo mode.
                // This lets RA provide completions, hover, go-to-def without cargo.
                let rp_json = workspace.join("rust-project.json");
                if !rp_json.exists() {
                    // Try to install rust-src — on Windows run in WSL since
                    // that's where rust-analyzer runs.
                    if cfg!(target_os = "windows") {
                        let _ = std::process::Command::new("wsl")
                            .args(["bash", "-lc",
                                ". \"$HOME/.cargo/env\" 2>/dev/null; rustup component add rust-src 2>/dev/null || true"])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status();
                    } else {
                        let _ = std::process::Command::new("rustup")
                            .args(["component", "add", "rust-src"])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status();
                    }

                    // Try to find sysroot_src from rustc.
                    // On Windows, query WSL's rustc since RA runs there.
                    // Check multiple known locations — system rustc (apt) installs
                    // rust-src to different paths than rustup.
                    let sysroot_src = {
                        // 1. Ask rustc for its sysroot
                        let sysroot_output = if cfg!(target_os = "windows") {
                            std::process::Command::new("wsl")
                                .args([
                                    "bash",
                                    "-lc",
                                    ". \"$HOME/.cargo/env\" 2>/dev/null; rustc --print sysroot",
                                ])
                                .output()
                        } else {
                            std::process::Command::new("rustc")
                                .args(["--print", "sysroot"])
                                .output()
                        };
                        let sysroot = sysroot_output
                            .ok()
                            .and_then(|o| {
                                if o.status.success() {
                                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| "/usr".to_string());

                        // 2. Check common library source locations.
                        // On Windows, filesystem checks must go through WSL
                        // since the sysroot paths are Linux paths.
                        let mut found: Option<String> = None;

                        if cfg!(target_os = "windows") {
                            // Check inside WSL using a single shell command
                            let check_script = format!(
                                "if [ -d '{sysroot}/lib/rustlib/src/rust/library' ]; then \
                                   echo '{sysroot}/lib/rustlib/src/rust/library'; \
                                 elif ls -d /usr/src/rustc-*/library 2>/dev/null | head -1 | grep -q .; then \
                                   ls -d /usr/src/rustc-*/library 2>/dev/null | head -1; \
                                 elif [ -d '{sysroot}/lib/rustlib/src/rust' ]; then \
                                   echo '{sysroot}/lib/rustlib/src/rust'; \
                                 fi",
                                sysroot = sysroot
                            );
                            if let Ok(output) = std::process::Command::new("wsl")
                                .args(["bash", "-lc", &check_script])
                                .output()
                            {
                                if output.status.success() {
                                    let path =
                                        String::from_utf8_lossy(&output.stdout).trim().to_string();
                                    if !path.is_empty() {
                                        found = Some(path);
                                    }
                                }
                            }
                        } else {
                            let candidates = [
                                format!("{}/lib/rustlib/src/rust/library", sysroot),
                                // Debian/Ubuntu system rust-src package
                                "/usr/src/rustc-*/library".to_string(),
                                format!("{}/lib/rustlib/src/rust", sysroot),
                            ];

                            for candidate in &candidates {
                                if candidate.contains('*') {
                                    // Glob expansion for system packages
                                    if let Ok(entries) = std::fs::read_dir("/usr/src") {
                                        if let Some(entry) = entries.flatten().find(|e| {
                                            let name = e.file_name();
                                            let n = name.to_string_lossy();
                                            n.starts_with("rustc-")
                                                && e.path().join("library").exists()
                                        }) {
                                            found = Some(
                                                entry
                                                    .path()
                                                    .join("library")
                                                    .to_string_lossy()
                                                    .to_string(),
                                            );
                                            break;
                                        }
                                    }
                                } else {
                                    let p = std::path::PathBuf::from(candidate);
                                    if p.exists() {
                                        found = Some(p.to_string_lossy().to_string());
                                        break;
                                    }
                                }
                            }

                            if found.is_none() {
                                debug_log!("[LSP-CONFIG] rust-src not found at any known location, RA will have no stdlib completions");
                                let candidates_display = [
                                    format!("{}/lib/rustlib/src/rust/library", sysroot),
                                    "/usr/src/rustc-*/library".to_string(),
                                    format!("{}/lib/rustlib/src/rust", sysroot),
                                ];
                                debug_log!("[LSP-CONFIG] Searched: {:?}", candidates_display);
                            }
                        }
                        found
                    };

                    // Collect all .rs files as crate root modules
                    let rs_files: Vec<String> = std::fs::read_dir(workspace)
                        .ok()
                        .map(|entries| {
                            entries
                                .flatten()
                                .filter(|e| e.path().extension().map_or(false, |ext| ext == "rs"))
                                .map(|e| e.file_name().to_string_lossy().to_string())
                                .collect()
                        })
                        .unwrap_or_else(|| vec!["main.rs".to_string()]);

                    let sysroot_line = match &sysroot_src {
                        Some(path) => format!(r#"  "sysroot_src": "{}""#, path),
                        None => r#"  "sysroot_src": null"#.to_string(),
                    };

                    let crates: Vec<String> = rs_files
                        .iter()
                        .map(|f| {
                            format!(
                                r#"    {{
      "root_module": "{}",
      "edition": "2021",
      "deps": []
    }}"#,
                                f
                            )
                        })
                        .collect();

                    if let Ok(mut f) = std::fs::File::create(&rp_json) {
                        let _ = write!(
                            f,
                            "{{\n{},\n  \"crates\": [\n{}\n  ]\n}}\n",
                            sysroot_line,
                            crates.join(",\n")
                        );
                        debug_log!("[LSP-CONFIG] Created rust-project.json for standalone Rust workspace (no cargo)");
                    }
                }
            }
        }
        "dart" => {
            let pubspec = workspace.join("pubspec.yaml");
            if !pubspec.exists() {
                if let Ok(mut f) = std::fs::File::create(&pubspec) {
                    let _ = f.write_all(
                        b"name: synthi_workspace\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
                    );
                    debug_log!("[LSP-CONFIG] Created pubspec.yaml for standalone Dart workspace");

                    // Run 'dart pub get' so the Dart analysis server can resolve packages.
                    // Use the extended PATH that includes well-known Dart SDK locations.
                    let current_path = std::env::var("PATH").unwrap_or_default();
                    let dart_path = format!("/opt/dart-sdk/bin:/usr/lib/dart/bin:{}", current_path);
                    let pub_result = std::process::Command::new("dart")
                        .args(["pub", "get"])
                        .current_dir(workspace)
                        .env("PATH", &dart_path)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .status();
                    match pub_result {
                        Ok(s) if s.success() => debug_log!("[LSP-CONFIG] dart pub get succeeded"),
                        Ok(s) => {
                            debug_log!("[LSP-CONFIG] dart pub get exited with code {:?}", s.code())
                        }
                        Err(e) => {
                            // Try well-known paths if dart is not on PATH
                            for candidate in &["/opt/dart-sdk/bin/dart", "/usr/lib/dart/bin/dart"] {
                                if std::path::Path::new(candidate).exists() {
                                    let _ = std::process::Command::new(candidate)
                                        .args(["pub", "get"])
                                        .current_dir(workspace)
                                        .stdout(std::process::Stdio::piped())
                                        .stderr(std::process::Stdio::piped())
                                        .status();
                                    debug_log!("[LSP-CONFIG] Ran dart pub get via {}", candidate);
                                    break;
                                }
                            }
                            eprintln!("[LSP-CONFIG] dart pub get failed: {}", e);
                        }
                    }
                }
            }
        }
        "lua" => {
            // lua-language-server reads .luarc.json for project settings
            let luarc = workspace.join(".luarc.json");
            if !luarc.exists() {
                if let Ok(mut f) = std::fs::File::create(&luarc) {
                    let _ = f.write_all(
                        br#"{
  "runtime.version": "Lua 5.4",
  "diagnostics.globals": ["vim"],
  "workspace.library": [],
  "workspace.checkThirdParty": false
}
"#,
                    );
                    debug_log!("[LSP-CONFIG] Created .luarc.json for standalone Lua workspace");
                }
            }
        }
        "prisma" => {
            // Prisma Language Server works with .prisma files directly.
            // No extra config needed — it reads schema.prisma from the workspace.
            let schema = workspace.join("prisma/schema.prisma");
            if !schema.exists() {
                // Check root level too
                let root_schema = workspace.join("schema.prisma");
                if root_schema.exists() {
                    debug_log!("[LSP-CONFIG] Prisma schema found at root level");
                }
            } else {
                debug_log!("[LSP-CONFIG] Prisma schema found at prisma/schema.prisma");
            }
        }
        "json" | "jsonc" => {
            // vscode-json-language-server works out of the box.
            // Optionally, we could provide schema associations.
        }
        "yaml" => {
            // yaml-language-server works out of the box.
            // Could provide schema associations via settings.
        }
        // Python: pylsp/pyright works well for standalone files without extra config.
        // C/C++: compile_flags.txt is created in the cmd match arm below.
        // Java: jdtls creates .jdtls-data itself.
        // TOML, GraphQL, Dockerfile, Tailwind, ESLint: work without extra config.
        _ => {}
    }
}

