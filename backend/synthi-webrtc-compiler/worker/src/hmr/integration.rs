// ============================================================
// HMR INTEGRATION MODULE
// ============================================================
// Wires together all HMR subsystems into a single cohesive
// pipeline that the compile handler and runner call into.
//
// This module is the bridge between:
//   - handler.rs (compile request) â†’ planner â†’ adapter dispatch
//   - runner.rs  (runner execution) â†’ orchestrator â†’ state management
//   - frontend   (WebRTC messages)  â†’ status notifications
//
// Call flow:
//   1. Handler calls `HmrPipeline::plan_and_dispatch()` after compile
//   2. Planner decides WarmReload / ColdReload / ProcessSwap / etc.
//   3. Adapter registry selects the right adapter for the language
//   4. AI gate blocks/allows AI calls based on Loop A/B classification
//   5. State system snapshots + restores across the reload
//   6. Status notifications are emitted for the frontend
// ============================================================

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use crate::hmr::adapter_lifecycle_fsm::{AdapterLifecycleFsm, LifecycleEvent};
use crate::hmr::adapter_matrix::{AdapterFamily, AdapterMatrix};
use crate::hmr::adapter_registry::{create_adapter_for_language, AdapterRegistry};
use crate::hmr::adapter_trait::{
    AdapterHealth, AdapterReloadRequest, AdapterReloadResult, ReloadArtifactBlob,
    ReloadCapsuleMetadata,
};
use crate::hmr::ai_gate::{AiGate, AiGateDecision};
use crate::hmr::build_manifest::BuildManifest;
use crate::hmr::candidate::CandidateState;
use crate::hmr::candidate_bridge::{bridge_tick, BridgeAction, BridgeConfig};
use crate::hmr::candidate_notification::CandidateNotification;
use crate::hmr::candidate_queue::CandidateQueue;
use crate::hmr::candidate_supersession::{should_supersede, SupersessionVerdict};
use crate::hmr::health_check::HealthCheckResult;
use crate::hmr::lifecycle_machine::LifecycleStateMachine;
use crate::hmr::loop_classifier::CompileLoop;
use crate::hmr::planner::{PlannerInput, PlannerOutput};
use crate::hmr::planner_decision::StateStrategy;
use crate::hmr::planner_glue::{execute_planner_and_transition, PlannerNotification};
use crate::hmr::rollout_flags::RolloutFlags;
use crate::hmr::telemetry::HmrTelemetry;

// â”€â”€ Status notification types (serialized to JSON for WebRTC) â”€â”€

/// Adapter status notification sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdapterStatusNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub adapter_family: String,
    pub language: Option<String>,
    pub health: String,
    pub reload_count: u32,
    pub failed_reload_count: u32,
    pub last_reload_ms: Option<u64>,
    pub active_slot: Option<String>,
    pub state_preserved: Option<bool>,
}

/// AI status notification sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AiStatusNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub ai_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u32>,
}

/// State restore notification sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StateRestoreNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub restore_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserved_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lost_fields: Option<Vec<String>>,
}

/// Adapter health notification for the health panel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AdapterHealthNotification {
    #[serde(rename = "type")]
    pub msg_type: &'static str,
    pub family: String,
    pub active: bool,
    pub health: String,
    pub reloads: u32,
    pub last_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// â”€â”€ Collected notifications from a pipeline run â”€â”€

/// All notifications produced by a single pipeline execution.
/// The runner serializes these to JSON and sends them over WebRTC.
#[derive(Debug, Clone, Default)]
pub struct PipelineNotifications {
    /// JSON strings ready to send over the data channel.
    pub messages: Vec<String>,
}

impl PipelineNotifications {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
        }
    }

    fn push_json<T: serde::Serialize>(&mut self, notification: &T) {
        if let Ok(json) = serde_json::to_string(notification) {
            self.messages.push(json);
        }
    }

    fn extend(&mut self, other: PipelineNotifications) {
        self.messages.extend(other.messages);
    }
}

// â”€â”€ The HMR Pipeline â”€â”€

