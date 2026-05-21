use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tree_sitter::Parser;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFastPathResult {
    pub accepted: bool,
    pub generated_path: Option<String>,
    pub patched_device_source: Option<String>,
    pub reload_plan: Value,
    pub verifier_report: Value,
    pub reason_codes: Vec<String>,
}

impl DeviceFastPathResult {
    fn rejected(reason_codes: Vec<&str>, user_path: &str) -> Self {
        Self::rejected_strings(reason_codes.into_iter().map(str::to_string).collect(), user_path)
    }

    fn rejected_strings(reason_codes: Vec<String>, user_path: &str) -> Self {
        Self::rejected_strings_with_evidence(reason_codes, user_path, None, Value::Null)
    }

    fn rejected_strings_with_evidence(
        reason_codes: Vec<String>,
        user_path: &str,
        generated_path: Option<&str>,
        evidence: Value,
    ) -> Self {
        let codes = reason_codes;
        let plan = rejection_plan(&codes);
        let reload_plan = reload_plan(plan, &codes, user_path, generated_path);
        let verifier_report =
            fast_path_verifier_report("reject", plan, &codes, user_path, generated_path, evidence);
        Self {
            accepted: false,
            generated_path: None,
            patched_device_source: None,
            reload_plan,
            verifier_report,
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
    if let Some(reason) = device_compile_metadata_rejection_reason(sidecar) {
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
    let parser_status =
        device_ast_status_report(&old_user_source, new_user_source, generated_device_source);
    if !parser_status.failures.is_empty() {
        let mut reason_codes = vec!["parser.device_ast_parse_failed".to_string()];
        reason_codes.extend(parser_status.failures.clone());
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some("parser.device_ast_parse_failed"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            reason_codes,
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    }

    let old_signatures = kernel_signatures(&old_user_source);
    let new_signatures = kernel_signatures(new_user_source);
    if old_signatures != new_signatures {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some("abi.kernel_signature_changed"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["abi.kernel_signature_changed".to_string()],
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    }
    let old_layout = constant_global_layout_hash(&old_user_source);
    let new_layout = constant_global_layout_hash(new_user_source);
    if old_layout != new_layout {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some("abi.constant_global_layout_changed"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["abi.constant_global_layout_changed".to_string()],
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    }

    let mappings = mappings_for_source(sidecar, &user_path);
    if mappings.is_empty() {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some("mapping.device_mapping_missing"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["mapping.device_mapping_missing".to_string()],
            &user_path,
            None,
            evidence,
        );
    }

    let old_regions = kernel_regions(&old_user_source);
    let new_regions = kernel_regions(new_user_source);
    let generated_regions = kernel_regions(generated_device_source);
    let Some(delta) = changed_span(&old_user_source, new_user_source) else {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            None,
            None,
            Some("edit.no_change"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["edit.no_change".to_string()],
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    };

    let mut patched = generated_device_source.to_string();
    let mut patched_any = false;
    let mut affected_symbols = Vec::new();
    let mut generated_patch_span = None;
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
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                mapping_generated_range(mapping),
                Some("mapping.new_kernel_missing"),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec!["mapping.new_kernel_missing".to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        };
        let Some(generated_region) = generated_regions.get(symbol) else {
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                mapping_generated_range(mapping),
                Some("mapping.generated_kernel_missing"),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec!["mapping.generated_kernel_missing".to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        };
        let body_offset = delta.old_start.saturating_sub(old_region.body_start);
        let old_segment = &old_user_source[delta.old_start..delta.old_end];
        let new_segment = &new_user_source[delta.new_start..delta.new_end];
        let generated_body =
            &generated_device_source[generated_region.body_start..generated_region.body_end];
        let mut replacement_text = new_segment.to_string();
        let mut replaced_len = old_segment.len();
        let generated_relative = if !old_segment.is_empty() {
            unique_substr_offset(generated_body, old_segment).or_else(|| {
                statement_patch_anchor(
                    &old_user_source,
                    new_user_source,
                    generated_body,
                    old_region,
                    new_regions.get(symbol)?,
                    &delta,
                )
                .map(|anchor| {
                    replacement_text = anchor.replacement;
                    replaced_len = anchor.old_len;
                    anchor.relative_start
                })
            })
        } else if body_offset <= generated_body.len() {
            Some(body_offset)
        } else {
            None
        };
        let Some(relative) = generated_relative else {
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                mapping_generated_range(mapping),
                Some("mapping.patch_anchor_missing"),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec!["mapping.patch_anchor_missing".to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        };
        let start = generated_region.body_start + relative;
        let end = start + replaced_len;
        if start > patched.len() || end > patched.len() || start > end {
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                Some(byte_range_json(start, end)),
                Some("mapping.patch_range_invalid"),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec!["mapping.patch_range_invalid".to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        }
        patched.replace_range(start..end, &replacement_text);
        patched_any = true;
        affected_symbols.push(symbol.to_string());
        generated_patch_span = Some(byte_range_json(start, end));
        break;
    }

    if !patched_any {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            Some(&delta),
            None,
            Some("edit.not_mapped_kernel_body"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["edit.not_mapped_kernel_body".to_string()],
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    }
    let generated_path = mapped_generated_device_path(sidecar, &user_path);
    let mut codes = vec![
        "edit.kernel_body_only".to_string(),
        "abi.kernel_signature_unchanged".to_string(),
        "abi.constant_global_layout_unchanged".to_string(),
        "mapping.device_role_valid".to_string(),
        "parser.user_baseline_ast_passed".to_string(),
        "parser.user_candidate_ast_passed".to_string(),
        "parser.generated_device_ast_passed".to_string(),
        "build.selected_compile_command_present".to_string(),
        "build.effective_flags_hash_present".to_string(),
        "build.device_sidecar_only".to_string(),
    ];
    codes.extend(
        affected_symbols
            .iter()
            .map(|symbol| format!("mapping.kernel.{symbol}")),
    );
    let plan = reload_plan("device_only", &codes, &user_path, generated_path.as_deref());
    let evidence = fast_path_verifier_evidence(
        sidecar,
        Some(&old_user_source),
        Some(new_user_source),
        Some(&patched),
        Some(parser_status.report),
        Some(&delta),
        generated_patch_span,
        None,
    );
    let verifier_report = fast_path_verifier_report(
        "pass",
        "device_only",
        &codes,
        &user_path,
        generated_path.as_deref(),
        evidence,
    );
    DeviceFastPathResult {
        accepted: true,
        generated_path,
        patched_device_source: Some(patched),
        reload_plan: plan,
        verifier_report,
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
                    Some("gpu_device_tainted") => Some("gpu_device_tainted"),
                    Some("gpu_driver_tdr") => Some("gpu_driver_tdr"),
                    Some("vram_session_refresh_required") => {
                        Some("vram_session_refresh_required")
                    }
                    Some("vram_fragmented") => Some("vram_fragmented"),
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

fn device_compile_metadata_rejection_reason(sidecar: &Value) -> Option<&'static str> {
    let selected_command = sidecar
        .get("selectedCompileCommand")
        .or_else(|| sidecar.get("selected_compile_command"));
    let has_command_identity = selected_command
        .and_then(|command| {
            command
                .get("identity")
                .or_else(|| command.get("argumentsHash"))
                .or_else(|| command.get("effectiveFlagsHash"))
        })
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_command_identity {
        return Some("build.selected_compile_command_missing");
    }

    let has_effective_flags = sidecar
        .get("effectiveFlagsHash")
        .or_else(|| {
            selected_command.and_then(|command| command.get("effectiveFlagsHash"))
        })
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_effective_flags {
        return Some("build.effective_flags_hash_missing");
    }

    None
}

#[derive(Debug, Clone)]
struct DeviceAstStatus {
    report: Value,
    failures: Vec<String>,
}

fn device_ast_status_report(
    old_user_source: &str,
    new_user_source: &str,
    generated_device_source: &str,
) -> DeviceAstStatus {
    let inputs = [
        (
            "userBaseline",
            "parser.user_baseline_ast_failed",
            old_user_source,
        ),
        (
            "userCandidate",
            "parser.user_candidate_ast_failed",
            new_user_source,
        ),
        (
            "generatedDevice",
            "parser.generated_device_ast_failed",
            generated_device_source,
        ),
    ];
    let mut failures = Vec::new();
    let mut report = serde_json::Map::new();
    for (key, reason, source) in inputs {
        match parse_device_cpp_ast(source) {
            Ok(()) => {
                report.insert(
                    key.to_string(),
                    json!({
                        "status": "pass",
                        "reasonCode": null,
                    }),
                );
            }
            Err(message) => {
                failures.push(reason.to_string());
                report.insert(
                    key.to_string(),
                    json!({
                        "status": "fail",
                        "reasonCode": reason,
                        "detail": message,
                    }),
                );
            }
        }
    }
    DeviceAstStatus {
        report: Value::Object(report),
        failures,
    }
}

fn parse_device_cpp_ast(source: &str) -> Result<(), String> {
    let parseable = sanitize_gpu_annotations_for_cpp_parser(source);
    let mut parser = Parser::new();
    let language = tree_sitter_cpp::LANGUAGE;
    parser
        .set_language(&language.into())
        .map_err(|e| format!("set_language: {e}"))?;
    let tree = parser
        .parse(&parseable, None)
        .ok_or_else(|| "parse returned None".to_string())?;
    if tree.root_node().has_error() {
        Err("tree_sitter_cpp_parse_error".to_string())
    } else {
        Ok(())
    }
}

fn sanitize_gpu_annotations_for_cpp_parser(source: &str) -> String {
    let launch_bounds = Regex::new(r"__launch_bounds__\s*\([^)]*\)")
        .expect("launch bounds sanitizer regex");
    let mut out = launch_bounds.replace_all(source, "").into_owned();
    let launch_config =
        Regex::new(r"(?s)<<<.*?>>>").expect("CUDA/HIP launch config sanitizer regex");
    out = launch_config.replace_all(&out, "").into_owned();
    for token in [
        "__global__",
        "__device__",
        "__host__",
        "__constant__",
        "__managed__",
        "__shared__",
        "__restrict__",
    ] {
        out = out.replace(token, "");
    }
    out
}

fn fast_path_verifier_report(
    status: &str,
    selected_plan: &str,
    reason_codes: &[String],
    user_path: &str,
    generated_path: Option<&str>,
    evidence: Value,
) -> Value {
    json!({
        "schemaVersion": "synthi.gpu.device_fast_path_verifier.v1",
        "status": status,
        "selectedPlan": if status == "pass" { Value::String(selected_plan.to_string()) } else { Value::Null },
        "selectedFallback": if status == "reject" { Value::String(selected_plan.to_string()) } else { Value::Null },
        "reasonCodes": reason_codes,
        "userFile": user_path,
        "generatedRole": generated_path,
        "evidence": evidence,
    })
}

fn fast_path_verifier_evidence(
    sidecar: &Value,
    old_user_source: Option<&str>,
    new_user_source: Option<&str>,
    generated_device_source: Option<&str>,
    parser_status: Option<Value>,
    changed_user_span: Option<&BodyDelta>,
    mapped_generated_span: Option<Value>,
    rejection_rule: Option<&str>,
) -> Value {
    json!({
        "kernelSignature": kernel_signature_evidence(old_user_source, new_user_source),
        "constantGlobalLayout": constant_global_layout_evidence(old_user_source, new_user_source),
        "generatedDeviceSourceHash": generated_device_source.map(sha256_hex),
        "changedUserSpan": changed_user_span.map(body_delta_json).unwrap_or(Value::Null),
        "mappedGeneratedSpan": mapped_generated_span.unwrap_or(Value::Null),
        "parserStatus": parser_status.unwrap_or(Value::Null),
        "compileMetadata": compile_metadata_evidence(sidecar),
        "rejectionRule": rejection_rule,
    })
}

fn kernel_signature_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_value = before.map(kernel_signature_snapshot).unwrap_or(Value::Null);
    let after_value = after.map(kernel_signature_snapshot).unwrap_or(Value::Null);
    let changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(kernel_signature_hash(before) != kernel_signature_hash(after))
        }
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "before": before_value,
        "after": after_value,
    })
}

fn kernel_signature_snapshot(source: &str) -> Value {
    let signatures = kernel_signatures(source);
    json!({
        "hash": kernel_signature_hash(source),
        "signatures": signatures,
    })
}

fn kernel_signature_hash(source: &str) -> String {
    let material = kernel_signatures(source)
        .into_iter()
        .map(|(symbol, signature)| format!("{symbol}:{signature}"))
        .collect::<Vec<_>>()
        .join("|");
    sha256_hex(&material)
}

fn constant_global_layout_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_hash = before.map(constant_global_layout_hash);
    let after_hash = after.map(constant_global_layout_hash);
    let changed = match (&before_hash, &after_hash) {
        (Some(before), Some(after)) => Value::Bool(before != after),
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "beforeHash": before_hash,
        "afterHash": after_hash,
    })
}

fn compile_metadata_evidence(sidecar: &Value) -> Value {
    let selected_command = sidecar
        .get("selectedCompileCommand")
        .or_else(|| sidecar.get("selected_compile_command"));
    let identity = selected_command
        .and_then(|command| {
            command
                .get("identity")
                .or_else(|| command.get("argumentsHash"))
                .or_else(|| command.get("effectiveFlagsHash"))
        })
        .and_then(Value::as_str);
    let arguments_count = selected_command
        .and_then(|command| command.get("arguments"))
        .and_then(Value::as_array)
        .map(Vec::len);
    let effective_flags_hash = sidecar
        .get("effectiveFlagsHash")
        .or_else(|| selected_command.and_then(|command| command.get("effectiveFlagsHash")))
        .and_then(Value::as_str);
    json!({
        "selectedCompileCommandPresent": selected_command.is_some(),
        "selectedCompileCommandIdentity": identity,
        "selectedCompileCommandArgumentsCount": arguments_count,
        "effectiveFlagsHashPresent": effective_flags_hash.is_some(),
        "effectiveFlagsHash": effective_flags_hash,
    })
}

fn body_delta_json(delta: &BodyDelta) -> Value {
    json!({
        "oldStartByte": delta.old_start,
        "oldEndByte": delta.old_end,
        "newStartByte": delta.new_start,
        "newEndByte": delta.new_end,
    })
}

fn mapping_generated_range(mapping: &Value) -> Option<Value> {
    mapping
        .get("generatedRange")
        .cloned()
        .or_else(|| mapping.get("generatedBodyRange").cloned())
}

fn byte_range_json(start: usize, end: usize) -> Value {
    json!({
        "startByte": start,
        "endByte": end,
    })
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
    if needle.is_empty() {
        return None;
    }
    let first = haystack.find(needle)?;
    let rest = &haystack[first + needle.len()..];
    if rest.contains(needle) {
        None
    } else {
        Some(first)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StatementPatchAnchor {
    relative_start: usize,
    old_len: usize,
    replacement: String,
}

fn statement_patch_anchor(
    old_source: &str,
    new_source: &str,
    generated_body: &str,
    old_region: &KernelRegion,
    new_region: &KernelRegion,
    delta: &BodyDelta,
) -> Option<StatementPatchAnchor> {
    let old_spans = enclosing_patch_spans(
        old_source,
        delta.old_start,
        delta.old_end,
        old_region.body_start,
        old_region.body_end,
    );
    let new_spans = enclosing_patch_spans(
        new_source,
        delta.new_start,
        delta.new_end,
        new_region.body_start,
        new_region.body_end,
    );

    for (kind, old_start, old_end) in old_spans {
        let old_text = old_source.get(old_start..old_end)?;
        if old_text.trim().is_empty() {
            continue;
        }
        let Some((_, new_start, new_end)) = new_spans
            .iter()
            .find(|(new_kind, _, _)| new_kind == &kind)
        else {
            continue;
        };
        let new_text = new_source.get(*new_start..*new_end)?;
        let relative = unique_substr_offset(generated_body, old_text)?;
        return Some(StatementPatchAnchor {
            relative_start: relative,
            old_len: old_text.len(),
            replacement: new_text.to_string(),
        });
    }

    None
}

fn enclosing_patch_spans(
    source: &str,
    start: usize,
    end: usize,
    lower_bound: usize,
    upper_bound: usize,
) -> Vec<(&'static str, usize, usize)> {
    let mut spans = Vec::new();
    if let Some((statement_start, statement_end)) =
        enclosing_statement_span(source, start, end, lower_bound, upper_bound)
    {
        spans.push(("statement", statement_start, statement_end));
    }
    if let Some((line_start, line_end)) =
        enclosing_line_span(source, start, end, lower_bound, upper_bound)
    {
        spans.push(("line", line_start, line_end));
    }
    spans.dedup_by(|a, b| a.1 == b.1 && a.2 == b.2);
    spans
}

fn enclosing_statement_span(
    source: &str,
    start: usize,
    end: usize,
    lower_bound: usize,
    upper_bound: usize,
) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    if start >= bytes.len() || start > end || lower_bound > upper_bound || upper_bound > bytes.len()
    {
        return None;
    }

    let mut left = start.min(upper_bound);
    while left > lower_bound {
        let prev = bytes[left - 1];
        if matches!(prev, b';' | b'{' | b'}') {
            break;
        }
        left -= 1;
    }

    let mut right = end.min(upper_bound);
    while right < upper_bound {
        let byte = bytes[right];
        right += 1;
        if byte == b';' {
            break;
        }
        if matches!(byte, b'{' | b'}') {
            return None;
        }
    }

    trim_ascii_span(source, left, right)
}

fn enclosing_line_span(
    source: &str,
    start: usize,
    end: usize,
    lower_bound: usize,
    upper_bound: usize,
) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    if start >= bytes.len() || start > end || lower_bound > upper_bound || upper_bound > bytes.len()
    {
        return None;
    }

    let mut left = start.min(upper_bound);
    while left > lower_bound && bytes[left - 1] != b'\n' && bytes[left - 1] != b'\r' {
        left -= 1;
    }

    let mut right = end.min(upper_bound);
    while right < upper_bound && bytes[right] != b'\n' && bytes[right] != b'\r' {
        right += 1;
    }

    trim_ascii_span(source, left, right)
}

fn trim_ascii_span(source: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    if start > end || end > source.len() {
        return None;
    }
    let bytes = source.as_bytes();
    let mut left = start;
    let mut right = end;
    while left < right && bytes[left].is_ascii_whitespace() {
        left += 1;
    }
    while right > left && bytes[right - 1].is_ascii_whitespace() {
        right -= 1;
    }
    if left < right {
        Some((left, right))
    } else {
        None
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
            "selectedCompileCommand": {
                "schemaVersion": "synthi.gpu.selected_compile_command.v1",
                "source": "compile_commands.json",
                "identity": "compile-command-id",
                "effectiveFlagsHash": "flags-hash"
            },
            "effectiveFlagsHash": "flags-hash",
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
            .any(|code| code == "parser.user_baseline_ast_passed"));
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "build.selected_compile_command_present"));
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "build.device_sidecar_only"));
        assert_eq!(
            result.verifier_report.get("status").and_then(Value::as_str),
            Some("pass")
        );
        assert_eq!(
            result
                .verifier_report
                .pointer("/selectedPlan")
                .and_then(Value::as_str),
            Some("device_only")
        );
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/parserStatus/userCandidate/status")
                .and_then(Value::as_str),
            Some("pass")
        );
        assert!(result
            .verifier_report
            .pointer("/evidence/changedUserSpan/oldStartByte")
            .and_then(Value::as_u64)
            .is_some());
        assert!(result
            .verifier_report
            .pointer("/evidence/mappedGeneratedSpan/startByte")
            .and_then(Value::as_u64)
            .is_some());
    }

    #[test]
    fn hip_translation_unit_with_launch_syntax_can_use_body_fast_path() {
        let source = "#include <hip/hip_runtime.h>\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\nint main() {\n  flow<<<dim3(1), dim3(64), 0, hipStreamDefault>>>(nullptr, 1);\n}\n";
        let next = "#include <hip/hip_runtime.h>\n__global__ void flow(float* x, int n) {\n  x[0] += 2.0f;\n}\nint main() {\n  flow<<<dim3(1), dim3(64), 0, hipStreamDefault>>>(nullptr, 1);\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));
        let generated = "extern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n";

        let result = try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated);

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "parser.user_candidate_ast_passed"));
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("2.0f"));
    }

    #[test]
    fn ambiguous_small_delta_uses_statement_anchor() {
        let source = "__global__ void flow(float a, const float* x, float* y, int i) {\n  y[i] = a * x[i] + y[i];\n}\n";
        let next = "__global__ void flow(float a, const float* x, float* y, int i) {\n  y[i] = (a + 0.25f) * x[i] + y[i];\n}\n";
        let generated = "extern \"C\" __global__ void flow(float a, const float* x, float* y, int i) {\n  y[i] = a * x[i] + y[i];\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));

        let result = try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated);

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("(a + 0.25f) * x[i]"));
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
        assert_eq!(
            result.verifier_report.get("status").and_then(Value::as_str),
            Some("reject")
        );
        assert_eq!(
            result
                .verifier_report
                .pointer("/selectedFallback")
                .and_then(Value::as_str),
            Some("abi_breaking")
        );
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/kernelSignature/changed")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/rejectionRule")
                .and_then(Value::as_str),
            Some("abi.kernel_signature_changed")
        );
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
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/constantGlobalLayout/changed")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn constant_global_layout_edit_is_blocked_before_mapping_lookup() {
        let mut missing_mapping = sidecar();
        missing_mapping["deviceMappings"] = Value::Array(Vec::new());
        let next = "__constant__ double gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n";

        let result = try_direct_device_body_patch(
            &missing_mapping,
            "src/gpu/flow.hip",
            next,
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "abi.constant_global_layout_changed"));
        assert!(!result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.device_mapping_missing"));
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
    fn missing_selected_compile_command_blocks_fast_path() {
        let mut missing = sidecar();
        missing.as_object_mut().unwrap().remove("selectedCompileCommand");

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
            .any(|code| code == "build.selected_compile_command_missing"));
    }

    #[test]
    fn missing_effective_flags_hash_blocks_fast_path() {
        let mut missing = sidecar();
        missing.as_object_mut().unwrap().remove("effectiveFlagsHash");
        missing["selectedCompileCommand"]
            .as_object_mut()
            .unwrap()
            .remove("effectiveFlagsHash");

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
            .any(|code| code == "build.effective_flags_hash_missing"));
    }

    #[test]
    fn device_ast_parse_failure_blocks_fast_path() {
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += ;\n}\n";

        let result =
            try_direct_device_body_patch(&sidecar(), "src/gpu/flow.hip", next, generated_source());

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "parser.device_ast_parse_failed"));
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "parser.user_candidate_ast_failed"));
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/parserStatus/userCandidate/status")
                .and_then(Value::as_str),
            Some("fail")
        );
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
    fn tainted_gpu_blocks_fast_path_with_specific_reason() {
        let mut tainted = sidecar();
        tainted["fastPathPolicy"] = json!({
            "deviceOnlyAllowed": false,
            "blockedReasonCodes": ["gpu_device_tainted"]
        });

        let result = try_direct_device_body_patch(
            &tainted,
            "src/gpu/flow.hip",
            generated_source(),
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "gpu_device_tainted"));
    }

    #[test]
    fn fragmented_vram_blocks_fast_path_with_specific_reason() {
        let mut fragmented = sidecar();
        fragmented["fastPathPolicy"] = json!({
            "deviceOnlyAllowed": false,
            "blockedReasonCodes": ["vram_session_refresh_required", "vram_fragmented"]
        });

        let result = try_direct_device_body_patch(
            &fragmented,
            "src/gpu/flow.hip",
            generated_source(),
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "vram_session_refresh_required"));
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
