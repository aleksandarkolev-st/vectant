// ============================================================
// SPECULATIVE DIFF-PATCH EXECUTION
// ============================================================
//
// When the user pauses typing, fire `perform_ai_diff_patch`
// speculatively against the paused-at source. Cache the resulting
// edit list keyed by a hash of the new source. When the actual
// compile request arrives, check the cache: if the hash matches,
// skip the Tier 2 AI call entirely and apply the cached edits
// directly. Total Tier 2 time drops from ~2s (AI wait) to <10ms
// (local apply).
//
// ## How it's triggered
//
// `trigger_speculative(workspace_path, new_source_content)` is
// called by the file-sync data-channel handler in main.rs on every
// "write"/"edit_delta" message whose path does NOT match a split
// module (core.cpp / gui.cpp / shared.h). The frontend already
// debounces keystrokes at ~200ms, so the rate is modest.
//
// Each call spawns a tokio task that:
//   1. Records its `generation` at start (monotonic counter).
//   2. Waits 300ms (additional debounce on top of frontend debounce).
//   3. Re-checks its generation — if superseded by a newer trigger,
//      exits early. This keeps AI budget low during steady typing:
//      most tasks die during the debounce without ever reaching the
//      HTTP layer.
//   4. Reads the sidecar for `original_source` + `architecture`.
//   5. Reads the current split module contents from disk.
//   6. Computes a diff and calls `perform_ai_diff_patch`.
//   7. Checks its generation one last time before committing the
//      result. If superseded, the result is discarded.
//
// ## How it's consumed
//
// `take_matching(source_hash)` is called by handler.rs Tier 2
// immediately before calling `perform_ai_diff_patch`. It atomically
// checks the cache: if the cached result's source_hash matches AND
// the result is < 30s old, consume it (set `latest_result = None`)
// and return the edits. The caller applies them via
// `edit_applier::apply_edit` and skips the AI call.
//
// ## Tradeoffs
//
// - **Budget waste**: AI calls that race each other get their
//   results discarded via generation mismatch. The HTTP call still
//   runs to completion because tokio::Notify-based cancellation is
//   unreliable for this pattern (waiters register on poll, not on
//   creation). Acceptable: the vast majority of tasks die during
//   debounce without reaching the HTTP layer.
// - **Stale cache**: 30s expiry prevents extremely stale results
//   (e.g., user paused, AI took 8s, user pause another 25s → by
//   now the split might have been re-run by another compile).
// - **Non-split-file writes only**: the trigger skips split-file
//   writes because those bypass Tier 2 entirely (handler.rs
//   FallbackDeterministic "is_editing_split_file" branch).

use crate::hmr::edit_applier::Edit;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// A cached speculative diff_patch result.
#[derive(Debug, Clone)]
pub struct SpeculativeResult {
    pub source_hash: u64,
    pub edits: Vec<Edit>,
    pub created_at: Instant,
}

/// Shared state for the speculative executor.
struct SpeculativeState {
    /// Monotonic counter incremented on every trigger. Spawned tasks
    /// record their generation at start and compare before committing
    /// to detect supersession.
    generation: u64,
    /// The most recent completed speculation result (if any). Consumed
    /// by `take_matching` on compile.
    latest_result: Option<SpeculativeResult>,
}

static STATE: OnceLock<Mutex<SpeculativeState>> = OnceLock::new();

fn get_state() -> &'static Mutex<SpeculativeState> {
    STATE.get_or_init(|| {
        Mutex::new(SpeculativeState {
            generation: 0,
            latest_result: None,
        })
    })
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Debounce window before firing the speculative AI call.
/// The frontend already debounces ~200ms; adding 300ms here means
/// tasks from fast typing cancel via generation check before ever
/// hitting the HTTP layer.
const DEBOUNCE_MS: u64 = 300;

/// How long a cached result is considered fresh. After this, compile
/// ignores it and does a regular Tier 2 AI call.
const CACHE_MAX_AGE: Duration = Duration::from_secs(30);

