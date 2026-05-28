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
            "status": "missing",
            "candidateCount": 0,
            "acceptedCount": 0,
            "rejectedCount": 0,
            "selectedIslandId": null,
            "reasonCodes": ["fission.candidate_missing"],
            "candidates": [],
        });
    }

    let mut accepted_count = 0usize;
    let mut rejected_count = 0usize;
    let mut selected_island_id = Value::Null;
    let mut reports = Vec::new();

    for candidate in candidates {
        let report = verify_fission_candidate(&candidate);
        if report.get("status").and_then(Value::as_str) == Some("pass") {
            accepted_count += 1;
            if selected_island_id.is_null() {
                selected_island_id = report
                    .get("islandId")
                    .cloned()
                    .filter(|v| !v.is_null())
                    .unwrap_or(Value::Null);
            }
        } else {
            rejected_count += 1;
        }
        reports.push(report);
    }

    let status = if accepted_count > 0 { "pass" } else { "reject" };
    let reason_codes = if accepted_count > 0 {
        vec!["fission.candidate_accepted"]
    } else {
        vec!["fission.no_accepted_candidate"]
    };

    json!({
        "schemaVersion": FISSION_VERIFIER_SCHEMA_VERSION,
        "status": status,
        "candidateCount": reports.len(),
        "acceptedCount": accepted_count,
        "rejectedCount": rejected_count,
        "selectedIslandId": selected_island_id,
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

fn string_set(value: Option<&Value>) -> BTreeSet<String> {
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
        assert_eq!(report["candidates"][0]["status"], "pass");
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
}
