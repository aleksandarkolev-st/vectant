use std::{collections::HashMap, net::SocketAddr, sync::Arc};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, sync::mpsc, sync::Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
struct SignalMessage {
    #[serde(rename = "type")]
    msg_type: String,
    role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sdp_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate: Option<serde_json::Value>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let listener = TcpListener::bind("0.0.0.0:9000").await?;
    println!("Signaling server listening on ws://0.0.0.0:9000");

    while let Ok((stream, addr)) = listener.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, state).await {
                eprintln!("Connection error: {e}");
            }
        });
    }

    Ok(())
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    _addr: SocketAddr,
    state: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>>,
) -> anyhow::Result<()> {
    let ws_stream = accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let _ = ws_tx.send(msg).await;
        }
    });

    let mut role: Option<String> = None;

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

        if parsed.msg_type == "register" {
            if let Some(r) = parsed.role.clone() {
                role = Some(r.clone());
                state.lock().await.insert(r, out_tx.clone());
            }
            continue;
        }

        if let Some(ref r) = role {
            let target = if r == "browser" { "worker" } else { "browser" };
            if let Some(target_tx) = state.lock().await.get(target).cloned() {
                let _ = target_tx.send(Message::text(text));
            }
        }
    }

    if let Some(r) = role {
        state.lock().await.remove(&r);
    }

    send_task.abort();
    Ok(())
}
