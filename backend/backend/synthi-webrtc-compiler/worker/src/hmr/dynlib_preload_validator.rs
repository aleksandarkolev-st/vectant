// ============================================================
// DYNLIB PRELOAD VALIDATOR
// ============================================================
// Validates a shared library before it is loaded into the
// running process.  Catches problems early (size, format, ABI)
// to avoid crashes during hot swap.
// ============================================================


use serde::{Deserialize, Serialize};

use crate::hmr::dynlib_abi_contract::AbiHeader;

/// Preload validation configuration.
#[derive(Debug, Clone)]
pub struct PreloadConfig {
    /// Maximum file size (bytes).
    pub max_file_size: u64,
    /// Expected ABI version for compatibility check.
    pub expected_abi: AbiHeader,
    /// Minimum number of exported symbols to accept.
    pub min_exports: usize,
    /// Whether to check file extension.
    pub check_extension: bool,
}

impl Default for PreloadConfig {
    fn default() -> Self {
        Self {
            max_file_size: 512 * 1024 * 1024, // 512 MB
            expected_abi: AbiHeader::CURRENT,
            min_exports: 5, // at least the 5 required symbols
            check_extension: true,
        }
    }
}

/// A preload issue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloadIssue {
    pub severity: IssueSeverity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IssueSeverity {
    Error,
    Warning,
    Info,
}

/// Result of preload validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloadResult {
    pub valid: bool,
    pub issues: Vec<PreloadIssue>,
}

impl PreloadResult {
    pub fn ok() -> Self {
        Self {
            valid: true,
            issues: vec![],
        }
    }

    pub fn has_errors(&self) -> bool {
        self.issues.iter().any(|i| i.severity == IssueSeverity::Error)
    }
}

/// Validate a library file before loading.
pub fn validate_preload(
    path: &str,
    file_size: u64,
    exported_symbols: &[String],
    reported_abi: Option<&AbiHeader>,
    config: &PreloadConfig,
) -> PreloadResult {
    let mut issues = Vec::new();

    // Check path is non-empty
    if path.is_empty() {
        issues.push(PreloadIssue {
            severity: IssueSeverity::Error,
            code: "EMPTY_PATH".into(),
            message: "artifact path is empty".into(),
        });
        return PreloadResult {
            valid: false,
            issues,
        };
    }

    // Check extension
    if config.check_extension {
        let valid_exts = [".so", ".dylib", ".dll"];
        if !valid_exts.iter().any(|ext| path.ends_with(ext)) {
            issues.push(PreloadIssue {
                severity: IssueSeverity::Error,
                code: "BAD_EXTENSION".into(),
                message: format!("'{}' is not a valid shared library extension", path),
            });
        }
    }

    // Check file size
    if file_size > config.max_file_size {
        issues.push(PreloadIssue {
            severity: IssueSeverity::Error,
            code: "TOO_LARGE".into(),
            message: format!(
                "file size {} exceeds limit {}",
                file_size, config.max_file_size
            ),
        });
    } else if file_size == 0 {
        issues.push(PreloadIssue {
            severity: IssueSeverity::Warning,
            code: "ZERO_SIZE".into(),
            message: "file size is 0; may be a build error".into(),
        });
    }

    // Check minimum exports
    if exported_symbols.len() < config.min_exports {
        issues.push(PreloadIssue {
            severity: IssueSeverity::Error,
            code: "TOO_FEW_EXPORTS".into(),
            message: format!(
                "only {} exports; need at least {}",
                exported_symbols.len(),
                config.min_exports
            ),
        });
    }

    // Check ABI compatibility
    if let Some(abi) = reported_abi {
        if !abi.is_compatible_with(&config.expected_abi) {
            issues.push(PreloadIssue {
                severity: IssueSeverity::Error,
                code: "ABI_INCOMPATIBLE".into(),
                message: format!(
                    "ABI {} not compatible with expected {}",
                    abi, config.expected_abi
                ),
            });
        }
    } else {
        issues.push(PreloadIssue {
            severity: IssueSeverity::Warning,
            code: "NO_ABI_VERSION".into(),
            message: "library does not report ABI version".into(),
        });
    }

    let valid = !issues.iter().any(|i| i.severity == IssueSeverity::Error);
    PreloadResult { valid, issues }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_required() -> Vec<String> {
        vec![
            "hmr_get_abi_version".into(),
            "hmr_init".into(),
            "hmr_shutdown".into(),
            "hmr_on_update".into(),
            "hmr_on_render".into(),
        ]
    }

    #[test]
    fn valid_library() {
        let result = validate_preload(
            "libmod.so",
            1024,
            &all_required(),
            Some(&AbiHeader::CURRENT),
            &PreloadConfig::default(),
        );
        assert!(result.valid);
    }

    #[test]
    fn rejects_oversized() {
        let result = validate_preload(
            "libmod.so",
            1024 * 1024 * 1024, // 1 GB
            &all_required(),
            Some(&AbiHeader::CURRENT),
            &PreloadConfig::default(),
        );
        assert!(!result.valid);
        assert!(result.issues.iter().any(|i| i.code == "TOO_LARGE"));
    }

    #[test]
    fn rejects_wrong_abi() {
        let bad_abi = AbiHeader { major: 2, minor: 0, patch: 0 };
        let result = validate_preload(
            "libmod.so",
            1024,
            &all_required(),
            Some(&bad_abi),
            &PreloadConfig::default(),
        );
        assert!(!result.valid);
        assert!(result.issues.iter().any(|i| i.code == "ABI_INCOMPATIBLE"));
    }

    #[test]
    fn warns_on_missing_abi() {
        let result = validate_preload(
            "libmod.so",
            1024,
            &all_required(),
            None,
            &PreloadConfig::default(),
        );
        assert!(result.valid); // warning only
        assert!(result.issues.iter().any(|i| i.code == "NO_ABI_VERSION"));
    }
}
