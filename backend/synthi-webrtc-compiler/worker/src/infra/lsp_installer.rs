//! Auto-installs language servers on demand when they are not found on PATH.
//!
//! Called before spawning the LSP process.  Each install is guarded by a
//! marker file so it only runs once per worker lifetime / workspace.
//!
//! The installs are best-effort: if something fails we log and let the caller
//! try to spawn anyway (maybe the user installed it manually in the meantime).

use std::path::Path;
use tokio::process::Command;
use std::process::Stdio;

/// Check whether `program` is available on PATH (or reachable via WSL on Windows).
/// Also checks well-known SDK install locations for certain programs (e.g. Dart).
async fn is_on_path(program: &str) -> bool {
    let res = if cfg!(target_os = "windows") {
        Command::new("wsl")
            .args(["which", program])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
    } else {
        Command::new("which")
            .arg(program)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
    };
    if matches!(res, Ok(s) if s.success()) {
        return true;
    }

    // Fallback: check well-known SDK install locations for binaries that
    // may not be on the default PATH (e.g. Dart SDK installs to /opt or /usr/lib).
    let extra_paths: &[&str] = match program {
        "dart" => &[
            "/opt/dart-sdk/bin/dart",
            "/usr/lib/dart/bin/dart",
            "/usr/local/bin/dart",
        ],
        _ => &[],
    };
    for path in extra_paths {
        if std::path::Path::new(path).exists() {
            return true;
        }
    }
    false
}

