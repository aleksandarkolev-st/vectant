// ─────────────────────────────────────────────────────────────────────────────
//  Signaling Server v2 — session-multiplexed with Redis Pub/Sub relay
// ─────────────────────────────────────────────────────────────────────────────
//
//  Each peer registers with  { type: "register", role: "browser"|"worker",
//                               session_id: "<workspace>-<user>" }
//
//  SDP / ICE messages are routed **only** between peers sharing the same
//  `session_id`.  Redis Pub/Sub lets any signaling pod forward a message
//  to whichever pod currently holds the peer's WebSocket — enabling
//  horizontal scaling without sticky sessions.
//
//  Env vars:
//    SIGNALING_PORT  — listen port              (default 9000)
//    REDIS_URL       — redis://host:port        (default redis://127.0.0.1:6379)
//    NODE_ID         — unique id for this pod    (default: random UUID)
// ─────────────────────────────────────────────────────────────────────────────

use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{mpsc, RwLock},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

// HTTP client for spawner webhook.
static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("failed to build HTTP client")
    })
}

// ── Wire protocol ──────────────────────────────────────────────────────────

/// Messages exchanged over the WebSocket between clients and this server.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignalMessage {
    #[serde(rename = "type")]
    msg_type: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp_type: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate: Option<serde_json::Value>,
}

// ── Redis relay envelope ───────────────────────────────────────────────────

/// Envelope published to Redis so that the pod holding the target WebSocket
/// can deliver the payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelayEnvelope {
    /// Unique id of the **sending** pod — receiving pod skips its own messages.
    source_node: String,
    /// Channel key the message targets (e.g. "session:abc:worker").
    target_key: String,
    /// The original signaling JSON to forward verbatim.
    payload: String,
}

// ── Shared state ───────────────────────────────────────────────────────────

/// Composite key: (session_id, role) → per-connection sender.
type PeerKey = (String, String); // (session_id, role)

/// Shared across all connection tasks on this pod.
struct AppState {
    /// Local peers connected to **this** pod.
    peers: RwLock<HashMap<PeerKey, mpsc::UnboundedSender<Message>>>,
    /// Maps a `__legacy__` worker to the real session it is currently serving.
    /// Used in local dev when the worker has no SESSION_ID set.
    legacy_session: RwLock<Option<String>>,
    /// Redis client for Pub/Sub relay.
    redis_client: redis::Client,
    /// Unique identifier for this signaling pod instance.
    node_id: String,
    /// Base URL of the collab server for spawner webhooks.
    collab_url: Option<String>,
}

// ── Redis channel name helper ──────────────────────────────────────────────

/// All signaling pods subscribe to a single Redis channel.  The envelope
/// contains routing information so each pod can filter locally.
const REDIS_CHANNEL: &str = "signaling:relay";

// ── Main ───────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = env::var("SIGNALING_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9000);

    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let node_id = env::var("NODE_ID").unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());

    println!("[Signaling] node_id  = {node_id}");
    println!("[Signaling] redis    = {redis_url}");

    let redis_client = redis::Client::open(redis_url.as_str())?;
    let collab_url = env::var("COLLAB_SERVER_URL").ok();

    if let Some(ref url) = collab_url {
        println!("[Signaling] collab   = {url}");
    } else {
        println!("[Signaling] COLLAB_SERVER_URL not set — disconnect webhook disabled");
    }

    // Quick connectivity check — fail fast if Redis is unreachable.
    {
        let mut conn = redis_client.get_multiplexed_async_connection().await?;
        let pong: String = redis::cmd("PING").query_async(&mut conn).await?;
        println!("[Signaling] Redis PING → {pong}");
    }

    let state = Arc::new(AppState {
        peers: RwLock::new(HashMap::new()),
        legacy_session: RwLock::new(None),
        redis_client: redis_client.clone(),
        node_id: node_id.clone(),
        collab_url,
    });

    // ── Background: Redis subscriber ───────────────────────────────────
    {
        let state = state.clone();
        tokio::spawn(redis_subscriber(state));
    }

    // ── Accept WebSocket connections ───────────────────────────────────
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    println!("[Signaling] Listening on ws://0.0.0.0:{port}");

    while let Ok((stream, addr)) = listener.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, state).await {
                eprintln!("[Signaling] connection error ({addr}): {e}");
            }
        });
    }

    Ok(())
}

