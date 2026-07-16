use crate::hmr::gpu_proof::GpuHmrProofEvidenceRef;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const FISSION_ISLAND_SCHEMA_VERSION: &str = "synthi.gpu.fission_island.v1";
pub const FISSION_VERIFIER_SCHEMA_VERSION: &str = "synthi.gpu.fission_verifier.v1";
pub const FISSION_VERIFIER_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_verifier_evidence.v2";
const FISSION_PHASE_SOURCE_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_phase_source_evidence.v1";
pub(crate) const FISSION_RUN_BINDING_SCHEMA_VERSION: &str = "synthi.gpu.fission_run_binding.v1";
const FISSION_VERIFIER_EVIDENCE_AUTHORITY: &str =
    "trusted_source_binding_support_only_not_gpu_hmr_or_runtime_authority";
const FISSION_PHASE_SOURCE_EVIDENCE_AUTHORITY: &str =
    "support_only_not_gpu_hmr_runtime_or_dispatch_authority";
const FISSION_PHASE_SOURCE_EVIDENCE_KIND: &str = "fission-phase-source";
const FISSION_SOURCE_MAPPING_EVIDENCE_KIND: &str = "fission-source-mapping";
const FISSION_SOURCE_MAPPING_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_source_mapping_evidence.v1";
const FISSION_INCLUDE_CLOSURE_EVIDENCE_KIND: &str = "fission-include-closure";
const FISSION_INCLUDE_CLOSURE_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_include_closure_evidence.v1";
const FISSION_DEPENDENCY_CLOSURE_EVIDENCE_KIND: &str = "fission-dependency-closure";
const FISSION_DEPENDENCY_CLOSURE_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_dependency_closure_evidence.v1";
const FISSION_SYMBOL_OWNERSHIP_EVIDENCE_KIND: &str = "device-symbol-set";
const FISSION_SYMBOL_OWNERSHIP_EVIDENCE_SCHEMA_VERSION: &str = "synthi.gpu.hmr.symbol_set.v1";
const FISSION_ABI_MEMBRANE_EVIDENCE_KIND: &str = "device-abi-metadata";
const FISSION_ABI_MEMBRANE_EVIDENCE_SCHEMA_VERSION: &str = "synthi.gpu.hmr.abi_metadata.v1";
const FISSION_COMPILE_RECIPE_EVIDENCE_KIND: &str = "fission-compile-recipe";
const FISSION_COMPILE_RECIPE_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_compile_recipe_evidence.v1";
const FISSION_COMPILER_EVIDENCE_KIND: &str = "device-compiler-output";
const FISSION_COMPILER_EVIDENCE_SCHEMA_VERSION: &str = "synthi.gpu.hmr.compiler_evidence.v1";
const FISSION_LOADER_CAPABILITY_EVIDENCE_KIND: &str = "device-artifact-transport";
const FISSION_LOADER_CAPABILITY_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.hmr.artifact_transport.v1";
const FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_KIND: &str = "fission-output-oracle-contract";
const FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_output_oracle_contract_evidence.v1";
const FISSION_OUTPUT_ORACLE_OBSERVATION_EVIDENCE_KIND: &str = "fission-output-oracle-observation";
const FISSION_OUTPUT_ORACLE_OBSERVATION_EVIDENCE_SCHEMA_VERSION: &str =
    "synthi.gpu.fission_output_oracle_observation_evidence.v1";
const FISSION_SYMBOL_OWNERSHIP_EVIDENCE_ID_DESCRIPTOR: &str = "device-symbols";
const FISSION_COMPILER_EVIDENCE_ID_DESCRIPTOR: &str = "device-compiler";
const INTERNAL_VALIDATED_EVIDENCE_RECORDS_FIELD: &str =
    "__synthiTrustedValidatedFissionEvidenceRecords";
const INTERNAL_INVALID_EVIDENCE_RECORD_COUNT_FIELD: &str =
    "__synthiTrustedInvalidFissionEvidenceRecordCount";
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

const GENERATED_TOPOLOGY_EVIDENCE_FIELDS: &[&str] = &[
    "generatedTopologyEvidenceIds",
    "generatedDeviceTopologyEvidenceIds",
    "topologyEvidenceIds",
    "selectedArtifactTopologyEvidenceIds",
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
}

const REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES: &[VerificationEvidenceCategory] = &[
    VerificationEvidenceCategory {
        name: "source_mapping",
        fields: &["sourceMappingEvidenceIds", "sourceMapEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "include_closure",
        fields: &["includeClosureEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "symbol_ownership",
        fields: &["symbolOwnershipEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "dependency_closure",
        fields: &["dependencyClosureEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "abi_membrane",
        fields: &["abiMembraneEvidenceIds", "abiEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "compile_recipe",
        fields: &[
            "compileRecipeEvidenceIds",
            "compileCommandEvidenceIds",
            "compileEvidenceIds",
        ],
    },
    VerificationEvidenceCategory {
        name: "loader_capability",
        fields: &["loaderCapabilityEvidenceIds", "loaderEvidenceIds"],
    },
    VerificationEvidenceCategory {
        name: "output_oracle",
        fields: &["outputOracleEvidenceIds", "oracleEvidenceIds"],
    },
];

#[derive(Clone, Copy, Debug)]
pub(crate) struct FissionEvidenceProducerContext<'a> {
    pub(crate) producer_subsystem: &'a str,
    pub(crate) timestamp: &'a str,
    pub(crate) session_id: &'a str,
    pub(crate) source_edit_id: &'a str,
    pub(crate) selected_artifact_id: &'a str,
    pub(crate) file_path: Option<&'a str>,
}

/// Produce current-run, support-only phase evidence at a trusted Rust boundary.
/// The returned records must be retained and supplied to
/// `verify_fission_candidates_with_evidence` in the same run.
pub(crate) fn produce_fission_phase_source_evidence(
    candidate: &mut Value,
    trusted_upstream_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> Result<Vec<GpuHmrProofEvidenceRef>, &'static str> {
    if !candidate.is_object() {
        return Err("fission evidence candidate must be an object");
    }
    if !canonical_nonempty_string(context.producer_subsystem) {
        return Err("fission evidence producer subsystem must be non-empty");
    }
    if !canonical_nonempty_string(context.timestamp) {
        return Err("fission evidence timestamp must be non-empty");
    }
    if !canonical_nonempty_string(context.session_id) {
        return Err("fission evidence session id must be non-empty");
    }
    if !canonical_nonempty_string(context.source_edit_id) {
        return Err("fission evidence source edit id must be non-empty");
    }
    if !canonical_nonempty_string(context.selected_artifact_id) {
        return Err("fission evidence selected artifact id must be non-empty");
    }
    if candidate.get("sourceEditId").and_then(Value::as_str) != Some(context.source_edit_id)
        || candidate.get("selectedArtifactId").and_then(Value::as_str)
            != Some(context.selected_artifact_id)
    {
        return Err("fission evidence candidate does not match current run context");
    }
    if context
        .file_path
        .is_some_and(|value| !canonical_nonempty_string(value))
    {
        return Err("fission evidence file path must be non-empty when present");
    }

    let mut produced = Vec::new();
    for category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
        let upstream_evidence_ids = declared_category_source_evidence_ids(candidate, category.name)
            .map_err(|_| "fission category evidence declaration must contain unique canonical ids")?
            .into_iter()
            .collect::<Vec<_>>();
        if upstream_evidence_ids.is_empty() {
            continue;
        }
        let record = phase_source_evidence_record(
            candidate,
            category.name,
            upstream_evidence_ids,
            trusted_upstream_evidence,
            context,
        )
        .ok_or("fission phase evidence could not join current-run upstream evidence")?;
        produced.push((category, record));
    }

    if let Some(object) = candidate.as_object_mut() {
        for (category, record) in &produced {
            for field in category.fields {
                object.remove(*field);
            }
            object.insert(category.fields[0].to_string(), json!([record.evidence_id]));
        }
    }

    let verifier_records = produced
        .iter()
        .filter_map(|(category, source_record)| {
            content_bound_fission_evidence_record(
                candidate,
                category.name,
                source_record,
                trusted_upstream_evidence,
                context,
            )
        })
        .collect::<Vec<_>>();
    let verifier_evidence_ids = verifier_records
        .iter()
        .filter_map(|record| record.get("evidenceId").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(object) = candidate.as_object_mut() {
        object.insert(
            "verifierEvidenceRecords".to_string(),
            Value::Array(verifier_records),
        );
        object.insert(
            "verifierEvidenceIds".to_string(),
            json!(verifier_evidence_ids),
        );
    }

    Ok(produced.into_iter().map(|(_, record)| record).collect())
}

pub(crate) fn current_run_fission_category_evidence_valid(
    candidate: &Value,
    category: &str,
    evidence_id: &str,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    exactly_one_trusted_evidence_record(trusted_evidence, evidence_id).is_some_and(|record| {
        current_run_upstream_record_valid_for_category(
            candidate,
            category,
            record,
            trusted_evidence,
            context,
        )
    })
}

pub fn verify_fission_candidates(value: &Value) -> Value {
    verify_fission_candidates_internal(value, &[], None)
}

pub(crate) fn verify_fission_candidates_with_evidence(
    value: &Value,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> Value {
    verify_fission_candidates_internal(value, trusted_evidence, Some(context))
}

fn verify_fission_candidates_internal(
    value: &Value,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: Option<FissionEvidenceProducerContext<'_>>,
) -> Value {
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
        let report = verify_fission_candidate_with_evidence(&candidate, trusted_evidence, context);
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
    verify_fission_candidate_with_evidence(candidate, &[], None)
}

fn verify_fission_candidate_with_evidence(
    candidate: &Value,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: Option<FissionEvidenceProducerContext<'_>>,
) -> Value {
    let prepared_candidate =
        candidate_with_validated_evidence(candidate, trusted_evidence, context);
    verify_prepared_fission_candidate(&prepared_candidate)
}

fn verify_prepared_fission_candidate(candidate: &Value) -> Value {
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
    if invalid_content_bound_fission_evidence_record_count(candidate) > 0 {
        reason_codes.push("fission.verifier_evidence_record_invalid".to_string());
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
    if !output_oracle_resolved_aliases_unambiguous(candidate) {
        reason_codes.push("fission.output_oracle_alias_conflict".to_string());
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

    if !generated_topology_binding_valid(candidate) {
        reason_codes.push("fission.claim_narrower_than_generated_topology".to_string());
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
    let reported_candidate = candidate_without_internal_evidence_fields(candidate);

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
        "contentBoundVerifierEvidenceRecords": valid_content_bound_fission_evidence_records(candidate),
        "invalidContentBoundVerifierEvidenceRecordCount": invalid_content_bound_fission_evidence_record_count(candidate),
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
        "generatedTopologyBinding": generated_topology_binding_summary(candidate),
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
        "verifierEvidenceId": verifier_evidence_id(&reported_candidate, status),
        "candidate": reported_candidate,
    })
}

fn collect_candidates(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::Object(_) => vec![value.clone()],
        _ => Vec::new(),
    }
}

fn candidate_without_internal_evidence_fields(candidate: &Value) -> Value {
    let mut candidate = candidate.clone();
    if let Some(object) = candidate.as_object_mut() {
        object.remove(INTERNAL_VALIDATED_EVIDENCE_RECORDS_FIELD);
        object.remove(INTERNAL_INVALID_EVIDENCE_RECORD_COUNT_FIELD);
    }
    candidate
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

fn generated_topology_binding_required(candidate: &Value) -> bool {
    replacement_scope_rank(candidate) < 2 && generated_role_path_required(candidate)
}

fn generated_topology_binding_valid(candidate: &Value) -> bool {
    if !generated_topology_binding_required(candidate) {
        return true;
    }
    !generated_topology_evidence_ids(candidate).is_empty()
        && selected_artifact_content_addressed_and_hashed(candidate)
        && generated_role_path(candidate).is_some()
        && generated_topology_binding_object_valid(candidate)
}

fn generated_topology_evidence_ids(candidate: &Value) -> Vec<String> {
    deterministic_evidence_ids_for_category(
        candidate,
        GENERATED_TOPOLOGY_EVIDENCE_FIELDS,
        &[
            "generated_topology",
            "device_topology",
            "generated_manifest_device_role_topology",
            "selected_artifact_topology",
        ],
    )
}

fn selected_artifact_content_addressed_and_hashed(candidate: &Value) -> bool {
    !artifact_identity_ids(candidate).is_empty()
        && !artifact_identity_hashes(candidate).is_empty()
        && artifact_identity_contract_valid(candidate)
}

fn generated_topology_binding_object(candidate: &Value) -> Option<&Value> {
    [
        "generatedTopologyBinding",
        "generatedDeviceTopologyBinding",
        "selectedArtifactTopology",
    ]
    .iter()
    .find_map(|field| candidate.get(*field).filter(|value| value.is_object()))
}

fn generated_topology_binding_object_valid(candidate: &Value) -> bool {
    let Some(binding) = generated_topology_binding_object(candidate) else {
        return false;
    };
    let Some(binding_object) = binding.as_object() else {
        return false;
    };
    if !topology_binding_source_valid(binding_object) {
        return false;
    }
    if !topology_binding_materialized_partial_artifact(binding_object) {
        return false;
    }
    let Some(candidate_path) = generated_role_path(candidate) else {
        return false;
    };
    let Some(binding_path) = topology_binding_generated_role_path(binding_object) else {
        return false;
    };
    if binding_path != candidate_path {
        return false;
    }
    topology_binding_artifact_identity_matches_candidate(binding, candidate)
}

fn topology_binding_source_valid(object: &serde_json::Map<String, Value>) -> bool {
    object
        .get("source")
        .and_then(Value::as_str)
        .or_else(|| object.get("proofBoundary").and_then(Value::as_str))
        .map(normalized_scope_text)
        .is_some_and(|value| {
            value.contains("generated")
                && value.contains("topology")
                && (value.contains("manifest") || value.contains("device_role"))
        })
}

fn topology_binding_materialized_partial_artifact(object: &serde_json::Map<String, Value>) -> bool {
    bool_true(object.get("materializedPartialArtifact"))
        || bool_true(object.get("separatelyMaterializedPartialArtifact"))
        || bool_true(object.get("contentAddressedPartialArtifact"))
}

fn topology_binding_generated_role_path(object: &serde_json::Map<String, Value>) -> Option<String> {
    [
        "generatedRolePath",
        "generatedPath",
        "deviceTranslationUnitPath",
        "path",
    ]
    .iter()
    .find_map(|field| object.get(*field).and_then(Value::as_str))
    .and_then(normalized_project_path)
}

fn topology_binding_artifact_identity_matches_candidate(
    binding: &Value,
    candidate: &Value,
) -> bool {
    let binding_ids = artifact_identity_ids(binding);
    let binding_hashes = artifact_identity_hashes(binding);
    if binding_ids.is_empty()
        || binding_hashes.is_empty()
        || !binding_ids
            .iter()
            .all(|id| content_addressed_artifact_id_valid(id))
        || !binding_hashes.iter().all(|hash| sha256_digest_value(hash))
    {
        return false;
    }
    let candidate_ids: BTreeSet<String> = artifact_identity_ids(candidate).into_iter().collect();
    let candidate_hashes: BTreeSet<String> = artifact_identity_hashes(candidate)
        .into_iter()
        .filter_map(|hash| canonical_sha256_digest(&hash))
        .collect();
    binding_ids.iter().any(|id| candidate_ids.contains(id))
        && binding_hashes.iter().any(|hash| {
            canonical_sha256_digest(hash).is_some_and(|digest| candidate_hashes.contains(&digest))
        })
}

fn generated_topology_binding_summary(candidate: &Value) -> Value {
    json!({
        "required": generated_topology_binding_required(candidate),
        "valid": generated_topology_binding_valid(candidate),
        "evidenceIds": generated_topology_evidence_ids(candidate),
        "generatedRolePath": generated_role_path(candidate),
        "selectedArtifactContentAddressedAndHashed": selected_artifact_content_addressed_and_hashed(candidate),
        "bindingPresent": generated_topology_binding_object(candidate).is_some(),
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

fn output_oracle_resolved_aliases_unambiguous(candidate: &Value) -> bool {
    [
        "outputOracleContract",
        "resolvedOutputOracleContract",
        "output_oracle_contract",
        "resolved_output_oracle_contract",
    ]
    .iter()
    .filter(|field| candidate.get(**field).is_some())
    .count()
        <= 1
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

fn output_oracle_resolved_contract_kind(object: &serde_json::Map<String, Value>) -> Option<String> {
    let kind = object.get("kind").and_then(Value::as_str)?;
    let normalized = normalized_scope_text(kind);
    (!normalized.is_empty()).then_some(normalized)
}

fn output_oracle_resolved_contract_valid(candidate: &Value) -> bool {
    if !output_oracle_resolved_aliases_unambiguous(candidate) {
        return false;
    }
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

fn canonical_source_evidence_id(value: &str) -> bool {
    let normalized = value.trim();
    let Some(rest) = normalized.strip_prefix("evidence:") else {
        return false;
    };
    let Some((descriptor, digest)) = rest.rsplit_once(':') else {
        return false;
    };
    let descriptor_tokens = descriptor
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    !descriptor_tokens.is_empty()
        && !descriptor_tokens
            .iter()
            .any(|token| matches!(token.as_str(), "ai" | "llm" | "model" | "proposal"))
        && digest.len() == 64
        && digest
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn evidence_subject_field(candidate: &Value, field: &str) -> Value {
    candidate.get(field).cloned().unwrap_or(Value::Null)
}

fn proof_authority_field(key: &str) -> bool {
    matches!(
        key,
        "acceptedForGpuHmr"
            | "accepted_for_gpu_hmr"
            | "gpuHmrSuccess"
            | "gpu_hmr_success"
            | "canSatisfyGpuHmr"
            | "can_satisfy_gpu_hmr"
            | "canSatisfyRuntimeProof"
            | "can_satisfy_runtime_proof"
            | "canSatisfyDispatchProof"
            | "can_satisfy_dispatch_proof"
            | "gpuHmrAuthority"
            | "gpu_hmr_authority"
            | "runtimeAuthority"
            | "runtime_authority"
            | "dispatchAuthority"
            | "dispatch_authority"
            | "proofAuthority"
            | "proof_authority"
    )
}

fn strip_proof_authority_fields(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(strip_proof_authority_fields).collect())
        }
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| !proof_authority_field(key))
                .map(|(key, value)| (key.clone(), strip_proof_authority_fields(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub(crate) fn fission_output_oracle_evidence_subject(candidate: &Value) -> Value {
    canonical_json_value(&json!({
        "requiredOracleId": evidence_subject_field(candidate, "requiredOracleId"),
        "requiredOutputOracleId": evidence_subject_field(candidate, "requiredOutputOracleId"),
        "outputOracleRequirement": strip_proof_authority_fields(&evidence_subject_field(candidate, "outputOracleRequirement")),
        "outputOracleContract": strip_proof_authority_fields(&evidence_subject_field(candidate, "outputOracleContract")),
        "resolvedOutputOracleContract": strip_proof_authority_fields(&evidence_subject_field(candidate, "resolvedOutputOracleContract")),
        "output_oracle_contract": strip_proof_authority_fields(&evidence_subject_field(candidate, "output_oracle_contract")),
        "resolved_output_oracle_contract": strip_proof_authority_fields(&evidence_subject_field(candidate, "resolved_output_oracle_contract")),
        "outputOracleProposal": strip_proof_authority_fields(&evidence_subject_field(candidate, "outputOracleProposal")),
    }))
}

fn verification_evidence_subject(candidate: &Value, category: &str) -> Option<Value> {
    match category {
        "source_mapping" => Some(json!({
            "sourceEditId": evidence_subject_field(candidate, "sourceEditId"),
            "sourcePaths": evidence_subject_field(candidate, "sourcePaths"),
            "sourceSpans": evidence_subject_field(candidate, "sourceSpans"),
            "generatedRolePath": evidence_subject_field(candidate, "generatedRolePath"),
        })),
        "include_closure" => Some(json!({
            "sourcePaths": evidence_subject_field(candidate, "sourcePaths"),
            "includeClosure": evidence_subject_field(candidate, "includeClosure"),
            "dependencyClosureHash": evidence_subject_field(candidate, "dependencyClosureHash"),
        })),
        "symbol_ownership" => Some(json!({
            "targetSymbols": evidence_subject_field(candidate, "targetSymbols"),
            "exportedSymbolsExpected": evidence_subject_field(candidate, "exportedSymbolsExpected"),
            "symbolIdentityMappings": evidence_subject_field(candidate, "symbolIdentityMappings"),
        })),
        "dependency_closure" => Some(json!({
            "sourcePaths": evidence_subject_field(candidate, "sourcePaths"),
            "includeClosure": evidence_subject_field(candidate, "includeClosure"),
            "dependencyClosureHash": evidence_subject_field(candidate, "dependencyClosureHash"),
        })),
        "abi_membrane" => Some(json!({
            "abiMembraneId": evidence_subject_field(candidate, "abiMembraneId"),
        })),
        "compile_recipe" => Some(json!({
            "compileRecipeHash": evidence_subject_field(candidate, "compileRecipeHash"),
            "compileCommandHash": evidence_subject_field(candidate, "compileCommandHash"),
        })),
        "loader_capability" => Some(json!({
            "selectedArtifactId": evidence_subject_field(candidate, "selectedArtifactId"),
            "artifactHash": evidence_subject_field(candidate, "artifactHash"),
            "loaderCapabilityRequirement": evidence_subject_field(candidate, "loaderCapabilityRequirement"),
        })),
        "output_oracle" => Some(fission_output_oracle_evidence_subject(candidate)),
        _ => None,
    }
}

fn category_source_evidence_ids(candidate: &Value, category: &str) -> BTreeSet<String> {
    REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
        .iter()
        .find(|definition| definition.name == category)
        .into_iter()
        .flat_map(|definition| definition.fields.iter())
        .flat_map(|field| evidence_id_list(candidate.get(*field)))
        .filter(|id| canonical_source_evidence_id(id))
        .collect()
}

fn declared_category_source_evidence_ids(
    candidate: &Value,
    category: &str,
) -> Result<BTreeSet<String>, ()> {
    let Some(definition) = REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
        .iter()
        .find(|definition| definition.name == category)
    else {
        return Err(());
    };
    let mut ids = BTreeSet::new();
    for field in definition.fields {
        let Some(value) = candidate.get(*field) else {
            continue;
        };
        let values = match value {
            Value::String(value) => vec![value.as_str()],
            Value::Array(values) => values
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
                .ok_or(())?,
            _ => return Err(()),
        };
        for evidence_id in values {
            if evidence_id != evidence_id.trim()
                || !canonical_source_evidence_id(evidence_id)
                || !ids.insert(evidence_id.to_string())
            {
                return Err(());
            }
        }
    }
    Ok(ids)
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        Value::Object(object) => {
            let mut canonical = serde_json::Map::new();
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(value) = object.get(key) {
                    canonical.insert(key.clone(), canonical_json_value(value));
                }
            }
            Value::Object(canonical)
        }
        _ => value.clone(),
    }
}

fn sha256_json_value(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&canonical_json_value(value)).unwrap_or_default());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub(crate) fn canonical_fission_json_hash(value: &Value) -> String {
    sha256_json_value(value)
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .to_string()
}

fn sha256_exact_json_value(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(value).unwrap_or_default());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn canonical_sha256_content_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn canonical_nonempty_string(value: &str) -> bool {
    !value.is_empty() && value == value.trim()
}

fn metadata_claims_proof_authority(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(metadata_claims_proof_authority),
        Value::Object(object) => object.iter().any(|(key, value)| {
            (proof_authority_field(key) && value.as_bool() == Some(true))
                || metadata_claims_proof_authority(value)
        }),
        _ => false,
    }
}

fn evidence_record_content_identity_valid(record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let expected_content_hash = sha256_json_value(metadata);
    let Some(expected_digest) = expected_content_hash.strip_prefix("sha256:") else {
        return false;
    };
    record.content_hash == expected_content_hash
        && record
            .evidence_id
            .rsplit_once(':')
            .is_some_and(|(_, digest)| digest == expected_digest)
}

fn evidence_id_descriptor_valid(record: &GpuHmrProofEvidenceRef, expected: &str) -> bool {
    record
        .evidence_id
        .strip_prefix("evidence:")
        .and_then(|value| value.rsplit_once(':'))
        .is_some_and(|(descriptor, _)| descriptor == expected)
}

fn current_run_upstream_record_base_valid(
    record: &GpuHmrProofEvidenceRef,
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    canonical_source_evidence_id(&record.evidence_id)
        && canonical_sha256_content_hash(&record.content_hash)
        && evidence_record_content_identity_valid(record)
        && !record.kind.trim().is_empty()
        && record.kind == record.kind.trim()
        && !record.producer_subsystem.trim().is_empty()
        && record.producer_subsystem == record.producer_subsystem.trim()
        && canonical_nonempty_string(&record.summary)
        && record.timestamp == context.timestamp
        && record.session_id.as_deref() == Some(context.session_id)
        && record
            .file_path
            .as_deref()
            .is_none_or(|value| !value.trim().is_empty() && value == value.trim())
        && record.artifact_uri.as_deref() == Some(context.selected_artifact_id)
        && upstream_run_binding_valid(record.metadata.as_ref(), context)
        && !record
            .metadata
            .as_ref()
            .is_some_and(metadata_claims_proof_authority)
}

fn evidence_schema_valid(metadata: &Value, expected: &str) -> bool {
    metadata.get("schemaVersion").and_then(Value::as_str) == Some(expected)
}

fn evidence_field_matches_candidate(
    metadata: &Value,
    metadata_field: &str,
    candidate: &Value,
    candidate_field: &str,
) -> bool {
    metadata.get(metadata_field).unwrap_or(&Value::Null)
        == candidate.get(candidate_field).unwrap_or(&Value::Null)
}

fn evidence_hash_field_matches_candidate(
    metadata: &Value,
    metadata_field: &str,
    candidate: &Value,
    candidate_field: &str,
) -> bool {
    let Some(metadata_hash) = metadata.get(metadata_field).and_then(Value::as_str) else {
        return false;
    };
    let Some(candidate_hash) = candidate.get(candidate_field).and_then(Value::as_str) else {
        return false;
    };
    canonical_sha256_digest(metadata_hash) == canonical_sha256_digest(candidate_hash)
}

fn evidence_hash_pointer_matches_candidate(
    metadata: &Value,
    metadata_pointer: &str,
    candidate: &Value,
    candidate_field: &str,
) -> bool {
    let Some(metadata_hash) = metadata.pointer(metadata_pointer).and_then(Value::as_str) else {
        return false;
    };
    let Some(candidate_hash) = candidate.get(candidate_field).and_then(Value::as_str) else {
        return false;
    };
    canonical_sha256_digest(metadata_hash) == canonical_sha256_digest(candidate_hash)
}

fn current_run_compiler_evidence_valid(
    candidate: &Value,
    compiler_evidence_id: &str,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    exactly_one_trusted_evidence_record(trusted_evidence, compiler_evidence_id).is_some_and(
        |record| {
            current_run_upstream_record_base_valid(record, context)
                && record.kind == FISSION_COMPILER_EVIDENCE_KIND
                && evidence_id_descriptor_valid(record, FISSION_COMPILER_EVIDENCE_ID_DESCRIPTOR)
                && record.metadata.as_ref().is_some_and(|metadata| {
                    evidence_schema_valid(metadata, FISSION_COMPILER_EVIDENCE_SCHEMA_VERSION)
                        && evidence_hash_pointer_matches_candidate(
                            metadata,
                            "/compileProvenance/compileCommandHash",
                            candidate,
                            "compileCommandHash",
                        )
                        && evidence_hash_pointer_matches_candidate(
                            metadata,
                            "/compileProvenance/dependencyHash",
                            candidate,
                            "dependencyClosureHash",
                        )
                })
        },
    )
}

fn source_mapping_evidence_valid(candidate: &Value, record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    record.kind == FISSION_SOURCE_MAPPING_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_SOURCE_MAPPING_EVIDENCE_KIND)
        && evidence_schema_valid(metadata, FISSION_SOURCE_MAPPING_EVIDENCE_SCHEMA_VERSION)
        && evidence_field_matches_candidate(metadata, "sourceEditId", candidate, "sourceEditId")
        && evidence_field_matches_candidate(
            metadata,
            "selectedArtifactId",
            candidate,
            "selectedArtifactId",
        )
        && evidence_field_matches_candidate(metadata, "sourcePaths", candidate, "sourcePaths")
        && evidence_field_matches_candidate(metadata, "sourceSpans", candidate, "sourceSpans")
        && evidence_field_matches_candidate(
            metadata,
            "generatedRolePath",
            candidate,
            "generatedRolePath",
        )
}

fn closure_evidence_valid(
    candidate: &Value,
    record: &GpuHmrProofEvidenceRef,
    expected_kind: &str,
    expected_schema: &str,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let Some(compiler_evidence_id) = metadata.get("compilerEvidenceId").and_then(Value::as_str)
    else {
        return false;
    };
    record.kind == expected_kind
        && evidence_id_descriptor_valid(record, expected_kind)
        && evidence_schema_valid(metadata, expected_schema)
        && evidence_field_matches_candidate(
            metadata,
            "selectedArtifactId",
            candidate,
            "selectedArtifactId",
        )
        && evidence_field_matches_candidate(metadata, "sourcePaths", candidate, "sourcePaths")
        && evidence_field_matches_candidate(metadata, "includeClosure", candidate, "includeClosure")
        && evidence_hash_field_matches_candidate(
            metadata,
            "dependencyClosureHash",
            candidate,
            "dependencyClosureHash",
        )
        && current_run_compiler_evidence_valid(
            candidate,
            compiler_evidence_id,
            trusted_evidence,
            context,
        )
}

fn symbol_identity_mappings_bound_to_record(
    candidate: &Value,
    record: &GpuHmrProofEvidenceRef,
) -> bool {
    let targets = string_set(candidate.get("targetSymbols"));
    let exports = string_set(candidate.get("exportedSymbolsExpected"));
    let mappings = candidate
        .get("symbolIdentityMappings")
        .or_else(|| candidate.get("symbolIdentityMap"));
    match mappings {
        None => true,
        Some(Value::Array(mappings)) => mappings.iter().all(|mapping| {
            let Some(mapping) = mapping.as_object() else {
                return false;
            };
            let Some(target) = first_mapping_string(
                mapping,
                &["targetSymbol", "sourceSymbol", "logicalSymbol", "symbol"],
            ) else {
                return false;
            };
            let Some(exported) = first_mapping_string(
                mapping,
                &[
                    "exportedSymbol",
                    "runtimeSymbol",
                    "artifactSymbol",
                    "mangledSymbol",
                ],
            ) else {
                return false;
            };
            let evidence_ids = first_mapping_evidence_ids(
                mapping,
                &[
                    "evidenceIds",
                    "verifierEvidenceIds",
                    "symbolOwnershipEvidenceIds",
                    "identityEvidenceIds",
                ],
            );
            targets.contains(&target)
                && exports.contains(&exported)
                && evidence_ids.iter().any(|id| id == &record.evidence_id)
        }),
        Some(_) => false,
    }
}

fn symbol_ownership_evidence_valid(candidate: &Value, record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    record.kind == FISSION_SYMBOL_OWNERSHIP_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_SYMBOL_OWNERSHIP_EVIDENCE_ID_DESCRIPTOR)
        && evidence_schema_valid(metadata, FISSION_SYMBOL_OWNERSHIP_EVIDENCE_SCHEMA_VERSION)
        && evidence_field_matches_candidate(metadata, "targetSymbols", candidate, "targetSymbols")
        && evidence_field_matches_candidate(
            metadata,
            "artifactExportedSymbols",
            candidate,
            "exportedSymbolsExpected",
        )
        && metadata.get("symbolBound").and_then(Value::as_bool) == Some(true)
        && symbol_identity_mappings_bound_to_record(candidate, record)
        && string_list(candidate.get("safeExportSupersetEvidenceIds"))
            .into_iter()
            .all(|id| id == record.evidence_id)
}

fn abi_membrane_evidence_valid(candidate: &Value, record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let expected_membrane_id = format!("abi-membrane:{}", record.evidence_id);
    record.kind == FISSION_ABI_MEMBRANE_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_ABI_MEMBRANE_EVIDENCE_KIND)
        && evidence_schema_valid(metadata, FISSION_ABI_MEMBRANE_EVIDENCE_SCHEMA_VERSION)
        && evidence_field_matches_candidate(metadata, "targetSymbols", candidate, "targetSymbols")
        && evidence_field_matches_candidate(
            metadata,
            "artifactExportedSymbols",
            candidate,
            "exportedSymbolsExpected",
        )
        && candidate.get("abiMembraneId").and_then(Value::as_str)
            == Some(expected_membrane_id.as_str())
        && metadata
            .get("layoutSizeAlignmentVerified")
            .and_then(Value::as_bool)
            == Some(true)
        && non_empty_array(metadata.get("acceptedExtractorEvidenceRefs"))
        && non_empty_array(metadata.get("acceptedExtractorSources"))
        && non_empty_array(metadata.get("extractorProvenance"))
        && [
            "kernelSignatures",
            "clangAstKernelSignatures",
            "parameterAbiRecords",
        ]
        .iter()
        .any(|field| non_empty_array(metadata.get(*field)))
        && metadata
            .get("kernelAbiFingerprintHash")
            .and_then(Value::as_str)
            .and_then(canonical_sha256_digest)
            .is_some()
        && metadata
            .get("constantGlobalLayoutHash")
            .and_then(Value::as_str)
            .and_then(canonical_sha256_digest)
            .is_some()
}

fn compile_recipe_evidence_valid(
    candidate: &Value,
    record: &GpuHmrProofEvidenceRef,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let Some(compiler_evidence_id) = metadata.get("compilerEvidenceId").and_then(Value::as_str)
    else {
        return false;
    };
    record.kind == FISSION_COMPILE_RECIPE_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_COMPILE_RECIPE_EVIDENCE_KIND)
        && evidence_schema_valid(metadata, FISSION_COMPILE_RECIPE_EVIDENCE_SCHEMA_VERSION)
        && evidence_field_matches_candidate(
            metadata,
            "selectedArtifactId",
            candidate,
            "selectedArtifactId",
        )
        && evidence_hash_field_matches_candidate(
            metadata,
            "compileRecipeHash",
            candidate,
            "compileRecipeHash",
        )
        && evidence_hash_field_matches_candidate(
            metadata,
            "compileCommandHash",
            candidate,
            "compileCommandHash",
        )
        && evidence_hash_field_matches_candidate(
            metadata,
            "dependencyClosureHash",
            candidate,
            "dependencyClosureHash",
        )
        && current_run_compiler_evidence_valid(
            candidate,
            compiler_evidence_id,
            trusted_evidence,
            context,
        )
}

fn loader_capability_evidence_valid(candidate: &Value, record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let required_tokens = loader_capability_tokens(candidate.get("loaderCapabilityRequirement"))
        .into_iter()
        .collect::<BTreeSet<_>>();
    let observed_tokens = loader_capability_tokens(Some(metadata))
        .into_iter()
        .collect::<BTreeSet<_>>();
    record.kind == FISSION_LOADER_CAPABILITY_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_LOADER_CAPABILITY_EVIDENCE_KIND)
        && evidence_schema_valid(metadata, FISSION_LOADER_CAPABILITY_EVIDENCE_SCHEMA_VERSION)
        && evidence_field_matches_candidate(
            metadata,
            "selectedArtifactId",
            candidate,
            "selectedArtifactId",
        )
        && evidence_hash_field_matches_candidate(
            metadata,
            "artifactContentHash",
            candidate,
            "artifactHash",
        )
        && !required_tokens.is_empty()
        && required_tokens.is_subset(&observed_tokens)
}

fn output_oracle_evidence_valid(candidate: &Value, record: &GpuHmrProofEvidenceRef) -> bool {
    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let Some(expected_subject) = verification_evidence_subject(candidate, "output_oracle") else {
        return false;
    };
    let contract_evidence = record.kind == FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_KIND)
        && evidence_schema_valid(
            metadata,
            FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_SCHEMA_VERSION,
        )
        && metadata
            .get("contractMaterialized")
            .and_then(Value::as_bool)
            == Some(true)
        && metadata.get("proposalOnly").and_then(Value::as_bool) == Some(false);
    let observation_evidence = record.kind == FISSION_OUTPUT_ORACLE_OBSERVATION_EVIDENCE_KIND
        && evidence_id_descriptor_valid(record, FISSION_OUTPUT_ORACLE_OBSERVATION_EVIDENCE_KIND)
        && evidence_schema_valid(
            metadata,
            FISSION_OUTPUT_ORACLE_OBSERVATION_EVIDENCE_SCHEMA_VERSION,
        )
        && metadata.get("observationAccepted").and_then(Value::as_bool) == Some(true)
        && metadata
            .get("dispatchId")
            .and_then(Value::as_str)
            .is_some_and(canonical_nonempty_string);
    (contract_evidence || observation_evidence)
        && evidence_field_matches_candidate(metadata, "sourceEditId", candidate, "sourceEditId")
        && evidence_field_matches_candidate(
            metadata,
            "selectedArtifactId",
            candidate,
            "selectedArtifactId",
        )
        && metadata.get("oracleSubject") == Some(&canonical_json_value(&expected_subject))
}

fn current_run_upstream_record_valid_for_category(
    candidate: &Value,
    category: &str,
    record: &GpuHmrProofEvidenceRef,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    if !current_run_upstream_record_base_valid(record, context) {
        return false;
    }
    match category {
        "source_mapping" => source_mapping_evidence_valid(candidate, record),
        "include_closure" => closure_evidence_valid(
            candidate,
            record,
            FISSION_INCLUDE_CLOSURE_EVIDENCE_KIND,
            FISSION_INCLUDE_CLOSURE_EVIDENCE_SCHEMA_VERSION,
            trusted_evidence,
            context,
        ),
        "symbol_ownership" => symbol_ownership_evidence_valid(candidate, record),
        "dependency_closure" => closure_evidence_valid(
            candidate,
            record,
            FISSION_DEPENDENCY_CLOSURE_EVIDENCE_KIND,
            FISSION_DEPENDENCY_CLOSURE_EVIDENCE_SCHEMA_VERSION,
            trusted_evidence,
            context,
        ),
        "abi_membrane" => abi_membrane_evidence_valid(candidate, record),
        "compile_recipe" => {
            compile_recipe_evidence_valid(candidate, record, trusted_evidence, context)
        }
        "loader_capability" => loader_capability_evidence_valid(candidate, record),
        "output_oracle" => output_oracle_evidence_valid(candidate, record),
        _ => false,
    }
}

fn upstream_run_binding_valid(
    metadata: Option<&Value>,
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    metadata.and_then(|metadata| metadata.get("runBinding"))
        == Some(&json!({
            "schemaVersion": FISSION_RUN_BINDING_SCHEMA_VERSION,
            "timestamp": context.timestamp,
            "sessionId": context.session_id,
            "sourceEditId": context.source_edit_id,
            "selectedArtifactId": context.selected_artifact_id,
        }))
}

fn current_run_upstream_evidence_bindings(
    candidate: &Value,
    category: &str,
    upstream_evidence_ids: &[String],
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> Option<Vec<Value>> {
    let mut bindings = Vec::with_capacity(upstream_evidence_ids.len());
    for evidence_id in upstream_evidence_ids {
        let record = exactly_one_trusted_evidence_record(trusted_evidence, evidence_id)?;
        if !current_run_upstream_record_valid_for_category(
            candidate,
            category,
            record,
            trusted_evidence,
            context,
        ) {
            return None;
        }
        let projection = trusted_source_record_projection(record);
        bindings.push(json!({
            "evidenceId": evidence_id,
            "recordHash": sha256_exact_json_value(&projection),
            "recordProjection": projection,
        }));
    }
    Some(bindings)
}

fn phase_source_evidence_metadata(
    candidate: &Value,
    category: &str,
    upstream_evidence_ids: &[String],
    upstream_evidence_bindings: &[Value],
    context: FissionEvidenceProducerContext<'_>,
) -> Option<Value> {
    let subject = canonical_json_value(&verification_evidence_subject(candidate, category)?);
    Some(json!({
        "schemaVersion": FISSION_PHASE_SOURCE_EVIDENCE_SCHEMA_VERSION,
        "category": category,
        "subject": subject,
        "upstreamEvidenceIds": upstream_evidence_ids,
        "upstreamEvidenceBindings": upstream_evidence_bindings,
        "runContext": {
            "producerSubsystem": context.producer_subsystem,
            "timestamp": context.timestamp,
            "sessionId": context.session_id,
            "sourceEditId": context.source_edit_id,
            "selectedArtifactId": context.selected_artifact_id,
            "filePath": context.file_path,
        },
        "authority": FISSION_PHASE_SOURCE_EVIDENCE_AUTHORITY,
        "supportOnly": true,
        "acceptedForGpuHmr": false,
        "gpuHmrSuccess": false,
        "canSatisfyGpuHmr": false,
        "canSatisfyRuntimeProof": false,
        "canSatisfyDispatchProof": false,
        "gpuHmrAuthority": false,
        "runtimeAuthority": false,
        "dispatchAuthority": false,
    }))
}

fn phase_source_evidence_summary(category: &str) -> String {
    format!("support-only fission phase-source evidence for {category}")
}

fn phase_source_evidence_record(
    candidate: &Value,
    category: &str,
    upstream_evidence_ids: Vec<String>,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> Option<GpuHmrProofEvidenceRef> {
    let upstream_evidence_bindings = current_run_upstream_evidence_bindings(
        candidate,
        category,
        &upstream_evidence_ids,
        trusted_evidence,
        context,
    )?;
    let metadata = phase_source_evidence_metadata(
        candidate,
        category,
        &upstream_evidence_ids,
        &upstream_evidence_bindings,
        context,
    )?;
    let content_hash = sha256_exact_json_value(&metadata);
    let digest = content_hash.strip_prefix("sha256:")?;
    Some(GpuHmrProofEvidenceRef {
        evidence_id: format!("evidence:fission-phase-source:{category}:{digest}"),
        kind: FISSION_PHASE_SOURCE_EVIDENCE_KIND.to_string(),
        content_hash,
        producer_subsystem: context.producer_subsystem.trim().to_string(),
        timestamp: context.timestamp.trim().to_string(),
        session_id: Some(context.session_id.trim().to_string()),
        file_path: context.file_path.map(|value| value.trim().to_string()),
        artifact_uri: Some(context.selected_artifact_id.trim().to_string()),
        summary: phase_source_evidence_summary(category),
        metadata: Some(metadata),
    })
}

fn phase_source_upstream_evidence_ids(metadata: &Value) -> Option<Vec<String>> {
    let ids = metadata
        .get("upstreamEvidenceIds")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    if ids.is_empty()
        || ids
            .iter()
            .any(|id| id != id.trim() || !canonical_source_evidence_id(id))
    {
        return None;
    }
    let canonical = ids.iter().cloned().collect::<BTreeSet<_>>();
    (canonical.len() == ids.len() && canonical.into_iter().eq(ids.iter().cloned())).then_some(ids)
}

fn phase_source_evidence_record_valid_for_candidate(
    candidate: &Value,
    category: &str,
    record: &GpuHmrProofEvidenceRef,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> bool {
    if record.kind != FISSION_PHASE_SOURCE_EVIDENCE_KIND
        || record.producer_subsystem != context.producer_subsystem
        || record.timestamp != context.timestamp
        || record.session_id.as_deref() != Some(context.session_id)
        || record.file_path.as_deref() != context.file_path
        || record.artifact_uri.as_deref() != Some(context.selected_artifact_id)
        || candidate.get("sourceEditId").and_then(Value::as_str) != Some(context.source_edit_id)
        || candidate.get("selectedArtifactId").and_then(Value::as_str)
            != Some(context.selected_artifact_id)
        || record.summary != phase_source_evidence_summary(category)
    {
        return false;
    }

    let Some(metadata) = record.metadata.as_ref() else {
        return false;
    };
    let Some(upstream_evidence_ids) = phase_source_upstream_evidence_ids(metadata) else {
        return false;
    };
    let Some(upstream_evidence_bindings) = current_run_upstream_evidence_bindings(
        candidate,
        category,
        &upstream_evidence_ids,
        trusted_evidence,
        context,
    ) else {
        return false;
    };
    let Some(expected_metadata) = phase_source_evidence_metadata(
        candidate,
        category,
        &upstream_evidence_ids,
        &upstream_evidence_bindings,
        context,
    ) else {
        return false;
    };
    if metadata != &expected_metadata {
        return false;
    }

    let expected_content_hash = sha256_exact_json_value(metadata);
    if record.content_hash != expected_content_hash {
        return false;
    }
    let Some(digest) = expected_content_hash.strip_prefix("sha256:") else {
        return false;
    };
    record.evidence_id == format!("evidence:fission-phase-source:{category}:{digest}")
}

fn trusted_source_record_projection(record: &GpuHmrProofEvidenceRef) -> Value {
    canonical_json_value(&json!({
        "evidenceId": record.evidence_id,
        "kind": record.kind,
        "contentHash": record.content_hash,
        "producerSubsystem": record.producer_subsystem,
        "timestamp": record.timestamp,
        "sessionId": record.session_id,
        "filePath": record.file_path,
        "artifactUri": record.artifact_uri,
        "summary": record.summary,
        "metadata": record.metadata,
    }))
}

fn content_bound_fission_evidence_record(
    candidate: &Value,
    category: &str,
    source_record: &GpuHmrProofEvidenceRef,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: FissionEvidenceProducerContext<'_>,
) -> Option<Value> {
    if !canonical_source_evidence_id(&source_record.evidence_id)
        || !category_source_evidence_ids(candidate, category).contains(&source_record.evidence_id)
        || !phase_source_evidence_record_valid_for_candidate(
            candidate,
            category,
            source_record,
            trusted_evidence,
            context,
        )
    {
        return None;
    }
    let subject = canonical_json_value(&verification_evidence_subject(candidate, category)?);
    let subject_hash = sha256_json_value(&subject);
    let source_record_projection = trusted_source_record_projection(source_record);
    let source_record_hash = sha256_exact_json_value(&source_record_projection);
    let binding_hash = sha256_json_value(&json!({
        "subject": subject,
        "trustedSourceRecordProjection": source_record_projection,
    }));
    let identity_material = json!({
        "schemaVersion": FISSION_VERIFIER_EVIDENCE_SCHEMA_VERSION,
        "authority": FISSION_VERIFIER_EVIDENCE_AUTHORITY,
        "category": category,
        "sourceEvidenceId": source_record.evidence_id,
        "subjectHash": subject_hash,
        "bindingHash": binding_hash,
        "subject": subject,
        "trustedSourceRecordHash": source_record_hash,
        "trustedSourceRecordProjection": source_record_projection,
        "supportOnly": true,
        "acceptedForGpuHmr": false,
        "gpuHmrSuccess": false,
        "canSatisfyGpuHmr": false,
        "canSatisfyRuntimeProof": false,
        "canSatisfyDispatchProof": false,
    });
    let evidence_hash = sha256_json_value(&identity_material)
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .to_string();
    Some(json!({
        "schemaVersion": FISSION_VERIFIER_EVIDENCE_SCHEMA_VERSION,
        "evidenceId": format!("fission-evidence:{category}:sha256:{evidence_hash}"),
        "authority": FISSION_VERIFIER_EVIDENCE_AUTHORITY,
        "category": category,
        "sourceEvidenceId": source_record.evidence_id,
        "subjectHash": subject_hash,
        "bindingHash": binding_hash,
        "subject": subject,
        "trustedSourceRecordHash": source_record_hash,
        "trustedSourceRecordProjection": source_record_projection,
        "supportOnly": true,
        "acceptedForGpuHmr": false,
        "gpuHmrSuccess": false,
        "canSatisfyGpuHmr": false,
        "canSatisfyRuntimeProof": false,
        "canSatisfyDispatchProof": false,
    }))
}

fn exactly_one_trusted_evidence_record<'a>(
    trusted_evidence: &'a [GpuHmrProofEvidenceRef],
    evidence_id: &str,
) -> Option<&'a GpuHmrProofEvidenceRef> {
    let mut matches = trusted_evidence
        .iter()
        .filter(|record| record.evidence_id == evidence_id);
    let record = matches.next()?;
    matches.next().is_none().then_some(record)
}

fn candidate_with_validated_evidence(
    candidate: &Value,
    trusted_evidence: &[GpuHmrProofEvidenceRef],
    context: Option<FissionEvidenceProducerContext<'_>>,
) -> Value {
    let declared_records = candidate
        .get("verifierEvidenceRecords")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut evidence_id_counts = BTreeMap::new();
    let mut binding_counts = BTreeMap::new();
    for record in &declared_records {
        if let Some(evidence_id) = record.get("evidenceId").and_then(Value::as_str) {
            *evidence_id_counts
                .entry(evidence_id.to_string())
                .or_insert(0usize) += 1;
        }
        if let (Some(category), Some(source_evidence_id)) = (
            record.get("category").and_then(Value::as_str),
            record.get("sourceEvidenceId").and_then(Value::as_str),
        ) {
            *binding_counts
                .entry((category.to_string(), source_evidence_id.to_string()))
                .or_insert(0usize) += 1;
        }
    }

    let mut valid_records = Vec::new();
    if let Some(context) = context {
        for record in &declared_records {
            let Some(evidence_id) = record.get("evidenceId").and_then(Value::as_str) else {
                continue;
            };
            let Some(category) = record.get("category").and_then(Value::as_str) else {
                continue;
            };
            let Some(source_evidence_id) = record.get("sourceEvidenceId").and_then(Value::as_str)
            else {
                continue;
            };
            if evidence_id_counts.get(evidence_id) != Some(&1)
                || binding_counts.get(&(category.to_string(), source_evidence_id.to_string()))
                    != Some(&1)
            {
                continue;
            }
            let Some(source_record) =
                exactly_one_trusted_evidence_record(trusted_evidence, source_evidence_id)
            else {
                continue;
            };
            let Some(expected) = content_bound_fission_evidence_record(
                candidate,
                category,
                source_record,
                trusted_evidence,
                context,
            ) else {
                continue;
            };
            if record == &expected {
                valid_records.push(expected);
            }
        }
    }
    let invalid_count = declared_records.len().saturating_sub(valid_records.len());

    let mut prepared = candidate.clone();
    if let Some(object) = prepared.as_object_mut() {
        object.insert(
            INTERNAL_VALIDATED_EVIDENCE_RECORDS_FIELD.to_string(),
            Value::Array(valid_records),
        );
        object.insert(
            INTERNAL_INVALID_EVIDENCE_RECORD_COUNT_FIELD.to_string(),
            json!(invalid_count),
        );
    }
    prepared
}

fn valid_content_bound_fission_evidence_records(candidate: &Value) -> Vec<Value> {
    candidate
        .get(INTERNAL_VALIDATED_EVIDENCE_RECORDS_FIELD)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn invalid_content_bound_fission_evidence_record_count(candidate: &Value) -> usize {
    candidate
        .get(INTERNAL_INVALID_EVIDENCE_RECORD_COUNT_FIELD)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

fn content_bound_evidence_ids_for_category(candidate: &Value, category: &str) -> Vec<String> {
    valid_content_bound_fission_evidence_records(candidate)
        .into_iter()
        .filter(|record| record.get("category").and_then(Value::as_str) == Some(category))
        .filter_map(|record| {
            record
                .get("evidenceId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn missing_verification_evidence_categories(candidate: &Value) -> Vec<&'static str> {
    REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
        .iter()
        .filter_map(|category| {
            if content_bound_evidence_ids_for_category(candidate, category.name).is_empty() {
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
        let evidence_ids = content_bound_evidence_ids_for_category(candidate, category.name);
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
    valid_content_bound_fission_evidence_records(candidate)
        .into_iter()
        .filter_map(|record| {
            record
                .get("evidenceId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn non_authoritative_evidence_ids(candidate: &Value) -> Vec<String> {
    let accepted = deterministic_verifier_evidence_ids(candidate)
        .into_iter()
        .collect::<BTreeSet<_>>();
    string_list(candidate.get("verifierEvidenceIds"))
        .into_iter()
        .filter(|id| !accepted.contains(id))
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

    const TEST_TRUSTED_EVIDENCE_FIELD: &str = "__testTrustedFissionEvidence";

    fn test_producer_context() -> FissionEvidenceProducerContext<'static> {
        FissionEvidenceProducerContext {
            producer_subsystem: "worker.gpu_fission_test_producer",
            timestamp: "2026-07-16T12:00:00Z",
            session_id: "session:gpu-fission-test",
            source_edit_id: "edit:1",
            selected_artifact_id:
                "artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            file_path: None,
        }
    }

    fn test_run_binding() -> Value {
        json!({
            "schemaVersion": FISSION_RUN_BINDING_SCHEMA_VERSION,
            "timestamp": test_producer_context().timestamp,
            "sessionId": test_producer_context().session_id,
            "sourceEditId": test_producer_context().source_edit_id,
            "selectedArtifactId": test_producer_context().selected_artifact_id,
        })
    }

    fn test_bound_upstream_record(
        descriptor: &str,
        kind: &str,
        mut metadata: Value,
    ) -> GpuHmrProofEvidenceRef {
        metadata
            .as_object_mut()
            .expect("test upstream metadata must be an object")
            .insert("runBinding".to_string(), test_run_binding());
        let content_hash = sha256_json_value(&metadata);
        let digest = content_hash.strip_prefix("sha256:").unwrap();
        GpuHmrProofEvidenceRef {
            evidence_id: format!("evidence:{descriptor}:{digest}"),
            kind: kind.to_string(),
            content_hash,
            producer_subsystem: "worker.gpu_fission_test_upstream".to_string(),
            timestamp: test_producer_context().timestamp.to_string(),
            session_id: Some(test_producer_context().session_id.to_string()),
            file_path: None,
            artifact_uri: Some(test_producer_context().selected_artifact_id.to_string()),
            summary: format!("typed current-run {kind} observation"),
            metadata: Some(metadata),
        }
    }

    fn test_category_upstream_evidence(candidate: &mut Value) -> Vec<GpuHmrProofEvidenceRef> {
        let compiler_record = test_bound_upstream_record(
            FISSION_COMPILER_EVIDENCE_ID_DESCRIPTOR,
            FISSION_COMPILER_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_COMPILER_EVIDENCE_SCHEMA_VERSION,
                "compileProvenance": {
                    "compileCommandHash": candidate.get("compileCommandHash"),
                    "dependencyHash": candidate.get("dependencyClosureHash"),
                },
                "stderrBytes": 0,
                "stderrHash": format!("sha256:{}", hex::encode(Sha256::digest(b""))),
            }),
        );
        let compiler_evidence_id = compiler_record.evidence_id.clone();

        let source_mapping = test_bound_upstream_record(
            FISSION_SOURCE_MAPPING_EVIDENCE_KIND,
            FISSION_SOURCE_MAPPING_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_SOURCE_MAPPING_EVIDENCE_SCHEMA_VERSION,
                "sourceEditId": candidate.get("sourceEditId"),
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "sourcePaths": candidate.get("sourcePaths"),
                "sourceSpans": candidate.get("sourceSpans"),
                "generatedRolePath": candidate.get("generatedRolePath"),
            }),
        );
        let include_closure = test_bound_upstream_record(
            FISSION_INCLUDE_CLOSURE_EVIDENCE_KIND,
            FISSION_INCLUDE_CLOSURE_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_INCLUDE_CLOSURE_EVIDENCE_SCHEMA_VERSION,
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "sourcePaths": candidate.get("sourcePaths"),
                "includeClosure": candidate.get("includeClosure"),
                "dependencyClosureHash": candidate.get("dependencyClosureHash"),
                "compilerEvidenceId": &compiler_evidence_id,
            }),
        );
        let symbol_ownership = test_bound_upstream_record(
            FISSION_SYMBOL_OWNERSHIP_EVIDENCE_ID_DESCRIPTOR,
            FISSION_SYMBOL_OWNERSHIP_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_SYMBOL_OWNERSHIP_EVIDENCE_SCHEMA_VERSION,
                "targetSymbols": candidate.get("targetSymbols"),
                "artifactExportedSymbols": candidate.get("exportedSymbolsExpected"),
                "symbolBound": true,
            }),
        );
        for field in ["symbolIdentityMappings", "symbolIdentityMap"] {
            if let Some(mappings) = candidate.get_mut(field).and_then(Value::as_array_mut) {
                for mapping in mappings.iter_mut().filter_map(Value::as_object_mut) {
                    mapping.insert(
                        "evidenceIds".to_string(),
                        json!([symbol_ownership.evidence_id.clone()]),
                    );
                }
                break;
            }
        }
        if candidate.get("safeExportSupersetReason").is_some() {
            candidate["safeExportSupersetEvidenceIds"] =
                json!([symbol_ownership.evidence_id.clone()]);
        } else if let Some(object) = candidate.as_object_mut() {
            object.remove("safeExportSupersetEvidenceIds");
        }
        let dependency_closure = test_bound_upstream_record(
            FISSION_DEPENDENCY_CLOSURE_EVIDENCE_KIND,
            FISSION_DEPENDENCY_CLOSURE_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_DEPENDENCY_CLOSURE_EVIDENCE_SCHEMA_VERSION,
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "sourcePaths": candidate.get("sourcePaths"),
                "includeClosure": candidate.get("includeClosure"),
                "dependencyClosureHash": candidate.get("dependencyClosureHash"),
                "compilerEvidenceId": &compiler_evidence_id,
            }),
        );
        let abi_membrane = test_bound_upstream_record(
            FISSION_ABI_MEMBRANE_EVIDENCE_KIND,
            FISSION_ABI_MEMBRANE_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_ABI_MEMBRANE_EVIDENCE_SCHEMA_VERSION,
                "targetSymbols": candidate.get("targetSymbols"),
                "artifactExportedSymbols": candidate.get("exportedSymbolsExpected"),
                "kernelSignatures": [{"name": "step", "parameters": []}],
                "kernelAbiFingerprintHash": format!("sha256:{}", "4".repeat(64)),
                "constantGlobalLayoutHash": format!("sha256:{}", "5".repeat(64)),
                "layoutSizeAlignmentVerified": true,
                "acceptedExtractorEvidenceRefs": ["evidence:test-abi-extractor"],
                "acceptedExtractorSources": ["test_structured_abi_extractor"],
                "extractorProvenance": [{
                    "extractorKind": "structured_test_extractor",
                    "acceptedByRuntimeCorrectnessPlan": true
                }],
            }),
        );
        candidate["abiMembraneId"] = json!(format!("abi-membrane:{}", abi_membrane.evidence_id));
        let compile_recipe = test_bound_upstream_record(
            FISSION_COMPILE_RECIPE_EVIDENCE_KIND,
            FISSION_COMPILE_RECIPE_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_COMPILE_RECIPE_EVIDENCE_SCHEMA_VERSION,
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "compileRecipeHash": candidate.get("compileRecipeHash"),
                "compileCommandHash": candidate.get("compileCommandHash"),
                "dependencyClosureHash": candidate.get("dependencyClosureHash"),
                "compilerEvidenceId": &compiler_evidence_id,
            }),
        );
        let required_loader_tokens =
            loader_capability_tokens(candidate.get("loaderCapabilityRequirement"));
        let loader_capability = test_bound_upstream_record(
            FISSION_LOADER_CAPABILITY_EVIDENCE_KIND,
            FISSION_LOADER_CAPABILITY_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_LOADER_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "artifactContentHash": candidate.get("artifactHash"),
                "acceptedTransports": required_loader_tokens,
            }),
        );
        let output_oracle = test_bound_upstream_record(
            FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_KIND,
            FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_KIND,
            json!({
                "schemaVersion": FISSION_OUTPUT_ORACLE_CONTRACT_EVIDENCE_SCHEMA_VERSION,
                "sourceEditId": candidate.get("sourceEditId"),
                "selectedArtifactId": candidate.get("selectedArtifactId"),
                "oracleSubject": verification_evidence_subject(candidate, "output_oracle"),
                "contractMaterialized": true,
                "proposalOnly": false,
            }),
        );

        let category_records = [
            ("source_mapping", source_mapping),
            ("include_closure", include_closure),
            ("symbol_ownership", symbol_ownership),
            ("dependency_closure", dependency_closure),
            ("abi_membrane", abi_membrane),
            ("compile_recipe", compile_recipe),
            ("loader_capability", loader_capability),
            ("output_oracle", output_oracle),
        ];
        let object = candidate.as_object_mut().unwrap();
        for (category_name, record) in &category_records {
            let category = REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES
                .iter()
                .find(|category| category.name == *category_name)
                .unwrap();
            for field in category.fields {
                object.remove(*field);
            }
            object.insert(category.fields[0].to_string(), json!([record.evidence_id]));
        }
        object.insert(
            "verifierEvidenceIds".to_string(),
            json!(category_records
                .iter()
                .map(|(_, record)| record.evidence_id.clone())
                .collect::<Vec<_>>()),
        );

        std::iter::once(compiler_record)
            .chain(category_records.into_iter().map(|(_, record)| record))
            .collect()
    }

    fn refresh_content_bound_evidence(candidate: &mut Value) {
        let _ = candidate
            .as_object_mut()
            .expect("test fission candidate must be an object")
            .remove(TEST_TRUSTED_EVIDENCE_FIELD)
            .unwrap_or(Value::Null);
        let mut upstream_evidence = test_category_upstream_evidence(candidate);
        for category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
            let ids = category_source_evidence_ids(candidate, category.name)
                .into_iter()
                .collect::<Vec<_>>();
            assert!(
                current_run_upstream_evidence_bindings(
                    candidate,
                    category.name,
                    &ids,
                    &upstream_evidence,
                    test_producer_context(),
                )
                .is_some(),
                "typed test upstream record invalid for {}",
                category.name,
            );
        }
        let trusted_phase_evidence = produce_fission_phase_source_evidence(
            candidate,
            &upstream_evidence,
            test_producer_context(),
        )
        .expect("trusted test producer must materialize evidence");
        assert_eq!(
            trusted_phase_evidence.len(),
            REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES.len()
        );
        upstream_evidence.extend(trusted_phase_evidence);
        candidate.as_object_mut().unwrap().insert(
            TEST_TRUSTED_EVIDENCE_FIELD.to_string(),
            serde_json::to_value(upstream_evidence).unwrap(),
        );
    }

    fn test_input_and_trusted_evidence(value: &Value) -> (Value, Vec<GpuHmrProofEvidenceRef>) {
        fn extract(value: &mut Value, trusted_evidence: &mut Vec<GpuHmrProofEvidenceRef>) {
            match value {
                Value::Array(items) => {
                    for item in items {
                        extract(item, trusted_evidence);
                    }
                }
                Value::Object(object) => {
                    if let Some(records) = object.remove(TEST_TRUSTED_EVIDENCE_FIELD) {
                        trusted_evidence.extend(
                            serde_json::from_value::<Vec<GpuHmrProofEvidenceRef>>(records)
                                .expect("test trusted evidence must deserialize"),
                        );
                    }
                }
                _ => {}
            }
        }

        let mut input = value.clone();
        let mut trusted_evidence = Vec::new();
        extract(&mut input, &mut trusted_evidence);
        let trusted_evidence = trusted_evidence
            .into_iter()
            .map(|record| (record.evidence_id.clone(), record))
            .collect::<BTreeMap<_, _>>()
            .into_values()
            .collect();
        (input, trusted_evidence)
    }

    fn verify_fission_candidates(value: &Value) -> Value {
        let (input, trusted_evidence) = test_input_and_trusted_evidence(value);
        super::verify_fission_candidates_with_evidence(
            &input,
            &trusted_evidence,
            test_producer_context(),
        )
    }

    fn verify_with_test_evidence(
        candidate: &Value,
        trusted_evidence: &[GpuHmrProofEvidenceRef],
    ) -> Value {
        super::verify_fission_candidates_with_evidence(
            candidate,
            trusted_evidence,
            test_producer_context(),
        )
    }

    fn verify_fission_candidate(candidate: &Value) -> Value {
        verify_fission_candidates(candidate)
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|reports| reports.first())
            .cloned()
            .expect("test candidate verification must produce one report")
    }

    fn restore_category_upstream_evidence_ids(
        candidate: &mut Value,
        trusted_evidence: &[GpuHmrProofEvidenceRef],
    ) {
        for category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
            let upstream_ids = category_source_evidence_ids(candidate, category.name)
                .iter()
                .filter_map(|phase_id| {
                    trusted_evidence
                        .iter()
                        .find(|record| record.evidence_id == *phase_id)
                        .and_then(|record| record.metadata.as_ref())
                        .and_then(phase_source_upstream_evidence_ids)
                })
                .flatten()
                .collect::<BTreeSet<_>>();
            let object = candidate.as_object_mut().unwrap();
            for field in category.fields {
                object.remove(*field);
            }
            object.insert(
                category.fields[0].to_string(),
                json!(upstream_ids.into_iter().collect::<Vec<_>>()),
            );
        }
    }

    fn valid_candidate() -> Value {
        let artifact_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let source_evidence_id = format!("evidence:test-observation:{}", "b".repeat(64));
        let mut candidate = json!({
            "islandId": "island:sha256:1",
            "sourceEditId": "edit:1",
            "selectedArtifactId": format!("artifact:sha256:{artifact_digest}"),
            "artifactHash": format!("sha256:{artifact_digest}"),
            "sourcePaths": ["src/device.kernel"],
            "sourceSpans": [{"path": "src/device.kernel", "startLine": 10, "endLine": 12}],
            "generatedRolePath": ".synthi/generated/gpu/device.kernel",
            "generatedTopologyBinding": {
                "schemaVersion": "synthi.gpu.generated_topology_binding.v1",
                "source": "generated_manifest_device_role_topology",
                "generatedRolePath": ".synthi/generated/gpu/device.kernel",
                "selectedArtifactId": format!("artifact:sha256:{artifact_digest}"),
                "selectedArtifactHash": format!("sha256:{artifact_digest}"),
                "artifactKind": "device_partial",
                "replacementScope": "device_partial",
                "materializedPartialArtifact": true,
                "separatelyMaterializedPartialArtifact": true,
                "contentAddressedPartialArtifact": true,
                "sourcePaths": ["src/device.kernel"],
                "targetSymbols": ["step"]
            },
            "generatedTopologyEvidenceIds": [source_evidence_id.clone()],
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
            "sourceMappingEvidenceIds": [source_evidence_id.clone()],
            "includeClosureEvidenceIds": [source_evidence_id.clone()],
            "symbolOwnershipEvidenceIds": [source_evidence_id.clone()],
            "dependencyClosureEvidenceIds": [source_evidence_id.clone()],
            "abiMembraneEvidenceIds": [source_evidence_id.clone()],
            "compileRecipeEvidenceIds": [source_evidence_id.clone()],
            "loaderCapabilityEvidenceIds": [source_evidence_id.clone()],
            "outputOracleEvidenceIds": [source_evidence_id.clone()],
            "verifierEvidenceIds": [source_evidence_id.clone()],
            "narrowerCandidateRejections": [
                {
                    "scopeRank": 0,
                    "reasonCode": "fission.edit_crosses_body_boundary",
                    "verifierEvidenceIds": [source_evidence_id]
                }
            ],
        });
        refresh_content_bound_evidence(&mut candidate);
        candidate
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
    fn public_aggregate_rejects_externally_supplied_self_consistent_evidence() {
        let (candidate, _) = test_input_and_trusted_evidence(&valid_candidate());

        let report = super::verify_fission_candidates(&json!([candidate]));

        assert_eq!(report["status"], "reject");
        assert_eq!(report["acceptedCount"], 0);
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!([
                "source_mapping",
                "include_closure",
                "symbol_ownership",
                "dependency_closure",
                "abi_membrane",
                "compile_recipe",
                "loader_capability",
                "output_oracle"
            ])
        );
        assert_eq!(
            report["candidates"][0]["invalidContentBoundVerifierEvidenceRecordCount"],
            REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES.len()
        );
    }

    #[test]
    fn trusted_aggregate_accepts_valid_current_run_registry() {
        let (candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["acceptedCount"], 1);
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!([])
        );
    }

    #[test]
    fn producer_rejects_partially_malformed_category_evidence() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let evidence_id = candidate["sourceMappingEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        let padded_evidence_id = format!(" {evidence_id}");
        candidate["sourceMappingEvidenceIds"] = json!([evidence_id, padded_evidence_id]);

        let result = produce_fission_phase_source_evidence(
            &mut candidate,
            &trusted_evidence,
            test_producer_context(),
        );

        assert_eq!(
            result,
            Err("fission category evidence declaration must contain unique canonical ids")
        );
    }

    #[test]
    fn producer_rejects_every_ordered_cross_category_record_reuse() {
        let (mut base_candidate, trusted_evidence) =
            test_input_and_trusted_evidence(&valid_candidate());
        restore_category_upstream_evidence_ids(&mut base_candidate, &trusted_evidence);

        for source_category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
            let source_evidence_id =
                category_source_evidence_ids(&base_candidate, source_category.name)
                    .into_iter()
                    .next()
                    .unwrap();
            for destination_category in REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES {
                if source_category.name == destination_category.name {
                    continue;
                }
                let mut candidate = base_candidate.clone();
                let object = candidate.as_object_mut().unwrap();
                for field in destination_category.fields {
                    object.remove(*field);
                }
                object.insert(
                    destination_category.fields[0].to_string(),
                    json!([source_evidence_id.clone()]),
                );

                let result = produce_fission_phase_source_evidence(
                    &mut candidate,
                    &trusted_evidence,
                    test_producer_context(),
                );

                assert_eq!(
                    result,
                    Err("fission phase evidence could not join current-run upstream evidence"),
                    "{} evidence must not satisfy {}",
                    source_category.name,
                    destination_category.name,
                );
            }
        }
    }

    #[test]
    fn producer_rejects_content_hash_that_does_not_match_evidence_id_or_metadata() {
        let (mut candidate, mut trusted_evidence) =
            test_input_and_trusted_evidence(&valid_candidate());
        restore_category_upstream_evidence_ids(&mut candidate, &trusted_evidence);
        let source_mapping_evidence_id = candidate["sourceMappingEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == source_mapping_evidence_id)
            .unwrap()
            .content_hash = format!("sha256:{}", "d".repeat(64));

        let result = produce_fission_phase_source_evidence(
            &mut candidate,
            &trusted_evidence,
            test_producer_context(),
        );

        assert_eq!(
            result,
            Err("fission phase evidence could not join current-run upstream evidence")
        );
    }

    #[test]
    fn producer_rejects_content_consistent_record_with_wrong_id_descriptor() {
        let (mut candidate, mut trusted_evidence) =
            test_input_and_trusted_evidence(&valid_candidate());
        restore_category_upstream_evidence_ids(&mut candidate, &trusted_evidence);
        let original_evidence_id = candidate["sourceMappingEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        let record = trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == original_evidence_id)
            .unwrap();
        let digest = record.content_hash.strip_prefix("sha256:").unwrap();
        record.evidence_id = format!("evidence:unrelated-category:{digest}");
        candidate["sourceMappingEvidenceIds"] = json!([record.evidence_id.clone()]);

        let result = produce_fission_phase_source_evidence(
            &mut candidate,
            &trusted_evidence,
            test_producer_context(),
        );

        assert_eq!(
            result,
            Err("fission phase evidence could not join current-run upstream evidence")
        );
    }

    #[test]
    fn producer_rejects_content_consistent_oracle_record_for_another_contract() {
        let (mut candidate, mut trusted_evidence) =
            test_input_and_trusted_evidence(&valid_candidate());
        restore_category_upstream_evidence_ids(&mut candidate, &trusted_evidence);
        let original_evidence_id = candidate["outputOracleEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        let record = trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == original_evidence_id)
            .unwrap();
        record.metadata.as_mut().unwrap()["oracleSubject"]["requiredOracleId"] =
            json!("oracle:different-contract");
        let content_hash = sha256_json_value(record.metadata.as_ref().unwrap());
        let digest = content_hash.strip_prefix("sha256:").unwrap();
        record.evidence_id = format!("evidence:test-fission-output-oracle-contract:{digest}");
        record.content_hash = content_hash;
        candidate["outputOracleEvidenceIds"] = json!([record.evidence_id]);

        let result = produce_fission_phase_source_evidence(
            &mut candidate,
            &trusted_evidence,
            test_producer_context(),
        );

        assert_eq!(
            result,
            Err("fission phase evidence could not join current-run upstream evidence")
        );
    }

    #[test]
    fn trusted_aggregate_rejects_registry_replayed_into_another_session() {
        let (candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let context = FissionEvidenceProducerContext {
            session_id: "session:replayed-run",
            ..test_producer_context()
        };

        let report =
            super::verify_fission_candidates_with_evidence(&candidate, &trusted_evidence, context);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!([
                "source_mapping",
                "include_closure",
                "symbol_ownership",
                "dependency_closure",
                "abi_membrane",
                "compile_recipe",
                "loader_capability",
                "output_oracle"
            ])
        );
    }

    #[test]
    fn trusted_aggregate_rejects_registry_replayed_for_another_artifact() {
        let (candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let context = FissionEvidenceProducerContext {
            selected_artifact_id:
                "artifact:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            ..test_producer_context()
        };

        let report =
            super::verify_fission_candidates_with_evidence(&candidate, &trusted_evidence, context);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["acceptedCount"], 0);
    }

    #[test]
    fn trusted_aggregate_rejects_registry_replayed_for_another_edit() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        candidate["sourceEditId"] = json!("edit:replayed");
        let context = FissionEvidenceProducerContext {
            source_edit_id: "edit:replayed",
            ..test_producer_context()
        };

        let report =
            super::verify_fission_candidates_with_evidence(&candidate, &trusted_evidence, context);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["acceptedCount"], 0);
    }

    #[test]
    fn producer_rejects_cross_edit_upstream_evidence_rewrap() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        restore_category_upstream_evidence_ids(&mut candidate, &trusted_evidence);
        candidate["sourceEditId"] = json!("edit:replayed");
        let context = FissionEvidenceProducerContext {
            source_edit_id: "edit:replayed",
            ..test_producer_context()
        };

        let result =
            produce_fission_phase_source_evidence(&mut candidate, &trusted_evidence, context);

        assert_eq!(
            result,
            Err("fission phase evidence could not join current-run upstream evidence")
        );
    }

    #[test]
    fn trusted_aggregate_rejects_upstream_record_from_another_timestamp() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let upstream_evidence_id = candidate["verifierEvidenceRecords"][0]
            ["trustedSourceRecordProjection"]["metadata"]["upstreamEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == upstream_evidence_id)
            .unwrap()
            .timestamp = "2026-07-16T12:00:01Z".to_string();

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["acceptedCount"], 0);
    }

    #[test]
    fn trusted_aggregate_rejects_artifact_unbound_upstream_record() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let upstream_evidence_id = candidate["verifierEvidenceRecords"][0]
            ["trustedSourceRecordProjection"]["metadata"]["upstreamEvidenceIds"][0]
            .as_str()
            .unwrap()
            .to_string();
        trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == upstream_evidence_id)
            .unwrap()
            .artifact_uri = None;

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["acceptedCount"], 0);
    }

    #[test]
    fn trusted_aggregate_rejects_missing_registry_record() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let source_evidence_id = candidate["verifierEvidenceRecords"][0]["sourceEvidenceId"]
            .as_str()
            .unwrap()
            .to_string();
        trusted_evidence.retain(|record| record.evidence_id != source_evidence_id);

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
        assert_eq!(
            report["candidates"][0]["invalidContentBoundVerifierEvidenceRecordCount"],
            1
        );
    }

    #[test]
    fn trusted_aggregate_rejects_duplicate_registry_id() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let source_evidence_id = candidate["verifierEvidenceRecords"][0]["sourceEvidenceId"]
            .as_str()
            .unwrap();
        let duplicate = trusted_evidence
            .iter()
            .find(|record| record.evidence_id == source_evidence_id)
            .unwrap()
            .clone();
        trusted_evidence.push(duplicate);

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
    }

    #[test]
    fn trusted_aggregate_rejects_mutated_registry_record() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let source_evidence_id = candidate["verifierEvidenceRecords"][0]["sourceEvidenceId"]
            .as_str()
            .unwrap();
        trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == source_evidence_id)
            .unwrap()
            .summary
            .push_str(" mutated");

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
    }

    #[test]
    fn trusted_aggregate_rejects_wrong_category_and_authority_claim() {
        let (candidate, mut trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let source_evidence_id = candidate["verifierEvidenceRecords"][0]["sourceEvidenceId"]
            .as_str()
            .unwrap();
        let record = trusted_evidence
            .iter_mut()
            .find(|record| record.evidence_id == source_evidence_id)
            .unwrap();
        record.metadata.as_mut().unwrap()["category"] = json!("compile_recipe");
        record.metadata.as_mut().unwrap()["acceptedForGpuHmr"] = json!(true);

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
    }

    #[test]
    fn trusted_aggregate_rejects_ambiguous_duplicate_verifier_records() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        let duplicate = candidate["verifierEvidenceRecords"][0].clone();
        candidate["verifierEvidenceRecords"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
        assert_eq!(
            report["candidates"][0]["invalidContentBoundVerifierEvidenceRecordCount"],
            2
        );
    }

    #[test]
    fn phase_source_records_alone_cannot_satisfy_verifier_acceptance() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        candidate
            .as_object_mut()
            .unwrap()
            .remove("verifierEvidenceRecords");
        candidate["verifierEvidenceIds"] = json!(trusted_evidence
            .iter()
            .map(|record| record.evidence_id.clone())
            .collect::<Vec<_>>());

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["candidates"][0]["verificationEvidenceCoverage"]["missingCategories"],
            json!([
                "source_mapping",
                "include_closure",
                "symbol_ownership",
                "dependency_closure",
                "abi_membrane",
                "compile_recipe",
                "loader_capability",
                "output_oracle"
            ])
        );
    }

    #[test]
    fn renaming_unbound_project_fixture_and_label_fields_preserves_verdict() {
        let (mut candidate, trusted_evidence) = test_input_and_trusted_evidence(&valid_candidate());
        candidate["project"] = json!("renamed-project");
        candidate["fixture"] = json!("renamed-fixture");
        candidate["label"] = json!("renamed-label");

        let report = verify_with_test_evidence(&candidate, &trusted_evidence);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["acceptedCount"], 1);
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
        refresh_content_bound_evidence(&mut candidate);

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
    fn rejects_phase_evidence_from_tagged_free_form_ids() {
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

        assert_eq!(report["status"], "reject");
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!([
                "source_mapping",
                "include_closure",
                "symbol_ownership",
                "dependency_closure",
                "abi_membrane",
                "compile_recipe",
                "loader_capability",
                "output_oracle"
            ])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.deterministic_verifier_evidence_missing"));
    }

    #[test]
    fn rejects_content_bound_phase_evidence_after_subject_mutation() {
        let mut candidate = valid_candidate();
        candidate["compileCommandHash"] =
            json!("sha256:4444444444444444444444444444444444444444444444444444444444444444");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["invalidContentBoundVerifierEvidenceRecordCount"], 3);
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!(["include_closure", "dependency_closure", "compile_recipe"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.verifier_evidence_record_invalid"));
    }

    #[test]
    fn rejects_content_bound_phase_evidence_with_forged_category_binding() {
        let mut candidate = valid_candidate();
        candidate["verifierEvidenceRecords"][0]["category"] = json!("compile_recipe");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["invalidContentBoundVerifierEvidenceRecordCount"], 1);
        assert_eq!(
            report["verificationEvidenceCoverage"]["missingCategories"],
            json!(["source_mapping"])
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.verifier_evidence_record_invalid"));
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
        refresh_content_bound_evidence(&mut candidate);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(
            report["artifactIdentityContract"]["contentAddressedArtifactIds"],
            true
        );
        assert_eq!(report["artifactIdentityContract"]["idsMatchHashes"], true);
    }

    #[test]
    fn rejects_narrow_candidate_without_generated_topology_evidence() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("generatedTopologyEvidenceIds");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["generatedTopologyBinding"]["required"], true);
        assert_eq!(report["generatedTopologyBinding"]["valid"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.claim_narrower_than_generated_topology"));
    }

    #[test]
    fn rejects_narrow_candidate_without_generated_topology_binding() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("generatedTopologyBinding");

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert_eq!(report["generatedTopologyBinding"]["required"], true);
        assert_eq!(report["generatedTopologyBinding"]["bindingPresent"], false);
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.claim_narrower_than_generated_topology"));
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
        candidate
            .as_object_mut()
            .unwrap()
            .remove("selectedArtifactId");
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
        assert_eq!(
            report["outputOracleContract"]["requiredOracleId"],
            "oracle:sentinel"
        );
        assert_eq!(report["outputOracleContract"]["proposalPresent"], false);
        assert_eq!(
            report["outputOracleContract"]["resolvedContractPresent"],
            false
        );
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_missing"));
    }

    #[test]
    fn rejects_multiple_resolved_output_oracle_aliases_even_when_equal() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("outputOracleProposal");
        let contract = json!({
            "kind": "buffer_checksum",
            "oracleId": "oracle:sentinel",
            "expectedHash": format!("sha256:{}", "6".repeat(64)),
            "producer": "deterministic_probe",
            "outputTargetId": "buffer:sentinel",
            "readbackPlan": {"syncPoint": "after-dispatch"},
            "runtimeSessionIdSource": "runtime-session",
            "artifactIdSource": "selected-artifact"
        });
        candidate["outputOracleContract"] = contract.clone();
        candidate["resolved_output_oracle_contract"] = contract;
        refresh_content_bound_evidence(&mut candidate);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "reject");
        assert!(report["reasonCodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "fission.output_oracle_alias_conflict"));
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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
            "artifact_id": "artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });
        refresh_content_bound_evidence(&mut candidate);

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
            "artifactId": "artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "visual_ref": "validation-screenshot:fresh-frame"
        });
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

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
        refresh_content_bound_evidence(&mut candidate);

        let report = verify_fission_candidate(&candidate);

        assert_eq!(report["status"], "pass");
        assert_eq!(report["safeExportSupersetSymbols"], json!([]));
    }

    #[test]
    fn rejects_ai_only_verifier_evidence_ids() {
        let mut candidate = valid_candidate();
        candidate
            .as_object_mut()
            .unwrap()
            .remove("verifierEvidenceRecords");
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
        let deterministic_ids = report["deterministicVerifierEvidenceIds"]
            .as_array()
            .unwrap();
        assert_eq!(
            deterministic_ids.len(),
            REQUIRED_VERIFICATION_EVIDENCE_CATEGORIES.len()
        );
        assert!(deterministic_ids.iter().all(|id| id
            .as_str()
            .is_some_and(|id| id.starts_with("fission-evidence:"))));
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
        refresh_content_bound_evidence(&mut wide);

        let mut narrow = valid_candidate();
        narrow["islandId"] = json!("island:narrow");
        narrow["artifactKind"] = json!("source_include_bridge");
        narrow["sourcePaths"] = json!(["src/a.device"]);
        narrow["sourceSpans"] = json!([{"path": "src/a.device", "startLine": 20, "endLine": 24}]);
        narrow["targetSymbols"] = json!(["shade"]);
        narrow["exportedSymbolsExpected"] = json!(["shade"]);
        refresh_content_bound_evidence(&mut narrow);

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
