use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use tree_sitter::Parser;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFastPathResult {
    pub accepted: bool,
    pub generated_path: Option<String>,
    pub patched_device_source: Option<String>,
    pub affected_symbols: Vec<String>,
    pub reload_plan: Value,
    pub verifier_report: Value,
    pub reason_codes: Vec<String>,
}

impl DeviceFastPathResult {
    fn rejected(reason_codes: Vec<&str>, user_path: &str) -> Self {
        Self::rejected_strings(
            reason_codes.into_iter().map(str::to_string).collect(),
            user_path,
        )
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
            affected_symbols: Vec::new(),
            reload_plan,
            verifier_report,
            reason_codes: codes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KernelRegion {
    signature: String,
    start: usize,
    body_start: usize,
    body_end: usize,
    end: usize,
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
    if !is_device_source_path(&user_path)
        && !is_device_header_kernel_source_path(&user_path, new_user_source)
    {
        return DeviceFastPathResult::rejected(vec!["edit.not_device_source"], &user_path);
    }
    if let Some(reason) = device_only_capability_rejection_reason(sidecar) {
        return DeviceFastPathResult::rejected(vec![reason], &user_path);
    }
    if let Some(reason) = device_compile_metadata_rejection_reason(sidecar) {
        return DeviceFastPathResult::rejected(vec![reason], &user_path);
    }

    let old_user_source = match source_baseline(sidecar, &user_path) {
        NormalizedStringLookup::Found(source) => source,
        NormalizedStringLookup::Missing => {
            return DeviceFastPathResult::rejected(
                vec!["mapping.source_baseline_missing"],
                &user_path,
            );
        }
        NormalizedStringLookup::Ambiguous => {
            return DeviceFastPathResult::rejected(
                vec!["mapping.source_baseline_path_ambiguous"],
                &user_path,
            );
        }
    };
    match source_baseline_hash(sidecar, &user_path) {
        NormalizedStringLookup::Found(expected_hash) => {
            if sha256_hex(&old_user_source) != expected_hash {
                return DeviceFastPathResult::rejected(
                    vec!["mapping.source_baseline_stale"],
                    &user_path,
                );
            }
        }
        NormalizedStringLookup::Missing => {}
        NormalizedStringLookup::Ambiguous => {
            return DeviceFastPathResult::rejected(
                vec!["mapping.source_baseline_hash_path_ambiguous"],
                &user_path,
            );
        }
    }
    let parser_status =
        device_ast_status_report(&old_user_source, new_user_source, generated_device_source);
    let parser_lexical_fallback = !parser_status.failures.is_empty()
        && parser_status_allows_lexical_kernel_region_fallback(&parser_status.report);
    if !parser_status.failures.is_empty() && !parser_lexical_fallback {
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

    let duplicate_kernel_symbols = duplicate_kernel_region_names(&old_user_source)
        .union(&duplicate_kernel_region_names(new_user_source))
        .cloned()
        .collect::<Vec<_>>();
    if !duplicate_kernel_symbols.is_empty() {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some("mapping.ambiguous_source_symbol_identity"),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec!["mapping.ambiguous_source_symbol_identity".to_string()],
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

    if let Some(reason) = strict_body_only_rejection(&old_user_source, new_user_source) {
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some(reason),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            vec![reason.to_string()],
            &user_path,
            mapped_generated_device_path(sidecar, &user_path).as_deref(),
            evidence,
        );
    }

    let mappings = mappings_for_source(sidecar, &user_path);
    if mappings.is_empty() {
        let reason_codes = unmapped_mapping_reason_codes_for_source(sidecar, &user_path);
        let evidence_reason = reason_codes
            .first()
            .map(String::as_str)
            .unwrap_or("mapping.device_mapping_missing");
        let evidence = fast_path_verifier_evidence(
            sidecar,
            Some(&old_user_source),
            Some(new_user_source),
            Some(generated_device_source),
            Some(parser_status.report.clone()),
            changed_span(&old_user_source, new_user_source).as_ref(),
            None,
            Some(evidence_reason),
        );
        return DeviceFastPathResult::rejected_strings_with_evidence(
            reason_codes,
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
    let mut source_include_bridge_recompile = false;
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
        let mapping_generated_path = mapping
            .get("generatedPath")
            .and_then(Value::as_str)
            .map(normalize_path);
        if mapping_generated_path.as_deref().is_some_and(|generated| {
            device_symbol_identity_uncertain_for_scope(sidecar, symbol, &user_path, generated)
        }) {
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                mapping_generated_range(mapping),
                Some("selection.symbol_identity_uncertain"),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec!["selection.symbol_identity_uncertain".to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        }
        let source_bridge_partial_status = mapping_generated_path
            .as_deref()
            .map(|generated_path| {
                source_include_bridge_partial_status(sidecar, generated_path, &user_path, symbol)
            })
            .unwrap_or(SourceIncludeBridgePartialStatus::Unavailable);
        if let SourceIncludeBridgePartialStatus::Rejected(reason) = source_bridge_partial_status {
            let evidence = fast_path_verifier_evidence(
                sidecar,
                Some(&old_user_source),
                Some(new_user_source),
                Some(generated_device_source),
                Some(parser_status.report.clone()),
                Some(&delta),
                mapping_generated_range(mapping),
                Some(reason),
            );
            return DeviceFastPathResult::rejected_strings_with_evidence(
                vec![reason.to_string()],
                &user_path,
                mapped_generated_device_path(sidecar, &user_path).as_deref(),
                evidence,
            );
        }
        if (mapping_is_source_include_bridge(mapping)
            && generated_source_includes_path(generated_device_source, &user_path))
            || source_bridge_partial_status == SourceIncludeBridgePartialStatus::Available
        {
            patched_any = true;
            source_include_bridge_recompile = true;
            affected_symbols.push(symbol.to_string());
            break;
        }
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
            let statement_anchor = new_regions.get(symbol).and_then(|new_region| {
                statement_patch_anchor(
                    &old_user_source,
                    new_user_source,
                    generated_body,
                    old_region,
                    new_region,
                    &delta,
                )
            });
            let statement_anchor_matches_generated_drift =
                statement_anchor.as_ref().is_some_and(|anchor| {
                    generated_body
                        .get(anchor.relative_start..anchor.relative_start + anchor.old_len)
                        .is_some_and(|generated_statement| generated_statement != anchor.source_old)
                });
            if old_segment.trim().len() <= 2 && statement_anchor_matches_generated_drift {
                statement_anchor.map(|anchor| {
                    replacement_text = anchor.replacement;
                    replaced_len = anchor.old_len;
                    anchor.relative_start
                })
            } else {
                unique_substr_offset(generated_body, old_segment).or_else(|| {
                    statement_anchor.map(|anchor| {
                        replacement_text = anchor.replacement;
                        replaced_len = anchor.old_len;
                        anchor.relative_start
                    })
                })
            }
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
        "build.selected_compile_command_present".to_string(),
        "build.effective_flags_hash_present".to_string(),
        "build.device_sidecar_only".to_string(),
    ];
    if source_include_bridge_recompile {
        codes.push("mapping.source_include_bridge_recompile".to_string());
    } else {
        codes.push("mapping.generated_body_patched".to_string());
    }
    if parser_lexical_fallback {
        codes.push("parser.lexical_kernel_region_fallback".to_string());
    } else {
        codes.extend([
            "parser.user_baseline_ast_passed".to_string(),
            "parser.user_candidate_ast_passed".to_string(),
            "parser.generated_device_ast_passed".to_string(),
        ]);
    }
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
        affected_symbols,
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

fn mapping_is_source_include_bridge(mapping: &Value) -> bool {
    mapping
        .get("generatedMappingMode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode == "source_include_bridge")
        || mapping
            .get("mappingConfidence")
            .and_then(Value::as_str)
            .is_some_and(|confidence| confidence == "generated_include_bridge_same_source")
}

fn generated_source_includes_path(source: &str, user_path: &str) -> bool {
    let target = normalize_path(user_path);
    let include_re = Regex::new(r#"^\s*#\s*include\s*"(?P<path>[^"]+)""#).expect("include regex");
    source.lines().any(|line| {
        include_re
            .captures(line)
            .and_then(|caps| caps.name("path"))
            .map(|m| normalize_path(m.as_str()) == target)
            .unwrap_or(false)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceIncludeBridgePartialStatus {
    Available,
    Rejected(&'static str),
    Unavailable,
}

fn source_include_bridge_partial_status(
    sidecar: &Value,
    generated_path: &str,
    user_path: &str,
    symbol: &str,
) -> SourceIncludeBridgePartialStatus {
    let generated = normalize_path(generated_path);
    let source = normalize_path(user_path);
    if generated.is_empty() || source.is_empty() || symbol.trim().is_empty() {
        return SourceIncludeBridgePartialStatus::Unavailable;
    }
    let mut rejection = None;
    for report_key in ["devicePartialArtifacts", "generatedDevicePartials"] {
        let Some(artifacts) = sidecar
            .get(report_key)
            .and_then(|report| report.get("artifacts"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for item in artifacts {
            if item.get("kind").and_then(Value::as_str) != Some("source_include_bridge") {
                continue;
            }
            let Some(artifact_generated) = item
                .get("generatedPath")
                .and_then(Value::as_str)
                .map(normalize_path)
            else {
                continue;
            };
            if artifact_generated != generated {
                continue;
            }
            let source_paths = normalized_json_string_set(item, "sourcePaths");
            if source_paths.len() != 1 || !source_paths.contains(&source) {
                continue;
            }
            let artifact_symbols = normalized_json_string_set(item, "symbols");
            if artifact_symbols.is_empty() || !artifact_symbols.contains(symbol) {
                continue;
            }
            if artifact_symbols
                .iter()
                .all(|candidate| device_symbol_maps_to_scope(sidecar, candidate, &source, &generated))
            {
                return SourceIncludeBridgePartialStatus::Available;
            }
            rejection.get_or_insert("selection.unsafe_symbol_superset");
        }
    }
    rejection
        .map(SourceIncludeBridgePartialStatus::Rejected)
        .unwrap_or(SourceIncludeBridgePartialStatus::Unavailable)
}

fn normalized_json_string_set(item: &Value, key: &str) -> BTreeSet<String> {
    item.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_path)
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn device_symbol_maps_to_scope(
    sidecar: &Value,
    symbol: &str,
    source_path: &str,
    generated_path: &str,
) -> bool {
    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar.pointer(pointer).and_then(Value::as_array) else {
            continue;
        };
        if items.iter().any(|item| {
            item.get("kind").and_then(Value::as_str) == Some("kernel")
                && item
                    .get("symbol")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    == Some(symbol)
                && item
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .as_deref()
                    == Some(source_path)
                && item
                    .get("generatedPath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .as_deref()
                    == Some(generated_path)
        }) {
            return true;
        }
    }
    false
}

fn device_mapping_identity_field(item: &Value, key: &str) -> Option<String> {
    let value = item.get(key)?;
    if let Some(text) = value.as_str() {
        return Some(text.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    if value.is_null() {
        return None;
    }
    Some(value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn device_mapping_identity_key(item: &Value) -> Option<String> {
    let fields = [
        "qualifiedSourceName",
        "qualifiedName",
        "signatureHash",
        "linkage",
        "namespacePath",
        "templateArity",
        "overloadIndex",
        "sourceSpan",
        "sourceSpanHash",
        "mangledNames",
        "demangledNames",
        "exportedNames",
    ];
    let parts = fields
        .iter()
        .filter_map(|field| {
            device_mapping_identity_field(item, field).map(|value| format!("{field}={value}"))
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\x1f"))
}

fn device_symbol_identity_uncertain_for_scope(
    sidecar: &Value,
    symbol: &str,
    source_path: &str,
    generated_path: &str,
) -> bool {
    let mut identities = BTreeSet::new();
    for pointer in ["/deviceMappings", "/deviceMappingReport/deviceMappings"] {
        let Some(items) = sidecar.pointer(pointer).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let same_scope = item.get("kind").and_then(Value::as_str) == Some("kernel")
                && item
                    .get("symbol")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    == Some(symbol)
                && item
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .as_deref()
                    == Some(source_path)
                && item
                    .get("generatedPath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .as_deref()
                    == Some(generated_path);
            if !same_scope {
                continue;
            }
            if let Some(identity) = device_mapping_identity_key(item) {
                identities.insert(identity);
            }
        }
    }
    identities.len() > 1
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
                    Some("stale_launch_pointer_detected") => Some("stale_launch_pointer_detected"),
                    Some("stale_launch_pointer_check_missing") => {
                        Some("stale_launch_pointer_check_missing")
                    }
                    Some("launch_indirection_unverified") => Some("launch_indirection_unverified"),
                    Some("multi_device_tu_requires_topology_verification") => {
                        Some("multi_device_tu_requires_topology_verification")
                    }
                    Some("gpu_device_tainted") => Some("gpu_device_tainted"),
                    Some("gpu_driver_tdr") => Some("gpu_driver_tdr"),
                    Some("vram_session_refresh_required") => Some("vram_session_refresh_required"),
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
        .or_else(|| selected_command.and_then(|command| command.get("effectiveFlagsHash")))
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

fn parser_status_allows_lexical_kernel_region_fallback(report: &Value) -> bool {
    let status = |key: &str| {
        report
            .get(key)
            .and_then(|item| item.get("status"))
            .and_then(Value::as_str)
    };
    let baseline_failed = status("userBaseline") == Some("fail");
    let candidate_failed = status("userCandidate") == Some("fail");
    let generated_failed = status("generatedDevice") == Some("fail");

    // If the old user source and generated device role both parsed cleanly,
    // a candidate-only parser failure is strong evidence of a newly invalid
    // edit. Macro-heavy runtime-compiled GPU headers often fail parsing before
    // and after the edit, so the lexical kernel-region verifier below is the
    // deterministic authority in that project shape.
    baseline_failed || (candidate_failed && generated_failed) || generated_failed
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
    let global_signature = Regex::new(r"GLOBAL_KERNEL_SIGNATURE\s*\(([^)]*)\)")
        .expect("global kernel signature sanitizer regex");
    let mut out = global_signature.replace_all(source, "$1").into_owned();
    let launch_bounds =
        Regex::new(r"__launch_bounds__\s*\([^)]*\)").expect("launch bounds sanitizer regex");
    out = launch_bounds.replace_all(&out, "").into_owned();
    let launch_config =
        Regex::new(r"(?s)<<<.*?>>>").expect("CUDA/HIP launch config sanitizer regex");
    out = launch_config.replace_all(&out, "").into_owned();
    let annotations = Regex::new(&format!(
        r#"\b(?:__global__|__device__|__host__|__constant__|__managed__|__shared__|__restrict__|{})\b"#,
        device_annotation_macro_pattern()
    ))
    .expect("GPU annotation sanitizer regex");
    out = annotations.replace_all(&out, "").into_owned();
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
    let verifier_evidence_id = sha256_hex(&format!(
        "{}|{}|{}|{}|{}",
        status,
        selected_plan,
        user_path,
        generated_path.unwrap_or(""),
        evidence
    ));
    let include_graph_root_changed = evidence
        .pointer("/includeGraphRoot/changed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let macro_controlled_abi_uncertain = evidence
        .pointer("/directiveDiff/macroDirectivesChanged")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    json!({
        "schemaVersion": "synthi.gpu.device_fast_path_verifier.v1",
        "status": status,
        "selectedPlan": if status == "pass" { Value::String(selected_plan.to_string()) } else { Value::Null },
        "selectedFallback": if status == "reject" { Value::String(selected_plan.to_string()) } else { Value::Null },
        "reasonCodes": reason_codes,
        "userFile": user_path,
        "generatedRole": generated_path,
        "verifierEvidenceId": verifier_evidence_id,
        "includeGraphRootChanged": include_graph_root_changed,
        "macroControlledAbiUncertain": macro_controlled_abi_uncertain,
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
        "deviceFunctionSignature": device_function_signature_evidence(old_user_source, new_user_source),
        "deviceFunctionBody": device_function_body_evidence(old_user_source, new_user_source),
        "typeLayout": type_layout_evidence(old_user_source, new_user_source),
        "constantGlobalLayout": constant_global_layout_evidence(old_user_source, new_user_source),
        "staticConstexprData": static_constexpr_data_evidence(old_user_source, new_user_source),
        "directiveDiff": directive_diff_evidence(old_user_source, new_user_source),
        "includeGraphRoot": include_graph_root_evidence(old_user_source, new_user_source),
        "declarationSurface": declaration_surface_evidence(old_user_source, new_user_source),
        "affectedSymbols": affected_symbol_evidence(old_user_source, new_user_source),
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

fn device_function_signature_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_snapshot = before
        .map(device_function_signature_snapshot)
        .unwrap_or(Value::Null);
    let after_snapshot = after
        .map(device_function_signature_snapshot)
        .unwrap_or(Value::Null);
    let changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(device_function_signature_hash(before) != device_function_signature_hash(after))
        }
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "before": before_snapshot,
        "after": after_snapshot,
    })
}

fn device_function_signature_snapshot(source: &str) -> Value {
    json!({
        "hash": device_function_signature_hash(source),
        "signatures": device_function_signatures(source),
    })
}

fn device_function_body_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_snapshot = before
        .map(device_function_body_snapshot)
        .unwrap_or(Value::Null);
    let after_snapshot = after.map(device_function_body_snapshot).unwrap_or(Value::Null);
    let changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(device_function_body_hash(before) != device_function_body_hash(after))
        }
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "before": before_snapshot,
        "after": after_snapshot,
    })
}

fn device_function_body_snapshot(source: &str) -> Value {
    json!({
        "hash": device_function_body_hash(source),
        "bodyHashes": device_function_body_hashes(source),
    })
}

fn type_layout_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_hash = before.map(type_layout_hash);
    let after_hash = after.map(type_layout_hash);
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

fn static_constexpr_data_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_hash = before.map(static_constexpr_data_hash);
    let after_hash = after.map(static_constexpr_data_hash);
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

fn directive_diff_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_summary = before.map(directive_summary).unwrap_or(Value::Null);
    let after_summary = after.map(directive_summary).unwrap_or(Value::Null);
    let include_changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(include_directive_hash(before) != include_directive_hash(after))
        }
        _ => Value::Null,
    };
    let macro_changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(macro_directive_hash(before) != macro_directive_hash(after))
        }
        _ => Value::Null,
    };
    let preprocessor_condition_changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(preprocessor_condition_hash(before) != preprocessor_condition_hash(after))
        }
        _ => Value::Null,
    };
    json!({
        "includeDirectivesChanged": include_changed,
        "macroDirectivesChanged": macro_changed,
        "preprocessorConditionsChanged": preprocessor_condition_changed,
        "before": before_summary,
        "after": after_summary,
    })
}

fn include_graph_root_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let before_roots = before.map(include_graph_roots).unwrap_or_default();
    let after_roots = after.map(include_graph_roots).unwrap_or_default();
    let changed = match (before, after) {
        (Some(_), Some(_)) => Value::Bool(before_roots != after_roots),
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "beforeRoots": before_roots,
        "afterRoots": after_roots,
    })
}

fn declaration_surface_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    let snapshot = |source: &str| {
        json!({
            "templateHash": template_declaration_hash(source),
            "usingHash": using_declaration_hash(source),
            "typeAliasHash": type_alias_hash(source),
            "externHash": extern_declaration_hash(source),
            "namespaceHash": namespace_declaration_hash(source),
            "preprocessorConditionHash": preprocessor_condition_hash(source),
        })
    };
    let before_snapshot = before.map(snapshot).unwrap_or(Value::Null);
    let after_snapshot = after.map(snapshot).unwrap_or(Value::Null);
    let changed = match (before, after) {
        (Some(before), Some(after)) => {
            Value::Bool(declaration_surface_hash(before) != declaration_surface_hash(after))
        }
        _ => Value::Null,
    };
    json!({
        "changed": changed,
        "before": before_snapshot,
        "after": after_snapshot,
    })
}

fn affected_symbol_evidence(before: Option<&str>, after: Option<&str>) -> Value {
    match (before, after) {
        (Some(before), Some(after)) => json!(changed_kernel_body_symbols(before, after)),
        _ => Value::Null,
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum NormalizedStringLookup {
    Found(String),
    Missing,
    Ambiguous,
}

fn source_baseline(sidecar: &Value, path: &str) -> NormalizedStringLookup {
    normalized_object_string_lookup(sidecar, "sourceBaselineContents", path)
}

fn source_baseline_hash(sidecar: &Value, path: &str) -> NormalizedStringLookup {
    normalized_object_string_lookup(sidecar, "sourceBaselineHashes", path)
}

fn normalized_object_string_lookup(
    sidecar: &Value,
    object_key: &str,
    path: &str,
) -> NormalizedStringLookup {
    let Some(map) = sidecar.get(object_key).and_then(Value::as_object) else {
        return NormalizedStringLookup::Missing;
    };
    let normalized_path = normalize_path(path);
    let mut values = BTreeSet::new();
    for (key, value) in map {
        if normalize_path(key) == normalized_path {
            if let Some(text) = value.as_str() {
                values.insert(text.to_string());
            }
        }
    }
    match values.len() {
        0 => NormalizedStringLookup::Missing,
        1 => NormalizedStringLookup::Found(values.into_iter().next().unwrap_or_default()),
        _ => NormalizedStringLookup::Ambiguous,
    }
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

fn unmapped_mapping_reason_codes_for_source(sidecar: &Value, path: &str) -> Vec<String> {
    let mut reasons = BTreeSet::new();
    for pointer in ["/unmappedKernels", "/deviceMappingReport/unmappedKernels"] {
        let Some(items) = sidecar.pointer(pointer).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let source_matches = item
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(normalize_path)
                .as_deref()
                == Some(path);
            if !source_matches {
                continue;
            }
            let Some(reason) = item
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
            else {
                continue;
            };
            if reason.starts_with("mapping.") {
                reasons.insert(reason.to_string());
            } else {
                reasons.insert(format!("mapping.{reason}"));
            }
        }
    }
    if reasons.is_empty() {
        vec!["mapping.device_mapping_missing".to_string()]
    } else {
        reasons.into_iter().collect()
    }
}

fn kernel_signatures(source: &str) -> BTreeMap<String, String> {
    kernel_regions(source)
        .into_iter()
        .map(|(name, region)| (name, normalize_signature(&region.signature)))
        .collect()
}

pub fn changed_kernel_body_symbols(old_source: &str, new_source: &str) -> Vec<String> {
    let old_regions = kernel_regions(old_source);
    let new_regions = kernel_regions(new_source);
    if old_regions.is_empty()
        || old_regions.len() != new_regions.len()
        || old_regions.keys().collect::<Vec<_>>() != new_regions.keys().collect::<Vec<_>>()
    {
        return Vec::new();
    }

    let mut changed = Vec::new();
    for (name, old_region) in old_regions {
        let Some(new_region) = new_regions.get(&name) else {
            return Vec::new();
        };
        if normalize_signature(&old_region.signature) != normalize_signature(&new_region.signature)
        {
            return Vec::new();
        }
        let Some(old_body) = old_source.get(old_region.body_start..old_region.body_end) else {
            return Vec::new();
        };
        let Some(new_body) = new_source.get(new_region.body_start..new_region.body_end) else {
            return Vec::new();
        };
        if old_body != new_body {
            changed.push(name);
        }
    }
    changed
}

fn device_function_signatures(source: &str) -> BTreeMap<String, Vec<String>> {
    let mut signatures: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (region_key, region) in device_function_regions(source) {
        let name = region_key
            .split('@')
            .next()
            .unwrap_or(region_key.as_str())
            .to_string();
        signatures
            .entry(name)
            .or_default()
            .push(normalize_signature(&region.signature));
    }
    for values in signatures.values_mut() {
        values.sort();
    }
    signatures
}

fn device_function_signature_hash(source: &str) -> String {
    let material = device_function_signatures(source)
        .into_iter()
        .map(|(symbol, signatures)| format!("{symbol}:{}", signatures.join(",")))
        .collect::<Vec<_>>()
        .join("|");
    sha256_hex(&material)
}

fn device_function_regions(source: &str) -> BTreeMap<String, KernelRegion> {
    let re = Regex::new(&format!(
        r#"(?:(?:__host__\s+__device__|__device__\s+__host__|__device__|{})\s+)+(?:[A-Za-z_][A-Za-z0-9_:<>,\s*&~]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\("#,
        device_annotation_macro_pattern()
    ))
    .expect("device function regex");
    let masked = mask_comments_preserving_len(source);
    let mut out = BTreeMap::new();
    for captures in re.captures_iter(&masked) {
        let Some(matched) = captures.get(0) else {
            continue;
        };
        let Some(name) = captures.get(1).map(|m| m.as_str().to_string()) else {
            continue;
        };
        if name == "if" || name == "for" || name == "while" || name == "switch" {
            continue;
        }
        let open = matched.end() - 1;
        let Some((params, after_params)) = read_balanced(source, open, b'(', b')') else {
            continue;
        };
        let Some(body_open) = next_function_body_open(source, after_params) else {
            continue;
        };
        let Some((_body, body_close)) = read_balanced(source, body_open, b'{', b'}') else {
            continue;
        };
        let signature = source
            .get(matched.start()..body_open)
            .unwrap_or(params.as_str())
            .to_string();
        let key = format!("{name}@{}", matched.start());
        out.insert(
            key,
            KernelRegion {
                signature,
                start: matched.start(),
                body_start: body_open + 1,
                body_end: body_close.saturating_sub(1),
                end: body_close,
            },
        );
    }
    out
}

fn device_function_body_hashes(source: &str) -> BTreeMap<String, Vec<String>> {
    let masked = mask_comments_preserving_len(source);
    let mut body_hashes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (region_key, region) in device_function_regions(source) {
        let name = region_key
            .split('@')
            .next()
            .unwrap_or(region_key.as_str())
            .to_string();
        let signature = normalize_signature(&region.signature);
        let body = masked
            .get(region.body_start..region.body_end)
            .map(collapse_ws)
            .unwrap_or_default();
        body_hashes
            .entry(name)
            .or_default()
            .push(sha256_hex(&format!("{signature}:{body}")));
    }
    for values in body_hashes.values_mut() {
        values.sort();
    }
    body_hashes
}

fn device_function_body_hash(source: &str) -> String {
    let material = device_function_body_hashes(source)
        .into_iter()
        .map(|(symbol, body_hashes)| format!("{symbol}:{}", body_hashes.join(",")))
        .collect::<Vec<_>>()
        .join("|");
    sha256_hex(&material)
}

pub(crate) fn device_header_kernel_body_only_edit_symbol(
    old_source: &str,
    new_source: &str,
) -> Option<String> {
    if kernel_signatures(old_source) != kernel_signatures(new_source) {
        return None;
    }
    if constant_global_layout_hash(old_source) != constant_global_layout_hash(new_source) {
        return None;
    }
    if strict_body_only_rejection(old_source, new_source).is_some() {
        return None;
    }
    let delta = changed_span(old_source, new_source)?;
    let old_regions = kernel_regions(old_source);
    let new_regions = kernel_regions(new_source);
    for (name, old_region) in old_regions {
        let Some(new_region) = new_regions.get(&name) else {
            continue;
        };
        if delta.old_start >= old_region.body_start
            && delta.old_end <= old_region.body_end
            && delta.new_start >= new_region.body_start
            && delta.new_end <= new_region.body_end
        {
            return Some(name);
        }
    }
    None
}

fn kernel_region_records(source: &str) -> Vec<(String, KernelRegion)> {
    let re = Regex::new(
        r#"(?:extern\s+"C"\s+)?(?:__global__\s+(?:void\s+)?|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?)([A-Za-z_][A-Za-z0-9_]*)\s*\("#,
    )
    .expect("kernel regex");
    let masked = mask_comments_preserving_len(source);
    let mut out = Vec::new();
    for captures in re.captures_iter(&masked) {
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
        let Some(body_open) = next_function_body_open(source, after_params) else {
            continue;
        };
        let Some((_body, body_close)) = read_balanced(source, body_open, b'{', b'}') else {
            continue;
        };
        let signature = source
            .get(matched.start()..body_open)
            .unwrap_or(params.as_str())
            .to_string();
        out.push((
            name,
            KernelRegion {
                signature,
                start: matched.start(),
                body_start: body_open + 1,
                body_end: body_close.saturating_sub(1),
                end: body_close,
            },
        ));
    }
    out
}

fn kernel_regions(source: &str) -> BTreeMap<String, KernelRegion> {
    kernel_region_records(source).into_iter().collect()
}

fn duplicate_kernel_region_names(source: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for (name, _region) in kernel_region_records(source) {
        if !seen.insert(name.clone()) {
            duplicates.insert(name);
        }
    }
    duplicates
}

fn mask_comments_preserving_len(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut masked = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => {
                let quote = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                        continue;
                    }
                    if bytes[i] == quote {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                masked[i] = b' ';
                masked[i + 1] = b' ';
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    if bytes[i] != b'\r' {
                        masked[i] = b' ';
                    }
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                masked[i] = b' ';
                masked[i + 1] = b' ';
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        masked[i] = b' ';
                        masked[i + 1] = b' ';
                        i += 2;
                        break;
                    }
                    if bytes[i] != b'\n' && bytes[i] != b'\r' {
                        masked[i] = b' ';
                    }
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    String::from_utf8(masked).unwrap_or_else(|_| source.to_string())
}

fn normalized_source_lines_matching(source: &str, pattern: &Regex) -> Vec<String> {
    let masked = mask_comments_preserving_len(source);
    source
        .lines()
        .zip(masked.lines())
        .filter_map(|(line, masked_line)| {
            if pattern.is_match(masked_line) {
                Some(collapse_ws(line.trim()))
            } else {
                None
            }
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn hash_lines(lines: Vec<String>) -> String {
    sha256_hex(&lines.join("\n"))
}

fn include_graph_roots(source: &str) -> Vec<String> {
    let include_re =
        Regex::new(r#"^\s*#\s*include\s*(?P<path><[^>]+>|"[^"]+")"#).expect("include regex");
    let mut roots = source
        .lines()
        .filter_map(|line| {
            include_re
                .captures(line)
                .and_then(|caps| caps.name("path"))
                .map(|m| m.as_str().trim_matches(['<', '>', '"']).replace('\\', "/"))
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    roots
}

fn include_directive_hash(source: &str) -> String {
    let re = Regex::new(r#"^\s*#\s*include\b"#).expect("include directive regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn macro_directive_hash(source: &str) -> String {
    let re = Regex::new(r#"^\s*#\s*(define|undef)\b"#).expect("macro directive regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn preprocessor_condition_hash(source: &str) -> String {
    let re = Regex::new(r#"^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b"#)
        .expect("preprocessor condition regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn directive_summary(source: &str) -> Value {
    let include_re = Regex::new(r#"^\s*#\s*include\b"#).expect("include directive regex");
    let macro_re = Regex::new(r#"^\s*#\s*(define|undef)\b"#).expect("macro directive regex");
    let preprocessor_condition_re = Regex::new(r#"^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b"#)
        .expect("preprocessor condition regex");
    json!({
        "includeHash": include_directive_hash(source),
        "macroHash": macro_directive_hash(source),
        "preprocessorConditionHash": preprocessor_condition_hash(source),
        "includeCount": normalized_source_lines_matching(source, &include_re).len(),
        "macroCount": normalized_source_lines_matching(source, &macro_re).len(),
        "preprocessorConditionCount": normalized_source_lines_matching(
            source,
            &preprocessor_condition_re,
        )
        .len(),
    })
}

fn template_declaration_hash(source: &str) -> String {
    let re = Regex::new(r#"\btemplate\s*<"#).expect("template regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn using_declaration_hash(source: &str) -> String {
    let re = Regex::new(r#"\busing\b"#).expect("using regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn type_alias_hash(source: &str) -> String {
    let re = Regex::new(r#"\b(typedef|using\b[^;{]*=)"#).expect("type alias regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn extern_declaration_hash(source: &str) -> String {
    let re = Regex::new(r#"\bextern\b"#).expect("extern regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn namespace_declaration_hash(source: &str) -> String {
    let re = Regex::new(r#"\bnamespace\b"#).expect("namespace regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn declaration_surface_hash(source: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}|{}|{}|{}",
        template_declaration_hash(source),
        using_declaration_hash(source),
        type_alias_hash(source),
        extern_declaration_hash(source),
        namespace_declaration_hash(source),
        preprocessor_condition_hash(source),
    ))
}

fn static_constexpr_data_hash(source: &str) -> String {
    let re =
        Regex::new(r#"\b(static|constexpr)\b[^;{()]*;"#).expect("static constexpr data regex");
    hash_lines(normalized_source_lines_matching(source, &re))
}

fn type_layout_hash(source: &str) -> String {
    let masked = mask_comments_preserving_len(source);
    let re = Regex::new(
        r#"\b(?:(?:struct|class|union)\s+[A-Za-z_][A-Za-z0-9_]*[^;{]*|enum\s+(?:(?:class|struct)\s+)?[A-Za-z_][A-Za-z0-9_]*[^;{]*)\{"#,
    )
        .expect("type layout regex");
    let mut layouts = Vec::new();
    for matched in re.find_iter(&masked) {
        let open = matched.end().saturating_sub(1);
        let Some((_body, close)) = read_balanced(source, open, b'{', b'}') else {
            continue;
        };
        let mut end = close;
        while end < source.len() && source.as_bytes().get(end).is_some_and(u8::is_ascii_whitespace)
        {
            end += 1;
        }
        if source.as_bytes().get(end) == Some(&b';') {
            end += 1;
        }
        if let Some(layout) = source.get(matched.start()..end) {
            layouts.push(collapse_ws(layout));
        }
    }
    layouts.sort();
    sha256_hex(&layouts.join("\n"))
}

pub fn build_device_partial_source(source: &str, symbols: &[String]) -> Option<String> {
    let target_symbols = symbols
        .iter()
        .map(|symbol| symbol.trim())
        .filter(|symbol| !symbol.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    if target_symbols.is_empty() {
        return None;
    }

    let regions = kernel_regions(source);
    if regions.len() <= target_symbols.len() {
        return None;
    }
    if !target_symbols
        .iter()
        .all(|symbol| regions.contains_key(symbol))
    {
        return None;
    }

    let mut ordered = regions.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(_, region)| region.start);

    let mut partial = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for (name, region) in ordered {
        if region.start < cursor || region.end < region.start || region.end > source.len() {
            return None;
        }
        partial.push_str(source.get(cursor..region.start)?);
        if target_symbols.contains(name) {
            partial.push_str(source.get(region.start..region.end)?);
        } else {
            partial.push_str("\n// synthi-gpu-hmr: unchanged kernel omitted: ");
            partial.push_str(name);
            partial.push('\n');
        }
        cursor = region.end;
    }
    partial.push_str(source.get(cursor..)?);

    if partial.len() >= source.len() {
        return None;
    }
    let partial_symbols = kernel_regions(&partial)
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if partial_symbols != target_symbols {
        return None;
    }
    Some(partial)
}

pub fn build_device_include_bridge_partial_source(
    source: &str,
    target_source_paths: &[String],
    omit_source_paths: &[String],
) -> Option<String> {
    let target_paths = target_source_paths
        .iter()
        .map(|path| normalize_path(path))
        .filter(|path| !path.is_empty())
        .collect::<BTreeSet<_>>();
    let omit_paths = omit_source_paths
        .iter()
        .map(|path| normalize_path(path))
        .filter(|path| !path.is_empty() && !target_paths.contains(path))
        .collect::<BTreeSet<_>>();
    if target_paths.is_empty() || omit_paths.is_empty() {
        return None;
    }

    let include_re = Regex::new(r#"^\s*#\s*include\s+"(?P<path>[^"]+)""#).expect("include regex");
    let mut partial = String::with_capacity(source.len());
    let mut removed = 0usize;
    let mut kept_target = false;
    for line in source.split_inclusive('\n') {
        let line_body = line.trim_end_matches(['\r', '\n']);
        let newline = line.get(line_body.len()..).unwrap_or_default();
        if let Some(caps) = include_re.captures(line_body) {
            if let Some(include_path) = caps.name("path").map(|m| normalize_path(m.as_str())) {
                if target_paths.contains(&include_path) {
                    kept_target = true;
                }
                if omit_paths.contains(&include_path) {
                    partial.push_str(
                        "// synthi-gpu-hmr: omitted source include from partial artifact",
                    );
                    partial.push_str(newline);
                    removed += 1;
                    continue;
                }
            }
        }
        partial.push_str(line);
    }

    if removed == 0 || !kept_target {
        return None;
    }
    Some(partial)
}

fn next_function_body_open(source: &str, after_params: usize) -> Option<usize> {
    let rest = source.get(after_params..)?;
    let brace = rest.find('{')?;
    let semicolon = rest.find(';');
    if semicolon.is_some_and(|index| index < brace) {
        return None;
    }
    Some(after_params + brace)
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

fn strict_body_only_rejection(old_source: &str, new_source: &str) -> Option<&'static str> {
    if include_directive_hash(old_source) != include_directive_hash(new_source) {
        return Some("abi.include_directive_changed");
    }
    if macro_directive_hash(old_source) != macro_directive_hash(new_source) {
        return Some("abi.macro_directive_changed");
    }
    if preprocessor_condition_hash(old_source) != preprocessor_condition_hash(new_source) {
        return Some("abi.preprocessor_condition_changed");
    }
    if template_declaration_hash(old_source) != template_declaration_hash(new_source) {
        return Some("abi.template_declaration_changed");
    }
    if using_declaration_hash(old_source) != using_declaration_hash(new_source) {
        return Some("abi.using_declaration_changed");
    }
    if type_alias_hash(old_source) != type_alias_hash(new_source) {
        return Some("abi.type_alias_changed");
    }
    if extern_declaration_hash(old_source) != extern_declaration_hash(new_source) {
        return Some("abi.extern_declaration_changed");
    }
    if type_layout_hash(old_source) != type_layout_hash(new_source) {
        return Some("abi.type_layout_changed");
    }
    if namespace_declaration_hash(old_source) != namespace_declaration_hash(new_source) {
        return Some("abi.namespace_changed");
    }
    if static_constexpr_data_hash(old_source) != static_constexpr_data_hash(new_source) {
        return Some("abi.static_constexpr_data_changed");
    }
    let old_device_signatures = device_function_signatures(old_source);
    let new_device_signatures = device_function_signatures(new_source);
    if old_device_signatures != new_device_signatures {
        if old_device_signatures.keys().collect::<Vec<_>>()
            != new_device_signatures.keys().collect::<Vec<_>>()
        {
            return Some("abi.device_function_set_changed");
        }
        if old_device_signatures
            .iter()
            .any(|(name, signatures)| new_device_signatures.get(name).map(Vec::len) != Some(signatures.len()))
        {
            return Some("abi.overload_set_changed");
        }
        return Some("abi.device_function_signature_changed");
    }
    if device_function_body_hash(old_source) != device_function_body_hash(new_source) {
        return Some("abi.device_function_body_changed");
    }
    None
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
    source_old: String,
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
        let Some((_, new_start, new_end)) =
            new_spans.iter().find(|(new_kind, _, _)| new_kind == &kind)
        else {
            continue;
        };
        let new_text = new_source.get(*new_start..*new_end)?;
        if let Some(relative) = unique_substr_offset(generated_body, old_text) {
            return Some(StatementPatchAnchor {
                relative_start: relative,
                old_len: old_text.len(),
                source_old: old_text.to_string(),
                replacement: new_text.to_string(),
            });
        }
        let Some((relative, old_len)) =
            normalized_statement_anchor_offset(generated_body, old_text)
        else {
            continue;
        };
        return Some(StatementPatchAnchor {
            relative_start: relative,
            old_len,
            source_old: old_text.to_string(),
            replacement: new_text.to_string(),
        });
    }

    None
}

fn normalized_statement_anchor_offset(
    generated_body: &str,
    old_text: &str,
) -> Option<(usize, usize)> {
    let old_normalized = normalize_statement_anchor(old_text);
    if old_normalized.is_empty() {
        return None;
    }

    let mut found: Option<(usize, usize)> = None;
    for (start, end) in statement_spans(generated_body) {
        let candidate = generated_body.get(start..end)?;
        if normalize_statement_anchor(candidate) != old_normalized {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some((start, end - start));
    }
    found
}

fn statement_spans(source: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let bytes = source.as_bytes();
    let mut start = 0usize;
    for (idx, byte) in bytes.iter().enumerate() {
        if matches!(*byte, b'{' | b'}') {
            if let Some(span) = trim_ascii_span(source, start, idx) {
                spans.push(span);
            }
            start = idx + 1;
            continue;
        }
        if *byte == b';' {
            if let Some(span) = trim_ascii_span(source, start, idx + 1) {
                spans.push(span);
            }
            start = idx + 1;
        }
    }
    if let Some(span) = trim_ascii_span(source, start, source.len()) {
        spans.push(span);
    }
    spans
}

fn normalize_statement_anchor(text: &str) -> String {
    let without_redundant_global_qualifiers = strip_redundant_global_scope_qualifiers(text);
    collapse_ws(&without_redundant_global_qualifiers)
        .replace(" ;", ";")
        .replace("( ", "(")
        .replace(" )", ")")
        .replace("[ ", "[")
        .replace(" ]", "]")
        .replace(" ,", ",")
}

fn strip_redundant_global_scope_qualifiers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if idx + 1 < bytes.len()
            && bytes[idx] == b':'
            && bytes[idx + 1] == b':'
            && starts_redundant_global_scope(text, idx)
        {
            idx += 2;
            continue;
        }
        let Some(ch) = text[idx..].chars().next() else {
            break;
        };
        out.push(ch);
        idx += ch.len_utf8();
    }
    out
}

fn starts_redundant_global_scope(text: &str, scope_idx: usize) -> bool {
    let Some(next) = text.get(scope_idx + 2..).and_then(|rest| rest.chars().next()) else {
        return false;
    };
    if !is_cpp_identifier_start(next) {
        return false;
    }
    let previous = text
        .get(..scope_idx)
        .and_then(|prefix| prefix.chars().rev().find(|ch| !ch.is_whitespace()));
    match previous {
        None => true,
        Some(ch) => !is_cpp_identifier_continue(ch) && !matches!(ch, ')' | ']' | '>'),
    }
}

fn is_cpp_identifier_start(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphabetic()
}

fn is_cpp_identifier_continue(ch: char) -> bool {
    is_cpp_identifier_start(ch) || ch.is_ascii_digit()
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
    let normalized = path.replace('\\', "/");
    let absolute = normalized.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." => parts.push(part),
            value => parts.push(value),
        }
    }
    let joined = parts.join("/");
    if absolute && !joined.is_empty() {
        format!("/{joined}")
    } else {
        joined
    }
}

fn device_annotation_macro_pattern() -> &'static str {
    r#"[A-Z][A-Z0-9_]*(?:DEVICE|GPU|CUDA|HIP)[A-Z0-9_]*"#
}

fn source_contains_device_annotation(source: &str) -> bool {
    let stripped = mask_comments_preserving_len(source);
    stripped.contains("__global__")
        || stripped.contains("__device__")
        || stripped.contains("GLOBAL_KERNEL_SIGNATURE")
        || Regex::new(&format!(r#"\b{}\b"#, device_annotation_macro_pattern()))
            .expect("device annotation macro regex")
            .is_match(&stripped)
}

fn is_device_source_path(path: &str) -> bool {
    let lower = normalize_path(path).to_ascii_lowercase();
    lower.ends_with(".cu") || lower.ends_with(".hip")
}

fn is_device_header_path(path: &str) -> bool {
    let lower = normalize_path(path).to_ascii_lowercase();
    lower.ends_with(".cuh")
        || lower.ends_with(".h")
        || lower.ends_with(".hh")
        || lower.ends_with(".hpp")
        || lower.ends_with(".hxx")
}

fn is_device_header_kernel_source_path(path: &str, source: &str) -> bool {
    is_device_header_path(path) && source_contains_device_annotation(source)
}

fn rejection_plan(reason_codes: &[String]) -> &'static str {
    if reason_codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "abi.kernel_signature_changed"
                | "abi.constant_global_layout_changed"
                | "abi.include_directive_changed"
                | "abi.macro_directive_changed"
                | "abi.preprocessor_condition_changed"
                | "abi.template_declaration_changed"
                | "abi.using_declaration_changed"
                | "abi.type_alias_changed"
                | "abi.extern_declaration_changed"
                | "abi.type_layout_changed"
                | "abi.namespace_changed"
                | "abi.static_constexpr_data_changed"
                | "abi.device_function_set_changed"
                | "abi.device_function_signature_changed"
                | "abi.device_function_body_changed"
                | "abi.overload_set_changed"
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

    const FIXTURE_GENERATED_DEVICE_PATH: &str = ".synthi/generated/gpu/device.hip";
    const FIXTURE_SOURCE_PATH: &str = "fixtures/device/source.hip";
    const FIXTURE_FOREIGN_SOURCE_PATH: &str = "fixtures/device/foreign.hip";
    const FIXTURE_SYMBOL: &str = "fixture_kernel_a";
    const FIXTURE_FOREIGN_SYMBOL: &str = "fixture_kernel_b";
    const FIXTURE_PARTIAL_FILENAME: &str = ".synthi/generated/gpu/device.partial.source.hip";

    fn fixture_kernel_body(symbol: &str, statement: &str) -> String {
        format!("extern \"C\" __global__ void {symbol}(float* values) {{\n  {statement};\n}}\n")
    }

    fn source_include_recompile_fixture(
        before: &str,
        mappings: Vec<Value>,
        artifact_symbols: &[&str],
    ) -> Value {
        let mut source_baseline_contents = serde_json::Map::new();
        source_baseline_contents.insert(
            FIXTURE_SOURCE_PATH.to_string(),
            Value::String(before.to_string()),
        );
        let mut source_baseline_hashes = serde_json::Map::new();
        source_baseline_hashes.insert(
            FIXTURE_SOURCE_PATH.to_string(),
            Value::String(sha256_hex(before)),
        );
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
            "sourceBaselineContents": Value::Object(source_baseline_contents),
            "sourceBaselineHashes": Value::Object(source_baseline_hashes),
            "deviceMappings": mappings,
            "devicePartialArtifacts": {
                "schemaVersion": "synthi.gpu.device_partial_artifacts.v1",
                "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                "artifacts": [
                    {
                        "kind": "source_include_bridge",
                        "filename": FIXTURE_PARTIAL_FILENAME,
                        "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                        "sourcePaths": [FIXTURE_SOURCE_PATH],
                        "symbols": artifact_symbols,
                        "contentBytes": 82,
                        "fullBytes": 256
                    }
                ]
            }
        })
    }

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

    fn sidecar_with_source(source: &str) -> Value {
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));
        meta
    }

    fn generated_source() -> &'static str {
        "extern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n"
    }

    fn macro_header_sidecar() -> Value {
        let source = "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)\nCameraRays(HIPRTRenderData render_data) {\n  render_data.random_number += 1;\n}\n";
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
                "src/Device/kernels/CameraRays.h": source
            },
            "sourceBaselineHashes": {
                "src/Device/kernels/CameraRays.h": sha256_hex(source)
            },
            "deviceMappings": [
                {
                    "kind": "kernel",
                    "symbol": "CameraRays",
                    "sourcePath": "src/Device/kernels/CameraRays.h",
                    "generatedPath": ".synthi/generated/gpu/device.hip"
                }
            ]
        })
    }

    fn generated_macro_header_source() -> &'static str {
        "extern \"C\" __global__ void CameraRays(HIPRTRenderData render_data) {\n  render_data.random_number += 1;\n}\n"
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
    fn macro_wrapped_runtime_kernel_header_body_edit_is_device_only() {
        let next = "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)\nCameraRays(HIPRTRenderData render_data) {\n  render_data.random_number += 3;\n}\n";

        let result = try_direct_device_body_patch(
            &macro_header_sidecar(),
            "src/Device/kernels/CameraRays.h",
            next,
            generated_macro_header_source(),
        );

        assert!(
            result.accepted,
            "reason_codes={:?} verifier={}",
            result.reason_codes, result.verifier_report
        );
        assert_eq!(
            result.reload_plan.get("plan").and_then(Value::as_str),
            Some("device_only")
        );
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("random_number += 3"));
    }

    #[test]
    fn source_include_bridge_header_body_edit_recompiles_scoped_partial() {
        let before = "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)\nCameraRays(HIPRTRenderData render_data) {\n  render_data.random_number += 1;\n}\n";
        let next = before.replace("random_number += 1", "random_number += 5");
        let meta = json!({
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
                "src/Device/kernels/CameraRays.h": before
            },
            "sourceBaselineHashes": {
                "src/Device/kernels/CameraRays.h": sha256_hex(before)
            },
            "deviceMappings": [
                {
                    "kind": "kernel",
                    "symbol": "CameraRays",
                    "sourcePath": "src/Device/kernels/CameraRays.h",
                    "generatedPath": ".synthi/generated/gpu/device.hip",
                    "generatedMappingMode": "source_include_bridge",
                    "mappingConfidence": "generated_include_bridge_same_source"
                }
            ]
        });
        let generated =
            "#include \"synthi_gpu_runtime.h\"\n#include \"src/Device/kernels/CameraRays.h\"\n";

        let result = try_direct_device_body_patch(
            &meta,
            "src/Device/kernels/CameraRays.h",
            &next,
            generated,
        );

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert_eq!(result.patched_device_source.as_deref(), Some(generated));
        assert_eq!(result.affected_symbols, vec!["CameraRays".to_string()]);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.source_include_bridge_recompile"));
        assert!(result
            .verifier_report
            .pointer("/evidence/mappedGeneratedSpan")
            .is_some_and(Value::is_null));
    }

    #[test]
    fn source_include_bridge_prefers_recompile_when_generated_copy_exists() {
        let before = "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)\nSourceBackedKernel(RenderState state) {\n  state.value += device_min(3, state.limit);\n}\n";
        let next = before.replace("device_min(3", "device_min(2 + 1");
        let meta = json!({
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
                "src/gpu/source_backed_kernel.h": before
            },
            "sourceBaselineHashes": {
                "src/gpu/source_backed_kernel.h": sha256_hex(before)
            },
            "deviceMappings": [
                {
                    "kind": "kernel",
                    "symbol": "SourceBackedKernel",
                    "sourcePath": "src/gpu/source_backed_kernel.h",
                    "generatedPath": ".synthi/generated/gpu/device.hip",
                    "generatedMappingMode": "source_include_bridge",
                    "mappingConfidence": "generated_include_bridge_same_source"
                }
            ]
        });
        let generated = "#include \"synthi_gpu_runtime.h\"\n#include \"src/gpu/source_backed_kernel.h\"\nextern \"C\" __global__ void SourceBackedKernel(RenderState state) {\n  state.value = state.value + 1;\n}\n";
        assert!(kernel_regions(generated).contains_key("SourceBackedKernel"));

        let result = try_direct_device_body_patch(
            &meta,
            "src/gpu/source_backed_kernel.h",
            &next,
            generated,
        );

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert_eq!(result.patched_device_source.as_deref(), Some(generated));
        assert_eq!(
            result.affected_symbols,
            vec!["SourceBackedKernel".to_string()]
        );
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.source_include_bridge_recompile"));
        assert!(!result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.generated_body_patched"));
    }

    #[test]
    fn source_include_partial_recompile_does_not_require_generated_patch_anchor() {
        let before = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] += 1.0f");
        let next = before.replace("values[0] += 1.0f", "values[0] += 2.0f");
        let generated = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] = device_step(values[0])");
        let meta = source_include_recompile_fixture(
            &before,
            vec![
                json!({
                    "kind": "kernel",
                    "symbol": FIXTURE_SYMBOL,
                    "sourcePath": FIXTURE_SOURCE_PATH,
                    "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                    "mappingConfidence": "source_backed_partial"
                }),
            ],
            &[FIXTURE_SYMBOL],
        );

        let result = try_direct_device_body_patch(
            &meta,
            FIXTURE_SOURCE_PATH,
            &next,
            &generated,
        );

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert_eq!(result.patched_device_source.as_deref(), Some(generated.as_str()));
        assert_eq!(result.affected_symbols, vec![FIXTURE_SYMBOL.to_string()]);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.source_include_bridge_recompile"));
        assert!(!result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.generated_body_patched"));
    }

    #[test]
    fn source_include_partial_recompile_rejects_conflicting_symbol_identity() {
        let before = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] += 1.0f");
        let next = before.replace("values[0] += 1.0f", "values[0] += 2.0f");
        let generated = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] = device_step(values[0])");
        let meta = source_include_recompile_fixture(
            &before,
            vec![
                json!({
                    "kind": "kernel",
                    "symbol": FIXTURE_SYMBOL,
                    "qualifiedSourceName": "gpu::fixture_kernel_a",
                    "signatureHash": "signature-a",
                    "sourcePath": FIXTURE_SOURCE_PATH,
                    "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                    "mappingConfidence": "source_backed_partial"
                }),
                json!({
                    "kind": "kernel",
                    "symbol": FIXTURE_SYMBOL,
                    "qualifiedSourceName": "gpu::fixture_kernel_a",
                    "signatureHash": "signature-b",
                    "sourcePath": FIXTURE_SOURCE_PATH,
                    "generatedPath": FIXTURE_GENERATED_DEVICE_PATH,
                    "mappingConfidence": "source_backed_partial"
                }),
            ],
            &[FIXTURE_SYMBOL],
        );

        let result = try_direct_device_body_patch(
            &meta,
            FIXTURE_SOURCE_PATH,
            &next,
            &generated,
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "selection.symbol_identity_uncertain"));
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/rejectionRule")
                .and_then(Value::as_str),
            Some("selection.symbol_identity_uncertain")
        );
    }

    #[test]
    fn source_include_partial_recompile_rejects_unsafe_symbol_superset() {
        let before = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] += 1.0f");
        let next = before.replace("values[0] += 1.0f", "values[0] += 2.0f");
        let generated = fixture_kernel_body(FIXTURE_SYMBOL, "values[0] = device_step(values[0])");
        let meta = source_include_recompile_fixture(
            &before,
            vec![
                json!({
                    "kind": "kernel",
                    "symbol": FIXTURE_SYMBOL,
                    "sourcePath": FIXTURE_SOURCE_PATH,
                    "generatedPath": FIXTURE_GENERATED_DEVICE_PATH
                }),
                json!({
                    "kind": "kernel",
                    "symbol": FIXTURE_FOREIGN_SYMBOL,
                    "sourcePath": FIXTURE_FOREIGN_SOURCE_PATH,
                    "generatedPath": FIXTURE_GENERATED_DEVICE_PATH
                }),
            ],
            &[FIXTURE_SYMBOL, FIXTURE_FOREIGN_SYMBOL],
        );

        let result = try_direct_device_body_patch(
            &meta,
            FIXTURE_SOURCE_PATH,
            &next,
            &generated,
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "selection.unsafe_symbol_superset"));
    }

    #[test]
    fn macro_wrapped_ifdef_kernel_header_body_edit_is_detected() {
        let before = "#ifdef __KERNELCC__\nGLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n#else\nGLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)\n#endif\n{\n  render_data.random_number += 1;\n}\n";
        let after = before.replace("random_number += 1", "random_number += 3");

        assert_eq!(
            device_header_kernel_body_only_edit_symbol(before, &after).as_deref(),
            Some("CameraRays")
        );
    }

    #[test]
    fn kernel_region_detection_ignores_commented_macro_examples() {
        let source = r#"
// GLOBAL_KERNEL_SIGNATURE(void) CommentLine(RenderData data) {}
/* GLOBAL_KERNEL_SIGNATURE(void) CommentBlock(RenderData data) {} */
GLOBAL_KERNEL_SIGNATURE(void) LiveKernel(RenderData data) {
  data.value += 1;
}
"#;

        let regions = kernel_regions(source);

        assert_eq!(regions.keys().cloned().collect::<Vec<_>>(), vec!["LiveKernel"]);
    }

    #[test]
    fn hip_translation_unit_with_launch_syntax_can_use_body_fast_path() {
        let source = "#include <hip/hip_runtime.h>\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\nint main() {\n  flow<<<dim3(1), dim3(64), 0, hipStreamDefault>>>(nullptr, 1);\n}\n";
        let next = "#include <hip/hip_runtime.h>\n__global__ void flow(float* x, int n) {\n  x[0] += 2.0f;\n}\nint main() {\n  flow<<<dim3(1), dim3(64), 0, hipStreamDefault>>>(nullptr, 1);\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));
        let generated =
            "extern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n";

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
    fn macro_heavy_generated_parse_failure_can_use_lexical_kernel_region_fallback() {
        let source = "__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n";
        let next = "__global__ void flow(float* x, int n) {\n  x[0] += 2.0f;\n}\n";
        let generated = "#if defined(__KERNELCC__)\nextern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));

        let result = try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated);

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "parser.lexical_kernel_region_fallback"));
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("2.0f"));
    }

    #[test]
    fn partial_device_source_keeps_only_target_kernels() {
        let source = r#"
__device__ float helper(float x) { return x + 1.0f; }
extern "C" __global__ void shade(float* x) {
  x[0] = helper(x[0]);
}
extern "C" __global__ void trace(float* x) {
  x[0] = x[0] * 2.0f;
}
"#;

        let partial = build_device_partial_source(source, &["shade".to_string()]).unwrap();

        assert!(partial.len() < source.len());
        assert!(partial.contains("__device__ float helper"));
        assert!(partial.contains("__global__ void shade"));
        assert!(!partial.contains("__global__ void trace"));
        assert!(partial.contains("unchanged kernel omitted: trace"));
    }

    #[test]
    fn changed_kernel_body_symbols_reports_only_body_edits() {
        let before = r#"
extern "C" __global__ void shade(float* x) {
  x[0] = 1.0f;
}
extern "C" __global__ void trace(float* x) {
  x[0] = 2.0f;
}
"#;
        let after = before.replace("x[0] = 2.0f;", "x[0] = 3.0f;");

        assert_eq!(
            changed_kernel_body_symbols(before, &after),
            vec!["trace".to_string()]
        );
    }

    #[test]
    fn changed_kernel_body_symbols_declines_signature_drift() {
        let before = "extern \"C\" __global__ void shade(float* x) { x[0] = 1.0f; }\n";
        let after = "extern \"C\" __global__ void shade(float* x, int n) { x[0] = n; }\n";

        assert!(changed_kernel_body_symbols(before, after).is_empty());
    }

    #[test]
    fn partial_device_source_declines_when_it_cannot_shrink() {
        let source = "extern \"C\" __global__ void shade(float* x) {\n  x[0] = 1.0f;\n}\n";

        assert!(build_device_partial_source(source, &["shade".to_string()]).is_none());
    }

    #[test]
    fn include_bridge_partial_source_omits_unaffected_kernel_includes() {
        let source = "#include <hip/hip_runtime.h>\n#include \"synthi_gpu_runtime.h\"\n#include \"src/Device/includes/Common.h\"\n#include \"src/Device/kernels/CameraRays.h\"\n#include \"src/Device/kernels/Megakernel.h\"\n";

        let partial = build_device_include_bridge_partial_source(
            source,
            &["src/Device/kernels/CameraRays.h".to_string()],
            &["src/Device/kernels/Megakernel.h".to_string()],
        )
        .unwrap();

        assert!(partial.contains("#include <hip/hip_runtime.h>"));
        assert!(partial.contains("#include \"src/Device/includes/Common.h\""));
        assert!(partial.contains("#include \"src/Device/kernels/CameraRays.h\""));
        assert!(!partial.contains("#include \"src/Device/kernels/Megakernel.h\""));
        assert!(partial.contains("omitted source include from partial artifact"));
    }

    #[test]
    fn include_bridge_partial_source_declines_without_target_include() {
        let source = "#include \"src/Device/kernels/Megakernel.h\"\n";

        assert!(build_device_include_bridge_partial_source(
            source,
            &["src/Device/kernels/CameraRays.h".to_string()],
            &["src/Device/kernels/Megakernel.h".to_string()],
        )
        .is_none());
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
    fn global_namespace_qualifier_drift_uses_normalized_statement_anchor() {
        let source = "namespace scale_template { template <typename T> __device__ T gain(T v) { return v; } }\n__global__ void flow(float* x, int n) {\n  x[0] += ::scale_template::gain<float>(1.0f);\n}\n";
        let next = "namespace scale_template { template <typename T> __device__ T gain(T v) { return v; } }\n__global__ void flow(float* x, int n) {\n  x[0] -= ::scale_template::gain<float>(1.0f);\n}\n";
        let generated = "namespace scale_template { template <typename T> __device__ T gain(T v) { return v; } }\nextern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += scale_template::gain<float>(1.0f);\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"]["src/gpu/flow.hip"] = Value::String(source.to_string());
        meta["sourceBaselineHashes"]["src/gpu/flow.hip"] = Value::String(sha256_hex(source));

        let result = try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated);

        assert!(result.accepted, "{:?}", result.reason_codes);
        assert!(result
            .patched_device_source
            .as_deref()
            .unwrap_or_default()
            .contains("x[0] -= ::scale_template::gain<float>(1.0f);"));
    }

    #[test]
    fn statement_anchor_preserves_namespace_identity() {
        assert_eq!(
            normalize_statement_anchor("value += ::math::gain(input);"),
            normalize_statement_anchor("value += math::gain(input);")
        );
        assert_ne!(
            normalize_statement_anchor("value += math::gain(input);"),
            normalize_statement_anchor("value += mathgain(input);")
        );
        assert_ne!(
            normalize_statement_anchor("value += outer::gain(input);"),
            normalize_statement_anchor("value += gain(input);")
        );
    }

    #[test]
    fn direct_fast_path_rejects_translation_unit_surface_changes() {
        let kernel = "__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n";
        let cases = vec![
            (
                "include",
                "#include \"a.h\"\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "#include \"b.h\"\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.include_directive_changed",
            ),
            (
                "define",
                "#define SCALE 1\n__global__ void flow(float* x, int n) {\n  x[0] += SCALE;\n}\n",
                "#define SCALE 2\n__global__ void flow(float* x, int n) {\n  x[0] += SCALE;\n}\n",
                "abi.macro_directive_changed",
            ),
            (
                "body define",
                "__global__ void flow(float* x, int n) {\n#define SCALE 1\n  x[0] += SCALE;\n#undef SCALE\n}\n",
                "__global__ void flow(float* x, int n) {\n#define SCALE 2\n  x[0] += SCALE;\n#undef SCALE\n}\n",
                "abi.macro_directive_changed",
            ),
            (
                "body include",
                "__global__ void flow(float* x, int n) {\n#include \"path_a.inc\"\n  x[0] += 1.0f;\n}\n",
                "__global__ void flow(float* x, int n) {\n#include \"path_b.inc\"\n  x[0] += 1.0f;\n}\n",
                "abi.include_directive_changed",
            ),
            (
                "preprocessor condition",
                "#if defined(USE_PRIMARY)\nstruct Params { float a; };\n#endif\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "#if defined(USE_SECONDARY)\nstruct Params { float a; };\n#endif\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.preprocessor_condition_changed",
            ),
            (
                "body preprocessor condition",
                "__global__ void flow(float* x, int n) {\n#if defined(USE_PRIMARY)\n  x[0] += 1.0f;\n#endif\n}\n",
                "__global__ void flow(float* x, int n) {\n#if defined(USE_SECONDARY)\n  x[0] += 1.0f;\n#endif\n}\n",
                "abi.preprocessor_condition_changed",
            ),
            (
                "using",
                "using Scalar = float;\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "using Scalar = double;\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.using_declaration_changed",
            ),
            (
                "body using",
                "__global__ void flow(float* x, int n) {\n  using Scalar = float;\n  x[0] += Scalar{1.0f};\n}\n",
                "__global__ void flow(float* x, int n) {\n  using Scalar = double;\n  x[0] += Scalar{1.0f};\n}\n",
                "abi.using_declaration_changed",
            ),
            (
                "typedef",
                "typedef float Scalar;\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "typedef double Scalar;\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.type_alias_changed",
            ),
            (
                "body typedef",
                "__global__ void flow(float* x, int n) {\n  typedef float Scalar;\n  x[0] += Scalar{1.0f};\n}\n",
                "__global__ void flow(float* x, int n) {\n  typedef double Scalar;\n  x[0] += Scalar{1.0f};\n}\n",
                "abi.type_alias_changed",
            ),
            (
                "extern",
                "extern float table[];\n__global__ void flow(float* x, int n) {\n  x[0] += table[0];\n}\n",
                "extern double table[];\n__global__ void flow(float* x, int n) {\n  x[0] += table[0];\n}\n",
                "abi.extern_declaration_changed",
            ),
            (
                "body extern",
                "__global__ void flow(float* x, int n) {\n  extern float table[];\n  x[0] += table[0];\n}\n",
                "__global__ void flow(float* x, int n) {\n  extern double table[];\n  x[0] += table[0];\n}\n",
                "abi.extern_declaration_changed",
            ),
            (
                "type layout",
                "struct Params { float a; };\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "struct Params { float a; float b; };\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.type_layout_changed",
            ),
            (
                "body type layout",
                "__global__ void flow(float* x, int n) {\n  struct Local { float a; };\n  Local v{1.0f};\n  x[0] += v.a;\n}\n",
                "__global__ void flow(float* x, int n) {\n  struct Local { float a; float b; };\n  Local v{1.0f, 2.0f};\n  x[0] += v.a;\n}\n",
                "abi.type_layout_changed",
            ),
            (
                "enum layout",
                "enum class Mode : int { Primary = 1 };\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "enum class Mode : int { Primary = 1, Secondary = 2 };\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.type_layout_changed",
            ),
            (
                "body enum layout",
                "__global__ void flow(float* x, int n) {\n  enum Mode { Primary = 1 };\n  x[0] += float(Primary);\n}\n",
                "__global__ void flow(float* x, int n) {\n  enum Mode { Primary = 1, Secondary = 2 };\n  x[0] += float(Primary);\n}\n",
                "abi.type_layout_changed",
            ),
            (
                "namespace",
                "namespace gpu { }\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "namespace gpu2 { }\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.namespace_changed",
            ),
            (
                "static constexpr",
                "static constexpr float kGain = 1.0f;\n__global__ void flow(float* x, int n) {\n  x[0] += kGain;\n}\n",
                "static constexpr float kGain = 2.0f;\n__global__ void flow(float* x, int n) {\n  x[0] += kGain;\n}\n",
                "abi.static_constexpr_data_changed",
            ),
            (
                "body static constexpr",
                "__global__ void flow(float* x, int n) {\n  static constexpr float kGain = 1.0f;\n  x[0] += kGain;\n}\n",
                "__global__ void flow(float* x, int n) {\n  static constexpr float kGain = 2.0f;\n  x[0] += kGain;\n}\n",
                "abi.static_constexpr_data_changed",
            ),
            (
                "device function signature",
                "__device__ float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "__device__ float helper(float x, float y) { return x + y; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f, 2.0f);\n}\n",
                "abi.device_function_signature_changed",
            ),
            (
                "device function return type",
                "__device__ float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "__device__ double helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.device_function_signature_changed",
            ),
            (
                "device function default argument",
                "__device__ float helper(float x = 1.0f) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper();\n}\n",
                "__device__ float helper(float x = 2.0f) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper();\n}\n",
                "abi.device_function_signature_changed",
            ),
            (
                "device function body",
                "__device__ float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "__device__ float helper(float x) { return x + 1.0f; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.device_function_body_changed",
            ),
            (
                "macro annotated device function body",
                "PROJECT_DEVICE float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "PROJECT_DEVICE float helper(float x) { return x + 1.0f; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.device_function_body_changed",
            ),
            (
                "macro annotated device function signature",
                "PROJECT_DEVICE float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "PROJECT_DEVICE double helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.device_function_signature_changed",
            ),
            (
                "inline device function body",
                "__device__ inline float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "__device__ inline float helper(float x) { return x + 1.0f; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.device_function_body_changed",
            ),
            (
                "overload set",
                "__device__ float helper(float x) { return x; }\n__device__ int helper(int x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "__device__ float helper(float x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.overload_set_changed",
            ),
            (
                "template",
                "template <typename T> __device__ T helper(T x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "template <typename T, typename U> __device__ T helper(T x) { return x; }\n__global__ void flow(float* x, int n) {\n  x[0] += helper(1.0f);\n}\n",
                "abi.template_declaration_changed",
            ),
            (
                "kernel extern c linkage",
                "extern \"C\" __global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.kernel_signature_changed",
            ),
            (
                "kernel launch bounds",
                "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)\nflow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(128)\nflow(float* x, int n) {\n  x[0] += 1.0f;\n}\n",
                "abi.kernel_signature_changed",
            ),
        ];

        for (name, before, after, reason) in cases {
            let result = try_direct_device_body_patch(
                &sidecar_with_source(before),
                "src/gpu/flow.hip",
                after,
                kernel,
            );
            assert!(
                !result.accepted,
                "case {name} unexpectedly accepted: {:?}",
                result.reason_codes
            );
            assert!(
                result.reason_codes.iter().any(|code| code == reason),
                "case {name} expected {reason}, got {:?}",
                result.reason_codes
            );
        }
    }

    #[test]
    fn device_header_detection_accepts_generic_device_annotation_macros() {
        assert!(is_device_header_kernel_source_path(
            "src/device/helper.hpp",
            "PROJECT_DEVICE float helper(float x) { return x; }\n"
        ));
        assert!(is_device_header_kernel_source_path(
            "src/device/helper.hpp",
            "GPU_HOST_DEVICE float helper(float x) { return x; }\n"
        ));
        assert!(!is_device_header_kernel_source_path(
            "src/device/helper.hpp",
            "// PROJECT_DEVICE float helper(float x) { return x; }\n"
        ));
    }

    #[test]
    fn direct_fast_path_rejects_device_and_constant_global_changes() {
        let device_global =
            "__device__ float gain;\n__global__ void flow(float* x, int n) {\n  x[0] += gain;\n}\n";
        let changed_device_global =
            "__device__ double gain;\n__global__ void flow(float* x, int n) {\n  x[0] += gain;\n}\n";
        let result = try_direct_device_body_patch(
            &sidecar_with_source(device_global),
            "src/gpu/flow.hip",
            changed_device_global,
            generated_source(),
        );
        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "abi.constant_global_layout_changed"));
    }

    #[test]
    fn direct_fast_path_rejects_duplicate_kernel_source_identity() {
        let source = "namespace primary {\n__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n}\nnamespace secondary {\n__global__ void flow(float* x, int n) {\n  x[0] += 2.0f;\n}\n}\n";
        let next = source.replace("x[0] += 2.0f;", "x[0] += 3.0f;");
        let result = try_direct_device_body_patch(
            &sidecar_with_source(source),
            "src/gpu/flow.hip",
            &next,
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.ambiguous_source_symbol_identity"));
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
    fn mapping_report_unmapped_reason_is_preserved() {
        let mut ambiguous_mapping = sidecar();
        ambiguous_mapping["deviceMappings"] = Value::Array(Vec::new());
        ambiguous_mapping["deviceMappingReport"] = json!({
            "unmappedKernels": [
                {
                    "sourcePath": "src/gpu/flow.hip",
                    "symbol": "flow",
                    "reason": "ambiguous_source_symbol_identity"
                }
            ]
        });
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] * 2.0f;\n}\n";

        let result = try_direct_device_body_patch(
            &ambiguous_mapping,
            "src/gpu/flow.hip",
            next,
            generated_source(),
        );

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.ambiguous_source_symbol_identity"));
        assert!(!result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.device_mapping_missing"));
        assert_eq!(
            result
                .verifier_report
                .pointer("/evidence/rejectionRule")
                .and_then(Value::as_str),
            Some("mapping.ambiguous_source_symbol_identity")
        );
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
        missing
            .as_object_mut()
            .unwrap()
            .remove("selectedCompileCommand");

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
        missing
            .as_object_mut()
            .unwrap()
            .remove("effectiveFlagsHash");
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

    #[test]
    fn fast_path_logical_path_normalization_collapses_anchored_segments() {
        assert_eq!(normalize_path(r".\src\gpu\flow.hip"), "src/gpu/flow.hip");
        assert_eq!(normalize_path("src/device/../gpu/flow.hip"), "src/gpu/flow.hip");
        assert_eq!(normalize_path("/workspace/src/../gpu/flow.hip"), "/workspace/gpu/flow.hip");
        assert_eq!(normalize_path("../src/gpu/flow.hip"), "../src/gpu/flow.hip");
        assert_eq!(normalize_path("../../src/./gpu/flow.hip"), "../../src/gpu/flow.hip");
    }

    #[test]
    fn baseline_lookup_accepts_normalized_single_path_identity() {
        let source = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n";
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] * 2.0f;\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"] = json!({
            r".\src\gpu\flow.hip": source
        });
        meta["sourceBaselineHashes"] = json!({
            r".\src\gpu\flow.hip": sha256_hex(source)
        });

        let result =
            try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated_source());

        assert!(result.accepted);
    }

    #[test]
    fn baseline_lookup_rejects_ambiguous_normalized_path_identity() {
        let source = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0];\n}\n";
        let other_source = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] + 1.0f;\n}\n";
        let next = "__constant__ float gain[1];\n__global__ void flow(float* x, int n) {\n  x[0] += gain[0] * 2.0f;\n}\n";
        let mut meta = sidecar();
        meta["sourceBaselineContents"] = json!({
            "src/gpu/flow.hip": source,
            "./src/gpu/flow.hip": other_source
        });

        let result =
            try_direct_device_body_patch(&meta, "src/gpu/flow.hip", next, generated_source());

        assert!(!result.accepted);
        assert!(result
            .reason_codes
            .iter()
            .any(|code| code == "mapping.source_baseline_path_ambiguous"));
    }
}
