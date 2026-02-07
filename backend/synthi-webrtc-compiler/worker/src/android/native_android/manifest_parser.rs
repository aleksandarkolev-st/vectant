// ============================================================
// ANDROID MANIFEST PARSER
// ============================================================
// Parses AndroidManifest.xml to extract package name, activities,
// intent filters, permissions, and launcher activity information.
// ============================================================

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

// ============================================================
// TYPES
// ============================================================

/// Parsed information from AndroidManifest.xml
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AndroidManifestInfo {
    /// Package name (e.g., "com.example.app")
    pub package: Option<String>,

    /// Application label/name
    pub app_label: Option<String>,

    /// Application icon resource
    pub app_icon: Option<String>,

    /// Application theme
    pub app_theme: Option<String>,

    /// Whether the app is debuggable
    pub debuggable: bool,

    /// Minimum SDK version
    pub min_sdk_version: Option<u32>,

    /// Target SDK version
    pub target_sdk_version: Option<u32>,

    /// Version code
    pub version_code: Option<u32>,

    /// Version name
    pub version_name: Option<String>,

    /// List of activities defined in the manifest
    pub activities: Vec<ActivityInfo>,

    /// Launcher activity (main entry point)
    pub launcher_activity: Option<ActivityInfo>,

    /// List of requested permissions
    pub permissions: Vec<String>,

    /// List of registered services
    pub services: Vec<String>,

    /// List of registered receivers
    pub receivers: Vec<String>,

    /// List of registered providers
    pub providers: Vec<String>,
}

/// Information about an activity
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActivityInfo {
    /// Activity class name (e.g., ".MainActivity" or "com.example.MainActivity")
    pub name: String,

    /// Fully qualified activity name
    pub fully_qualified_name: Option<String>,

    /// Activity label
    pub label: Option<String>,

    /// Whether the activity is exported
    pub exported: bool,

    /// Screen orientation
    pub screen_orientation: Option<String>,

    /// Launch mode
    pub launch_mode: Option<String>,

    /// Intent filters for this activity
    pub intent_filters: Vec<IntentFilterInfo>,

    /// Whether this is the launcher activity
    pub is_launcher: bool,
}

/// Information about an intent filter
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntentFilterInfo {
    /// Actions (e.g., "android.intent.action.MAIN")
    pub actions: Vec<String>,

    /// Categories (e.g., "android.intent.category.LAUNCHER")
    pub categories: Vec<String>,

    /// Data schemes (e.g., "https")
    pub data_schemes: Vec<String>,

    /// Data hosts
    pub data_hosts: Vec<String>,
}

// ============================================================
// PARSING LOGIC
// ============================================================

/// Parses an AndroidManifest.xml file
pub async fn parse_android_manifest(manifest_path: &Path) -> Result<AndroidManifestInfo> {
    if !manifest_path.exists() {
        bail!("AndroidManifest.xml not found: {:?}", manifest_path);
    }

    let content = fs::read_to_string(manifest_path)
        .await
        .context("Failed to read AndroidManifest.xml")?;

    parse_manifest_content(&content)
}

/// Parses AndroidManifest content from a string
pub fn parse_manifest_content(content: &str) -> Result<AndroidManifestInfo> {
    let mut info = AndroidManifestInfo::default();

    // Extract package from manifest tag
    if let Some(package) = extract_attribute(content, "manifest", "package") {
        info.package = Some(package);
    }

    // Extract version info
    info.version_code = extract_attribute(content, "manifest", "android:versionCode")
        .and_then(|v| v.parse().ok());
    info.version_name = extract_attribute(content, "manifest", "android:versionName");

    // Extract uses-sdk attributes
    info.min_sdk_version = extract_attribute(content, "uses-sdk", "android:minSdkVersion")
        .and_then(|v| v.parse().ok());
    info.target_sdk_version = extract_attribute(content, "uses-sdk", "android:targetSdkVersion")
        .and_then(|v| v.parse().ok());

    // Extract application attributes
    info.app_label = extract_attribute(content, "application", "android:label");
    info.app_icon = extract_attribute(content, "application", "android:icon");
    info.app_theme = extract_attribute(content, "application", "android:theme");
    info.debuggable = extract_attribute(content, "application", "android:debuggable")
        .map(|v| v == "true")
        .unwrap_or(false);

    // Parse activities
    info.activities = parse_activities(content, info.package.as_deref());

    // Find launcher activity
    info.launcher_activity = info
        .activities
        .iter()
        .find(|a| a.is_launcher)
        .cloned();

    // Parse permissions
    info.permissions = parse_uses_permissions(content);

    // Parse services
    info.services = parse_components(content, "service");

    // Parse receivers
    info.receivers = parse_components(content, "receiver");

    // Parse providers
    info.providers = parse_components(content, "provider");

    Ok(info)
}

