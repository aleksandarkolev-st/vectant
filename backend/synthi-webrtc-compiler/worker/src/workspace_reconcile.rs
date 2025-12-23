use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::fs;
use webrtc::data_channel::RTCDataChannel;

#[derive(Debug, Clone)]
pub struct ReconcileConfig {
    pub include_build_outputs: bool,
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub chunk_chars: usize,
}

impl Default for ReconcileConfig {
    fn default() -> Self {
        Self {
            include_build_outputs: false,
            max_files: 200,
            max_total_bytes: 25 * 1024 * 1024,
            max_file_bytes: 5 * 1024 * 1024,
            chunk_chars: 24_000,
        }
    }
}

impl ReconcileConfig {
    pub fn from_env() -> Self {
        let mut cfg = Self::default();

        let truthy = |v: &str| {
            matches!(
                v.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "y" | "on"
            )
        };

        if let Ok(v) = std::env::var("SYNTHI_SYNC_BUILD_OUTPUTS") {
            cfg.include_build_outputs = truthy(&v);
        }
        if let Ok(v) = std::env::var("SYNTHI_SYNC_MAX_FILES") {
            if let Ok(n) = v.trim().parse::<usize>() {
                cfg.max_files = n;
            }
        }
        if let Ok(v) = std::env::var("SYNTHI_SYNC_MAX_TOTAL_BYTES") {
            if let Ok(n) = v.trim().parse::<u64>() {
                cfg.max_total_bytes = n;
            }
        }
        if let Ok(v) = std::env::var("SYNTHI_SYNC_MAX_FILE_BYTES") {
            if let Ok(n) = v.trim().parse::<u64>() {
                cfg.max_file_bytes = n;
            }
        }
        if let Ok(v) = std::env::var("SYNTHI_SYNC_CHUNK_CHARS") {
            if let Ok(n) = v.trim().parse::<usize>() {
                cfg.chunk_chars = n.max(4096);
            }
        }

        cfg
    }
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    // relative path -> sha256
    hashes: HashMap<String, String>,
}

impl Snapshot {
    pub fn contains_path(&self, rel: &str) -> bool {
        self.hashes.contains_key(rel)
    }
}

#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub existed_before: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverwritePolicy {
    /// Safe to overwrite existing files (tool-owned).
    Overwrite,
    /// Only write if the file did not exist in the original workspace snapshot.
    CreateOnly,
}

#[derive(Debug, Clone)]
pub struct SyncRules {
    pub always: Vec<(String, OverwritePolicy)>,
    pub optional_dirs: Vec<String>,
}

impl SyncRules {
    /// Prefixes all rule paths with a workspace-relative directory (e.g. "android" or "apps/mobile/android").
    ///
    /// This is used for React Native projects where the Android Gradle project lives at
    /// `<project_root>/android` rather than at the workspace root.
    pub fn with_prefix(&self, prefix: &str) -> Self {
        let prefix = prefix.replace('\\', "/");
        let prefix = prefix.trim().trim_matches('/');
        if prefix.is_empty() {
            return self.clone();
        }

        let join = |p: &str| {
            let p = p.replace('\\', "/");
            let p = p.trim().trim_start_matches('/');
            format!("{}/{}", prefix, p)
        };

        Self {
            always: self.always.iter().map(|(p, pol)| (join(p), *pol)).collect(),
            optional_dirs: self.optional_dirs.iter().map(|d| join(d)).collect(),
        }
    }
}

impl Default for SyncRules {
    fn default() -> Self {
        Self {
            always: vec![
                ("gradlew".into(), OverwritePolicy::Overwrite),
                ("gradlew.bat".into(), OverwritePolicy::Overwrite),
                ("gradle/wrapper".into(), OverwritePolicy::Overwrite),
                ("local.properties".into(), OverwritePolicy::Overwrite),
                // Build scripts can be user-authored; only persist if generated (new).
                ("settings.gradle".into(), OverwritePolicy::CreateOnly),
                ("settings.gradle.kts".into(), OverwritePolicy::CreateOnly),
                ("build.gradle".into(), OverwritePolicy::CreateOnly),
                ("build.gradle.kts".into(), OverwritePolicy::CreateOnly),
            ],
            optional_dirs: vec!["build".into(), "app/build".into()],
        }
    }
}

#[derive(Debug, Serialize)]
struct ReconcileMsg<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    #[serde(rename = "type")]
    msg_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idx: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_chunks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<serde_json::Value>,
}

fn normalize_rel_path(rel: &str) -> Option<String> {
    let p = rel.replace('\\', "/");
    let p = p.trim().trim_start_matches('/');
    if p.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in p.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        out.push(part);
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("/"))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

async fn read_file_bytes(path: &Path) -> Result<Vec<u8>> {
    let bytes = fs::read(path)
        .await
        .with_context(|| format!("read failed: {}", path.display()))?;
    Ok(bytes)
}

