use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFastPathResult {
    pub accepted: bool,
    pub generated_path: Option<String>,
    pub patched_device_source: Option<String>,
    pub reload_plan: Value,
    pub reason_codes: Vec<String>,
}

impl DeviceFastPathResult {
    fn rejected(reason_codes: Vec<&str>, user_path: &str) -> Self {
        let codes: Vec<String> = reason_codes.into_iter().map(str::to_string).collect();
        let plan = rejection_plan(&codes);
        Self {
            accepted: false,
            generated_path: None,
            patched_device_source: None,
            reload_plan: reload_plan(plan, &codes, user_path, None),
            reason_codes: codes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KernelRegion {
    signature: String,
    body_start: usize,
    body_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BodyDelta {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

pub fn try_direct_device_body_patch(
    sidecar: &Value,
    user_path: &str,
    new_user_source: &str,
    generated_device_source: &str,
) -> DeviceFastPathResult {
    let user_path = normalize_path(user_path);
    if !is_device_source_path(&user_path) {
        return DeviceFastPathResult::rejected(vec!["edit.not_device_source"], &user_path);
    }
    if let Some(reason) = device_only_capability_rejection_reason(sidecar) {
        return DeviceFastPathResult::rejected(vec![reason], &user_path);
    }

    let Some(old_user_source) = source_baseline(sidecar, &user_path) else {
        return DeviceFastPathResult::rejected(vec!["mapping.source_baseline_missing"], &user_path);
    };
    if let Some(expected_hash) = source_baseline_hash(sidecar, &user_path) {
        if sha256_hex(&old_user_source) != expected_hash {
            return DeviceFastPathResult::rejected(
                vec!["mapping.source_baseline_stale"],
                &user_path,
            );
        }
    }

    let mappings = mappings_for_source(sidecar, &user_path);
    if mappings.is_empty() {
        return DeviceFastPathResult::rejected(vec!["mapping.device_mapping_missing"], &user_path);
    }

    let old_signatures = kernel_signatures(&old_user_source);
    let new_signatures = kernel_signatures(new_user_source);
    if old_signatures != new_signatures {
        return DeviceFastPathResult::rejected(vec!["abi.kernel_signature_changed"], &user_path);
    }
    let old_layout = constant_global_layout_hash(&old_user_source);
    let new_layout = constant_global_layout_hash(new_user_source);
    if old_layout != new_layout {
        return DeviceFastPathResult::rejected(
            vec!["abi.constant_global_layout_changed"],
            &user_path,
        );
    }

    let old_regions = kernel_regions(&old_user_source);
    let new_regions = kernel_regions(new_user_source);
    let generated_regions = kernel_regions(generated_device_source);
    let Some(delta) = changed_span(&old_user_source, new_user_source) else {
        return DeviceFastPathResult::rejected(vec!["edit.no_change"], &user_path);
    };

    let mut patched = generated_device_source.to_string();
    let mut patched_any = false;
    let mut affected_symbols = Vec::new();
    for mapping in mappings {
        let symbol = mapping
            .get("symbol")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(old_region) = old_regions.get(symbol) else {
            continue;
        };
        if delta.old_start < old_region.body_start || delta.old_end > old_region.body_end {
            continue;
        }
        if !new_regions.contains_key(symbol) {
            return DeviceFastPathResult::rejected(vec!["mapping.new_kernel_missing"], &user_path);
        };
        let Some(generated_region) = generated_regions.get(symbol) else {
            return DeviceFastPathResult::rejected(
                vec!["mapping.generated_kernel_missing"],
                &user_path,
            );
        };
        let body_offset = delta.old_start.saturating_sub(old_region.body_start);
        let old_segment = &old_user_source[delta.old_start..delta.old_end];
        let new_segment = &new_user_source[delta.new_start..delta.new_end];
        let generated_body =
            &generated_device_source[generated_region.body_start..generated_region.body_end];
        let generated_relative = if !old_segment.is_empty() {
            unique_substr_offset(generated_body, old_segment)
        } else if body_offset <= generated_body.len() {
            Some(body_offset)
        } else {
            None
        };
        let Some(relative) = generated_relative else {
            return DeviceFastPathResult::rejected(
                vec!["mapping.patch_anchor_missing"],
                &user_path,
            );
        };
        let start = generated_region.body_start + relative;
        let end = start + old_segment.len();
        if start > patched.len() || end > patched.len() || start > end {
            return DeviceFastPathResult::rejected(vec!["mapping.patch_range_invalid"], &user_path);
        }
        patched.replace_range(start..end, new_segment);
        patched_any = true;
        affected_symbols.push(symbol.to_string());
        break;
    }

    if !patched_any {
        return DeviceFastPathResult::rejected(vec!["edit.not_mapped_kernel_body"], &user_path);
    }
    let generated_path = mapped_generated_device_path(sidecar, &user_path);
    let mut codes = vec![
        "edit.kernel_body_only".to_string(),
        "abi.kernel_signature_unchanged".to_string(),
        "abi.constant_global_layout_unchanged".to_string(),
        "mapping.device_role_valid".to_string(),
        "build.device_sidecar_only".to_string(),
    ];
    codes.extend(
        affected_symbols
            .iter()
            .map(|symbol| format!("mapping.kernel.{symbol}")),
    );
    let plan = reload_plan("device_only", &codes, &user_path, generated_path.as_deref());
    DeviceFastPathResult {
        accepted: true,
        generated_path,
        patched_device_source: Some(patched),
        reload_plan: plan,
        reason_codes: codes,
    }
}

pub fn mapped_generated_device_path(sidecar: &Value, user_path: &str) -> Option<String> {
    let user_path = normalize_path(user_path);
    mappings_for_source(sidecar, &user_path)
        .first()
        .and_then(|m| m.get("generatedPath"))
        .and_then(Value::as_str)
        .map(normalize_path)
        .or_else(|| {
            sidecar
                .pointer("/deviceMappingReport/generatedDevicePath")
                .and_then(Value::as_str)
                .map(normalize_path)
        })
        .or_else(|| {
            sidecar
                .pointer("/generatedRoles/device/path")
                .and_then(Value::as_str)
                .map(normalize_path)
        })
}

pub fn device_source_hash(source: &str) -> String {
    sha256_hex(source)
}

pub fn device_only_capability_rejection_reason(sidecar: &Value) -> Option<&'static str> {
    let profile_status = sidecar
        .pointer("/toolchainCapabilities/status")
        .and_then(Value::as_str);
    if profile_status != Some("current") {
        return Some(if profile_status == Some("stale") {
            "toolchain_capability_stale"
        } else {
            "toolchain_capability_missing"
        });
    }

    let supports = sidecar
        .pointer("/toolchainCapabilities/supportsDeviceOnlyReload")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !supports {
        return Some("toolchain_capability_no_device_only_reload");
    }

    let fast_policy_allows = sidecar
        .pointer("/fastPathPolicy/deviceOnlyAllowed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !fast_policy_allows {
        if let Some(reason) = sidecar
            .pointer("/fastPathPolicy/blockedReasonCodes")
            .and_then(Value::as_array)
            .and_then(|codes| {
                codes.iter().find_map(|code| match code.as_str() {
                    Some("stale_launch_pointer_detected") => {
                        Some("stale_launch_pointer_detected")
                    }
                    Some("stale_launch_pointer_check_missing") => {
                        Some("stale_launch_pointer_check_missing")
                    }
                    Some("launch_indirection_unverified") => {
                        Some("launch_indirection_unverified")
                    }
                    Some("multi_device_tu_requires_topology_verification") => {
                        Some("multi_device_tu_requires_topology_verification")
                    }
                    _ => None,
                })
            })
        {
            return Some(reason);
        }
        return Some("fast_path_policy_blocks_device_only");
    }

    None
}

fn source_baseline(sidecar: &Value, path: &str) -> Option<String> {
    sidecar
        .get("sourceBaselineContents")
        .and_then(Value::as_object)
        .and_then(|m| m.get(path))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn source_baseline_hash(sidecar: &Value, path: &str) -> Option<String> {
    sidecar
        .get("sourceBaselineHashes")
        .and_then(Value::as_object)
        .and_then(|m| m.get(path))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn mappings_for_source<'a>(sidecar: &'a Value, path: &str) -> Vec<&'a Value> {
    sidecar
        .get("deviceMappings")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("kind").and_then(Value::as_str) == Some("kernel")
                        && item
                            .get("sourcePath")
                            .and_then(Value::as_str)
                            .map(normalize_path)
                            .as_deref()
                            == Some(path)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn kernel_signatures(source: &str) -> BTreeMap<String, String> {
    kernel_regions(source)
        .into_iter()
        .map(|(name, region)| (name, normalize_signature(&region.signature)))
        .collect()
}

fn kernel_regions(source: &str) -> BTreeMap<String, KernelRegion> {
    let re =
        Regex::new(r#"(?:extern\s+"C"\s+)?__global__\s+(?:void\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\("#)
            .expect("kernel regex");
    let mut out = BTreeMap::new();
    for captures in re.captures_iter(source) {
        let Some(matched) = captures.get(0) else {
            continue;
        };
        let Some(name) = captures.get(1).map(|m| m.as_str().to_string()) else {
            continue;
        };
        let open = matched.end() - 1;
        let Some((params, after_params)) = read_balanced(source, open, b'(', b')') else {
            continue;
        };
        let Some(body_open) = next_non_ws(source, after_params) else {
            continue;
        };
        if source.as_bytes().get(body_open) != Some(&b'{') {
            continue;
        }
        let Some((_body, body_close)) = read_balanced(source, body_open, b'{', b'}') else {
            continue;
        };
        out.insert(
            name,
            KernelRegion {
                signature: params,
                body_start: body_open + 1,
                body_end: body_close.saturating_sub(1),
            },
        );
    }
    out
}

fn constant_global_layout_hash(source: &str) -> String {
    let re = Regex::new(r"\b(__constant__|__device__|__managed__)\s+([^;]+);")
        .expect("device global regex");
    let mut decls = Vec::new();
    for captures in re.captures_iter(source) {
        let storage = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let decl = captures
            .get(2)
            .map(|m| collapse_ws(m.as_str()))
            .unwrap_or_default();
        if decl.contains('(') {
            continue;
        }
        decls.push(format!("{storage} {decl}"));
    }
    decls.sort();
    sha256_hex(&decls.join(";"))
}

fn changed_span(old: &str, new: &str) -> Option<BodyDelta> {
    if old == new {
        return None;
    }
    let old_bytes = old.as_bytes();
    let new_bytes = new.as_bytes();
    let mut prefix = 0;
    while prefix < old_bytes.len()
        && prefix < new_bytes.len()
        && old_bytes[prefix] == new_bytes[prefix]
    {
        prefix += 1;
    }
    let mut old_suffix = old_bytes.len();
    let mut new_suffix = new_bytes.len();
    while old_suffix > prefix
        && new_suffix > prefix
        && old_bytes[old_suffix - 1] == new_bytes[new_suffix - 1]
    {
        old_suffix -= 1;
        new_suffix -= 1;
    }
    Some(BodyDelta {
        old_start: prefix,
        old_end: old_suffix,
        new_start: prefix,
        new_end: new_suffix,
    })
}

fn unique_substr_offset(haystack: &str, needle: &str) -> Option<usize> {
    let first = haystack.find(needle)?;
    let rest = &haystack[first + needle.len()..];
    if rest.contains(needle) {
        None
    } else {
        Some(first)
    }
}

fn reload_plan(
    plan: &str,
    reason_codes: &[String],
    user_path: &str,
    generated_path: Option<&str>,
) -> Value {
    json!({
        "schemaVersion": super::gpu_prod_contracts::RELOAD_PLAN_SCHEMA_VERSION,
        "plan": plan,
        "reasonCodes": reason_codes,
        "fallbacksAvailable": ["warm_rebuild", "ai_delta", "full_resplit", "cold_restart"],
        "affectedUserFiles": [user_path],
        "affectedGeneratedRoles": generated_path.map(|p| vec![p.to_string()]).unwrap_or_default(),
        "timingsMs": {},
    })
}

fn normalize_signature(params: &str) -> String {
    collapse_ws(params)
        .replace(" *", "*")
        .replace("* ", "*")
        .replace(" &", "&")
        .replace("& ", "&")
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    normalized
}

fn is_device_source_path(path: &str) -> bool {
    let lower = normalize_path(path).to_ascii_lowercase();
    lower.ends_with(".cu") || lower.ends_with(".hip")
}

fn rejection_plan(reason_codes: &[String]) -> &'static str {
    if reason_codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "abi.kernel_signature_changed" | "abi.constant_global_layout_changed"
        )
    }) {
        "abi_breaking"
    } else {
        "unsupported"
    }
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn next_non_ws(source: &str, start: usize) -> Option<usize> {
    source
        .as_bytes()
        .iter()
        .enumerate()
        .skip(start)
        .find(|(_, b)| !b.is_ascii_whitespace())
        .map(|(idx, _)| idx)
}

fn read_balanced(source: &str, open_index: usize, open: u8, close: u8) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    if bytes.get(open_index) != Some(&open) {
        return None;
    }
    let mut depth = 0usize;
    let start = open_index + 1;
    for (idx, byte) in bytes.iter().enumerate().skip(open_index) {
        if *byte == open {
            depth += 1;
        } else if *byte == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some((source[start..idx].to_string(), idx + 1));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar() -> Value {
        let source = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n";
        json!({
            "toolchainCapabilities": {
                "status": "current",
                "supportsDeviceOnlyReload": true
            },
            "fastPathPolicy": {
                "deviceOnlyAllowed": true
            },
            "sourceBaselineContents": {
                "src/gpu/flow.hip": source
            },
            "sourceBaselineHashes": {
                "src/gpu/flow.hip": sha256_hex(source)
            },
            "deviceMappings": [
                {
                    "kind": "kernel",
                    "symbol": "flow",
                    "sourcePath": "src/gpu/flow.hip",
                    "generatedPath": ".synthi/generated/gpu/device.hip"
                }
            ]
        })
    }

    fn generated_source() -> &'static str {
        "extern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n"
    }

    #[test]
    fn arithmetic_kernel_body_edit_is_device_only() {
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] * 2.0f;\n}\n";

        let result =
            try_direct_device_body_patch(&sidecar(), "src/gpu/flow.hip", next, generated_source());

        assert!(result.accepted);
        assert_eq!(
            result.reload_plan.get("plan").and_then(Value::as_str),
            Some("device_only")
        );
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("gain[0] * 2.0f"));
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "build.device_sidecar_only"));
    }

    #[test]
    fn signature_edit_is_blocked() {
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n, float s) {\n  x[0] += gain[0];\n}\n";

        let result =
            try_direct_device_body_patch(&sidecar(), "src/gpu/flow.hip", next, generated_source());

        assert!(!result.accepted);
        assert_eq!(
            result.reload_plan.get("plan").and_then(Value::as_str),
            Some("abi_breaking")
        );
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "abi.kernel_signature_changed"));
    }

    #[test]
    fn constant_global_layout_edit_is_blocked() {
        let next = "__constant__ double gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n";

        let result =
            try_direct_device_body_patch(&sidecar(), "src/gpu/flow.hip", next, generated_source());

        assert!(!result.accepted);
        assert_eq!(
            result.reload_plan.get("plan").and_then(Value::as_str),
            Some("abi_breaking")
        );
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "abi.constant_global_layout_changed"));
    }

    #[test]
    fn stale_capability_blocks_fast_path() {
        let mut stale = sidecar();
        stale["toolchainCapabilities"]["status"] = Value::String("stale".to_string());

        let result = try_direct_device_body_patch(
            &stale,
            "src/gpu/flow.hip",
            generated_source(),
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "toolchain_capability_stale"));
    }

    #[test]
    fn missing_capability_blocks_fast_path() {
        let mut missing = sidecar();
        missing
            .as_object_mut()
            .unwrap()
            .remove("toolchainCapabilities");

        let result = try_direct_device_body_patch(
            &missing,
            "src/gpu/flow.hip",
            generated_source(),
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "toolchain_capability_missing"));
    }

    #[test]
    fn stale_launch_pointer_check_blocks_fast_path_with_specific_reason() {
        let mut stale_launch = sidecar();
        stale_launch["fastPathPolicy"] = json!({
            "deviceOnlyAllowed": false,
            "blockedReasonCodes": ["stale_launch_pointer_check_missing"]
        });

        let result = try_direct_device_body_patch(
            &stale_launch,
            "src/gpu/flow.hip",
            generated_source(),
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "stale_launch_pointer_check_missing"));
    }

    #[test]
    fn generated_patch_anchor_must_match() {
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] * 2.0f;\n}\n";

        let result = try_direct_device_body_patch(
            &sidecar(),
            "src/gpu/flow.hip",
            next,
            "extern \"C\" __global__ void flow(float* x, int n) { x[0] += other; }",
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.patch_anchor_missing"));
    }

    #[test]
    fn resolves_mapped_generated_device_path() {
        assert_eq!(
            mapped_generated_device_path(&sidecar(), "src/gpu/flow.hip").as_deref(),
            Some(".synthi/generated/gpu/device.hip")
        );
        assert_eq!(device_source_hash("abc"), sha256_hex("abc"));
    }
}
