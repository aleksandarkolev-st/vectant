use anyhow::{anyhow, Context, Result};
use gstreamer as gst;
use gstreamer::prelude::{Cast, ElementExt, GstBinExt, GstObjectExt, ObjectExt};
use gstreamer_app as gst_app;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicU32, Ordering};
use std::str::FromStr;
use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::rtp::header::Header;
use webrtc::rtp::extension::audio_level_extension::AudioLevelExtension;
use webrtc::rtp::extension::HeaderExtension;
use webrtc_util::Unmarshal;

#[derive(Debug, Clone, Copy)]
pub enum VideoCodec {
    Vp8,
    H264,
}

#[derive(Debug, Clone)]
pub struct EmulatorVideoConfig {
    /// X11 display to capture from, e.g. ":99".
    pub x11_display: String,
    /// Optional X11 window id (XID) to capture directly (preferred over root capture).
    pub x11_xid: Option<u64>,
    /// Capture framerate.
    pub fps: u32,
    /// Capture width.
    pub width: u32,
    /// Capture height.
    pub height: u32,
    pub codec: VideoCodec,
    /// Optional capture region (for root capture): start X coordinate
    pub startx: Option<i32>,
    /// Optional capture region: start Y coordinate
    pub starty: Option<i32>,
    /// Optional capture region: end X coordinate (exclusive)
    pub endx: Option<i32>,
    /// Optional capture region: end Y coordinate (exclusive)
    pub endy: Option<i32>,
    /// Pixels to crop from the right side (to remove SDK toolbar)
    pub crop_right: u32,
    /// RTP payload type explicitly negotiated (defaults to 96 if not set, but vital for H.264)
    pub payload_type: u8,
}

#[derive(Debug, Clone)]
pub struct EmulatorAppSrcConfig {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub codec: VideoCodec,
    pub payload_type: u8,
}

impl Default for EmulatorAppSrcConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            width: 1080,
            height: 1920,
            format: "RGBA".to_string(),
            codec: VideoCodec::Vp8,
            payload_type: 96,
        }
    }
}

impl Default for EmulatorVideoConfig {
    fn default() -> Self {
        Self {
            x11_display: ":99".to_string(),
            x11_xid: None,
            fps: 30,
            width: 1080,
            height: 1920,
            codec: VideoCodec::Vp8,
            startx: None,
            starty: None,
            endx: None,
            endy: None,
            crop_right: 0,
            payload_type: 96,
        }
    }
}

pub struct EmulatorVideoPipeline {
    pipeline: gst::Pipeline,
    codec: VideoCodec,
    pub track: Arc<TrackLocalStaticRTP>,
    _rtp_task: tokio::task::JoinHandle<()>,
    /// Counter for RTP packets written to the track (can be read externally for diagnostics)
    pub rtp_packet_count: Arc<AtomicU64>,
    /// Counter for samples received in appsink callback
    pub appsink_sample_count: Arc<AtomicU64>,
    appsrc: Option<gst_app::AppSrc>,
    /// SSRC to force on outgoing packets (0 = no force)
    pub forced_ssrc: Arc<AtomicU32>,
}

fn drain_pipeline_errors(pipeline: &gst::Pipeline, max_ms: u64) -> Vec<String> {
    let Some(bus) = pipeline.bus() else {
        return vec![];
    };

    let mut elapsed = 0u64;
    let mut out = Vec::new();
    while elapsed < max_ms {
        let slice = 50u64.min(max_ms - elapsed);
        if let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(slice)) {
            if let gst::MessageView::Error(err) = msg.view() {
                let src = err.src().map(|s| s.path_string()).unwrap_or_default();
                let dbg = err.debug().unwrap_or_default();
                out.push(format!("{}: {} ({})", src, err.error(), dbg));
            }
        }
        elapsed += slice;
    }
    out
}

