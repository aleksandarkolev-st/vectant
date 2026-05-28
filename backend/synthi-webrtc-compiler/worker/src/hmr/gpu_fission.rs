use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const FISSION_ISLAND_SCHEMA_VERSION: &str = "synthi.gpu.fission_island.v1";
pub const FISSION_VERIFIER_SCHEMA_VERSION: &str = "synthi.gpu.fission_verifier.v1";

const REQUIRED_STRING_FIELDS: &[&str] = &[
    "islandId",
    "sourceEditId",
    "artifactKind",
    "dependencyClosureHash",
    "abiMembraneId",
    "compileRecipeHash",
    "compileCommandHash",
];

const REQUIRED_NON_EMPTY_ARRAY_FIELDS: &[&str] = &[
    "sourcePaths",
    "sourceSpans",
    "targetSymbols",
    "exportedSymbolsExpected",
    "verifierEvidenceIds",
];

pub fn verify_fission_candidates(value: &Value) -> Value {
    let candidates = collect_candidates(value);
    if candidates.is_empty() {
        return json!({
            "schemaVersion": FISSION_VERIFIER_SCHEMA_VERSION,
            "selectionPolicy": "narrowest_viable_generic_v1",
            "status": "missing",
            "candidateCount": 0,
            "acceptedCount": 0,
            "rejectedCount": 0,
            "selectedIslandId": null,
            "selectedCandidateIndex": null,
            "reasonCodes": ["fission.candidate_missing"],
            "candidates": [],
        });
    }

    let mut accepted_count = 0usize;
    let mut rejected_count = 0usize;
    let mut reports = Vec::new();

    for candidate in candidates {
        let report = verify_fission_candidate(&candidate);
        if report.get("status").and_then(Value::as_str) == Some("pass") {
            accepted_count += 1;
        } else {
            rejected_count += 1;
        }
        reports.push(report);
    }

    let selected_candidate_index = select_narrowest_candidate_index(&reports);
    for (index, report) in reports.iter_mut().enumerate() {
        if let Some(object) = report.as_object_mut() {
            object.insert(
                "selected".to_string(),
                Value::Bool(selected_candidate_index == Some(index)),
            );
        }
    }
    let selected_island_id = selected_candidate_index
        .and_then(|index| reports.get(index))
        .and_then(|report| report.get("islandId"))
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or(Value::Null);

    let status = if accepted_count > 0 { "pass" } else { "reject" };
    let reason_codes = if accepted_count > 0 {
        vec!["fission.candidate_accepted"]
    } else {
        vec!["fission.no_accepted_candidate"]
    };

    json!({
        "schemaVersion": FISSION_VERIFIER_SCHEMA_VERSION,
        "selectionPolicy": "narrowest_viable_generic_v1",
        "status": status,
        "candidateCount": reports.len(),
        "acceptedCount": accepted_count,
        "rejectedCount": rejected_count,
        "selectedIslandId": selected_island_id,
        "selectedCandidateIndex": selected_candidate_index,
        "reasonCodes": reason_codes,
        "candidates": reports,
    })
}