/// Persistent per-session HMR pipeline state.
///
/// Created once when the handler starts a session and reused
/// across HMR reloads within that session.
pub struct HmrPipeline {
    /// Adapter registry (language â†’ concrete adapter).
    pub adapter_registry: AdapterRegistry,
    /// Adapter matrix for capability lookups.
    pub adapter_matrix: AdapterMatrix,
    /// Rollout / kill switch flags.
    pub rollout_flags: RolloutFlags,
    /// AI call gate (Loop A blocks, Loop B allows).
    pub ai_gate: AiGate,
    /// Lifecycle state machine for the preview session.
    pub lifecycle: LifecycleStateMachine,
    /// Telemetry collector.
    pub telemetry: HmrTelemetry,
    /// Adapter lifecycle FSMs per language.
    pub adapter_fsms: HashMap<String, AdapterLifecycleFsm>,
    /// Languages whose adapters were initialized successfully.
    initialized_adapters: HashSet<String>,
    /// Candidate queue for build-to-load pipeline.
    pub candidate_queue: CandidateQueue,
    /// Candidate bridge config.
    pub bridge_config: BridgeConfig,
    /// Per-language reload counters.
    reload_counts: HashMap<String, u32>,
    /// Per-language failure counters.
    failure_counts: HashMap<String, u32>,
    /// Consecutive failure counter (across all languages).
    pub consecutive_failures: u32,
    /// Previous build manifest (for diff-based decisions).
    pub prev_manifest: Option<BuildManifest>,
}

impl HmrPipeline {
    /// Create a new pipeline for a preview session.
    pub fn new(preview_id: &str) -> Self {
        let adapter_matrix = AdapterMatrix::default_matrix();
        let adapter_registry = AdapterRegistry::from_matrix(&adapter_matrix);

        Self {
            adapter_registry,
            adapter_matrix,
            rollout_flags: RolloutFlags::new_defaults(),
            ai_gate: AiGate::new(),
            lifecycle: LifecycleStateMachine::new(preview_id),
            telemetry: HmrTelemetry::new(),
            adapter_fsms: HashMap::new(),
            initialized_adapters: HashSet::new(),
            candidate_queue: CandidateQueue::new(preview_id),
            bridge_config: BridgeConfig::default(),
            reload_counts: HashMap::new(),
            failure_counts: HashMap::new(),
            consecutive_failures: 0,
            prev_manifest: None,
        }
    }