/// Called from main.rs file-sync handler on every non-split-file write.
/// Returns immediately — the actual work happens in a spawned task.
///
/// `workspace_path` is the worker tempdir (where `.synthi_split_meta.json`
/// and the split files live). `new_source` is the full content that was
/// just written by the file-sync message.
pub fn trigger_speculative(workspace_path: PathBuf, new_source: String) {
    tokio::spawn(async move {
        // Take a generation ticket.
        let my_gen = {
            let mut s = get_state().lock().await;
            s.generation += 1;
            s.generation
        };

        let source_hash = hash_str(&new_source);

        // Early exit: we already have a fresh result for this exact source.
        {
            let s = get_state().lock().await;
            if let Some(r) = &s.latest_result {
                if r.source_hash == source_hash && r.created_at.elapsed() < CACHE_MAX_AGE {
                    return;
                }
            }
        }

        // Debounce window.
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;

        // Check for supersession.
        {
            let s = get_state().lock().await;
            if s.generation != my_gen {
                // Newer trigger is already in flight. Drop this one
                // without hitting the HTTP layer.
                return;
            }
        }

        // Read sidecar for baseline + architecture.
        let sidecar_path = workspace_path.join(".synthi_split_meta.json");
        let (old_source, arch_md) = match tokio::fs::read_to_string(&sidecar_path).await {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(meta) => {
                    let old = meta
                        .get("original_source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arch = meta
                        .get("architecture")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    (old, arch)
                }
                Err(e) => {
                    eprintln!("[Spec] sidecar parse failed: {}", e);
                    return;
                }
            },
            Err(_) => {
                // No sidecar yet — first compile of the session hasn't run.
                // Nothing to speculate against.
                return;
            }
        };

        if old_source.is_empty() {
            return;
        }
        if old_source == new_source {
            // No actual change, nothing to speculate.
            return;
        }

        // Read current split module contents from disk.
        let core_content = tokio::fs::read_to_string(workspace_path.join("core.cpp"))
            .await
            .unwrap_or_default();
        let gui_content = tokio::fs::read_to_string(workspace_path.join("gui.cpp"))
            .await
            .unwrap_or_default();
        let shared_content = tokio::fs::read_to_string(workspace_path.join("shared.h"))
            .await
            .unwrap_or_default();
        if core_content.is_empty() && gui_content.is_empty() && shared_content.is_empty() {
            // No split files yet — first compile hasn't produced them.
            return;
        }

        // Compute a simple diff between baseline and new source.
        let diff = crate::compiler::handler::build_simple_diff(&old_source, &new_source);
        if diff.is_empty() {
            return;
        }

        eprintln!(
            "[Spec] triggered: source_hash={}, diff={} bytes, arch={} chars (gen={})",
            source_hash,
            diff.len(),
            arch_md.len(),
            my_gen
        );

        // Run perform_ai_diff_patch with the arch hint.
        let arch_hint: Option<&str> = if arch_md.is_empty() {
            None
        } else {
            Some(arch_md.as_str())
        };
        let start = Instant::now();
        let ai_result = crate::compiler::stages::ai_utils::perform_ai_diff_patch(
            &diff,
            &core_content,
            &gui_content,
            &shared_content,
            arch_hint,
        )
        .await;

        match ai_result {
            Ok(edits) => {
                let elapsed = start.elapsed();
                let num_edits = edits.len();
                let mut s = get_state().lock().await;
                if s.generation != my_gen {
                    // Superseded while waiting for AI. Discard result.
                    eprintln!(
                        "[Spec] superseded during AI call, discarding {} edit(s) (gen={}, current={}, took {:?})",
                        num_edits, my_gen, s.generation, elapsed
                    );
                    return;
                }
                eprintln!(
                    "[Spec] READY source_hash={} {} edit(s) cached in {:?}",
                    source_hash, num_edits, elapsed
                );
                s.latest_result = Some(SpeculativeResult {
                    source_hash,
                    edits,
                    created_at: Instant::now(),
                });
            }
            Err(e) => {
                eprintln!(
                    "[Spec] AI diff_patch failed (gen={}): {}",
                    my_gen, e
                );
            }
        }
    });
}

/// Called from handler.rs Tier 2. Atomically checks if the cache has
/// a fresh result for the given source hash. If yes, consumes it and
/// returns the edits; otherwise returns None.
///
/// Consuming (setting latest_result = None) prevents a stale cache
/// entry from being used a second time if the user compiles the same
/// source twice — the second compile should hit the full Tier 2 AI
/// path so its result is based on fresh split module contents.
pub async fn take_matching(source_hash: u64) -> Option<Vec<Edit>> {
    let mut s = get_state().lock().await;
    if let Some(r) = &s.latest_result {
        if r.source_hash == source_hash && r.created_at.elapsed() < CACHE_MAX_AGE {
            let edits = r.edits.clone();
            let num_edits = edits.len();
            let age = r.created_at.elapsed();
            s.latest_result = None;
            eprintln!(
                "[Spec] HIT source_hash={} {} edit(s) (age={:?}) — skipping Tier 2 AI call",
                source_hash, num_edits, age
            );
            return Some(edits);
        }
    }
    None
}

/// Compute the source hash used as the cache key. Must match what
/// the file-sync handler and the compile handler both derive from
/// the same source string for the cache lookup to work.
pub fn hash_source(s: &str) -> u64 {
    hash_str(s)
}
