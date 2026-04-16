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
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

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
    /// The source hash currently being speculated on. Set by a spawned
    /// task as soon as it passes the generation check (AFTER the
    /// debounce), cleared when the task completes or errors. This is
    /// how `take_matching_or_wait` knows whether to wait for an
    /// in-flight speculation vs fall through to a live AI call.
    in_flight_hash: Option<u64>,
    /// Woken (via `notify_one`) whenever an in-flight speculation
    /// completes — whether it stored a result, errored, or was
    /// superseded. Handlers waiting on speculation for their source
    /// hash block on this notification.
    completion: Arc<Notify>,
    /// Woken (via `notify_waiters`) by `trigger_speculative` on EVERY
    /// new invocation, so any in-flight spec task can abort its
    /// HTTP call early via `tokio::select!`. Prior to this, old tasks
    /// kept their HTTP calls running to completion and only discarded
    /// the result after it came back — wasting Gemini tokens + seconds
    /// of latency for every save in a typing burst.
    cancel_notify: Arc<Notify>,
}

static STATE: OnceLock<Mutex<SpeculativeState>> = OnceLock::new();

fn get_state() -> &'static Mutex<SpeculativeState> {
    STATE.get_or_init(|| {
        Mutex::new(SpeculativeState {
            generation: 0,
            latest_result: None,
            in_flight_hash: None,
            completion: Arc::new(Notify::new()),
            cancel_notify: Arc::new(Notify::new()),
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
        // Take a generation ticket AND wake any in-flight tasks'
        // cancellation notified-futures so their `tokio::select!`
        // drops the HTTP call mid-request. Previously old tasks
        // ran their HTTP to completion and then discarded the
        // result — wasting Gemini tokens + seconds of latency
        // for every save in a typing burst (see gen=10/12/15/18
        // cascade in the live-test log from 2026-04-16).
        let my_gen = {
            let mut s = get_state().lock().await;
            s.generation += 1;
            // Fire cancel_notify FIRST, then swap in a fresh
            // Notify for our own task to race against. Any task
            // currently awaiting `.notified()` on the old arc
            // wakes immediately and aborts. Tasks that haven't
            // yet entered their select! will grab the new one.
            s.cancel_notify.notify_waiters();
            s.cancel_notify = Arc::new(Notify::new());
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

        // Mark in-flight so `take_matching_or_wait` knows a speculation
        // for this hash is imminent and can block on it instead of
        // running a duplicate live AI call from the compile handler.
        {
            let mut s = get_state().lock().await;
            s.in_flight_hash = Some(source_hash);
        }

        // Run the speculation body. Any early-return sets `stored`
        // to false and falls through to the cleanup at the end of
        // the task, which clears `in_flight_hash` and wakes any
        // waiter blocked in `take_matching_or_wait`. Using explicit
        // end-of-task cleanup (instead of a Drop guard) avoids
        // the runtime/panic pitfalls of spawning from Drop.
        let mut _stored = false;

        'speculation: {
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
                        break 'speculation;
                    }
                },
                Err(_) => {
                    // No sidecar yet — first compile of the session
                    // hasn't run. Nothing to speculate against.
                    break 'speculation;
                }
            };

            if old_source.is_empty() {
                break 'speculation;
            }
            if old_source == new_source {
                // No actual change, nothing to speculate.
                break 'speculation;
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
            // ULTRAPLAN Phase 5: read host_runner.cpp as the 4th edit
            // target. Empty string is the legacy 3-file project sentinel —
            // perform_ai_diff_patch / Python prompt builder skip the
            // host_runner section in that case.
            let host_runner_content =
                tokio::fs::read_to_string(workspace_path.join("host_runner.cpp"))
                    .await
                    .unwrap_or_default();
            if core_content.is_empty() && gui_content.is_empty() && shared_content.is_empty() {
                // No split files yet — first compile hasn't produced them.
                break 'speculation;
            }

            // Compute a simple diff between baseline and new source.
            let diff = crate::compiler::handler::build_simple_diff(&old_source, &new_source);
            if diff.is_empty() {
                break 'speculation;
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

            // Race the AI call against the cancellation notify.
            // Clone the Arc, create a Notified future, and eagerly
            // register via `enable()` so a `notify_waiters()` that
            // fires between the lock release and the `select!` poll
            // is not lost. Without `enable()`, there was a narrow
            // race where a newer trigger could fire `notify_waiters()`
            // after clone but before the first `select!` poll —
            // dropping the notification and letting the HTTP call
            // run to completion (wasting Gemini tokens).
            let cancel_notify_arc = {
                let s = get_state().lock().await;
                s.cancel_notify.clone()
            };
            let cancel_notified = cancel_notify_arc.notified();
            tokio::pin!(cancel_notified);
            cancel_notified.as_mut().enable();

            let start = Instant::now();
            let ai_result = tokio::select! {
                biased;
                // `biased` gives cancel priority if both arms
                // complete in the same poll — ensures a late-
                // firing cancel still wins over a just-completed
                // HTTP result.
                _ = &mut cancel_notified => {
                    eprintln!(
                        "[Spec] cancelled mid-HTTP for gen={} after {:?} \
                         (newer trigger fired — dropping in-flight AI call \
                         without waiting for response)",
                        my_gen, start.elapsed()
                    );
                    break 'speculation;
                }
                r = crate::compiler::stages::ai_utils::perform_ai_diff_patch(
                    &diff,
                    &core_content,
                    &gui_content,
                    &shared_content,
                    &host_runner_content,
                    arch_hint,
                ) => r,
            };

            match ai_result {
                Ok(edits) => {
                    let elapsed = start.elapsed();
                    let num_edits = edits.len();
                    let mut s = get_state().lock().await;
                    if s.generation != my_gen {
                        // Superseded AFTER the HTTP call returned
                        // but BEFORE we took the lock. Rare — the
                        // select! cancel arm normally catches this
                        // first. Discard the result for correctness.
                        eprintln!(
                            "[Spec] superseded during AI call, discarding {} edit(s) (gen={}, current={}, took {:?})",
                            num_edits, my_gen, s.generation, elapsed
                        );
                        break 'speculation;
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
                    _stored = true;
                }
                Err(e) => {
                    eprintln!("[Spec] AI diff_patch failed (gen={}): {}", my_gen, e);
                }
            }
        } // end 'speculation

        // Cleanup: always runs after the speculation block exits,
        // regardless of whether we stored a result, errored, or took
        // an early break. Clears `in_flight_hash` (if it's still our
        // hash — i.e. we weren't already superseded) and wakes any
        // compile handler blocked in `take_matching_or_wait`.
        {
            let mut s = get_state().lock().await;
            if s.in_flight_hash == Some(source_hash) {
                s.in_flight_hash = None;
            }
            s.completion.notify_one();
        }
    });
}

/// Fast-path cache lookup used by `take_matching_or_wait` and
/// any caller that wants to peek without blocking. Consumes the
/// entry if it matches so the next caller sees a miss.
async fn try_take_matching(source_hash: u64) -> Option<Vec<Edit>> {
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

/// Called from handler.rs Tier 2. Atomically checks if the cache has
/// a fresh result for the given source hash OR if a speculation for
/// the same hash is currently in flight. If in-flight, waits up to
/// `timeout` for it to complete, then re-checks the cache. Returns
/// the edits on success, None on miss/timeout — the caller falls
/// through to the live AI call.
///
/// This exists to solve the Ctrl+S race: the frontend sends a
/// file-sync write and a compile request back-to-back on save, so
/// the speculative task is still in its 300ms debounce when the
/// compile handler arrives. Without waiting, the handler would fire
/// its own duplicate live AI call. Waiting de-dups to a single AI
/// call per save.
pub async fn take_matching_or_wait(source_hash: u64, timeout: Duration) -> Option<Vec<Edit>> {
    // Fast path: a result is already cached.
    if let Some(edits) = try_take_matching(source_hash).await {
        return Some(edits);
    }

    // Check if there's an in-flight speculation for this exact hash.
    // If not, return None immediately — the compile handler will run
    // a fresh live AI call with no extra latency.
    //
    // We grab the `completion` Notify handle BEFORE releasing the
    // lock so that if the speculation completes between the in-flight
    // check and our wait, we still see it via the Notify permit.
    // tokio::sync::Notify::notify_one stores one permit if no waiter
    // is registered, so the race is safe.
    let (in_flight_match, notify) = {
        let s = get_state().lock().await;
        (s.in_flight_hash == Some(source_hash), s.completion.clone())
    };
    if !in_flight_match {
        return None;
    }

    eprintln!(
        "[Spec] WAIT source_hash={} (speculation in flight, blocking up to {:?})",
        source_hash, timeout
    );
    let wait_start = Instant::now();

    // Wait for completion notification, with timeout.
    let notified = notify.notified();
    tokio::pin!(notified);
    let done = tokio::time::timeout(timeout, &mut notified).await;

    match done {
        Ok(()) => {
            // Speculation woke us. Re-check the cache.
            if let Some(edits) = try_take_matching(source_hash).await {
                eprintln!(
                    "[Spec] WAIT complete after {:?}, cache hit",
                    wait_start.elapsed()
                );
                Some(edits)
            } else {
                // Woken but no matching result. Could be because the
                // speculation errored, was superseded, or the result
                // was for a different hash. Fall through.
                eprintln!(
                    "[Spec] WAIT complete after {:?}, cache still empty — falling through",
                    wait_start.elapsed()
                );
                None
            }
        }
        Err(_) => {
            // Timed out waiting for speculation. Fall through to live.
            eprintln!(
                "[Spec] WAIT timeout after {:?} — falling through to live AI call",
                wait_start.elapsed()
            );
            None
        }
    }
}

/// Compute the source hash used as the cache key. Must match what
/// the file-sync handler and the compile handler both derive from
/// the same source string for the cache lookup to work.
pub fn hash_source(s: &str) -> u64 {
    hash_str(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn cancel_notify_enable_catches_early_fire() {
        let notify = Arc::new(Notify::new());
        let notify_clone = notify.clone();

        let was_cancelled = Arc::new(AtomicBool::new(false));
        let was_cancelled_clone = was_cancelled.clone();

        let handle = tokio::spawn(async move {
            let notified = notify_clone.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            // Yield so the main task can fire notify_waiters()
            // AFTER enable() but BEFORE select! poll.
            tokio::task::yield_now().await;

            tokio::select! {
                biased;
                _ = &mut notified => {
                    was_cancelled_clone.store(true, Ordering::SeqCst);
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        });

        // Give the spawned task time to reach yield_now
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // Fire notification — with enable(), this reaches the waiter
        // even though select! hasn't polled yet.
        notify.notify_waiters();

        handle.await.unwrap();
        assert!(
            was_cancelled.load(Ordering::SeqCst),
            "enable() should register the waiter eagerly so notify_waiters() is not lost"
        );
    }

    #[tokio::test]
    async fn hash_source_deterministic() {
        let h1 = hash_source("hello world");
        let h2 = hash_source("hello world");
        let h3 = hash_source("hello world!");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }
}
