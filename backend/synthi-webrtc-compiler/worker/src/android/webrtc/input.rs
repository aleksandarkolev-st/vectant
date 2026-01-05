use anyhow::{Context, Result};
use lazy_static::lazy_static;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct EmulatorInputSession {
    pub adb: PathBuf,
    pub serial: String,
    pub device_w: u32,
    pub device_h: u32,
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

pub async fn register_session(session_id: &str, adb: PathBuf, serial: String) -> Result<()> {
    let (w, h) = query_device_size(&adb, &serial).await?;
    let mut g = SESSIONS.lock().expect("SESSIONS lock");
    g.insert(
        session_id.to_string(),
        EmulatorInputSession {
            adb,
            serial,
            device_w: w,
            device_h: h,
        },
    );
    Ok(())
}

pub fn unregister_session_sync(session_id: &str) {
    let mut g = SESSIONS.lock().expect("SESSIONS lock");
    g.remove(session_id);
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

    match msg.kind.as_str() {
        "tap" => {
            let (x, y) = map_point(&msg, session.device_w, session.device_h)?;
            adb_shell(
                &session.adb,
                &session.serial,
                &["input", "tap", &x.to_string(), &y.to_string()],
            )
            .await?;
        }
        "swipe" => {
            let (x1, y1) = map_point(&msg, session.device_w, session.device_h)?;
            let (x2, y2) = map_point2(&msg, session.device_w, session.device_h)?;
            let dur = msg.duration_ms.unwrap_or(250).to_string();
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
                    &dur,
                ],
            )
            .await?;
        }
        "key" => {
            let kc = msg
                .keycode
                .as_deref()
                .context("key event missing keycode")?;
            let kc = if kc.starts_with("KEYCODE_") { kc.to_string() } else { format!("KEYCODE_{}", kc) };
            adb_shell(&session.adb, &session.serial, &["input", "keyevent", &kc]).await?;
        }
        "text" => {
            let text = msg.text.unwrap_or_default();
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

fn map_point(msg: &EmulatorInputMessage, device_w: u32, device_h: u32) -> Result<(u32, u32)> {
    let x = msg.x.context("tap/swipe missing x")?;
    let y = msg.y.context("tap/swipe missing y")?;
    map_xy(msg, x, y, device_w, device_h)
}

fn map_point2(msg: &EmulatorInputMessage, device_w: u32, device_h: u32) -> Result<(u32, u32)> {
    let x = msg.x2.context("swipe missing x2")?;
    let y = msg.y2.context("swipe missing y2")?;
    map_xy(msg, x, y, device_w, device_h)
}

fn map_xy(
    msg: &EmulatorInputMessage,
    x: f64,
    y: f64,
    device_w: u32,
    device_h: u32,
) -> Result<(u32, u32)> {
    // Default assumption if client doesn't send geometry:
    // coordinates are already in device pixels.
    let Some(view_w) = msg.view_w else {
        return Ok((x.round().clamp(0.0, device_w as f64) as u32, y.round().clamp(0.0, device_h as f64) as u32));
    };
    let Some(view_h) = msg.view_h else {
        return Ok((x.round().clamp(0.0, device_w as f64) as u32, y.round().clamp(0.0, device_h as f64) as u32));
    };

    let video_w = msg.video_w.unwrap_or(device_w as f64).max(1.0);
    let video_h = msg.video_h.unwrap_or(device_h as f64).max(1.0);

    // object-fit: contain letterboxing model
    let scale = (view_w / video_w).min(view_h / video_h).max(1e-6);
    let content_w = video_w * scale;
    let content_h = video_h * scale;
    let off_x = (view_w - content_w) / 2.0;
    let off_y = (view_h - content_h) / 2.0;

    let nx = ((x - off_x) / content_w).clamp(0.0, 1.0);
    let ny = ((y - off_y) / content_h).clamp(0.0, 1.0);

    let dx = (nx * device_w as f64).round().clamp(0.0, device_w as f64);
    let dy = (ny * device_h as f64).round().clamp(0.0, device_h as f64);
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
