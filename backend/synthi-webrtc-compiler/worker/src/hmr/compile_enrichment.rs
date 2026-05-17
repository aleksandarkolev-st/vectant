// ============================================================
// COMPILE REQUEST ENRICHMENT
// ============================================================
// Enriches a compile request with loop classification and
// adapted-project metadata before it enters the compile pipeline.
// This is the glue between the loop classifier and the existing
// handler.rs dispatch.
// ============================================================

use serde::{Deserialize, Serialize};

use crate::hmr::adapted_project::AdaptedProjectStatus;
use crate::hmr::loop_classifier::{CompileLoop, LoopClassification};

/// Enriched compile metadata attached to a compile request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileEnrichment {
    /// Which loop was selected.
    pub classification: LoopClassification,

    /// Adapted project status.
    pub adapted_status: AdaptedProjectStatus,

    /// Whether AI split should be called (derived from loop type).
    pub use_ai_split: bool,

    /// Whether the compile should use incremental cache.
    pub use_incremental_cache: bool,

    /// Source hash for staleness tracking.
    pub source_hash: Option<String>,
}

impl CompileEnrichment {
    /// Create enrichment from classification and adapted status.
    pub fn from_classification(
        classification: LoopClassification,
        adapted_status: AdaptedProjectStatus,
        source_hash: Option<String>,
    ) -> Self {
        let use_ai_split = classification.loop_type == CompileLoop::LoopB;
        let use_incremental_cache = classification.loop_type == CompileLoop::LoopA;

        Self {
            classification,
            adapted_status,
            use_ai_split,
            use_incremental_cache,
            source_hash,
        }
    }

    /// Whether this compile is on the deterministic path.
    pub fn is_deterministic(&self) -> bool {
        self.classification.loop_type == CompileLoop::LoopA
    }

    /// Whether this compile uses AI assistance.
    pub fn is_ai_assisted(&self) -> bool {
        self.classification.loop_type == CompileLoop::LoopB
    }
}

/// Summary of enrichment for telemetry/logging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentSummary {
    pub loop_type: CompileLoop,
    pub reason: String,
    pub is_adapted: bool,
    pub use_ai_split: bool,
    pub use_incremental_cache: bool,
}

impl From<&CompileEnrichment> for EnrichmentSummary {
    fn from(e: &CompileEnrichment) -> Self {
        Self {
            loop_type: e.classification.loop_type,
            reason: format!("{:?}", e.classification.reason),
            is_adapted: e.adapted_status.is_adapted,
            use_ai_split: e.use_ai_split,
            use_incremental_cache: e.use_incremental_cache,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::loop_classifier::{LoopClassification, LoopReason};
    use std::path::PathBuf;

    #[test]
    fn loop_a_sets_deterministic_flags() {
        let classification = LoopClassification {
            loop_type: CompileLoop::LoopA,
            reason: LoopReason::AdaptedProjectFresh,
        };
        let status = AdaptedProjectStatus::adapted(
            PathBuf::from("core.cpp"),
            PathBuf::from("gui.cpp"),
            None,
        );
        let enrichment =
            CompileEnrichment::from_classification(classification, status, Some("h1".into()));

        assert!(enrichment.is_deterministic());
        assert!(!enrichment.use_ai_split);
        assert!(enrichment.use_incremental_cache);
    }

    #[test]
    fn loop_b_sets_ai_flags() {
        let classification = LoopClassification {
            loop_type: CompileLoop::LoopB,
            reason: LoopReason::NotAdapted,
        };
        let status = AdaptedProjectStatus::not_adapted("test");
        let enrichment = CompileEnrichment::from_classification(classification, status, None);

        assert!(enrichment.is_ai_assisted());
        assert!(enrichment.use_ai_split);
        assert!(!enrichment.use_incremental_cache);
    }
}
