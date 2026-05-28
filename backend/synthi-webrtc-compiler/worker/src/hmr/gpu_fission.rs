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

    if !candidate.get("includeClosure").is_some_and(Value::is_array) {
        reason_codes.push("fission.includeClosure_missing".to_string());
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
        "safeExportSupersetSymbols": safe_export_superset_symbols(candidate),
        "safeExportSupersetEvidenceIds": safe_export_superset_evidence_ids(candidate),
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
    if !non_empty_string(object.get("path")) {
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
