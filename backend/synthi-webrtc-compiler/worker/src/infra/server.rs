use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

pub async fn start_server(
    addr: String,
    update_rx: broadcast::Receiver<String>, // Receives JSON payloads
    session_hash: String,
) {
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    println!("WebSocket server listening on: {}", addr);

    let session_hash = Arc::new(session_hash);

    while let Ok((stream, _)) = listener.accept().await {
        let update_rx = update_rx.resubscribe();
        let session_hash = session_hash.clone();
        tokio::spawn(accept_connection(stream, update_rx, session_hash));
    }
}

async fn accept_connection(
    stream: TcpStream,
    mut update_rx: broadcast::Receiver<String>,
    session_hash: Arc<String>,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            println!("Error during the websocket handshake occurred: {}", e);
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Simple handshake: Client must send session hash first
    if let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if text.trim() != *session_hash {
                    println!("Invalid session hash: {}", text);
                    let _ = write
                        .send(Message::Text("Error: Invalid session hash".to_string()))
                        .await;
                    return;
                }
                let _ = write.send(Message::Text("Connected".to_string())).await;
            }
            _ => {
                return;
            }
        }
    }

    // Forward updates to client
    loop {
        tokio::select! {
            Ok(msg) = update_rx.recv() => {
                if let Err(e) = write.send(Message::Text(msg)).await {
                    println!("Error sending message: {}", e);
                    break;
                }
            }
            Some(msg) = read.next() => {
                // Handle client messages if any (e.g. ping/pong)
                if let Ok(Message::Close(_)) = msg {
                    break;
                }
            }
        }
    }
}