fn require_element(name: &str) -> Result<()> {
    gst::ElementFactory::find(name)
        .ok_or_else(|| anyhow!("Missing required GStreamer element: {}", name))
        .map(|_| ())
}

fn ximagesrc_disable_shm_arg() -> String {
    // In headless / Xvfb setups, ximagesrc can fail with MIT-SHM / XShmGetImage (BadMatch).
    // Different GStreamer builds expose different property names to disable XShm.
    let Ok(el) = gst::ElementFactory::make("ximagesrc").build() else {
        return String::new();
    };

    let mut has_use_shm = false;
    let mut has_use_xshm = false;
    let mut has_remote = false;

    for pspec in el.list_properties() {
        match pspec.name() {
            "use-shm" => has_use_shm = true,
            "use-xshm" => has_use_xshm = true,
            "remote" => has_remote = true,
            _ => {}
        }
    }

    if has_use_shm {
        " use-shm=false".to_string()
    } else if has_use_xshm {
        " use-xshm=false".to_string()
    } else if has_remote {
        // Marking as remote typically forces non-SHM image capture.
        " remote=true".to_string()
    } else {
        String::new()
    }
}

/// Helper to select the best available H.264 encoder
/// Checks for NVENV (NVIDIA) -> VAAPI (Intel/AMD) -> x264 (Software)
fn get_h264_encoder_string() -> String {
    if gst::ElementFactory::find("nvh264enc").is_some() {
        // NVIDIA hardware encoding
        // preset=low-latency-hp: High performance low latency
        // zerolatency=true: Removes buffering
        // gop-size=60: Keyframe every 2s at 30fps
        "nvh264enc name=video_encoder preset=low-latency-hp zerolatency=true bitrate=2000 gop-size=60 ! video/x-h264,profile=high"
            .to_string()
    } else if gst::ElementFactory::find("vaapih264enc").is_some() {
        // Intel/AMD hardware encoding via VAAPI
        "vaapih264enc name=video_encoder rate-control=cbr bitrate=2000 keyframe-period=60 ! video/x-h264,profile=high"
            .to_string()
    } else {
        // Software fallback (x264)
        // tune=zerolatency: Optimize for streaming
        // speed-preset=ultrafast: Sacrifice compression for CPU speed
        // profile=constrained-baseline: Required for broad WebRTC compatibility (Chrome/Safari)
        "x264enc name=video_encoder tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=30 ! video/x-h264,profile=constrained-baseline,level=(string)3.1,stream-format=byte-stream"
            .to_string()
    }
}

