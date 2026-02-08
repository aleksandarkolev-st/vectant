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
    matches!(res, Ok(s) if s.success())
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
            // Step 2: Install rust-analyzer component (preferred) or download binary
            ". \"$HOME/.cargo/env\" 2>/dev/null; \
             rustup component add rust-analyzer 2>/dev/null || \
             curl -L https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz | \
             gunzip > /usr/local/bin/rust-analyzer && chmod +x /usr/local/bin/rust-analyzer",
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
            // Dart SDK is usually installed with Flutter; skip for now
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

    // Already on PATH?  Done.
    if is_on_path(binary).await {
        println!("[LSP-INSTALL] {} already available", binary);
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
