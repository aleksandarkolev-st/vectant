// ============================================================
// FLUTTER ANDROID SCAFFOLD GENERATOR
// ============================================================
// Auto-generates the Android folder structure for Flutter projects
// that are missing it or have outdated v1 embedding.
// ============================================================

use anyhow::{Context, Result};
use regex::Regex;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Minimum Gradle version required (supports Java 21)
const MIN_GRADLE_VERSION: &str = "8.5";

/// Normalize line endings to Unix-style LF.
/// This is CRITICAL because shell scripts and Gradle files break with CRLF.
fn normalize_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace("\r", "\n")
}

// ============================================================
// 1. THE ARCHITECTURAL SCHEMA: DIAGNOSTIC & REMEDIATION
// ============================================================

#[derive(Debug, Clone, PartialEq)]
pub enum MaintenanceAction {
    /// Full scaffold generation (when android/ is missing)
    ScaffoldAndroidDir,
    /// Update AndroidManifest.xml to use v2 embedding
    UpdateManifestEmbedding,
    /// Update settings.gradle to use pluginManagement
    UpdateSettingsGradle,
    /// Upgrade gradle-wrapper.properties to specific version
    UpgradeGradleWrapper(String),
    /// Add org.gradle.caching=true to gradle.properties
    EnableGradleCaching,
    /// Fix buggy JVM opts in gradlew script
    FixGradlewExecution,
    /// Generate missing app icon
    GenerateIcon,
    /// Generate missing local.properties (helper for build)
    GenerateLocalProperties,
}

#[derive(Debug)]
pub struct DiagnosticReport {
    pub actions: Vec<MaintenanceAction>,
}

/// Convenience wrapper: Checks if any maintenance actions are needed.
pub async fn needs_android_scaffold(project_root: &Path) -> bool {
    let report = diagnose_android_scaffold(project_root).await;
    !report.actions.is_empty()
}

// ============================================================
// 2. DIAGNOSTIC ENGINE (PASSIVE INSPECTION)
// ============================================================

