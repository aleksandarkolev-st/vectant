use gstreamer as gst;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::{broadcast, mpsc};
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;

use crate::compiler::builder::ModuleHashes;
use crate::runtime::capability::HmrCapability;

// RunnerState tracks the state of a running plugin process
// This is used by the worker to manage HMR, video streaming, and process lifecycle
// Currently the runner uses individual fields directly, but this struct provides
// the complete state model for future HMR orchestration integration
pub struct RunnerState {
    pub process: Option<Child>, // Option to allow taking it if needed, or just drop
    pub stdin: Option<Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>>,
    pub output_tx: broadcast::Sender<String>,
    // Session that owns this runner. Required so cancel-build with a
    // specific session_id can verify the cancel actually targets the
    // currently-active runner before tearing down Xvfb/GStreamer — a
    // stale cancel-build for a previous session must NOT kill the
    // shared Xvfb of the live session (caused XIO error 110 on :99).
    pub session_id: Option<String>,
    pub is_gui: bool,
    pub is_hmr_capable: bool, // True if runner was started with HMR-capable code (detected from exports)
    pub hmr_capability: Option<HmrCapability>, // Detailed capability level
    pub xvfb_process: Option<Child>,
    pub gst_pipeline: Option<gst::Pipeline>,
    pub sdl_tx: Option<mpsc::UnboundedSender<String>>,
    pub video_track: Option<Arc<TrackLocalStaticRTP>>,
    pub audio_track: Option<Arc<TrackLocalStaticRTP>>,
    pub width: u32,
    pub height: u32,
    pub wsl_display_str: String,
    pub gst_display_str: String,
    // Module hashes for differential rebuild
    pub module_hashes: ModuleHashes,
    // Loaded module paths (for determining what to reload)
    pub loaded_core_path: Option<String>,
    pub loaded_gui_path: Option<String>,
    // Widget-level compilation state
    pub loaded_widget_paths: HashMap<String, String>, // widget_id -> so_path
    pub widget_hashes: HashMap<String, u64>,          // widget_id -> content_hash
}

/// RunnerState builder methods for fluent configuration
impl RunnerState {
    /// Create a new RunnerState with required fields
    pub fn new(
        process: Option<Child>,
        stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
        output_tx: broadcast::Sender<String>,
    ) -> Self {
        Self {
            process,
            stdin: Some(stdin),
            output_tx,
            session_id: None,
            is_gui: false,
            is_hmr_capable: false,
            hmr_capability: None,
            xvfb_process: None,
            gst_pipeline: None,
            sdl_tx: None,
            video_track: None,
            audio_track: None,
            width: 800,
            height: 600,
            wsl_display_str: String::new(),
            gst_display_str: String::new(),
            module_hashes: ModuleHashes::default(),
            loaded_core_path: None,
            loaded_gui_path: None,
            loaded_widget_paths: HashMap::new(),
            widget_hashes: HashMap::new(),
        }
    }

    /// Configure GUI mode settings
    pub fn with_gui(mut self, is_gui: bool, width: u32, height: u32) -> Self {
        self.is_gui = is_gui;
        self.width = width;
        self.height = height;
        self
    }

    /// Set HMR capability information
    pub fn with_hmr_capability(
        mut self,
        is_capable: bool,
        capability: Option<HmrCapability>,
    ) -> Self {
        self.is_hmr_capable = is_capable;
        self.hmr_capability = capability;
        self
    }

    /// Set Xvfb process for headless GUI rendering
    pub fn with_xvfb(
        mut self,
        xvfb: Option<Child>,
        display_str: String,
        gst_display: String,
    ) -> Self {
        self.xvfb_process = xvfb;
        self.wsl_display_str = display_str;
        self.gst_display_str = gst_display;
        self
    }

    /// Set GStreamer pipeline for video streaming
    pub fn with_gst_pipeline(mut self, pipeline: Option<gst::Pipeline>) -> Self {
        self.gst_pipeline = pipeline;
        self
    }

    /// Set SDL event channel for GUI interaction
    pub fn with_sdl_tx(mut self, sdl_tx: Option<mpsc::UnboundedSender<String>>) -> Self {
        self.sdl_tx = sdl_tx;
        self
    }

    /// Set WebRTC media tracks for streaming
    pub fn with_media_tracks(
        mut self,
        video: Option<Arc<TrackLocalStaticRTP>>,
        audio: Option<Arc<TrackLocalStaticRTP>>,
    ) -> Self {
        self.video_track = video;
        self.audio_track = audio;
        self
    }

    /// Update module hashes for differential rebuild tracking
    pub fn update_module_hashes(&mut self, hashes: ModuleHashes) {
        self.module_hashes = hashes;
    }

    /// Set loaded core module path
    pub fn set_core_path(&mut self, path: Option<String>) {
        self.loaded_core_path = path;
    }

    /// Set loaded GUI module path
    pub fn set_gui_path(&mut self, path: Option<String>) {
        self.loaded_gui_path = path;
    }

    /// Register a loaded widget module
    pub fn register_widget(&mut self, widget_id: String, so_path: String, content_hash: u64) {
        self.loaded_widget_paths.insert(widget_id.clone(), so_path);
        self.widget_hashes.insert(widget_id, content_hash);
    }

    /// Unregister a widget module
    pub fn unregister_widget(&mut self, widget_id: &str) {
        self.loaded_widget_paths.remove(widget_id);
        self.widget_hashes.remove(widget_id);
    }

    /// Check if a widget needs rebuild based on content hash
    pub fn widget_needs_rebuild(&self, widget_id: &str, new_hash: u64) -> bool {
        self.widget_hashes
            .get(widget_id)
            .map(|&h| h != new_hash)
            .unwrap_or(true)
    }

    /// Get all loaded widget paths
    pub fn get_widget_paths(&self) -> &HashMap<String, String> {
        &self.loaded_widget_paths
    }
}