pub fn verify_fission_candidate(candidate: &Value) -> Value {
    let mut reason_codes = Vec::new();

    if !candidate.is_object() {
        reason_codes.push("fission.candidate_not_object".to_string());
    }

    for field in REQUIRED_STRING_FIELDS {
        if !non_empty_string(candidate.get(*field)) {
            reason_codes.push(format!("fission.{field}_missing"));
        }
    }

    for field in REQUIRED_NON_EMPTY_ARRAY_FIELDS {
        if !non_empty_array(candidate.get(*field)) {
            reason_codes.push(format!("fission.{field}_missing"));
        }
    }

    if !source_paths_valid(candidate) {
        reason_codes.push("fission.source_path_invalid".to_string());
    }

    if !deterministic_verifier_evidence_present(candidate) {
        reason_codes.push("fission.deterministic_verifier_evidence_missing".to_string());
    }

    if !candidate
        .get("sourceSpans")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(valid_source_span))
    {
        reason_codes.push("fission.source_span_invalid".to_string());
    }

    if !source_spans_within_declared_paths(candidate) {
        reason_codes.push("fission.source_span_path_unmapped".to_string());
    }

    if !candidate.get("includeClosure").is_some_and(Value::is_array) {
        reason_codes.push("fission.includeClosure_missing".to_string());
    } else if !include_closure_valid(candidate) {
        reason_codes.push("fission.includeClosure_invalid".to_string());
    }

    if !loader_capability_present(candidate.get("loaderCapabilityRequirement")) {
        reason_codes.push("fission.loader_capability_requirement_missing".to_string());
    }

    if !oracle_requirement_present(candidate) {
        reason_codes.push("fission.output_oracle_missing".to_string());
    }

    if !target_symbols_exported(candidate) {
        reason_codes.push("fission.target_symbol_not_exported".to_string());
    }

    if !safe_export_superset_justified(candidate) {
        reason_codes.push("fission.safe_export_superset_unverified".to_string());
    }

    if !narrower_rejection_coverage_complete(candidate) {
        reason_codes.push("fission.narrower_candidate_rejections_incomplete".to_string());
    }

    let status = if reason_codes.is_empty() {
        reason_codes.push("fission.candidate_verified".to_string());
        "pass"
    } else {
        "reject"
    };

    json!({
        "schemaVersion": FISSION_ISLAND_SCHEMA_VERSION,
        "status": status,
        "islandId": candidate.get("islandId").cloned().unwrap_or(Value::Null),
        "sourceEditId": candidate.get("sourceEditId").cloned().unwrap_or(Value::Null),
        "aiProposalId": candidate.get("aiProposalId").cloned().unwrap_or(Value::Null),
        "reasonCodes": reason_codes,
        "deterministicVerifierEvidenceIds": deterministic_verifier_evidence_ids(candidate),
        "nonAuthoritativeEvidenceIds": non_authoritative_evidence_ids(candidate),
        "normalizedSourcePaths": normalized_source_paths(candidate),
        "unmappedSourceSpanPaths": unmapped_source_span_paths(candidate),
        "normalizedIncludeClosurePaths": normalized_include_closure_paths(candidate),
        "invalidIncludeClosureEntries": invalid_include_closure_entries(candidate),
        "safeExportSupersetSymbols": safe_export_superset_symbols(candidate),
        "safeExportSupersetEvidenceIds": safe_export_superset_evidence_ids(candidate),
        "narrowerRejectionCoverage": narrower_rejection_coverage(candidate),
        "selectionScore": fission_selection_score(candidate),
        "verifierEvidenceId": verifier_evidence_id(candidate, status),
        "candidate": candidate,
    })
}

fn collect_candidates(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::Object(_) => vec![value.clone()],
        _ => Vec::new(),
    }
}

fn non_empty_string(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|items| !items.is_empty())
}

fn valid_source_span(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if !object
        .get("path")
        .and_then(Value::as_str)
        .and_then(normalized_project_path)
        .is_some()
    {
        return false;
    }
    let line_range = positive_u64(object.get("startLine"))
        .zip(positive_u64(object.get("endLine")))
        .is_some_and(|(start, end)| start <= end);
    let byte_range = zero_based_u64(object.get("startByte"))
        .zip(zero_based_u64(object.get("endByte")))
        .is_some_and(|(start, end)| start < end);
    line_range || byte_range
}

fn source_paths_valid(candidate: &Value) -> bool {
    let paths = string_list(candidate.get("sourcePaths"));
    !paths.is_empty()
        && paths
            .iter()
            .all(|path| normalized_project_path(path).is_some())
}

fn source_spans_within_declared_paths(candidate: &Value) -> bool {
    unmapped_source_span_paths(candidate).is_empty()
}

