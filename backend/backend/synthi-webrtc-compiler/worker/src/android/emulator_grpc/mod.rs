use anyhow::{anyhow, bail, Context, Result};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tonic::metadata::MetadataValue;
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

        if cfg.use_token {
            let _ = read_grpc_token(cfg)?;
        }

        Ok(Self { channel })
    }

    #[cfg(not(synthi_no_protoc))]
    pub fn display_client(
        &self,
    ) -> Result<generated::emulator_controller_client::EmulatorControllerClient<Channel>> {
        Ok(
            generated::emulator_controller_client::EmulatorControllerClient::new(
                self.channel.clone(),
            )
            .max_decoding_message_size(16 * 1024 * 1024),
        )
    }

    #[cfg(synthi_no_protoc)]
    pub fn display_client(&self) -> Result<generated::Placeholder> {
        bail!("emulator gRPC codegen unavailable (protoc missing)");
    }

    #[cfg(not(synthi_no_protoc))]
    pub fn input_client(
        &self,
    ) -> Result<generated::emulator_controller_client::EmulatorControllerClient<Channel>> {
        Ok(
            generated::emulator_controller_client::EmulatorControllerClient::new(
                self.channel.clone(),
            )
            .max_decoding_message_size(16 * 1024 * 1024),
        )
    }

    #[cfg(synthi_no_protoc)]
    pub fn input_client(&self) -> Result<generated::Placeholder> {
        bail!("emulator gRPC codegen unavailable (protoc missing)");
    }
}

#[cfg(not(synthi_no_protoc))]
async fn connect_controller(
    cfg: &EmulatorGrpcConfig,
) -> Result<generated::emulator_controller_client::EmulatorControllerClient<Channel>> {
    let endpoint = format!("http://{}:{}", cfg.host, cfg.port);
    // Note: Do NOT apply a global timeout here as it affects streaming RPC calls.
    // Individual streaming calls manage their own timeouts via keep-alive and other mechanisms.
    let channel = Endpoint::from_shared(endpoint)
        .context("invalid gRPC endpoint")?
        .connect_timeout(Duration::from_secs(5))
        .connect()
        .await
        .context("failed to connect to emulator gRPC endpoint")?;

    if cfg.use_token {
        let _ = read_grpc_token(cfg)?;
    }

    Ok(
        generated::emulator_controller_client::EmulatorControllerClient::new(channel)
            .max_decoding_message_size(16 * 1024 * 1024),
    )
}

#[cfg(synthi_no_protoc)]
async fn connect_controller(_cfg: &EmulatorGrpcConfig) -> Result<generated::Placeholder> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

#[cfg(not(synthi_no_protoc))]
pub async fn stream_frames(
    cfg: &EmulatorGrpcConfig,
) -> Result<mpsc::UnboundedReceiver<EmulatorFrame>> {
    let token = read_grpc_token(cfg)?;
    let mut client = connect_controller(cfg).await?;

    let format = generated::ImageFormat {
        format: generated::image_format::ImgFormat::Rgb888 as i32,
        rotation: None,
        width: cfg.target_width.unwrap_or(0),
        height: cfg.target_height.unwrap_or(0),
        display: 0,
        transport: Some(generated::ImageTransport {
            channel: 0,
            handle: String::new(),
        }),
        folded_display: None,
        display_mode: 0,
    };

    let mut request = Request::new(format);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    let response = client
        .stream_screenshot(request)
        .await
        .context("streamScreenshot RPC failed")?;

    let mut stream = response.into_inner();
    let (tx, rx) = mpsc::unbounded_channel::<EmulatorFrame>();

    tokio::spawn(async move {
        // Start with a small flush to ensure no stale data in channel? Not needed as it is new.
        eprintln!("[grpc] stream_frames task started");

        let mut last_seq: Option<u32> = None;
        loop {
            match stream.message().await {
                Ok(Some(image)) => {
                    let seq = image.seq;
                    if let Some(s) = if seq > 0 { Some(seq) } else { None } {
                        if let Some(prev) = last_seq {
                            if s > prev + 1 {
                                eprintln!(
                                    "[grpc] screenshot stream dropped frames: prev={} current={}",
                                    prev, s
                                );
                            }
                        }
                        last_seq = Some(s);
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
                            generated::image_format::ImgFormat::Rgba8888 => {
                                format = "RGBA".to_string()
                            }
                            generated::image_format::ImgFormat::Rgb888 => {
                                format = "RGB".to_string()
                            }
                            // Some emulators return generic "Raw" or other types, but if width*height*3 == size, it's RGB.
                            // We will default to RGB if it's ambiguous but size matches.
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

                    // if format != "RGBA" {
                    //     eprintln!("[grpc] unsupported image format: {}", format);
                    //     continue;
                    // }

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
                        eprintln!("[grpc] frame receiver dropped, stopping stream");
                        break;
                    }
                }
                Ok(None) => {
                    eprintln!("[grpc] stream ended normally");
                    break;
                }
                Err(e) => {
                    eprintln!("[grpc] stream error: {:#}", e);
                    break;
                }
            }
        }
    });

    Ok(rx)
}