/// Diagnoses the state of the Android scaffold and returns a report of needed actions.
pub async fn diagnose_android_scaffold(project_root: &Path) -> DiagnosticReport {
    let mut actions = Vec::new();
    let android_dir = project_root.join("android");

    // Check if android folder exists
    if !android_dir.exists() {
        actions.push(MaintenanceAction::ScaffoldAndroidDir);
        // If the whole dir is missing, we don't need to check children
        return DiagnosticReport { actions };
    }

    // Check local.properties (often missing in git repos, needed for build)
    if !android_dir.join("local.properties").exists() {
        actions.push(MaintenanceAction::GenerateLocalProperties);
    }

    // Check for v2 embedding in AndroidManifest.xml
    let manifest_path = android_dir.join("app/src/main/AndroidManifest.xml");
    if let Ok(content) = fs::read_to_string(&manifest_path).await {
        // v1 embedding or missing embedding metadata
        if !content.contains("flutterEmbedding") || content.contains("android:value=\"1\"") {
            actions.push(MaintenanceAction::UpdateManifestEmbedding);
        }
    } else {
        // Only trigger update if file exists but is unreadable/empty,
        // otherwise if it's missing, it implies a deeper issue, but we might treat it as "Scaffold"
        // in a more granular system. For now, let's assume if manifest is missing,
        // the user might benefit from full scaffold or we skip.
        // But since we didn't trigger ScaffoldAndroidDir (folder exists), let's assume we can try to patch/regen manifest.
        actions.push(MaintenanceAction::UpdateManifestEmbedding);
    }

    // Check for new-style settings.gradle with plugin management
    let settings_path = android_dir.join("settings.gradle");
    if let Ok(content) = fs::read_to_string(&settings_path).await {
        if !content.contains("pluginManagement") {
            actions.push(MaintenanceAction::UpdateSettingsGradle);
        }
    } else {
        actions.push(MaintenanceAction::UpdateSettingsGradle);
    }

    // Check Gradle version compatibility (must be >= 8.5 for Java 21)
    let wrapper_path = android_dir.join("gradle/wrapper/gradle-wrapper.properties");
    if let Ok(content) = fs::read_to_string(&wrapper_path).await {
        if let Some(version) = extract_gradle_version(&content) {
            if !is_gradle_version_sufficient(&version, MIN_GRADLE_VERSION) {
                actions.push(MaintenanceAction::UpgradeGradleWrapper(MIN_GRADLE_VERSION.to_string()));
            }
        } else {
            // Can't parse version or invalid file
            actions.push(MaintenanceAction::UpgradeGradleWrapper(MIN_GRADLE_VERSION.to_string()));
        }
    } else {
        actions.push(MaintenanceAction::UpgradeGradleWrapper(MIN_GRADLE_VERSION.to_string()));
    }

    // Check if gradle.properties has caching enabled
    let props_path = android_dir.join("gradle.properties");
    if let Ok(content) = fs::read_to_string(&props_path).await {
        if !content.contains("org.gradle.caching=true") {
            actions.push(MaintenanceAction::EnableGradleCaching);
        }
    } else {
        actions.push(MaintenanceAction::EnableGradleCaching);
    }

    // Check for broken gradlew script (buggy JVM opts quoting)
    let gradlew_path = android_dir.join("gradlew");
    if let Ok(content) = fs::read_to_string(&gradlew_path).await {
        if !content.contains("DEFAULT_JVM_OPTS=\"-Xmx64m -Xms64m\"") {
            actions.push(MaintenanceAction::FixGradlewExecution);
        }
    } else {
        actions.push(MaintenanceAction::FixGradlewExecution);
    }

    // Check for existence of an app icon (drawable or mipmap)
    let icon_drawable = android_dir.join("app/src/main/res/drawable/ic_launcher.xml");
    let icon_mipmap = android_dir.join("app/src/main/res/mipmap-hdpi/ic_launcher.png");
    if !icon_drawable.exists() && !icon_mipmap.exists() {
        actions.push(MaintenanceAction::GenerateIcon);
    }

    DiagnosticReport { actions }
}

/// Extract Gradle version from wrapper properties content
fn extract_gradle_version(content: &str) -> Option<String> {
    for line in content.lines() {
        if line.starts_with("distributionUrl") {
            if let Some(start) = line.find("gradle-") {
                let after_prefix = &line[start + 7..];
                if let Some(end) = after_prefix.find('-') {
                    return Some(after_prefix[..end].to_string());
                }
            }
        }
    }
    None
}

/// Check if gradle_version >= min_version
fn is_gradle_version_sufficient(gradle_version: &str, min_version: &str) -> bool {
    let parse_version = |v: &str| -> (u32, u32, u32) {
        let parts: Vec<&str> = v.split('.').collect();
        let major = parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    };
    
    let current = parse_version(gradle_version);
    let required = parse_version(min_version);
    
    current >= required
}

// ============================================================
// 3. MAIN EXECUTION & ATOMIC REMEDIATION HANDLERS
// ============================================================