fn normalized_source_paths(candidate: &Value) -> Vec<String> {
    string_list(candidate.get("sourcePaths"))
        .into_iter()
        .filter_map(|path| normalized_project_path(&path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn unmapped_source_span_paths(candidate: &Value) -> Vec<String> {
    let declared_paths: BTreeSet<String> = normalized_source_paths(candidate).into_iter().collect();
    candidate
        .get("sourceSpans")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("path").and_then(Value::as_str))
                .filter(|path| {
                    normalized_project_path(path)
                        .as_ref()
                        .is_none_or(|normalized| !declared_paths.contains(normalized))
                })
                .map(|path| path.trim().to_string())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn normalized_project_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized_separators = trimmed.replace('\\', "/");
    if normalized_separators.starts_with('/')
        || normalized_separators.starts_with('~')
        || normalized_separators.contains("://")
        || looks_like_drive_absolute_path(&normalized_separators)
    {
        return None;
    }

    let mut segments = Vec::new();
    for segment in normalized_separators.split('/') {
        match segment {
            "" | "." => {}
            ".." => return None,
            value => segments.push(value),
        }
    }

    if segments.is_empty() {
        None
    } else {
        Some(segments.join("/"))
    }
}

fn looks_like_drive_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn include_closure_valid(candidate: &Value) -> bool {
    invalid_include_closure_entries(candidate).is_empty()
}

fn normalized_include_closure_paths(candidate: &Value) -> Vec<String> {
    candidate
        .get("includeClosure")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(include_closure_entry_path)
                .filter_map(|path| normalized_project_path(&path))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn invalid_include_closure_entries(candidate: &Value) -> Vec<String> {
    candidate
        .get("includeClosure")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    include_closure_entry_path(item)
                        .and_then(|path| normalized_project_path(&path))
                        .is_none()
                })
                .map(include_closure_entry_label)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn include_closure_entry_path(value: &Value) -> Option<String> {
    match value {
        Value::String(path) => Some(path.trim().to_string()),
        Value::Object(object) => object
            .get("path")
            .and_then(Value::as_str)
            .map(|path| path.trim().to_string()),
        _ => None,
    }
}

fn include_closure_entry_label(value: &Value) -> String {
    match include_closure_entry_path(value) {
        Some(path) if !path.is_empty() => path,
        _ => "missing-path".to_string(),
    }
}

fn loader_capability_present(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Object(object)) => !object.is_empty(),
        _ => false,
    }
}

fn oracle_requirement_present(candidate: &Value) -> bool {
    non_empty_string(candidate.get("requiredOracleId"))
        || candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(|object| !object.is_empty())
}

fn target_symbols_exported(candidate: &Value) -> bool {
    let targets = string_set(candidate.get("targetSymbols"));
    let exports = string_set(candidate.get("exportedSymbolsExpected"));
    !targets.is_empty() && targets.is_subset(&exports)
}

fn safe_export_superset_justified(candidate: &Value) -> bool {
    let extra_symbols = safe_export_superset_symbols(candidate);
    extra_symbols.is_empty()
        || (non_empty_string(candidate.get("safeExportSupersetReason"))
            && !safe_export_superset_evidence_ids(candidate).is_empty())
}

fn safe_export_superset_symbols(candidate: &Value) -> Vec<String> {
    let targets = string_set(candidate.get("targetSymbols"));
    string_set(candidate.get("exportedSymbolsExpected"))
        .difference(&targets)
        .cloned()
        .collect()
}

fn safe_export_superset_evidence_ids(candidate: &Value) -> Vec<String> {
    let specific = string_list(candidate.get("safeExportSupersetEvidenceIds"));
    if specific.is_empty() {
        deterministic_verifier_evidence_ids(candidate)
    } else {
        specific
            .into_iter()
            .filter(|id| is_deterministic_verifier_evidence_id(id))
            .collect()
    }
}

fn narrower_rejection_coverage_complete(candidate: &Value) -> bool {
    let selected_scope_rank = replacement_scope_rank(candidate);
    if selected_scope_rank == 0 {
        return true;
    }
    missing_narrower_rejection_ranks(candidate).is_empty()
}

fn narrower_rejection_coverage(candidate: &Value) -> Value {
    let selected_scope_rank = replacement_scope_rank(candidate);
    let covered_ranks = covered_narrower_rejection_ranks(candidate, selected_scope_rank);
    let missing_ranks = missing_narrower_rejection_ranks(candidate);
    json!({
        "selectedScopeRank": selected_scope_rank,
        "requiredRanks": (0..selected_scope_rank).collect::<Vec<_>>(),
        "coveredRanks": covered_ranks,
        "missingRanks": missing_ranks,
        "evidenceIds": narrower_rejection_evidence_ids(candidate),
    })
}

fn missing_narrower_rejection_ranks(candidate: &Value) -> Vec<u64> {
    let selected_scope_rank = replacement_scope_rank(candidate);
    let covered: BTreeSet<u64> = covered_narrower_rejection_ranks(candidate, selected_scope_rank)
        .into_iter()
        .collect();
    (0..selected_scope_rank)
        .filter(|rank| !covered.contains(rank))
        .collect()
}