// ── Redis subscriber task ──────────────────────────────────────────────────

async fn redis_subscriber(state: Arc<AppState>) {
    loop {
        match redis_subscribe_loop(&state).await {
            Ok(()) => {
                eprintln!("[Signaling] Redis subscription ended, reconnecting…");
            }
            Err(e) => {
                eprintln!("[Signaling] Redis subscribe error: {e}, retrying in 2s…");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

async fn redis_subscribe_loop(state: &AppState) -> anyhow::Result<()> {
    let conn = state.redis_client.get_async_connection().await?;
    let mut pubsub = conn.into_pubsub();
    pubsub.subscribe(REDIS_CHANNEL).await?;
    println!("[Signaling] Subscribed to Redis channel '{REDIS_CHANNEL}'");

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = msg.get_payload()?;
        let envelope: RelayEnvelope = match serde_json::from_str(&payload) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Ignore messages this pod published itself.
        if envelope.source_node == state.node_id {
            continue;
        }

        // Parse the target_key → (session_id, role).
        if let Some((session_id, role)) = parse_target_key(&envelope.target_key) {
            let peers = state.peers.read().await;
            if let Some(tx) = peers.get(&(session_id, role)) {
                let _ = tx.send(Message::text(envelope.payload));
            }
        }
    }

    Ok(())
}

/// target_key format: "session:<session_id>:<role>"
fn make_target_key(session_id: &str, role: &str) -> String {
    format!("session:{session_id}:{role}")
}

fn parse_target_key(key: &str) -> Option<(String, String)> {
    // "session:<sid>:<role>"
    let mut parts = key.splitn(3, ':');
    let _prefix = parts.next()?; // "session"
    let sid = parts.next()?;
    let role = parts.next()?;
    Some((sid.to_string(), role.to_string()))
}

// ── Per-connection handler ─────────────────────────────────────────────────

async fn handle_connection(
    stream: tokio::net::TcpStream,
    addr: SocketAddr,
    state: Arc<AppState>,
) -> anyhow::Result<()> {
    let ws = accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Outbound channel for this connection.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    // Spawn a task that drains the outbound queue into the WebSocket.
    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Identity of this connection — set on "register".
    let mut my_session: Option<String> = None;
    let mut my_role: Option<String> = None;

    while let Some(msg) = ws_rx.next().await {
        let msg = msg?;
        if !msg.is_text() {
            continue;
        }
        let text = msg.into_text()?;

        let parsed: SignalMessage = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // ── Register ───────────────────────────────────────────────────
        if parsed.msg_type == "register" {
            let role = match parsed.role {
                Some(r) => r,
                None => continue,
            };
            let session_id = match parsed.session_id {
                Some(s) => s,
                None => {
                    // Backwards compat: if no session_id, use a legacy
                    // singleton key so old workers/browsers still work
                    // (single-session mode).
                    "__legacy__".to_string()
                }
            };

            // Remove previous registration if the connection re-registers.
            if let (Some(old_sid), Some(old_role)) = (&my_session, &my_role) {
                state
                    .peers
                    .write()
                    .await
                    .remove(&(old_sid.clone(), old_role.clone()));
            }

            my_session = Some(session_id.clone());
            my_role = Some(role.clone());

            state
                .peers
                .write()
                .await
                .insert((session_id.clone(), role.clone()), out_tx.clone());

            println!(
                "[Signaling] Registered {role} for session '{session_id}' (addr={addr})"
            );
            continue;
        }

        // ── Forward SDP / ICE / reset / etc ────────────────────────────
        let (session_id, role) = match (&my_session, &my_role) {
            (Some(s), Some(r)) => (s.clone(), r.clone()),
            _ => continue, // not registered yet — drop
        };

        let target_role = if role == "browser" {
            "worker"
        } else {
            "browser"
        };

        // ── Legacy-worker bridging ─────────────────────────────────────
        // In local dev the worker runs without SESSION_ID and registers
        // as "__legacy__".  When the __legacy__ worker sends a response
        // (answer / candidate), rewrite the target session to whichever
        // real browser session it is serving.
        let effective_session = if session_id == "__legacy__" && role == "worker" {
            // Worker responding — route to the real browser session.
            state.legacy_session.read().await.clone().unwrap_or(session_id.clone())
        } else {
            session_id.clone()
        };

        // Try local delivery first.
        let delivered_locally = {
            let peers = state.peers.read().await;
            // Look for exact session match first, then fall back to the
            // __legacy__ worker.  This lets a single local-dev worker
            // (no SESSION_ID set) serve any browser session.
            let fell_back_to_legacy;
            let target_tx = match peers.get(&(effective_session.clone(), target_role.to_string())) {
                Some(tx) => { fell_back_to_legacy = false; Some(tx) }
                None if target_role == "worker" => {
                    fell_back_to_legacy = true;
                    peers.get(&("__legacy__".to_string(), "worker".to_string()))
                }
                None => { fell_back_to_legacy = false; None }
            };
            if let Some(tx) = target_tx {
                let ok = tx.send(Message::text(text.clone())).is_ok();
                // Remember which real session the legacy worker is serving.
                if ok && fell_back_to_legacy && effective_session != "__legacy__" {
                    drop(peers); // release read lock before taking write lock
                    *state.legacy_session.write().await = Some(effective_session.clone());
                }
                ok
            } else {
                false
            }
        };

        if delivered_locally {
            log_forward(&parsed.msg_type, &effective_session, &role, target_role, "local");
        } else {
            // Target peer is not on this pod — publish via Redis for
            // whichever pod holds the other end.
            publish_to_redis(
                &state,
                &make_target_key(&effective_session, target_role),
                &text,
            )
            .await;
            log_forward(&parsed.msg_type, &effective_session, &role, target_role, "redis");
        }
    }

    // ── Cleanup on disconnect ──────────────────────────────────────────
    if let (Some(sid), Some(role)) = (&my_session, &my_role) {
        let session_empty = {
            let mut peers = state.peers.write().await;
            peers.remove(&(sid.clone(), role.clone()));

            // Check if any peer in this session remains (browser or worker).
            let has_browser = peers.contains_key(&(sid.clone(), "browser".to_string()));
            let has_worker = peers.contains_key(&(sid.clone(), "worker".to_string()));
            !has_browser && !has_worker
        };

        println!("[Signaling] Unregistered {role} for session '{sid}' (addr={addr})");

        // If no peers remain for this session, notify the collab server
        // so it can tear down the workspace pod.
        if session_empty {
            if let Some(ref base_url) = state.collab_url {
                let url = format!("{base_url}/api/spawner/session-ended");
                let sid_clone = sid.clone();
                tokio::spawn(async move {
                    let body = serde_json::json!({ "session_id": sid_clone });
                    match http_client().post(&url).json(&body).send().await {
                        Ok(resp) => {
                            println!(
                                "[Signaling] Session-ended webhook for '{sid_clone}': {}",
                                resp.status()
                            );
                        }
                        Err(e) => {
                            eprintln!(
                                "[Signaling] Session-ended webhook failed for '{sid_clone}': {e}"
                            );
                        }
                    }
                });
            }
        }
    }

    send_task.abort();
    Ok(())
}

// ── Redis publish helper ───────────────────────────────────────────────────

async fn publish_to_redis(state: &AppState, target_key: &str, payload: &str) {
    let envelope = RelayEnvelope {
        source_node: state.node_id.clone(),
        target_key: target_key.to_string(),
        payload: payload.to_string(),
    };

    let json = match serde_json::to_string(&envelope) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[Signaling] Failed to serialize relay envelope: {e}");
            return;
        }
    };

    let result: Result<(), _> = async {
        let mut conn = state.redis_client.get_multiplexed_async_connection().await?;
        redis::cmd("PUBLISH")
            .arg(REDIS_CHANNEL)
            .arg(&json)
            .query_async::<_, i64>(&mut conn)
            .await?;
        Ok::<(), redis::RedisError>(())
    }
    .await;

    if let Err(e) = result {
        eprintln!("[Signaling] Redis PUBLISH failed: {e}");
    }
}

// ── Logging helper ─────────────────────────────────────────────────────────

fn log_forward(msg_type: &str, session: &str, from: &str, to: &str, via: &str) {
    println!(
        "[Signaling] {msg_type}: session={session} {from}→{to} via {via}"
    );
}