#[cfg(synthi_no_protoc)]
pub async fn stream_frames(
    _cfg: &EmulatorGrpcConfig,
) -> Result<mpsc::UnboundedReceiver<EmulatorFrame>> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

#[cfg(not(synthi_no_protoc))]
pub async fn inject_tap(_cfg: &EmulatorGrpcConfig, _x: u32, _y: u32) -> Result<()> {
    let token = read_grpc_token(_cfg)?;
    let mut client = connect_controller(_cfg).await?;
    let identifier = 0;
    let down = generated::Touch {
        x: _x as i32,
        y: _y as i32,
        identifier,
        pressure: 1,
        touch_major: 0,
        touch_minor: 0,
        expiration: 0,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![down],
        display: 0,
    };
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_touch(request).await?;

    sleep(Duration::from_millis(40)).await;

    let up = generated::Touch {
        x: _x as i32,
        y: _y as i32,
        identifier,
        pressure: 0,
        touch_major: 0,
        touch_minor: 0,
        expiration: 0,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![up],
        display: 0,
    };
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_touch(request).await?;

    Ok(())
}

#[cfg(synthi_no_protoc)]
pub async fn inject_tap(_cfg: &EmulatorGrpcConfig, _x: u32, _y: u32) -> Result<()> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

#[cfg(not(synthi_no_protoc))]
pub async fn inject_swipe(
    cfg: &EmulatorGrpcConfig,
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    duration_ms: u64,
) -> Result<()> {
    let token = read_grpc_token(cfg)?;
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
        expiration: 0,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![down],
        display: 0,
    };
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_touch(request).await?;

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
            expiration: 0,
            orientation: 0,
        };
        let event = generated::TouchEvent {
            touches: vec![move_evt],
            display: 0,
        };
        let mut request = Request::new(event);
        if let Some(token) = token.as_deref() {
            apply_grpc_token(&mut request, token)?;
        }
        client.send_touch(request).await?;
        sleep(delay).await;
    }

    let up = generated::Touch {
        x: x2 as i32,
        y: y2 as i32,
        identifier,
        pressure: 0,
        touch_major: 0,
        touch_minor: 0,
        expiration: 0,
        orientation: 0,
    };
    let event = generated::TouchEvent {
        touches: vec![up],
        display: 0,
    };
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_touch(request).await?;

    Ok(())
}

#[cfg(synthi_no_protoc)]
pub async fn inject_swipe(
    _cfg: &EmulatorGrpcConfig,
    _x1: u32,
    _y1: u32,
    _x2: u32,
    _y2: u32,
    _duration_ms: u64,
) -> Result<()> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