/// Extracts activities from the manifest
fn parse_activities(content: &str, package: Option<&str>) -> Vec<ActivityInfo> {
    let mut activities = Vec::new();

    // Find all activity blocks
    let mut pos = 0;
    while let Some(start) = content[pos..].find("<activity") {
        let abs_start = pos + start;
        
        // Find the end of this activity block
        let block_end = find_closing_tag(&content[abs_start..], "activity")
            .map(|e| abs_start + e)
            .unwrap_or(content.len());

        let activity_block = &content[abs_start..block_end];
        
        if let Some(activity) = parse_single_activity(activity_block, package) {
            activities.push(activity);
        }

        pos = block_end;
    }

    activities
}

/// Parses a single activity block
fn parse_single_activity(block: &str, package: Option<&str>) -> Option<ActivityInfo> {
    let name = extract_attribute(block, "activity", "android:name")?;

    let fully_qualified = if name.starts_with('.') {
        package.map(|p| format!("{}{}", p, name))
    } else if name.contains('.') {
        Some(name.clone())
    } else {
        package.map(|p| format!("{}.{}", p, name))
    };

    let exported = extract_attribute(block, "activity", "android:exported")
        .map(|v| v == "true")
        .unwrap_or(false);

    let intent_filters = parse_intent_filters(block);
    let is_launcher = intent_filters.iter().any(|f| {
        f.actions.contains(&"android.intent.action.MAIN".to_string())
            && f.categories.contains(&"android.intent.category.LAUNCHER".to_string())
    });

    Some(ActivityInfo {
        name,
        fully_qualified_name: fully_qualified,
        label: extract_attribute(block, "activity", "android:label"),
        exported,
        screen_orientation: extract_attribute(block, "activity", "android:screenOrientation"),
        launch_mode: extract_attribute(block, "activity", "android:launchMode"),
        intent_filters,
        is_launcher,
    })
}

/// Parses intent filters from a block
fn parse_intent_filters(block: &str) -> Vec<IntentFilterInfo> {
    let mut filters = Vec::new();

    let mut pos = 0;
    while let Some(start) = block[pos..].find("<intent-filter") {
        let abs_start = pos + start;
        
        let block_end = find_closing_tag(&block[abs_start..], "intent-filter")
            .map(|e| abs_start + e)
            .unwrap_or(block.len());

        let filter_block = &block[abs_start..block_end];

        let actions = extract_all_attributes(filter_block, "action", "android:name");
        let categories = extract_all_attributes(filter_block, "category", "android:name");
        let data_schemes = extract_all_attributes(filter_block, "data", "android:scheme");
        let data_hosts = extract_all_attributes(filter_block, "data", "android:host");

        filters.push(IntentFilterInfo {
            actions,
            categories,
            data_schemes,
            data_hosts,
        });

        pos = block_end;
    }

    filters
}

/// Parses uses-permission elements
fn parse_uses_permissions(content: &str) -> Vec<String> {
    extract_all_attributes(content, "uses-permission", "android:name")
}

/// Parses component names (services, receivers, providers)
fn parse_components(content: &str, component_type: &str) -> Vec<String> {
    extract_all_attributes(content, component_type, "android:name")
}

// ============================================================
// XML HELPER FUNCTIONS
// ============================================================

/// Extracts a single attribute value from an XML tag
fn extract_attribute(content: &str, tag: &str, attr: &str) -> Option<String> {
    // Find the tag
    let tag_pattern = format!("<{}", tag);
    let tag_start = content.find(&tag_pattern)?;
    
    // Find the end of the opening tag (could be > or />)
    let tag_content = &content[tag_start..];
    let tag_end = tag_content.find('>')?.min(
        tag_content.find("/>").unwrap_or(usize::MAX)
    );
    let tag_str = &tag_content[..tag_end];

    // Find the attribute
    let attr_pattern = format!("{}=", attr);
    let attr_start = tag_str.find(&attr_pattern)?;
    let value_start = &tag_str[attr_start + attr_pattern.len()..];

    // Extract quoted value
    let quote = value_start.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &value_start[1..];
    let end = rest.find(quote)?;
    
    Some(rest[..end].to_string())
}