/// Generates or repairs the Android scaffold based on diagnostic actions.
pub async fn generate_android_scaffold(
    project_root: &Path,
    app_id: &str,
    project_name: &str,
    flutter_sdk_path: Option<&str>,
) -> Result<()> {
    let report = diagnose_android_scaffold(project_root).await;

    if report.actions.is_empty() {
        return Ok(());
    }

    eprintln!("[android_scaffold] Applying fixes: {:?}", report.actions);

    let android_dir = project_root.join("android");

    for action in report.actions {
        match action {
            MaintenanceAction::ScaffoldAndroidDir => {
                apply_full_scaffold(project_root, app_id, project_name, flutter_sdk_path).await?;
                // Since this regenerates everything, we can break early or continue.
                // Depending on implementation, Scaffold might miss things if not comprehensive.
                // But our full scaffold should be comprehensive.
                break; 
            }
            MaintenanceAction::UpdateManifestEmbedding => {
                apply_patch_manifest(&android_dir, app_id, project_name).await?;
            }
            MaintenanceAction::UpdateSettingsGradle => {
                apply_patch_settings_gradle(&android_dir).await?;
            }
            MaintenanceAction::UpgradeGradleWrapper(version) => {
                apply_upgrade_gradle_wrapper(&android_dir, &version).await?;
            }
            MaintenanceAction::EnableGradleCaching => {
                apply_enable_gradle_caching(&android_dir).await?;
            }
            MaintenanceAction::FixGradlewExecution => {
                apply_fix_gradlew(&android_dir).await?;
            }
            MaintenanceAction::GenerateIcon => {
                generate_ic_launcher(&android_dir).await?;
            }
            MaintenanceAction::GenerateLocalProperties => {
                generate_local_properties(&android_dir, flutter_sdk_path).await?;
            }
        }
    }

    Ok(())
}

// --- ATOMIC REMEDIATION IMPLEMENTATIONS ---

async fn apply_full_scaffold(
    project_root: &Path, 
    app_id: &str, 
    project_name: &str, 
    flutter_sdk_path: Option<&str>
) -> Result<()> {
    // This uses the "generators" to create the full structure from scratch
    // Note: We REMOVED the fs::remove_dir_all call.
    
    let android_dir = project_root.join("android");
    
    // Create directory structure
    fs::create_dir_all(android_dir.join("app/src/main/java")).await?;
    fs::create_dir_all(android_dir.join("app/src/main/res/drawable")).await?;
    fs::create_dir_all(android_dir.join("app/src/main/res/drawable-v21")).await?;
    fs::create_dir_all(android_dir.join("app/src/main/res/values")).await?;
    fs::create_dir_all(android_dir.join("app/src/main/res/values-night")).await?;
    fs::create_dir_all(android_dir.join("app/src/debug")).await?;
    fs::create_dir_all(android_dir.join("app/src/profile")).await?;
    fs::create_dir_all(android_dir.join("gradle/wrapper")).await?;
    
    let java_package_path = app_id.replace('.', "/");
    let main_activity_dir = android_dir.join(format!("app/src/main/java/{}", java_package_path));
    fs::create_dir_all(&main_activity_dir).await?;
    
    // Call generators
    generate_settings_gradle(&android_dir).await?;
    generate_root_build_gradle(&android_dir).await?;
    generate_app_build_gradle(&android_dir, app_id).await?;
    generate_gradle_properties(&android_dir).await?;
    generate_local_properties(&android_dir, flutter_sdk_path).await?;
    generate_gradle_wrapper(&android_dir).await?;
    generate_gradlew(&android_dir).await?;
    generate_main_activity(&main_activity_dir, app_id).await?;
    generate_android_manifest(&android_dir, app_id, project_name).await?;
    generate_debug_manifest(&android_dir, app_id).await?;
    generate_profile_manifest(&android_dir, app_id).await?;
    generate_styles(&android_dir, project_name).await?;
    generate_launch_background(&android_dir).await?;
    generate_ic_launcher(&android_dir).await?;
    
    if let Some(sdk) = flutter_sdk_path {
        copy_gradle_wrapper_jar(&android_dir, sdk).await?;
    }

    Ok(())
}

