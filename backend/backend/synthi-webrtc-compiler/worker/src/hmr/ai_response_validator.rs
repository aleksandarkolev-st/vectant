// ============================================================
// AI RESPONSE VALIDATOR
// ============================================================
// Validates AI responses before the planner acts on them.
// Prevents malformed, oversized, or suspicious AI output from
// corrupting the deterministic pipeline.
// ============================================================


use crate::hmr::ai_request_contract::{AiRecommendation, AiResponse, FilePatch};

/// Validation verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseVerdict {
    /// Response is valid, safe to act on.
    Valid,
    /// Response has warnings but is usable.
    ValidWithWarnings(Vec<String>),
    /// Response is invalid, must be rejected.
    Invalid(Vec<String>),
}

/// Validation configuration.
#[derive(Debug, Clone)]
pub struct ResponseValidatorConfig {
    /// Maximum total response payload size (bytes).
    pub max_response_bytes: usize,
    /// Maximum number of file patches.
    pub max_patches: usize,
    /// Maximum size of a single patch (bytes).
    pub max_patch_bytes: usize,
    /// Minimum confidence for healing patches.
    pub min_confidence: f32,
    /// Maximum tokens before cost warning.
    pub token_warning_threshold: u32,
}

impl Default for ResponseValidatorConfig {
    fn default() -> Self {
        Self {
            max_response_bytes: 2 * 1024 * 1024, // 2 MB
            max_patches: 50,
            max_patch_bytes: 256 * 1024, // 256 KB per patch
            min_confidence: 0.5,
            token_warning_threshold: 8000,
        }
    }
}

/// Validate an AI response.
pub fn validate_response(
    response: &AiResponse,
    config: &ResponseValidatorConfig,
) -> ResponseVerdict {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // Basic structure
    if response.request_id.is_empty() {
        errors.push("response missing request_id".into());
    }

    // Check error case
    if !response.success {
        if response.error.is_none() {
            warnings.push("failed response has no error message".into());
        }
        // Failed responses are valid (just unsuccessful)
        if errors.is_empty() {
            return if warnings.is_empty() {
                ResponseVerdict::Valid
            } else {
                ResponseVerdict::ValidWithWarnings(warnings)
            };
        }
    }

    // Token usage warnings
    if let Some(ref usage) = response.tokens_used {
        if usage.total_tokens > config.token_warning_threshold {
            warnings.push(format!(
                "high token usage: {} tokens",
                usage.total_tokens
            ));
        }
    }

    // Validate recommendation content
    if let Some(ref rec) = response.recommendation {
        match rec {
            AiRecommendation::HealingPatch { patches, confidence } => {
                if *confidence < config.min_confidence {
                    errors.push(format!(
                        "confidence {} below minimum {}",
                        confidence, config.min_confidence
                    ));
                }
                if patches.len() > config.max_patches {
                    errors.push(format!(
                        "{} patches exceeds limit {}",
                        patches.len(),
                        config.max_patches
                    ));
                }
                for patch in patches {
                    if let Err(e) = validate_patch(patch, config) {
                        errors.push(e);
                    }
                }
            }

            AiRecommendation::SplitSuggestion {
                core_files,
                gui_files,
                shared_files,
            } => {
                if core_files.is_empty() && gui_files.is_empty() {
                    errors.push("split suggestion has no core or gui files".into());
                }
                // Check for path traversal
                for path in core_files.iter().chain(gui_files.iter()).chain(shared_files.iter()) {
                    if path.contains("..") {
                        errors.push(format!("path traversal in split suggestion: {}", path));
                    }
                }
            }

            AiRecommendation::AdapterConfig { adapter_family, .. } => {
                if adapter_family.is_empty() {
                    errors.push("adapter config has empty adapter_family".into());
                }
            }

            AiRecommendation::MigrationGuide { steps, .. } => {
                if steps.is_empty() {
                    warnings.push("migration guide has no steps".into());
                }
            }

            AiRecommendation::NoRecommendation { .. } => {
                // Always valid
            }
        }
    }

    if !errors.is_empty() {
        ResponseVerdict::Invalid(errors)
    } else if !warnings.is_empty() {
        ResponseVerdict::ValidWithWarnings(warnings)
    } else {
        ResponseVerdict::Valid
    }
}

/// Validate a single file patch.
fn validate_patch(patch: &FilePatch, config: &ResponseValidatorConfig) -> Result<(), String> {
    if patch.file_path.is_empty() {
        return Err("patch has empty file_path".into());
    }
    if patch.file_path.contains("..") {
        return Err(format!("path traversal in patch: {}", patch.file_path));
    }
    if patch.patched.len() > config.max_patch_bytes {
        return Err(format!(
            "patch for {} is {} bytes, exceeds {} limit",
            patch.file_path,
            patch.patched.len(),
            config.max_patch_bytes
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::ai_request_contract::TokenUsage;

    #[test]
    fn valid_success() {
        let resp = AiResponse {
            request_id: "req-001".into(),
            success: true,
            recommendation: Some(AiRecommendation::NoRecommendation {
                reason: "test".into(),
            }),
            error: None,
            processing_ms: 100,
            model_id: None,
            tokens_used: None,
        };
        let config = ResponseValidatorConfig::default();
        assert_eq!(validate_response(&resp, &config), ResponseVerdict::Valid);
    }

    #[test]
    fn low_confidence_rejected() {
        let resp = AiResponse {
            request_id: "req-002".into(),
            success: true,
            recommendation: Some(AiRecommendation::HealingPatch {
                patches: vec![FilePatch {
                    file_path: "src/main.rs".into(),
                    original: "old".into(),
                    patched: "new".into(),
                }],
                confidence: 0.2,
            }),
            error: None,
            processing_ms: 100,
            model_id: None,
            tokens_used: None,
        };
        let config = ResponseValidatorConfig::default();
        assert!(matches!(
            validate_response(&resp, &config),
            ResponseVerdict::Invalid(_)
        ));
    }

    #[test]
    fn path_traversal_blocked() {
        let resp = AiResponse {
            request_id: "req-003".into(),
            success: true,
            recommendation: Some(AiRecommendation::SplitSuggestion {
                core_files: vec!["../../etc/passwd".into()],
                gui_files: vec![],
                shared_files: vec![],
            }),
            error: None,
            processing_ms: 100,
            model_id: None,
            tokens_used: None,
        };
        let config = ResponseValidatorConfig::default();
        assert!(matches!(
            validate_response(&resp, &config),
            ResponseVerdict::Invalid(_)
        ));
    }
}
