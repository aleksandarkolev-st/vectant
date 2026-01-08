use anyhow::{Context, Result};
use lazy_static::lazy_static;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex as TokioMutex;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use std::sync::Mutex;
use crate::android::emulator_grpc;
use super::stream_config::{EmulatorStreamConfig, EmulatorStreamMode};

/// Global store of cancelled mobile job session IDs.
/// When a job is cancelled, its session_id is added here.
/// Jobs should periodically check this to determine if they should stop.
lazy_static! {
    static ref CANCELLED_SESSIONS: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

/// Mark a mobile job session as cancelled
pub fn cancel_session(session_id: &str) {
    let mut g = CANCELLED_SESSIONS.lock().expect("CANCELLED_SESSIONS lock");
    g.insert(session_id.to_string());
    eprintln!("[input.rs] Session {} marked as cancelled", session_id);
}

/// Check if a mobile job session has been cancelled
pub fn is_session_cancelled(session_id: &str) -> bool {
    let g = CANCELLED_SESSIONS.lock().expect("CANCELLED_SESSIONS lock");
    g.contains(session_id)
}

/// Remove a session from the cancelled set (cleanup after job finishes)
pub fn clear_cancelled_session(session_id: &str) {
    let mut g = CANCELLED_SESSIONS.lock().expect("CANCELLED_SESSIONS lock");
    g.remove(session_id);
}

#[derive(Debug)]
pub struct EmulatorInputSession {
    pub adb: PathBuf,
    pub serial: String,
    pub device_w: u32,
    pub device_h: u32,
    pub stream_config: EmulatorStreamConfig,
    pub grpc_frame_size: Option<(u32, u32)>,
    /// Persistent adb shell process for low-latency input
    shell_proc: Option<Arc<TokioMutex<PersistentShell>>>,
}

impl Clone for EmulatorInputSession {
    fn clone(&self) -> Self {
        Self {
            adb: self.adb.clone(),
            serial: self.serial.clone(),
            device_w: self.device_w,
            device_h: self.device_h,
            stream_config: self.stream_config.clone(),
            grpc_frame_size: self.grpc_frame_size,
            shell_proc: self.shell_proc.clone(),
        }
    }
}

/// A persistent adb shell process for low-latency command execution
struct PersistentShell {
    stdin: ChildStdin,
    #[allow(dead_code)]
    child: Child,
}

impl std::fmt::Debug for PersistentShell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistentShell").finish_non_exhaustive()
    }
}