/// Extracts all occurrences of an attribute from matching tags
fn extract_all_attributes(content: &str, tag: &str, attr: &str) -> Vec<String> {
    let mut values = Vec::new();
    let tag_pattern = format!("<{}", tag);
    let attr_pattern = format!("{}=", attr);

    let mut pos = 0;
    while let Some(start) = content[pos..].find(&tag_pattern) {
        let abs_start = pos + start;
        let tag_content = &content[abs_start..];
        
        // Find end of tag
        if let Some(tag_end) = tag_content.find('>') {
            let tag_str = &tag_content[..tag_end];
            
            // Find attribute
            if let Some(attr_start) = tag_str.find(&attr_pattern) {
                let value_start = &tag_str[attr_start + attr_pattern.len()..];
                let quote = value_start.chars().next().unwrap_or(' ');
                if quote == '"' || quote == '\'' {
                    let rest = &value_start[1..];
                    if let Some(end) = rest.find(quote) {
                        values.push(rest[..end].to_string());
                    }
                }
            }
            
            pos = abs_start + tag_end + 1;
        } else {
            break;
        }
    }

    values
}

/// Finds the closing tag for an XML element
fn find_closing_tag(content: &str, tag: &str) -> Option<usize> {
    let closing = format!("</{}>", tag);
    let self_closing = "/>";

    // Check if it's self-closing
    let first_gt = content.find('>')?;
    if content[..first_gt].ends_with('/') {
        return Some(first_gt + 1);
    }

    // Find closing tag
    content.find(&closing).map(|p| p + closing.len())
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/// Gets the fully qualified launcher activity name
pub fn get_launcher_component(manifest: &AndroidManifestInfo) -> Option<String> {
    let launcher = manifest.launcher_activity.as_ref()?;
    let package = manifest.package.as_ref()?;
    
    let activity_name = launcher.fully_qualified_name.as_ref()
        .unwrap_or(&launcher.name);
    
    // If activity starts with '.', prepend package
    if activity_name.starts_with('.') {
        Some(format!("{}/{}", package, activity_name))
    } else if activity_name.contains('.') {
        Some(format!("{}/{}", package, activity_name))
    } else {
        Some(format!("{}/.{}", package, activity_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MANIFEST: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.myapp"
    android:versionCode="1"
    android:versionName="1.0">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
    
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/AppTheme"
        android:debuggable="true">
        
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:label="@string/app_name"
            android:launchMode="singleTop">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        
        <activity
            android:name=".SecondActivity"
            android:exported="false" />
            
        <service android:name=".MyService" />
        
    </application>
</manifest>"#;

    #[test]
    fn test_parse_manifest() {
        let info = parse_manifest_content(SAMPLE_MANIFEST).unwrap();
        
        assert_eq!(info.package, Some("com.example.myapp".to_string()));
        assert_eq!(info.version_code, Some(1));
        assert_eq!(info.version_name, Some("1.0".to_string()));
        assert_eq!(info.min_sdk_version, Some(21));
        assert_eq!(info.target_sdk_version, Some(34));
        assert!(info.debuggable);
    }

    #[test]
    fn test_parse_activities() {
        let info = parse_manifest_content(SAMPLE_MANIFEST).unwrap();
        
        assert_eq!(info.activities.len(), 2);
        
        let main = info.launcher_activity.as_ref().unwrap();
        assert_eq!(main.name, ".MainActivity");
        assert!(main.is_launcher);
        assert!(main.exported);
    }

    #[test]
    fn test_parse_permissions() {
        let info = parse_manifest_content(SAMPLE_MANIFEST).unwrap();
        
        assert!(info.permissions.contains(&"android.permission.INTERNET".to_string()));
        assert!(info.permissions.contains(&"android.permission.CAMERA".to_string()));
    }

    #[test]
    fn test_get_launcher_component() {
        let info = parse_manifest_content(SAMPLE_MANIFEST).unwrap();
        let component = get_launcher_component(&info).unwrap();
        
        assert!(component.contains("com.example.myapp"));
        assert!(component.contains("MainActivity"));
    }
}
