// ============================================================
// AI REQUEST CONTRACT
// ============================================================
// Defines the canonical request/response contract between the
// deterministic planner (Loop A) and the AI backend (Loop B).
// The AI is only invoked when Loop A explicitly defers.
// ============================================================


use serde::{Deserialize, Serialize};

/// Why the planner is asking the AI for help.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiRequestReason {
    /// Planner cannot determine correct split boundaries.
    SplitUnknown,
    /// Healing rule not found for this error pattern.
    HealingNeeded,
    /// Adapter adaptation required for non-standard project.
    AdapterAdaptation,
    /// Complex migration path needs AI guidance.
    MigrationGuidance,
    /// Loop A exhausted retries, escalating.
    RetryExhausted,
}

/// Priority level for the AI request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AiPriority {
    /// Can wait, user not blocked.
    Low = 0,
    /// User is waiting, but has partial result.
    Medium = 1,
    /// User is blocked, needs immediate response.
    High = 2,
    /// System health at risk.
    Critical = 3,
}

/// The request sent from the planner to the AI backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRequest {
    /// Unique request ID.
    pub request_id: String,
    /// Why the AI is being called.
    pub reason: AiRequestReason,
    /// Priority (affects timeout and queue position).
    pub priority: AiPriority,
    /// The source code or context the AI needs.
    pub context: AiContext,
    /// Maximum time the planner will wait (millis).
    pub timeout_ms: u64,
    /// Whether the planner can proceed without AI response.
    pub fallback_available: bool,
    /// Attempt number (1-based).
    pub attempt: u32,
    /// Maximum attempts before giving up.
    pub max_attempts: u32,
}

/// Context payload for the AI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiContext {
    /// Module being processed.
    pub module_id: String,
    /// File paths involved.
    pub file_paths: Vec<String>,
    /// Relevant source snippets (truncated to budget).
    pub source_snippets: Vec<SourceSnippet>,
    /// Error messages (if healing request).
    pub errors: Vec<String>,
    /// Current adapter family.
    pub adapter_family: Option<String>,
    /// Build manifest summary (not full payload).
    pub build_summary: Option<String>,
}

/// A source code snippet with location info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSnippet {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub content: String,
}

/// The response from the AI backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    /// Matching request ID.
    pub request_id: String,
    /// Whether the AI successfully processed the request.
    pub success: bool,
    /// The AI's recommendation.
    pub recommendation: Option<AiRecommendation>,
    /// Error message if failed.
    pub error: Option<String>,
    /// Processing time on the AI side (millis).
    pub processing_ms: u64,
    /// Model used (for telemetry).
    pub model_id: Option<String>,
    /// Token usage (for cost tracking).
    pub tokens_used: Option<TokenUsage>,
}

/// Token usage for cost tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// The AI's recommended action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AiRecommendation {
    /// Suggested split boundaries.
    SplitSuggestion {
        core_files: Vec<String>,
        gui_files: Vec<String>,
        shared_files: Vec<String>,
    },
    /// Healing patch to apply.
    HealingPatch {
        patches: Vec<FilePatch>,
        confidence: f32,
    },
    /// Adapter configuration adjustment.
    AdapterConfig {
        adapter_family: String,
        config_overrides: serde_json::Value,
    },
    /// Migration guidance.
    MigrationGuide {
        steps: Vec<String>,
        estimated_risk: String,
    },
    /// AI could not help — fall back.
    NoRecommendation { reason: String },
}

/// A file-level patch from the AI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePatch {
    pub file_path: String,
    pub original: String,
    pub patched: String,
}

/// Validate an AI request before sending.
pub fn validate_request(req: &AiRequest) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();

    if req.request_id.is_empty() {
        errors.push("request_id is empty".into());
    }
    if req.timeout_ms == 0 {
        errors.push("timeout_ms must be > 0".into());
    }
    if req.context.module_id.is_empty() {
        errors.push("module_id is empty".into());
    }
    if req.attempt > req.max_attempts {
        errors.push("attempt exceeds max_attempts".into());
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_request() {
        let req = AiRequest {
            request_id: "req-001".into(),
            reason: AiRequestReason::SplitUnknown,
            priority: AiPriority::Medium,
            context: AiContext {
                module_id: "mod_a".into(),
                file_paths: vec!["src/main.rs".into()],
                source_snippets: vec![],
                errors: vec![],
                adapter_family: None,
                build_summary: None,
            },
            timeout_ms: 5000,
            fallback_available: true,
            attempt: 1,
            max_attempts: 3,
        };
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn invalid_empty_id() {
        let req = AiRequest {
            request_id: "".into(),
            reason: AiRequestReason::HealingNeeded,
            priority: AiPriority::High,
            context: AiContext {
                module_id: "mod_a".into(),
                file_paths: vec![],
                source_snippets: vec![],
                errors: vec![],
                adapter_family: None,
                build_summary: None,
            },
            timeout_ms: 5000,
            fallback_available: true,
            attempt: 1,
            max_attempts: 3,
        };
        assert!(validate_request(&req).is_err());
    }
}
