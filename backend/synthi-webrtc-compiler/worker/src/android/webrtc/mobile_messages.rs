use base64::Engine;
use serde_json::json;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use webrtc::data_channel::RTCDataChannel;

use crate::android::emulator::LogcatEntry;

use base64::engine::general_purpose::STANDARD as BASE64_STD;

/// Sends a status update to the frontend via the build-log channel.
pub async fn send_status(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    status: &str,
    message: &str,
    data: Option<serde_json::Value>,
) {
    let payload = json!({
        "sessionId": session_id,
        "type": "mobile-status",
        "status": status,
        "message": message,
        "data": data,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends a log line to the frontend.
pub async fn send_log(log_dc: &Arc<RTCDataChannel>, session_id: &str, line: &str, source: &str) {
    let payload = json!({
        "sessionId": session_id,
        "type": "mobile-log",
        "source": source,
        "line": line,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends logcat entry to frontend.
pub async fn send_logcat(log_dc: &Arc<RTCDataChannel>, session_id: &str, entry: &LogcatEntry) {
    let payload = json!({
        "sessionId": session_id,
        "type": "logcat",
        "entry": entry,
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Announces worker streaming capabilities for this session.
/// This is intended to let the frontend pick the best available transport
/// (future: real WebRTC video + input; current: screenshot frames over data channel).
pub async fn send_mobile_capabilities(log_dc: &Arc<RTCDataChannel>, session_id: &str) {
    let payload = json!({
        "sessionId": session_id,
        "type": "mobile-capabilities",
        "data": {
            "protocol": 1,
            "pixels": {
                "screenshot_frames": true,
                "chunked_frames": true,
                "webrtc_video": false,
            },
            "input": {
                "supported": false,
                "methods": [],
            }
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Sends a single emulator frame (PNG/JPEG, base64) to the frontend.
pub async fn send_emulator_frame(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    mime: &str,
    b64: &str,
    bytes: usize,
) {
    let payload = json!({
        "sessionId": session_id,
        "type": "emulator-frame",
        "data": {
            "mime": mime,
            // Prefer `b64` going forward, but keep `png_b64` for backwards compatibility.
            "b64": b64,
            "png_b64": b64,
            "bytes": bytes,
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

pub async fn send_emulator_frame_chunked(
    log_dc: &Arc<RTCDataChannel>,
    session_id: &str,
    mime: &str,
    b64: &str,
    bytes: usize,
) {
    // Keep chunks small so they survive typical RTCDataChannel max message sizes.
    // This is intentionally conservative.
    const CHUNK_CHARS: usize = 12_000;

    let frame_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();

    let total_chunks = (b64.len() + CHUNK_CHARS - 1) / CHUNK_CHARS;
    let begin = json!({
        "sessionId": session_id,
        "type": "emulator-frame-begin",
        "data": {
            "frame_id": frame_id,
            "mime": mime,
            "bytes": bytes,
            "total_chunks": total_chunks,
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&begin).unwrap_or_default())
        .await;

    for (idx, chunk) in b64.as_bytes().chunks(CHUNK_CHARS).enumerate() {
        let s = std::str::from_utf8(chunk).unwrap_or("");
        let msg = json!({
            "sessionId": session_id,
            "type": "emulator-frame-chunk",
            "data": {
                "frame_id": frame_id,
                "idx": idx,
                "chunk": s,
            }
        });
        let _ = log_dc
            .send_text(serde_json::to_string(&msg).unwrap_or_default())
            .await;
    }

    let end = json!({
        "sessionId": session_id,
        "type": "emulator-frame-end",
        "data": {
            "frame_id": frame_id,
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&end).unwrap_or_default())
        .await;
}

/// Small helper so callers don't need to import the base64 engine.
pub fn bytes_to_b64(bytes: &[u8]) -> String {
    BASE64_STD.encode(bytes)
}
