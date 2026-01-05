use anyhow::{anyhow, Context, Result};
use gstreamer as gst;
use gstreamer::prelude::{Cast, ElementExt, GstBinExt, GstObjectExt, ObjectExt};
use gstreamer_app as gst_app;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;
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
        }
    }
}

pub struct EmulatorVideoPipeline {
    pipeline: gst::Pipeline,
    pub track: Arc<TrackLocalStaticRTP>,
    _rtp_task: tokio::task::JoinHandle<()>,
    /// Counter for RTP packets written to the track (can be read externally for diagnostics)
    pub rtp_packet_count: Arc<AtomicU64>,
    /// Counter for samples received in appsink callback
    pub appsink_sample_count: Arc<AtomicU64>,
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
    let caps = format!(
        "videoconvert ! videoscale ! videorate ! {}video/x-raw,framerate={},width={},height={} ! queue ! ",
        crop, framerate, cfg.width, cfg.height
    );

    // Payloader output must be RTP packet bytes for Packet::unmarshal.
    // pt=96 is the common dynamic payload type.
    let enc = match cfg.codec {
        VideoCodec::Vp8 => {
            "vp8enc deadline=1 cpu-used=8 error-resilient=partitions keyframe-max-dist=60 ! rtpvp8pay pt=96".to_string()
        }
        VideoCodec::H264 => {
            // Baseline-ish settings + frequent keyframes for low-latency.
            "x264enc tune=zerolatency speed-preset=ultrafast bitrate=2000 key-int-max=60 ! video/x-h264,stream-format=byte-stream,profile=baseline ! rtph264pay pt=96 config-interval=-1".to_string()
        }
    };

    format!(
        "{}{}{} ! queue ! appsink name=video_sink drop=true max-buffers=50",
        src, caps, enc
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

        // Some X11/Xvfb capture failures only surface asynchronously on the bus.
        // If we immediately see an error, fail-fast so callers can fall back (e.g. root capture).
        let early_errors = drain_pipeline_errors(&pipeline, 250);
        if !early_errors.is_empty() {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(anyhow!(
                "Emulator video pipeline failed to start (early bus error): {}",
                early_errors.join(" | ")
            ));
        }

        // Give the pipeline a moment to start producing frames, then verify it's working.
        // We check sample count from the callback rather than pulling directly to avoid
        // competing with the callback for samples.
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

        let track = Arc::new(TrackLocalStaticRTP::new(
            webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability {
                mime_type: track_mime_type(cfg.codec),
                ..Default::default()
            },
            "video".to_string(),
            "synthi-emulator".to_string(),
        ));

        let rtp_packet_count = Arc::new(AtomicU64::new(0));
        let rtp_packet_count_clone = rtp_packet_count.clone();
        let track_clone = track.clone();
        let rtp_task = tokio::spawn(async move {
            let mut last_log_time = std::time::Instant::now();
            while let Some(buf) = rtp_rx.recv().await {
                if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                    let _ = track_clone.write_rtp(&packet).await;
                    let count = rtp_packet_count_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    // Log every 5 seconds to show the pipeline is producing packets
                    if last_log_time.elapsed() >= std::time::Duration::from_secs(5) {
                        eprintln!("[video-pipeline] RTP packets written: {} (continuing...)", count);
                        last_log_time = std::time::Instant::now();
                    }
                }
            }
            let final_count = rtp_packet_count_clone.load(Ordering::Relaxed);
            eprintln!("[video-pipeline] RTP task ended, total packets written: {}", final_count);
        });

        eprintln!("[video-pipeline] Pipeline started successfully, track attached");

        Ok(Self {
            pipeline,
            track,
            _rtp_task: rtp_task,
            rtp_packet_count,
            appsink_sample_count,
        })
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

    pub fn stop(mut self) {
        eprintln!("[video-pipeline] Stopping pipeline...");
        let _ = self.pipeline.set_state(gst::State::Null);
        self._rtp_task.abort();
    }

    pub fn debug_pipeline_string(cfg: &EmulatorVideoConfig) -> String {
        pipeline_string(cfg)
    }
}
