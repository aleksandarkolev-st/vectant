use anyhow::{Context, Result};
use lazy_static::lazy_static;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::{EmulatorConfig, EmulatorSession};

#[derive(Debug, Clone)]
pub struct EnsureReadyResult {
    pub serial: String,
    pub boot_time_ms: u64,
    pub reused: bool,
}

pub struct EmulatorDaemon {
    session: Option<EmulatorSession>,
    config_fingerprint: Option<String>,
    last_used_at: Option<Instant>,
    idle_shutdown_after: Duration,
}

impl EmulatorDaemon {
    pub fn new() -> Self {
        Self {
            session: None,
            config_fingerprint: None,
            last_used_at: None,
            // Default: keep the emulator warm for a bit between jobs.
            idle_shutdown_after: Duration::from_secs(10 * 60),
        }
    }

    pub async fn ensure_ready(&mut self, config: EmulatorConfig) -> Result<EnsureReadyResult> {
        let fingerprint = fingerprint_config(&config);

        // If the config changes (different SDK root / AVD / image), restart.
        if self
            .config_fingerprint
            .as_ref()
            .is_some_and(|f| f != &fingerprint)
        {
            self.shutdown_now().await;
        }

        // If we have a live session and a serial, treat it as reusable.
        if let Some(session) = self.session.as_ref() {
            if let Some(serial) = session.serial().await {
                self.config_fingerprint = Some(fingerprint);
                self.last_used_at = Some(Instant::now());
                return Ok(EnsureReadyResult {
                    serial,
                    boot_time_ms: 0,
                    reused: true,
                });
            }
        }

        // Otherwise, cold boot.
        let mut session = EmulatorSession::new(config);
        let boot = session.boot().await.context("Failed to boot emulator")?;
        if !boot.success {
            self.session = None;
            self.config_fingerprint = None;
            self.last_used_at = None;
            anyhow::bail!("Emulator boot failed: {:?}", boot.error);
        }

        let serial = boot.serial.clone().unwrap_or_default();
        self.session = Some(session);
        self.config_fingerprint = Some(fingerprint);
        self.last_used_at = Some(Instant::now());

        Ok(EnsureReadyResult {
            serial,
            boot_time_ms: boot.boot_time_ms,
            reused: false,
        })
    }

    pub fn session_mut(&mut self) -> &mut EmulatorSession {
        self.session
            .as_mut()
            .expect("ensure_ready must be called before session_mut")
    }

    pub fn session(&self) -> Option<&EmulatorSession> {
        self.session.as_ref()
    }

    /// Mark the emulator as recently used but keep it alive.
    /// Also stops any running logcat process so jobs don't leak streams.
    pub async fn release_keepalive(&mut self) {
        if let Some(session) = self.session.as_ref() {
            let _ = session.stop_logcat().await;
        }
        self.last_used_at = Some(Instant::now());
    }

    /// Explicitly shuts down the emulator (daemon-managed reset).
    pub async fn shutdown_now(&mut self) {
        if let Some(mut session) = self.session.take() {
            let _ = session.shutdown().await;
        }
        self.config_fingerprint = None;
        self.last_used_at = None;
    }

    pub async fn maybe_reap_idle(&mut self) {
        let Some(last_used) = self.last_used_at else {
            return;
        };

        if last_used.elapsed() >= self.idle_shutdown_after {
            self.shutdown_now().await;
            return;
        }

        // Enforce maximum lifetime as well.
        if let Some(session) = self.session.as_ref() {
            if session.is_expired() {
                self.shutdown_now().await;
            }
        }
    }
}

fn fingerprint_config(cfg: &EmulatorConfig) -> String {
    // Keep it stable and explicit; any meaningful change should restart the emulator.
    format!(
        "sdk={}|avd={}|img={}|ram={}|cores={}|hw_accel={}|extra={}",
        cfg.android_sdk_root.display(),
        cfg.avd_name,
        cfg.system_image,
        cfg.ram_mb,
        cfg.cores,
        cfg.use_hw_accel,
        cfg.extra_args.join(";")
    )
}

lazy_static! {
    static ref GLOBAL_DAEMON: Mutex<EmulatorDaemon> = Mutex::new(EmulatorDaemon::new());
}

static REAPER_STARTED: OnceLock<()> = OnceLock::new();

fn start_reaper_task_once() {
    if REAPER_STARTED.set(()).is_err() {
        return;
    }

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            let mut daemon = GLOBAL_DAEMON.lock().await;
            daemon.maybe_reap_idle().await;
        }
    });
}

/// Acquire the global emulator daemon lock and ensure the emulator is ready.
///
/// NOTE: This returns a MutexGuard; while held, no other job can use the emulator.
pub async fn acquire_emulator_daemon(
    config: EmulatorConfig,
) -> Result<(tokio::sync::MutexGuard<'static, EmulatorDaemon>, EnsureReadyResult)> {
    start_reaper_task_once();

    let mut daemon = GLOBAL_DAEMON.lock().await;
    let info = daemon.ensure_ready(config).await?;

    Ok((daemon, info))
}