impl PersistentShell {
    async fn new(adb: &PathBuf, serial: &str) -> Result<Self> {
        let mut child = Command::new(adb)
            .args(["-s", serial, "shell"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("failed to spawn persistent adb shell")?;
        
        let stdin = child.stdin.take().context("failed to get stdin")?;
        Ok(Self { stdin, child })
    }

    async fn send_command(&mut self, cmd: &str) -> Result<()> {
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

lazy_static! {
    static ref SESSIONS: Mutex<HashMap<String, EmulatorInputSession>> = Mutex::new(HashMap::new());
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorInputMessage {
    pub session_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub duration_ms: Option<u64>,
    pub text: Option<String>,
    pub keycode: Option<String>,

    // Optional client geometry (strongly recommended).
    pub view_w: Option<f64>,
    pub view_h: Option<f64>,
    pub video_w: Option<f64>,
    pub video_h: Option<f64>,
}

pub async fn register_session(
    session_id: &str,
    adb: PathBuf,
    serial: String,
    stream_config: EmulatorStreamConfig,
) -> Result<()> {
    let (w, h) = query_device_size(&adb, &serial).await?;
    
    // Create a persistent shell for low-latency input
    let shell_proc = match PersistentShell::new(&adb, &serial).await {
        Ok(shell) => {
            eprintln!("[input.rs] Created persistent shell for session {}", session_id);
            Some(Arc::new(TokioMutex::new(shell)))
        }
        Err(e) => {
            eprintln!("[input.rs] Failed to create persistent shell, falling back to per-command mode: {}", e);
            None
        }
    };
    
    let mut g = SESSIONS.lock().expect("SESSIONS lock");
    g.insert(
        session_id.to_string(),
        EmulatorInputSession {
            adb,
            serial,
            device_w: w,
            device_h: h,
            stream_config,
            grpc_frame_size: None,
            shell_proc,
        },
    );
    Ok(())
}

pub fn unregister_session_sync(session_id: &str) {
    let mut g = SESSIONS.lock().expect("SESSIONS lock");
    g.remove(session_id);
}

pub fn update_grpc_frame_size(session_id: &str, width: u32, height: u32) {
    let mut g = SESSIONS.lock().expect("SESSIONS lock");
    if let Some(session) = g.get_mut(session_id) {
        session.grpc_frame_size = Some((width, height));
    }
}

pub async fn handle_input_message(msg: EmulatorInputMessage) -> Result<()> {
    let sid = msg
        .session_id
        .as_deref()
        .context("emulator input missing sessionId")?;

    let session = {
        let g = SESSIONS.lock().expect("SESSIONS lock");
        g.get(sid)
            .cloned()
            .with_context(|| format!("no emulator input session registered for {}", sid))?
    };

    if session.stream_config.mode == EmulatorStreamMode::Grpc {
        if let Err(err) = handle_input_grpc(&msg, &session).await {
            eprintln!("[input.rs] gRPC input failed; falling back to ADB: {:#}", err);
            handle_input_adb(&msg, &session).await?;
        }
        return Ok(());
    }

    handle_input_adb(&msg, &session).await
}

async fn handle_input_grpc(
    msg: &EmulatorInputMessage,
    session: &EmulatorInputSession,
) -> Result<()> {
    let (frame_w, frame_h) = session
        .grpc_frame_size
        .context("gRPC frame size unavailable for input mapping")?;

    match msg.kind.as_str() {
        "tap" => {
            let (x, y) = map_point(msg, frame_w, frame_h)?;
            emulator_grpc::inject_tap(&session.stream_config.grpc, x, y).await?;
        }
        "swipe" => {
            let (x1, y1) = map_point(msg, frame_w, frame_h)?;
            let (x2, y2) = map_point2(msg, frame_w, frame_h)?;
            let dur = msg.duration_ms.unwrap_or(250);
            emulator_grpc::inject_swipe(&session.stream_config.grpc, x1, y1, x2, y2, dur).await?;
        }
        "key" => {
            let kc = msg
                .keycode
                .as_deref()
                .context("key event missing keycode")?;
            let kc = if kc.starts_with("KEYCODE_") { kc.to_string() } else { format!("KEYCODE_{}", kc) };
            emulator_grpc::inject_key(&session.stream_config.grpc, &kc).await?;
        }
        "text" => {
            let text = msg.text.clone().unwrap_or_default();
            emulator_grpc::inject_text(&session.stream_config.grpc, &text).await?;
        }
        "rotate" => {
            anyhow::bail!("rotate not implemented via gRPC");
        }
        _ => {
            anyhow::bail!("unknown emulator input type: {}", msg.kind);
        }
    }

    Ok(())
}

async fn handle_input_adb(msg: &EmulatorInputMessage, session: &EmulatorInputSession) -> Result<()> {
    // Use persistent shell for low-latency input when available
    let use_persistent = session.shell_proc.is_some();

    match msg.kind.as_str() {
        "tap" => {
            let (x, y) = map_point(msg, session.device_w, session.device_h)?;
            let cmd = format!("input tap {} {}", x, y);
            if use_persistent {
                let shell = session.shell_proc.as_ref().unwrap();
                let mut shell_guard = shell.lock().await;
                shell_guard.send_command(&cmd).await?;
            } else {
                adb_shell(
                    &session.adb,
                    &session.serial,
                    &["input", "tap", &x.to_string(), &y.to_string()],
                )
                .await?;
            }
        }
        "swipe" => {
            let (x1, y1) = map_point(msg, session.device_w, session.device_h)?;
            let (x2, y2) = map_point2(msg, session.device_w, session.device_h)?;
            let dur = msg.duration_ms.unwrap_or(250);
            let cmd = format!("input swipe {} {} {} {} {}", x1, y1, x2, y2, dur);
            if use_persistent {
                let shell = session.shell_proc.as_ref().unwrap();
                let mut shell_guard = shell.lock().await;
                shell_guard.send_command(&cmd).await?;
            } else {
                adb_shell(
                    &session.adb,
                    &session.serial,
                    &[
                        "input",
                        "swipe",
                        &x1.to_string(),
                        &y1.to_string(),
                        &x2.to_string(),
                        &y2.to_string(),
                        &dur.to_string(),
                    ],
                )
                .await?;
            }
        }
        "key" => {
            let kc = msg
                .keycode
                .as_deref()
                .context("key event missing keycode")?;
            let kc = if kc.starts_with("KEYCODE_") { kc.to_string() } else { format!("KEYCODE_{}", kc) };
            let cmd = format!("input keyevent {}", kc);
            if use_persistent {
                let shell = session.shell_proc.as_ref().unwrap();
                let mut shell_guard = shell.lock().await;
                shell_guard.send_command(&cmd).await?;
            } else {
                adb_shell(&session.adb, &session.serial, &["input", "keyevent", &kc]).await?;
            }
        }
        "text" => {
            let text = msg.text.clone().unwrap_or_default();
            // Text input needs special quoting, use fallback method
            adb_shell_text(&session.adb, &session.serial, &text).await?;
        }
        "rotate" => {
            rotate_device(&session.adb, &session.serial).await?;
        }
        _ => {
            anyhow::bail!("unknown emulator input type: {}", msg.kind);
        }
    }

    Ok(())
}

async fn rotate_device(adb: &PathBuf, serial: &str) -> Result<()> {
    // Best-effort rotation: lock rotation (disable accelerometer) and advance user_rotation.
    // 0=0°, 1=90°, 2=180°, 3=270°
    let cur = adb_shell_output(adb, serial, &["settings", "get", "system", "user_rotation"]).await?;
    let cur = cur.trim().parse::<i32>().unwrap_or(0).rem_euclid(4);
    let next = (cur + 1).rem_euclid(4);

    adb_shell(adb, serial, &["settings", "put", "system", "accelerometer_rotation", "0"]).await?;
    adb_shell(adb, serial, &["settings", "put", "system", "user_rotation", &next.to_string()]).await?;
    Ok(())
}

fn map_point(msg: &EmulatorInputMessage, target_w: u32, target_h: u32) -> Result<(u32, u32)> {
    let x = msg.x.context("tap/swipe missing x")?;
    let y = msg.y.context("tap/swipe missing y")?;
    map_xy(msg, x, y, target_w, target_h)
}

fn map_point2(msg: &EmulatorInputMessage, target_w: u32, target_h: u32) -> Result<(u32, u32)> {
    let x = msg.x2.context("swipe missing x2")?;
    let y = msg.y2.context("swipe missing y2")?;
    map_xy(msg, x, y, target_w, target_h)
}

fn map_xy(
    msg: &EmulatorInputMessage,
    x: f64,
    y: f64,
    target_w: u32,
    target_h: u32,
) -> Result<(u32, u32)> {
    // Default assumption if client doesn't send geometry:
    // coordinates are already in device pixels.
    let Some(view_w) = msg.view_w else {
        return Ok((x.round().clamp(0.0, target_w as f64) as u32, y.round().clamp(0.0, target_h as f64) as u32));
    };
    let Some(view_h) = msg.view_h else {
        return Ok((x.round().clamp(0.0, target_w as f64) as u32, y.round().clamp(0.0, target_h as f64) as u32));
    };

    let video_w = msg.video_w.unwrap_or(target_w as f64).max(1.0);
    let video_h = msg.video_h.unwrap_or(target_h as f64).max(1.0);

    // object-fit: contain letterboxing model
    let scale = (view_w / video_w).min(view_h / video_h).max(1e-6);
    let content_w = video_w * scale;
    let content_h = video_h * scale;
    let off_x = (view_w - content_w) / 2.0;
    let off_y = (view_h - content_h) / 2.0;

    let nx = ((x - off_x) / content_w).clamp(0.0, 1.0);
    let ny = ((y - off_y) / content_h).clamp(0.0, 1.0);

    let dx = (nx * target_w as f64).round().clamp(0.0, target_w as f64);
    let dy = (ny * target_h as f64).round().clamp(0.0, target_h as f64);
    Ok((dx as u32, dy as u32))
}

async fn adb_shell(adb: &PathBuf, serial: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(adb)
        .args(["-s", serial, "shell"])
        .args(args)
        .status()
        .await
        .context("failed to run adb shell")?;
    if !status.success() {
        anyhow::bail!("adb shell failed: {:?}", status.code());
    }
    Ok(())
}

async fn adb_shell_output(adb: &PathBuf, serial: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(adb)
        .args(["-s", serial, "shell"])
        .args(args)
        .output()
        .await
        .context("failed to run adb shell (output)")?;
    if !out.status.success() {
        anyhow::bail!("adb shell (output) failed: {:?}", out.status.code());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn adb_shell_text(adb: &PathBuf, serial: &str, text: &str) -> Result<()> {
    // Use sh -c with single-quoted argument to preserve spaces and most punctuation.
    // This avoids the brittle %s encoding behavior of `input text`.
    let quoted = shell_single_quote(text);
    let cmd = format!("input text {}", quoted);

    let status = Command::new(adb)
        .args(["-s", serial, "shell", "sh", "-c", &cmd])
        .status()
        .await
        .context("failed to run adb shell sh -c")?;
    if !status.success() {
        anyhow::bail!("adb input text failed: {:?}", status.code());
    }
    Ok(())
}

fn shell_single_quote(s: &str) -> String {
    // POSIX sh single-quote escaping: close, escape, reopen.
    // abc'def -> 'abc'\''def'
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

pub async fn query_device_size(adb: &PathBuf, serial: &str) -> Result<(u32, u32)> {
    // Prefer: adb shell wm size
    let out = Command::new(adb)
        .args(["-s", serial, "shell", "wm", "size"])
        .output()
        .await
        .context("adb shell wm size failed")?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let re = Regex::new(r"(Physical size:|Override size:)?\s*(\d+)x(\d+)")
        .expect("regex");
    if let Some(c) = re.captures(&stdout) {
        let w: u32 = c.get(2).unwrap().as_str().parse().unwrap_or(0);
        let h: u32 = c.get(3).unwrap().as_str().parse().unwrap_or(0);
        if w > 0 && h > 0 {
            return Ok((w, h));
        }
    }

    // Fallback: dumpsys display
    let out = Command::new(adb)
        .args(["-s", serial, "shell", "dumpsys", "display"])
        .output()
        .await
        .context("adb shell dumpsys display failed")?;
    let stdout = String::from_utf8_lossy(&out.stdout);

    // Try common patterns: "mBaseDisplayInfo=DisplayInfo{" ... " real 1080 x 1920,".
    let re2 = Regex::new(r"real\s+(\d+)\s*x\s*(\d+)").expect("regex");
    if let Some(c) = re2.captures(&stdout) {
        let w: u32 = c.get(1).unwrap().as_str().parse().unwrap_or(0);
        let h: u32 = c.get(2).unwrap().as_str().parse().unwrap_or(0);
        if w > 0 && h > 0 {
            return Ok((w, h));
        }
    }

    anyhow::bail!("failed to determine device size")
}