#[cfg(not(synthi_no_protoc))]
pub async fn inject_key(cfg: &EmulatorGrpcConfig, keycode: &str) -> Result<()> {
    let token = read_grpc_token(cfg)?;
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
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_key(request).await?;

    Ok(())
}

#[cfg(synthi_no_protoc)]
pub async fn inject_key(_cfg: &EmulatorGrpcConfig, _keycode: &str) -> Result<()> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

#[cfg(not(synthi_no_protoc))]
pub async fn inject_text(cfg: &EmulatorGrpcConfig, text: &str) -> Result<()> {
    let token = read_grpc_token(cfg)?;
    let mut client = connect_controller(cfg).await?;
    let event = generated::KeyboardEvent {
        code_type: generated::keyboard_event::KeyCodeType::Usb as i32,
        event_type: generated::keyboard_event::KeyEventType::Keypress as i32,
        key_code: 0,
        key: String::new(),
        text: text.to_string(),
    };
    let mut request = Request::new(event);
    if let Some(token) = token.as_deref() {
        apply_grpc_token(&mut request, token)?;
    }
    client.send_key(request).await?;
    Ok(())
}

#[cfg(synthi_no_protoc)]
pub async fn inject_text(_cfg: &EmulatorGrpcConfig, _text: &str) -> Result<()> {
    bail!("emulator gRPC codegen unavailable (protoc missing)");
}

pub fn grpc_codegen_available() -> bool {
    !cfg!(synthi_no_protoc)
}

fn read_grpc_token(cfg: &EmulatorGrpcConfig) -> Result<Option<String>> {
    if !cfg.use_token {
        return Ok(None);
    }

    let token_path = cfg.token_path.clone().or_else(|| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()?;
        Some(format!(
            "{}/.emulator_console_auth_token",
            home.trim_end_matches('/')
        ))
    });

    let Some(path) = token_path else {
        bail!("gRPC token requested but SYNTHI_ANDROID_GRPC_TOKEN_PATH is not set");
    };

    let token = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read gRPC token from {}", path))?
        .trim()
        .to_string();
    if token.is_empty() {
        bail!("gRPC token file was empty: {}", path);
    }
    Ok(Some(token))
}

fn apply_grpc_token<T>(req: &mut Request<T>, token: &str) -> Result<()> {
    let bearer = format!("Bearer {}", token);
    let metadata = req.metadata_mut();
    metadata.insert(
        "authorization",
        MetadataValue::try_from(bearer.as_str())
            .context("invalid gRPC authorization metadata value")?,
    );
    metadata.insert(
        "x-android-emulator-token",
        MetadataValue::try_from(token).context("invalid gRPC token metadata value")?,
    );
    Ok(())
}

fn map_keycode_to_w3c(keycode: &str) -> Option<String> {
    let kc = keycode.trim().to_uppercase();
    let key = match kc.as_str() {
        "KEYCODE_BACK" => "GoBack",
        "KEYCODE_HOME" => "GoHome",
        "KEYCODE_APP_SWITCH" => "AppSwitch",
        "KEYCODE_ENTER" => "Enter",
        "KEYCODE_DEL" => "Backspace",
        "KEYCODE_FORWARD_DEL" => "Delete",
        "KEYCODE_TAB" => "Tab",
        "KEYCODE_ESCAPE" => "Escape",
        "KEYCODE_DPAD_UP" => "ArrowUp",
        "KEYCODE_DPAD_DOWN" => "ArrowDown",
        "KEYCODE_DPAD_LEFT" => "ArrowLeft",
        "KEYCODE_DPAD_RIGHT" => "ArrowRight",
        "KEYCODE_PAGE_UP" => "PageUp",
        "KEYCODE_PAGE_DOWN" => "PageDown",
        "KEYCODE_MOVE_HOME" => "Home",
        "KEYCODE_MOVE_END" => "End",
        "KEYCODE_SPACE" => " ",
        _ => return None,
    };
    Some(key.to_string())
}
