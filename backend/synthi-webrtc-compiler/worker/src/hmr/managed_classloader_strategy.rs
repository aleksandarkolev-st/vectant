// ============================================================
// MANAGED CLASSLOADER STRATEGY
// ============================================================
// JVM-specific reload strategies: JVMTI-based hot-swap of
// individual classes vs classloader-restart for structural
// changes.  Decides which approach based on the change set.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Kind of JVM class change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClassChangeKind {
    /// Method body change only (hotswap-safe).
    BodyOnly,
    /// Added or removed field (structural).
    FieldChange,
    /// Changed method signature (structural).
    SignatureChange,
    /// Added or removed class.
    ClassAddedOrRemoved,
    /// Changed inheritance.
    InheritanceChange,
    /// Unknown / cannot determine.
    Unknown,
}

impl ClassChangeKind {
    /// Whether this change can be applied via JVMTI hotswap.
    pub fn is_hotswap_safe(&self) -> bool {
        matches!(self, ClassChangeKind::BodyOnly)
    }
}

/// Description of a single class change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassChange {
    pub class_name: String,
    pub kind: ClassChangeKind,
}

/// Chosen reload strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JvmReloadStrategy {
    /// JVMTI RedefineClasses — fastest, no state loss.
    HotSwap,
    /// Throw away classloader, create new one, reload all classes.
    ClassLoaderRestart,
    /// Full JVM restart (last resort).
    FullRestart,
}

/// Thresholds for strategy selection.
#[derive(Debug, Clone)]
pub struct JvmStrategyConfig {
    /// Max classes for hotswap before escalating.
    pub hotswap_class_limit: usize,
    /// Allow hotswap only for body-only changes.
    pub strict_hotswap: bool,
}

impl Default for JvmStrategyConfig {
    fn default() -> Self {
        Self {
            hotswap_class_limit: 50,
            strict_hotswap: true,
        }
    }
}

/// Decision result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyDecision {
    pub strategy: JvmReloadStrategy,
    pub reason: String,
    pub classes_affected: usize,
}

/// Decide which JVM reload strategy to use for a set of changes.
pub fn decide_jvm_strategy(
    changes: &[ClassChange],
    config: &JvmStrategyConfig,
) -> StrategyDecision {
    if changes.is_empty() {
        return StrategyDecision {
            strategy: JvmReloadStrategy::HotSwap,
            reason: "no changes".into(),
            classes_affected: 0,
        };
    }

    let all_body_only = changes.iter().all(|c| c.kind.is_hotswap_safe());

    if config.strict_hotswap && !all_body_only {
        // Structural changes — need classloader restart.
        let has_inheritance = changes
            .iter()
            .any(|c| c.kind == ClassChangeKind::InheritanceChange);

        if has_inheritance {
            return StrategyDecision {
                strategy: JvmReloadStrategy::FullRestart,
                reason: "inheritance changes require full restart".into(),
                classes_affected: changes.len(),
            };
        }

        return StrategyDecision {
            strategy: JvmReloadStrategy::ClassLoaderRestart,
            reason: "structural changes require classloader restart".into(),
            classes_affected: changes.len(),
        };
    }

    if changes.len() > config.hotswap_class_limit {
        return StrategyDecision {
            strategy: JvmReloadStrategy::ClassLoaderRestart,
            reason: format!(
                "{} classes exceed hotswap limit of {}",
                changes.len(),
                config.hotswap_class_limit
            ),
            classes_affected: changes.len(),
        };
    }

    StrategyDecision {
        strategy: JvmReloadStrategy::HotSwap,
        reason: format!("{} body-only changes", changes.len()),
        classes_affected: changes.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_change(name: &str) -> ClassChange {
        ClassChange {
            class_name: name.into(),
            kind: ClassChangeKind::BodyOnly,
        }
    }

    #[test]
    fn small_body_only_is_hotswap() {
        let changes = vec![body_change("com.example.Foo")];
        let d = decide_jvm_strategy(&changes, &JvmStrategyConfig::default());
        assert_eq!(d.strategy, JvmReloadStrategy::HotSwap);
    }

    #[test]
    fn structural_change_requires_classloader() {
        let changes = vec![ClassChange {
            class_name: "com.example.Foo".into(),
            kind: ClassChangeKind::FieldChange,
        }];
        let d = decide_jvm_strategy(&changes, &JvmStrategyConfig::default());
        assert_eq!(d.strategy, JvmReloadStrategy::ClassLoaderRestart);
    }

    #[test]
    fn inheritance_requires_full_restart() {
        let changes = vec![ClassChange {
            class_name: "com.example.Base".into(),
            kind: ClassChangeKind::InheritanceChange,
        }];
        let d = decide_jvm_strategy(&changes, &JvmStrategyConfig::default());
        assert_eq!(d.strategy, JvmReloadStrategy::FullRestart);
    }

    #[test]
    fn over_limit_escalates() {
        let changes: Vec<_> = (0..60).map(|i| body_change(&format!("Class{}", i))).collect();
        let d = decide_jvm_strategy(&changes, &JvmStrategyConfig::default());
        assert_eq!(d.strategy, JvmReloadStrategy::ClassLoaderRestart);
    }
}
