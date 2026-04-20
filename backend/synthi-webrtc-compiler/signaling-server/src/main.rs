// ─────────────────────────────────────────────────────────────────────────────
//  Signaling Server v2 — session-multiplexed with Redis Pub/Sub relay
// ─────────────────────────────────────────────────────────────────────────────
//
//  Each peer registers with  { type: "register", role: "browser"|"worker"|"observer",
//                               session_id: "<workspace>-<user>" }
//
//  Role semantics:
//    - browser: singleton per session. Re-registering evicts the prior
//      sender (Path A eviction).
//    - worker:  singleton per session.
//    - observer: any number per session. Worker SDP/ICE is fanned to
//      every browser + observer in the session. Routes from observer/
//      browser land at the worker one-to-one. Worker-side per-peer PC
//      registry is phase-2 (ultraplan §4.16 + PHASE_2_PLUS_BACKLOG.md:G3);
//      without it, only the most-recently-set-up peer actually receives
//      media. The signaling fan-out is prerequisite for that work.
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

    /// Optional client identity string (e.g. `"synthi-mcp/0.1.0"`). For
    /// operator observability — never used for routing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_version: Option<String>,

    /// Optional protocol handshake: the list of protocol versions the
    /// client can speak. Server picks the highest mutually-supported
    /// version and echoes it back on the `registered` reply. Clients
    /// that omit this default to protocol 1 (current single version) so
    /// legacy browsers/workers keep working byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supported_protocols: Option<Vec<u32>>,

    /// Per-connection peer identifier. Minted by the signaling-server on
    /// register and echoed in the `registered` ack. Routing decisions
    /// still run off `(session_id, role)` today; the field is on the wire
    /// for forward-compat with G3 Phase B (worker per-peer PC routing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    peer_id: Option<String>,
}

/// Protocol versions this signaling-server implementation can speak.
/// Keep ordered ascending — the highest mutually-supported version wins.
const SERVER_PROTOCOLS: &[u32] = &[1];

/// Pick the highest mutually-supported protocol. `None` means no common
/// version exists and the client should be rejected with
/// `unsupported_protocol`.
fn pick_protocol(client: Option<&[u32]>) -> Option<u32> {
    match client {
        None => SERVER_PROTOCOLS.last().copied(),
        Some(list) if list.is_empty() => SERVER_PROTOCOLS.last().copied(),
        Some(list) => {
            let mut best: Option<u32> = None;
            for v in SERVER_PROTOCOLS {
                if list.contains(v) {
                    best = Some(match best {
                        Some(b) => b.max(*v),
                        None => *v,
                    });
                }
            }
            best
        }
    }
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

/// Composite key: (session_id, role) → ordered list of per-connection senders.
/// Roles `browser` and `worker` enforce a single peer (Path A eviction on
/// re-register); role `observer` allows N peers per session so agents can
/// co-attach with humans.
type PeerKey = (String, String); // (session_id, role)

/// Recognised roles. Anything else is accepted verbatim for forward-compat
/// but treated as a singleton (like `browser`). Keep the list here so the
/// register + forward paths share one source of truth.
const ROLE_BROWSER: &str = "browser";
const ROLE_WORKER: &str = "worker";
const ROLE_OBSERVER: &str = "observer";

/// Roles that are allowed multiple peers per session.
fn role_is_multi_peer(role: &str) -> bool {
    role == ROLE_OBSERVER
}

/// Classify a role as either a human peer (driver) or an agent peer
/// (passive observer / automated driver). Browsers today always count
/// as humans; observer/mcp-agent count as agents. Anything else falls
/// back to `human` (conservative — a new role shows up in the
/// human count until explicitly classified).
fn role_is_agent(role: &str) -> bool {
    role == ROLE_OBSERVER || role == "mcp-agent"
}

/// Compute `PresenceCounts` from a map of session peer lists (keyed by
/// (session_id, role)) for the given session. Worker peers are not
/// counted — they're not "attached" in the user-facing sense; they are
/// the compute endpoint.
fn compute_presence_counts(
    peers: &HashMap<PeerKey, Vec<mpsc::UnboundedSender<Message>>>,
    session_id: &str,
) -> PresenceCounts {
    let mut counts = PresenceCounts::zero();
    for ((sid, role), senders) in peers {
        if sid != session_id {
            continue;
        }
        if role == ROLE_WORKER {
            continue;
        }
        let n = senders.len();
        if role_is_agent(role) {
            counts.agents += n;
        } else {
            counts.humans += n;
        }
    }
    counts
}

/// Emit a `{type:"presence", ...}` message to every peer of a session
/// (worker, browsers, observers). Fails silently on a closed sender —
/// the next disconnect cleanup will reap it.
async fn broadcast_presence(state: &Arc<AppState>, session_id: &str, counts: PresenceCounts) {
    let msg = serde_json::json!({
        "type": "presence",
        "session_id": session_id,
        "attached_humans": counts.humans,
        "attached_agents": counts.agents,
    });
    let text = msg.to_string();
    let peers = state.peers.read().await;
    for ((sid, _role), senders) in peers.iter() {
        if sid != session_id {
            continue;
        }
        for tx in senders {
            let _ = tx.send(Message::text(text.clone()));
        }
    }
}

/// Counts of peers attached to a session, grouped by whether they are
/// human-driven or agent-driven. Emitted as a `presence` message so MCP
/// clients can surface `attached_humans` / `attached_agents` in their
/// session envelope without polling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PresenceCounts {
    humans: usize,
    agents: usize,
}