fn gcd_u32(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

fn pipeline_string(cfg: &EmulatorVideoConfig) -> String {
    let shm_arg = ximagesrc_disable_shm_arg();

    let framerate = format!("{}/1", cfg.fps.max(1));

    let w = cfg.width.max(1);
    let h = cfg.height.max(1);
    let g = gcd_u32(w, h).max(1);
    let ar_w = w / g;
    let ar_h = h / g;

    // Capture strategy:
    // 1) If we have an XID, capture that window directly (avoids scaling the whole X11 root).
    // 2) Else capture the full X11 root window for the display, optionally with region crop.
    // NOTE: we force use-damage=0 to avoid missed updates on some drivers.
    
    // Build region properties if set (for root capture)
    let region = if cfg.x11_xid.is_none() {
        let mut r = String::new();
        if let Some(x) = cfg.startx { r.push_str(&format!(" startx={}", x)); }
        if let Some(y) = cfg.starty { r.push_str(&format!(" starty={}", y)); }
        if let Some(x) = cfg.endx { r.push_str(&format!(" endx={}", x)); }
        if let Some(y) = cfg.endy { r.push_str(&format!(" endy={}", y)); }
        r
    } else {
        String::new()
    };
    
    let src = if let Some(xid) = cfg.x11_xid {
        if cfg.x11_display.trim().is_empty() {
            format!("ximagesrc use-damage=0 show-pointer=false{} xid={} ! ", shm_arg, xid)
        } else {
            format!(
                "ximagesrc use-damage=0 show-pointer=false{} display-name={} xid={} ! ",
                shm_arg, cfg.x11_display, xid
            )
        }
    } else if cfg.x11_display.trim().is_empty() {
        // Explicit xid=0 to force root capture (some builds do nothing if xid is unset).
        format!("ximagesrc use-damage=0 show-pointer=false{}{} xid=0 ! ", shm_arg, region)
    } else {
        // Explicit xid=0 to force root capture (some builds do nothing if xid is unset).
        format!(
            "ximagesrc use-damage=0 show-pointer=false{} display-name={}{} xid=0 ! ",
            shm_arg, cfg.x11_display, region
        )
    };

    // Crop the right side to remove the SDK toolbar if crop_right > 0
    // Also check for env var override: SYNTHI_ANDROID_CROP_RIGHT_PX
    // The crop happens immediately after capture, before any conversion.
    let crop_right_px = std::env::var("SYNTHI_ANDROID_CROP_RIGHT_PX")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(cfg.crop_right);
    
    let crop_toolbar = if crop_right_px > 0 {
        if gst::ElementFactory::find("videocrop").is_some() {
            eprintln!("[video-pipeline] Cropping {} pixels from right side (SDK toolbar) using videocrop", crop_right_px);
            format!("videoconvert ! videocrop right={} ! ", crop_right_px)
        } else {
            // Fallback: use videobox if videocrop isn't available
            if gst::ElementFactory::find("videobox").is_some() {
                eprintln!("[video-pipeline] Cropping {} pixels from right side (SDK toolbar) using videobox", crop_right_px);
                format!("videoconvert ! videobox right=-{} ! ", crop_right_px)
            } else {
                eprintln!("[video-pipeline] WARNING: Neither videocrop nor videobox available, cannot crop toolbar!");
                String::new()
            }
        }
    } else {
        String::new()
    };

    // ximagesrc cannot always accept width/height caps directly.
    // Convert/scale/rate first, then apply a single capsfilter.
    // Crop to the desired aspect ratio (best-effort, opt-in).
    // This can remove emulator chrome (e.g. side toolbar), but can also crop out the emulator
    // entirely if it's not centered on the captured X11 root.
    let crop_enabled = std::env::var("SYNTHI_ANDROID_CROP_ASPECT")
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    let crop = if crop_enabled && gst::ElementFactory::find("aspectratiocrop").is_some() {
        format!("aspectratiocrop aspect-ratio={}/{} ! ", ar_w, ar_h)
    } else {
        String::new()
    };
    
    // Build the processing pipeline: crop first, then scale to output dimensions
    // Use leaky queues to drop frames if processing is too slow (prevent lag buildup)
    let caps = if crop_toolbar.is_empty() {
        format!(
            "videoconvert ! videoscale ! videorate ! {}video/x-raw,framerate={},width={},height={} ! ",
            crop, framerate, cfg.width, cfg.height
        )
    } else {
        format!(
            "{}videoscale ! videorate ! {}video/x-raw,framerate={},width={},height={} ! ",
            crop_toolbar, crop, framerate, cfg.width, cfg.height
        )
    };

    // Payloader output must be RTP packet bytes for Packet::unmarshal.
    // pt=96 is the common dynamic payload type.
    let enc = match cfg.codec {
        VideoCodec::Vp8 => {
            format!("vp8enc name=video_encoder deadline=1 cpu-used=8 error-resilient=partitions keyframe-max-dist=60 ! rtpvp8pay pt={}", cfg.payload_type)
        }
        VideoCodec::H264 => {
            // Use hardware acceleration if available
            let encoder = get_h264_encoder_string();
            // config-interval=1 sends SPS/PPS with every keyframe (essential for WebRTC join/recovery)
            format!("{} ! rtph264pay pt={} config-interval=-1 aggregate-mode=zero-latency mtu=1200", encoder, cfg.payload_type)
        }
    };

    // Final queue before appsink: also leaky 1 frame.
    // Appsink max-buffers=1 ensures we only hold the absolute latest frame for consumption.
    // sync=false prevents GStreamer from holding frames to match timestamps, ensuring min latency.
    format!(
        "{}{}{} ! queue leaky=downstream max-size-buffers=1 ! appsink name=video_sink drop=true max-buffers=1 sync=false",
        src, caps, enc
    )
}

fn appsrc_pipeline_string(cfg: &EmulatorAppSrcConfig) -> String {
    let framerate = format!("{}/1", cfg.fps.max(1));
    let enc = match cfg.codec {
        VideoCodec::Vp8 => {
            format!("vp8enc name=video_encoder deadline=1 cpu-used=8 error-resilient=partitions keyframe-max-dist=60 ! rtpvp8pay pt={}", cfg.payload_type)
        }
        VideoCodec::H264 => {
            // Use hardware acceleration if available
            let encoder = get_h264_encoder_string();
            // config-interval=1 sends SPS/PPS with every keyframe
            format!("{} ! rtph264pay pt={} config-interval=-1 aggregate-mode=zero-latency mtu=1200", encoder, cfg.payload_type)
        }
    };

    let decoder = if cfg.format == "PNG" {
        // Use queues around pngdec to offload decoding to a separate thread
        "queue max-size-buffers=1 ! pngdec ! queue max-size-buffers=1 ! "
    } else if cfg.format == "JPEG" || cfg.format == "JPG" {
        "queue max-size-buffers=1 ! jpegdec ! queue max-size-buffers=1 ! "
    } else {
        ""
    };

    // Low latency appsrc pipeline: leaky queues + drop=true appsink
    // We already drop frames in the gRPC loop if appsrc is full, but this ensures GStreamer doesn't buffer internally.
    format!(
        "appsrc name=emulator_frames is-live=true format=time do-timestamp=true ! {}videoconvert ! videoscale ! videorate ! video/x-raw,framerate={},width={},height={} ! queue leaky=downstream max-size-buffers=1 ! {} ! queue leaky=downstream max-size-buffers=200 ! appsink name=video_sink drop=true max-buffers=1",
        decoder, framerate, cfg.width, cfg.height, enc
    )
}

pub fn track_mime_type(codec: VideoCodec) -> String {
    match codec {
        VideoCodec::Vp8 => "video/VP8".to_string(),
        VideoCodec::H264 => "video/H264".to_string(),
    }
}

impl EmulatorVideoPipeline {
    pub fn start(cfg: EmulatorVideoConfig) -> Result<Self> {
        // Validate required plugins early (fail-fast).
        require_element("ximagesrc")?;
        require_element("videoconvert")?;
        require_element("videoscale")?;
        require_element("videorate")?;
        require_element("queue")?;
        require_element("appsink")?;
        // videocrop is optional - we check at runtime
        match cfg.codec {
            VideoCodec::Vp8 => {
                require_element("vp8enc")?;
                require_element("rtpvp8pay")?;
            }
            VideoCodec::H264 => {
                require_element("x264enc")?;
                require_element("rtph264pay")?;
            }
        }

        let gst_str = pipeline_string(&cfg);
        let pipeline = gst::parse_launch(&gst_str)
            .context("Failed to parse GStreamer pipeline")?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow!("Expected gst::Pipeline"))?;

        Self::finalize_pipeline(pipeline, cfg.codec, cfg.payload_type, None, true, cfg.width, cfg.height)
    }

    pub fn start_appsrc(cfg: EmulatorAppSrcConfig) -> Result<Self> {
        // Validate required plugins early (fail-fast).
        require_element("appsrc")?;
        require_element("videoconvert")?;
        require_element("videoscale")?;
        require_element("videorate")?;
        require_element("queue")?;
        require_element("appsink")?;
        match cfg.codec {
            VideoCodec::Vp8 => {
                require_element("vp8enc")?;
                require_element("rtpvp8pay")?;
            }
            VideoCodec::H264 => {
                require_element("x264enc")?;
                require_element("rtph264pay")?;
            }
        }

        let gst_str = appsrc_pipeline_string(&cfg);
        let pipeline = gst::parse_launch(&gst_str)
            .context("Failed to parse GStreamer appsrc pipeline")?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow!("Expected gst::Pipeline"))?;

        let appsrc = pipeline
            .by_name("emulator_frames")
            .context("emulator_frames appsrc not found")?
            .downcast::<gst_app::AppSrc>()
            .map_err(|_| anyhow!("Expected AppSrc"))?;

        let caps_str = if cfg.format == "PNG" {
            format!(
                "image/png,width={},height={},framerate={}/1",
                cfg.width.max(1),
                cfg.height.max(1),
                cfg.fps.max(1)
            )
        } else if cfg.format == "JPEG" || cfg.format == "JPG" {
            format!(
                "image/jpeg,width={},height={},framerate={}/1",
                cfg.width.max(1),
                cfg.height.max(1),
                cfg.fps.max(1)
            )
        } else {
            format!(
                "video/x-raw,format={},width={},height={},framerate={}/1",
                cfg.format,
                cfg.width.max(1),
                cfg.height.max(1),
                cfg.fps.max(1)
            )
        };
        let caps = gst::Caps::from_str(&caps_str)
            .context("Failed to build appsrc caps")?;
        appsrc.set_caps(Some(&caps));

        Self::finalize_pipeline(pipeline, cfg.codec, cfg.payload_type, Some(appsrc), false, cfg.width, cfg.height)
    }

    fn finalize_pipeline(
        pipeline: gst::Pipeline,
        codec: VideoCodec,
        payload_type: u8,
        appsrc: Option<gst_app::AppSrc>,
        verify_samples: bool,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let appsink = pipeline
            .by_name("video_sink")
            .context("video_sink not found")?
            .downcast::<gst_app::AppSink>()
            .map_err(|_| anyhow!("Expected AppSink"))?;

        // Counter for samples received in the appsink callback (for diagnostics)
        let appsink_sample_count = Arc::new(AtomicU64::new(0));
        let appsink_sample_count_cb = appsink_sample_count.clone();
        
        let (rtp_tx, mut rtp_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| {
                        eprintln!("[video-pipeline] appsink pull_sample failed (EOS)");
                        gst::FlowError::Eos
                    })?;
                    let buffer = sample.buffer().ok_or_else(|| {
                        eprintln!("[video-pipeline] sample has no buffer");
                        gst::FlowError::Error
                    })?;
                    let map = buffer.map_readable().map_err(|_| {
                        eprintln!("[video-pipeline] buffer map_readable failed");
                        gst::FlowError::Error
                    })?;
                    let count = appsink_sample_count_cb.fetch_add(1, Ordering::Relaxed) + 1;
                    if count <= 5 || count % 100 == 0 {
                        eprintln!("[video-pipeline] appsink sample #{} size={}", count, map.len());
                    }
                    if rtp_tx.send(map.to_vec()).is_err() {
                        eprintln!("[video-pipeline] rtp_tx.send failed (receiver dropped?)");
                        return Err(gst::FlowError::Error);
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        pipeline
            .set_state(gst::State::Playing)
            .context("Failed to set emulator video pipeline to Playing")?;

        // Some capture failures only surface asynchronously on the bus.
        let early_errors = drain_pipeline_errors(&pipeline, 250);
        if !early_errors.is_empty() {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(anyhow!(
                "Emulator video pipeline failed to start (early bus error): {}",
                early_errors.join(" | ")
            ));
        }

        if verify_samples {
            // Give the pipeline a moment to start producing frames, then verify it's working.
            std::thread::sleep(std::time::Duration::from_millis(3000));
            let initial_samples = appsink_sample_count.load(Ordering::Relaxed);
            if initial_samples == 0 {
                let errors = drain_pipeline_errors(&pipeline, 250);
                let _ = pipeline.set_state(gst::State::Null);
                if errors.is_empty() {
                    return Err(anyhow!(
                        "Emulator video pipeline produced no frames in first 500ms"
                    ));
                }
                return Err(anyhow!(
                    "Emulator video pipeline failed shortly after start: {}",
                    errors.join(" | ")
                ));
            }
            eprintln!("[video-pipeline] Initial verification: {} samples in first 500ms", initial_samples);
        }

        let track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: track_mime_type(codec),
                rtcp_feedback: vec![
                    RTCPFeedback { typ: "transport-cc".to_string(), parameter: "".to_string() },
                    RTCPFeedback { typ: "ccm".to_string(), parameter: "fir".to_string() },
                    RTCPFeedback { typ: "nack".to_string(), parameter: "".to_string() },
                    RTCPFeedback { typ: "nack".to_string(), parameter: "pli".to_string() },
                ],
                ..Default::default()
            },
            "video".to_string(),
            "synthi-emulator".to_string(),
        ));

        let rtp_packet_count = Arc::new(AtomicU64::new(0));
        let rtp_packet_count_clone = rtp_packet_count.clone();
        let forced_ssrc = Arc::new(AtomicU32::new(0));
        let forced_ssrc_clone = forced_ssrc.clone();
        let track_clone = track.clone();
        let rtp_task = tokio::spawn(async move {
            let mut last_log_time = std::time::Instant::now();
            let mut last_packet_count = 0u64;
            
            let target_bitrate = match codec {
                VideoCodec::Vp8 => "auto",
                VideoCodec::H264 => "2000k",
            };

            while let Some(buf) = rtp_rx.recv().await {
                if let Ok(mut packet) = Packet::unmarshal(&mut &buf[..]) {
                    // Critical: Interceptors (like TWCC) often rely on header extensions.
                    // However, webrtc-rs InterceptorChain running on TrackLocalStaticRTP usually handles
                    // automatic stamping if the extension is negotiated.
                    // But if packets_sent=0 in stats, it might imply the interceptor isn't seeing the packets
                    // or isn't associating them with the SSRC.
                    
                    // Cleanup any GStreamer junk extensions
                    packet.header.extensions.clear(); 

                    // Force SSRC if configured
                    let ssrc = forced_ssrc_clone.load(Ordering::Relaxed);
                    if ssrc != 0 {
                        packet.header.ssrc = ssrc;
                    }
                    
                    // Force Payload Type (Negotiated)
                    if payload_type != 0 {
                         packet.header.payload_type = payload_type;
                    }

                    let _ = track_clone.write_rtp(&packet).await;
                    let count = rtp_packet_count_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    
                    // Log telemetry every ~2s
                    let elapsed = last_log_time.elapsed();
                    if elapsed >= std::time::Duration::from_secs(2) {
                        let packets_since = count - last_packet_count;
                        let pps = (packets_since as f64 / elapsed.as_secs_f64()) as u64;
                        
                        eprintln!(
                            "[perf telemetry] res={}x{} codec={:?} target_br={} pps={} total_packets={}",
                            width, height, codec, target_bitrate, pps, count
                        );

                        last_log_time = std::time::Instant::now();
                        last_packet_count = count;
                    }
                }
            }
            let final_count = rtp_packet_count_clone.load(Ordering::Relaxed);
            eprintln!("[video-pipeline] RTP task ended, total packets written: {}", final_count);
        });

        eprintln!("[video-pipeline] Pipeline started successfully, track attached");

        Ok(Self {
            pipeline,
            codec,
            track,
            _rtp_task: rtp_task,
            rtp_packet_count,
            appsink_sample_count,
            appsrc,
            forced_ssrc,
        })
    }

    pub fn set_ssrc(&self, ssrc: u32) {
        self.forced_ssrc.store(ssrc, Ordering::Relaxed);
        eprintln!("[video-pipeline] Forced SSRC updated to {}", ssrc);
    }

    /// Get the current count of RTP packets written to the track
    pub fn get_rtp_packet_count(&self) -> u64 {
        self.rtp_packet_count.load(Ordering::Relaxed)
    }

    /// Get the current count of samples received in appsink callback
    pub fn get_appsink_sample_count(&self) -> u64 {
        self.appsink_sample_count.load(Ordering::Relaxed)
    }

    /// Get the current GStreamer pipeline state
    pub fn get_pipeline_state(&self) -> String {
        let (result, current, pending) = self.pipeline.state(gst::ClockTime::from_mseconds(0));
        format!("{:?}/{:?} (pending: {:?})", result, current, pending)
    }

    /// Check for any errors on the pipeline bus
    pub fn drain_errors(&self) -> Vec<String> {
        drain_pipeline_errors(&self.pipeline, 0)
    }

    pub fn stop(&self) {
        eprintln!("[video-pipeline] Stopping pipeline...");
        let _ = self.pipeline.set_state(gst::State::Null);
        self._rtp_task.abort();
    }

    pub fn debug_pipeline_string(cfg: &EmulatorVideoConfig) -> String {
        pipeline_string(cfg)
    }

    pub fn debug_appsrc_pipeline_string(cfg: &EmulatorAppSrcConfig) -> String {
        appsrc_pipeline_string(cfg)
    }

    pub fn appsrc_clone(&self) -> Option<gst_app::AppSrc> {
        self.appsrc.clone()
    }

    pub fn push_frame(&self, data: &[u8], pts_ns: Option<u64>) -> Result<()> {
        let appsrc = self
            .appsrc
            .as_ref()
            .context("appsrc not configured for this pipeline")?;
        let mut buffer = gst::Buffer::from_slice(data.to_vec());
        if let Some(pts) = pts_ns {
            if let Some(buf) = buffer.get_mut() {
                buf.set_pts(gst::ClockTime::from_nseconds(pts));
            }
        }
        appsrc
            .push_buffer(buffer)
            .map_err(|e| anyhow!("appsrc push_buffer failed: {:?}", e))?;
        Ok(())
    }

    pub fn set_target_bitrate(&self, bitrate_kbits: u32) -> Result<()> {
        let encoder = self
            .pipeline
            .by_name("video_encoder")
            .ok_or_else(|| anyhow!("video_encoder element not found in pipeline"))?;

        // Clamp to sane values (500k - 8000k)
        let bitrate_kbits = bitrate_kbits.max(500).min(8000);

        match self.codec {
            VideoCodec::Vp8 => {
                // vp8enc uses bits per second (target-bitrate)
                let bitrate_bps = (bitrate_kbits * 1000) as i32;
                if encoder.has_property("target-bitrate", None) {
                   encoder.set_property("target-bitrate", bitrate_bps);
                   eprintln!("[video-pipeline] Updated VP8 bitrate to {} bps", bitrate_bps);
                } else {
                   eprintln!("[video-pipeline] WARNING: VP8 encoder does not support 'target-bitrate'");
                }
            }
            VideoCodec::H264 => {
                // x264enc, nvh264enc, vaapih264enc use kbit/sec for 'bitrate'
                if encoder.has_property("bitrate", None) {
                    encoder.set_property("bitrate", bitrate_kbits);
                    eprintln!("[video-pipeline] Updated H.264 bitrate to {} kbps", bitrate_kbits);
                } else {
                    eprintln!("[video-pipeline] WARNING: H.264 encoder does not support 'bitrate'");
                }
            }
        }
        Ok(())
    }
}