fn covered_narrower_rejection_ranks(candidate: &Value, selected_scope_rank: u64) -> Vec<u64> {
    candidate
        .get("narrowerCandidateRejections")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| valid_narrower_rejection_scope_rank(item, selected_scope_rank))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn valid_narrower_rejection_scope_rank(value: &Value, selected_scope_rank: u64) -> Option<u64> {
    let scope_rank = narrower_rejection_scope_rank(value)?;
    if scope_rank >= selected_scope_rank {
        return None;
    }
    if !narrower_rejection_reason_present(value)
        || narrower_rejection_evidence_ids_for(value).is_empty()
    {
        return None;
    }
    Some(scope_rank)
}

fn narrower_rejection_scope_rank(value: &Value) -> Option<u64> {
    if let Some(rank) = value.get("scopeRank").and_then(Value::as_u64) {
        return Some(rank);
    }

    let object = value.as_object()?;
    let has_scope_text = ["replacementScope", "artifactScope", "scope", "artifactKind"]
        .iter()
        .any(|field| object.get(*field).and_then(Value::as_str).is_some());
    if has_scope_text {
        Some(replacement_scope_rank(value))
    } else {
        None
    }
}

fn narrower_rejection_reason_present(value: &Value) -> bool {
    non_empty_string(value.get("reasonCode"))
        || value
            .get("reasonCodes")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| non_empty_string(Some(item))))
}