async fn apply_patch_manifest(android_dir: &Path, app_id: &str, project_name: &str) -> Result<()> {
    let manifest_path = android_dir.join("app/src/main/AndroidManifest.xml");
    
    // Fallback: if manifest doesn't exist, generate it
    if !manifest_path.exists() {
        return generate_android_manifest(android_dir, app_id, project_name).await;
    }

    let content = fs::read_to_string(&manifest_path).await?;
    let mut new_content = content.clone();

    // Strategy: Regex based patching
    // 1. Check if flutterEmbedding exists
    if new_content.contains("flutterEmbedding") {
        // Update value to 2
        let re = Regex::new(r#"(<meta-data[^>]*android:name="flutterEmbedding"[^>]*android:value=")[^"]*(")"#)?;
        new_content = re.replace(&new_content, "${1}2${2}").to_string();
    } else {
        // Prepare tag to insert
        let embedding_tag = r#"
            <meta-data
              android:name="flutterEmbedding"
              android:value="2" />"#;
        
        // Find <application> tag start
        // We look for the closing bracket > of <application ... >
        let re_app = Regex::new(r"(<application[^>]*>)")?;
        if re_app.is_match(&new_content) {
             new_content = re_app.replace(&new_content, format!("$1{}", embedding_tag).as_str()).to_string();
        } else {
             // Malformed XML or no application tag? Backup and regen.
             backup_and_regenerate(&manifest_path, || {
                 generate_android_manifest(android_dir, app_id, project_name)
             }).await?;
             return Ok(());
        }
    }
    
    if new_content != content {
        fs::write(&manifest_path, new_content).await?;
    }
    Ok(())
}

async fn apply_patch_settings_gradle(android_dir: &Path) -> Result<()> {
    let settings_path = android_dir.join("settings.gradle");
    // Since implementing a regex patch for settings.gradle structure is complex (mix of GroovyDSL),
    // and maintaining the old structure isn't worth it if it's missing pluginManagement,
    // we backup and regenerate.
    backup_and_regenerate(&settings_path, || {
        generate_settings_gradle(android_dir)
    }).await
}

async fn apply_upgrade_gradle_wrapper(android_dir: &Path, version: &str) -> Result<()> {
    let wrapper_path = android_dir.join("gradle/wrapper/gradle-wrapper.properties");
    if !wrapper_path.exists() {
        return generate_gradle_wrapper(android_dir).await;
    }
    
    let content = fs::read_to_string(&wrapper_path).await?;
    // Replace distributionUrl=...
    // Pattern: distributionUrl=https\://services.gradle.org/distributions/gradle-X.Y.Z-all.zip
    let re = Regex::new(r"(distributionUrl=.*gradle-)([\d\.]+)(-.*zip)")?;
    // We expect version to include minor/patch if needed? MIN_GRADLE_VERSION is "8.5"
    let new_content = re.replace(&content, format!("${{1}}{}${{3}}", version).as_str()).to_string();
    
    if new_content != content {
        fs::write(&wrapper_path, new_content).await?;
    }
    Ok(())
}

async fn apply_enable_gradle_caching(android_dir: &Path) -> Result<()> {
    let props_path = android_dir.join("gradle.properties");
    if !props_path.exists() {
        return generate_gradle_properties(android_dir).await;
    }
    
    let content = fs::read_to_string(&props_path).await?;
    let mut new_content = String::with_capacity(content.len() + 50);
    new_content.push_str(&content);

    // If not exists, append. If exists but false, replace (regex).
    if content.contains("org.gradle.caching") {
         let re = Regex::new(r"(org\.gradle\.caching\s*=\s*)(.*)")?;
         new_content = re.replace(&content, "${1}true").to_string();
    } else {
         if !new_content.ends_with('\n') {
             new_content.push('\n');
         }
         new_content.push_str("org.gradle.caching=true\n");
    }

    if new_content != content {
         fs::write(&props_path, new_content).await?;
    }
    Ok(())
}

async fn apply_fix_gradlew(android_dir: &Path) -> Result<()> {
    // Regenerate helpful scripts, overwriting is generally safe here as they are standard boilerplate
    // but strict "Intelligence" would parse it. 
    // Given the complexity of shell scripts, "Backup and Regen" is the safer "surgical" fall back.
    backup_and_regenerate(&android_dir.join("gradlew"), || generate_gradlew(android_dir)).await
}


// --- HELPER UTILS ---

async fn backup_and_regenerate<F, Fut>(path: &Path, generator: F) -> Result<()> 
where 
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<()>>
{
    if path.exists() {
        let backup_path = path.with_extension("bak");
        // Don't overwrite existing backup blindly? or do we? 
        // Let's assume we want to save the current state.
        fs::rename(path, &backup_path).await.context("Failed to backup file")?;
    }
    generator().await
}

// ============================================================
// 4. GENERATORS (Refactored to internal helpers)
// ============================================================

async fn generate_settings_gradle(android_dir: &Path) -> Result<()> {
    // Note: Updated with standard Flutter templates
    let content = r#"pluginManagement {
    def flutterSdkPath = {
        def properties = new Properties()
        file("local.properties").withInputStream { properties.load(it) }
        def flutterSdkPath = properties.getProperty("flutter.sdk")
        assert flutterSdkPath != null, "flutter.sdk not set in local.properties"
        return flutterSdkPath
    }()

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id "dev.flutter.flutter-plugin-loader" version "1.0.0"
    id "com.android.application" version "8.3.2" apply false
    id "org.jetbrains.kotlin.android" version "1.9.22" apply false
}

include ":app"
"#;
    
    fs::write(android_dir.join("settings.gradle"), normalize_line_endings(content))
        .await
        .context("Failed to write settings.gradle")?;
    Ok(())
}

