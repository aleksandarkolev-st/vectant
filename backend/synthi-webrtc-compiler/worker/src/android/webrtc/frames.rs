use anyhow::{bail, Context, Result};
use image::imageops::FilterType;
use image::GenericImageView;
use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::timeout;

pub fn compress_frame_for_preview(png: &[u8]) -> Result<(String, Vec<u8>)> {
    // Convert PNG -> low-res JPEG to dramatically reduce payload size.
    // If decoding fails for any reason, fall back to the original PNG bytes.
    let img = match image::load_from_memory(png) {
        Ok(i) => i,
        Err(_) => return Ok(("image/png".to_string(), png.to_vec())),
    };

    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Ok(("image/png".to_string(), png.to_vec()));
    }

    // Target a small width so the base64 JSON stays under typical RTC limits.
    // Keep aspect ratio.
    let target_w: u32 = 320;
    let scale = (target_w as f32 / w as f32).min(1.0);
    let new_w = ((w as f32) * scale).round().max(1.0) as u32;
    let new_h = ((h as f32) * scale).round().max(1.0) as u32;
    let resized = img.resize(new_w, new_h, FilterType::Triangle);

    let mut out: Vec<u8> = Vec::with_capacity((png.len() / 4).max(16 * 1024));
    let mut cur = Cursor::new(&mut out);
    // Use JPEG for size. Default quality from image crate is fine for preview.
    resized
        .write_to(&mut cur, image::ImageFormat::Jpeg)
        .context("failed to encode jpeg")?;

    Ok(("image/jpeg".to_string(), out))
}

pub async fn capture_screencap_png(adb: &PathBuf, serial: &str) -> Result<Vec<u8>> {
    // `exec-out` returns raw bytes on stdout. This is the simplest way to capture
    // pixels without needing shared folders, framebuffer access, or a video pipeline.
    let out = timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(adb)
            .args(["-s", serial, "exec-out", "screencap", "-p"])
            .output(),
    )
    .await
    .context("screencap timeout")?
    .context("Failed to run adb exec-out screencap")?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!(
            "adb screencap failed (status={:?}) stderr={}",
            out.status.code(),
            stderr
        );
    }

    // Basic PNG signature check.
    // Note: some adb builds can emit extra text before the binary payload (rare), so we
    // search for the PNG signature and slice from there.
    const PNG_SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if out.stdout.len() >= PNG_SIG.len() {
        if &out.stdout[..PNG_SIG.len()] == PNG_SIG {
            return Ok(out.stdout);
        }
        if let Some(idx) = out.stdout.windows(PNG_SIG.len()).position(|w| w == PNG_SIG) {
            return Ok(out.stdout[idx..].to_vec());
        }
    }

    bail!(
        "adb screencap did not return PNG bytes (len={})",
        out.stdout.len()
    );
}