impl PresenceCounts {
    fn zero() -> Self {
        Self { humans: 0, agents: 0 }
    }
}

/// Shared across all connection tasks on this pod.
struct AppState {
    /// Local peers connected to **this** pod. Vec length enforced per role:
    ///   browser/worker: 1 (re-register evicts the prior sender).
    ///   observer:       N.
    peers: RwLock<HashMap<PeerKey, Vec<mpsc::UnboundedSender<Message>>>>,
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

/// Pick the peer roles that should receive a message sent by `sender_role`.
/// Worker messages fan out to browser + observer; everything else targets
/// the worker.
fn target_roles_for(sender_role: &str) -> &'static [&'static str] {
    if sender_role == ROLE_WORKER {
        &[ROLE_BROWSER, ROLE_OBSERVER]
    } else {
        &[ROLE_WORKER]
    }
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

        // Parse the target_key → (session_id, role). Fan to all local peers
        // of that role (observer case can have many; browser/worker at most 1).
        if let Some((session_id, role)) = parse_target_key(&envelope.target_key) {
            let peers = state.peers.read().await;
            if let Some(senders) = peers.get(&(session_id, role)) {
                for tx in senders {
                    let _ = tx.send(Message::text(envelope.payload.clone()));
                }
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

            // Protocol-version handshake. Clients that don't send
            // `supported_protocols` default to v1 (current), preserving
            // byte-identical wire for legacy browsers/workers.
            let negotiated_protocol = match pick_protocol(parsed.supported_protocols.as_deref()) {
                Some(v) => v,
                None => {
                    let err = serde_json::json!({
                        "type": "register-error",
                        "code": "unsupported_protocol",
                        "server_supports": SERVER_PROTOCOLS,
                    });
                    let _ = out_tx.send(Message::text(err.to_string()));
                    // Close without populating peer state so signaling
                    // doesn't route to an unsupported client.
                    println!(
                        "[Signaling] Rejected register from {addr}: unsupported_protocol (client supports {:?})",
                        parsed.supported_protocols
                    );
                    break;
                }
            };
            if let Some(cv) = &parsed.client_version {
                println!("[Signaling]   client_version={cv}");
            }

            // Remove previous registration if the connection re-registers.
            if let (Some(old_sid), Some(old_role)) = (&my_session, &my_role) {
                let mut peers = state.peers.write().await;
                if let Some(v) = peers.get_mut(&(old_sid.clone(), old_role.clone())) {
                    v.retain(|tx| !tx.same_channel(&out_tx));
                    if v.is_empty() {
                        peers.remove(&(old_sid.clone(), old_role.clone()));
                    }
                }
            }

            my_session = Some(session_id.clone());
            my_role = Some(role.clone());
            // Per-connection peer identifier. Echoed back in the
            // `registered` ack so clients can correlate their messages
            // with server-side routing decisions. Phase B will stamp
            // this onto forwarded SDP/ICE messages; today it's
            // informational only.
            let peer_id = uuid::Uuid::new_v4().to_string();

            // Singleton roles evict prior senders (Path A); observer appends.
            let key = (session_id.clone(), role.clone());
            let is_multi = role_is_multi_peer(&role);
            let presence_after_insert = {
                let mut peers = state.peers.write().await;
                let entry = peers.entry(key).or_default();
                if !is_multi {
                    entry.clear();
                }
                entry.push(out_tx.clone());
                compute_presence_counts(&peers, &session_id)
            };

            let count_msg = if is_multi { " (observer slot)" } else { "" };
            println!(
                "[Signaling] Registered {role}{count_msg} for session '{session_id}' (addr={addr}, protocol={negotiated_protocol})"
            );

            // Acknowledge the registration so the client knows which
            // protocol version to use. Emitted after peer-map insert so
            // a client that immediately replies with SDP sees a
            // server that's ready to route.
            let ack = serde_json::json!({
                "type": "registered",
                "accepted_protocol": negotiated_protocol,
                "server_supports": SERVER_PROTOCOLS,
                "session_id": session_id,
                "role": role,
                "peer_id": peer_id,
            });
            let _ = out_tx.send(Message::text(ack.to_string()));

            // Broadcast presence to everyone attached to this session
            // (including the worker, so worker-side metrics can surface
            // the same counts).
            broadcast_presence(&state, &session_id, presence_after_insert).await;
            continue;
        }

        // ── Forward SDP / ICE / reset / etc ────────────────────────────
        let (session_id, role) = match (&my_session, &my_role) {
            (Some(s), Some(r)) => (s.clone(), r.clone()),
            _ => continue, // not registered yet — drop
        };

        // ── Legacy-worker bridging ─────────────────────────────────────
        // In local dev the worker runs without SESSION_ID and registers
        // as "__legacy__".  When the __legacy__ worker sends a response
        // (answer / candidate), rewrite the target session to whichever
        // real browser session it is serving.
        let effective_session = if session_id == "__legacy__" && role == ROLE_WORKER {
            state.legacy_session.read().await.clone().unwrap_or(session_id.clone())
        } else {
            session_id.clone()
        };

        let target_roles = target_roles_for(&role);

        // Fan out across every target role. For worker → [browser, observer]
        // this routes the same message to both sets so every attached peer
        // gets the SDP/ICE. WebRTC semantics at the peer layer ignore what
        // isn't theirs; phase-2 worker per-peer PC registry tightens this.
        for target_role in target_roles {
            let delivered_locally = {
                let peers = state.peers.read().await;
                let primary = peers.get(&(effective_session.clone(), target_role.to_string()));
                // Legacy worker fallback — only when the target role is worker and
                // there is no exact match.
                let legacy_fallback = match primary {
                    Some(v) if !v.is_empty() => None,
                    _ if *target_role == ROLE_WORKER => {
                        peers.get(&("__legacy__".to_string(), ROLE_WORKER.to_string()))
                    }
                    _ => None,
                };
                let senders = primary.filter(|v| !v.is_empty()).or(legacy_fallback);

                if let Some(senders) = senders {
                    let mut any_ok = false;
                    for tx in senders {
                        if tx.send(Message::text(text.clone())).is_ok() {
                            any_ok = true;
                        }
                    }
                    if any_ok && legacy_fallback.is_some() && effective_session != "__legacy__" {
                        drop(peers);
                        *state.legacy_session.write().await = Some(effective_session.clone());
                    }
                    any_ok
                } else {
                    false
                }
            };

            if delivered_locally {
                log_forward(&parsed.msg_type, &effective_session, &role, target_role, "local");
            } else {
                publish_to_redis(
                    &state,
                    &make_target_key(&effective_session, target_role),
                    &text,
                )
                .await;
                log_forward(&parsed.msg_type, &effective_session, &role, target_role, "redis");
            }
        }
    }

    // ── Cleanup on disconnect ──────────────────────────────────────────
    if let (Some(sid), Some(role)) = (&my_session, &my_role) {
        let (session_empty, presence_after_remove) = {
            let mut peers = state.peers.write().await;
            // Remove this specific sender from the role's Vec; drop empty entry.
            if let Some(v) = peers.get_mut(&(sid.clone(), role.clone())) {
                v.retain(|tx| !tx.same_channel(&out_tx));
                if v.is_empty() {
                    peers.remove(&(sid.clone(), role.clone()));
                }
            }
            // Session empty when no role has any peer.
            let empty = !peers
                .iter()
                .any(|((sid2, _r), v)| sid2 == sid && !v.is_empty());
            let presence = compute_presence_counts(&peers, sid);
            (empty, presence)
        };

        println!("[Signaling] Unregistered {role} for session '{sid}' (addr={addr})");

        // Tell remaining peers that the count changed. Skip when the
        // session is empty — there's nobody left to listen.
        if !session_empty {
            broadcast_presence(&state, sid, presence_after_remove).await;
        }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_multi_peer_classification() {
        assert!(!role_is_multi_peer(ROLE_BROWSER));
        assert!(!role_is_multi_peer(ROLE_WORKER));
        assert!(role_is_multi_peer(ROLE_OBSERVER));
        assert!(!role_is_multi_peer("some_future_role"));
    }

    #[test]
    fn target_roles_for_worker_is_fanout() {
        let t = target_roles_for(ROLE_WORKER);
        assert_eq!(t, &[ROLE_BROWSER, ROLE_OBSERVER]);
    }

    #[test]
    fn target_roles_for_browser_and_observer_route_to_worker() {
        assert_eq!(target_roles_for(ROLE_BROWSER), &[ROLE_WORKER]);
        assert_eq!(target_roles_for(ROLE_OBSERVER), &[ROLE_WORKER]);
    }

    #[test]
    fn parse_target_key_roundtrip() {
        let key = make_target_key("abc123", "observer");
        let (sid, role) = parse_target_key(&key).unwrap();
        assert_eq!(sid, "abc123");
        assert_eq!(role, "observer");
    }

    #[test]
    fn protocol_handshake_default_when_client_omits_field() {
        // Legacy clients send no `supported_protocols` — default to the
        // highest server-supported version.
        assert_eq!(pick_protocol(None), Some(1));
    }

    #[test]
    fn protocol_handshake_empty_list_defaults_to_current() {
        // An empty list is treated like no-list (back-compat).
        let empty: &[u32] = &[];
        assert_eq!(pick_protocol(Some(empty)), Some(1));
    }

    #[test]
    fn protocol_handshake_picks_highest_mutually_supported() {
        // Client supports 1 + hypothetical future 2 — server only speaks
        // 1 today → picks 1.
        assert_eq!(pick_protocol(Some(&[1, 2, 3])), Some(1));
        assert_eq!(pick_protocol(Some(&[1])), Some(1));
    }

    #[test]
    fn protocol_handshake_rejects_when_no_overlap() {
        // Client supports only a future version server doesn't speak.
        assert_eq!(pick_protocol(Some(&[99, 100])), None);
    }

    #[test]
    fn role_agent_classification() {
        // observer + mcp-agent are agents; browser is human-driven;
        // unknown roles fall to human (conservative).
        assert!(!role_is_agent(ROLE_BROWSER));
        assert!(!role_is_agent(ROLE_WORKER));
        assert!(role_is_agent(ROLE_OBSERVER));
        assert!(role_is_agent("mcp-agent"));
        assert!(!role_is_agent("some_future_role"));
    }

    fn fake_sender() -> mpsc::UnboundedSender<Message> {
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        tx
    }

    #[test]
    fn presence_counts_browser_as_human() {
        let mut peers = HashMap::<PeerKey, Vec<mpsc::UnboundedSender<Message>>>::new();
        peers.insert(("s1".to_string(), ROLE_BROWSER.to_string()), vec![fake_sender()]);
        let c = compute_presence_counts(&peers, "s1");
        assert_eq!(c, PresenceCounts { humans: 1, agents: 0 });
    }

    #[test]
    fn presence_counts_observer_as_agent() {
        let mut peers = HashMap::<PeerKey, Vec<mpsc::UnboundedSender<Message>>>::new();
        peers.insert(
            ("s1".to_string(), ROLE_OBSERVER.to_string()),
            vec![fake_sender(), fake_sender()],
        );
        peers.insert(("s1".to_string(), ROLE_BROWSER.to_string()), vec![fake_sender()]);
        let c = compute_presence_counts(&peers, "s1");
        assert_eq!(c, PresenceCounts { humans: 1, agents: 2 });
    }

    #[test]
    fn presence_counts_ignores_worker() {
        let mut peers = HashMap::<PeerKey, Vec<mpsc::UnboundedSender<Message>>>::new();
        peers.insert(("s1".to_string(), ROLE_WORKER.to_string()), vec![fake_sender()]);
        peers.insert(("s1".to_string(), ROLE_BROWSER.to_string()), vec![fake_sender()]);
        let c = compute_presence_counts(&peers, "s1");
        assert_eq!(c, PresenceCounts { humans: 1, agents: 0 });
    }

    #[test]
    fn presence_counts_scope_by_session_id() {
        let mut peers = HashMap::<PeerKey, Vec<mpsc::UnboundedSender<Message>>>::new();
        peers.insert(("s1".to_string(), ROLE_BROWSER.to_string()), vec![fake_sender()]);
        peers.insert(("s2".to_string(), ROLE_BROWSER.to_string()), vec![fake_sender()]);
        peers.insert(
            ("s2".to_string(), ROLE_OBSERVER.to_string()),
            vec![fake_sender()],
        );
        let c1 = compute_presence_counts(&peers, "s1");
        let c2 = compute_presence_counts(&peers, "s2");
        assert_eq!(c1, PresenceCounts { humans: 1, agents: 0 });
        assert_eq!(c2, PresenceCounts { humans: 1, agents: 1 });
    }
}
