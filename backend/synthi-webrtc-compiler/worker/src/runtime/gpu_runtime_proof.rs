use crate::hmr::gpu_proof::sha256_hex_bytes;
use crate::infra::messages::compute_expected_output_contract_hash_valid;
use crate::runtime::runner_protocol::canonical_sha256_content_hash;
use std::collections::HashSet;

pub const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof_ledger.v1";
pub const GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE: &str =
    "synthi.gpu_hmr.proof_ledger.portable.v2";
pub const GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";
pub const GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.validation-proof.v1";
pub const GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION: &str = "synthi.gpu_hmr.contract.v1";
pub const GPU_HMR_FULL_RUNTIME_RESULT_STATE: &str = "gpu-hmr-full-runtime-proven";
pub const COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION: &str =
    "synthi.gpu.hmr.compute_expected_output_contract.v1";

pub const GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const GPU_HMR_PORTABLE_JSON_MAX_DEPTH: usize = 128;
pub const GPU_HMR_PORTABLE_JSON_MAX_NODES: usize = 100_000;
pub const GPU_HMR_PORTABLE_JSON_MAX_CONTAINER_ENTRIES: usize = 100_000;
pub const GPU_HMR_PORTABLE_JSON_MAX_STRING_BYTES: usize = 16 * 1024 * 1024;
pub const GPU_HMR_PORTABLE_JSON_MAX_CANONICAL_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrictGpuRuntimeProofExpectation<'a> {
    pub request_id: &'a str,
    pub source_edit_id: &'a str,
    pub artifact_content_hash: &'a str,
    pub process_id: &'a str,
    pub runtime_session_id: &'a str,
    pub compute_expected_output_contract_hash: Option<&'a str>,
    pub enforce_compute_expected_output_contract_hash: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGpuRuntimeProof {
    pub proof_id: String,
    pub ledger_proof_id: String,
    pub compute_expected_output_contract_hash: Option<String>,
}

fn stable_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        serde_json::Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value =
                        stable_json(map.get(key).unwrap_or(&serde_json::Value::Null));
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

fn json_sha256(value: &serde_json::Value) -> String {
    sha256_hex_bytes(stable_json(value).as_bytes())
}

pub fn canonical_gpu_runtime_proof_json_bytes(value: &serde_json::Value) -> Vec<u8> {
    stable_json(value).into_bytes()
}

pub fn canonical_gpu_runtime_proof_json_sha256(value: &serde_json::Value) -> String {
    format!(
        "sha256:{}",
        sha256_hex_bytes(&canonical_gpu_runtime_proof_json_bytes(value))
    )
}