async fn file_sha256(path: &Path) -> Result<String> {
    let bytes = read_file_bytes(path).await?;
    Ok(sha256_hex(&bytes))
}

async fn snapshot_paths(
    workspace_root: &Path,
    rules: &SyncRules,
    include_optional_dirs: bool,
) -> Result<Snapshot> {
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();

    for (p, _) in &rules.always {
        let rel = normalize_rel_path(p).unwrap();
        let abs = workspace_root.join(&rel);
        if abs.is_file() {
            candidates.push((abs, rel));
        } else if abs.is_dir() {
            // capture all files under directory
            let mut stack = vec![abs.clone()];
            while let Some(dir) = stack.pop() {
                let mut rd = fs::read_dir(&dir).await?;
                while let Some(ent) = rd.next_entry().await? {
                    let ft = ent.file_type().await?;
                    let ent_path = ent.path();
                    if ft.is_dir() {
                        stack.push(ent_path);
                    } else if ft.is_file() {
                        if let Ok(relpath) = ent_path.strip_prefix(workspace_root) {
                            if let Some(r) = normalize_rel_path(&relpath.to_string_lossy()) {
                                candidates.push((ent_path, r));
                            }
                        }
                    }
                }
            }
        }
    }

    if include_optional_dirs {
        for dir in &rules.optional_dirs {
            let rel = normalize_rel_path(dir).unwrap();
            let abs = workspace_root.join(&rel);
            if !abs.is_dir() {
                continue;
            }
            let mut stack = vec![abs];
            while let Some(d) = stack.pop() {
                let mut rd = fs::read_dir(&d).await?;
                while let Some(ent) = rd.next_entry().await? {
                    let ft = ent.file_type().await?;
                    let ent_path = ent.path();
                    if ft.is_dir() {
                        stack.push(ent_path);
                    } else if ft.is_file() {
                        if let Ok(relpath) = ent_path.strip_prefix(workspace_root) {
                            if let Some(r) = normalize_rel_path(&relpath.to_string_lossy()) {
                                candidates.push((ent_path, r));
                            }
                        }
                    }
                }
            }
        }
    }

    let mut hashes = HashMap::new();
    for (abs, rel) in candidates {
        let h = file_sha256(&abs).await.unwrap_or_default();
        if !h.is_empty() {
            hashes.insert(rel, h);
        }
    }

    Ok(Snapshot { hashes })
}

fn overwrite_policy_for_path(rules: &SyncRules, rel: &str) -> OverwritePolicy {
    let rel_norm = rel.replace('\\', "/");

    for (p, policy) in &rules.always {
        let p_norm = p.replace('\\', "/").trim_matches('/').to_string();
        if p_norm.is_empty() {
            continue;
        }
        if rel_norm == p_norm {
            return *policy;
        }
        if rel_norm.starts_with(&(p_norm.clone() + "/")) {
            return *policy;
        }
    }

    // Optional dirs: treated as CreateOnly unless explicitly enabled elsewhere.
    OverwritePolicy::CreateOnly
}

async fn collect_changes(
    workspace_root: &Path,
    snapshot: &Snapshot,
    rules: &SyncRules,
    cfg: &ReconcileConfig,
) -> Result<(Vec<FileChange>, serde_json::Value)> {
    let post = snapshot_paths(workspace_root, rules, cfg.include_build_outputs).await?;

    let mut changed = Vec::new();
    let mut total_bytes: u64 = 0;

    // Deterministic ordering
    let mut paths: Vec<String> = post.hashes.keys().cloned().collect();
    paths.sort();

    let mut skipped = Vec::new();

    for rel in paths {
        if changed.len() >= cfg.max_files {
            skipped.push(json!({"path": rel, "reason": "max_files"}));
            continue;
        }

        let abs = workspace_root.join(&rel);
        let meta = fs::metadata(&abs).await;
        let Ok(meta) = meta else { continue };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        if size > cfg.max_file_bytes {
            skipped.push(json!({"path": rel, "reason": "file_too_large", "size": size}));
            continue;
        }

        if total_bytes.saturating_add(size) > cfg.max_total_bytes {
            skipped.push(json!({"path": rel, "reason": "max_total_bytes", "size": size}));
            continue;
        }

        let existed_before = snapshot.hashes.contains_key(&rel);
        let old_hash = snapshot.hashes.get(&rel);
        let new_hash = post.hashes.get(&rel);
        if existed_before {
            if let (Some(o), Some(n)) = (old_hash, new_hash) {
                if o == n {
                    continue;
                }
            }
        }

        let policy = overwrite_policy_for_path(rules, &rel);
        if existed_before && policy == OverwritePolicy::CreateOnly {
            skipped.push(json!({"path": rel, "reason": "create_only_existing"}));
            continue;
        }

        let bytes = read_file_bytes(&abs).await?;
        let sha256 = sha256_hex(&bytes);

        changed.push(FileChange {
            path: rel,
            bytes,
            sha256,
            existed_before,
        });
        total_bytes = total_bytes.saturating_add(size);
    }

    let summary = json!({
        "planned": changed.len(),
        "skipped": skipped,
        "total_bytes": total_bytes,
        "include_build_outputs": cfg.include_build_outputs,
        "max_files": cfg.max_files,
        "max_total_bytes": cfg.max_total_bytes,
        "max_file_bytes": cfg.max_file_bytes,
    });

    Ok((changed, summary))
}

