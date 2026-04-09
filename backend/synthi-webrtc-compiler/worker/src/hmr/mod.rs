pub mod abi_detect;
pub mod adapted_project;
pub mod adapter_matrix;
pub mod adapter_trait;
pub mod ai_bypass;
pub mod ai_cache;
pub mod ai_circuit_breaker;
pub mod ai_cost_tracker;
pub mod ai_fallback_chain;
#[cfg(test)]
pub mod ai_extraction_tests;
pub mod ai_gate;
pub mod ai_request_contract;
pub mod ai_response_validator;
pub mod ai_timeout_guardian;
pub mod binary_state;
pub mod build_manifest;
pub mod cache_writer;
pub mod candidate;
pub mod candidate_bridge;
pub mod candidate_history;
pub mod candidate_notification;
pub mod candidate_queue;
pub mod candidate_supersession;
pub mod candidate_watchdog;
pub mod changed_files;
pub mod compile_enrichment;
pub mod dependency_graph;
pub mod deterministic_compile;
pub mod diagnostics;
pub mod dirty_classifier;
pub mod dynlib_adapter;
pub mod dynlib_build_hooks;
pub mod dynlib_reload;
pub mod dynlib_swap;
pub mod fast_refresh;
pub mod health_check;
pub mod hmr_eligibility;
pub mod hot_swap_coordinator;
pub mod incremental_cache;
pub mod lifecycle_machine;
pub mod loop_b_triggers;
pub mod loop_classifier;
pub mod managed_runtime_adapter;
pub mod orchestrator;
pub mod planner;
pub mod planner_decision;
pub mod planner_glue;
#[cfg(test)]
pub mod planner_integration_tests;
pub mod preview_lifecycle;
pub mod promotion_policy;
pub mod rebuild_scope;
pub mod reload_manager;
pub mod reload_protocol;
pub mod rollback_notification;
pub mod rollout_flags;
pub mod scope_planner_bridge;
pub mod shared_header_detect;
pub mod slot_manager;
pub mod state_checkpoint;
pub mod state_diff;
pub mod state_manager;
pub mod state_migration;
pub mod state_restore_orchestrator;
pub mod state_restore_validator;
pub mod state_serializer;
pub mod state_size_limiter;
pub mod state_snapshot;
pub mod state_type_id;
pub mod swap_rollback;
pub mod symbol_validation;
pub mod telemetry;

#[cfg(test)]
pub mod wave05_integration_tests;

#[cfg(test)]
pub mod wave06_integration_tests;

#[cfg(test)]
pub mod wave07_integration_tests;

#[cfg(test)]
pub mod wave08_integration_tests;

#[cfg(test)]
pub mod wave09_integration_tests;
