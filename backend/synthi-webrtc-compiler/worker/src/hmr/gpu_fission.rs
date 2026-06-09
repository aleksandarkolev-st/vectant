use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const FISSION_ISLAND_SCHEMA_VERSION: &str = "synthi.gpu.fission_island.v1";
pub const FISSION_VERIFIER_SCHEMA_VERSION: &str = "synthi.gpu.fission_verifier.v1";
const ORIGINAL_HOST_ATTACHMENT_CONTRACT_SCHEMA_VERSION: &str =
    "synthi.gpu.original_host_attachment_contract.v1";

const REQUIRED_STRING_FIELDS: &[&str] = &[
    "islandId",
    "sourceEditId",
    "artifactKind",
    "dependencyClosureHash",
    "abiMembraneId",
    "compileRecipeHash",
    "compileCommandHash",
];

const REQUIRED_SHA256_DIGEST_FIELDS: &[&str] = &[
    "dependencyClosureHash",
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

const COMPILE_COST_HINT_FIELDS: &[&str] = &[
    "compileCostEstimateMs",
    "compileCostMs",
    "estimatedCompileMs",
    "compileEstimateMs",
];

const HISTORICAL_TIMING_HINT_FIELDS: &[&str] = &[
    "historicalCompileMs",
    "historicalTimingMs",
    "meanCompileMs",
    "p50CompileMs",
    "lastCompileMs",
];

const ACCEPTED_OUTPUT_ORACLE_KINDS: &[&str] = &[
    "edit_contract",
    "sentinel_buffer_value",
    "kernel_checksum",
    "kernel_side_checksum",
    "render_target_hash",
    "accumulation_buffer_hash",
    "selected_pixels",
    "selected_pixel_values",
    "per_pass_checksum",
    "dispatch_counter",
    "buffer_checksum",
];

const RENDER_OUTPUT_ORACLE_KINDS: &[&str] = &[
    "render_target_hash",
    "accumulation_buffer_hash",
    "selected_pixels",
    "selected_pixel_values",
];

const ORIGINAL_HOST_ATTACHMENT_ACTIONS: &[&str] = &[
    "upgrade_runtime_boundary_to_original_host_attachment",
    "attach_runtime_object_dispatch_boundary",
    "wrap_source_launch_with_synthi_runtime_boundary",
    "wrap_native_launch_api_with_synthi_runtime_boundary",
    "instrument_host_launch_boundary",
];

const ORIGINAL_HOST_ATTACHMENT_REQUIRED_BOUNDARY_APIS: &[&str] = &[
    "synthi_gpu_launch_source_location",
    "synthi_gpu_launch_original_host_path",
    "synthi_original_host_path_with_provenance",
];

const ORIGINAL_HOST_LAUNCH_MAPPING_EVIDENCE_FIELDS: &[&str] = &[
    "originalHostLaunchMappingEvidenceIds",
    "originalHostPathEvidenceIds",
    "hostPathAttachmentEvidenceIds",
    "launchAttachmentEvidenceIds",
];

const ORIGINAL_HOST_RUNTIME_ATTACHMENT_EVIDENCE_FIELDS: &[&str] = &[
    "runtimeAttachmentEvidenceIds",
    "originalHostRuntimeAttachmentEvidenceIds",
    "originalHostPathEvidenceIds",
    "hostPathAttachmentEvidenceIds",
    "launchAttachmentEvidenceIds",
];

const ORIGINAL_HOST_RUNTIME_ATTACHMENT_EVIDENCE_SCOPES: &[&str] = &[
    "original_host_path",
    "original_host_runtime_attachment",
    "original_host_path_attachment",
    "host_path_attachment",
    "launch_attachment",
    "runtime_attachment",
];

const AI_PROPOSAL_DETERMINISTIC_PROMOTION_EVIDENCE_FIELDS: &[&str] = &[
    "deterministicPromotionEvidenceIds",
    "fissionPromotionEvidenceIds",
    "proposalPromotionEvidenceIds",
];

const FISSION_SELECTION_COMPARISON_ORDER: &[&str] = &[
    "scopeRank",
    "missingVerificationCategoryCount",
    "targetSymbolCount",
    "exportedSymbolOverage",
    "sourcePathCount",
    "includeClosureCount",
    "sourceSpanExtent",
    "compileCostPenaltyMs",
    "historicalTimingPenaltyMs",
];

const FISSION_SELECTION_TIE_BREAKERS: &[&str] = &["verifierEvidenceId", "candidateIndex"];

const LOADER_CAPABILITY_TOKEN_FIELDS: &[&str] = &[
    "loaderCapability",
    "loaderCapabilityName",
    "capability",
    "transport",
    "transportClass",
    "requestedTransport",
    "selectedLoaderTransport",
    "loaderApi",
];

const LOADER_TRANSPORT_LIST_FIELDS: &[&str] = &[
    "acceptedTransports",
    "supportedTransports",
    "reloadRequestTransports",
    "compileOutputTransports",
    "transports",
];

#[derive(Clone, Copy)]
struct VerificationEvidenceCategory {
    name: &'static str,
    fields: &'static [&'static str],
    fallback_tokens: &'static [&'static str],
}

const REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES: &[VerificationEvidenceCategory] = &[
    VerificationEvidenceCategory {
        name: "source_mapping",
        fields: &["sourceMappingEvidenceIds", "sourceMapEvidenceIds"],
        fallback_tokens: &["source_mapping", "source_map"],
    },
    VerificationEvidenceCategory {
        name: "include_closure",
        fields: &["includeClosureEvidenceIds"],
        fallback_tokens: &["include_closure"],
    },
    VerificationEvidenceCategory {
        name: "symbol_ownership",
        fields: &["symbolOwnershipEvidenceIds"],
        fallback_tokens: &["symbol_ownership", "symbol_owner"],
    },
    VerificationEvidenceCategory {
        name: "dependency_closure",
        fields: &["dependencyClosureEvidenceIds"],
        fallback_tokens: &["dependency_closure"],
    },
    VerificationEvidenceCategory {
        name: "abi_membrane",
        fields: &["abiMembraneEvidenceIds", "abiEvidenceIds"],
        fallback_tokens: &["abi_membrane", "abi_layout"],
    },
    VerificationEvidenceCategory {
        name: "compile_recipe",
        fields: &[
            "compileRecipeEvidenceIds",
            "compileCommandEvidenceIds",
            "compileEvidenceIds",
        ],
        fallback_tokens: &["compile_recipe", "compile_command", "compile_invocation"],
    },
    VerificationEvidenceCategory {
        name: "loader_capability",
        fields: &["loaderCapabilityEvidenceIds", "loaderEvidenceIds"],
        fallback_tokens: &["loader_capability", "loader_requirement", "module_load"],
    },
    VerificationEvidenceCategory {
        name: "output_oracle",
        fields: &["outputOracleEvidenceIds", "oracleEvidenceIds"],
        fallback_tokens: &["output_oracle", "oracle_contract", "oracle_requirement"],
    },
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
        rejected_fission_reason_codes(&reports)
    };

    json!({
        "schemaVersion": FISSION_VERIFIER_SCHEMA_VERSION,
        "selectionPolicy": "narrowest_viable_generic_v1",
        "selectionDecision": fission_selection_decision(
            &reports,
            selected_candidate_index,
            accepted_count,
            rejected_count,
        ),
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
    for field in REQUIRED_SHA256_DIGEST_FIELDS {
        if !sha256_digest_string(candidate.get(*field)) {
            reason_codes.push(format!("fission.{field}_invalid"));
        }
    }
    if non_empty_string(candidate.get("artifactKind"))
        && artifact_kind_scope_rank(candidate).is_none()
    {
        reason_codes.push("fission.artifactKind_invalid".to_string());
    }
    for field in invalid_replacement_scope_fields(candidate) {
        reason_codes.push(format!("fission.{field}_invalid"));
    }
    if replacement_scope_narrows_artifact_kind(candidate) {
        reason_codes.push("fission.replacement_scope_narrows_artifact_kind".to_string());
    }

    for field in REQUIRED_NON_EMPTY_ARRAY_FIELDS {
        if !non_empty_array(candidate.get(*field)) {
            reason_codes.push(format!("fission.{field}_missing"));
        }
    }

    if !source_paths_valid(candidate) {
        reason_codes.push("fission.source_path_invalid".to_string());
    }

    let generated_role_value_present = generated_role_path_value(candidate).is_some();
    let generated_role_path_present = generated_role_path(candidate).is_some();
    if generated_role_value_present && !generated_role_path_present {
        reason_codes.push("fission.generated_role_path_invalid".to_string());
    } else if generated_role_path_required(candidate) && !generated_role_path_present {
        reason_codes.push("fission.generated_role_path_missing".to_string());
    }

    if !deterministic_verifier_evidence_present(candidate) {
        reason_codes.push("fission.deterministic_verifier_evidence_missing".to_string());
    }

    for category in missing_verification_evidence_categories(candidate) {
        reason_codes.push(format!("fission.{category}_evidence_missing"));
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

    let loader_capability_requirement = candidate.get("loaderCapabilityRequirement");
    if !loader_capability_present(loader_capability_requirement) {
        reason_codes.push("fission.loader_capability_requirement_missing".to_string());
    } else if !loader_capability_requirement_valid(loader_capability_requirement) {
        reason_codes.push("fission.loader_capability_requirement_invalid".to_string());
    }

    if !oracle_requirement_present(candidate) {
        reason_codes.push("fission.output_oracle_missing".to_string());
    }
    if output_oracle_proposal_present(candidate) && !output_oracle_proposal_valid(candidate) {
        reason_codes.push("fission.output_oracle_invalid".to_string());
    }

    if !target_symbols_exported(candidate) {
        reason_codes.push("fission.target_symbol_not_exported".to_string());
    }

    if !artifact_identity_contract_valid(candidate) {
        reason_codes.push("fission.artifact_identity_invalid".to_string());
    }

    if !safe_export_superset_justified(candidate) {
        reason_codes.push("fission.safe_export_superset_unverified".to_string());
    }

    if !narrower_rejection_coverage_complete(candidate) {
        reason_codes.push("fission.narrower_candidate_rejections_incomplete".to_string());
    }

    if original_host_launch_mapping_required(candidate)
        && !non_empty_string(candidate.get("originalHostLaunchMappingId"))
    {
        reason_codes.push("fission.original_host_launch_mapping_missing".to_string());
    }
    if original_host_launch_mapping_required(candidate)
        && original_host_launch_mapping_evidence_ids(candidate).is_empty()
    {
        reason_codes.push("fission.original_host_launch_mapping_evidence_missing".to_string());
    }
    if original_host_launch_mapping_required(candidate)
        && !original_host_runtime_attachment_proven(candidate)
        && original_host_attachment_instrumentation_proposals(candidate).is_empty()
    {
        reason_codes.push("fission.original_host_attachment_instrumentation_missing".to_string());
    }

    if stream_ordering_required(candidate) && stream_ordering_evidence_ids(candidate).is_empty() {
        reason_codes.push("fission.stream_ordering_evidence_missing".to_string());
    }

    if epoch_retirement_required(candidate) && epoch_retirement_evidence_ids(candidate).is_empty() {
        reason_codes.push("fission.epoch_retirement_unavailable".to_string());
    }

    if ai_proposal_id_required(candidate) && !non_empty_string(candidate.get("aiProposalId")) {
        reason_codes.push("fission.ai_proposal_id_missing".to_string());
    }
    if ai_proposal_id_required(candidate)
        && ai_proposal_deterministic_promotion_evidence_ids(candidate).is_empty()
    {
        reason_codes.push("fission.ai_proposal_deterministic_promotion_missing".to_string());
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
        "aiProposalIdRequired": ai_proposal_id_required(candidate),
        "aiProposalDeterministicPromotionEvidenceIds": ai_proposal_deterministic_promotion_evidence_ids(candidate),
        "reasonCodes": reason_codes,
        "deterministicVerifierEvidenceIds": deterministic_verifier_evidence_ids(candidate),
        "nonAuthoritativeEvidenceIds": non_authoritative_evidence_ids(candidate),
        "verificationEvidenceCoverage": verification_evidence_coverage(candidate),
        "normalizedSourcePaths": normalized_source_paths(candidate),
        "unmappedSourceSpanPaths": unmapped_source_span_paths(candidate),
        "normalizedIncludeClosurePaths": normalized_include_closure_paths(candidate),
        "invalidIncludeClosureEntries": invalid_include_closure_entries(candidate),
        "safeExportSupersetSymbols": safe_export_superset_symbols(candidate),
        "safeExportSupersetEvidenceIds": safe_export_superset_evidence_ids(candidate),
        "narrowerRejectionCoverage": narrower_rejection_coverage(candidate),
        "hashFieldCoverage": hash_field_coverage(candidate),
        "artifactIdentityContract": artifact_identity_contract_summary(candidate),
        "loaderCapabilityContract": loader_capability_contract_summary(
            candidate.get("loaderCapabilityRequirement")
        ),
        "outputOracleContract": output_oracle_contract_summary(candidate),
        "generatedRolePathRequired": generated_role_path_required(candidate),
        "generatedRolePath": generated_role_path(candidate),
        "artifactKindScopeRank": artifact_kind_scope_rank(candidate),
        "replacementScopeRank": replacement_scope_rank(candidate),
        "originalHostLaunchMappingRequired": original_host_launch_mapping_required(candidate),
        "originalHostLaunchMappingId": candidate
            .get("originalHostLaunchMappingId")
            .cloned()
            .unwrap_or(Value::Null),
        "originalHostLaunchMappingEvidenceIds": original_host_launch_mapping_evidence_ids(candidate),
        "originalHostRuntimeAttachmentProven": original_host_runtime_attachment_proven(candidate),
        "originalHostRuntimeAttachmentEvidenceIds": original_host_runtime_attachment_evidence_ids(candidate),
        "originalHostAttachmentInstrumentationProposalIds": original_host_attachment_instrumentation_proposals(candidate),
        "streamOrderingRequired": stream_ordering_required(candidate),
        "streamOrderingEvidenceIds": stream_ordering_evidence_ids(candidate),
        "epochRetirementRequired": epoch_retirement_required(candidate),
        "epochRetirementEvidenceIds": epoch_retirement_evidence_ids(candidate),
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
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

fn sha256_digest_string(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str).map(str::trim) else {
        return false;
    };
    let digest = value.strip_prefix("sha256:").unwrap_or(value);
    digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn hash_field_coverage(candidate: &Value) -> Value {
    json!({
        "requiredFields": REQUIRED_SHA256_DIGEST_FIELDS,
        "invalidFields": REQUIRED_SHA256_DIGEST_FIELDS
            .iter()
            .filter(|field| !sha256_digest_string(candidate.get(**field)))
            .copied()
            .collect::<Vec<_>>(),
    })
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
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

fn rejected_fission_reason_codes(reports: &[Value]) -> Vec<&str> {
    let mut codes = BTreeSet::new();
    codes.insert("fission.no_accepted_candidate");
    for report in reports {
        if report.get("status").and_then(Value::as_str) == Some("pass") {
            continue;
        }
        if let Some(reason_codes) = report.get("reasonCodes").and_then(Value::as_array) {
            for code in reason_codes.iter().filter_map(Value::as_str) {
                let code = code.trim();
                if !code.is_empty() {
                    codes.insert(code);
                }
            }
        }
    }
    codes.into_iter().collect()
}

fn generated_role_path(candidate: &Value) -> Option<String> {
    generated_role_path_value(candidate).and_then(|path| normalized_project_path(&path))
}

fn generated_role_path_value(candidate: &Value) -> Option<String> {
    for field in ["generatedRolePath", "generatedPath"] {
        if let Some(path) = candidate.get(field).and_then(Value::as_str) {
            return Some(path.trim().to_string());
        }
    }
    candidate
        .get("generatedRole")
        .and_then(Value::as_object)
        .and_then(|object| {
            ["path", "generatedRolePath", "generatedPath"]
                .iter()
                .find_map(|field| object.get(*field).and_then(Value::as_str))
        })
        .map(str::trim)
        .map(str::to_string)
}

fn generated_role_path_required(candidate: &Value) -> bool {
    bool_true(candidate.get("generatedRolePathRequired"))
        || generated_role_scope_requires_generated_path(candidate)
}

fn generated_role_scope_requires_generated_path(candidate: &Value) -> bool {
    let mut scope_text = Vec::new();
    for field in ["replacementScope", "artifactScope", "scope", "artifactKind"] {
        if let Some(value) = candidate.get(field).and_then(Value::as_str) {
            scope_text.push(normalized_scope_text(value));
        }
    }
    let scope_text = scope_text.join(" ");
    scope_text.contains("generated")
        || scope_text.contains("device")
        || scope_text.contains("module")
        || scope_text.contains("kernel")
        || scope_text.contains("source_include")
        || scope_text.contains("partial")
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

fn loader_capability_requirement_valid(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(value)) => loader_capability_token_valid(value),
        Some(Value::Object(object)) => {
            let object_tokens = loader_capability_object_tokens(object);
            let transport_tokens = loader_capability_transport_lists(object);
            loader_capability_selected_artifact_id_valid(object)
                && (!object_tokens.is_empty()
                    && object_tokens
                        .iter()
                        .all(|token| loader_capability_token_valid(token))
                    || !transport_tokens.is_empty()
                        && transport_tokens
                            .iter()
                            .all(|token| loader_capability_token_valid(token)))
        }
        _ => false,
    }
}

fn loader_capability_contract_summary(value: Option<&Value>) -> Value {
    let tokens = loader_capability_tokens(value);
    json!({
        "present": loader_capability_present(value),
        "valid": loader_capability_requirement_valid(value),
        "tokens": tokens,
        "invalidTokens": tokens
            .iter()
            .filter(|token| !loader_capability_token_valid(token))
            .cloned()
            .collect::<Vec<_>>(),
        "selectedArtifactIdValid": value
            .and_then(Value::as_object)
            .is_none_or(loader_capability_selected_artifact_id_valid),
    })
}

fn loader_capability_tokens(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.trim().to_string()],
        Some(Value::Object(object)) => {
            let mut tokens = loader_capability_object_tokens(object);
            tokens.extend(loader_capability_transport_lists(object));
            tokens
        }
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|token| !token.trim().is_empty())
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect()
}

fn loader_capability_object_tokens(object: &serde_json::Map<String, Value>) -> Vec<String> {
    LOADER_CAPABILITY_TOKEN_FIELDS
        .iter()
        .filter_map(|field| object.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn loader_capability_transport_lists(object: &serde_json::Map<String, Value>) -> Vec<String> {
    LOADER_TRANSPORT_LIST_FIELDS
        .iter()
        .flat_map(|field| string_list(object.get(*field)))
        .collect()
}

fn loader_capability_selected_artifact_id_valid(object: &serde_json::Map<String, Value>) -> bool {
    object
        .get("selectedArtifactId")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_none_or(content_addressed_artifact_id_valid)
}

fn artifact_identity_contract_valid(candidate: &Value) -> bool {
    let artifact_ids = artifact_identity_ids(candidate);
    if artifact_ids
        .iter()
        .any(|id| !content_addressed_artifact_id_valid(id))
    {
        return false;
    }

    let hashes = artifact_identity_hashes(candidate);
    if hashes.iter().any(|hash| !sha256_digest_value(hash)) {
        return false;
    }

    let hash_digests = hashes
        .iter()
        .filter_map(|hash| canonical_sha256_digest(hash))
        .collect::<BTreeSet<_>>();
    if hash_digests.is_empty() {
        return true;
    }
    if artifact_ids.is_empty() {
        return false;
    }

    artifact_ids.iter().all(|id| {
        artifact_id_sha256_digest(id).is_some_and(|digest| hash_digests.contains(&digest))
    })
}

fn artifact_identity_contract_summary(candidate: &Value) -> Value {
    let artifact_ids = artifact_identity_ids(candidate);
    let hashes = artifact_identity_hashes(candidate);
    json!({
        "artifactIds": artifact_ids,
        "artifactHashes": hashes,
        "contentAddressedArtifactIds": artifact_ids
            .iter()
            .all(|id| content_addressed_artifact_id_valid(id)),
        "hashesValid": hashes.iter().all(|hash| sha256_digest_value(hash)),
        "idsMatchHashes": artifact_identity_contract_valid(candidate),
    })
}

fn artifact_identity_ids(candidate: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    collect_artifact_identity_id(candidate.get("selectedArtifactId"), &mut ids);
    collect_artifact_identity_id(candidate.get("artifactId"), &mut ids);
    if let Some(loader) = candidate
        .get("loaderCapabilityRequirement")
        .and_then(Value::as_object)
    {
        collect_artifact_identity_id(loader.get("selectedArtifactId"), &mut ids);
        collect_artifact_identity_id(loader.get("artifactId"), &mut ids);
    }
    if let Some(oracle) = candidate
        .get("outputOracleProposal")
        .and_then(Value::as_object)
    {
        for field in [
            "artifactId",
            "artifact",
            "selectedArtifactId",
            "runtimeArtifactBinding",
            "artifact_id",
            "selected_artifact_id",
        ] {
            collect_artifact_identity_id(oracle.get(field), &mut ids);
        }
    }
    ids.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn collect_artifact_identity_id(value: Option<&Value>, ids: &mut Vec<String>) {
    match value {
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.starts_with("artifact:") {
                ids.push(trimmed.to_string());
            }
        }
        Some(Value::Object(object)) => {
            for field in ["artifactId", "selectedArtifactId", "id"] {
                collect_artifact_identity_id(object.get(field), ids);
            }
        }
        _ => {}
    }
}

fn artifact_identity_hashes(candidate: &Value) -> Vec<String> {
    let mut hashes = Vec::new();
    for field in [
        "artifactHash",
        "contentHash",
        "artifactContentHash",
        "selectedArtifactHash",
    ] {
        collect_artifact_identity_hash(candidate.get(field), &mut hashes);
    }
    if let Some(loader) = candidate
        .get("loaderCapabilityRequirement")
        .and_then(Value::as_object)
    {
        for field in ["contentHash", "artifactHash", "selectedArtifactHash"] {
            collect_artifact_identity_hash(loader.get(field), &mut hashes);
        }
    }
    hashes
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn collect_artifact_identity_hash(value: Option<&Value>, hashes: &mut Vec<String>) {
    if let Some(value) = value.and_then(Value::as_str).map(str::trim) {
        if !value.is_empty() {
            hashes.push(value.to_string());
        }
    }
}

fn content_addressed_artifact_id_valid(value: &str) -> bool {
    artifact_id_sha256_digest(value).is_some()
}

fn artifact_id_sha256_digest(value: &str) -> Option<String> {
    canonical_sha256_digest(value.trim().strip_prefix("artifact:")?)
}

fn sha256_digest_value(value: &str) -> bool {
    canonical_sha256_digest(value).is_some()
}

fn canonical_sha256_digest(value: &str) -> Option<String> {
    let digest = value.trim().strip_prefix("sha256:").unwrap_or(value.trim());
    (digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit()))
        .then(|| digest.to_ascii_lowercase())
}

fn loader_capability_token_valid(value: &str) -> bool {
    matches!(
        normalized_scope_text(value).as_str(),
        "module_load_data"
            | "module_load_file"
            | "module_load_data_disabled_by_backend"
            | "module_load_data_unsafe_on_target"
            | "memfd_or_tempfile_required"
            | "content_addressed_blob"
            | "ram"
            | "ram_blob"
            | "ram_bytes"
            | "filesystem_path"
            | "filesystem_fallback"
            | "module_load_path"
    )
}

fn oracle_requirement_present(candidate: &Value) -> bool {
    output_oracle_proposal_valid(candidate) || output_oracle_resolved_contract_valid(candidate)
}

fn output_oracle_proposal_present(candidate: &Value) -> bool {
    candidate.get("outputOracleProposal").is_some()
}

fn output_oracle_proposal_valid(candidate: &Value) -> bool {
    let Some(object) = candidate
        .get("outputOracleProposal")
        .and_then(Value::as_object)
    else {
        return false;
    };
    let Some(kind) = output_oracle_kind(candidate) else {
        return false;
    };
    ACCEPTED_OUTPUT_ORACLE_KINDS.contains(&kind.as_str())
        && output_oracle_expected_value_present(object)
        && output_oracle_producer_present(object)
        && output_oracle_output_target_present(object)
        && output_oracle_readback_contract_present(object)
        && output_oracle_runtime_session_binding_present(object)
        && output_oracle_artifact_binding_present(object)
        && (!RENDER_OUTPUT_ORACLE_KINDS.contains(&kind.as_str())
            || output_oracle_visual_evidence_contract_present(object))
}

fn output_oracle_resolved_contract_present(candidate: &Value) -> bool {
    output_oracle_resolved_contract_object(candidate).is_some()
}

fn output_oracle_resolved_contract_object(
    candidate: &Value,
) -> Option<&serde_json::Map<String, Value>> {
    candidate
        .get("outputOracleContract")
        .or_else(|| candidate.get("resolvedOutputOracleContract"))
        .or_else(|| candidate.get("output_oracle_contract"))
        .or_else(|| candidate.get("resolved_output_oracle_contract"))
        .and_then(Value::as_object)
}

fn output_oracle_resolved_contract_kind(
    object: &serde_json::Map<String, Value>,
) -> Option<String> {
    let kind = object.get("kind").and_then(Value::as_str)?;
    let normalized = normalized_scope_text(kind);
    (!normalized.is_empty()).then_some(normalized)
}

fn output_oracle_resolved_contract_valid(candidate: &Value) -> bool {
    let Some(object) = output_oracle_resolved_contract_object(candidate) else {
        return false;
    };
    let Some(kind) = output_oracle_resolved_contract_kind(object) else {
        return false;
    };
    let oracle_id_present = non_empty_string(candidate.get("requiredOracleId"))
        || [
            "requiredOracleId",
            "oracleId",
            "oracle_id",
            "required_oracle_id",
        ]
        .iter()
        .any(|field| non_empty_string(object.get(*field)));
    oracle_id_present
        && ACCEPTED_OUTPUT_ORACLE_KINDS.contains(&kind.as_str())
        && output_oracle_expected_value_present(object)
        && output_oracle_producer_present(object)
        && output_oracle_output_target_present(object)
        && output_oracle_readback_contract_present(object)
        && output_oracle_runtime_session_binding_present(object)
        && output_oracle_artifact_binding_present(object)
        && (!RENDER_OUTPUT_ORACLE_KINDS.contains(&kind.as_str())
            || output_oracle_visual_evidence_contract_present(object))
}

fn output_oracle_kind(candidate: &Value) -> Option<String> {
    let kind = candidate
        .get("outputOracleProposal")
        .and_then(|proposal| proposal.get("kind"))
        .and_then(Value::as_str)?;
    let normalized = normalized_scope_text(kind);
    (!normalized.is_empty()).then_some(normalized)
}

fn output_oracle_expected_value_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "expected",
        "expectedValue",
        "expectedHash",
        "expectedIncrement",
        "expected_value",
        "expected_hash",
        "expected_increment",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn output_oracle_producer_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "producer",
        "producerSubsystem",
        "producerId",
        "producer_subsystem",
        "producer_id",
    ]
    .iter()
    .any(|field| non_empty_string(object.get(*field)))
}

fn output_oracle_output_target_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "outputTargetId",
        "outputTarget",
        "target",
        "output_target_id",
        "output_target",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn output_oracle_readback_contract_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "readbackPlan",
        "readbackTimestampSource",
        "readbackAfterHmr",
        "readbackAfterHMR",
        "readback_after_hmr",
        "readback_timestamp_source",
        "syncPoint",
        "synchronizationPoint",
        "knownSyncPoint",
        "probeMode",
        "probeConfig",
        "deterministicProbeMode",
        "sync_point",
        "synchronization_point",
        "known_sync_point",
        "probe_mode",
        "probe_config",
        "deterministic_probe_mode",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn output_oracle_runtime_session_binding_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "runtimeSessionId",
        "runtimeSession",
        "sessionId",
        "runtimeSessionBinding",
        "sessionBinding",
        "runtimeSessionIdSource",
        "sessionIdSource",
        "runtime_session_id",
        "runtime_session",
        "session_id",
        "runtime_session_binding",
        "session_binding",
        "runtime_session_id_source",
        "session_id_source",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn output_oracle_artifact_binding_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "artifactId",
        "artifact",
        "artifactBinding",
        "artifactIdSource",
        "selectedArtifactId",
        "runtimeArtifactBinding",
        "artifact_id",
        "artifact_binding",
        "artifact_id_source",
        "selected_artifact_id",
        "runtime_artifact_binding",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn output_oracle_visual_evidence_contract_present(object: &serde_json::Map<String, Value>) -> bool {
    [
        "visualEvidenceRef",
        "visualEvidenceRefs",
        "visualEvidencePlan",
        "visualEvidenceRequirement",
        "requiresVisualEvidence",
        "visualRef",
        "visual_evidence_ref",
        "visual_evidence_refs",
        "visual_evidence_plan",
        "visual_evidence_requirement",
        "requires_visual_evidence",
        "visual_ref",
    ]
    .iter()
    .any(|field| object.get(*field).is_some_and(value_present))
}

fn value_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

fn output_oracle_contract_summary(candidate: &Value) -> Value {
    json!({
        "requiredOracleId": candidate
            .get("requiredOracleId")
            .cloned()
            .unwrap_or(Value::Null),
        "proposalPresent": output_oracle_proposal_present(candidate),
        "proposalValid": output_oracle_proposal_valid(candidate),
        "proposalKind": output_oracle_kind(candidate),
        "proposalExpectedValuePresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_expected_value_present),
        "proposalProducerPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_producer_present),
        "proposalOutputTargetPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_output_target_present),
        "proposalReadbackContractPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_readback_contract_present),
        "proposalRuntimeSessionBindingPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_runtime_session_binding_present),
        "proposalArtifactBindingPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_artifact_binding_present),
        "proposalVisualEvidenceRequired": output_oracle_kind(candidate)
            .is_some_and(|kind| RENDER_OUTPUT_ORACLE_KINDS.contains(&kind.as_str())),
        "proposalVisualEvidenceContractPresent": candidate
            .get("outputOracleProposal")
            .and_then(Value::as_object)
            .is_some_and(output_oracle_visual_evidence_contract_present),
        "resolvedContractPresent": output_oracle_resolved_contract_present(candidate),
        "resolvedContractValid": output_oracle_resolved_contract_valid(candidate),
        "resolvedContractKind": output_oracle_resolved_contract_object(candidate)
            .and_then(output_oracle_resolved_contract_kind),
        "resolvedContractExpectedValuePresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_expected_value_present),
        "resolvedContractProducerPresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_producer_present),
        "resolvedContractOutputTargetPresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_output_target_present),
        "resolvedContractReadbackContractPresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_readback_contract_present),
        "resolvedContractRuntimeSessionBindingPresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_runtime_session_binding_present),
        "resolvedContractArtifactBindingPresent": output_oracle_resolved_contract_object(candidate)
            .is_some_and(output_oracle_artifact_binding_present),
        "acceptedKinds": ACCEPTED_OUTPUT_ORACLE_KINDS,
    })
}

fn target_symbols_exported(candidate: &Value) -> bool {
    let targets = string_set(candidate.get("targetSymbols"));
    let exports = string_set(candidate.get("exportedSymbolsExpected"));
    if targets.is_empty() || exports.is_empty() {
        return false;
    }
    let mapped_targets = symbol_identity_mapped_targets(candidate, &exports);
    targets
        .iter()
        .all(|target| exports.contains(target) || mapped_targets.contains(target))
}

fn safe_export_superset_justified(candidate: &Value) -> bool {
    let extra_symbols = safe_export_superset_symbols(candidate);
    extra_symbols.is_empty()
        || (non_empty_string(candidate.get("safeExportSupersetReason"))
            && !safe_export_superset_evidence_ids(candidate).is_empty())
}

fn safe_export_superset_symbols(candidate: &Value) -> Vec<String> {
    let targets = string_set(candidate.get("targetSymbols"));
    let exports = string_set(candidate.get("exportedSymbolsExpected"));
    let mapped_exports = symbol_identity_mapped_exports(candidate, &exports);
    exports
        .difference(&targets)
        .filter(|symbol| !mapped_exports.contains(*symbol))
        .cloned()
        .collect()
}

fn symbol_identity_mapped_targets(
    candidate: &Value,
    exports: &BTreeSet<String>,
) -> BTreeSet<String> {
    symbol_identity_mappings(candidate, exports)
        .into_iter()
        .map(|(target, _)| target)
        .collect()
}

fn symbol_identity_mapped_exports(
    candidate: &Value,
    exports: &BTreeSet<String>,
) -> BTreeSet<String> {
    symbol_identity_mappings(candidate, exports)
        .into_iter()
        .map(|(_, exported)| exported)
        .collect()
}

fn symbol_identity_mappings(
    candidate: &Value,
    exports: &BTreeSet<String>,
) -> Vec<(String, String)> {
    candidate
        .get("symbolIdentityMappings")
        .or_else(|| candidate.get("symbolIdentityMap"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .filter_map(|mapping| {
                    let target = first_mapping_string(
                        mapping,
                        &["targetSymbol", "sourceSymbol", "logicalSymbol", "symbol"],
                    )?;
                    let exported = first_mapping_string(
                        mapping,
                        &[
                            "exportedSymbol",
                            "runtimeSymbol",
                            "artifactSymbol",
                            "mangledSymbol",
                        ],
                    )?;
                    let evidence_ids = first_mapping_evidence_ids(
                        mapping,
                        &[
                            "evidenceIds",
                            "verifierEvidenceIds",
                            "symbolOwnershipEvidenceIds",
                            "identityEvidenceIds",
                        ],
                    );
                    (!target.is_empty()
                        && !exported.is_empty()
                        && exports.contains(&exported)
                        && !evidence_ids.is_empty())
                    .then_some((target, exported))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn first_mapping_string(
    mapping: &serde_json::Map<String, Value>,
    fields: &[&str],
) -> Option<String> {
    fields.iter().find_map(|field| {
        mapping
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn first_mapping_evidence_ids(
    mapping: &serde_json::Map<String, Value>,
    fields: &[&str],
) -> Vec<String> {
    fields
        .iter()
        .find_map(|field| {
            let ids = string_list(mapping.get(*field));
            (!ids.is_empty()).then_some(ids)
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|id| is_deterministic_verifier_evidence_id(id))
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

fn missing_verification_evidence_categories(candidate: &Value) -> Vec<&'static str> {
    REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
        .iter()
        .filter_map(|category| {
            if deterministic_evidence_ids_for_category(
                candidate,
                category.fields,
                category.fallback_tokens,
            )
            .is_empty()
            {
                Some(category.name)
            } else {
                None
            }
        })
        .collect()
}

fn verification_evidence_coverage(candidate: &Value) -> Value {
    let mut categories = Vec::new();
    let mut missing = Vec::new();
    for category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
        let evidence_ids = deterministic_evidence_ids_for_category(
            candidate,
            category.fields,
            category.fallback_tokens,
        );
        if evidence_ids.is_empty() {
            missing.push(category.name);
        }
        categories.push(json!({
            "category": category.name,
            "evidenceIds": evidence_ids,
        }));
    }
    json!({
        "requiredCategories": REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
            .iter()
            .map(|category| category.name)
            .collect::<Vec<_>>(),
        "missingCategories": missing,
        "categories": categories,
    })
}

fn deterministic_evidence_ids_for_category(
    candidate: &Value,
    fields: &[&str],
    fallback_tokens: &[&str],
) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for field in fields {
        ids.extend(
            evidence_id_list(candidate.get(*field))
                .into_iter()
                .filter(|id| is_deterministic_verifier_evidence_id(id)),
        );
    }
    ids.extend(
        deterministic_verifier_evidence_ids(candidate)
            .into_iter()
            .filter(|id| evidence_id_matches_any_token(id, fallback_tokens)),
    );
    ids.into_iter().collect()
}

fn evidence_id_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.trim().to_string()],
        Some(Value::Array(items)) => items
            .iter()
            .flat_map(|item| evidence_id_list(Some(item)))
            .collect(),
        Some(Value::Object(object)) => {
            let mut ids = Vec::new();
            for field in ["id", "evidenceId", "proofId", "ref"] {
                if let Some(value) = object.get(field).and_then(Value::as_str) {
                    ids.push(value.trim().to_string());
                }
            }
            ids.extend(evidence_id_list(object.get("evidenceIds")));
            ids
        }
        _ => Vec::new(),
    }
}

fn evidence_id_matches_any_token(value: &str, tokens: &[&str]) -> bool {
    let normalized = normalized_scope_text(value);
    tokens.iter().any(|token| normalized.contains(token))
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

fn ai_proposal_id_required(candidate: &Value) -> bool {
    bool_true(candidate.get("aiProposalIdRequired"))
        || bool_true(candidate.get("aiGenerated"))
        || bool_true(candidate.get("llmGenerated"))
        || ai_source_marker_present(candidate)
        || non_authoritative_evidence_ids(candidate)
            .iter()
            .any(|id| text_indicates_ai_source(id))
}

fn ai_proposal_deterministic_promotion_evidence_ids(candidate: &Value) -> Vec<String> {
    deterministic_evidence_ids_for_category(
        candidate,
        AI_PROPOSAL_DETERMINISTIC_PROMOTION_EVIDENCE_FIELDS,
        &[
            "fission_promotion",
            "proposal_promotion",
            "deterministic_promotion",
        ],
    )
}

fn ai_source_marker_present(candidate: &Value) -> bool {
    [
        "proposalSource",
        "candidateSource",
        "source",
        "plannerSource",
        "createdBy",
    ]
    .iter()
    .any(|field| value_indicates_ai_source(candidate.get(*field)))
}

fn value_indicates_ai_source(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(value)) => text_indicates_ai_source(value),
        Some(Value::Object(object)) => object
            .values()
            .any(|value| value_indicates_ai_source(Some(value))),
        Some(Value::Array(items)) => items
            .iter()
            .any(|value| value_indicates_ai_source(Some(value))),
        _ => false,
    }
}

fn text_indicates_ai_source(value: &str) -> bool {
    normalized_scope_text(value)
        .split('_')
        .any(|token| matches!(token, "ai" | "llm" | "model"))
}

fn original_host_launch_mapping_required(candidate: &Value) -> bool {
    bool_true(candidate.get("requiresOriginalHostPath"))
        || bool_true(candidate.get("originalHostLaunchMappingRequired"))
        || explicit_original_host_requirement(candidate.get("originalHostPathRequirement"))
        || explicit_original_host_requirement(candidate.get("originalHostLaunchMappingRequirement"))
        || runtime_ownership_requires_original_host(candidate.get("runtimeOwnershipRequirement"))
        || runtime_ownership_requires_original_host(candidate.get("runtimeAttachmentRequirement"))
}

fn stream_ordering_required(candidate: &Value) -> bool {
    bool_true(candidate.get("requiresStreamOrdering"))
        || bool_true(candidate.get("streamOrderingRequired"))
        || explicit_requirement_enabled(candidate.get("streamOrderingRequirement"))
        || explicit_requirement_enabled(candidate.get("runtimeOrderingRequirement"))
        || epoch_publication_required(candidate)
        || epoch_retirement_required(candidate)
}

fn epoch_publication_required(candidate: &Value) -> bool {
    bool_true(candidate.get("epochPublicationRequired"))
        || explicit_requirement_enabled(candidate.get("epochPublicationRequirement"))
        || explicit_requirement_enabled(candidate.get("capsulePublicationRequirement"))
}

fn epoch_retirement_required(candidate: &Value) -> bool {
    bool_true(candidate.get("epochRetirementRequired"))
        || bool_true(candidate.get("streamRetirementRequired"))
        || explicit_requirement_enabled(candidate.get("epochRetirementRequirement"))
        || explicit_requirement_enabled(candidate.get("streamRetirementRequirement"))
}

fn stream_ordering_evidence_ids(candidate: &Value) -> Vec<String> {
    deterministic_evidence_ids_for_category(
        candidate,
        &[
            "streamOrderingEvidenceIds",
            "runtimeOrderingEvidenceIds",
            "streamEvidenceIds",
        ],
        &["stream_ordering", "stream_order", "runtime_ordering"],
    )
}

fn epoch_retirement_evidence_ids(candidate: &Value) -> Vec<String> {
    deterministic_evidence_ids_for_category(
        candidate,
        &[
            "epochRetirementEvidenceIds",
            "streamRetirementEvidenceIds",
            "retirementFenceEvidenceIds",
            "epochPublicationEvidenceIds",
        ],
        &[
            "epoch_retirement",
            "stream_retirement",
            "retirement_fence",
            "epoch_publication",
            "epoch_swap",
        ],
    )
}

fn original_host_launch_mapping_evidence_ids(candidate: &Value) -> Vec<String> {
    deterministic_evidence_ids_for_category(
        candidate,
        ORIGINAL_HOST_LAUNCH_MAPPING_EVIDENCE_FIELDS,
        &[
            "original_host_launch_mapping",
            "original_host_path",
            "host_path_attachment",
            "launch_attachment",
        ],
    )
}

fn original_host_runtime_attachment_proven(candidate: &Value) -> bool {
    runtime_attachment_value_proven(candidate)
}

fn original_host_runtime_attachment_evidence_ids(candidate: &Value) -> Vec<String> {
    let mut ids = BTreeSet::new();
    collect_runtime_attachment_evidence_ids(Some(candidate), &mut ids);
    ids.into_iter().collect()
}

fn runtime_attachment_value_proven(value: &Value) -> bool {
    match value {
        Value::Bool(_) => false,
        Value::Object(object) => {
            let direct_claim_proven = bool_true(object.get("runtimeAttachmentProven"))
                && !runtime_attachment_evidence_ids_for_object(object).is_empty();
            direct_claim_proven
                || object
                    .get("mapping")
                    .is_some_and(runtime_attachment_value_proven)
                || object
                    .get("runtimeAttachment")
                    .is_some_and(runtime_attachment_value_proven)
                || object
                    .get("launchAttachmentScout")
                    .is_some_and(runtime_attachment_value_proven)
                || object
                    .get("originalHostLaunchMapping")
                    .is_some_and(runtime_attachment_value_proven)
        }
        _ => false,
    }
}

fn runtime_attachment_evidence_ids_for_object(
    object: &serde_json::Map<String, Value>,
) -> Vec<String> {
    ORIGINAL_HOST_RUNTIME_ATTACHMENT_EVIDENCE_FIELDS
        .iter()
        .flat_map(|field| evidence_id_list(object.get(*field)))
        .filter(|id| is_original_host_runtime_attachment_evidence_id(id))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn collect_runtime_attachment_evidence_ids(value: Option<&Value>, ids: &mut BTreeSet<String>) {
    let Some(value) = value else {
        return;
    };
    if let Some(object) = value.as_object() {
        ids.extend(runtime_attachment_evidence_ids_for_object(object));
        collect_runtime_attachment_evidence_ids(object.get("mapping"), ids);
        collect_runtime_attachment_evidence_ids(object.get("runtimeAttachment"), ids);
        collect_runtime_attachment_evidence_ids(object.get("launchAttachmentScout"), ids);
        collect_runtime_attachment_evidence_ids(object.get("originalHostLaunchMapping"), ids);
    }
}

fn is_original_host_runtime_attachment_evidence_id(value: &str) -> bool {
    if !is_deterministic_verifier_evidence_id(value) {
        return false;
    }
    let normalized = normalized_scope_text(value);
    ORIGINAL_HOST_RUNTIME_ATTACHMENT_EVIDENCE_SCOPES
        .iter()
        .any(|scope| normalized.contains(scope))
}

fn original_host_attachment_instrumentation_proposals(candidate: &Value) -> Vec<String> {
    let mut ids = BTreeSet::new();
    collect_original_host_attachment_proposal_ids(
        candidate.get("attachmentInstrumentationProposals"),
        &mut ids,
    );
    collect_original_host_attachment_proposal_ids(
        candidate.get("originalHostAttachmentInstrumentationProposals"),
        &mut ids,
    );
    collect_original_host_attachment_proposal_ids(
        candidate.pointer("/launchAttachmentScout/attachmentInstrumentationProposals"),
        &mut ids,
    );
    collect_original_host_attachment_proposal_ids(
        candidate.pointer("/launchAttachmentScout/mapping/attachmentInstrumentationProposals"),
        &mut ids,
    );
    collect_original_host_attachment_proposal_ids(
        candidate.pointer("/originalHostLaunchMapping/attachmentInstrumentationProposals"),
        &mut ids,
    );
    ids.into_iter().collect()
}

fn collect_original_host_attachment_proposal_ids(
    value: Option<&Value>,
    ids: &mut BTreeSet<String>,
) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Object(object) => {
            if original_host_attachment_proposal_valid(value) {
                if let Some(proposal_id) = object
                    .get("proposalId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    ids.insert(proposal_id.to_string());
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_original_host_attachment_proposal_ids(Some(item), ids);
            }
        }
        _ => {}
    }
}

fn original_host_attachment_proposal_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let required_apis = string_list(object.get("requiredBoundaryApis"))
        .into_iter()
        .collect::<BTreeSet<_>>();
    let has_required_api_contract = ORIGINAL_HOST_ATTACHMENT_REQUIRED_BOUNDARY_APIS
        .iter()
        .all(|api| required_apis.contains(*api));
    let has_instrumentation_action = object
        .get("instrumentationAction")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|action| ORIGINAL_HOST_ATTACHMENT_ACTIONS.contains(&action));
    non_empty_string(object.get("proposalId"))
        && non_empty_string(object.get("hostPathId"))
        && non_empty_string(object.get("sourceLaunchSiteId"))
        && non_empty_string(object.get("path"))
        && non_empty_string(object.get("sourceProvenance"))
        && positive_u64(object.get("line")).is_some()
        && positive_u64(object.get("column")).is_some()
        && sha256_digest_string(object.get("sourceHash"))
        && sha256_digest_string(object.get("snippetHash"))
        && has_instrumentation_action
        && has_required_api_contract
        && object
            .get("runtimeEvidenceRequired")
            .and_then(Value::as_object)
            .is_some_and(|evidence| {
                bool_true(evidence.get("runtimeSessionScoped"))
                    && bool_true(evidence.get("dispatchBoundaryObserved"))
                    && bool_true(evidence.get("dispatchEntryRuntimeVerified"))
                    && bool_true(evidence.get("launchArgProvenanceComplete"))
            })
        && original_host_attachment_contract_valid(object.get("attachmentContract"))
}

fn original_host_attachment_contract_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    object.get("schemaVersion").and_then(Value::as_str)
        == Some(ORIGINAL_HOST_ATTACHMENT_CONTRACT_SCHEMA_VERSION)
        && original_host_attachment_contract_runtime_dispatch_valid(
            object.get("runtimeDispatchBoundary"),
        )
        && original_host_attachment_contract_arg_provenance_valid(
            object.get("launchArgumentProvenance"),
        )
        && original_host_attachment_contract_stream_ordering_valid(object.get("streamOrdering"))
        && original_host_attachment_contract_host_preservation_valid(object.get("hostPreservation"))
        && original_host_attachment_contract_output_proof_valid(object.get("outputProof"))
}

fn original_host_attachment_contract_runtime_dispatch_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    bool_true(object.get("required"))
        && object
            .get("dispatchTableEntryIdSource")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| value == "runtime_boundary_active_generation")
        && bool_true(object.get("mustMatchActiveGenerationEntry"))
        && bool_true(object.get("mustEmitSynthiLaunchDispatch"))
}