fn is_probably_text(path: &str, bytes: &[u8]) -> bool {
    // quick heuristic: treat common gradle/android textual extensions as text
    let lower = path.to_lowercase();
    let text_exts = [
        ".gradle",
        ".kts",
        ".properties",
        ".xml",
        ".json",
        ".txt",
        ".md",
        ".kt",
        ".java",
        ".sh",
        ".bat",
    ];
    if text_exts.iter().any(|e| lower.ends_with(e)) {
        return true;
    }
    // for unknown: check for NUL bytes
    !bytes.iter().any(|b| *b == 0)
}

async fn send_json(dc: &Arc<RTCDataChannel>, payload: &impl Serialize) {
    let _ = dc
        .send_text(serde_json::to_string(payload).unwrap_or_default())
        .await;
}

pub async fn reconcile_and_stream(
    log_dc: Arc<RTCDataChannel>,
    session_id: &str,
    workspace_root: &Path,
    snapshot: Snapshot,
) -> Result<()> {
    let cfg = ReconcileConfig::from_env();
    let rules = SyncRules::default();

    reconcile_and_stream_with_rules(log_dc, session_id, workspace_root, snapshot, rules, cfg).await
}

pub async fn reconcile_and_stream_with_rules(
    log_dc: Arc<RTCDataChannel>,
    session_id: &str,
    workspace_root: &Path,
    snapshot: Snapshot,
    rules: SyncRules,
    cfg: ReconcileConfig,
) -> Result<()> {
    let (changes, summary) = collect_changes(workspace_root, &snapshot, &rules, &cfg).await?;

    send_json(
        &log_dc,
        &ReconcileMsg {
            session_id,
            msg_type: "workspace-reconcile-begin",
            path: None,
            sha256: None,
            size: None,
            idx: None,
            total_chunks: None,
            mode: None,
            data: None,
            summary: Some(summary.clone()),
        },
    )
    .await;

    // Guard against duplicates if snapshot collection had duplicates
    let mut sent: HashSet<String> = HashSet::new();

    for ch in changes {
        if !sent.insert(ch.path.clone()) {
            continue;
        }

        let is_text = is_probably_text(&ch.path, &ch.bytes);
        let mode = if ch.existed_before {
            "overwrite"
        } else {
            "create"
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&ch.bytes);
        let chunk_chars = cfg.chunk_chars.max(4096);
        let total_chunks = (b64.len() + chunk_chars - 1) / chunk_chars;

        send_json(
            &log_dc,
            &ReconcileMsg {
                session_id,
                msg_type: "workspace-file-begin",
                path: Some(&ch.path),
                sha256: Some(&ch.sha256),
                size: Some(ch.bytes.len() as u64),
                idx: None,
                total_chunks: Some(total_chunks),
                mode: Some(mode),
                data: Some(if is_text { "text" } else { "binary" }),
                summary: None,
            },
        )
        .await;

        for (idx, chunk) in b64.as_bytes().chunks(chunk_chars).enumerate() {
            let s = std::str::from_utf8(chunk).unwrap_or("");
            send_json(
                &log_dc,
                &ReconcileMsg {
                    session_id,
                    msg_type: "workspace-file-chunk",
                    path: Some(&ch.path),
                    sha256: None,
                    size: None,
                    idx: Some(idx),
                    total_chunks: None,
                    mode: None,
                    data: Some(s),
                    summary: None,
                },
            )
            .await;
        }

        send_json(
            &log_dc,
            &ReconcileMsg {
                session_id,
                msg_type: "workspace-file-end",
                path: Some(&ch.path),
                sha256: None,
                size: None,
                idx: None,
                total_chunks: None,
                mode: None,
                data: None,
                summary: None,
            },
        )
        .await;
    }

    send_json(
        &log_dc,
        &ReconcileMsg {
            session_id,
            msg_type: "workspace-reconcile-end",
            path: None,
            sha256: None,
            size: None,
            idx: None,
            total_chunks: None,
            mode: None,
            data: None,
            summary: Some(summary),
        },
    )
    .await;

    Ok(())
}

pub async fn take_snapshot(workspace_root: &Path) -> Result<Snapshot> {
    let cfg = ReconcileConfig::from_env();
    let rules = SyncRules::default();
    snapshot_paths(workspace_root, &rules, cfg.include_build_outputs).await
}

pub async fn take_snapshot_with_rules(workspace_root: &Path, rules: SyncRules) -> Result<Snapshot> {
    let cfg = ReconcileConfig::from_env();
    snapshot_paths(workspace_root, &rules, cfg.include_build_outputs).await
}
