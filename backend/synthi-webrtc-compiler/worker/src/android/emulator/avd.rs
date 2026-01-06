use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::session::EmulatorSession;
use super::types::{parse_installed_system_images, rank_system_image};

impl EmulatorSession {
    // ============================================================
    // AVD MANAGEMENT
    // ============================================================

    /// Ensures the AVD exists, creating it if necessary
    pub async fn ensure_avd(&self) -> Result<()> {
        let avdmanager = self
            .core
            .config
            .android_sdk_root
            .join("cmdline-tools/latest/bin/avdmanager");

        // Check if AVD exists
        let output = Command::new(&avdmanager)
            .args(["list", "avd", "-c"])
            .output()
            .await
            .context("Failed to list AVDs")?;

        let avd_list = String::from_utf8_lossy(&output.stdout);
        if avd_list
            .lines()
            .any(|l| l.trim() == self.core.config.avd_name)
        {
            return Ok(()); // AVD already exists
        }

        // Create AVD.
        // avdmanager may prompt (e.g. "Do you wish to create a custom hardware profile?"),
        // so provide a default "no".
        let mut cmd = Command::new(&avdmanager);
        cmd.args([
            "create",
            "avd",
            "--name",
            &self.core.config.avd_name,
            "--package",
            &self.core.config.system_image,
            "--device",
            "pixel_4",
            "--force",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .context("Failed to spawn avdmanager create avd")?;
        if let Some(mut stdin) = child.stdin.take() {
            // "no" is the safe default.
            let _ = stdin.write_all(b"no\n").await;
        }
        let out = child
            .wait_with_output()
            .await
            .context("Failed to wait for avdmanager")?;
        if !out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            bail!(
                "avdmanager create avd failed (status={:?})\nstdout:\n{}\nstderr:\n{}",
                out.status.code(),
                stdout,
                stderr
            );
        }

        Ok(())
    }

    /// Downloads the required system image if not present
    pub async fn ensure_system_image(&mut self) -> Result<()> {
        let sdkmanager = self
            .core
            .config
            .android_sdk_root
            .join("cmdline-tools/latest/bin/sdkmanager");

        async fn list_installed(sdkmanager: &Path, sdk_root: &Path) -> Result<String> {
            let output = Command::new(sdkmanager)
                .arg(format!("--sdk_root={}", sdk_root.display()))
                .args(["--list_installed"])
                .output()
                .await
                .with_context(|| {
                    format!("Failed to run {} --list_installed", sdkmanager.display())
                })?;
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }

        async fn accept_licenses_best_effort(sdkmanager: &Path, sdk_root: &Path) {
            let mut cmd = Command::new(sdkmanager);
            cmd.arg(format!("--sdk_root={}", sdk_root.display()))
                .arg("--licenses")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut child) = cmd.spawn() {
                if let Some(mut stdin) = child.stdin.take() {
                    // Some license prompts require multiple confirmations.
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.write_all(b"y\n").await;
                    let _ = stdin.flush().await;
                }
                let _ = child.wait().await;
            }
        }

        async fn install_package(sdkmanager: &Path, sdk_root: &Path, pkg: &str) -> Result<()> {
            // Try to accept licenses first; ignore failures.
            accept_licenses_best_effort(sdkmanager, sdk_root).await;

            let mut cmd = Command::new(sdkmanager);
            cmd.arg(format!("--sdk_root={}", sdk_root.display()))
                .arg(pkg)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .with_context(|| format!("Failed to spawn sdkmanager to install {}", pkg))?;
            if let Some(mut stdin) = child.stdin.take() {
                // Accept licenses / prompts.
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.write_all(b"y\n").await;
                let _ = stdin.flush().await;
            }

            let out = child
                .wait_with_output()
                .await
                .with_context(|| format!("Failed to wait for sdkmanager installing {}", pkg))?;

            if !out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                bail!(
                    "sdkmanager install failed for: {} (status={:?})\nstdout:\n{}\nstderr:\n{}",
                    pkg,
                    out.status.code(),
                    stdout,
                    stderr
                );
            }

            Ok(())
        }

        let sdk_root = self.core.config.android_sdk_root.clone();
        let installed_text = list_installed(&sdkmanager, &sdk_root).await?;
        let installed_images = parse_installed_system_images(&installed_text);

        // If the requested image already exists, we're done.
        if installed_images
            .iter()
            .any(|p| p == &self.core.config.system_image)
        {
            return Ok(());
        }

        // Try installing the requested image.
        let requested = self.core.config.system_image.clone();
        if install_package(&sdkmanager, &sdk_root, &requested)
            .await
            .is_ok()
        {
            return Ok(());
        }

        // If install failed, try fallbacks (prefer already-installed images first).
        if !installed_images.is_empty() {
            let mut sorted = installed_images;
            sorted.sort_by(|a, b| rank_system_image(b).cmp(&rank_system_image(a)));
            let chosen = sorted[0].clone();
            self.core.config.system_image = chosen;
            return Ok(());
        }

        // No installed system images; try a few commonly available candidates.
        let fallback_candidates = [
            // Same API, alternate ABI/flavor.
            "system-images;android-34;google_apis;x86",
            "system-images;android-34;default;x86_64",
            // Commonly available older API.
            "system-images;android-33;google_apis;x86_64",
            "system-images;android-33;default;x86_64",
            "system-images;android-32;google_apis;x86_64",
            "system-images;android-31;google_apis;x86_64",
        ];

        let mut last_err: Option<anyhow::Error> = None;
        for pkg in fallback_candidates {
            match install_package(&sdkmanager, &sdk_root, pkg).await {
                Ok(_) => {
                    self.core.config.system_image = pkg.to_string();
                    return Ok(());
                }
                Err(e) => last_err = Some(e),
            }
        }

        // Re-list for debugging context.
        let installed_after = list_installed(&sdkmanager, &sdk_root)
            .await
            .unwrap_or_default();
        let installed_images_after = parse_installed_system_images(&installed_after);

        if let Some(e) = last_err {
            bail!(
                "No usable Android system image could be installed. Last error: {:#}\nCurrently installed system images: {:?}",
                e,
                installed_images_after
            );
        }

        bail!(
            "No usable Android system image could be installed. Currently installed system images: {:?}",
            installed_images_after
        );
    }
}
