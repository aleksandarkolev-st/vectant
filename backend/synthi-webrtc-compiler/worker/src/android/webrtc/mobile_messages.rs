use serde_json::json;
use std::sync::Arc;
use webrtc::data_channel::RTCDataChannel;

use crate::android::emulator::LogcatEntry;

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
                "screenshot_frames": false,
                "chunked_frames": false,
                "webrtc_video": true,
            },
            "input": {
                "supported": true,
                "methods": ["tap", "swipe", "text", "key"],
            }
        }
    });
    let _ = log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}
