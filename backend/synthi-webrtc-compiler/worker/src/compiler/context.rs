use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;

use crate::hmr::fast_refresh::BoundaryChecker;
use crate::hmr::incremental_cache::IncrementalCache;
use crate::hmr::orchestrator::HmrOrchestrator;
use crate::infra::observability::{MetricsAggregator, StructuredLogger};
use crate::runtime::path_c::supervisor::SupervisedSession;
use crate::runtime::path_c::xvfb_allocator::XvfbAllocator;
use crate::runtime::runner_state::RunnerState;
use crate::safety::hardened_ipc::IpcConfig;
use crate::safety::restart_control::RestartController;
use crate::webrtc::TrackFanout;

pub struct CompileContext {
    pub log_dc: Arc<RTCDataChannel>,
    pub terminal_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    pub sdl_input_store: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    pub runner_store: Arc<Mutex<Option<RunnerState>>>,
    pub pc: Arc<RTCPeerConnection>,
    pub workspace_path: PathBuf,
    pub compile_cache: Arc<Mutex<HashMap<String, (u64, String)>>>,
    pub boundary_checker: Arc<Mutex<BoundaryChecker>>,
    pub incremental_cache: Arc<IncrementalCache>,
    pub hmr_orchestrator: Arc<Mutex<HmrOrchestrator>>,
    pub structured_logger: Arc<StructuredLogger>,
    pub metrics_aggregator: Arc<Mutex<MetricsAggregator>>,
    pub restart_controller: Arc<Mutex<RestartController>>,
    pub ipc_config: Arc<IpcConfig>,
    // Phase 12.6: per-session supervisor (typed IPC, per-session Xvfb)
    pub supervisor_store: Arc<Mutex<Option<SupervisedSession>>>,
    pub xvfb_allocator: Arc<Mutex<XvfbAllocator>>,
    /// Session-wide RTP fanouts. Producers (runner.rs + video_pipeline.rs)
    /// dispatch packets here; the PC-creation code in main.rs subscribes
    /// each peer's per-peer track to them. Dropping a peer (via
    /// `PeerRegistry::remove`) drops its `FanoutSubscription`, severing
    /// dispatch to that peer without affecting the rest.
    pub video_fanout: Arc<TrackFanout>,
    pub audio_fanout: Arc<TrackFanout>,
}

impl Clone for CompileContext {
    fn clone(&self) -> Self {
        Self {
            log_dc: self.log_dc.clone(),
            terminal_store: self.terminal_store.clone(),
            sdl_input_store: self.sdl_input_store.clone(),
            runner_store: self.runner_store.clone(),
            pc: self.pc.clone(),
            workspace_path: self.workspace_path.clone(),
            compile_cache: self.compile_cache.clone(),
            boundary_checker: self.boundary_checker.clone(),
            incremental_cache: self.incremental_cache.clone(),
            hmr_orchestrator: self.hmr_orchestrator.clone(),
            structured_logger: self.structured_logger.clone(),
            metrics_aggregator: self.metrics_aggregator.clone(),
            restart_controller: self.restart_controller.clone(),
            ipc_config: self.ipc_config.clone(),
            supervisor_store: self.supervisor_store.clone(),
            xvfb_allocator: self.xvfb_allocator.clone(),
            video_fanout: self.video_fanout.clone(),
            audio_fanout: self.audio_fanout.clone(),
        }
    }
}