async fn generate_root_build_gradle(android_dir: &Path) -> Result<()> {
    let content = r#"allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.buildDir = "../build"
subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register("clean", Delete) {
    delete rootProject.buildDir
}
"#;
    
    fs::write(android_dir.join("build.gradle"), normalize_line_endings(content))
        .await
        .context("Failed to write build.gradle")?;
    Ok(())
}

async fn generate_app_build_gradle(android_dir: &Path, app_id: &str) -> Result<()> {
    let content = format!(r#"plugins {{
    id "com.android.application"
    id "kotlin-android"
    id "dev.flutter.flutter-gradle-plugin"
}}

android {{
    namespace "{app_id}"
    compileSdk 34
    ndkVersion = flutter.ndkVersion

    compileOptions {{
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }}

    kotlinOptions {{
        jvmTarget = JavaVersion.VERSION_17
    }}

    defaultConfig {{
        applicationId "{app_id}"
        minSdk 21
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }}

    buildTypes {{
        release {{
            signingConfig signingConfigs.debug
        }}
    }}
}}

flutter {{
    source "../.."
}}
"#);
    
    fs::write(android_dir.join("app/build.gradle"), normalize_line_endings(&content))
        .await
        .context("Failed to write app/build.gradle")?;
    Ok(())
}

async fn generate_gradle_properties(android_dir: &Path) -> Result<()> {
    let content = r#"org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G -XX:+HeapDumpOnOutOfMemoryError
android.useAndroidX=true
android.enableJetifier=true
org.gradle.caching=true
"#;
    
    fs::write(android_dir.join("gradle.properties"), normalize_line_endings(content))
        .await
        .context("Failed to write gradle.properties")?;
    Ok(())
}