/// Run a shell command (or via WSL on Windows).  Returns Ok(()) on success.
async fn sh(script: &str) -> Result<(), String> {
    println!("[LSP-INSTALL] Running: {}", script);
    let status = if cfg!(target_os = "windows") {
        Command::new("wsl")
            .args(["bash", "-lc", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .await
    } else {
        Command::new("bash")
            .args(["-lc", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .await
    };
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("exited {:?}", s.code())),
        Err(e) => Err(format!("{}", e)),
    }
}

/// Ensure the language server for `lang` is installed.
/// `workspace` is the project root (used for marker files).
///
/// Returns the binary name that should be on PATH after installation
/// (useful for logging), or an error string if install failed.
pub async fn ensure_lsp_installed(lang: &str, workspace: &Path) -> Result<&'static str, String> {
    let (binary, install_steps) = match lang {
        "cpp" | "c" => ("clangd", vec![
            "apt-get update -qq && apt-get install -y -qq clangd >/dev/null 2>&1 || true",
        ]),
        "rust" => ("rust-analyzer", vec![
            // Step 1: Ensure rustup + cargo + rustc are available.
            // Without cargo, rust-analyzer can't load workspace metadata.
            "command -v cargo >/dev/null 2>&1 || \
             (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable 2>/dev/null && \
              . \"$HOME/.cargo/env\" 2>/dev/null || true)",
            // Step 2: Install rust-src — required for stdlib completions (Vec, String, etc.).
            // Also install rust-analyzer as a rustup component (preferred).
            ". \"$HOME/.cargo/env\" 2>/dev/null; \
             rustup component add rust-src rust-analyzer 2>/dev/null || true",
            // Step 3: Fallback — if rustup isn't available, try system package or binary download.
            // Also try installing rust-src via apt for system rustc installs.
            "command -v rust-analyzer >/dev/null 2>&1 || \
             (apt-get update -qq && apt-get install -y -qq rust-src 2>/dev/null || true; \
              curl -L https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz | \
              gunzip > /usr/local/bin/rust-analyzer && chmod +x /usr/local/bin/rust-analyzer)",
        ]),
        "python" | "py" => ("pylsp", vec![
            // Prefer OS package to avoid PEP 668 restrictions
            "apt-get update -qq && apt-get install -y -qq python3-pylsp >/dev/null 2>&1 || true",
            // Fallback to pip with explicit override
            "pip install --quiet --break-system-packages python-lsp-server 2>/dev/null || pip3 install --quiet --break-system-packages python-lsp-server",
        ]),
        "typescript" | "ts" | "javascript" | "js" => ("typescript-language-server", vec![
            "npm install -g typescript-language-server typescript 2>/dev/null || true",
        ]),
        "java" => ("jdtls", vec![
            // Step 1: ensure JDK 17+ is available
            "java -version 2>&1 || (apt-get update -qq && apt-get install -y -qq openjdk-17-jdk >/dev/null 2>&1)",
            // Step 2: download jdtls
            "mkdir -p /opt/jdtls && \
             curl -fsSL https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202409261450.tar.gz | \
             tar xz -C /opt/jdtls",
            // Step 3: create wrapper script
            "printf '%s\\n' '#!/bin/bash' \
             'exec java \\' \
             '  -Declipse.application=org.eclipse.jdt.ls.core.id1 \\' \
             '  -Dosgi.bundles.defaultStartLevel=4 \\' \
             '  -Declipse.product=org.eclipse.jdt.ls.core.product \\' \
             '  -Xmx1G \\' \
             '  --add-modules=ALL-SYSTEM \\' \
             '  --add-opens java.base/java.util=ALL-UNNAMED \\' \
             '  --add-opens java.base/java.lang=ALL-UNNAMED \\' \
             '  -jar /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar \\' \
             '  -configuration /opt/jdtls/config_linux \\' \
             '  \"$@\"' \
             > /usr/local/bin/jdtls && chmod +x /usr/local/bin/jdtls",
        ]),
        "go" => ("gopls", vec![
            "go install golang.org/x/tools/gopls@latest 2>/dev/null || true",
        ]),
        "csharp" | "cs" => ("OmniSharp", vec![
            // OmniSharp is complex to auto-install; skip for now
        ]),
        "ruby" | "rb" => ("ruby-lsp", vec![
            "gem install ruby-lsp 2>/dev/null || true",
        ]),
        "php" => ("phpactor", vec![
            "composer global require phpactor/phpactor 2>/dev/null || true",
        ]),
        "kotlin" | "kt" => ("kotlin-language-server", vec![
            // Kotlin LS requires manual download; skip for now
        ]),
        "zig" => ("zls", vec![
            // ZLS requires matching zig version; skip for now
        ]),
        "dart" => ("dart", vec![
            // Try apt first (official dart repo), then fallback to manual SDK download
            "command -v dart >/dev/null 2>&1 || \
             (apt-get update -qq && apt-get install -y -qq apt-transport-https gnupg2 2>/dev/null; \
              curl -fsSL https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/dart-archive-keyring.gpg 2>/dev/null; \
              echo 'deb [signed-by=/usr/share/keyrings/dart-archive-keyring.gpg arch=amd64] https://storage.googleapis.com/dart-archive/channels/stable/release/latest/linux-packages stable main' > /etc/apt/sources.list.d/dart_stable.list; \
              apt-get update -qq && apt-get install -y -qq dart 2>/dev/null && \
              ln -sf /usr/lib/dart/bin/dart /usr/local/bin/dart 2>/dev/null) || true",
            // Fallback: direct SDK download (ensure unzip is available first)
            "command -v dart >/dev/null 2>&1 || \
             (apt-get install -y -qq unzip 2>/dev/null || true; \
              curl -fsSL https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip -o /tmp/dart-sdk.zip && \
              unzip -qo /tmp/dart-sdk.zip -d /opt && rm -f /tmp/dart-sdk.zip && \
              ln -sf /opt/dart-sdk/bin/dart /usr/local/bin/dart && \
              export PATH=\"/opt/dart-sdk/bin:$PATH\") || true",
            // Ensure dart is on PATH by adding symlinks for common install locations
            "command -v dart >/dev/null 2>&1 || \
             (for d in /opt/dart-sdk/bin/dart /usr/lib/dart/bin/dart; do \
                [ -x \"$d\" ] && ln -sf \"$d\" /usr/local/bin/dart && break; \
              done) || true",
        ]),
        "lua" => ("lua-language-server", vec![
            // LuaLS requires manual download
        ]),
        "elixir" | "ex" => ("elixir-ls", vec![
            // ElixirLS requires matching OTP version; skip for now
        ]),
        "svelte" => ("svelteserver", vec![
            "npm install -g svelte-language-server 2>/dev/null || true",
        ]),
        "css" | "scss" | "less" => ("vscode-css-language-server", vec![
            "npm install -g vscode-langservers-extracted 2>/dev/null || true",
        ]),
        "html" => ("vscode-html-language-server", vec![
            "npm install -g vscode-langservers-extracted 2>/dev/null || true",
        ]),
        _ => return Err(format!("No installer for language: {}", lang)),
    };

    // Already on PATH?  Done — but for Rust, we still need to ensure
    // rust-src is installed (required for stdlib completions like Vec::new).
    // The rust-analyzer binary may be pre-installed from a system package
    // without the rust-src component.
    if is_on_path(binary).await {
        println!("[LSP-INSTALL] {} already available", binary);
        if lang == "rust" {
            ensure_rust_src().await;
        }
        return Ok(binary);
    }

    if install_steps.is_empty() {
        return Err(format!("{} not found and no auto-installer configured", binary));
    }

    // Check marker to rate-limit install attempts (max once per 5 minutes).
    // We no longer permanently block retries — a previous failure (e.g. PEP 668
    // before --break-system-packages was added) shouldn't prevent future attempts.
    let marker = workspace.join(format!(".synthi_lsp_installed_{}", lang));
    if marker.exists() {
        // Already attempted — check if it actually worked
        if is_on_path(binary).await {
            if lang == "rust" { ensure_rust_src().await; }
            return Ok(binary);
        }
        // Rate-limit: only retry if the marker is older than 5 minutes
        if let Ok(meta) = std::fs::metadata(&marker) {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().unwrap_or_default() < std::time::Duration::from_secs(300) {
                    return Err(format!("{} install was recently attempted but binary still not found (will retry after cooldown)", binary));
                }
            }
        }
        // Cooldown expired — remove stale marker and retry
        let _ = std::fs::remove_file(&marker);
    }

    println!("[LSP-INSTALL] {} not found, installing for {}...", binary, lang);

    for step in &install_steps {
        if let Err(e) = sh(step).await {
            eprintln!("[LSP-INSTALL] Install step failed: {}", e);
            // Continue to next step — some steps are fallbacks
        }
    }

    // Verify
    if is_on_path(binary).await {
        // Only write marker on SUCCESS — failed installs should be retried
        let _ = std::fs::write(&marker, "installed");
        println!("[LSP-INSTALL] ✓ {} installed successfully", binary);
        Ok(binary)
    } else {
        // Write marker with timestamp so we can rate-limit retries
        let _ = std::fs::write(&marker, "failed");
        Err(format!("{} still not found after install attempt", binary))
    }
}