fn original_host_attachment_contract_arg_provenance_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    bool_true(object.get("required"))
        && object
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| value == "runtime_observed_launch_arguments")
        && bool_true(object.get("completeRequired"))
        && bool_true(object.get("unknownArgumentsBlockFullRuntime"))
}

fn original_host_attachment_contract_stream_ordering_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    bool_true(object.get("required"))
        && object
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| value == "runtime_boundary_stream_token")
        && bool_true(object.get("mustSynchronizeAffectedStreamsBeforePublish"))
}

fn original_host_attachment_contract_host_preservation_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    bool_true(object.get("runtimeIdentitySnapshotRequired"))
        && bool_true(object.get("hostReplacementBlocksFullRuntime"))
}

fn original_host_attachment_contract_output_proof_valid(value: Option<&Value>) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    bool_true(object.get("deterministicOracleRequired"))
        && bool_true(object.get("visualEvidenceSupplementalOnly"))
}

fn bool_true(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool) == Some(true)
}

fn explicit_requirement_enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => requirement_text_enabled(value),
        Some(Value::Object(object)) => {
            bool_true(object.get("required"))
                || bool_true(object.get("enabled"))
                || object
                    .values()
                    .filter_map(Value::as_str)
                    .any(requirement_text_enabled)
        }
        _ => false,
    }
}