async fn generate_main_activity(activity_dir: &Path, app_id: &str) -> Result<()> {
    let content = format!(r#"package {app_id}

import io.flutter.embedding.android.FlutterActivity

class MainActivity: FlutterActivity()
"#);
    
    fs::write(activity_dir.join("MainActivity.kt"), normalize_line_endings(&content))
        .await
        .context("Failed to write MainActivity.kt")?;
    Ok(())
}

async fn generate_android_manifest(android_dir: &Path, _app_id: &str, project_name: &str) -> Result<()> {
    // Note: Intentionally kept simple for regeneration
    let content = format!(r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="{project_name}"
        android:name="${{applicationName}}"
        android:icon="@drawable/ic_launcher">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:taskAffinity=""
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
    <queries>
        <intent>
            <action android:name="android.intent.action.PROCESS_TEXT"/>
            <data android:mimeType="text/plain"/>
        </intent>
    </queries>
</manifest>
"#);
    
    fs::write(android_dir.join("app/src/main/AndroidManifest.xml"), normalize_line_endings(&content))
        .await
        .context("Failed to write AndroidManifest.xml")?;
    Ok(())
}

async fn generate_debug_manifest(android_dir: &Path, _app_id: &str) -> Result<()> {
    let content = r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
</manifest>
"#;
    
    fs::write(android_dir.join("app/src/debug/AndroidManifest.xml"), normalize_line_endings(content))
        .await
        .context("Failed to write debug AndroidManifest.xml")?;
    Ok(())
}

async fn generate_profile_manifest(android_dir: &Path, _app_id: &str) -> Result<()> {
    let content = r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET"/>
</manifest>
"#;
    
    fs::write(android_dir.join("app/src/profile/AndroidManifest.xml"), normalize_line_endings(content))
        .await
        .context("Failed to write profile AndroidManifest.xml")?;
    Ok(())
}

async fn generate_styles(android_dir: &Path, _project_name: &str) -> Result<()> {
    // Launch theme
    let launch_theme = r#"<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="LaunchTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">@drawable/launch_background</item>
    </style>
    <style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">?android:colorBackground</item>
    </style>
</resources>
"#;
    fs::write(android_dir.join("app/src/main/res/values/styles.xml"), normalize_line_endings(launch_theme)).await?;
    
    // Night mode styles
    let night_theme = r#"<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="LaunchTheme" parent="@android:style/Theme.Black.NoTitleBar">
        <item name="android:windowBackground">@drawable/launch_background</item>
    </style>
    <style name="NormalTheme" parent="@android:style/Theme.Black.NoTitleBar">
        <item name="android:windowBackground">?android:colorBackground</item>
    </style>
</resources>
"#;
    fs::write(android_dir.join("app/src/main/res/values-night/styles.xml"), normalize_line_endings(night_theme)).await?;
    Ok(())
}

async fn generate_launch_background(android_dir: &Path) -> Result<()> {
    let content = r#"<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="?android:colorBackground" />
</layer-list>
"#;
    fs::write(android_dir.join("app/src/main/res/drawable/launch_background.xml"), normalize_line_endings(content)).await?;
    
    // v21 version
    let content_v21 = r#"<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="?android:colorBackground" />
</layer-list>
"#;
    fs::write(android_dir.join("app/src/main/res/drawable-v21/launch_background.xml"), normalize_line_endings(content_v21)).await?;
    Ok(())
}

/// Derives an application ID from the project name
pub fn derive_app_id(project_name: &str) -> String {
    let clean_name: String = project_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("com.example.{}", clean_name)
}

async fn generate_local_properties(android_dir: &Path, flutter_sdk_path: Option<&str>) -> Result<()> {
    let sdk_path = flutter_sdk_path.unwrap_or("/home/sasho/flutter");
    let content = format!(r#"flutter.sdk={}
"#, sdk_path);
    
    fs::write(android_dir.join("local.properties"), normalize_line_endings(&content))
        .await
        .context("Failed to write local.properties")?;
    Ok(())
}

async fn generate_gradle_wrapper(android_dir: &Path) -> Result<()> {
    let content = r#"distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-all.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
"#;
    
    fs::write(android_dir.join("gradle/wrapper/gradle-wrapper.properties"), normalize_line_endings(content))
        .await
        .context("Failed to write gradle-wrapper.properties")?;
    Ok(())
}

async fn generate_gradlew(android_dir: &Path) -> Result<()> {
    // Unix shell script
    let gradlew_unix = r##"#!/bin/sh
app_path=$0
while
    APP_HOME=${app_path%"${app_path##*/}"}
    [ -h "$app_path" ]
do
    ls=$( ls -ld "$app_path" )
    link=${ls#*' -> '}
    case $link in
      /*)   app_path=$link ;;
      *)    app_path=$APP_HOME$link ;;
    esac
done
if [ -n "$JAVA_HOME" ] ; then
    if [ -x "$JAVA_HOME/jre/sh/java" ] ; then
        JAVACMD=$JAVA_HOME/jre/sh/java
    else
        JAVACMD=$JAVA_HOME/bin/java
    fi
    if [ ! -x "$JAVACMD" ] ; then
        die "ERROR: JAVA_HOME is set to an invalid directory: $JAVA_HOME"
    fi
else
    JAVACMD=java
    which java >/dev/null 2>&1 || die "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH."
fi
APP_HOME=$( cd -P "${APP_HOME:-./}" > /dev/null && printf '%s\n' "$PWD" ) || exit
DEFAULT_JVM_OPTS="-Xmx64m -Xms64m"
CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar
save () {
    for i do printf %s\\n "$i" | sed "s/'/'\\\\''/g;1s/^/'/;\$s/\$/' \\\\/" ; done
    echo " "
}
APP_ARGS=$(save "$@")
exec "$JAVACMD" $DEFAULT_JVM_OPTS $JAVA_OPTS $GRADLE_OPTS \
  "-Dorg.gradle.appname=$APP_BASE_NAME" \
  -classpath "$CLASSPATH" \
  org.gradle.wrapper.GradleWrapperMain \
  "$@"
"##;

    let gradlew_unix = gradlew_unix.replace("\r\n", "\n").replace("\r", "\n");
    
    let gradlew_path = android_dir.join("gradlew");
    fs::write(&gradlew_path, gradlew_unix)
        .await
        .context("Failed to write gradlew")?;
    
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&gradlew_path) {
             let mut perms = metadata.permissions();
             perms.set_mode(0o755);
             let _ = std::fs::set_permissions(&gradlew_path, perms);
        }
    }
    
    // Windows batch script
    let gradlew_bat = r#"@rem Gradle startup script for Windows
@if "%DEBUG%"=="" @echo off
if "%OS%"=="Windows_NT" setlocal
set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
if defined JAVA_HOME goto findJavaFromJavaHome
set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if %ERRORLEVEL% equ 0 goto execute
echo. 1>&2
echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH. 1>&2
echo. 1>&2
goto fail
:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe
if exist "%JAVA_EXE%" goto execute
echo. 1>&2
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME% 1>&2
echo. 1>&2
goto fail
:execute
set CLASSPATH=%DIRNAME%\gradle\wrapper\gradle-wrapper.jar
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
:end
if %ERRORLEVEL% equ 0 goto mainEnd
:fail
if not "" == "%GRADLE_EXIT_CONSOLE%" exit 1
exit /b 1
:mainEnd
if "%OS%"=="Windows_NT" endlocal
:omega
"#;

    fs::write(android_dir.join("gradlew.bat"), gradlew_bat)
        .await
        .context("Failed to write gradlew.bat")?;
    
    Ok(())
}

async fn copy_gradle_wrapper_jar(android_dir: &Path, flutter_sdk_path: &str) -> Result<()> {
    let wrapper_sources = [
        format!("{}/packages/flutter_tools/gradle/wrapper/gradle-wrapper.jar", flutter_sdk_path),
        format!("{}/bin/cache/artifacts/gradle_wrapper/gradle-wrapper.jar", flutter_sdk_path),
    ];
    let dest = android_dir.join("gradle/wrapper/gradle-wrapper.jar");
    for source in &wrapper_sources {
        let source_path = Path::new(source);
        if source_path.exists() {
            fs::copy(source_path, &dest).await.context("Failed to copy gradle-wrapper.jar")?;
            return Ok(());
        }
    }
    eprintln!("[android_scaffold] Warning: Could not find gradle-wrapper.jar in Flutter SDK");
    Ok(())
}

async fn generate_ic_launcher(android_dir: &Path) -> Result<()> {
    let content = r##"<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#3DDC84"
        android:pathData="M0,0h108v108h-108z"/>
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M54,54m-20,0a20,20 0 1,1 40,0a20,20 0 1,1 -40,0"/>
</vector>
"##;
    fs::write(android_dir.join("app/src/main/res/drawable/ic_launcher.xml"), normalize_line_endings(content))
        .await
        .context("Failed to write ic_launcher.xml")?;
    Ok(())
}
