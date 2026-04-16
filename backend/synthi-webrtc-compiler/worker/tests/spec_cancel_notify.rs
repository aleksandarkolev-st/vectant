// ============================================================
// Speculative diff_patch — cancel_notify race fix test
// ============================================================
//
// Validates that the Notify::enable() fix prevents the race
// condition where notify_waiters() fires between Notified
// creation and select! poll.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

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

    notify.notify_waiters();

    handle.await.unwrap();
    assert!(
        was_cancelled.load(Ordering::SeqCst),
        "enable() should register the waiter eagerly"
    );
}

#[tokio::test]
async fn without_enable_notification_can_be_lost() {
    // Demonstrates the race that enable() fixes.
    // Without enable(), notify_waiters() before the first poll
    // is a no-op. This test shows the select! falls through to
    // the timeout arm instead of the cancel arm.
    let notify = Arc::new(Notify::new());
    let notify_clone = notify.clone();

    let was_cancelled = Arc::new(AtomicBool::new(false));
    let was_cancelled_clone = was_cancelled.clone();

    // Fire BEFORE .notified() is created — proves that
    // notify_waiters() without a registered waiter is a no-op.
    notify.notify_waiters();

    let handle = tokio::spawn(async move {
        let notified = notify_clone.notified();
        tokio::pin!(notified);
        // NO enable() call — the notification was already lost

        tokio::select! {
            biased;
            _ = &mut notified => {
                was_cancelled_clone.store(true, Ordering::SeqCst);
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    });

    handle.await.unwrap();
    assert!(
        !was_cancelled.load(Ordering::SeqCst),
        "without enable(), notification before creation is lost"
    );
}

#[tokio::test]
async fn hash_source_deterministic() {
    let h1 = worker::hmr::speculative_diff_patch::hash_source("hello world");
    let h2 = worker::hmr::speculative_diff_patch::hash_source("hello world");
    let h3 = worker::hmr::speculative_diff_patch::hash_source("hello world!");
    assert_eq!(h1, h2);
    assert_ne!(h1, h3);
}
