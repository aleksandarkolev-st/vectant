use anyhow::{anyhow, bail, Context, Result};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tonic::transport::{Channel, Endpoint};
use tonic::Request;

use crate::android::webrtc::EmulatorGrpcConfig;

#[cfg(not(synthi_no_protoc))]
pub mod generated {
    tonic::include_proto!("android.emulation.control");
}

#[cfg(synthi_no_protoc)]
pub mod generated {
    #[derive(Clone, Debug, Default)]
    pub struct Placeholder {}
}

#[derive(Debug, Clone)]
pub struct EmulatorGrpcClients {
    channel: Channel,
}

#[derive(Debug, Clone)]
pub struct EmulatorFrame {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub data: Vec<u8>,
    pub timestamp_ns: Option<u64>,
}

impl EmulatorGrpcClients {
    pub async fn connect(cfg: &EmulatorGrpcConfig) -> Result<Self> {
        let endpoint = format!("http://{}:{}", cfg.host, cfg.port);
        let channel = Endpoint::from_shared(endpoint)
            .context("invalid gRPC endpoint")?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(5))
            .connect()
            .await
            .context("failed to connect to emulator gRPC endpoint")?;

        // TODO: Apply token auth once the emulator gRPC auth mechanism is wired.
        let _ = cfg.use_token;
        let _ = cfg.token_path.as_deref();

        Ok(Self { channel })
    }

    pub fn display_client(&self) -> Result<()> {
        // TODO: Replace with real display stream client once proto services are available.
        let _ = &self.channel;
        bail!("TODO: emulator gRPC display client is not wired yet");
    }

    pub fn input_client(&self) -> Result<()> {
        // TODO: Replace with real input/control client once proto services are available.
        let _ = &self.channel;
        bail!("TODO: emulator gRPC input client is not wired yet");
    }
}

async fn connect_controller(cfg: &EmulatorGrpcConfig) -> Result<generated::emulator_controller_client::EmulatorControllerClient<Channel>> {
    let endpoint = format!("http://{}:{}", cfg.host, cfg.port);
    let channel = Endpoint::from_shared(endpoint)
        .context("invalid gRPC endpoint")?
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .connect()
        .await
        .context("failed to connect to emulator gRPC endpoint")?;

    // TODO: Apply token auth once the emulator gRPC auth mechanism is wired.
    let _ = cfg.use_token;
    let _ = cfg.token_path.as_deref();

    Ok(generated::emulator_controller_client::EmulatorControllerClient::new(channel))
}

pub async fn stream_frames(cfg: &EmulatorGrpcConfig) -> Result<mpsc::UnboundedReceiver<EmulatorFrame>> {
    let mut client = connect_controller(cfg).await?;

    let format = generated::ImageFormat {
        format: generated::image_format::ImgFormat::Rgba8888 as i32,
        rotation: None,
        width: 0,
        height: 0,
        display: 0,
        transport: None,
        folded_display: None,
        display_mode: None,
    };

    let response = client
        .stream_screenshot(Request::new(format))
        .await
        .context("streamScreenshot RPC failed")?;

    let mut stream = response.into_inner();
    let (tx, rx) = mpsc::unbounded_channel::<EmulatorFrame>();

    tokio::spawn(async move {
        let mut last_seq: Option<u32> = None;
        while let Ok(Some(image)) = stream.message().await {
            if let Some(seq) = if image.seq > 0 { Some(image.seq) } else { None } {
                if let Some(prev) = last_seq {
                    if seq > prev + 1 {
                        eprintln!("[grpc] screenshot stream dropped frames: prev={} current={}", prev, seq);
                    }
                }
                last_seq = Some(seq);
            }

            let mut width = 0u32;
            let mut height = 0u32;
            let mut format = "RGBA".to_string();

            if let Some(fmt) = image.format.as_ref() {
                if fmt.width > 0 {
                    width = fmt.width;
                }
                if fmt.height > 0 {
                    height = fmt.height;
                }
                match generated::image_format::ImgFormat::from_i32(fmt.format)
                    .unwrap_or(generated::image_format::ImgFormat::Png)
                {
                    generated::image_format::ImgFormat::Rgba8888 => format = "RGBA".to_string(),
                    generated::image_format::ImgFormat::Rgb888 => format = "RGB".to_string(),
                    generated::image_format::ImgFormat::Png => format = "PNG".to_string(),
                }
            }

            if width == 0 {
                width = image.width;
            }
            if height == 0 {
                height = image.height;
            }

            if image.image.is_empty() {
                continue;
            }

            if format != "RGBA" {
                eprintln!("[grpc] unsupported image format: {}", format);
                continue;
            }

            if width == 0 || height == 0 {
                eprintln!("[grpc] missing image dimensions; skipping frame");
                continue;
            }

            let timestamp_ns = if image.timestamp_us > 0 {
                Some(image.timestamp_us.saturating_mul(1000))
            } else {
                None
            };

            let frame = EmulatorFrame {
                width,
                height,
                format,
                data: image.image,
                timestamp_ns,
            };

            if tx.send(frame).is_err() {
                break;
            }
        }
    });

    Ok(rx)
}