fn narrower_rejection_evidence_ids(candidate: &Value) -> Vec<String> {
    candidate
        .get("narrowerCandidateRejections")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .flat_map(narrower_rejection_evidence_ids_for)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

fn narrower_rejection_evidence_ids_for(value: &Value) -> Vec<String> {
    [
        "verifierEvidenceIds",
        "evidenceIds",
        "rejectionEvidenceIds",
        "proofEvidenceIds",
    ]
    .iter()
    .flat_map(|field| string_list(value.get(*field)))
    .filter(|id| is_deterministic_verifier_evidence_id(id))
    .collect()
}

fn deterministic_verifier_evidence_present(candidate: &Value) -> bool {
    !deterministic_verifier_evidence_ids(candidate).is_empty()
}

fn deterministic_verifier_evidence_ids(candidate: &Value) -> Vec<String> {
    string_list(candidate.get("verifierEvidenceIds"))
        .into_iter()
        .filter(|id| is_deterministic_verifier_evidence_id(id))
        .collect()
}

fn non_authoritative_evidence_ids(candidate: &Value) -> Vec<String> {
    string_list(candidate.get("verifierEvidenceIds"))
        .into_iter()
        .filter(|id| !is_deterministic_verifier_evidence_id(id))
        .collect()
}

fn is_deterministic_verifier_evidence_id(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.starts_with("ai:")
        || normalized.starts_with("llm:")
        || normalized.starts_with("model:")
        || normalized.contains("proposal")
    {
        return false;
    }
    normalized.starts_with("evidence:")
        || normalized.starts_with("verifier:")
        || normalized.starts_with("fission-verifier:")
        || normalized.starts_with("proof:")
}

fn select_narrowest_candidate_index(reports: &[Value]) -> Option<usize> {
    reports
        .iter()
        .enumerate()
        .filter(|(_, report)| report.get("status").and_then(Value::as_str) == Some("pass"))
        .min_by(|(left_index, left), (right_index, right)| {
            let left_score = selection_score_total(left).unwrap_or(u64::MAX);
            let right_score = selection_score_total(right).unwrap_or(u64::MAX);
            left_score
                .cmp(&right_score)
                .then_with(|| verifier_evidence_id_value(left).cmp(&verifier_evidence_id_value(right)))
                .then_with(|| left_index.cmp(right_index))
        })
        .map(|(index, _)| index)
}

fn selection_score_total(report: &Value) -> Option<u64> {
    report
        .get("selectionScore")
        .and_then(|score| score.get("total"))
        .and_then(Value::as_u64)
}

fn verifier_evidence_id_value(report: &Value) -> String {
    report
        .get("verifierEvidenceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn fission_selection_score(candidate: &Value) -> Value {
    let target_symbol_count = string_set(candidate.get("targetSymbols")).len() as u64;
    let exported_symbol_count = string_set(candidate.get("exportedSymbolsExpected")).len() as u64;
    let source_path_count = string_set(candidate.get("sourcePaths")).len() as u64;
    let include_closure_count = candidate
        .get("includeClosure")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);
    let source_span_extent = source_span_extent(candidate.get("sourceSpans"));
    let scope_rank = replacement_scope_rank(candidate);
    let exported_symbol_overage = exported_symbol_count.saturating_sub(target_symbol_count);
    let total = scope_rank
        .saturating_mul(1_000_000_000)
        .saturating_add(target_symbol_count.saturating_mul(10_000_000))
        .saturating_add(exported_symbol_overage.saturating_mul(1_000_000))
        .saturating_add(source_path_count.saturating_mul(100_000))
        .saturating_add(include_closure_count.saturating_mul(1_000))
        .saturating_add(source_span_extent.min(999));
    json!({
        "policy": "narrowest_viable_generic_v1",
        "total": total,
        "scopeRank": scope_rank,
        "targetSymbolCount": target_symbol_count,
        "exportedSymbolCount": exported_symbol_count,
        "exportedSymbolOverage": exported_symbol_overage,
        "sourcePathCount": source_path_count,
        "includeClosureCount": include_closure_count,
        "sourceSpanExtent": source_span_extent,
    })
}

fn replacement_scope_rank(candidate: &Value) -> u64 {
    let mut scope_text = Vec::new();
    for field in ["replacementScope", "artifactScope", "scope", "artifactKind"] {
        if let Some(value) = candidate.get(field).and_then(Value::as_str) {
            scope_text.push(normalized_scope_text(value));
        }
    }
    let scope_text = scope_text.join(" ");
    if scope_text.is_empty() {
        return 2;
    }
    if scope_text.contains("body") || scope_text.contains("function") {
        0
    } else if scope_text.contains("source_include")
        || (scope_text.contains("partial") && scope_text.contains("device"))
    {
        1
    } else if scope_text.contains("multi") {
        2
    } else if scope_text.contains("full")
        && (scope_text.contains("device") || scope_text.contains("module"))
    {
        3
    } else if scope_text.contains("host") {
        4
    } else if scope_text.contains("runner")
        || scope_text.contains("process")
        || scope_text.contains("restart")
    {
        5
    } else {
        2
    }
}

fn normalized_scope_text(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn source_span_extent(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    byte_span_extent(item)
                        .or_else(|| line_span_extent(item))
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

fn byte_span_extent(value: &Value) -> Option<u64> {
    let object = value.as_object()?;
    zero_based_u64(object.get("startByte"))
        .zip(zero_based_u64(object.get("endByte")))
        .and_then(|(start, end)| end.checked_sub(start))
        .filter(|extent| *extent > 0)
}

fn line_span_extent(value: &Value) -> Option<u64> {
    let object = value.as_object()?;
    positive_u64(object.get("startLine"))
        .zip(positive_u64(object.get("endLine")))
        .and_then(|(start, end)| end.checked_sub(start).map(|extent| extent + 1))
        .filter(|extent| *extent > 0)
}

fn string_set(value: Option<&Value>) -> BTreeSet<String> {
    string_list(value).into_iter().collect()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn positive_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|v| *v > 0)
}

fn zero_based_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn verifier_evidence_id(candidate: &Value, status: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(status.as_bytes());
    hasher.update(b"\0");
    hasher.update(serde_json::to_vec(candidate).unwrap_or_default());
    format!("fission-verifier:sha256:{}", hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_candidate() -> Value {
        json!({
            "islandId": "island:sha256:1",
            "sourceEditId": "edit:1",
            "sourcePaths": ["src/device.kernel"],
            "sourceSpans": [{"path": "src/device.kernel", "startLine": 10, "endLine": 12}],
            "targetSymbols": ["step"],
            "exportedSymbolsExpected": ["step", "helper"],
            "artifactKind": "device_partial",
            "safeExportSupersetReason": "helper symbol is verifier-owned dependency closure",
            "includeClosure": [],
            "dependencyClosureHash": "sha256:dependency",
            "abiMembraneId": "abi:membrane",
            "compileRecipeHash": "sha256:recipe",
            "compileCommandHash": "sha256:command",
            "loaderCapabilityRequirement": {"transport": "content_addressed_blob"},
            "requiredOracleId": "oracle:sentinel",
            "verifierEvidenceIds": ["evidence:source-map"],
            "narrowerCandidateRejections": [
                {
                    "scopeRank": 0,
                    "reasonCode": "fission.edit_crosses_body_boundary",
                    "verifierEvidenceIds": ["evidence:source-map"]
                }
            ],
        })
    }

    #[test]
    fn accepts_complete_generic_candidate() {
        let report = verify_fission_candidates(&json!([valid_candidate()]));

        assert_eq!(report["status"], "pass");
        assert_eq!(report["acceptedCount"], 1);
        assert_eq!(report["selectedIslandId"], "island:sha256:1");
        assert_eq!(report["selectedCandidateIndex"], 0);
        assert_eq!(report["candidates"][0]["status"], "pass");
        assert_eq!(report["candidates"][0]["selected"], true);
        assert_eq!(
            report["candidates"][0]["reasonCodes"][0],
            "fission.candidate_verified"
        );
    }

    #[test]
    fn rejects_candidate_without_oracle() {
        let mut candidate = valid_candidate();
        candidate.as_object_mut().unwrap().remove("requiredOracleId");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
    }

    #[test]
    fn rejects_candidate_when_target_symbol_is_not_expected_export() {
        let mut candidate = valid_candidate();
        candidate["exportedSymbolsExpected"] = json!(["helper"]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.target_symbol_not_exported"));
    }

    #[test]
    fn rejects_source_span_outside_declared_source_paths() {
        let mut candidate = valid_candidate();
        candidate["sourceSpans"] =
            json!([{"path": "src/other.kernel", "startLine": 10, "endLine": 12}]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["unmappedSourceSpanPaths"], json!(["src/other.kernel"]));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.source_span_path_unmapped"));
    }

    #[test]
    fn accepts_normalized_source_span_paths() {
        let mut candidate = valid_candidate();
        candidate["sourcePaths"] = json!(["src/device.kernel"]);
        candidate["sourceSpans"] =
            json!([{"path": ".\\src\\device.kernel", "startLine": 10, "endLine": 12}]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["normalizedSourcePaths"], json!(["src/device.kernel"]));
        assert_eq!(report["unmappedSourceSpanPaths"], json!([]));
    }

    #[test]
    fn rejects_source_paths_that_escape_workspace() {
        let mut candidate = valid_candidate();
        candidate["sourcePaths"] = json!(["../device.kernel"]);
        candidate["sourceSpans"] =
            json!([{"path": "../device.kernel", "startLine": 10, "endLine": 12}]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.source_path_invalid"));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.source_span_invalid"));
    }

    #[test]
    fn accepts_normalized_include_closure_paths() {
        let mut candidate = valid_candidate();
        candidate["includeClosure"] = json!([
            "include/math.h",
            {"path": ".\\include\\device.h"}
        ]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["normalizedIncludeClosurePaths"],
            json!(["include/device.h", "include/math.h"])
        );
        assert_eq!(report["invalidIncludeClosureEntries"], json!([]));
    }

    #[test]
    fn rejects_invalid_include_closure_paths() {
        let mut candidate = valid_candidate();
        candidate["includeClosure"] = json!(["include/math.h", "../secrets.h", {"path": ""}]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["invalidIncludeClosureEntries"],
            json!(["../secrets.h", "missing-path"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.includeClosure_invalid"));
    }

    #[test]
    fn rejects_unjustified_safe_export_superset() {
        let mut candidate = valid_candidate();
        candidate.as_object_mut().unwrap().remove("safeExportSupersetReason");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["safeExportSupersetSymbols"], json!(["helper"]));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.safe_export_superset_unverified"));
    }

    #[test]
    fn rejects_wider_candidate_without_narrower_rejection_proof() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("narrowerCandidateRejections");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["narrowerRejectionCoverage"]["missingRanks"],
            json!([0])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.narrower_candidate_rejections_incomplete"));
    }

    #[test]
    fn rejects_incomplete_narrower_rejection_coverage_for_full_device_candidate() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("full_device_module");
        candidate["narrowerCandidateRejections"] = json!([
            {
                "scopeRank": 0,
                "reasonCode": "fission.edit_crosses_body_boundary",
                "verifierEvidenceIds": ["evidence:source-map"]
            },
            {
                "scopeRank": 1,
                "reasonCode": "fission.include_closure_unknown",
                "verifierEvidenceIds": ["evidence:include-closure"]
            }
        ]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["narrowerRejectionCoverage"]["coveredRanks"],
            json!([0, 1])
        );
        assert_eq!(
            report["narrowerRejectionCoverage"]["missingRanks"],
            json!([2])
        );
    }

    #[test]
    fn accepts_body_scope_without_narrower_rejection_proof() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("function_body");
        candidate["exportedSymbolsExpected"] = json!(["step"]);
        candidate.as_object_mut().unwrap().remove("safeExportSupersetReason");
        candidate
            .as_object_mut()
            .unwrap()
            .remove("narrowerCandidateRejections");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["narrowerRejectionCoverage"]["requiredRanks"],
            json!([])
        );
    }

    #[test]
    fn accepts_exact_export_set_without_superset_reason() {
        let mut candidate = valid_candidate();
        candidate["exportedSymbolsExpected"] = json!(["step"]);
        candidate.as_object_mut().unwrap().remove("safeExportSupersetReason");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["safeExportSupersetSymbols"], json!([]));
    }

    #[test]
    fn rejects_ai_only_verifier_evidence_ids() {
        let mut candidate = valid_candidate();
        candidate["verifierEvidenceIds"] = json!(["ai:fission:proposal", "llm:reasoning"]);
        candidate["aiProposalId"] = json!("ai:fission:proposal");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["deterministicVerifierEvidenceIds"], json!([]));
        assert_eq!(
            report["nonAuthoritativeEvidenceIds"],
            json!(["ai:fission:proposal", "llm:reasoning"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.deterministic_verifier_evidence_missing"));
    }

    #[test]
    fn selects_narrowest_accepted_candidate_not_first_pass() {
        let mut wide = valid_candidate();
        wide["islandId"] = json!("island:wide");
        wide["artifactKind"] = json!("full_device_module");
        wide["sourcePaths"] = json!(["src/a.device", "src/b.device"]);
        wide["sourceSpans"] = json!([
            {"path": "src/a.device", "startLine": 1, "endLine": 200},
            {"path": "src/b.device", "startLine": 1, "endLine": 150}
        ]);
        wide["targetSymbols"] = json!(["shade", "trace"]);
        wide["exportedSymbolsExpected"] = json!(["shade", "trace", "helper"]);
        wide["narrowerCandidateRejections"] = json!([
            {
                "scopeRank": 0,
                "reasonCode": "fission.edit_crosses_body_boundary",
                "verifierEvidenceIds": ["evidence:source-map"]
            },
            {
                "scopeRank": 1,
                "reasonCode": "fission.include_closure_unknown",
                "verifierEvidenceIds": ["evidence:include-closure"]
            },
            {
                "scopeRank": 2,
                "reasonCode": "fission.symbol_ownership_ambiguous",
                "verifierEvidenceIds": ["evidence:symbol-ownership"]
            }
        ]);

        let mut narrow = valid_candidate();
        narrow["islandId"] = json!("island:narrow");
        narrow["artifactKind"] = json!("source_include_bridge");
        narrow["sourcePaths"] = json!(["src/a.device"]);
        narrow["sourceSpans"] = json!([{"path": "src/a.device", "startLine": 20, "endLine": 24}]);
        narrow["targetSymbols"] = json!(["shade"]);
        narrow["exportedSymbolsExpected"] = json!(["shade"]);

        let report = verify_fission_candidates(&json!([wide, narrow]));

        assert_eq!(report["status"], "pass");
        assert_eq!(report["acceptedCount"], 2);
        assert_eq!(report["selectedIslandId"], "island:narrow");
        assert_eq!(report["selectedCandidateIndex"], 1);
        assert_eq!(report["candidates"][0]["selected"], false);
        assert_eq!(report["candidates"][1]["selected"], true);
    }

    #[test]
    fn rejected_candidates_are_not_selected() {
        let mut rejected = valid_candidate();
        rejected.as_object_mut().unwrap().remove("requiredOracleId");

        let report = verify_fission_candidates(&json!([rejected]));

        assert_eq!(report["status"], "reject");
        assert_eq!(report["selectedIslandId"], Value::Null);
        assert_eq!(report["selectedCandidateIndex"], Value::Null);
        assert_eq!(report["candidates"][0]["selected"], false);
    }
}