/// Ensure the `rust-src` component is installed via rustup.
/// This is critical for rust-analyzer to resolve stdlib types
/// (Vec::new, String::from, HashMap::insert, etc.).
/// Without rust-src, RA can autocomplete type *names* from the
/// prelude but cannot index their impl blocks or methods.
///
/// IMPORTANT: We must check using the **same PATH** that rust-analyzer
/// will use at runtime (`$CARGO_HOME/bin` prepended).  If the container
/// has both a system rustc (`/usr`) and a rustup installation
/// (`~/.cargo/bin`), the system sysroot may have rust-src while the
/// rustup toolchain does not.  RA uses the rustup toolchain, so we
/// must ensure rust-src is installed there.
async fn ensure_rust_src() {
    // On Windows, rust-analyzer runs inside WSL, so we must check
    // and install rust-src in the WSL environment, not on the host.
    // The previous code ran `rustc --print sysroot` on the Windows
    // host, found rust-src there, and returned early — leaving the
    // WSL environment without rust-src.
    if cfg!(target_os = "windows") {
        // Check if rust-src exists inside WSL
        let check = sh("test -d \"$(rustc --print sysroot)/lib/rustlib/src/rust/library\"").await;
        if check.is_ok() {
            println!("[LSP-INSTALL] rust-src already present in WSL");
            return;
        }
        println!("[LSP-INSTALL] rust-src not found in WSL, installing...");
        let _ = sh(". \"$HOME/.cargo/env\" 2>/dev/null; rustup component add rust-src 2>/dev/null || true").await;
        let _ = sh("apt-get update -qq && apt-get install -y -qq rust-src 2>/dev/null || true").await;
        println!("[LSP-INSTALL] rust-src installation attempted in WSL");
        return;
    }

    // Linux: check using the same PATH that rust-analyzer will use.
    // RA is spawned with $CARGO_HOME/bin prepended to PATH, which may
    // resolve to a different rustc (rustup proxy) than the system one.
    let cargo_home = std::env::var("CARGO_HOME")
        .unwrap_or_else(|_| "/root/.cargo".to_string());
    let current_path = std::env::var("PATH").unwrap_or_default();
    let ra_path = format!("{}/bin:{}", cargo_home, current_path);

    // Check rust-src with RA's PATH (the rustc that RA will actually use)
    let ra_sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .env("PATH", &ra_path)
        .env_remove("RUSTUP_TOOLCHAIN")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()
        .and_then(|o| if o.status.success() {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else {
            None
        });

    if let Some(ref sysroot) = ra_sysroot {
        let lib_path = std::path::PathBuf::from(sysroot)
            .join("lib/rustlib/src/rust/library");
        if lib_path.exists() {
            println!("[LSP-INSTALL] rust-src already present at {} (RA sysroot)", lib_path.display());
            return;
        }
        println!("[LSP-INSTALL] rust-src NOT found at {} (RA sysroot: {})", lib_path.display(), sysroot);
    }

    // Also check the system sysroot as a secondary location
    let sys_sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()
        .and_then(|o| if o.status.success() {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else {
            None
        });

    if let Some(ref sysroot) = sys_sysroot {
        let lib_path = std::path::PathBuf::from(sysroot)
            .join("lib/rustlib/src/rust/library");
        if lib_path.exists() {
            println!("[LSP-INSTALL] rust-src found at system sysroot {} but NOT in RA's sysroot — installing for RA's toolchain", lib_path.display());
        }
    }

    println!("[LSP-INSTALL] Installing rust-src for RA's toolchain...");
    // Install rust-src using the same PATH as RA, so rustup installs
    // for the correct toolchain (the one RA will actually use).
    let install_script = format!(
        "export PATH='{}'; . \"$HOME/.cargo/env\" 2>/dev/null; rustup component add rust-src 2>/dev/null || true",
        ra_path
    );
    let _ = sh(&install_script).await;
    // Fallback: try apt (handles system-installed rustc without rustup)
    let _ = sh("apt-get update -qq && apt-get install -y -qq rust-src 2>/dev/null || true").await;
    println!("[LSP-INSTALL] rust-src installation attempted");
}