fn json_field(value: &serde_json::Value, key: &str) -> serde_json::Value {
    value.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

fn json_object_or_empty(value: &serde_json::Value, key: &str) -> serde_json::Value {
    match value.get(key) {
        Some(serde_json::Value::Object(_)) => value
            .get(key)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        _ => serde_json::json!({}),
    }
}

pub fn canonical_runtime_ledger_proof_id(record: &serde_json::Value) -> String {
    let firewall = json_object_or_empty(record, "firewall_evidence");
    let mut material = serde_json::json!({
        "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "projectId": json_field(record, "project_id"),
        "editId": json_field(record, "edit_id"),
        "backend": json_field(record, "backend"),
        "classification": json_object_or_empty(record, "classification"),
        "contractHash": json_field(record, "contract_hash"),
        "artifactBeforeHash": json_field(record, "artifact_before_hash"),
        "artifactAfterHash": json_field(record, "artifact_after_hash"),
        "loaderEvent": json_object_or_empty(record, "loader_event"),
        "epochPublishEvent": json_object_or_empty(record, "epoch_publish_event"),
        "dispatchEvent": json_object_or_empty(record, "dispatch_event"),
        "outputEvent": json_object_or_empty(record, "output_event"),
        "retirementEvent": json_object_or_empty(record, "retirement_event"),
        "processIdentity": json_object_or_empty(record, "process_identity"),
        "deviceIdentity": json_object_or_empty(record, "device_identity"),
        "oracleArtifacts": json_object_or_empty(record, "oracle_artifacts"),
        "deterministicVisualMode": json_object_or_empty(record, "deterministic_visual_mode"),
        "outputOracleTarget": json_object_or_empty(record, "output_oracle_target"),
        "metricClock": json_field(record, "metric_clock"),
        "metricScope": json_field(record, "metric_scope"),
        "cacheState": json_field(record, "cache_state"),
        "timings": json_object_or_empty(record, "timings"),
        "timingMetrics": json_object_or_empty(record, "timing_metrics"),
        "modelProvenance": json_object_or_empty(record, "model_provenance"),
        "evidenceRefs": json_field(record, "evidence_refs"),
        "cpuHmrUsed": record.get("cpu_hmr_used").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "fullRebuildUsed": record.get("full_rebuild_used").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "processRestarted": record.get("process_restarted").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "firewallEvidence": {
            "cpuHmrUsedEvidencePresent": firewall.get("cpu_hmr_used").is_some() || firewall.get("cpuHmrUsed").is_some(),
            "fullRebuildUsedEvidencePresent": firewall.get("full_rebuild_used").is_some() || firewall.get("fullRebuildUsed").is_some(),
            "processRestartedEvidencePresent": firewall.get("process_restarted").is_some() || firewall.get("processRestarted").is_some(),
            "processIdBefore": firewall.get("process_id_before")
                .or_else(|| firewall.get("processIdBefore"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
            "processIdAfter": firewall.get("process_id_after")
                .or_else(|| firewall.get("processIdAfter"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
        },
    });
    if record
        .get("proof_canonical_profile")
        .and_then(serde_json::Value::as_str)
        == Some(GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE)
    {
        let object = material
            .as_object_mut()
            .expect("canonical runtime ledger proof material is an object");
        object.insert(
            "proofCanonicalProfile".to_string(),
            serde_json::json!(GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE),
        );
        if record.get("epoch_commit_event").is_some() {
            object.insert(
                "epochCommitEvent".to_string(),
                json_object_or_empty(record, "epoch_commit_event"),
            );
        }
    }
    format!("gpu-ledger-proof:sha256:{}", json_sha256(&material))
}

fn portable_json_numbers_supported(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Number(number) => number
            .as_i64()
            .map(|value| value.unsigned_abs() <= GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            .or_else(|| {
                number
                    .as_u64()
                    .map(|value| value <= GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            })
            .unwrap_or(false),
        serde_json::Value::Array(values) => values.iter().all(portable_json_numbers_supported),
        serde_json::Value::Object(fields) => fields.values().all(portable_json_numbers_supported),
        _ => true,
    }
}

fn portable_json_complexity_supported(value: &serde_json::Value) -> bool {
    fn add_bytes(bytes: &mut usize, amount: usize) -> bool {
        let Some(next_bytes) = bytes.checked_add(amount) else {
            return false;
        };
        if next_bytes > GPU_HMR_PORTABLE_JSON_MAX_CANONICAL_BYTES {
            return false;
        }
        *bytes = next_bytes;
        true
    }

    fn visit(
        value: &serde_json::Value,
        depth: usize,
        nodes: &mut usize,
        bytes: &mut usize,
    ) -> bool {
        if depth > GPU_HMR_PORTABLE_JSON_MAX_DEPTH {
            return false;
        }
        let Some(next_nodes) = nodes.checked_add(1) else {
            return false;
        };
        if next_nodes > GPU_HMR_PORTABLE_JSON_MAX_NODES {
            return false;
        }
        *nodes = next_nodes;

        match value {
            serde_json::Value::Null => add_bytes(bytes, 4),
            serde_json::Value::Bool(value) => add_bytes(bytes, if *value { 4 } else { 5 }),
            serde_json::Value::Number(value) => add_bytes(bytes, value.to_string().len()),
            serde_json::Value::String(value) => {
                value.len() <= GPU_HMR_PORTABLE_JSON_MAX_STRING_BYTES
                    && serde_json::to_string(value)
                        .ok()
                        .is_some_and(|encoded| add_bytes(bytes, encoded.len()))
            }
            serde_json::Value::Array(values) => {
                values.len() <= GPU_HMR_PORTABLE_JSON_MAX_CONTAINER_ENTRIES
                    && add_bytes(bytes, 2 + values.len().saturating_sub(1))
                    && values
                        .iter()
                        .all(|value| visit(value, depth + 1, nodes, bytes))
            }
            serde_json::Value::Object(fields) => {
                fields.len() <= GPU_HMR_PORTABLE_JSON_MAX_CONTAINER_ENTRIES
                    && add_bytes(bytes, 2 + fields.len().saturating_sub(1) + fields.len())
                    && fields
                        .keys()
                        .all(|key| key.len() <= GPU_HMR_PORTABLE_JSON_MAX_STRING_BYTES)
                    && fields.keys().all(|key| {
                        serde_json::to_string(key)
                            .ok()
                            .is_some_and(|encoded| add_bytes(bytes, encoded.len()))
                    })
                    && fields
                        .values()
                        .all(|value| visit(value, depth + 1, nodes, bytes))
            }
        }
    }

    let mut nodes = 0;
    let mut bytes = 0;
    visit(value, 0, &mut nodes, &mut bytes)
}

fn portable_json_aliases_consistent(value: &serde_json::Value) -> bool {
    fn alias_group_consistent(
        fields: &serde_json::Map<String, serde_json::Value>,
        names: &[&str],
    ) -> bool {
        let mut values = names.iter().filter_map(|name| fields.get(*name));
        let Some(first) = values.next() else {
            return true;
        };
        values.all(|value| value == first)
    }

    match value {
        serde_json::Value::Array(values) => values.iter().all(portable_json_aliases_consistent),
        serde_json::Value::Object(fields) => {
            let semantic_aliases_match = [
                &["backend", "gpu_backend", "gpuBackend"][..],
                &[
                    "artifact_after_hash",
                    "changed_gpu_artifact_hash",
                    "changedGpuArtifactHash",
                ][..],
                &[
                    "artifact_hash",
                    "artifact_id",
                    "artifactHash",
                    "artifactId",
                    "loaded_artifact_id",
                    "loadedArtifactId",
                    "published_artifact_id",
                    "publishedArtifactId",
                ][..],
            ]
            .iter()
            .all(|names| alias_group_consistent(fields, names));
            semantic_aliases_match
                && fields.iter().all(|(key, field_value)| {
                    let mut camel_key = String::with_capacity(key.len());
                    let mut uppercase_next = false;
                    let mut had_separator = false;
                    for character in key.chars() {
                        if character == '_' {
                            uppercase_next = true;
                            had_separator = true;
                        } else if uppercase_next {
                            camel_key.push(character.to_ascii_uppercase());
                            uppercase_next = false;
                        } else {
                            camel_key.push(character);
                        }
                    }
                    let alias_matches = !had_separator
                        || fields
                            .get(&camel_key)
                            .is_none_or(|alias_value| alias_value == field_value);
                    alias_matches && portable_json_aliases_consistent(field_value)
                })
        }
        _ => true,
    }
}

#[derive(Clone, Copy)]
enum EventAliasMode {
    Standard,
    Dispatch,
    Output,
    Retirement,
}

fn event_aliases_consistent(event: &serde_json::Value, mode: EventAliasMode) -> bool {
    let Some(fields) = event.as_object() else {
        return false;
    };
    let alias_group_consistent = |names: &[&str]| {
        let mut values = names.iter().filter_map(|name| fields.get(*name));
        let Some(first) = values.next() else {
            return true;
        };
        values.all(|value| value == first)
    };

    let standard_event_ids = ["id", "event_id", "eventId", "proof_id", "proofId"];
    let dispatch_event_ids = [
        "id",
        "event_id",
        "eventId",
        "proof_id",
        "proofId",
        "dispatch_id",
        "dispatchId",
    ];
    let event_ids = if matches!(mode, EventAliasMode::Dispatch) {
        dispatch_event_ids.as_slice()
    } else {
        standard_event_ids.as_slice()
    };
    let artifact_ids = [
        "artifact_hash",
        "artifactHash",
        "artifact_id",
        "artifactId",
        "loaded_artifact_hash",
        "loadedArtifactHash",
        "loaded_artifact_id",
        "loadedArtifactId",
        "published_artifact_hash",
        "publishedArtifactHash",
        "published_artifact_id",
        "publishedArtifactId",
        "runtime_artifact_id",
        "runtimeArtifactId",
        "selected_artifact_id",
        "selectedArtifactId",
        "new_artifact_hash",
        "newArtifactHash",
        "hash",
    ];
    let standard_groups = [
        event_ids,
        &["event", "event_kind", "eventKind", "kind"],
        &["epoch", "epoch_id", "epochId", "generation"],
        artifact_ids.as_slice(),
        &["process_id", "processId", "pid"],
        &["publication_id", "publicationId"],
        &["candidate_registration_id", "candidateRegistrationId"],
        &["dispatcher_registration_id", "dispatcherRegistrationId"],
        &["previous_epoch", "previousEpoch"],
        &["device_uuid", "deviceUuid", "device_id", "deviceId"],
        &[
            "timestamp_monotonic_ns",
            "timestampMonotonicNs",
            "timestamp_ms",
            "timestampMs",
            "ts",
        ],
        &[
            "passed",
            "success",
            "succeeded",
            "accepted",
            "gpu_hmr_success",
            "gpuHmrSuccess",
        ],
    ];
    standard_groups
        .iter()
        .all(|group| alias_group_consistent(group))
        && (!matches!(mode, EventAliasMode::Output)
            || alias_group_consistent(&[
                "after_dispatch_id",
                "afterDispatchId",
                "dispatch_id",
                "dispatchId",
            ]))
        && (!matches!(mode, EventAliasMode::Retirement)
            || (alias_group_consistent(&[
                "status",
                "result",
                "retirement_result",
                "retirementResult",
            ]) && alias_group_consistent(&["proof", "retirement_proof", "retirementProof"])))
}

fn canonical_epoch(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse::<u64>().ok()
}

fn expected_artifact_id(artifact_content_hash: &str) -> Option<String> {
    canonical_sha256_content_hash(artifact_content_hash).then(|| {
        format!(
            "artifact:sha256:{}",
            artifact_content_hash.trim_start_matches("sha256:")
        )
    })
}

fn canonical_artifact_id(value: &str) -> bool {
    value
        .strip_prefix("artifact:")
        .is_some_and(canonical_sha256_content_hash)
}

fn exact_object_fields(value: &serde_json::Value, expected: &[&str]) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.len() == expected.len() && expected.iter().all(|field| fields.contains_key(*field))
}

fn canonical_contract_text(value: &serde_json::Value) -> Option<&str> {
    let value = value.as_str()?;
    (!value.is_empty() && value.trim() == value).then_some(value)
}

fn canonical_bigint_text(value: &str, unsigned: bool) -> bool {
    if value == "0" {
        return true;
    }
    let digits = if let Some(rest) = value.strip_prefix('-') {
        if unsigned || rest.is_empty() {
            return false;
        }
        rest
    } else {
        value
    };
    digits
        .as_bytes()
        .first()
        .is_some_and(|byte| (b'1'..=b'9').contains(byte))
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn canonical_expected_value(value: &serde_json::Value, dtype: &str) -> bool {
    match dtype {
        "bool" => value.is_boolean(),
        "i64" | "u64" => value
            .as_str()
            .is_some_and(|value| canonical_bigint_text(value, dtype == "u64")),
        "complex64" | "complex128" => value.as_array().is_some_and(|components| {
            components.len() == 2
                && components
                    .iter()
                    .all(|component| component.as_f64().is_some_and(f64::is_finite))
        }),
        _ => value.as_f64().is_some_and(f64::is_finite),
    }
}

fn canonical_compute_expected_output_contract_hash(
    contract: &serde_json::Value,
    expectation: &StrictGpuRuntimeProofExpectation<'_>,
) -> Option<String> {
    const CONTRACT_FIELDS: &[&str] = &[
        "schemaVersion",
        "comparisonMode",
        "dtype",
        "shape",
        "elementCount",
        "byteOrder",
        "tolerance",
        "expectedValues",
        "expectedValuesHash",
        "expectedRawHash",
        "binding",
        "evidenceRefs",
        "contractHash",
    ];
    const BINDING_FIELDS: &[&str] = &[
        "projectId",
        "editId",
        "artifactAfterHash",
        "outputTargetId",
        "oracleCodeHash",
    ];
    const DTYPES: &[(&str, u64)] = &[
        ("bool", 1),
        ("i8", 1),
        ("u8", 1),
        ("bf16", 2),
        ("f16", 2),
        ("i16", 2),
        ("u16", 2),
        ("f32", 4),
        ("i32", 4),
        ("u32", 4),
        ("complex64", 8),
        ("f64", 8),
        ("i64", 8),
        ("u64", 8),
        ("complex128", 16),
    ];
    const MAX_EXPECTED_VALUES: usize = 262_144;

    if !exact_object_fields(contract, CONTRACT_FIELDS)
        || contract.get("schemaVersion")?.as_str()
            != Some(COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION)
    {
        return None;
    }
    let comparison_mode = contract.get("comparisonMode")?.as_str()?;
    if !matches!(comparison_mode, "exact_bytes" | "numeric_tolerance") {
        return None;
    }
    let dtype = contract.get("dtype")?.as_str()?;
    let dtype_width = DTYPES
        .iter()
        .find_map(|(candidate, width)| (*candidate == dtype).then_some(*width))?;
    let shape = contract.get("shape")?.as_array()?;
    if shape.is_empty() {
        return None;
    }
    let mut shape_product = 1_u64;
    for dimension in shape {
        let dimension = dimension.as_u64()?;
        if dimension == 0 || dimension > GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER {
            return None;
        }
        shape_product = shape_product.checked_mul(dimension)?;
        if shape_product > GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER {
            return None;
        }
    }
    let element_count = contract.get("elementCount")?.as_u64()?;
    if element_count == 0 || element_count != shape_product {
        return None;
    }
    let byte_order = contract.get("byteOrder")?.as_str()?;
    if (dtype_width == 1 && byte_order != "not_applicable")
        || (dtype_width > 1 && !matches!(byte_order, "little_endian" | "big_endian"))
    {
        return None;
    }
    if !contract
        .get("tolerance")?
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= 0.0)
    {
        return None;
    }

    match comparison_mode {
        "exact_bytes" => {
            if !contract.get("expectedValues")?.is_null()
                || !contract.get("expectedValuesHash")?.is_null()
                || !contract
                    .get("expectedRawHash")?
                    .as_str()
                    .is_some_and(compute_expected_output_contract_hash_valid)
            {
                return None;
            }
        }
        "numeric_tolerance" => {
            if !contract.get("expectedRawHash")?.is_null() {
                return None;
            }
            let expected_values = contract.get("expectedValues")?.as_array()?;
            if expected_values.len() > MAX_EXPECTED_VALUES
                || u64::try_from(expected_values.len()).ok()? != element_count
                || !expected_values
                    .iter()
                    .all(|value| canonical_expected_value(value, dtype))
            {
                return None;
            }
            let expected_values_hash = contract.get("expectedValuesHash")?.as_str()?;
            if !compute_expected_output_contract_hash_valid(expected_values_hash)
                || canonical_gpu_runtime_proof_json_sha256(contract.get("expectedValues")?)
                    != expected_values_hash
            {
                return None;
            }
        }
        _ => return None,
    }

    let binding = contract.get("binding")?;
    if !exact_object_fields(binding, BINDING_FIELDS) {
        return None;
    }
    let project_id = canonical_contract_text(binding.get("projectId")?)?;
    let edit_id = canonical_contract_text(binding.get("editId")?)?;
    let artifact_after_hash = canonical_contract_text(binding.get("artifactAfterHash")?)?;
    let output_target_id = canonical_contract_text(binding.get("outputTargetId")?)?;
    let oracle_code_hash = canonical_contract_text(binding.get("oracleCodeHash")?)?;
    let expected_artifact_id = expected_artifact_id(expectation.artifact_content_hash)?;
    if project_id.is_empty()
        || output_target_id.is_empty()
        || edit_id != expectation.source_edit_id
        || (artifact_after_hash != expectation.artifact_content_hash
            && artifact_after_hash != expected_artifact_id)
        || !compute_expected_output_contract_hash_valid(oracle_code_hash)
    {
        return None;
    }

    let evidence_refs = contract.get("evidenceRefs")?.as_array()?;
    if evidence_refs.is_empty() {
        return None;
    }
    let mut unique_refs = HashSet::with_capacity(evidence_refs.len());
    for evidence_ref in evidence_refs {
        let evidence_ref = canonical_contract_text(evidence_ref)?;
        if !unique_refs.insert(evidence_ref) {
            return None;
        }
    }

    let material = serde_json::json!({
        "schemaVersion": contract.get("schemaVersion")?,
        "comparisonMode": contract.get("comparisonMode")?,
        "dtype": contract.get("dtype")?,
        "shape": contract.get("shape")?,
        "elementCount": contract.get("elementCount")?,
        "byteOrder": contract.get("byteOrder")?,
        "tolerance": contract.get("tolerance")?,
        "expectedValues": contract.get("expectedValues")?,
        "expectedValuesHash": contract.get("expectedValuesHash")?,
        "expectedRawHash": contract.get("expectedRawHash")?,
        "binding": contract.get("binding")?,
        "evidenceRefs": contract.get("evidenceRefs")?,
    });
    let computed_hash = canonical_gpu_runtime_proof_json_sha256(&material);
    let declared_hash = contract.get("contractHash")?.as_str()?;
    (compute_expected_output_contract_hash_valid(declared_hash) && declared_hash == computed_hash)
        .then_some(computed_hash)
}

pub fn runtime_record_chain_matches(
    record: &serde_json::Value,
    expectation: &StrictGpuRuntimeProofExpectation<'_>,
) -> bool {
    if !portable_json_complexity_supported(record)
        || !portable_json_numbers_supported(record)
        || !portable_json_aliases_consistent(record)
    {
        return false;
    }
    let Some(expected_artifact_id) = expected_artifact_id(expectation.artifact_content_hash) else {
        return false;
    };
    let field_str = |pointer: &str| record.pointer(pointer).and_then(serde_json::Value::as_str);
    let field_u64 = |pointer: &str| record.pointer(pointer).and_then(serde_json::Value::as_u64);
    let event_artifact_matches = |event: &str| {
        field_str(&format!("/{event}/artifact_hash")) == Some(expected_artifact_id.as_str())
            && field_str(&format!("/{event}/artifact_id")) == Some(expected_artifact_id.as_str())
    };
    let event_process = |event: &str| field_str(&format!("/{event}/process_id"));
    let process_id = event_process("loader_event");
    let commit_event_id = field_str("/epoch_commit_event/id");
    let previous_epoch = field_str("/epoch_publish_event/previous_epoch");
    let candidate_epoch = field_str("/epoch_publish_event/epoch");
    let publication_id = field_str("/epoch_commit_event/publication_id");
    let candidate_registration_id = field_str("/epoch_commit_event/candidate_registration_id");
    let previous_artifact_id = field_str("/artifact_before_hash");
    let canonical_record_proof_id = canonical_runtime_ledger_proof_id(record);
    let record_proof_id_matches = ["proof_id", "proofId"]
        .iter()
        .filter_map(|name| record.get(*name))
        .all(|value| value.as_str() == Some(canonical_record_proof_id.as_str()));
    let generation_transition_matches = canonical_epoch(previous_epoch)
        .zip(canonical_epoch(candidate_epoch))
        .is_some_and(|(previous, candidate)| candidate > previous);
    let retirement_proof_accepted = matches!(
        field_str("/retirement_event/retirement_proof"),
        Some(
            "stream_event_proven"
                | "queue_idle_proven"
                | "frame_boundary_proven"
                | "no_retirement_required"
        )
    );
    let firewall = record.get("firewall_evidence");
    let evidence_refs = record
        .get("evidence_refs")
        .and_then(serde_json::Value::as_array);
    let has_ref = |expected: &str| {
        evidence_refs.is_some_and(|refs| refs.iter().any(|value| value.as_str() == Some(expected)))
    };

    record
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        == Some(GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION)
        && field_str("/proof_canonical_profile")
            == Some(GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE)
        && record_proof_id_matches
        && record.get("edit_id").and_then(serde_json::Value::as_str)
            == Some(expectation.source_edit_id)
        && record
            .get("artifact_after_hash")
            .and_then(serde_json::Value::as_str)
            == Some(expected_artifact_id.as_str())
        && record
            .get("artifact_before_hash")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|before| canonical_artifact_id(before) && before != expected_artifact_id)
        && event_aliases_consistent(&record["loader_event"], EventAliasMode::Standard)
        && event_aliases_consistent(&record["epoch_publish_event"], EventAliasMode::Standard)
        && event_aliases_consistent(&record["epoch_commit_event"], EventAliasMode::Standard)
        && event_aliases_consistent(&record["dispatch_event"], EventAliasMode::Dispatch)
        && event_aliases_consistent(&record["output_event"], EventAliasMode::Output)
        && event_aliases_consistent(&record["retirement_event"], EventAliasMode::Retirement)
        && event_artifact_matches("loader_event")
        && event_artifact_matches("epoch_publish_event")
        && event_artifact_matches("epoch_commit_event")
        && event_artifact_matches("dispatch_event")
        && event_artifact_matches("output_event")
        && field_str("/epoch_publish_event/event") == Some("provisional_install")
        && field_str("/epoch_publish_event/kind")
            .is_none_or(|kind| Some(kind) == field_str("/epoch_publish_event/event"))
        && field_str("/epoch_commit_event/event") == Some("unrestricted_visibility_commit")
        && field_str("/epoch_commit_event/kind")
            .is_none_or(|kind| Some(kind) == field_str("/epoch_commit_event/event"))
        && commit_event_id.is_some_and(|value| !value.is_empty())
        && generation_transition_matches
        && publication_id.is_some_and(|value| !value.is_empty())
        && candidate_registration_id.is_some_and(|value| !value.is_empty())
        && field_str("/epoch_publish_event/publication_id") == publication_id
        && field_str("/dispatch_event/publication_id") == publication_id
        && field_str("/epoch_publish_event/candidate_registration_id") == candidate_registration_id
        && field_str("/dispatch_event/dispatcher_registration_id") == candidate_registration_id
        && field_str("/epoch_commit_event/epoch") == field_str("/epoch_publish_event/epoch")
        && field_str("/epoch_commit_event/previous_epoch") == previous_epoch
        && field_str("/retirement_event/epoch") == previous_epoch
        && field_str("/retirement_event/artifact_hash") == previous_artifact_id
        && field_str("/retirement_event/artifact_id") == previous_artifact_id
        && field_str("/retirement_event/status") == Some("retired_after_quiescent")
        && retirement_proof_accepted
        && field_str("/dispatch_event/epoch") == field_str("/epoch_publish_event/epoch")
        && field_str("/output_event/epoch") == field_str("/dispatch_event/epoch")
        && field_str("/output_event/after_dispatch_id") == field_str("/dispatch_event/id")
        && record
            .pointer("/output_event/passed")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && process_id == Some(expectation.process_id)
        && event_process("epoch_publish_event") == process_id
        && event_process("epoch_commit_event") == process_id
        && event_process("dispatch_event") == process_id
        && event_process("output_event") == process_id
        && event_process("retirement_event") == process_id
        && field_str("/process_identity/process_id") == Some(expectation.process_id)
        && field_str("/process_identity/runtime_session_id") == Some(expectation.runtime_session_id)
        && record
            .get("cpu_hmr_used")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && record
            .get("full_rebuild_used")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && record
            .get("process_restarted")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("cpu_hmr_used"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("full_rebuild_used"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("process_restarted"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("process_id_before"))
            .and_then(serde_json::Value::as_str)
            == process_id
        && firewall
            .and_then(|value| value.get("process_id_after"))
            .and_then(serde_json::Value::as_str)
            == process_id
        && field_u64("/loader_event/timestamp_monotonic_ns")
            .zip(field_u64("/epoch_publish_event/timestamp_monotonic_ns"))
            .is_some_and(|(loader, publish)| loader <= publish)
        && field_u64("/epoch_publish_event/timestamp_monotonic_ns")
            .zip(field_u64("/dispatch_event/timestamp_monotonic_ns"))
            .is_some_and(|(publish, dispatch)| publish <= dispatch)
        && field_u64("/dispatch_event/timestamp_monotonic_ns")
            .zip(field_u64("/output_event/timestamp_monotonic_ns"))
            .is_some_and(|(dispatch, output)| dispatch <= output)
        && field_u64("/output_event/timestamp_monotonic_ns")
            .zip(field_u64("/epoch_commit_event/timestamp_monotonic_ns"))
            .is_some_and(|(output, commit)| output <= commit)
        && field_u64("/epoch_commit_event/timestamp_monotonic_ns")
            .zip(field_u64("/retirement_event/timestamp_monotonic_ns"))
            .is_some_and(|(commit, retirement)| commit <= retirement)
        && has_ref(&format!("reload:{}", expectation.request_id))
        && has_ref(&format!("source-edit-id:{}", expectation.source_edit_id))
        && has_ref(publication_id.unwrap_or_default())
        && has_ref(candidate_registration_id.unwrap_or_default())
}

pub fn recomputed_runtime_proof_id(
    runtime_artifact: &serde_json::Value,
    record: &serde_json::Value,
) -> Option<String> {
    let material = serde_json::json!({
        "resultState": runtime_artifact.get("resultState")?,
        "proofLedger": runtime_artifact.get("proofLedger")?,
        "acceptanceContract": runtime_artifact.get("acceptanceContract")?,
        "stageResults": runtime_artifact.get("stageResults")?,
        "runtimeTrace": runtime_artifact.get("runtimeTrace")?,
        "runtimeSessionId": runtime_artifact.pointer("/runtimeTrace/runtimeSessionId")?,
        "artifactBefore": record.get("artifact_before_hash")?,
        "artifactAfter": record.get("artifact_after_hash")?,
        "dispatchId": record.pointer("/dispatch_event/id")?,
    });
    Some(format!(
        "gpu-runtime-proof:sha256:{}",
        json_sha256(&material)
    ))
}

pub fn verify_strict_gpu_runtime_proof(
    proof: &serde_json::Value,
    expectation: &StrictGpuRuntimeProofExpectation<'_>,
) -> Option<VerifiedGpuRuntimeProof> {
    let reload_ref = format!("reload:{}", expectation.request_id);
    let source_edit_ref = format!("source-edit-id:{}", expectation.source_edit_id);
    if !portable_json_complexity_supported(proof)
        || !portable_json_numbers_supported(proof)
        || !portable_json_aliases_consistent(proof)
        || proof.get("type").and_then(serde_json::Value::as_str) != Some("gpu_hmr_proof")
        || proof
            .get("schemaVersion")
            .and_then(serde_json::Value::as_str)
            != Some(GPU_HMR_PROOF_SCHEMA_VERSION)
        || proof.get("module").and_then(serde_json::Value::as_str) != Some("device")
        || proof.get("resultState").and_then(serde_json::Value::as_str)
            != Some(GPU_HMR_FULL_RUNTIME_RESULT_STATE)
    {
        return None;
    }

    let proof_id = proof.get("proofId").and_then(serde_json::Value::as_str)?;
    let runtime_artifact = proof.get("runtimeProofArtifact")?;
    if runtime_artifact
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some(GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION)
        || runtime_artifact
            .get("proofId")
            .and_then(serde_json::Value::as_str)
            != Some(proof_id)
        || runtime_artifact
            .get("resultState")
            .and_then(serde_json::Value::as_str)
            != Some(GPU_HMR_FULL_RUNTIME_RESULT_STATE)
        || runtime_artifact
            .get("fullRuntimeProven")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .get("gpuHmrSuccess")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/acceptanceContractEvaluation/accepted")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/acceptanceContractEvaluation/failedGates")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|failed_gates| !failed_gates.is_empty())
        || runtime_artifact
            .pointer("/acceptanceContractConsistency/accepted")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/acceptanceContractConsistency/failedGates")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|failed_gates| !failed_gates.is_empty())
        || runtime_artifact
            .pointer("/derivedAcceptanceContractEvaluation/accepted")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/derivedAcceptanceContractEvaluation/failedGates")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|failed_gates| !failed_gates.is_empty())
        || runtime_artifact
            .pointer("/proofLedgerSourceConsistency/accepted")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/proofLedgerSourceConsistency/failures")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|failures| !failures.is_empty())
        || runtime_artifact
            .get("limitations")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|limitations| !limitations.is_empty())
        || runtime_artifact
            .pointer("/runtimeTrace/processId")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.process_id)
        || runtime_artifact
            .pointer("/runtimeTrace/runtimeSessionId")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.runtime_session_id)
    {
        return None;
    }

    let proof_ledger = proof.get("proofLedger")?;
    if proof_ledger
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some(GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION)
        || proof_ledger
            .get("gpuHmrSuccess")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact.get("proofLedger") != Some(proof_ledger)
    {
        return None;
    }
    let record = proof_ledger.pointer("/records/0")?;
    let expected_ledger_proof_id = canonical_runtime_ledger_proof_id(record);
    if proof_ledger
        .get("records")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|records| records.len() != 1)
        || !runtime_record_chain_matches(record, expectation)
        || proof_ledger
            .get("proofId")
            .and_then(serde_json::Value::as_str)
            != Some(expected_ledger_proof_id.as_str())
        || runtime_artifact
            .pointer("/proofLedgerQuery/proofId")
            .and_then(serde_json::Value::as_str)
            != proof_ledger
                .get("proofId")
                .and_then(serde_json::Value::as_str)
        || runtime_artifact
            .pointer("/proofLedgerQuery/schemaVersion")
            .and_then(serde_json::Value::as_str)
            != Some(GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION)
        || runtime_artifact
            .pointer("/explicitProofLedgerRecord/edit_id")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.source_edit_id)
        || runtime_artifact
            .pointer("/acceptanceContract/edit_id")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.source_edit_id)
        || runtime_artifact
            .pointer("/derivedAcceptanceContract/edit_id")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.source_edit_id)
        || runtime_artifact.get("explicitProofLedgerRecord") != Some(record)
        || runtime_artifact.get("derivedProofLedgerRecord") != Some(record)
        || runtime_artifact
            .pointer("/proofLedgerQuery/gpuHmrSuccess")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || runtime_artifact
            .pointer("/proofLedgerQuery/failedInvariants")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|failures| !failures.is_empty())
    {
        return None;
    }

    let expected_artifact_id = expected_artifact_id(expectation.artifact_content_hash)?;
    let acceptance_contract = runtime_artifact.get("acceptanceContract")?;
    if acceptance_contract
        .get("contract_version")
        .and_then(serde_json::Value::as_str)
        != Some(GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION)
        || acceptance_contract
            .get("edit_id")
            .and_then(serde_json::Value::as_str)
            != Some(expectation.source_edit_id)
        || acceptance_contract
            .get("artifact_hash_after")
            .and_then(serde_json::Value::as_str)
            != Some(expected_artifact_id.as_str())
        || runtime_artifact.get("derivedAcceptanceContract") != Some(acceptance_contract)
        || recomputed_runtime_proof_id(runtime_artifact, record).as_deref() != Some(proof_id)
    {
        return None;
    }
    let declared_expected_output_contract = acceptance_contract
        .pointer("/fission_report/output_oracle_contract/expected_output_contract");
    let verified_expected_output_contract_hash =
        if expectation.enforce_compute_expected_output_contract_hash {
            match (
                expectation.compute_expected_output_contract_hash,
                declared_expected_output_contract,
            ) {
                (Some(expected_hash), Some(contract)) => {
                    if !compute_expected_output_contract_hash_valid(expected_hash) {
                        return None;
                    }
                    let computed_hash =
                        canonical_compute_expected_output_contract_hash(contract, expectation)?;
                    if computed_hash != expected_hash {
                        return None;
                    }
                    Some(computed_hash)
                }
                (Some(_), None) | (None, Some(_)) => return None,
                (None, None) => None,
            }
        } else {
            match declared_expected_output_contract {
                Some(contract) => Some(canonical_compute_expected_output_contract_hash(
                    contract,
                    expectation,
                )?),
                None => None,
            }
        };
    let evidence_refs = record
        .get("evidence_refs")
        .and_then(serde_json::Value::as_array)?;
    if !evidence_refs
        .iter()
        .any(|value| value.as_str() == Some(&reload_ref))
        || !evidence_refs
            .iter()
            .any(|value| value.as_str() == Some(&source_edit_ref))
    {
        return None;
    }

    Some(VerifiedGpuRuntimeProof {
        proof_id: proof_id.to_string(),
        ledger_proof_id: expected_ledger_proof_id,
        compute_expected_output_contract_hash: verified_expected_output_contract_hash,
    })
}