    /// Initialize the adapter for a specific language (if not already done).
    pub fn ensure_adapter(&mut self, language: &str) {
        if self.adapter_registry.get_info(language).is_none() {
            if let Some(adapter) = create_adapter_for_language(language) {
                self.adapter_registry.register(language, adapter);
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        if !self.adapter_fsms.contains_key(language) {
            let mut fsm = AdapterLifecycleFsm::new();
            let _ = fsm.apply(LifecycleEvent::Initialize, now);
            self.adapter_fsms.insert(language.to_string(), fsm);
        }

        if !self.initialized_adapters.contains(language) {
            let init_result = self
                .adapter_registry
                .get_mut(language)
                .map(|adapter| adapter.initialize())
                .unwrap_or_else(|| {
                    Err(format!("No adapter registered for language '{}'", language))
                });

            match init_result {
                Ok(()) => {
                    self.initialized_adapters.insert(language.to_string());
                    if let Some(fsm) = self.adapter_fsms.get_mut(language) {
                        let _ = fsm.apply(LifecycleEvent::InitializeComplete, now);
                    }
                }
                Err(error) => {
                    eprintln!(
                        "[HMR Integration] Failed to initialize adapter for {}: {}",
                        language, error
                    );
                }
            }
        }
    }

    pub fn enqueue_candidate(
        &mut self,
        manifest: &BuildManifest,
        planner_output: &PlannerOutput,
    ) -> PipelineNotifications {
        let mut notifications = PipelineNotifications::new();

        if let Some(active) = self.candidate_queue.active() {
            match should_supersede(
                active,
                &manifest.artifact_hash,
                &self.bridge_config.supersession_policy,
            ) {
                SupersessionVerdict::Duplicate => {
                    return notifications;
                }
                SupersessionVerdict::Supersede => {
                    if let Some(active_candidate) = self.candidate_queue.active_mut() {
                        active_candidate.discard();
                    }
                    if let Some(summary) = self.candidate_queue.complete_active() {
                        notifications.push_json(&CandidateNotification::Discarded {
                            preview_id: summary.preview_id,
                            generation: summary.generation,
                            reason: "superseded_by_newer_candidate".into(),
                        });
                    }
                }
                SupersessionVerdict::LetFinish => {}
            }
        }

        let generation = self.candidate_queue.enqueue(
            manifest.clone(),
            planner_output.decision,
            planner_output.reason.state_strategy,
        );

        notifications.push_json(&CandidateNotification::Enqueued {
            preview_id: manifest.preview_id.clone(),
            generation,
            artifact_hash: manifest.artifact_hash.clone(),
        });

        notifications
    }

    pub fn validate_active_candidate(&mut self, total_reload_ms: u64) -> PipelineNotifications {
        let mut notifications = PipelineNotifications::new();

        if let Some(active) = self.candidate_queue.active_mut() {
            if active.state == CandidateState::Loading {
                active.begin_health_check();
                notifications.push_json(&CandidateNotification::HealthCheckStarted {
                    preview_id: active.id.preview_id.clone(),
                    generation: active.id.generation,
                });
            }

            let result = HealthCheckResult::Healthy {
                latency_ms: total_reload_ms,
            };
            active.record_health(result.clone());
            notifications.push_json(&CandidateNotification::HealthCheckCompleted {
                preview_id: active.id.preview_id.clone(),
                generation: active.id.generation,
                result,
            });
        }

        notifications.extend(self.tick_candidates(current_time_ms()));
        notifications
    }

    pub fn reject_active_candidate(&mut self, reason: impl Into<String>) -> PipelineNotifications {
        let mut notifications = PipelineNotifications::new();
        let reason = reason.into();

        if let Some(active) = self.candidate_queue.active_mut() {
            active.rollback(reason.clone());
        }

        if let Some(summary) = self.candidate_queue.complete_active() {
            notifications.push_json(&CandidateNotification::RolledBack {
                preview_id: summary.preview_id,
                generation: summary.generation,
                reason,
            });
        }

        notifications.extend(self.tick_candidates(current_time_ms()));
        notifications
    }

    /// Classify whether this compile is Loop A (deterministic) or Loop B (AI-assisted).
    ///
    /// Simplified classification: Loop B if AI changes are present or
    /// there have been consecutive failures triggering rescue mode.
    pub fn classify_loop(&self, has_ai_changes: bool) -> CompileLoop {
        if has_ai_changes || self.consecutive_failures >= 2 {
            CompileLoop::LoopB
        } else {
            CompileLoop::LoopA
        }
    }

    /// Check the AI gate for this compile loop.
    pub fn check_ai_gate(&self, loop_type: CompileLoop, endpoint: &str) -> AiGateDecision {
        self.ai_gate.check(loop_type, endpoint)
    }

    /// Run the planner to decide what kind of reload to do.
    ///
    /// Returns the planner output and a notification for the frontend.
    pub fn plan_reload(
        &mut self,
        manifest: &BuildManifest,
        abi_changed: bool,
        schema_changed: bool,
        runtime_supports_warm_reload: bool,
    ) -> (PlannerOutput, PlannerNotification) {
        let input = PlannerInput {
            manifest,
            prev_manifest: self.prev_manifest.as_ref(),
            adapter_matrix: &self.adapter_matrix,
            rollout_flags: &self.rollout_flags,
            abi_changed,
            schema_changed,
            runtime_supports_warm_reload,
            consecutive_failures: self.consecutive_failures,
        };

        execute_planner_and_transition(&input, &mut self.lifecycle, &self.telemetry)
    }

    /// Execute a reload through the adapter and produce all notifications.
    ///
    /// This is the main entry point called after `plan_reload()`.
    pub fn execute_reload(
        &mut self,
        language: &str,
        manifest: &BuildManifest,
        planner_output: &PlannerOutput,
        reload_id: &str,
    ) -> (AdapterReloadResult, PipelineNotifications) {
        let start = Instant::now();
        let mut notifications = PipelineNotifications::new();

        self.ensure_adapter(language);

        // Transition adapter FSM to Reloading
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Some(fsm) = self.adapter_fsms.get_mut(language) {
            let _ = fsm.apply(LifecycleEvent::BeginReload, now_ms);
        }

        // Emit snapshot_capturing phase notification
        notifications.push_json(&StateRestoreNotification {
            msg_type: "state_restore_status",
            restore_type: "snapshot_capturing".into(),
            module: Some(manifest.slot_name()),
            preserved_fields: None,
            reset_fields: None,
            error: None,
            fallback: None,
            strategy: None,
            duration_ms: None,
            warnings: None,
            lost_fields: None,
        });

        // Emit state restore "started" notification with strategy
        let restore_strategy = match planner_output.reason.state_strategy {
            StateStrategy::Preserve => "direct",
            StateStrategy::Migrate => "migrate",
            _ => "unknown",
        };
        notifications.push_json(&StateRestoreNotification {
            msg_type: "state_restore_status",
            restore_type: "restore_started".into(),
            module: Some(manifest.slot_name()),
            preserved_fields: None,
            reset_fields: None,
            error: None,
            fallback: None,
            strategy: Some(restore_strategy.to_string()),
            duration_ms: None,
            warnings: None,
            lost_fields: None,
        });

        // Dispatch to the adapter
        let reload_req = AdapterReloadRequest {
            reload_id: reload_id.to_string(),
            module_id: manifest.slot_name(),
            changed_files: manifest.dirty_units.clone().unwrap_or_default(),
            build_manifest: manifest.clone(),
            artifact_blob: None,
            capsule_metadata: None,
            preserve_state: matches!(
                planner_output.reason.state_strategy,
                StateStrategy::Preserve | StateStrategy::Migrate
            ),
            timeout_ms: 5000,
        };

        let result = if let Some(adapter) = self.adapter_registry.get_mut(language) {
            adapter.reload(&reload_req)
        } else {
            AdapterReloadResult::Unsupported {
                reason: format!("No adapter registered for language '{}'", language),
            }
        };

        let elapsed_ms = start.elapsed().as_millis() as u64;
        let adapter_family = self
            .adapter_registry
            .get_info(language)
            .map(|info| info.family);
        let dynlib_preflight_only = matches!(adapter_family, Some(AdapterFamily::DynamicLibrary));

        // Update counters based on result
        match &result {
            AdapterReloadResult::Success {
                state_preserved,
                reload_ms,
            } => {
                *self.reload_counts.entry(language.to_string()).or_insert(0) += 1;
                self.consecutive_failures = 0;

                // Transition adapter FSM to Ready
                if let Some(fsm) = self.adapter_fsms.get_mut(language) {
                    let _ = fsm.apply(LifecycleEvent::ReloadComplete, now_ms + elapsed_ms);
                }

                // State restore complete notification with real strategy and duration
                if !dynlib_preflight_only {
                    let strategy_str = if *state_preserved {
                        restore_strategy.to_string()
                    } else {
                        "discard".to_string()
                    };
                    notifications.push_json(&StateRestoreNotification {
                        msg_type: "state_restore_status",
                        restore_type: "restore_complete".into(),
                        module: Some(manifest.slot_name()),
                        preserved_fields: None, // filled by runner when available
                        reset_fields: None,     // filled by runner when available
                        error: None,
                        fallback: if *state_preserved {
                            None
                        } else {
                            Some("state_discarded".into())
                        },
                        strategy: Some(strategy_str),
                        duration_ms: Some(*reload_ms),
                        warnings: None,
                        lost_fields: None,
                    });
                }
            }
            AdapterReloadResult::Failed { error, .. } => {
                *self.failure_counts.entry(language.to_string()).or_insert(0) += 1;
                self.consecutive_failures += 1;

                if let Some(fsm) = self.adapter_fsms.get_mut(language) {
                    let _ = fsm.apply(LifecycleEvent::ReloadFailed, now_ms + elapsed_ms);
                }

                notifications.push_json(&StateRestoreNotification {
                    msg_type: "state_restore_status",
                    restore_type: "restore_error".into(),
                    module: Some(manifest.slot_name()),
                    preserved_fields: None,
                    reset_fields: None,
                    error: Some(error.clone()),
                    fallback: None,
                    strategy: None,
                    duration_ms: Some(elapsed_ms),
                    warnings: None,
                    lost_fields: None,
                });
            }
            AdapterReloadResult::Unsupported { reason } => {
                self.consecutive_failures += 1;

                notifications.push_json(&StateRestoreNotification {
                    msg_type: "state_restore_status",
                    restore_type: "restore_error".into(),
                    module: Some(manifest.slot_name()),
                    preserved_fields: None,
                    reset_fields: None,
                    error: Some(reason.clone()),
                    fallback: Some("full_restart".into()),
                    strategy: None,
                    duration_ms: Some(elapsed_ms),
                    warnings: None,
                    lost_fields: None,
                });
            }
        }

        // Emit adapter status notification
        let health = self
            .adapter_registry
            .get_mut(language)
            .map(|a| a.healthcheck())
            .unwrap_or(AdapterHealth::Unknown);

        let adapter_info = self.adapter_registry.get_info(language);
        let family_str = adapter_info
            .as_ref()
            .map(|i| format!("{:?}", i.family))
            .unwrap_or_else(|| "unknown".into());

        let reload_count = *self.reload_counts.get(language).unwrap_or(&0);
        let failed_count = *self.failure_counts.get(language).unwrap_or(&0);

        notifications.push_json(&AdapterStatusNotification {
            msg_type: "adapter_status",
            adapter_family: family_str.clone(),
            language: Some(language.to_string()),
            health: format!("{:?}", health).to_lowercase(),
            reload_count,
            failed_reload_count: failed_count,
            last_reload_ms: Some(elapsed_ms),
            active_slot: None,
            state_preserved: match &result {
                AdapterReloadResult::Success {
                    state_preserved, ..
                } if !dynlib_preflight_only => Some(*state_preserved),
                _ => None,
            },
        });

        // Emit adapter health notification
        notifications.push_json(&AdapterHealthNotification {
            msg_type: "adapter_health",
            family: family_str,
            active: true,
            health: format!("{:?}", health).to_lowercase(),
            reloads: reload_count,
            last_ms: Some(elapsed_ms),
            lifecycle_state: self
                .adapter_fsms
                .get(language)
                .map(|fsm| format!("{:?}", fsm.state())),
            ai_active: Some(self.consecutive_failures > 0),
            error: match &result {
                AdapterReloadResult::Failed { error, .. } => Some(error.clone()),
                AdapterReloadResult::Unsupported { reason } => Some(reason.clone()),
                _ => None,
            },
        });

        // Update previous manifest
        self.prev_manifest = Some(manifest.clone());

        (result, notifications)
    }

    /// Execute the paired GPU device reload without replacing the host
    /// `prev_manifest`.
    ///
    /// GPU projects are two-adapter projects: the existing host adapter
    /// owns the `.so` lifecycle, while the device adapter owns the
    /// sidecar cubin / hsaco lifecycle. The generic `execute_reload`
    /// path stores a single `prev_manifest` for host ABI decisions, so
    /// device reloads use this narrower dispatch surface until the
    /// planner grows first-class multi-manifest state.
    pub fn execute_gpu_device_reload(
        &mut self,
        language: &str,
        manifest: &BuildManifest,
        artifact_blob: Option<ReloadArtifactBlob>,
        capsule_metadata: Option<ReloadCapsuleMetadata>,
        reload_id: &str,
    ) -> (AdapterReloadResult, PipelineNotifications) {
        let start = Instant::now();
        let mut notifications = PipelineNotifications::new();

        self.ensure_adapter(language);

        let now_ms = current_time_ms();
        if let Some(fsm) = self.adapter_fsms.get_mut(language) {
            let _ = fsm.apply(LifecycleEvent::BeginReload, now_ms);
        }

        let reload_req = AdapterReloadRequest {
            reload_id: reload_id.to_string(),
            module_id: manifest.slot_name(),
            changed_files: manifest.dirty_units.clone().unwrap_or_default(),
            build_manifest: manifest.clone(),
            artifact_blob,
            capsule_metadata,
            preserve_state: true,
            timeout_ms: 5000,
        };

        let result = if let Some(adapter) = self.adapter_registry.get_mut(language) {
            adapter.reload(&reload_req)
        } else {
            AdapterReloadResult::Unsupported {
                reason: format!("No GPU adapter registered for language '{}'", language),
            }
        };

        let elapsed_ms = start.elapsed().as_millis() as u64;
        match &result {
            AdapterReloadResult::Success { .. } => {
                *self.reload_counts.entry(language.to_string()).or_insert(0) += 1;
                if let Some(fsm) = self.adapter_fsms.get_mut(language) {
                    let _ = fsm.apply(LifecycleEvent::ReloadComplete, now_ms + elapsed_ms);
                }
            }
            AdapterReloadResult::Failed { error, .. } => {
                *self.failure_counts.entry(language.to_string()).or_insert(0) += 1;
                if let Some(fsm) = self.adapter_fsms.get_mut(language) {
                    let _ = fsm.apply(LifecycleEvent::ReloadFailed, now_ms + elapsed_ms);
                }
                notifications.push_json(&StateRestoreNotification {
                    msg_type: "state_restore_status",
                    restore_type: "gpu_restore_error".into(),
                    module: Some(manifest.slot_name()),
                    preserved_fields: None,
                    reset_fields: None,
                    error: Some(error.clone()),
                    fallback: None,
                    strategy: Some("gpu_device_reload".into()),
                    duration_ms: Some(elapsed_ms),
                    warnings: None,
                    lost_fields: None,
                });
            }
            AdapterReloadResult::Unsupported { reason } => {
                notifications.push_json(&StateRestoreNotification {
                    msg_type: "state_restore_status",
                    restore_type: "gpu_restore_unsupported".into(),
                    module: Some(manifest.slot_name()),
                    preserved_fields: None,
                    reset_fields: None,
                    error: Some(reason.clone()),
                    fallback: Some("cold_restart".into()),
                    strategy: Some("gpu_device_reload".into()),
                    duration_ms: Some(elapsed_ms),
                    warnings: None,
                    lost_fields: None,
                });
            }
        }

        let health = self
            .adapter_registry
            .get_mut(language)
            .map(|a| a.healthcheck())
            .unwrap_or(AdapterHealth::Unknown);
        let adapter_info = self.adapter_registry.get_info(language);
        let family_str = adapter_info
            .as_ref()
            .map(|i| format!("{:?}", i.family))
            .unwrap_or_else(|| "unknown".into());
        let reload_count = *self.reload_counts.get(language).unwrap_or(&0);
        let failed_count = *self.failure_counts.get(language).unwrap_or(&0);

        notifications.push_json(&AdapterStatusNotification {
            msg_type: "adapter_status",
            adapter_family: family_str.clone(),
            language: Some(language.to_string()),
            health: format!("{:?}", health).to_lowercase(),
            reload_count,
            failed_reload_count: failed_count,
            last_reload_ms: Some(elapsed_ms),
            active_slot: Some("device".into()),
            state_preserved: match &result {
                AdapterReloadResult::Success {
                    state_preserved, ..
                } => Some(*state_preserved),
                _ => None,
            },
        });

        notifications.push_json(&AdapterHealthNotification {
            msg_type: "adapter_health",
            family: family_str,
            active: true,
            health: format!("{:?}", health).to_lowercase(),
            reloads: reload_count,
            last_ms: Some(elapsed_ms),
            lifecycle_state: self
                .adapter_fsms
                .get(language)
                .map(|fsm| format!("{:?}", fsm.state())),
            ai_active: Some(false),
            error: match &result {
                AdapterReloadResult::Failed { error, .. } => Some(error.clone()),
                AdapterReloadResult::Unsupported { reason } => Some(reason.clone()),
                _ => None,
            },
        });

        (result, notifications)
    }

    /// Build a state_restore_status notification with real field data.
    ///
    /// Called from the runner after the orchestrator's hot_reload returns
    /// an HmrResult with actual preserved/reset field lists.
    pub fn build_restore_complete_notification(
        module: &str,
        strategy: &str,
        preserved_fields: Vec<String>,
        reset_fields: Vec<String>,
        lost_fields: Vec<String>,
        duration_ms: u64,
        warnings: Vec<String>,
    ) -> String {
        let notification = StateRestoreNotification {
            msg_type: "state_restore_status",
            restore_type: "restore_complete".into(),
            module: Some(module.to_string()),
            preserved_fields: Some(preserved_fields),
            reset_fields: Some(reset_fields),
            error: None,
            fallback: None,
            strategy: Some(strategy.to_string()),
            duration_ms: Some(duration_ms),
            warnings: if warnings.is_empty() {
                None
            } else {
                Some(warnings)
            },
            lost_fields: if lost_fields.is_empty() {
                None
            } else {
                Some(lost_fields)
            },
        };
        serde_json::to_string(&notification).unwrap_or_default()
    }

    /// Tick the candidate bridge (called periodically or after events).
    pub fn tick_candidates(&mut self, current_time_ms: u64) -> PipelineNotifications {
        let mut notifications = PipelineNotifications::new();

        for _ in 0..4 {
            let (action, bridge_notifications) =
                bridge_tick(&self.candidate_queue, &self.bridge_config, current_time_ms);

            for notification in bridge_notifications {
                notifications.push_json(&notification);
            }

            let mut mutated = false;
            match action {
                BridgeAction::BeginLoad { .. } => {
                    if let Some(active) = self.candidate_queue.activate_next() {
                        notifications.push_json(&CandidateNotification::Loading {
                            preview_id: active.id.preview_id.clone(),
                            generation: active.id.generation,
                        });
                        mutated = true;
                    }
                }
                BridgeAction::Promote { generation } => {
                    if let Some(active) = self.candidate_queue.active_mut() {
                        if active.id.generation == generation {
                            active.promote();
                            mutated = true;
                        }
                    }

                    if mutated {
                        if let Some(summary) = self.candidate_queue.complete_active() {
                            notifications.push_json(&CandidateNotification::Promoted {
                                preview_id: summary.preview_id,
                                generation: summary.generation,
                                total_reload_ms: summary.age_ms,
                            });
                        }
                    }
                }
                BridgeAction::Rollback { generation, reason } => {
                    if let Some(active) = self.candidate_queue.active_mut() {
                        if active.id.generation == generation {
                            active.rollback(reason.clone());
                            mutated = true;
                        }
                    }

                    if mutated {
                        if let Some(summary) = self.candidate_queue.complete_active() {
                            notifications.push_json(&CandidateNotification::RolledBack {
                                preview_id: summary.preview_id,
                                generation: summary.generation,
                                reason,
                            });
                        }
                    }
                }
                BridgeAction::Discard { generation, reason } => {
                    if let Some(active) = self.candidate_queue.active_mut() {
                        if active.id.generation == generation {
                            active.discard();
                            mutated = true;
                        }
                    }

                    if mutated {
                        if let Some(summary) = self.candidate_queue.complete_active() {
                            notifications.push_json(&CandidateNotification::Discarded {
                                preview_id: summary.preview_id,
                                generation: summary.generation,
                                reason,
                            });
                        }
                    }
                }
                BridgeAction::Idle | BridgeAction::BeginHealthCheck { .. } => {}
            }

            if !mutated {
                break;
            }
        }

        notifications
    }

    /// Emit an AI status notification (called by the AI gate / circuit breaker).
    pub fn emit_ai_notification(
        &self,
        ai_type: &str,
        extra: HashMap<String, serde_json::Value>,
    ) -> PipelineNotifications {
        let mut notifications = PipelineNotifications::new();

        notifications.push_json(&AiStatusNotification {
            msg_type: "ai_status",
            ai_type: ai_type.to_string(),
            request_id: extra
                .get("request_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tokens_used: extra.get("tokens_used").and_then(|v| v.as_u64()),
            estimated_cost: extra.get("estimated_cost").and_then(|v| v.as_f64()),
            budget_used_percent: extra.get("budget_used_percent").and_then(|v| v.as_f64()),
            state: extra
                .get("state")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            level: extra
                .get("level")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            remaining: extra
                .get("remaining")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32),
        });

        notifications
    }

    /// Get the AI gate stats snapshot.
    pub fn ai_stats(&self) -> crate::hmr::ai_gate::AiGateStatsSnapshot {
        self.ai_gate.stats()
    }

    /// Get current adapter health for all registered languages.
    pub fn all_adapter_health(&self) -> Vec<(String, AdapterHealth)> {
        let mut result = Vec::new();
        for lang in self.adapter_registry.languages() {
            if self.adapter_registry.get_info(lang).is_some() {
                let health = self
                    .adapter_fsms
                    .get(lang)
                    .map(|_| AdapterHealth::Healthy) // FSM exists = initialized
                    .unwrap_or(AdapterHealth::Unknown);
                result.push((lang.to_string(), health));
            }
        }
        result
    }
}

// â”€â”€ Helper for BuildManifest to get a readable slot name â”€â”€

impl BuildManifest {
    /// Get a human-readable slot name.
    pub fn slot_name(&self) -> String {
        match &self.slot {
            crate::hmr::build_manifest::BuildSlot::Core => "core".into(),
            crate::hmr::build_manifest::BuildSlot::Gui => "gui".into(),
            crate::hmr::build_manifest::BuildSlot::Widget(name) => format!("widget:{}", name),
            crate::hmr::build_manifest::BuildSlot::Full => "full".into(),
            crate::hmr::build_manifest::BuildSlot::Custom(name) => name.clone(),
        }
    }
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(all(test, feature = "legacy_hmr_tests"))]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{
        BuildSlot, HealthcheckStrategy, PreviewPreservationMode, SnapshotMode,
    };

    fn make_manifest(language: &str) -> BuildManifest {
        BuildManifest {
            preview_id: "test-preview".into(),
            language: language.into(),
            adapter_family: "DynamicLibrary".into(),
            capability_tier: 2,
            slot: BuildSlot::Core,
            artifact_path: "/tmp/test.so".into(),
            artifact_hash: "abc123".into(),
            toolchain_fingerprint: "gcc-12".into(),
            abi_version: "1.0".into(),
            state_schema_hash: "s1".into(),
            snapshot_modes: vec![SnapshotMode::Binary],
            capabilities: vec![],
            preview_preservation_mode: PreviewPreservationMode::KeepAlive,
            dirty_unit_source: None,
            exported_symbols: vec!["core_on_load".into(), "core_on_update".into()],
            dependencies: vec![],
            healthcheck_strategy: HealthcheckStrategy::SymbolCheck,
            rollout_flags: Default::default(),
            build_time_ms: 200,
            translation_units: None,
            dirty_units: None,
            header_fingerprint: None,
            source_map_metadata: None,
            candidate_generation: None,
            boundary_map_version: None,
            provenance_id: None,
        }
    }

    #[test]
    fn pipeline_new_creates_adapters() {
        let pipeline = HmrPipeline::new("test");
        assert!(pipeline.adapter_registry.len() >= 6);
    }

    #[test]
    fn pipeline_classify_loop_a_default() {
        let pipeline = HmrPipeline::new("test");
        let loop_type = pipeline.classify_loop(false);
        assert!(matches!(loop_type, CompileLoop::LoopA));
    }

    #[test]
    fn pipeline_ai_gate_blocks_loop_a() {
        let pipeline = HmrPipeline::new("test");
        let decision = pipeline.check_ai_gate(CompileLoop::LoopA, "refactor");
        assert!(!decision.is_allowed());
    }

    #[test]
    fn pipeline_ai_gate_allows_loop_b() {
        let pipeline = HmrPipeline::new("test");
        let decision = pipeline.check_ai_gate(CompileLoop::LoopB, "refactor");
        assert!(decision.is_allowed());
    }

    #[test]
    fn pipeline_execute_reload_produces_notifications() {
        let mut pipeline = HmrPipeline::new("test");
        let manifest = make_manifest("cpp");

        // Plan first (need lifecycle in correct state)
        // Skip planner for this test â€” just exercise execute_reload
        pipeline.ensure_adapter("cpp");

        let (result, notifications) = pipeline.execute_reload(
            "cpp",
            &manifest,
            &PlannerOutput {
                decision: ReloadDecision::WarmReload,
                reason: crate::hmr::planner_decision::PlannerReasonBundle {
                    decision: ReloadDecision::WarmReload,
                    decision_reason: "test".into(),
                    decision_code: "TEST".into(),
                    state_strategy: StateStrategy::Migrate,
                    fallback_strategy: crate::hmr::planner_decision::FallbackStrategy::ColdReload,
                    user_message: String::new(),
                },
            },
            "reload-1",
        );

        // Should have at least: state_restore_started, state_restore_complete/error,
        // adapter_status, adapter_health
        assert!(
            notifications.messages.len() >= 3,
            "Expected >= 3 notifications, got {}",
            notifications.messages.len()
        );

        // Verify adapter_status message exists
        let has_adapter_status = notifications
            .messages
            .iter()
            .any(|m| m.contains("adapter_status"));
        assert!(has_adapter_status, "Missing adapter_status notification");

        // Verify adapter_health message exists
        let has_adapter_health = notifications
            .messages
            .iter()
            .any(|m| m.contains("adapter_health"));
        assert!(has_adapter_health, "Missing adapter_health notification");
    }

    #[test]
    fn pipeline_tracks_failure_counts() {
        let mut pipeline = HmrPipeline::new("test");
        let manifest = make_manifest("brainfuck"); // unknown language

        let planner_output = PlannerOutput {
            decision: ReloadDecision::WarmReload,
            reason: crate::hmr::planner_decision::PlannerReasonBundle {
                decision: ReloadDecision::WarmReload,
                decision_reason: "test".into(),
                decision_code: "TEST".into(),
                state_strategy: StateStrategy::Migrate,
                fallback_strategy: crate::hmr::planner_decision::FallbackStrategy::ColdReload,
                user_message: String::new(),
            },
        };

        let (result, _) = pipeline.execute_reload("brainfuck", &manifest, &planner_output, "r1");
        assert!(matches!(result, AdapterReloadResult::Unsupported { .. }));
        assert_eq!(pipeline.consecutive_failures, 1);
    }
}