pub async fn inject_tap(_cfg: &EmulatorGrpcConfig, _x: u32, _y: u32) -> Result<()> {
    let mut client = connect_controller(_cfg).await?;
    let identifier = 0;
    let down = generated::Touch {
        x: _x as i32,
        y: _y as i32,
        identifier,
        pressure: 1,
        touch_major: 0,
        touch_minor: 0,
        expiration: generated::touch::EventExpiration::EventExpirationUnspecified as i32,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![down],
        display: 0,
    };
    client.send_touch(Request::new(event)).await?;

    sleep(Duration::from_millis(40)).await;

    let up = generated::Touch {
        x: _x as i32,
        y: _y as i32,
        identifier,
        pressure: 0,
        touch_major: 0,
        touch_minor: 0,
        expiration: generated::touch::EventExpiration::EventExpirationUnspecified as i32,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![up],
        display: 0,
    };
    client.send_touch(Request::new(event)).await?;

    Ok(())
}

pub async fn inject_swipe(
    cfg: &EmulatorGrpcConfig,
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    duration_ms: u64,
) -> Result<()> {
    let mut client = connect_controller(cfg).await?;
    let identifier = 0;
    let steps = (duration_ms / 16).max(1).min(30) as u32;
    let delay = if steps > 0 {
        Duration::from_millis((duration_ms / steps as u64).max(5))
    } else {
        Duration::from_millis(16)
    };

    let down = generated::Touch {
        x: x1 as i32,
        y: y1 as i32,
        identifier,
        pressure: 1,
        touch_major: 0,
        touch_minor: 0,
        expiration: generated::touch::EventExpiration::EventExpirationUnspecified as i32,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![down],
        display: 0,
    };
    client.send_touch(Request::new(event)).await?;

    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let xi = (x1 as f64 + (x2 as f64 - x1 as f64) * t).round() as i32;
        let yi = (y1 as f64 + (y2 as f64 - y1 as f64) * t).round() as i32;
        let move_evt = generated::Touch {
            x: xi,
            y: yi,
            identifier,
            pressure: 1,
            touch_major: 0,
            touch_minor: 0,
            expiration: generated::touch::EventExpiration::EventExpirationUnspecified as i32,
            orientation: 0,
        };
        let event = generated::TouchEvent {
            touches: vec![move_evt],
            display: 0,
        };
        client.send_touch(Request::new(event)).await?;
        sleep(delay).await;
    }

    let up = generated::Touch {
        x: x2 as i32,
        y: y2 as i32,
        identifier,
        pressure: 0,
        touch_major: 0,
        touch_minor: 0,
        expiration: generated::touch::EventExpiration::EventExpirationUnspecified as i32,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![up],
        display: 0,
    };
    client.send_touch(Request::new(event)).await?;

    Ok(())
}

pub async fn inject_key(cfg: &EmulatorGrpcConfig, keycode: &str) -> Result<()> {
    let mapped = map_keycode_to_w3c(keycode)
        .ok_or_else(|| anyhow!("unsupported keycode for gRPC: {}", keycode))?;

    let mut client = connect_controller(cfg).await?;
    let event = generated::KeyboardEvent {
        code_type: generated::keyboard_event::KeyCodeType::Usb as i32,
        event_type: generated::keyboard_event::KeyEventType::Keypress as i32,
        key_code: 0,
        key: mapped,
        text: String::new(),
    };
    client.send_key(Request::new(event)).await?;

    Ok(())
}

pub async fn inject_text(cfg: &EmulatorGrpcConfig, text: &str) -> Result<()> {
    let mut client = connect_controller(cfg).await?;
    let event = generated::KeyboardEvent {
        code_type: generated::keyboard_event::KeyCodeType::Usb as i32,
        event_type: generated::keyboard_event::KeyEventType::Keypress as i32,
        key_code: 0,
        key: String::new(),
        text: text.to_string(),
    };
    client.send_key(Request::new(event)).await?;
    Ok(())
}

pub fn grpc_codegen_available() -> bool {
    !cfg!(synthi_no_protoc)
}

fn map_keycode_to_w3c(keycode: &str) -> Option<String> {
    let kc = keycode.trim().to_uppercase();
    let key = match kc.as_str() {
        "KEYCODE_BACK" => "GoBack",
        "KEYCODE_HOME" => "GoHome",
        "KEYCODE_APP_SWITCH" => "AppSwitch",
        "KEYCODE_ENTER" => "Enter",
        "KEYCODE_DEL" => "Backspace",
        "KEYCODE_TAB" => "Tab",
        "KEYCODE_ESCAPE" => "Escape",
        "KEYCODE_DPAD_UP" => "ArrowUp",
        "KEYCODE_DPAD_DOWN" => "ArrowDown",
        "KEYCODE_DPAD_LEFT" => "ArrowLeft",
        "KEYCODE_DPAD_RIGHT" => "ArrowRight",
        "KEYCODE_SPACE" => " ",
        _ => return None,
    };
    Some(key.to_string())
}
