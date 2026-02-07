mod project_detection;
mod react_native_emulator_job;
mod native_android_emulator_job;

pub use react_native_emulator_job::handle_react_native_emulator_job;
pub use native_android_emulator_job::{
    handle_native_android_emulator_job, 
    NativeAndroidJobConfig,
    parse_job_config as parse_native_android_job_config,
};

use std::path::PathBuf;
use std::sync::Arc;
use anyhow::Result;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;

use crate::android::emulator::EmulatorConfig;
use crate::android::native_android::BuildVariant;

/// Wrapper for native Android job handler that matches React Native handler signature
pub async fn handle_native_android_job_simple(
    log_dc: Arc<RTCDataChannel>,
    session_id: String,
    workspace_path: PathBuf,
    project_root: Option<String>,
    is_release: bool,
    pc: Arc<RTCPeerConnection>,
) -> Result<()> {
    // Determine project root path
    let project_path = if let Some(root) = &project_root {
        let cleaned = root.trim_start_matches('/');
        if cleaned.is_empty() {
            workspace_path.clone()
        } else {
            workspace_path.join(cleaned)
        }
    } else {
        workspace_path.clone()
    };

    // Create config for native Android job
    let config = NativeAndroidJobConfig {
        session_id: session_id.clone(),
        workspace_id: workspace_path.display().to_string(),
        project_root: project_path,
        build_variant: if is_release { BuildVariant::Release } else { BuildVariant::Debug },
        flavor: None,
        clean_build: false,
        extra_gradle_args: Vec::new(),
        emulator_config: EmulatorConfig::default(),
        enable_logcat: true,
        logcat_filter: None,
        max_session_secs: 1800,
    };

    handle_native_android_emulator_job(config, pc, log_dc).await
}
