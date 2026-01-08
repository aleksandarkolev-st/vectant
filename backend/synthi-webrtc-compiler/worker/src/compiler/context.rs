use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::data_channel::RTCDataChannel;

use crate::runtime::runner_state::RunnerState;
use crate::hmr::fast_refresh::BoundaryChecker;
use crate::hmr::incremental_cache::IncrementalCache;
use crate::hmr::orchestrator::HmrOrchestrator;
use crate::infra::observability::{StructuredLogger, MetricsAggregator};
use crate::safety::restart_control::RestartController;
use crate::safety::hardened_ipc::IpcConfig;

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
        }
    }
}
