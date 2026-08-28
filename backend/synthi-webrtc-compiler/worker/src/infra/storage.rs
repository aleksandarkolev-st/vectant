use futures_util::StreamExt;
use lazy_static::lazy_static;
use object_store::{
    gcp::{GoogleCloudStorageBuilder, GoogleConfigKey},
    path::Path,
    ObjectStore,
};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

lazy_static! {
    /// Slugs that have been successfully downloaded in this worker session.
    /// Subsequent `download()` calls for the same slug return the cached path
    /// instantly instead of re-listing + re-downloading from GCS.
    /// The file-sync data channel keeps the on-disk workspace up to date,
    /// so a full re-download is unnecessary.
    static ref DOWNLOADED_SLUGS: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

// Helper function to send progress updates
async fn send_progress_update(
    progress_tx: &mut Option<mpsc::UnboundedSender<String>>,
    message: &str,
) {
    if let Some(tx) = progress_tx {
        let progress_msg = format!("📊 {}", message);
        if let Err(e) = tx.send(progress_msg) {
            eprintln!("Failed to send progress update: {}", e);
        }
    }
}

fn env_value(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn gcs_bucket_name() -> String {
    env_value(&["SYNTHI_GCS_BUCKET", "GCS_BUCKET_NAME"])
        .unwrap_or_else(|| "synthi-cloud-storage".to_string())
}

fn gcs_credentials_json() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(raw_json) = env_value(&[
        "SYNTHI_GCS_SERVICE_ACCOUNT_JSON",
        "GCS_SERVICE_ACCOUNT_JSON",
    ]) {
        validate_credentials_json(&raw_json)?;
        return Ok(raw_json);
    }

    if let Some(path) = env_value(&[
        "SYNTHI_GCS_SERVICE_ACCOUNT_JSON_FILE",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ]) {
        let raw_json = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read GCS credentials file {}: {}", path, e))?;
        validate_credentials_json(&raw_json)?;
        return Ok(raw_json);
    }

    let client_email = env_value(&["SYNTHI_GCS_CLIENT_EMAIL", "GCS_CLIENT_EMAIL"]);
    let private_key = env_value(&["SYNTHI_GCS_PRIVATE_KEY", "GCS_PRIVATE_KEY"]);
    if let (Some(client_email), Some(private_key)) = (client_email, private_key) {
        let private_key = private_key.replace("\\n", "\n");
        let credentials_json = json!({
            "type": "service_account",
            "client_email": client_email,
            "private_key": private_key,
        })
        .to_string();
        validate_credentials_json(&credentials_json)?;
        return Ok(credentials_json);
    }

    Err("GCS credentials missing; set SYNTHI_GCS_SERVICE_ACCOUNT_JSON, SYNTHI_GCS_SERVICE_ACCOUNT_JSON_FILE, or SYNTHI_GCS_CLIENT_EMAIL plus SYNTHI_GCS_PRIVATE_KEY".into())
}

fn validate_credentials_json(
    raw_json: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let value: serde_json::Value = serde_json::from_str(raw_json)
        .map_err(|e| format!("GCS credentials JSON invalid: {}", e))?;
    if value
        .get("private_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Err("GCS credentials JSON missing private_key".into());
    }
    if value
        .get("client_email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Err("GCS credentials JSON missing client_email".into());
    }
    Ok(())
}

fn gcs_store() -> Result<Arc<dyn ObjectStore>, Box<dyn std::error::Error + Send + Sync>> {
    std::env::remove_var("GCLOUD_PROJECT");
    std::env::remove_var("CLOUDSDK_CORE_PROJECT");

    let credentials_json = gcs_credentials_json()?;
    let mut builder = GoogleCloudStorageBuilder::new();
    builder = builder.with_bucket_name(&gcs_bucket_name());
    builder = builder.with_config(GoogleConfigKey::ServiceAccountKey, &credentials_json);
    let store_impl = builder
        .build()
        .map_err(|e| format!("Failed to build GCS store: {}", e))?;
    Ok(Arc::new(store_impl))
}

pub async fn download(
    slug: &str,
    mut progress_tx: Option<mpsc::UnboundedSender<String>>,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    // Local directory for downloads - Write to /synthi/
    // We *update in place* so that build artifacts (node_modules, android/app/build, etc.)
    // can persist between runs for much faster subsequent builds.
    let local_dir = PathBuf::from("/synthi").join(slug);
    let skip_if_present = std::env::var("SYNTHI_STORAGE_SKIP_DOWNLOAD_IF_PRESENT")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "1" | "true" | "yes" | "y" | "on")
        })
        .unwrap_or(false);
    if skip_if_present && local_dir.exists() {
        println!(
            "Directory already exists: {}, skipping download (SYNTHI_STORAGE_SKIP_DOWNLOAD_IF_PRESENT=1)",
            local_dir.display()
        );
        return Ok(local_dir);
    }

    // ── Session-level cache ──────────────────────────────────────
    // After the first successful download for a slug, subsequent
    // calls return immediately.  The file-sync data channel keeps
    // the on-disk workspace in sync with the browser editor, so
    // re-downloading from GCS is unnecessary.
    {
        let cache = DOWNLOADED_SLUGS.lock().unwrap();
        if cache.contains(slug) && local_dir.exists() {
            println!(
                "[STORAGE] Slug '{}' already downloaded this session, skipping GCS sync",
                slug
            );
            return Ok(local_dir);
        }
    }

    let store = gcs_store()?;

    // List objects with workspaces/slug prefix
    let prefix = Path::from(format!("workspaces/{}/", slug.trim_matches('/')));

    let mut list_stream = store.list(Some(&prefix));
    let mut objects: Vec<Path> = Vec::new();
    while let Some(meta_res) = list_stream.next().await {
        let meta = meta_res?;
        let location_str = meta.location.as_ref();

        // Skip if doesn't match prefix
        if !location_str.starts_with(prefix.as_ref()) {
            continue;
        }

        let stripped = location_str.strip_prefix(prefix.as_ref()).unwrap();

        // Skip empty paths (top-level directory marker)
        if stripped.is_empty() {
            println!("skipped top-level directory marker: {}", location_str);
            continue;
        }

        // Skip directory markers (paths ending with '/')
        if location_str.ends_with('/') {
            println!("skipped directory marker: {}", location_str);
            continue;
        }

        // Additional check: skip objects with size 0 that look like directories
        if meta.size == 0 && stripped.contains('/') && !stripped.contains('.') {
            continue;
        }

        objects.push(meta.location.clone());
    }

    if objects.is_empty() {
        return Err("No objects found in the specified folder".into());
    }

    // Create the directory structure
    if !local_dir.exists() {
        fs::create_dir_all(&local_dir).map_err(|e| {
            eprintln!("   Path: {}", local_dir.display());
            eprintln!("   Error: {}", e);
            eprintln!("   Current working dir: {:?}", std::env::current_dir());
            format!("Failed to create directory {}: {}", local_dir.display(), e)
        })?;
        println!("Created local directory: {}", local_dir.display());
    } else {
        println!(
            "Directory already exists: {} (updating in place)",
            local_dir.display()
        );
    }

    // Maintain a manifest of previously downloaded paths so we can prune removed upstream files
    // without deleting build artifacts that are not part of the download (e.g. node_modules).
    let manifest_path = local_dir.join(".synthi_download_manifest.json");
    let prev_manifest: Vec<String> = if manifest_path.exists() {
        match fs::read_to_string(&manifest_path) {
            Ok(s) => serde_json::from_str::<Vec<String>>(&s).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    // Build the next manifest (relative paths) from remote object listing.
    let mut next_manifest: Vec<String> = Vec::with_capacity(objects.len());
    for object_path in objects.iter() {
        let object_name: &str = object_path.as_ref();
        let stripped = object_name
            .strip_prefix(prefix.as_ref())
            .ok_or_else(|| format!("Failed to strip prefix from: {}", object_name))?;
        let stripped_clean = stripped.trim_start_matches('/');
        next_manifest.push(stripped_clean.to_string());
    }

    // Prune files that were previously downloaded but are no longer present upstream.
    // This only touches paths from the manifest, so build artifacts remain intact.
    if !prev_manifest.is_empty() {
        let next_set: std::collections::HashSet<&str> =
            next_manifest.iter().map(|s| s.as_str()).collect();
        for old_rel in prev_manifest.iter() {
            if next_set.contains(old_rel.as_str()) {
                continue;
            }
            let old_path = local_dir.join(old_rel);
            if old_path.is_file() {
                let _ = fs::remove_file(&old_path);
                // Best-effort cleanup of empty parent dirs up to local_dir.
                let mut cur = old_path.parent();
                while let Some(p) = cur {
                    if p == local_dir {
                        break;
                    }
                    let is_empty = fs::read_dir(p)
                        .map(|mut it| it.next().is_none())
                        .unwrap_or(false);
                    if is_empty {
                        let _ = fs::remove_dir(p);
                        cur = p.parent();
                    } else {
                        break;
                    }
                }
            }
        }
    }

    // Download each object (overwriting existing files).
    for (index, object_path) in objects.iter().enumerate() {
        let object_name: &str = object_path.as_ref();
        println!("📥 Downloading object: {}", object_name);

        send_progress_update(
            &mut progress_tx,
            &format!("Downloading ({}/{})", index + 1, objects.len()),
        )
        .await;

        // Construct the local file path (strip workspaces/slug prefix)
        let stripped = object_name
            .strip_prefix(prefix.as_ref())
            .ok_or_else(|| format!("Failed to strip prefix from: {}", object_name))?;

        // Additional safety: remove any leading slashes from stripped path
        let stripped_clean = stripped.trim_start_matches('/');

        println!("🔧 Processing: {} -> {}", object_name, stripped_clean);
        let local_path = local_dir.join(stripped_clean);
        let parent_dir = local_path.parent().ok_or("Invalid path")?;

        // Create parent directories if they don't exist
        if !parent_dir.exists() {
            fs::create_dir_all(parent_dir).map_err(|e| {
                format!("Failed to create directory {}: {}", parent_dir.display(), e)
            })?;
            println!("Created directory: {}", parent_dir.display());
        }

        // Download the full object into memory then write to disk
        let get_result = store
            .get(object_path)
            .await
            .map_err(|e| format!("Failed to download {}: {}", object_name, e))?;
        let data = get_result
            .bytes()
            .await
            .map_err(|e| format!("Failed to read bytes from {}: {}", object_name, e))?;

        let mut file = fs::File::create(&local_path)
            .map_err(|e| format!("Failed to create file {}: {}", local_path.display(), e))?;
        file.write_all(&data)
            .map_err(|e| format!("Failed to write to file {}: {}", local_path.display(), e))?;

        println!("Saved to: {}", local_path.display());
    }

    // Write updated manifest.
    if let Ok(s) = serde_json::to_string_pretty(&next_manifest) {
        let _ = fs::write(&manifest_path, s);
    }

    // Mark this slug as downloaded for the session so subsequent
    // LSP channels skip the expensive GCS listing + download.
    {
        let mut cache = DOWNLOADED_SLUGS.lock().unwrap();
        cache.insert(slug.to_string());
    }

    // Return the local directory path so the caller can navigate to it
    Ok(local_dir)
}

pub async fn upload_directory(
    local_path: &PathBuf,
    slug: &str,
    sub_path: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!(
        "📤 Uploading directory: {} -> workspaces/{}/{}",
        local_path.display(),
        slug,
        sub_path
    );

    let store = gcs_store()?;

    // Recursively walk directory and upload
    let mut stack = vec![local_path.clone()];
    while let Some(current_dir) = stack.pop() {
        let entries = fs::read_dir(&current_dir)
            .map_err(|e| format!("Failed to read directory {}: {}", current_dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
            } else {
                // Calculate relative path from local_path
                let rel_path = path
                    .strip_prefix(local_path)
                    .map_err(|e| format!("Failed to strip prefix: {}", e))?;

                // Construct remote path: workspaces/{slug}/{sub_path}/{rel_path}
                // ensuring forward slashes
                let rel_str = rel_path.to_string_lossy().replace('\\', "/");
                let sub_str = sub_path.trim_matches('/').replace('\\', "/");

                let remote_key = if sub_str.is_empty() {
                    format!("workspaces/{}/{}", slug, rel_str)
                } else {
                    format!("workspaces/{}/{}/{}", slug, sub_str, rel_str)
                };

                println!("   Uploading: {} -> {}", rel_str, remote_key);

                // Read file content
                let content = fs::read(&path)
                    .map_err(|e| format!("Failed to read file {}: {}", path.display(), e))?;

                // Put object
                store
                    .put(&Path::from(remote_key), content.into())
                    .await
                    .map_err(|e| format!("Failed to upload file {}: {}", path.display(), e))?;
            }
        }
    }

    Ok(())
}
