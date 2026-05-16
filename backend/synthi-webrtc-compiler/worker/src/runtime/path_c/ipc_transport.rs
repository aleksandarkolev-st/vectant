// ============================================================
// IPC TRANSPORT (Phase 12.6c — Unix socket + length-prefix framing)
// ============================================================
//
// Async send/receive of HmrCommand and HmrResponse over a Unix
// domain socket. Wire format:
//
//   [4 bytes LE: payload length] [payload: JSON bytes]
//
// The length prefix enables reading exactly one message at a time
// without delimiter scanning (newline-based protocols break on
// JSON values containing newlines).

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::hmr_protocol::{HmrCommand, HmrResponse};

const MAX_MESSAGE_SIZE: u32 = 1024 * 1024; // 1 MB

/// Send a command over the socket.
pub async fn send_command(stream: &mut UnixStream, cmd: &HmrCommand) -> Result<()> {
    let payload = serde_json::to_vec(cmd)?;
    send_raw(stream, &payload).await
}

/// Send a response over the socket.
pub async fn send_response(stream: &mut UnixStream, resp: &HmrResponse) -> Result<()> {
    let payload = serde_json::to_vec(resp)?;
    send_raw(stream, &payload).await
}

/// Receive a command from the socket.
pub async fn recv_command(stream: &mut UnixStream) -> Result<HmrCommand> {
    let payload = recv_raw(stream).await?;
    serde_json::from_slice(&payload).context("deserialize HmrCommand")
}

/// Receive a response from the socket.
pub async fn recv_response(stream: &mut UnixStream) -> Result<HmrResponse> {
    let payload = recv_raw(stream).await?;
    serde_json::from_slice(&payload).context("deserialize HmrResponse")
}

async fn send_raw(stream: &mut UnixStream, payload: &[u8]) -> Result<()> {
    let len = payload.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(payload).await?;
    stream.flush().await?;
    Ok(())
}

async fn recv_raw(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .context("read length prefix")?;
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_MESSAGE_SIZE {
        anyhow::bail!(
            "message too large: {} bytes (max {})",
            len,
            MAX_MESSAGE_SIZE
        );
    }
    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .await
        .context("read payload")?;
    Ok(payload)
}

/// Socket path for a given session.
pub fn socket_path(session_id: &str) -> String {
    format!("/tmp/synthi_hmr_{}.sock", session_id)
}

#[cfg(test)]
mod tests {
    use super::super::hmr_protocol::*;
    use super::*;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn command_roundtrip_over_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test.sock");

        let listener = UnixListener::bind(&sock).unwrap();

        let sock_clone = sock.clone();
        let sender = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock_clone).await.unwrap();
            let cmd = HmrCommand::Load {
                command_id: 42,
                module_name: "core".to_string(),
                so_path: "/build/libcore.so".to_string(),
            };
            send_command(&mut stream, &cmd).await.unwrap();
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let cmd = recv_command(&mut stream).await.unwrap();
        sender.await.unwrap();

        assert_eq!(
            cmd,
            HmrCommand::Load {
                command_id: 42,
                module_name: "core".to_string(),
                so_path: "/build/libcore.so".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn response_roundtrip_over_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test2.sock");

        let listener = UnixListener::bind(&sock).unwrap();

        let sock_clone = sock.clone();
        let sender = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock_clone).await.unwrap();
            let resp = HmrResponse::HandshakeAck {
                child_version: 1,
                child_min_supported: 1,
                child_capabilities: vec!["load".to_string()],
            };
            send_response(&mut stream, &resp).await.unwrap();
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let resp = recv_response(&mut stream).await.unwrap();
        sender.await.unwrap();

        match resp {
            HmrResponse::HandshakeAck { child_version, .. } => {
                assert_eq!(child_version, 1);
            }
            other => panic!("expected HandshakeAck, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn multiple_commands_sequential() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test3.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let sock_clone = sock.clone();
        let sender = tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock_clone).await.unwrap();
            for i in 0..5u64 {
                let cmd = HmrCommand::Load {
                    command_id: i,
                    module_name: format!("mod{}", i),
                    so_path: format!("/lib{}.so", i),
                };
                send_command(&mut stream, &cmd).await.unwrap();
            }
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        for i in 0..5u64 {
            let cmd = recv_command(&mut stream).await.unwrap();
            assert_eq!(cmd.command_id(), Some(i));
        }
        sender.await.unwrap();
    }
}