fn explicit_original_host_requirement(value: Option<&Value>) -> bool {
    explicit_requirement_enabled(value)
}

fn runtime_ownership_requires_original_host(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(_)) => false,
        Some(Value::String(value)) => ownership_text_requires_original_host(value),
        Some(Value::Object(object)) => {
            bool_true(object.get("requiresOriginalHostPath"))
                || bool_true(object.get("originalHostLaunchMappingRequired"))
                || object
                    .values()
                    .filter_map(Value::as_str)
                    .any(ownership_text_requires_original_host)
        }
        _ => false,
    }
}

fn requirement_text_enabled(value: &str) -> bool {
    let normalized = normalized_scope_text(value);
    !matches!(
        normalized.as_str(),
        "" | "none" | "false" | "optional" | "not_required" | "unneeded" | "unavailable"
    )
}

fn ownership_text_requires_original_host(value: &str) -> bool {
    let normalized = normalized_scope_text(value);
    normalized.contains("original_host") || normalized.contains("host_path")
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
            let left_score = selection_score_key(left);
            let right_score = selection_score_key(right);
            left_score
                .cmp(&right_score)
                .then_with(|| {
                    verifier_evidence_id_value(left).cmp(&verifier_evidence_id_value(right))
                })
                .then_with(|| left_index.cmp(right_index))
        })
        .map(|(index, _)| index)
}

