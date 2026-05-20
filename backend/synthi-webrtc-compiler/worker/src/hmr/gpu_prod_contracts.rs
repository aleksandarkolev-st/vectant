use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const SIDECAR_SCHEMA_VERSION: &str = "synthi.gpu.split_sidecar.v1";
pub const RELOAD_PLAN_SCHEMA_VERSION: &str = "synthi.gpu.reload_plan.v1";
pub const RUN_REPORT_SCHEMA_VERSION: &str = "synthi.gpu.run_report.v1";
pub const TOOLCHAIN_PROFILE_SCHEMA_VERSION: &str = "synthi.gpu.toolchain_capability.v1";
pub const SELECTED_COMPILE_COMMAND_SCHEMA_VERSION: &str = "synthi.gpu.selected_compile_command.v1";

pub fn normalize_split_sidecar(meta: &Value) -> Value {
    let mut root = meta.as_object().cloned().unwrap_or_default();
    root.entry("schemaVersion".to_string())
        .or_insert_with(|| Value::String(SIDECAR_SCHEMA_VERSION.to_string()));

    let compile_manifest = root.get("compile_manifest").cloned().unwrap_or(Value::Null);
    let selected_compile_command = root
        .get("selectedCompileCommand")
        .cloned()
        .or_else(|| root.get("selected_compile_command").cloned())
        .unwrap_or_else(|| selected_compile_command_from_manifest(&compile_manifest));
    let effective_flags_hash = root
        .get("effectiveFlagsHash")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| effective_flags_hash(&compile_manifest));

    root.insert(
        "selectedCompileCommand".to_string(),
        selected_compile_command.clone(),
    );
    root.insert(
        "effectiveFlagsHash".to_string(),
        Value::String(effective_flags_hash.clone()),
    );

    let toolchain_profile = root
        .get("toolchainCapabilities")
        .cloned()
        .or_else(|| root.get("toolchain_capabilities").cloned())
        .unwrap_or_else(|| {
            toolchain_capabilities_from_manifest(&compile_manifest, &effective_flags_hash)
        });
    let toolchain_hash = stable_hash(&toolchain_profile);
    root.insert(
        "toolchainCapabilities".to_string(),
        toolchain_profile.clone(),
    );
    root.insert(
        "toolchainCapabilityProfileHash".to_string(),
        Value::String(toolchain_hash.clone()),
    );

    root.entry("targetIdentity".to_string())
        .or_insert_with(|| target_identity_from_manifest(&compile_manifest));
    if !root.contains_key("sourceBaselineHashes") {
        let source_hashes = source_hashes_from_meta(&root);
        root.insert("sourceBaselineHashes".to_string(), source_hashes);
    }
    root.entry("generatedRoles".to_string())
        .or_insert_with(|| generated_roles_from_manifest(&compile_manifest));
    root.entry("deviceMappings".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    root.entry("kernelSignatureHashes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    root.entry("constantGlobalLayoutHashes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    root.entry("templateEvidenceStatus".to_string())
        .or_insert_with(|| Value::String("missing".to_string()));
    root.entry("templateEvidenceInvalidationReasons".to_string())
        .or_insert_with(|| json!(["template_evidence_missing"]));
    root.entry("generatedArtifactPolicy".to_string())
        .or_insert_with(generated_artifact_policy);

    let fast_path_policy = fast_path_policy(&toolchain_profile, &root);
    root.insert("fastPathPolicy".to_string(), fast_path_policy);

    let reload_plan = root
        .get("lastReloadPlanReport")
        .cloned()
        .or_else(|| root.get("last_reload_plan_report").cloned())
        .unwrap_or_else(|| default_reload_plan(&toolchain_profile));
    root.insert("lastReloadPlanReport".to_string(), reload_plan.clone());

    let cache_report = root
        .get("cacheReport")
        .cloned()
        .or_else(|| root.get("cache_report").cloned())
        .unwrap_or_else(default_cache_report);
    root.insert("cacheReport".to_string(), cache_report.clone());

    if !root.contains_key("runReport") {
        let report = run_report(
            &root,
            &selected_compile_command,
            &toolchain_profile,
            &toolchain_hash,
            &reload_plan,
            &cache_report,
        );
        root.insert("runReport".to_string(), report);
    }

    Value::Object(root)
}

fn selected_compile_command_from_manifest(manifest: &Value) -> Value {
    let host_compiler = manifest
        .get("compiler")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let gpu = manifest.get("gpu").and_then(Value::as_object);
    let device_compiler = gpu
        .and_then(|g| g.get("device_compiler"))
        .and_then(Value::as_str);
    let mut args = Vec::new();
    if let Some(compiler) = device_compiler {
        args.push(Value::String(compiler.to_string()));
    } else {
        args.push(Value::String(host_compiler.to_string()));
    }
    if let Some(std) = manifest.get("std").and_then(Value::as_str) {
        args.push(Value::String(format!("-std={std}")));
    }
    for flag in string_array(manifest.get("common_flags")) {
        args.push(Value::String(flag));
    }
    if let Some(gpu) = gpu {
        for flag in string_array(gpu.get("device_flags")) {
            args.push(Value::String(flag));
        }
        for arch in string_array(gpu.get("arch")) {
            args.push(Value::String(format!("--gpu-arch={arch}")));
        }
    }

    json!({
        "schemaVersion": SELECTED_COMPILE_COMMAND_SCHEMA_VERSION,
        "source": if manifest.is_null() { "missing" } else { "synthi_compile_manifest" },
        "identity": stable_hash(&Value::Array(args.clone())),
        "compiler": host_compiler,
        "deviceCompiler": device_compiler,
        "arguments": args,
    })
}

fn effective_flags_hash(manifest: &Value) -> String {
    let mut material = Map::new();
    for key in [
        "compiler",
        "std",
        "common_flags",
        "core_link_flags",
        "gui_link_flags",
        "runner_link_flags",
    ] {
        if let Some(value) = manifest.get(key) {
            material.insert(key.to_string(), value.clone());
        }
    }
    if let Some(gpu) = manifest.get("gpu") {
        material.insert("gpu".to_string(), gpu.clone());
    }
    stable_hash(&Value::Object(material))
}

fn toolchain_capabilities_from_manifest(manifest: &Value, flags_hash: &str) -> Value {
    let gpu = manifest.get("gpu").and_then(Value::as_object);
    let compiler_id = gpu
        .and_then(|g| g.get("device_compiler"))
        .and_then(Value::as_str)
        .or_else(|| manifest.get("compiler").and_then(Value::as_str))
        .unwrap_or("unknown");
    let vendor = gpu
        .and_then(|g| g.get("vendor"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let arch = gpu
        .and_then(|g| g.get("arch"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(str::to_string);
    let device_flags = gpu
        .and_then(|g| g.get("device_flags"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let requires_rdc = string_array(Some(&device_flags)).iter().any(|f| {
        f.contains("-fgpu-rdc")
            || f.contains("--relocatable-device-code")
            || f.contains("-rdc=true")
            || f == "--device-c"
    });
    let has_gpu = gpu.is_some();
    let supports_device_only = has_gpu && !requires_rdc;

    json!({
        "schemaVersion": TOOLCHAIN_PROFILE_SCHEMA_VERSION,
        "status": if has_gpu { "current" } else { "missing" },
        "compilerId": compiler_id,
        "compilerVersion": null,
        "gpuVendor": vendor,
        "gpuArch": arch,
        "effectiveFlagsHash": flags_hash,
        "requiresRdc": requires_rdc,
        "supportsDeviceOnlyReload": supports_device_only,
        "supportsIncrementalDeviceLink": false,
        "supportsSymbolInspection": has_gpu,
        "supportsSafeModuleUnload": has_gpu,
        "supportsGpuTimeoutDetection": if has_gpu { "partial" } else { "none" },
        "deviceLinkAverageMs": null,
        "deviceLinkP95Ms": null,
        "lastProbeRunId": null,
    })
}

fn target_identity_from_manifest(manifest: &Value) -> Value {
    let module_files = manifest.get("module_files").cloned().unwrap_or(Value::Null);
    json!({
        "source": if manifest.is_null() { "missing" } else { "synthi_compile_manifest" },
        "targetName": null,
        "configuration": null,
        "moduleFiles": module_files,
    })
}

fn source_hashes_from_meta(root: &Map<String, Value>) -> Value {
    let mut hashes = Map::new();
    if let Some(split_hash) = root.get("split_hash").and_then(Value::as_str) {
        hashes.insert("primary".to_string(), Value::String(split_hash.to_string()));
    }
    Value::Object(hashes)
}

fn generated_roles_from_manifest(manifest: &Value) -> Value {
    let module_files = manifest.get("module_files").and_then(Value::as_object);
    let mut roles = Map::new();
    for role in ["shared", "core", "gui", "host_runner", "device"] {
        let path = module_files
            .and_then(|m| m.get(role))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| legacy_role_path(role));
        if let Some(path) = path {
            roles.insert(
                role.to_string(),
                json!({
                    "path": path,
                    "internal": true,
                }),
            );
        }
    }
    Value::Object(roles)
}

fn generated_artifact_policy() -> Value {
    json!({
        "rolesAreInternal": true,
        "userWorkspaceMaterialization": "forbidden",
        "forbiddenUserPaths": [
            "core.cpp",
            "gui.cpp",
            "host_runner.cpp",
            "shared.h",
            "device.cu",
            "device.hip"
        ],
    })
}

fn fast_path_policy(toolchain_profile: &Value, root: &Map<String, Value>) -> Value {
    let mut blocked = Vec::new();
    let profile_current = toolchain_profile
        .get("status")
        .and_then(Value::as_str)
        .map(|s| s == "current")
        .unwrap_or(false);
    let supports_device_only = toolchain_profile
        .get("supportsDeviceOnlyReload")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let template_status = root
        .get("templateEvidenceStatus")
        .and_then(Value::as_str)
        .unwrap_or("missing");

    if !profile_current {
        blocked.push("toolchain_capability_missing");
    }
    if profile_current && !supports_device_only {
        blocked.push("toolchain_capability_no_device_only_reload");
    }
    if template_status != "fresh" {
        blocked.push("template_evidence_missing");
    }

    json!({
        "deviceOnlyAllowed": profile_current && supports_device_only,
        "warmRebuildAllowed": profile_current && template_status == "fresh",
        "blockedReasonCodes": blocked,
    })
}

fn default_reload_plan(toolchain_profile: &Value) -> Value {
    let profile_current = toolchain_profile
        .get("status")
        .and_then(Value::as_str)
        .map(|s| s == "current")
        .unwrap_or(false);
    let mut reasons = vec!["reload.no_attempt_recorded"];
    if !profile_current {
        reasons.push("toolchain_capability_missing");
    }
    json!({
        "schemaVersion": RELOAD_PLAN_SCHEMA_VERSION,
        "plan": "unsupported",
        "reasonCodes": reasons,
        "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
        "affectedUserFiles": [],
        "affectedGeneratedRoles": [],
        "timingsMs": {},
    })
}

fn default_cache_report() -> Value {
    json!({
        "splitCacheHit": false,
        "splitCacheReason": "not_reported",
        "splitCacheKey": null,
    })
}

fn run_report(
    root: &Map<String, Value>,
    selected_compile_command: &Value,
    toolchain_profile: &Value,
    toolchain_hash: &str,
    reload_plan: &Value,
    cache_report: &Value,
) -> Value {
    json!({
        "schemaVersion": RUN_REPORT_SCHEMA_VERSION,
        "runId": root
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "selectedTarget": root.get("targetIdentity").cloned().unwrap_or(Value::Null),
        "selectedCompileCommand": selected_compile_command,
        "effectiveFlagsHash": root.get("effectiveFlagsHash").cloned().unwrap_or(Value::Null),
        "toolchainCapabilityProfileHash": toolchain_hash,
        "toolchainCapabilityProfile": toolchain_profile,
        "splitCacheKey": cache_report.get("splitCacheKey").cloned().unwrap_or(Value::Null),
        "splitCacheHit": cache_report
            .get("splitCacheHit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "splitCacheReason": cache_report
            .get("splitCacheReason")
            .and_then(Value::as_str)
            .unwrap_or("not_reported"),
        "patchTier": root.get("patchTier").cloned().unwrap_or(Value::Null),
        "reloadPlan": reload_plan,
        "arbiterDecision": root.get("arbiterDecision").cloned().unwrap_or(Value::Null),
        "rankedReloadOptions": root
            .get("rankedReloadOptions")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "consentRequired": root.get("consentRequired").cloned().unwrap_or(Value::Null),
        "consentReason": root.get("consentReason").cloned().unwrap_or(Value::Null),
        "generatedRoles": root.get("generatedRoles").cloned().unwrap_or(Value::Null),
        "agenticMode": root.get("agenticMode").cloned().unwrap_or(Value::Null),
        "agenticAttemptCount": root.get("agenticAttemptCount").cloned().unwrap_or(Value::Null),
    })
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn legacy_role_path(role: &str) -> Option<String> {
    match role {
        "shared" => Some("shared.h".to_string()),
        "core" => Some("core.cpp".to_string()),
        "gui" => Some("gui.cpp".to_string()),
        "host_runner" => Some("host_runner.cpp".to_string()),
        "device" => None,
        _ => None,
    }
}

fn stable_hash(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_sidecar_is_migrated_without_enabling_unsafe_fast_path() {
        let sidecar = json!({
            "split_hash": "123",
            "original_source": "int main() { return 0; }",
            "architecture": "arch",
            "compile_manifest": null,
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated.get("schemaVersion").and_then(Value::as_str),
            Some(SIDECAR_SCHEMA_VERSION)
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(migrated
            .pointer("/fastPathPolicy/blockedReasonCodes")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("toolchain_capability_missing")));
        assert_eq!(
            migrated
                .pointer("/lastReloadPlanReport/schemaVersion")
                .and_then(Value::as_str),
            Some(RELOAD_PLAN_SCHEMA_VERSION)
        );
    }

    #[test]
    fn gpu_manifest_records_compile_identity_and_current_capability_profile() {
        let sidecar = json!({
            "split_hash": "456",
            "compile_manifest": {
                "compiler": "clang++",
                "std": "c++20",
                "common_flags": ["-shared", "-fPIC"],
                "module_files": {
                    "shared": "internal/shared.h",
                    "core": "internal/core.cpp",
                    "gui": "internal/gui.cpp",
                    "host_runner": "internal/runner.cpp",
                    "device": "internal/device.hip"
                },
                "gpu": {
                    "vendor": "rocm",
                    "device_compiler": "hipcc",
                    "arch": ["gfx1201"],
                    "device_flags": ["-O3"],
                    "fatbin_strategy": "sidecar_module"
                }
            },
            "cache_report": {
                "splitCacheHit": true,
                "splitCacheReason": "exact_source_hash",
                "splitCacheKey": "99"
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/selectedCompileCommand/deviceCompiler")
                .and_then(Value::as_str),
            Some("hipcc")
        );
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/status")
                .and_then(Value::as_str),
            Some("current")
        );
        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/supportsDeviceOnlyReload")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/runReport/splitCacheHit")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/generatedRoles/device/internal")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn rdc_manifest_blocks_direct_device_only_policy() {
        let sidecar = json!({
            "compile_manifest": {
                "compiler": "clang++",
                "std": "c++20",
                "common_flags": [],
                "gpu": {
                    "vendor": "rocm",
                    "device_compiler": "hipcc",
                    "arch": ["gfx1201"],
                    "device_flags": ["-fgpu-rdc"]
                }
            }
        });

        let migrated = normalize_split_sidecar(&sidecar);

        assert_eq!(
            migrated
                .pointer("/toolchainCapabilities/requiresRdc")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            migrated
                .pointer("/fastPathPolicy/deviceOnlyAllowed")
                .and_then(Value::as_bool),
            Some(false)
        );
    }
}
