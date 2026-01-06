use anyhow::{anyhow, Context, Result};
use gstreamer as gst;
use gstreamer::prelude::{Cast, ElementExt, GstBinExt, GstObjectExt};
use gstreamer_app as gst_app;
use std::sync::Arc;
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
    /// Capture framerate.
    pub fps: u32,
    /// Capture width.
    pub width: u32,
    /// Capture height.
    pub height: u32,
    pub codec: VideoCodec,
}

impl Default for EmulatorVideoConfig {
    fn default() -> Self {
        Self {
            x11_display: ":99".to_string(),
            fps: 30,
            width: 1080,
            height: 1920,
            codec: VideoCodec::Vp8,
        }
    }
}

pub struct EmulatorVideoPipeline {
    pipeline: gst::Pipeline,
    pub track: Arc<TrackLocalStaticRTP>,
    _rtp_task: tokio::task::JoinHandle<()>,
}

fn require_element(name: &str) -> Result<()> {
    gst::ElementFactory::find(name)
        .ok_or_else(|| anyhow!("Missing required GStreamer element: {}", name))
        .map(|_| ())
}

fn pipeline_string(cfg: &EmulatorVideoConfig) -> String {
    let framerate = format!("{}/1", cfg.fps.max(1));

    // Capture the full X11 root window.
    // NOTE: we force use-damage=0 to avoid missed updates on some drivers.
    let src = format!(
        "ximagesrc use-damage=0 show-pointer=false display-name={} ! ",
        cfg.x11_display
    );

    // Keep caps explicit so negotiation is deterministic.
    let caps = format!(
        "video/x-raw,framerate={},width={},height={} ! videoconvert ! videoscale ! video/x-raw,framerate={},width={},height={} ! queue ! ",
        framerate, cfg.width, cfg.height, framerate, cfg.width, cfg.height
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

        let (rtp_tx, mut rtp_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                    let _ = rtp_tx.send(map.to_vec());
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        pipeline
            .set_state(gst::State::Playing)
            .context("Failed to set emulator video pipeline to Playing")?;

        let track = Arc::new(TrackLocalStaticRTP::new(
            webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability {
                mime_type: track_mime_type(cfg.codec),
                ..Default::default()
            },
            "video".to_string(),
            "synthi-emulator".to_string(),
        ));

        let track_clone = track.clone();
        let rtp_task = tokio::spawn(async move {
            while let Some(buf) = rtp_rx.recv().await {
                if let Ok(packet) = Packet::unmarshal(&mut &buf[..]) {
                    let _ = track_clone.write_rtp(&packet).await;
                }
            }
        });

        Ok(Self {
            pipeline,
            track,
            _rtp_task: rtp_task,
        })
    }

    pub fn stop(mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
        self._rtp_task.abort();
    }

    pub fn debug_pipeline_string(cfg: &EmulatorVideoConfig) -> String {
        pipeline_string(cfg)
    }
}