fn selection_score_key(report: &Value) -> [u64; 9] {
    let score = report.get("selectionScore");
    [
        selection_score_field(score, "scopeRank"),
        selection_score_field(score, "missingVerificationCategoryCount"),
        selection_score_field(score, "targetSymbolCount"),
        selection_score_field(score, "exportedSymbolOverage"),
        selection_score_field(score, "sourcePathCount"),
        selection_score_field(score, "includeClosureCount"),
        selection_score_field(score, "sourceSpanExtent"),
        selection_score_field(score, "compileCostPenaltyMs"),
        selection_score_field(score, "historicalTimingPenaltyMs"),
    ]
}

fn selection_score_field(score: Option<&Value>, field: &str) -> u64 {
    score
        .and_then(|score| score.get(field))
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX)
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
    let missing_verification_category_count =
        missing_verification_evidence_categories(candidate).len() as u64;
    let compile_cost_estimate_ms = first_numeric_hint(candidate, COMPILE_COST_HINT_FIELDS);
    let historical_timing_ms = first_numeric_hint(candidate, HISTORICAL_TIMING_HINT_FIELDS);
    let compile_cost_penalty_ms = compile_cost_estimate_ms.unwrap_or(9_999).min(9_999);
    let historical_timing_penalty_ms = historical_timing_ms.unwrap_or(9_999).min(9_999);
    let narrowness_score = target_symbol_count
        .saturating_mul(10_000_000)
        .saturating_add(exported_symbol_overage.saturating_mul(1_000_000))
        .saturating_add(source_path_count.saturating_mul(100_000))
        .saturating_add(include_closure_count.saturating_mul(1_000))
        .saturating_add(source_span_extent.min(999));
    let total = scope_rank
        .saturating_mul(1_000_000_000)
        .saturating_add(missing_verification_category_count.saturating_mul(100_000_000))
        .saturating_add(narrowness_score.saturating_mul(20_000))
        .saturating_add(compile_cost_penalty_ms)
        .saturating_add(historical_timing_penalty_ms);
    json!({
        "policy": "narrowest_viable_generic_v1",
        "comparisonOrder": FISSION_SELECTION_COMPARISON_ORDER,
        "total": total,
        "scopeRank": scope_rank,
        "missingVerificationCategoryCount": missing_verification_category_count,
        "targetSymbolCount": target_symbol_count,
        "exportedSymbolCount": exported_symbol_count,
        "exportedSymbolOverage": exported_symbol_overage,
        "sourcePathCount": source_path_count,
        "includeClosureCount": include_closure_count,
        "sourceSpanExtent": source_span_extent,
        "narrownessScore": narrowness_score,
        "compileCostEstimateMs": compile_cost_estimate_ms,
        "compileCostPenaltyMs": compile_cost_penalty_ms,
        "historicalTimingMs": historical_timing_ms,
        "historicalTimingPenaltyMs": historical_timing_penalty_ms,
    })
}

