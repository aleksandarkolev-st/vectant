use anyhow::{bail, Result};
use std::path::PathBuf;

/// Searches up from start_path to find the nearest directory containing
/// a package.json with react-native as a dependency.
/// Will not search above workspace_root.
pub async fn find_react_native_project_root(
    start_path: &PathBuf,
    workspace_root: &PathBuf,
) -> Result<PathBuf> {
    let mut current = start_path.clone();

    // If start_path is a file, get its parent directory
    if current.is_file() {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }

    loop {
        let package_json = current.join("package.json");
        if package_json.exists() {
            // Read and check for react-native dependency
            if let Ok(content) = tokio::fs::read_to_string(&package_json).await {
                if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                    let has_rn = pkg
                        .get("dependencies")
                        .and_then(|d| d.get("react-native"))
                        .is_some()
                        || pkg
                            .get("devDependencies")
                            .and_then(|d| d.get("react-native"))
                            .is_some();

                    if has_rn {
                        return Ok(current);
                    }
                }
            }
        }

        // Don't search above workspace root
        if current == *workspace_root || current.parent().is_none() {
            break;
        }

        // Move up one directory
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    bail!(
        "No React Native project found. Searched from {} up to {}",
        start_path.display(),
        workspace_root.display()
    )
}