#[cfg(test)]
mod portable_json_profile_tests {
    use super::{
        canonical_gpu_runtime_proof_json_bytes, canonical_gpu_runtime_proof_json_sha256,
        portable_json_complexity_supported, GPU_HMR_PORTABLE_JSON_MAX_CANONICAL_BYTES,
        GPU_HMR_PORTABLE_JSON_MAX_CONTAINER_ENTRIES, GPU_HMR_PORTABLE_JSON_MAX_DEPTH,
        GPU_HMR_PORTABLE_JSON_MAX_NODES, GPU_HMR_PORTABLE_JSON_MAX_STRING_BYTES,
    };

    #[test]
    fn portable_complexity_profile_bounds_depth_entries_and_total_nodes() {
        assert!(portable_json_complexity_supported(&serde_json::json!({
            "records": [{"accepted": false}],
        })));

        let too_many_entries = serde_json::Value::Array(vec![
            serde_json::Value::Null;
            GPU_HMR_PORTABLE_JSON_MAX_CONTAINER_ENTRIES
                + 1
        ]);
        assert!(!portable_json_complexity_supported(&too_many_entries));

        let mut too_deep = serde_json::Value::Null;
        for _ in 0..=GPU_HMR_PORTABLE_JSON_MAX_DEPTH {
            too_deep = serde_json::Value::Array(vec![too_deep]);
        }
        assert!(!portable_json_complexity_supported(&too_deep));

        let node_heavy =
            serde_json::Value::Array(vec![
                serde_json::Value::Array(vec![serde_json::Value::Null]);
                (GPU_HMR_PORTABLE_JSON_MAX_NODES / 2) + 1
            ]);
        assert!(!portable_json_complexity_supported(&node_heavy));

        let too_long_string =
            serde_json::Value::String("x".repeat(GPU_HMR_PORTABLE_JSON_MAX_STRING_BYTES + 1));
        assert!(!portable_json_complexity_supported(&too_long_string));

        let aggregate_too_large = serde_json::Value::Array(vec![
            serde_json::Value::String("x".repeat(GPU_HMR_PORTABLE_JSON_MAX_CANONICAL_BYTES / 2)),
            serde_json::Value::String("y".repeat(GPU_HMR_PORTABLE_JSON_MAX_CANONICAL_BYTES / 2)),
        ]);
        assert!(!portable_json_complexity_supported(&aggregate_too_large));
    }

    #[test]
    fn portable_canonical_json_matches_utf8_key_order_golden_vector() {
        let astral = "\u{10000}";
        let private_use = "\u{e000}";
        let mut object = serde_json::Map::new();
        object.insert(astral.to_string(), serde_json::json!(1));
        object.insert(private_use.to_string(), serde_json::json!(2));
        object.insert(
            "a".to_string(),
            serde_json::json!([
                null,
                true,
                false,
                "x",
                9_007_199_254_740_991_i64,
                -9_007_199_254_740_991_i64
            ]),
        );
        let value = serde_json::Value::Object(object);
        let expected = format!(
            "{{\"a\":[null,true,false,\"x\",9007199254740991,-9007199254740991],\"{private_use}\":2,\"{astral}\":1}}"
        );

        assert_eq!(
            canonical_gpu_runtime_proof_json_bytes(&value),
            expected.as_bytes()
        );
        assert_eq!(
            canonical_gpu_runtime_proof_json_sha256(&value),
            "sha256:9cd01d39f1b9883189a95c0fe9a25514cf561fa4f96f8367ae2bb67892ccf223"
        );
    }
}