fn fission_selection_decision(
    reports: &[Value],
    selected_candidate_index: Option<usize>,
    accepted_count: usize,
    rejected_count: usize,
) -> Value {
    let selected = selected_candidate_index.and_then(|index| reports.get(index));
    json!({
        "schemaVersion": "synthi.gpu.fission_selection_decision.v1",
        "policy": "narrowest_viable_generic_v1",
        "deterministic": true,
        "comparisonOrder": FISSION_SELECTION_COMPARISON_ORDER,
        "tieBreakers": FISSION_SELECTION_TIE_BREAKERS,
        "candidateCount": reports.len(),
        "acceptedCount": accepted_count,
        "rejectedCount": rejected_count,
        "selectedCandidateIndex": selected_candidate_index,
        "selectedIslandId": selected
            .and_then(|report| report.get("islandId"))
            .cloned()
            .unwrap_or(Value::Null),
        "selectedVerifierEvidenceId": selected
            .and_then(|report| report.get("verifierEvidenceId"))
            .cloned()
            .unwrap_or(Value::Null),
        "selectedScore": selected
            .and_then(|report| report.get("selectionScore"))
            .cloned()
            .unwrap_or(Value::Null),
        "narrowerRejectionCoverage": selected
            .and_then(|report| report.get("narrowerRejectionCoverage"))
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn replacement_scope_rank(candidate: &Value) -> u64 {
    let artifact_rank = artifact_kind_scope_rank(candidate);
    let explicit_scope_rank = explicit_replacement_scope_rank(candidate);

    match (artifact_rank, explicit_scope_rank) {
        (Some(artifact_rank), Some(scope_rank)) => artifact_rank.max(scope_rank),
        (Some(artifact_rank), None) => artifact_rank,
        (None, Some(scope_rank)) => scope_rank,
        (None, None) => 2,
    }
}

fn artifact_kind_scope_rank(candidate: &Value) -> Option<u64> {
    candidate
        .get("artifactKind")
        .and_then(Value::as_str)
        .and_then(scope_rank_from_text)
}

fn explicit_replacement_scope_rank(candidate: &Value) -> Option<u64> {
    ["replacementScope", "artifactScope", "scope"]
        .iter()
        .filter_map(|field| candidate.get(*field).and_then(Value::as_str))
        .filter_map(scope_rank_from_text)
        .min()
}

fn invalid_replacement_scope_fields(candidate: &Value) -> Vec<&'static str> {
    ["replacementScope", "artifactScope", "scope"]
        .into_iter()
        .filter(|field| {
            candidate
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| scope_rank_from_text(value).is_none())
        })
        .collect()
}

fn replacement_scope_narrows_artifact_kind(candidate: &Value) -> bool {
    artifact_kind_scope_rank(candidate)
        .zip(explicit_replacement_scope_rank(candidate))
        .is_some_and(|(artifact_rank, scope_rank)| scope_rank < artifact_rank)
}

fn scope_rank_from_text(value: &str) -> Option<u64> {
    let scope_text = normalized_scope_text(value);
    if scope_text.is_empty() {
        return None;
    }
    if scope_text.contains("body") || scope_text.contains("function") {
        Some(0)
    } else if scope_text.contains("source_include")
        || scope_text.contains("include_bridge")
        || (scope_text.contains("partial")
            && (scope_text.contains("device") || scope_text.contains("module")))
    {
        Some(1)
    } else if scope_text.contains("multi")
        || scope_text.contains("translation_unit")
        || scope_text.contains("kernel_region")
        || scope_text.contains("artifact_region")
        || scope_text == "region"
    {
        Some(2)
    } else if (scope_text.contains("full")
        && (scope_text.contains("device") || scope_text.contains("module")))
        || scope_text.contains("device_module")
        || scope_text.contains("sidecar")
        || scope_text.contains("code_object")
    {
        Some(3)
    } else if scope_text.contains("host") {
        Some(4)
    } else if scope_text.contains("runner")
        || scope_text.contains("process")
        || scope_text.contains("restart")
    {
        Some(5)
    } else {
        None
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

fn first_numeric_hint(candidate: &Value, fields: &[&str]) -> Option<u64> {
    fields
        .iter()
        .find_map(|field| numeric_hint(candidate.get(*field)))
}

fn numeric_hint(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
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
            "generatedRolePath": ".synthi/generated/gpu/device.kernel",
            "targetSymbols": ["step"],
            "exportedSymbolsExpected": ["step", "helper"],
            "artifactKind": "device_partial",
            "safeExportSupersetReason": "helper symbol is verifier-owned dependency closure",
            "includeClosure": [],
            "dependencyClosureHash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "abiMembraneId": "abi:membrane",
            "compileRecipeHash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "compileCommandHash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "loaderCapabilityRequirement": {"transport": "content_addressed_blob"},
            "requiredOracleId": "oracle:sentinel",
            "outputOracleProposal": {
                "kind": "sentinel_buffer_value",
                "producer": "deterministic_probe",
                "expected": "sentinel-changed-after-dispatch",
                "outputTargetId": "buffer:sentinel",
                "readbackPlan": {"syncPoint": "after-dispatch"},
                "sessionIdSource": "runtime-session",
                "artifactIdSource": "selected-artifact"
            },
            "sourceMappingEvidenceIds": ["evidence:source-map"],
            "includeClosureEvidenceIds": ["evidence:include-closure"],
            "symbolOwnershipEvidenceIds": ["evidence:symbol-ownership"],
            "dependencyClosureEvidenceIds": ["evidence:dependency-closure"],
            "abiMembraneEvidenceIds": ["evidence:abi-membrane"],
            "compileRecipeEvidenceIds": ["evidence:compile-recipe"],
            "loaderCapabilityEvidenceIds": ["evidence:loader-capability"],
            "outputOracleEvidenceIds": ["evidence:output-oracle"],
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

    fn valid_attachment_contract() -> Value {
        json!({
            "schemaVersion": "synthi.gpu.original_host_attachment_contract.v1",
            "runtimeDispatchBoundary": {
                "required": true,
                "dispatchTableEntryIdSource": "runtime_boundary_active_generation",
                "mustMatchActiveGenerationEntry": true,
                "mustEmitSynthiLaunchDispatch": true
            },
            "launchArgumentProvenance": {
                "required": true,
                "source": "runtime_observed_launch_arguments",
                "completeRequired": true,
                "unknownArgumentsBlockFullRuntime": true
            },
            "streamOrdering": {
                "required": true,
                "source": "runtime_boundary_stream_token",
                "mustSynchronizeAffectedStreamsBeforePublish": true
            },
            "hostPreservation": {
                "runtimeIdentitySnapshotRequired": true,
                "hostReplacementBlocksFullRuntime": true
            },
            "outputProof": {
                "deterministicOracleRequired": true,
                "visualEvidenceSupplementalOnly": true
            }
        })
    }

    #[test]
    fn accepts_complete_generic_candidate() {
        let report = verify_fission_candidates(&json!([valid_candidate()]));

        assert_eq!(report["status"], "pass");
        assert_eq!(report["acceptedCount"], 1);
        assert_eq!(report["selectedIslandId"], "island:sha256:1");
        assert_eq!(report["selectedCandidateIndex"], 0);
        assert_eq!(
            report["selectionDecision"]["schemaVersion"],
            "synthi.gpu.fission_selection_decision.v1"
        );
        assert_eq!(report["selectionDecision"]["deterministic"], true);
        assert_eq!(
            report["selectionDecision"]["tieBreakers"],
            json!(["verifierEvidenceId", "candidateIndex"])
        );
        assert_eq!(
            report["selectionDecision"]["selectedScore"],
            report["candidates"][0]["selectionScore"]
        );
        assert_eq!(report["candidates"][0]["status"], "pass");
        assert_eq!(report["candidates"][0]["selected"], true);
        assert_eq!(
            report["candidates"][0]["reasonCodes"][0],
            "fission.candidate_verified"
        );
    }

    #[test]
    fn accepts_target_symbol_exported_through_evidenced_identity_mapping() {
        let mut candidate = valid_candidate();
        candidate["targetSymbols"] = json!(["step"]);
        candidate["exportedSymbolsExpected"] = json!(["_Z4stepPf"]);
        candidate["symbolIdentityMappings"] = json!([
            {
                "targetSymbol": "step",
                "exportedSymbol": "_Z4stepPf",
                "evidenceIds": ["evidence:symbol-ownership"]
            }
        ]);
        candidate
            .as_object_mut()
            .unwrap()
            .remove("safeExportSupersetReason");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["safeExportSupersetSymbols"], json!([]));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|code| code != "fission.target_symbol_not_exported"));
    }

    #[test]
    fn rejects_symbol_identity_mapping_without_deterministic_evidence() {
        let mut candidate = valid_candidate();
        candidate["targetSymbols"] = json!(["step"]);
        candidate["exportedSymbolsExpected"] = json!(["_Z4stepPf"]);
        candidate["symbolIdentityMappings"] = json!([
            {
                "targetSymbol": "step",
                "exportedSymbol": "_Z4stepPf",
                "evidenceIds": ["ai:symbol-guess"]
            }
        ]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.target_symbol_not_exported"));
    }

    #[test]
    fn rejects_candidate_without_required_phase_evidence() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("abiMembraneEvidenceIds");
        candidate["verifierEvidenceIds"] = json!(["evidence:source-map"]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!(["abi_membrane"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.abi_membrane_evidence_missing"));
    }

    #[test]
    fn rejects_candidate_without_real_hash_field_digests() {
        let mut candidate = valid_candidate();
        candidate["dependencyClosureHash"] = json!("sha256:dependency");
        candidate["compileRecipeHash"] = json!("not-a-digest");
        candidate["compileCommandHash"] = json!("...");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["hashFieldCoverage"]["invalidFields"],
            json!([
                "dependencyClosureHash",
                "compileRecipeHash",
                "compileCommandHash"
            ])
        );
        for reason in [
            "fission.dependencyClosureHash_invalid",
            "fission.compileRecipeHash_invalid",
            "fission.compileCommandHash_invalid",
        ] {
            assert!(report["reasonCodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|code| code == reason));
        }
    }

    #[test]
    fn accepts_phase_evidence_from_tagged_verifier_ids() {
        let mut candidate = valid_candidate();
        for field in [
            "sourceMappingEvidenceIds",
            "includeClosureEvidenceIds",
            "symbolOwnershipEvidenceIds",
            "dependencyClosureEvidenceIds",
            "abiMembraneEvidenceIds",
            "compileRecipeEvidenceIds",
            "loaderCapabilityEvidenceIds",
            "outputOracleEvidenceIds",
        ] {
            candidate.as_object_mut().unwrap().remove(field);
        }
        candidate["verifierEvidenceIds"] = json!([
            "evidence:source-map",
            "evidence:include-closure",
            "evidence:symbol-ownership",
            "evidence:dependency-closure",
            "evidence:abi-membrane",
            "evidence:compile-recipe",
            "evidence:loader-capability",
            "evidence:output-oracle"
        ]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!([])
        );
    }

    #[test]
    fn rejects_candidate_without_compile_loader_and_oracle_evidence() {
        let mut candidate = valid_candidate();
        for field in [
            "compileRecipeEvidenceIds",
            "loaderCapabilityEvidenceIds",
            "outputOracleEvidenceIds",
        ] {
            candidate.as_object_mut().unwrap().remove(field);
        }

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!(["compile_recipe", "loader_capability", "output_oracle"])
        );
        for reason in [
            "fission.compile_recipe_evidence_missing",
            "fission.loader_capability_evidence_missing",
            "fission.output_oracle_evidence_missing",
        ] {
            assert!(report["reasonCodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|code| code == reason));
        }
    }

    #[test]
    fn rejects_loader_capability_requirement_without_capability_tokens() {
        let mut candidate = valid_candidate();
        candidate["loaderCapabilityRequirement"] = json!({
            "description": "non-empty but not a loader capability"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["loaderCapabilityContract"]["present"], true);
        assert_eq!(report["loaderCapabilityContract"]["valid"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.loader_capability_requirement_invalid"));
    }

    #[test]
    fn rejects_loader_capability_requirement_with_invalid_selected_artifact_id() {
        let mut candidate = valid_candidate();
        candidate["loaderCapabilityRequirement"] = json!({
            "acceptedTransports": ["ram_blob", "filesystem_path"],
            "selectedArtifactId": "build/device.hsaco"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["loaderCapabilityContract"]["tokens"],
            json!(["filesystem_path", "ram_blob"])
        );
        assert_eq!(
            report["loaderCapabilityContract"]["selectedArtifactIdValid"],
            false
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.loader_capability_requirement_invalid"));
    }

    #[test]
    fn accepts_content_addressed_selected_artifact_identity() {
        let mut candidate = valid_candidate();
        let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        candidate["selectedArtifactId"] = json!(format!("artifact:sha256:{digest}"));
        candidate["artifactHash"] = json!(format!("sha256:{digest}"));
        candidate["loaderCapabilityRequirement"] = json!({
            "acceptedTransports": ["ram_blob", "filesystem_path"],
            "selectedArtifactId": format!("artifact:sha256:{digest}"),
            "contentHash": format!("sha256:{digest}")
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["artifactIdentityContract"]["contentAddressedArtifactIds"],
            true
        );
        assert_eq!(report["artifactIdentityContract"]["idsMatchHashes"], true);
    }

    #[test]
    fn rejects_non_content_addressed_selected_artifact_identity() {
        let mut candidate = valid_candidate();
        candidate["selectedArtifactId"] = json!("artifact:latest");
        candidate["loaderCapabilityRequirement"] = json!({
            "acceptedTransports": ["ram_blob", "filesystem_path"],
            "selectedArtifactId": "artifact:latest"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["artifactIdentityContract"]["contentAddressedArtifactIds"],
            false
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.artifact_identity_invalid"));
    }

    #[test]
    fn rejects_selected_artifact_hash_mismatch() {
        let mut candidate = valid_candidate();
        let id_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let hash_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        candidate["selectedArtifactId"] = json!(format!("artifact:sha256:{id_digest}"));
        candidate["artifactHash"] = json!(format!("sha256:{hash_digest}"));
        candidate["loaderCapabilityRequirement"] = json!({
            "acceptedTransports": ["ram_blob", "filesystem_path"],
            "selectedArtifactId": format!("artifact:sha256:{id_digest}"),
            "contentHash": format!("sha256:{hash_digest}")
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["artifactIdentityContract"]["idsMatchHashes"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.artifact_identity_invalid"));
    }

    #[test]
    fn rejects_artifact_hash_without_selected_artifact_identity() {
        let mut candidate = valid_candidate();
        let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        candidate["artifactHash"] = json!(format!("sha256:{digest}"));

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["artifactIdentityContract"]["idsMatchHashes"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.artifact_identity_invalid"));
    }

    #[test]
    fn rejects_unknown_loader_capability_as_unproven() {
        let mut candidate = valid_candidate();
        candidate["loaderCapabilityRequirement"] = json!({
            "acceptedTransports": ["unknown"]
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["loaderCapabilityContract"]["invalidTokens"],
            json!(["unknown"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.loader_capability_requirement_invalid"));
    }

    #[test]
    fn rejects_candidate_without_oracle() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate
            .as_object_mut()
            .unwrap()
            .remove("outputOracleProposal");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
    }

    #[test]
    fn rejects_candidate_with_placeholder_required_oracle_id_only() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("outputOracleProposal");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["outputOracleContract"]["requiredOracleId"], "oracle:sentinel");
        assert_eq!(report["outputOracleContract"]["proposalPresent"], false);
        assert_eq!(report["outputOracleContract"]["resolvedContractPresent"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
    }

    #[test]
    fn accepts_candidate_with_valid_inline_output_oracle_proposal() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "selected_pixels",
            "producer": "deterministic_probe",
            "expected": [[0, 0, [1.0, 0.0, 0.0, 1.0]]],
            "tolerance": 0.001,
            "outputTargetId": "render-target:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            },
            "sessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact",
            "visualEvidencePlan": {
                "required": true,
                "producer": "validation-capture"
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["outputOracleContract"]["proposalValid"], true);
        assert_eq!(
            report["outputOracleContract"]["proposalKind"],
            "selected_pixels"
        );
        assert_eq!(
            report["outputOracleContract"]["proposalExpectedValuePresent"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalProducerPresent"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceRequired"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceContractPresent"],
            true
        );
    }

    #[test]
    fn accepts_candidate_with_buffer_checksum_output_oracle_proposal() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "buffer_checksum",
            "producer": "deterministic_probe",
            "expectedHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "outputTargetId": "buffer:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            },
            "sessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["outputOracleContract"]["proposalValid"], true);
        assert_eq!(
            report["outputOracleContract"]["proposalKind"],
            "buffer_checksum"
        );
        assert_eq!(
            report["outputOracleContract"]["proposalExpectedValuePresent"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalProducerPresent"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceRequired"],
            false
        );
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceContractPresent"],
            false
        );
    }

    #[test]
    fn accepts_candidate_with_snake_case_output_oracle_contract_aliases() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "buffer_checksum",
            "producer_subsystem": "deterministic_probe",
            "expected_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "output_target": "buffer:primary",
            "readback_after_hmr": true,
            "runtime_session_binding": {
                "source": "runtime-session"
            },
            "artifact_id": "artifact:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["outputOracleContract"]["proposalValid"], true);
        assert_eq!(
            report["outputOracleContract"]["proposalKind"],
            "buffer_checksum"
        );
        assert_eq!(
            report["outputOracleContract"]["proposalRuntimeSessionBindingPresent"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalArtifactBindingPresent"],
            true
        );
    }

    #[test]
    fn accepts_render_output_oracle_with_visual_ref_alias() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "selected_pixel_values",
            "producer": "deterministic_probe",
            "expected": [[0, 0, [1.0, 0.0, 0.0, 1.0]]],
            "outputTargetId": "render-target:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch"
            },
            "runtimeSessionId": "runtime-session:current",
            "artifactId": "artifact:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "visual_ref": "validation-screenshot:fresh-frame"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["outputOracleContract"]["proposalValid"], true);
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceRequired"],
            true
        );
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceContractPresent"],
            true
        );
    }

    #[test]
    fn rejects_inline_output_oracle_with_unknown_kind() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "screenshot_changed",
            "producer": "deterministic_probe",
            "expected": "changed",
            "outputTargetId": "render-target:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            },
            "sessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["outputOracleContract"]["proposalValid"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_invalid"));
    }

    #[test]
    fn rejects_inline_output_oracle_without_runtime_binding_contract() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "buffer_checksum",
            "producer": "deterministic_probe",
            "expectedHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "outputTargetId": "buffer:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["outputOracleContract"]["proposalValid"], false);
        assert_eq!(
            report["outputOracleContract"]["proposalRuntimeSessionBindingPresent"],
            false
        );
        assert_eq!(
            report["outputOracleContract"]["proposalArtifactBindingPresent"],
            false
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_invalid"));
    }

    #[test]
    fn rejects_render_output_oracle_without_visual_evidence_contract() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "render_target_hash",
            "producer": "deterministic_probe",
            "expectedHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "outputTargetId": "render-target:primary",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            },
            "sessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["outputOracleContract"]["proposalValid"], false);
        assert_eq!(
            report["outputOracleContract"]["proposalVisualEvidenceContractPresent"],
            false
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_invalid"));
    }

    #[test]
    fn rejects_inline_output_oracle_without_expected_value() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("requiredOracleId");
        candidate["outputOracleProposal"] = json!({
            "kind": "dispatch_counter",
            "producer": "deterministic_probe",
            "outputTargetId": "dispatch-counter:main",
            "readbackPlan": {
                "syncPoint": "after-dispatch",
                "timestampSource": "runtime-boundary"
            },
            "sessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact"
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_invalid"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_without_mapping() {
        let mut candidate = valid_candidate();
        candidate["requiresOriginalHostPath"] = json!(true);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["originalHostLaunchMappingRequired"], true);
        assert_eq!(report["originalHostLaunchMappingId"], Value::Null);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_launch_mapping_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_mapping_but_no_instrumentation() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["originalHostLaunchMappingRequired"], true);
        assert_eq!(
            report["originalHostLaunchMappingId"],
            "host-launch:mapped-runtime-boundary"
        );
        assert_eq!(
            report["originalHostLaunchMappingEvidenceIds"],
            json!(["evidence:original-host-launch-mapping:runtime-boundary"])
        );
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_bare_proposal_id() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [
                    "launch-attachment-proposal:sha256:abc"
                ]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_incomplete_instrumentation_proposal() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [
                    {
                        "proposalId": "launch-attachment-proposal:sha256:abc",
                        "sourceLaunchSiteId": "launch-site:sha256:def",
                        "hostPathId": "host-path:sha256:123",
                        "requiredBoundaryApis": [
                            "synthi_gpu_launch_source_location",
                            "synthi_gpu_launch_original_host_path"
                        ],
                        "runtimeEvidenceRequired": {
                            "runtimeSessionScoped": true,
                            "dispatchBoundaryObserved": true,
                            "dispatchEntryRuntimeVerified": true
                        }
                    }
                ]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_partial_boundary_api_contract() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [{
                    "proposalId": "launch-attachment-proposal:sha256:abc",
                    "sourceLaunchSiteId": "launch-site:sha256:def",
                    "hostPathId": "host-path:sha256:abc",
                    "path": "src/render_loop.cpp",
                    "line": 42,
                    "column": 17,
                    "sourceProvenance": "source_baseline_contents",
                    "sourceHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "snippetHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "instrumentationAction": "upgrade_runtime_boundary_to_original_host_attachment",
                    "requiredBoundaryApis": [
                        "synthi_gpu_launch_source_location",
                        "synthi_gpu_launch_original_host_path"
                    ],
                    "runtimeEvidenceRequired": {
                        "runtimeSessionScoped": true,
                        "dispatchBoundaryObserved": true,
                        "dispatchEntryRuntimeVerified": true,
                        "launchArgProvenanceComplete": true
                    },
                    "attachmentContract": valid_attachment_contract()
                }]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn accepts_original_host_attachment_candidate_with_mapping_and_instrumentation_proposal() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [{
                    "proposalId": "launch-attachment-proposal:sha256:abc",
                    "sourceLaunchSiteId": "launch-site:sha256:def",
                    "hostPathId": "host-path:sha256:abc",
                    "path": "src/render_loop.cpp",
                    "line": 42,
                    "column": 17,
                    "sourceProvenance": "source_baseline_contents",
                    "sourceHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "snippetHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "instrumentationAction": "upgrade_runtime_boundary_to_original_host_attachment",
                    "requiredBoundaryApis": [
                        "synthi_gpu_launch_source_location",
                        "synthi_gpu_launch_original_host_path",
                        "synthi_original_host_path_with_provenance"
                    ],
                    "runtimeEvidenceRequired": {
                        "runtimeSessionScoped": true,
                        "dispatchBoundaryObserved": true,
                        "dispatchEntryRuntimeVerified": true,
                        "launchArgProvenanceComplete": true
                    },
                    "attachmentContract": valid_attachment_contract()
                }]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["originalHostLaunchMappingRequired"], true);
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!(["launch-attachment-proposal:sha256:abc"])
        );
        assert_eq!(report["originalHostRuntimeAttachmentProven"], false);
    }

    #[test]
    fn rejects_original_host_attachment_candidate_without_attachment_contract() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [{
                    "proposalId": "launch-attachment-proposal:sha256:abc",
                    "sourceLaunchSiteId": "launch-site:sha256:def",
                    "hostPathId": "host-path:sha256:abc",
                    "path": "src/render_loop.cpp",
                    "line": 42,
                    "column": 17,
                    "sourceProvenance": "source_baseline_contents",
                    "sourceHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "snippetHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "instrumentationAction": "upgrade_runtime_boundary_to_original_host_attachment",
                    "requiredBoundaryApis": [
                        "synthi_gpu_launch_source_location",
                        "synthi_gpu_launch_original_host_path",
                        "synthi_original_host_path_with_provenance"
                    ],
                    "runtimeEvidenceRequired": {
                        "runtimeSessionScoped": true,
                        "dispatchBoundaryObserved": true,
                        "dispatchEntryRuntimeVerified": true,
                        "launchArgProvenanceComplete": true
                    }
                }]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn accepts_original_host_attachment_candidate_with_native_launch_api_proposal() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!({
            "required": true,
            "reason": "attach through preserved runtime launch boundary"
        });
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-native-api");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:native-api"]);
        candidate["launchAttachmentScout"] = json!({
            "mapping": {
                "attachmentInstrumentationProposals": [{
                    "proposalId": "launch-attachment-proposal:sha256:abc",
                    "sourceLaunchSiteId": "launch-site:sha256:def",
                    "hostPathId": "host-path:sha256:abc",
                    "path": "src/render_loop.cpp",
                    "line": 42,
                    "column": 17,
                    "sourceProvenance": "source_baseline_contents",
                    "sourceHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "snippetHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "instrumentationAction": "wrap_native_launch_api_with_synthi_runtime_boundary",
                    "requiredBoundaryApis": [
                        "synthi_gpu_launch_source_location",
                        "synthi_gpu_launch_original_host_path",
                        "synthi_original_host_path_with_provenance"
                    ],
                    "runtimeEvidenceRequired": {
                        "runtimeSessionScoped": true,
                        "dispatchBoundaryObserved": true,
                        "dispatchEntryRuntimeVerified": true,
                        "launchArgProvenanceComplete": true
                    },
                    "attachmentContract": valid_attachment_contract()
                }]
            }
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["originalHostAttachmentInstrumentationProposalIds"],
            json!(["launch-attachment-proposal:sha256:abc"])
        );
        assert_eq!(report["originalHostRuntimeAttachmentProven"], false);
    }

    #[test]
    fn accepts_original_host_attachment_candidate_with_runtime_proven_attachment() {
        let mut candidate = valid_candidate();
        candidate["requiresOriginalHostPath"] = json!(true);
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "runtimeAttachmentProven": true,
            "runtimeAttachmentEvidenceIds": [
                "evidence:original-host-runtime-attachment:runtime-boundary"
            ]
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["originalHostRuntimeAttachmentProven"], true);
        assert_eq!(
            report["originalHostRuntimeAttachmentEvidenceIds"],
            json!(["evidence:original-host-runtime-attachment:runtime-boundary"])
        );
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_mapping_evidence_as_runtime_attachment() {
        let mut candidate = valid_candidate();
        candidate["requiresOriginalHostPath"] = json!(true);
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "runtimeAttachmentProven": true,
            "runtimeAttachmentEvidenceIds": [
                "evidence:original-host-launch-mapping:runtime-boundary"
            ]
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["originalHostRuntimeAttachmentProven"], false);
        assert_eq!(
            report["originalHostRuntimeAttachmentEvidenceIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_with_bare_runtime_attachment_claim() {
        let mut candidate = valid_candidate();
        candidate["requiresOriginalHostPath"] = json!(true);
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");
        candidate["originalHostLaunchMappingEvidenceIds"] =
            json!(["evidence:original-host-launch-mapping:runtime-boundary"]);
        candidate["launchAttachmentScout"] = json!({
            "runtimeAttachmentProven": true
        });

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["originalHostRuntimeAttachmentProven"], false);
        assert_eq!(
            report["originalHostRuntimeAttachmentEvidenceIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_attachment_instrumentation_missing"));
    }

    #[test]
    fn rejects_original_host_attachment_candidate_without_mapping_evidence() {
        let mut candidate = valid_candidate();
        candidate["requiresOriginalHostPath"] = json!(true);
        candidate["originalHostLaunchMappingId"] = json!("host-launch:mapped-runtime-boundary");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["outputOracleContract"]["proposalValid"], true);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.original_host_launch_mapping_evidence_missing"));
        assert_eq!(report["originalHostLaunchMappingEvidenceIds"], json!([]));
    }

    #[test]
    fn rejects_epoch_candidate_without_stream_and_retirement_evidence() {
        let mut candidate = valid_candidate();
        candidate["epochPublicationRequired"] = json!(true);
        candidate["epochRetirementRequirement"] = json!("required");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["streamOrderingRequired"], true);
        assert_eq!(report["epochRetirementRequired"], true);
        assert_eq!(report["streamOrderingEvidenceIds"], json!([]));
        assert_eq!(report["epochRetirementEvidenceIds"], json!([]));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.stream_ordering_evidence_missing"));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.epoch_retirement_unavailable"));
    }

    #[test]
    fn accepts_epoch_candidate_with_deterministic_stream_and_retirement_evidence() {
        let mut candidate = valid_candidate();
        candidate["streamOrderingRequirement"] = json!({"required": true});
        candidate["streamRetirementRequired"] = json!(true);
        candidate["streamOrderingEvidenceIds"] = json!(["evidence:stream-ordering:launch"]);
        candidate["epochRetirementEvidenceIds"] = json!(["evidence:epoch-retirement:fence"]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["streamOrderingRequired"], true);
        assert_eq!(report["epochRetirementRequired"], true);
        assert_eq!(
            report["streamOrderingEvidenceIds"],
            json!(["evidence:stream-ordering:launch"])
        );
        assert_eq!(
            report["epochRetirementEvidenceIds"],
            json!(["evidence:epoch-retirement:fence"])
        );
    }

    #[test]
    fn does_not_require_original_host_mapping_for_optional_requirement() {
        let mut candidate = valid_candidate();
        candidate["originalHostPathRequirement"] = json!("optional");
        candidate["runtimeOwnershipRequirement"] = json!(true);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["originalHostLaunchMappingRequired"], false);
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
        assert_eq!(
            report["unmappedSourceSpanPaths"],
            json!(["src/other.kernel"])
        );
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
        assert_eq!(
            report["normalizedSourcePaths"],
            json!(["src/device.kernel"])
        );
        assert_eq!(report["unmappedSourceSpanPaths"], json!([]));
    }

    #[test]
    fn rejects_generated_device_candidate_without_generated_role_path() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("generatedRolePath");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["generatedRolePathRequired"], true);
        assert_eq!(report["generatedRolePath"], Value::Null);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.generated_role_path_missing"));
    }

    #[test]
    fn accepts_source_only_function_body_candidate_without_generated_role_path() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("function_body");
        candidate["exportedSymbolsExpected"] = json!(["step"]);
        candidate
            .as_object_mut()
            .unwrap()
            .remove("generatedRolePath");
        candidate
            .as_object_mut()
            .unwrap()
            .remove("safeExportSupersetReason");
        candidate
            .as_object_mut()
            .unwrap()
            .remove("narrowerCandidateRejections");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["generatedRolePathRequired"], false);
        assert_eq!(report["generatedRolePath"], Value::Null);
    }

    #[test]
    fn rejects_invalid_generated_role_path() {
        let mut candidate = valid_candidate();
        candidate["generatedRolePath"] = json!("../outside/device.kernel");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["generatedRolePathRequired"], true);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.generated_role_path_invalid"));
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
        candidate
            .as_object_mut()
            .unwrap()
            .remove("safeExportSupersetReason");

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
    fn rejects_unclassified_artifact_kind() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("opaque_ad_hoc_blob");
        candidate["replacementScope"] = json!("opaque_ad_hoc_blob");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["artifactKindScopeRank"], json!(null));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.artifactKind_invalid"));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.replacementScope_invalid"));
    }

    #[test]
    fn rejects_replacement_scope_that_is_narrower_than_artifact_kind() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("full_device_module");
        candidate["replacementScope"] = json!("function_body");
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
            },
            {
                "scopeRank": 2,
                "reasonCode": "fission.symbol_ownership_ambiguous",
                "verifierEvidenceIds": ["evidence:symbol-ownership"]
            }
        ]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["artifactKindScopeRank"], json!(3));
        assert_eq!(report["replacementScopeRank"], json!(3));
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.replacement_scope_narrows_artifact_kind"));
    }

    #[test]
    fn accepts_body_scope_without_narrower_rejection_proof() {
        let mut candidate = valid_candidate();
        candidate["artifactKind"] = json!("function_body");
        candidate["exportedSymbolsExpected"] = json!(["step"]);
        candidate
            .as_object_mut()
            .unwrap()
            .remove("safeExportSupersetReason");
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
        candidate
            .as_object_mut()
            .unwrap()
            .remove("safeExportSupersetReason");

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
    fn rejects_ai_marked_candidate_without_ai_proposal_id() {
        let mut candidate = valid_candidate();
        candidate["proposalSource"] = json!("ai_delta");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["aiProposalIdRequired"], true);
        assert_eq!(report["aiProposalId"], Value::Null);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.ai_proposal_id_missing"));
    }

    #[test]
    fn accepts_ai_marked_candidate_with_ai_proposal_id_and_deterministic_evidence() {
        let mut candidate = valid_candidate();
        candidate["proposalSource"] = json!({"planner": "llm_fission_planner"});
        candidate["aiProposalId"] = json!("ai:fission:proposal:123");
        candidate["deterministicPromotionEvidenceIds"] = json!(["evidence:fission-promotion"]);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["aiProposalIdRequired"], true);
        assert_eq!(report["aiProposalId"], "ai:fission:proposal:123");
        assert_eq!(
            report["aiProposalDeterministicPromotionEvidenceIds"],
            json!(["evidence:fission-promotion"])
        );
        assert_eq!(
            report["deterministicVerifierEvidenceIds"],
            json!(["evidence:source-map"])
        );
    }

    #[test]
    fn rejects_ai_marked_candidate_without_deterministic_promotion_evidence() {
        let mut candidate = valid_candidate();
        candidate["proposalSource"] = json!("ai_delta");
        candidate["aiProposalId"] = json!("ai:fission:proposal:456");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["aiProposalIdRequired"], true);
        assert_eq!(
            report["aiProposalDeterministicPromotionEvidenceIds"],
            json!([])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.ai_proposal_deterministic_promotion_missing"));
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
        assert_eq!(
            report["selectionDecision"]["selectedIslandId"],
            "island:narrow"
        );
        assert_eq!(report["selectionDecision"]["selectedCandidateIndex"], 1);
        assert_eq!(
            report["selectionDecision"]["selectedScore"],
            report["candidates"][1]["selectionScore"]
        );
        assert_eq!(report["candidates"][0]["selected"], false);
        assert_eq!(report["candidates"][1]["selected"], true);
    }

    #[test]
    fn ranks_equal_scope_candidates_by_compile_cost_and_history() {
        let mut slower = valid_candidate();
        slower["islandId"] = json!("island:slower");
        slower["compileCostEstimateMs"] = json!(250);
        slower["historicalTimingMs"] = json!(40);

        let mut faster = valid_candidate();
        faster["islandId"] = json!("island:faster");
        faster["compileCostEstimateMs"] = json!(50);
        faster["historicalTimingMs"] = json!(400);

        let report = verify_fission_candidates(&json!([slower, faster]));

        assert_eq!(report["status"], "pass");
        assert_eq!(report["selectedIslandId"], "island:faster");
        assert_eq!(report["selectedCandidateIndex"], 1);
        assert_eq!(
            report["candidates"][0]["selectionScore"]["compileCostEstimateMs"],
            json!(250)
        );
        assert_eq!(
            report["candidates"][1]["selectionScore"]["compileCostEstimateMs"],
            json!(50)
        );
    }

    #[test]
    fn uses_historical_timing_as_tie_break_after_compile_cost() {
        let mut slower_history = valid_candidate();
        slower_history["islandId"] = json!("island:slow-history");
        slower_history["estimatedCompileMs"] = json!("80");
        slower_history["p50CompileMs"] = json!(300);

        let mut faster_history = valid_candidate();
        faster_history["islandId"] = json!("island:fast-history");
        faster_history["estimatedCompileMs"] = json!("80");
        faster_history["p50CompileMs"] = json!(20);

        let report = verify_fission_candidates(&json!([slower_history, faster_history]));

        assert_eq!(report["status"], "pass");
        assert_eq!(report["selectedIslandId"], "island:fast-history");
        assert_eq!(report["selectedCandidateIndex"], 1);
        assert_eq!(
            report["candidates"][1]["selectionScore"]["historicalTimingMs"],
            json!(20)
        );
    }

    #[test]
    fn rejected_candidates_are_not_selected() {
        let mut rejected = valid_candidate();
        rejected.as_object_mut().unwrap().remove("requiredOracleId");
        rejected
            .as_object_mut()
            .unwrap()
            .remove("outputOracleProposal");

        let report = verify_fission_candidates(&json!([rejected]));

        assert_eq!(report["status"], "reject");
        assert_eq!(report["selectedIslandId"], Value::Null);
        assert_eq!(report["selectedCandidateIndex"], Value::Null);
        assert_eq!(report["candidates"][0]["selected"], false);
    }

    #[test]
    fn rejected_candidate_report_preserves_specific_reason_codes() {
        let mut rejected = valid_candidate();
        rejected.as_object_mut().unwrap().remove("requiredOracleId");
        rejected
            .as_object_mut()
            .unwrap()
            .remove("outputOracleProposal");

        let report = verify_fission_candidates(&json!([rejected]));
        let reason_codes = report["reasonCodes"].as_array().unwrap();

        assert!(reason_codes
            .iter()
            .any(|code| code == "fission.no_accepted_candidate"));
        assert!(reason_codes
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
    }
}
