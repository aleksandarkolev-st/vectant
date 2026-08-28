use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

use crate::hmr::adapter_trait::{
    reload_output_oracle_contract_content_hash, reload_output_oracle_proof_context_valid,
    ReloadCapsuleMetadata, RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION,
};
use crate::hmr::gpu_proof::sha256_hex_bytes;
use crate::infra::compute_expected_output_semantics::ComputeExpectedOutputContractV2;
#[cfg(test)]
use crate::runtime::gpu_runtime_boundary::GpuDispatchSlotBinding;
use crate::runtime::gpu_runtime_boundary::{
    monotonic_timestamp_ns, runtime_session_id, DispatcherCommitReceipt, GpuLaunchReceipt,
};

pub const HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA: &str =
    "synthi.gpu_hmr.host_verified_compute_readback.v1";
pub const HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY: &str =
    "worker_host_owned_full_dtoh_bytes_after_committed_dispatch_slot";

const MAX_RETAINED_RECEIPT_COUNT: usize = 32;
const MAX_RETAINED_READBACK_BYTES: usize = 128 * 1024 * 1024;
const DETERMINISTIC_SLICE_MAX_BYTES: usize = 4096;

const _: () = {
    assert!(MAX_RETAINED_RECEIPT_COUNT > 0);
    assert!(MAX_RETAINED_RECEIPT_COUNT < usize::MAX);
    assert!(MAX_RETAINED_READBACK_BYTES > 0);
    assert!(MAX_RETAINED_READBACK_BYTES < usize::MAX);
};

#[derive(Debug, Clone)]
pub(super) struct HostOutputOracleRequestBinding {
    request_id: String,
    source_edit_id: String,
    runtime_session_id: String,
    artifact_content_hash: String,
    artifact_id: String,
    profile_bytes_sha256: String,
    contract_sha256: String,
    oracle_id: String,
    expected_sha256: String,
    baseline_sha256: String,
    producer: String,
    output_target_id: String,
    probe_mode: String,
    probe_config_hash: String,
    proof_runtime_session_id: String,
    compute_expected_output_contract_v2: ComputeExpectedOutputContractV2,
    compute_expected_output_contract_hash: String,
    compute_expected_output_semantics_hash: String,
    proof_context_binding_sha256: Option<String>,
    proof_context_proof_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostVerifiedComputeReadbackReceipt {
    receipt_id: String,
    request_id: String,
    source_edit_id: String,
    runtime_session_id: String,
    process_id: u32,
    artifact_content_hash: String,
    artifact_id: String,
    generation: u64,
    dispatcher_registration_id: String,
    dispatch_table_hash: String,
    dispatch_table_entry_id: String,
    dispatch_id: String,
    dispatch_timestamp_monotonic_ns: u128,
    readback_timestamp_monotonic_ns: u128,
    stream_token: usize,
    profile_schema_version: String,
    profile_id: String,
    profile_bytes_sha256: String,
    contract_sha256: String,
    proof_runtime_session_id: String,
    compute_expected_output_contract_v2: ComputeExpectedOutputContractV2,
    compute_expected_output_contract_hash: String,
    compute_expected_output_semantics_hash: String,
    proof_context_binding_sha256: Option<String>,
    proof_context_proof_id: Option<String>,
    oracle_id: String,
    producer: String,
    output_target_id: String,
    output_buffer_name: String,
    element_type: String,
    element_count: usize,
    element_byte_width: usize,
    endianness: String,
    baseline_sha256: String,
    expected_sha256: String,
    observed_sha256: String,
    readback_schema_sha256: String,
    deterministic_slice_offset: usize,
    deterministic_slice_length: usize,
    deterministic_slice_stride: usize,
    deterministic_slice_sha256: String,
    probe_mode: String,
    probe_config_hash: String,
    probe_evidence_ref: String,
    readback_bytes: Arc<[u8]>,
    publication_id: Option<String>,
    previous_generation: Option<u64>,
    publication_timestamp_monotonic_ns: Option<u128>,
    publication_committed_timestamp_monotonic_ns: Option<u128>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadbackSchemaMaterial<'a> {
    schema_version: &'static str,
    element_type: &'a str,
    element_count: usize,
    element_byte_width: usize,
    endianness: &'a str,
    byte_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptIdMaterial<'a> {
    schema_version: &'static str,
    authority: &'static str,
    request_id: &'a str,
    source_edit_id: &'a str,
    runtime_session_id: &'a str,
    process_id: u32,
    artifact_content_hash: &'a str,
    artifact_id: &'a str,
    generation: u64,
    dispatcher_registration_id: &'a str,
    dispatch_table_hash: &'a str,
    dispatch_table_entry_id: &'a str,
    dispatch_id: &'a str,
    dispatch_timestamp_monotonic_ns: u128,
    readback_timestamp_monotonic_ns: u128,
    stream_token: usize,
    profile_schema_version: &'a str,
    profile_id: &'a str,
    profile_bytes_sha256: &'a str,
    contract_sha256: &'a str,
    proof_runtime_session_id: &'a str,
    compute_expected_output_contract_v2: &'a ComputeExpectedOutputContractV2,
    compute_expected_output_contract_hash: &'a str,
    compute_expected_output_semantics_hash: &'a str,
    proof_context_binding_sha256: Option<&'a str>,
    proof_context_proof_id: Option<&'a str>,
    oracle_id: &'a str,
    producer: &'a str,
    output_target_id: &'a str,
    output_buffer_name: &'a str,
    baseline_sha256: &'a str,
    expected_sha256: &'a str,
    observed_sha256: &'a str,
    readback_schema_sha256: &'a str,
    readback_byte_length: usize,
    deterministic_slice_sha256: &'a str,
    probe_config_hash: &'a str,
    probe_evidence_ref: &'a str,
    publication_id: &'a str,
    previous_generation: u64,
    publication_timestamp_monotonic_ns: u128,
    publication_committed_timestamp_monotonic_ns: u128,
}

thread_local! {
    static ACTIVE_REQUEST_BINDING: RefCell<Option<HostOutputOracleRequestBinding>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy)]
struct ReceiptRetentionLimits {
    max_receipt_count: usize,
    max_readback_bytes: usize,
}

impl ReceiptRetentionLimits {
    fn new(max_receipt_count: usize, max_readback_bytes: usize) -> Result<Self, String> {
        if max_receipt_count == 0 || max_receipt_count > MAX_RETAINED_RECEIPT_COUNT {
            return Err(format!(
                "host output oracle receipt count limit must be in 1..={MAX_RETAINED_RECEIPT_COUNT}"
            ));
        }
        if max_readback_bytes == 0 || max_readback_bytes > MAX_RETAINED_READBACK_BYTES {
            return Err(format!(
                "host output oracle readback byte limit must be in 1..={MAX_RETAINED_READBACK_BYTES}"
            ));
        }
        Ok(Self {
            max_receipt_count,
            max_readback_bytes,
        })
    }

    fn compile_time_maxima() -> Self {
        Self::new(MAX_RETAINED_RECEIPT_COUNT, MAX_RETAINED_READBACK_BYTES)
            .expect("host output oracle compile-time receipt retention limits")
    }
}

struct VerifiedReceiptStore {
    receipts: VecDeque<HostVerifiedComputeReadbackReceipt>,
    retained_receipt_count: usize,
    retained_readback_bytes: usize,
    limits: ReceiptRetentionLimits,
}

fn checked_retention_after_insert(
    retained_receipt_count: usize,
    retained_readback_bytes: usize,
    readback_bytes: usize,
) -> Result<(usize, usize), String> {
    let next_receipt_count = retained_receipt_count
        .checked_add(1)
        .ok_or_else(|| "host output oracle retained receipt count overflow".to_string())?;
    let next_readback_bytes = retained_readback_bytes
        .checked_add(readback_bytes)
        .ok_or_else(|| {
            "host output oracle retained readback byte accounting overflow".to_string()
        })?;
    Ok((next_receipt_count, next_readback_bytes))
}

impl VerifiedReceiptStore {
    fn new(limits: ReceiptRetentionLimits) -> Self {
        Self {
            receipts: VecDeque::new(),
            retained_receipt_count: 0,
            retained_readback_bytes: 0,
            limits,
        }
    }

    fn with_compile_time_maxima() -> Self {
        Self::new(ReceiptRetentionLimits::compile_time_maxima())
    }

    fn validate_accounting(&self) -> Result<(), String> {
        if self.retained_receipt_count != self.receipts.len() {
            return Err(format!(
                "host output oracle retained receipt count accounting mismatch accounted={} actual={}",
                self.retained_receipt_count,
                self.receipts.len()
            ));
        }
        let actual_readback_bytes = self.receipts.iter().try_fold(0usize, |total, receipt| {
            total
                .checked_add(receipt.readback_bytes.len())
                .ok_or_else(|| {
                    "host output oracle retained readback byte consistency overflow".to_string()
                })
        })?;
        if self.retained_readback_bytes != actual_readback_bytes {
            return Err(format!(
                "host output oracle retained readback byte accounting mismatch accounted={} actual={actual_readback_bytes}",
                self.retained_readback_bytes
            ));
        }
        if self.retained_receipt_count > self.limits.max_receipt_count
            || self.retained_readback_bytes > self.limits.max_readback_bytes
        {
            return Err(
                "host output oracle retained receipt accounting exceeds configured limits"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn insert_pinned(
        &mut self,
        receipt: &HostVerifiedComputeReadbackReceipt,
    ) -> Result<(), String> {
        self.validate_accounting()?;
        if self.receipts.iter().any(|candidate| {
            candidate.request_id == receipt.request_id
                && candidate.source_edit_id == receipt.source_edit_id
                && candidate.artifact_content_hash == receipt.artifact_content_hash
        }) {
            return Err(
                "host output oracle produced more than one receipt for a reload".to_string(),
            );
        }

        let (next_receipt_count, next_readback_bytes) = checked_retention_after_insert(
            self.retained_receipt_count,
            self.retained_readback_bytes,
            receipt.readback_bytes.len(),
        )?;
        if next_receipt_count > self.limits.max_receipt_count {
            return Err(format!(
                "host output oracle retained receipt count capacity exceeded limit={}",
                self.limits.max_receipt_count
            ));
        }
        if next_readback_bytes > self.limits.max_readback_bytes {
            return Err(format!(
                "host output oracle retained readback byte capacity exceeded limit={}",
                self.limits.max_readback_bytes
            ));
        }

        self.receipts.push_back(receipt.clone());
        self.retained_receipt_count = next_receipt_count;
        self.retained_readback_bytes = next_readback_bytes;
        debug_assert!(self.validate_accounting().is_ok());
        Ok(())
    }

    fn remove_at(&mut self, index: usize) -> Result<HostVerifiedComputeReadbackReceipt, String> {
        self.validate_accounting()?;
        let readback_bytes = self
            .receipts
            .get(index)
            .ok_or_else(|| "host output oracle receipt removal index is invalid".to_string())?
            .readback_bytes
            .len();
        let next_receipt_count = self
            .retained_receipt_count
            .checked_sub(1)
            .ok_or_else(|| "host output oracle retained receipt count underflow".to_string())?;
        let next_readback_bytes = self
            .retained_readback_bytes
            .checked_sub(readback_bytes)
            .ok_or_else(|| {
                "host output oracle retained readback byte accounting underflow".to_string()
            })?;
        let receipt = self
            .receipts
            .remove(index)
            .ok_or_else(|| "host output oracle receipt disappeared during removal".to_string())?;
        self.retained_receipt_count = next_receipt_count;
        self.retained_readback_bytes = next_readback_bytes;
        debug_assert!(self.validate_accounting().is_ok());
        Ok(receipt)
    }

    fn discard_matching(
        &mut self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
    ) -> Result<usize, String> {
        self.validate_accounting()?;
        let matches = matching_receipt_indices(
            &self.receipts,
            request_id,
            source_edit_id,
            artifact_content_hash,
        );
        let discarded = matches.len();
        for index in matches.into_iter().rev() {
            self.remove_at(index)?;
        }
        Ok(discarded)
    }

    #[cfg(test)]
    fn clear(&mut self) -> Result<(), String> {
        self.validate_accounting()?;
        self.receipts.clear();
        self.retained_receipt_count = 0;
        self.retained_readback_bytes = 0;
        Ok(())
    }
}

static VERIFIED_RECEIPTS: OnceLock<Mutex<VerifiedReceiptStore>> = OnceLock::new();

fn receipt_store() -> &'static Mutex<VerifiedReceiptStore> {
    VERIFIED_RECEIPTS.get_or_init(|| Mutex::new(VerifiedReceiptStore::with_compile_time_maxima()))
}

fn canonical_sha256(value: &str) -> bool {
    canonical_prefixed_sha256(value, "sha256:")
}

fn canonical_prefixed_sha256(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn canonical_source_edit_id(value: &str) -> bool {
    value
        .strip_prefix("source-edit:sha256:")
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
}

fn required_text(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(format!(
            "host output oracle {label} is empty or contains whitespace"
        ));
    }
    Ok(value.to_string())
}

fn contract_string(contract: &Value, aliases: &[&str], label: &str) -> Result<String, String> {
    let mut values = aliases
        .iter()
        .filter_map(|key| contract.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let value = values
        .next()
        .ok_or_else(|| format!("host output oracle contract is missing {label}"))?;
    if values.any(|candidate| candidate != value) {
        return Err(format!(
            "host output oracle contract has conflicting {label} aliases"
        ));
    }
    required_text(value, label)
}

impl HostOutputOracleRequestBinding {
    pub(super) fn from_reload_request(
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        capsule_metadata: &ReloadCapsuleMetadata,
    ) -> Result<Self, String> {
        let request_id = required_text(request_id, "request id")?;
        let source_edit_id = required_text(source_edit_id, "source edit id")?;
        if !canonical_source_edit_id(&source_edit_id) {
            return Err("host output oracle source edit id is not canonical".to_string());
        }
        let artifact_content_hash = required_text(artifact_content_hash, "artifact content hash")?;
        if !canonical_sha256(&artifact_content_hash) {
            return Err("host output oracle artifact content hash is not canonical".to_string());
        }
        let artifact_id = format!("artifact:{artifact_content_hash}");

        let commitment = capsule_metadata
            .output_oracle_profile_commitment
            .as_ref()
            .ok_or_else(|| "host output oracle profile commitment is missing".to_string())?;
        if commitment.schema_version != RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION {
            return Err("host output oracle profile commitment schema is invalid".to_string());
        }
        if commitment.candidate_artifact_sha256 != artifact_content_hash {
            return Err("host output oracle commitment artifact mismatch".to_string());
        }
        if commitment.edit_id != source_edit_id {
            return Err("host output oracle commitment source edit mismatch".to_string());
        }
        if !canonical_sha256(&commitment.profile_bytes_sha256)
            || !canonical_sha256(&commitment.fission_output_oracle_contract_sha256)
        {
            return Err("host output oracle commitment hashes are not canonical".to_string());
        }

        let contract = capsule_metadata
            .fission_output_oracle_contract
            .as_ref()
            .filter(|value| value.is_object())
            .ok_or_else(|| "host output oracle contract is missing".to_string())?;
        let contract_sha256 = reload_output_oracle_contract_content_hash(contract)
            .ok_or_else(|| "host output oracle contract is not hashable".to_string())?;
        if contract_sha256 != commitment.fission_output_oracle_contract_sha256 {
            return Err("host output oracle contract content hash mismatch".to_string());
        }
        let kind = contract_string(contract, &["kind"], "kind")?;
        if kind != "compute_readback" {
            return Err(format!(
                "host output oracle kind {kind:?} is not a compute readback"
            ));
        }
        let expected_output_change = contract
            .get("expectedOutputChange")
            .or_else(|| contract.get("expected_output_change"))
            .and_then(Value::as_bool);
        if expected_output_change != Some(true) {
            return Err(
                "host output oracle contract does not require an output change".to_string(),
            );
        }
        let oracle_id = contract_string(contract, &["oracleId", "oracle_id"], "oracle id")?;
        let expected_sha256 = contract_string(
            contract,
            &["expected", "expectedSha256", "expected_sha256"],
            "expected checksum",
        )?;
        let baseline_sha256 = contract_string(
            contract,
            &["baselineSha256", "baseline_sha256"],
            "baseline checksum",
        )?;
        let producer = contract_string(contract, &["producer"], "producer")?;
        let output_target_id = contract_string(
            contract,
            &["outputTargetId", "output_target_id"],
            "output target id",
        )?;
        let probe_mode = contract_string(contract, &["probeMode", "probe_mode"], "probe mode")?;
        let probe_config_hash = contract_string(
            contract,
            &["probeConfigHash", "probe_config_hash"],
            "probe config hash",
        )?;
        if !canonical_sha256(&expected_sha256)
            || !canonical_sha256(&baseline_sha256)
            || !canonical_sha256(&probe_config_hash)
        {
            return Err(
                "host output oracle contract checksum fields are not canonical".to_string(),
            );
        }
        if baseline_sha256 == expected_sha256 {
            return Err(
                "host output oracle baseline and expected checksums are identical".to_string(),
            );
        }

        if !reload_output_oracle_proof_context_valid(capsule_metadata, None) {
            return Err("host output oracle proof context binding is invalid".to_string());
        }
        let proof_context = capsule_metadata
            .output_oracle_proof_context
            .as_ref()
            .expect("validated output-oracle proof context");
        let expected_output_contract = capsule_metadata
            .compute_expected_output_contract_v2
            .as_ref()
            .ok_or_else(|| {
                "host output oracle caller-derived expected-output contract v2 is missing"
                    .to_string()
            })?;
        let expected_output_binding = expected_output_contract.binding();
        let expected_output_semantics = expected_output_contract.semantics();
        if expected_output_semantics.comparison_mode() != "exact_bytes" {
            return Err(
                "host output oracle expected-output comparison mode is not executable by the exact-byte readback"
                    .to_string(),
            );
        }
        for (label, observed, expected) in [
            (
                "artifact hash",
                expected_output_binding.artifact_after_hash.as_str(),
                artifact_content_hash.as_str(),
            ),
            (
                "source edit id",
                expected_output_binding.edit_id.as_str(),
                source_edit_id.as_str(),
            ),
            (
                "proof runtime session",
                expected_output_binding.runtime_session_id.as_str(),
                proof_context.runtime_session_id.as_str(),
            ),
            (
                "output target id",
                expected_output_binding.output_target_id.as_str(),
                output_target_id.as_str(),
            ),
            (
                "oracle code hash",
                expected_output_binding.oracle_code_hash.as_str(),
                probe_config_hash.as_str(),
            ),
            (
                "expected evidence hash",
                expected_output_semantics.expected_evidence_hash(),
                expected_sha256.as_str(),
            ),
        ] {
            if observed != expected {
                return Err(format!(
                    "host output oracle expected-output {label} does not match the request binding"
                ));
            }
        }
        let compute_expected_output_contract_hash =
            expected_output_contract.contract_hash().to_string();
        let compute_expected_output_semantics_hash =
            expected_output_semantics.semantics_hash().to_string();
        if !canonical_sha256(&compute_expected_output_contract_hash)
            || expected_output_contract.canonical_hash() != compute_expected_output_contract_hash
            || !canonical_sha256(&compute_expected_output_semantics_hash)
        {
            return Err(
                "host output oracle expected-output contract hashes are not canonical".to_string(),
            );
        }
        let proof_context_binding_sha256 = Some(proof_context.binding_sha256.clone());
        let proof_context_proof_id = Some(proof_context.proof_id.clone());

        Ok(Self {
            request_id,
            source_edit_id,
            runtime_session_id: runtime_session_id().to_string(),
            artifact_content_hash,
            artifact_id,
            profile_bytes_sha256: commitment.profile_bytes_sha256.clone(),
            contract_sha256,
            oracle_id,
            expected_sha256,
            baseline_sha256,
            producer,
            output_target_id,
            probe_mode,
            probe_config_hash,
            proof_runtime_session_id: proof_context.runtime_session_id.clone(),
            compute_expected_output_contract_v2: expected_output_contract.clone(),
            compute_expected_output_contract_hash,
            compute_expected_output_semantics_hash,
            proof_context_binding_sha256,
            proof_context_proof_id,
        })
    }
}

struct ActiveBindingGuard;

impl Drop for ActiveBindingGuard {
    fn drop(&mut self) {
        ACTIVE_REQUEST_BINDING.with(|slot| {
            slot.replace(None);
        });
    }
}

pub(super) fn with_host_output_oracle_request_binding<T>(
    binding: &HostOutputOracleRequestBinding,
    operation: impl FnOnce() -> T,
) -> Result<T, String> {
    if binding.runtime_session_id != runtime_session_id() {
        return Err("host output oracle binding runtime session is stale".to_string());
    }
    let already_active = ACTIVE_REQUEST_BINDING.with(|slot| slot.borrow().is_some());
    if already_active {
        return Err("host output oracle request binding is already active".to_string());
    }
    receipt_store()
        .lock()
        .expect("host output oracle receipt lock")
        .discard_matching(
            &binding.request_id,
            &binding.source_edit_id,
            &binding.artifact_content_hash,
        )?;
    ACTIVE_REQUEST_BINDING.with(|slot| {
        slot.replace(Some(binding.clone()));
    });
    let _guard = ActiveBindingGuard;
    Ok(operation())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_host_verified_compute_readback(
    launch_receipt: &GpuLaunchReceipt,
    profile_schema_version: &str,
    profile_id: &str,
    oracle_id: &str,
    producer: &str,
    output_target_id: &str,
    output_buffer_name: &str,
    element_type: &str,
    element_count: usize,
    element_byte_width: usize,
    endianness: &str,
    baseline_sha256: &str,
    expected_sha256: &str,
    probe_mode: &str,
    probe_config_hash: &str,
    probe_evidence_ref: &str,
    readback_bytes: &[u8],
) -> Result<HostVerifiedComputeReadbackReceipt, String> {
    let binding = ACTIVE_REQUEST_BINDING
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| "host output oracle readback has no active request binding".to_string())?;
    if binding.runtime_session_id != runtime_session_id()
        || launch_receipt.runtime_session_id != binding.runtime_session_id
    {
        return Err("host output oracle launch runtime session mismatch".to_string());
    }
    if !launch_receipt.dispatched
        || !canonical_prefixed_sha256(&launch_receipt.dispatch_id, "dispatch:sha256:")
        || launch_receipt.active_generation == 0
        || launch_receipt.dispatch_timestamp_monotonic_ns == 0
    {
        return Err("host output oracle launch receipt is incomplete".to_string());
    }
    let dispatch_slot = launch_receipt
        .dispatch_slot
        .as_ref()
        .ok_or_else(|| "host output oracle launch has no exact dispatch slot".to_string())?;
    if dispatch_slot.runtime_session_id != binding.runtime_session_id
        || dispatch_slot.generation != launch_receipt.active_generation
        || dispatch_slot.artifact_id != binding.artifact_id
        || dispatch_slot.artifact_content_hash != binding.artifact_content_hash
        || !canonical_prefixed_sha256(
            &dispatch_slot.dispatcher_registration_id,
            "dispatcher:sha256:",
        )
        || !canonical_sha256(&dispatch_slot.dispatch_table_hash)
        || dispatch_slot.dispatch_table_entry_id.is_empty()
        || dispatch_slot
            .dispatch_table_entry_id
            .chars()
            .any(char::is_whitespace)
    {
        return Err("host output oracle dispatch slot mismatch".to_string());
    }
    for (label, actual, expected) in [
        ("oracle id", oracle_id, binding.oracle_id.as_str()),
        ("producer", producer, binding.producer.as_str()),
        (
            "output target id",
            output_target_id,
            binding.output_target_id.as_str(),
        ),
        (
            "expected checksum",
            expected_sha256,
            binding.expected_sha256.as_str(),
        ),
        (
            "baseline checksum",
            baseline_sha256,
            binding.baseline_sha256.as_str(),
        ),
        ("probe mode", probe_mode, binding.probe_mode.as_str()),
        (
            "probe config hash",
            probe_config_hash,
            binding.probe_config_hash.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(format!(
                "host output oracle {label} does not match request binding"
            ));
        }
    }
    let profile_schema_version = required_text(profile_schema_version, "profile schema")?;
    let profile_id = required_text(profile_id, "profile id")?;
    let output_buffer_name = required_text(output_buffer_name, "output buffer name")?;
    let element_type = required_text(element_type, "element type")?;
    let endianness = required_text(endianness, "endianness")?;
    let probe_evidence_ref = required_text(probe_evidence_ref, "probe evidence ref")?;
    if element_count == 0 || element_byte_width == 0 || readback_bytes.is_empty() {
        return Err("host output oracle readback schema is empty".to_string());
    }
    let schema_byte_length = element_count
        .checked_mul(element_byte_width)
        .ok_or_else(|| "host output oracle readback schema byte length overflow".to_string())?;
    if schema_byte_length != readback_bytes.len() {
        return Err(format!(
            "host output oracle readback schema mismatch expected={schema_byte_length} actual={}",
            readback_bytes.len()
        ));
    }
    let semantic_byte_order =
        match endianness.as_str() {
            "little" => "little_endian",
            "big" => "big_endian",
            "not_applicable" => "not_applicable",
            _ => return Err(
                "host output oracle readback endianness has no expected-output semantic mapping"
                    .to_string(),
            ),
        };
    let expected_output_semantics = binding.compute_expected_output_contract_v2.semantics();
    if expected_output_semantics.byte_offset() != 0
        || u64::try_from(readback_bytes.len()).ok() != Some(expected_output_semantics.byte_length())
        || expected_output_semantics.dtype() != element_type
        || u64::try_from(element_count).ok() != Some(expected_output_semantics.element_count())
        || expected_output_semantics.byte_order() != semantic_byte_order
    {
        return Err(
            "host output oracle readback schema does not match the caller-derived expected-output byte selection"
                .to_string(),
        );
    }
    let observed_sha256 = format!("sha256:{}", sha256_hex_bytes(readback_bytes));
    if observed_sha256 != binding.expected_sha256 {
        return Err("host output oracle full readback checksum mismatch".to_string());
    }
    if observed_sha256 == binding.baseline_sha256 {
        return Err("host output oracle full readback did not change from baseline".to_string());
    }

    let readback_timestamp_monotonic_ns = monotonic_timestamp_ns();
    if readback_timestamp_monotonic_ns < launch_receipt.dispatch_timestamp_monotonic_ns {
        return Err("host output oracle readback predates dispatch".to_string());
    }
    let deterministic_slice_offset = 0;
    let deterministic_slice_length = readback_bytes.len().min(DETERMINISTIC_SLICE_MAX_BYTES);
    let deterministic_slice_stride = 1;
    let deterministic_slice_sha256 = format!(
        "sha256:{}",
        sha256_hex_bytes(&readback_bytes[..deterministic_slice_length])
    );
    let readback_schema = ReadbackSchemaMaterial {
        schema_version: HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
        element_type: &element_type,
        element_count,
        element_byte_width,
        endianness: &endianness,
        byte_length: readback_bytes.len(),
    };
    let readback_schema_sha256 = format!(
        "sha256:{}",
        sha256_hex_bytes(
            &serde_json::to_vec(&readback_schema).map_err(|error| format!(
                "host output oracle schema serialization failed: {error}"
            ))?,
        )
    );
    let receipt = HostVerifiedComputeReadbackReceipt {
        receipt_id: String::new(),
        request_id: binding.request_id,
        source_edit_id: binding.source_edit_id,
        runtime_session_id: binding.runtime_session_id,
        process_id: std::process::id(),
        artifact_content_hash: binding.artifact_content_hash,
        artifact_id: binding.artifact_id,
        generation: launch_receipt.active_generation,
        dispatcher_registration_id: dispatch_slot.dispatcher_registration_id.clone(),
        dispatch_table_hash: dispatch_slot.dispatch_table_hash.clone(),
        dispatch_table_entry_id: dispatch_slot.dispatch_table_entry_id.clone(),
        dispatch_id: launch_receipt.dispatch_id.clone(),
        dispatch_timestamp_monotonic_ns: launch_receipt.dispatch_timestamp_monotonic_ns,
        readback_timestamp_monotonic_ns,
        stream_token: launch_receipt.stream_token,
        profile_schema_version,
        profile_id,
        profile_bytes_sha256: binding.profile_bytes_sha256,
        contract_sha256: binding.contract_sha256,
        proof_runtime_session_id: binding.proof_runtime_session_id,
        compute_expected_output_contract_v2: binding.compute_expected_output_contract_v2,
        compute_expected_output_contract_hash: binding.compute_expected_output_contract_hash,
        compute_expected_output_semantics_hash: binding.compute_expected_output_semantics_hash,
        proof_context_binding_sha256: binding.proof_context_binding_sha256,
        proof_context_proof_id: binding.proof_context_proof_id,
        oracle_id: binding.oracle_id,
        producer: binding.producer,
        output_target_id: binding.output_target_id,
        output_buffer_name,
        element_type,
        element_count,
        element_byte_width,
        endianness,
        baseline_sha256: binding.baseline_sha256,
        expected_sha256: binding.expected_sha256,
        observed_sha256,
        readback_schema_sha256,
        deterministic_slice_offset,
        deterministic_slice_length,
        deterministic_slice_stride,
        deterministic_slice_sha256,
        probe_mode: binding.probe_mode,
        probe_config_hash: binding.probe_config_hash,
        probe_evidence_ref,
        readback_bytes: Arc::from(readback_bytes.to_vec().into_boxed_slice()),
        publication_id: None,
        previous_generation: None,
        publication_timestamp_monotonic_ns: None,
        publication_committed_timestamp_monotonic_ns: None,
    };

    let mut store = receipt_store()
        .lock()
        .expect("host output oracle receipt lock");
    store.insert_pinned(&receipt)?;
    Ok(receipt)
}

fn matching_receipt_indices(
    receipts: &VecDeque<HostVerifiedComputeReadbackReceipt>,
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
) -> Vec<usize> {
    receipts
        .iter()
        .enumerate()
        .filter_map(|(index, receipt)| {
            (receipt.request_id == request_id
                && receipt.source_edit_id == source_edit_id
                && receipt.artifact_content_hash == artifact_content_hash)
                .then_some(index)
        })
        .collect()
}

pub(super) fn finalize_host_verified_compute_readback(
    binding: &HostOutputOracleRequestBinding,
    publication: &DispatcherCommitReceipt,
) -> Result<HostVerifiedComputeReadbackReceipt, String> {
    let mut store = receipt_store()
        .lock()
        .expect("host output oracle receipt lock");
    store.validate_accounting()?;
    let matches = matching_receipt_indices(
        &store.receipts,
        &binding.request_id,
        &binding.source_edit_id,
        &binding.artifact_content_hash,
    );
    if matches.len() != 1 {
        return Err(format!(
            "host output oracle expected one provisional receipt for publication, found {}",
            matches.len()
        ));
    }
    let receipt = store
        .receipts
        .get_mut(matches[0])
        .ok_or_else(|| "host output oracle receipt disappeared during finalization".to_string())?;
    if receipt.publication_id.is_some() {
        return Err("host output oracle receipt was already finalized".to_string());
    }
    if receipt.runtime_session_id != runtime_session_id()
        || receipt.generation != publication.candidate_generation()
        || receipt.dispatcher_registration_id != publication.candidate_registration_id()
        || publication.previous_generation() >= publication.candidate_generation()
        || !canonical_prefixed_sha256(
            publication.publication_id(),
            "dispatcher-publication:sha256:",
        )
        || publication.publication_timestamp_monotonic_ns()
            > receipt.dispatch_timestamp_monotonic_ns
        || publication.committed_timestamp_monotonic_ns() < receipt.readback_timestamp_monotonic_ns
    {
        return Err("host output oracle publication receipt mismatch".to_string());
    }

    let receipt_material = ReceiptIdMaterial {
        schema_version: HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
        authority: HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY,
        request_id: &receipt.request_id,
        source_edit_id: &receipt.source_edit_id,
        runtime_session_id: &receipt.runtime_session_id,
        process_id: receipt.process_id,
        artifact_content_hash: &receipt.artifact_content_hash,
        artifact_id: &receipt.artifact_id,
        generation: receipt.generation,
        dispatcher_registration_id: &receipt.dispatcher_registration_id,
        dispatch_table_hash: &receipt.dispatch_table_hash,
        dispatch_table_entry_id: &receipt.dispatch_table_entry_id,
        dispatch_id: &receipt.dispatch_id,
        dispatch_timestamp_monotonic_ns: receipt.dispatch_timestamp_monotonic_ns,
        readback_timestamp_monotonic_ns: receipt.readback_timestamp_monotonic_ns,
        stream_token: receipt.stream_token,
        profile_schema_version: &receipt.profile_schema_version,
        profile_id: &receipt.profile_id,
        profile_bytes_sha256: &receipt.profile_bytes_sha256,
        contract_sha256: &receipt.contract_sha256,
        proof_runtime_session_id: &receipt.proof_runtime_session_id,
        compute_expected_output_contract_v2: &receipt.compute_expected_output_contract_v2,
        compute_expected_output_contract_hash: &receipt.compute_expected_output_contract_hash,
        compute_expected_output_semantics_hash: &receipt.compute_expected_output_semantics_hash,
        proof_context_binding_sha256: receipt.proof_context_binding_sha256.as_deref(),
        proof_context_proof_id: receipt.proof_context_proof_id.as_deref(),
        oracle_id: &receipt.oracle_id,
        producer: &receipt.producer,
        output_target_id: &receipt.output_target_id,
        output_buffer_name: &receipt.output_buffer_name,
        baseline_sha256: &receipt.baseline_sha256,
        expected_sha256: &receipt.expected_sha256,
        observed_sha256: &receipt.observed_sha256,
        readback_schema_sha256: &receipt.readback_schema_sha256,
        readback_byte_length: receipt.readback_bytes.len(),
        deterministic_slice_sha256: &receipt.deterministic_slice_sha256,
        probe_config_hash: &receipt.probe_config_hash,
        probe_evidence_ref: &receipt.probe_evidence_ref,
        publication_id: publication.publication_id(),
        previous_generation: publication.previous_generation(),
        publication_timestamp_monotonic_ns: publication.publication_timestamp_monotonic_ns(),
        publication_committed_timestamp_monotonic_ns: publication
            .committed_timestamp_monotonic_ns(),
    };
    receipt.receipt_id = format!(
        "host-output-oracle-receipt:sha256:{}",
        sha256_hex_bytes(
            &serde_json::to_vec(&receipt_material).map_err(|error| format!(
                "host output oracle receipt serialization failed: {error}"
            ))?,
        )
    );
    receipt.publication_id = Some(publication.publication_id().to_string());
    receipt.previous_generation = Some(publication.previous_generation());
    receipt.publication_timestamp_monotonic_ns =
        Some(publication.publication_timestamp_monotonic_ns());
    receipt.publication_committed_timestamp_monotonic_ns =
        Some(publication.committed_timestamp_monotonic_ns());
    Ok(receipt.clone())
}

pub(super) fn host_verified_compute_receipt_for_proof(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    dispatch_id: &str,
) -> Result<HostVerifiedComputeReadbackReceipt, String> {
    let store = receipt_store()
        .lock()
        .expect("host output oracle receipt lock");
    store.validate_accounting()?;
    let matches = matching_receipt_indices(
        &store.receipts,
        request_id,
        source_edit_id,
        artifact_content_hash,
    );
    if matches.len() != 1 {
        return Err(format!(
            "host output oracle expected one receipt for proof, found {}",
            matches.len()
        ));
    }
    let receipt = store.receipts[matches[0]].clone();
    if receipt.dispatch_id != dispatch_id {
        return Err("host output oracle proof dispatch id mismatch".to_string());
    }
    if receipt.publication_id.is_none() {
        return Err("host output oracle proof receipt is not publication-finalized".to_string());
    }
    Ok(receipt)
}

pub fn consume_host_verified_compute_receipt(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
) -> Result<HostVerifiedComputeReadbackReceipt, String> {
    let mut store = receipt_store()
        .lock()
        .expect("host output oracle receipt lock");
    store.validate_accounting()?;
    let matches = matching_receipt_indices(
        &store.receipts,
        request_id,
        source_edit_id,
        artifact_content_hash,
    );
    if matches.len() != 1 {
        return Err(format!(
            "host output oracle expected one current-run receipt, found {}",
            matches.len()
        ));
    }
    if store.receipts[matches[0]].publication_id.is_none() {
        return Err(
            "host output oracle current-run receipt is not publication-finalized".to_string(),
        );
    }
    store.remove_at(matches[0])
}

/// Releases a retained provisional or finalized receipt after terminal failure or cancellation.
/// Returns whether a matching receipt was present; successful proof delivery should use consume.
pub fn discard_host_verified_compute_receipt(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
) -> Result<bool, String> {
    let discarded = receipt_store()
        .lock()
        .expect("host output oracle receipt lock")
        .discard_matching(request_id, source_edit_id, artifact_content_hash)?;
    Ok(discarded != 0)
}

impl HostVerifiedComputeReadbackReceipt {
    pub fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn source_edit_id(&self) -> &str {
        &self.source_edit_id
    }

    pub fn runtime_session_id(&self) -> &str {
        &self.runtime_session_id
    }

    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    pub fn artifact_content_hash(&self) -> &str {
        &self.artifact_content_hash
    }

    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn dispatcher_registration_id(&self) -> &str {
        &self.dispatcher_registration_id
    }

    pub fn dispatch_table_hash(&self) -> &str {
        &self.dispatch_table_hash
    }

    pub fn dispatch_table_entry_id(&self) -> &str {
        &self.dispatch_table_entry_id
    }

    pub fn dispatch_id(&self) -> &str {
        &self.dispatch_id
    }

    pub fn dispatch_timestamp_monotonic_ns(&self) -> u128 {
        self.dispatch_timestamp_monotonic_ns
    }

    pub fn readback_timestamp_monotonic_ns(&self) -> u128 {
        self.readback_timestamp_monotonic_ns
    }

    pub fn stream_token(&self) -> usize {
        self.stream_token
    }

    pub fn publication_id(&self) -> Option<&str> {
        self.publication_id.as_deref()
    }

    pub fn previous_generation(&self) -> Option<u64> {
        self.previous_generation
    }

    pub fn publication_timestamp_monotonic_ns(&self) -> Option<u128> {
        self.publication_timestamp_monotonic_ns
    }

    pub fn publication_committed_timestamp_monotonic_ns(&self) -> Option<u128> {
        self.publication_committed_timestamp_monotonic_ns
    }

    pub fn profile_schema_version(&self) -> &str {
        &self.profile_schema_version
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_bytes_sha256(&self) -> &str {
        &self.profile_bytes_sha256
    }

    pub fn contract_sha256(&self) -> &str {
        &self.contract_sha256
    }

    pub fn proof_runtime_session_id(&self) -> &str {
        &self.proof_runtime_session_id
    }

    pub fn compute_expected_output_contract_v2(&self) -> &ComputeExpectedOutputContractV2 {
        &self.compute_expected_output_contract_v2
    }

    pub fn compute_expected_output_contract_hash(&self) -> &str {
        &self.compute_expected_output_contract_hash
    }

    pub fn compute_expected_output_semantics_hash(&self) -> &str {
        &self.compute_expected_output_semantics_hash
    }

    pub fn proof_context_binding_sha256(&self) -> Option<&str> {
        self.proof_context_binding_sha256.as_deref()
    }

    pub fn proof_context_proof_id(&self) -> Option<&str> {
        self.proof_context_proof_id.as_deref()
    }

    pub fn oracle_id(&self) -> &str {
        &self.oracle_id
    }

    pub fn producer(&self) -> &str {
        &self.producer
    }

    pub fn output_target_id(&self) -> &str {
        &self.output_target_id
    }

    pub fn output_buffer_name(&self) -> &str {
        &self.output_buffer_name
    }

    pub fn baseline_sha256(&self) -> &str {
        &self.baseline_sha256
    }

    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }

    pub fn observed_sha256(&self) -> &str {
        &self.observed_sha256
    }

    pub fn probe_mode(&self) -> &str {
        &self.probe_mode
    }

    pub fn probe_config_hash(&self) -> &str {
        &self.probe_config_hash
    }

    pub fn probe_evidence_ref(&self) -> &str {
        &self.probe_evidence_ref
    }

    pub fn readback_bytes(&self) -> &[u8] {
        &self.readback_bytes
    }

    pub fn readback_bytes_arc(&self) -> Arc<[u8]> {
        Arc::clone(&self.readback_bytes)
    }

    pub fn readback_schema_sha256(&self) -> &str {
        &self.readback_schema_sha256
    }

    pub fn recompute_readback_schema_sha256(&self) -> String {
        let material = ReadbackSchemaMaterial {
            schema_version: HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
            element_type: &self.element_type,
            element_count: self.element_count,
            element_byte_width: self.element_byte_width,
            endianness: &self.endianness,
            byte_length: self.readback_bytes.len(),
        };
        format!(
            "sha256:{}",
            sha256_hex_bytes(
                &serde_json::to_vec(&material)
                    .expect("host output oracle schema remains serializable")
            )
        )
    }

    pub fn readback_schema_json(&self) -> Value {
        json!({
            "schemaVersion": HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
            "elementType": self.element_type,
            "elementCount": self.element_count,
            "elementByteWidth": self.element_byte_width,
            "endianness": self.endianness,
            "byteLength": self.readback_bytes.len(),
        })
    }

    pub fn deterministic_slice_offset(&self) -> usize {
        self.deterministic_slice_offset
    }

    pub fn deterministic_slice_length(&self) -> usize {
        self.deterministic_slice_length
    }

    pub fn deterministic_slice_stride(&self) -> usize {
        self.deterministic_slice_stride
    }

    pub fn deterministic_slice_sha256(&self) -> &str {
        &self.deterministic_slice_sha256
    }

    pub fn recompute_full_readback_sha256(&self) -> String {
        format!("sha256:{}", sha256_hex_bytes(&self.readback_bytes))
    }

    pub fn recompute_deterministic_slice_sha256(&self) -> String {
        let end = self
            .deterministic_slice_offset
            .saturating_add(self.deterministic_slice_length);
        format!(
            "sha256:{}",
            sha256_hex_bytes(&self.readback_bytes[self.deterministic_slice_offset..end])
        )
    }
}

#[cfg(test)]
pub(super) fn reset_host_output_oracle_receipts_for_test() {
    ACTIVE_REQUEST_BINDING.with(|slot| {
        slot.replace(None);
    });
    let mut store = receipt_store()
        .lock()
        .expect("host output oracle receipt lock");
    store
        .clear()
        .expect("host output oracle receipt accounting reset");
    store.limits = ReceiptRetentionLimits::compile_time_maxima();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::adapter_trait::{
        bind_reload_output_oracle_proof_context, ReloadOutputOracleProfileCommitment,
    };
    use crate::infra::compute_expected_output_semantics::{
        ComputeExpectedOutputContractBindingV2, ComputeExpectedOutputSemantics,
        COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
    };
    use crate::runtime::gpu_runtime_boundary::dispatcher_commit_receipt_for_test;

    fn receipt_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        GUARD
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("host output oracle receipt test guard")
    }

    fn configure_retention_limits_for_test(
        max_receipt_count: usize,
        max_readback_bytes: usize,
    ) -> Result<(), String> {
        let limits = ReceiptRetentionLimits::new(max_receipt_count, max_readback_bytes)?;
        let mut store = receipt_store()
            .lock()
            .expect("host output oracle receipt lock");
        store.validate_accounting()?;
        if store.retained_receipt_count != 0 {
            return Err(
                "host output oracle test retention limits require an empty store".to_string(),
            );
        }
        store.limits = limits;
        Ok(())
    }

    fn retained_accounting_for_test() -> (usize, usize) {
        let store = receipt_store()
            .lock()
            .expect("host output oracle receipt lock");
        store
            .validate_accounting()
            .expect("host output oracle receipt accounting");
        (store.retained_receipt_count, store.retained_readback_bytes)
    }

    fn expected_output_contract_for_test(
        source_edit_id: &str,
        artifact_content_hash: &str,
        expected_sha256: &str,
        byte_length: usize,
        project_id: &str,
    ) -> ComputeExpectedOutputContractV2 {
        let output_target_id = "buffer:0";
        let oracle_code_hash = format!("sha256:{}", "c".repeat(64));
        let semantic_material = json!([
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "exact_bytes",
            output_target_id,
            "0",
            byte_length.to_string(),
            "u8",
            [byte_length.to_string()],
            byte_length.to_string(),
            "not_applicable",
            "0",
            null,
            null,
            expected_sha256,
        ]);
        let mut hash_material =
            b"synthi.gpu_hmr.compute_expected_output_semantics_hash.v1\0".to_vec();
        hash_material.extend(
            serde_json::to_vec(&semantic_material).expect("serialize expected-output semantics"),
        );
        let semantics_hash = format!("sha256:{}", sha256_hex_bytes(&hash_material));
        let semantics: ComputeExpectedOutputSemantics = serde_json::from_value(json!({
            "schemaVersion": COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
            "comparisonMode": "exact_bytes",
            "outputTargetId": output_target_id,
            "byteOffset": 0,
            "byteLength": byte_length,
            "dtype": "u8",
            "shape": [byte_length],
            "elementCount": byte_length,
            "byteOrder": "not_applicable",
            "toleranceDecimal": "0",
            "expectedValuesDecimal": null,
            "expectedValuesHash": null,
            "expectedRawHash": expected_sha256,
            "semanticsHash": semantics_hash,
        }))
        .expect("canonical expected-output semantics");
        semantics
            .derive_contract_v2(ComputeExpectedOutputContractBindingV2 {
                project_id: project_id.to_string(),
                edit_id: source_edit_id.to_string(),
                artifact_after_hash: artifact_content_hash.to_string(),
                output_target_id: output_target_id.to_string(),
                oracle_code_hash,
                compile_transport_nonce:
                    "gpu-proof-transport-request:0123456789abcdef0123456789abcdef".to_string(),
                runtime_session_id: "runtime-session:test-proof".to_string(),
            })
            .expect("derive expected-output contract")
    }

    fn fixture(
        request_id: &str,
        bytes: &[u8],
    ) -> (
        HostOutputOracleRequestBinding,
        GpuLaunchReceipt,
        ReloadCapsuleMetadata,
    ) {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let artifact_content_hash = format!("sha256:{}", "b".repeat(64));
        let expected = format!("sha256:{}", sha256_hex_bytes(bytes));
        let baseline = format!("sha256:{}", sha256_hex_bytes(&vec![0u8; bytes.len()]));
        let contract = json!({
            "kind": "compute_readback",
            "oracleId": "oracle:generic-compute",
            "expected": expected,
            "baselineSha256": baseline,
            "expectedOutputChange": true,
            "producer": "worker.host-dtoh",
            "outputTargetId": "buffer:0",
            "probeMode": "deterministic_readback",
            "probeConfigHash": format!("sha256:{}", "c".repeat(64)),
        });
        let contract_hash = reload_output_oracle_contract_content_hash(&contract).unwrap();
        let expected_output_contract = expected_output_contract_for_test(
            &source_edit_id,
            &artifact_content_hash,
            &expected,
            bytes.len(),
            "workspace:receipt-fixture",
        );
        let mut metadata = ReloadCapsuleMetadata {
            fission_output_oracle_contract: Some(contract),
            compute_expected_output_contract_v2: Some(expected_output_contract),
            output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.to_string(),
                candidate_artifact_sha256: artifact_content_hash.clone(),
                fission_output_oracle_contract_sha256: contract_hash,
                profile_bytes_sha256: format!("sha256:{}", "d".repeat(64)),
                edit_id: source_edit_id.clone(),
            }),
            proof_hash: Some(format!("sha256:{}", "e".repeat(64))),
            ..ReloadCapsuleMetadata::default()
        };
        assert!(bind_reload_output_oracle_proof_context(
            &mut metadata,
            &format!("gpu-proof:{}", "e".repeat(64)),
            "2026-07-19T00:00:00Z",
            "runtime-session:test-proof",
        ));
        let binding = HostOutputOracleRequestBinding::from_reload_request(
            request_id,
            &source_edit_id,
            &artifact_content_hash,
            &metadata,
        )
        .unwrap();
        let dispatch_timestamp_monotonic_ns = monotonic_timestamp_ns();
        let launch = GpuLaunchReceipt {
            dispatched: true,
            dispatch_id: format!("dispatch:sha256:{}", "1".repeat(64)),
            active_generation: 7,
            runtime_session_id: runtime_session_id().to_string(),
            stream_token: 3,
            dispatch_timestamp_monotonic_ns,
            dispatch_slot: Some(GpuDispatchSlotBinding {
                runtime_session_id: runtime_session_id().to_string(),
                generation: 7,
                dispatcher_registration_id: format!("dispatcher:sha256:{}", "2".repeat(64)),
                artifact_id: binding.artifact_id.clone(),
                artifact_content_hash: binding.artifact_content_hash.clone(),
                dispatch_table_hash: format!("sha256:{}", "3".repeat(64)),
                dispatch_table_entry_id: "kernel:0x1000".to_string(),
            }),
            dispatch_device_attestation: None,
        };
        (binding, launch, metadata)
    }

    fn record_active_fixture(
        binding: &HostOutputOracleRequestBinding,
        launch: &GpuLaunchReceipt,
        bytes: &[u8],
    ) -> Result<HostVerifiedComputeReadbackReceipt, String> {
        record_host_verified_compute_readback(
            launch,
            "synthi.gpu_hmr.runtime_output_oracle_profile.v1",
            "profile:generic-compute",
            &binding.oracle_id,
            &binding.producer,
            &binding.output_target_id,
            "output",
            "u8",
            bytes.len(),
            1,
            "not_applicable",
            &binding.baseline_sha256,
            &binding.expected_sha256,
            &binding.probe_mode,
            &binding.probe_config_hash,
            "evidence:host-dtoh",
            bytes,
        )
    }

    fn record_fixture(
        binding: &HostOutputOracleRequestBinding,
        launch: &GpuLaunchReceipt,
        bytes: &[u8],
    ) -> Result<HostVerifiedComputeReadbackReceipt, String> {
        with_host_output_oracle_request_binding(binding, || {
            record_active_fixture(binding, launch, bytes)
        })?
    }

    fn finalize_fixture(
        binding: &HostOutputOracleRequestBinding,
        provisional: &HostVerifiedComputeReadbackReceipt,
    ) -> Result<HostVerifiedComputeReadbackReceipt, String> {
        let commit = dispatcher_commit_receipt_for_test(
            format!("dispatcher-publication:sha256:{}", "4".repeat(64)),
            provisional.generation().saturating_sub(1),
            provisional.generation(),
            provisional.dispatcher_registration_id().to_string(),
            provisional
                .dispatch_timestamp_monotonic_ns()
                .saturating_sub(1),
            provisional
                .readback_timestamp_monotonic_ns()
                .saturating_add(1),
        );
        finalize_host_verified_compute_readback(binding, &commit)
    }

    #[test]
    fn retention_accepts_the_exact_readback_byte_limit() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        configure_retention_limits_for_test(2, 16).unwrap();
        let bytes = (1u8..=16).collect::<Vec<_>>();
        let (binding, launch, _) = fixture("request-exact-byte-limit", &bytes);

        record_fixture(&binding, &launch, &bytes).unwrap();
        assert_eq!(retained_accounting_for_test(), (1, bytes.len()));
        assert!(discard_host_verified_compute_receipt(
            &binding.request_id,
            &binding.source_edit_id,
            &binding.artifact_content_hash,
        )
        .unwrap());
        assert_eq!(retained_accounting_for_test(), (0, 0));
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn retention_rejects_the_readback_byte_limit_plus_one() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        configure_retention_limits_for_test(2, 16).unwrap();
        let bytes = vec![7u8; 17];
        let (binding, launch, _) = fixture("request-byte-limit-plus-one", &bytes);

        assert!(record_fixture(&binding, &launch, &bytes)
            .unwrap_err()
            .contains("readback byte capacity exceeded"));
        assert_eq!(retained_accounting_for_test(), (0, 0));
        assert!(!discard_host_verified_compute_receipt(
            &binding.request_id,
            &binding.source_edit_id,
            &binding.artifact_content_hash,
        )
        .unwrap());
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn pinned_provisional_and_finalized_receipts_are_not_evicted() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        configure_retention_limits_for_test(1, 64).unwrap();
        let first_bytes = vec![11u8; 8];
        let second_bytes = vec![12u8; 8];
        let (first_binding, first_launch, _) = fixture("request-pinned-first", &first_bytes);
        let (second_binding, second_launch, _) = fixture("request-pinned-second", &second_bytes);
        let provisional = record_fixture(&first_binding, &first_launch, &first_bytes).unwrap();

        assert!(
            record_fixture(&second_binding, &second_launch, &second_bytes)
                .unwrap_err()
                .contains("receipt count capacity exceeded")
        );
        assert_eq!(retained_accounting_for_test(), (1, first_bytes.len()));
        let finalized = finalize_fixture(&first_binding, &provisional).unwrap();

        assert!(
            record_fixture(&second_binding, &second_launch, &second_bytes)
                .unwrap_err()
                .contains("receipt count capacity exceeded")
        );
        let retained = host_verified_compute_receipt_for_proof(
            &first_binding.request_id,
            &first_binding.source_edit_id,
            &first_binding.artifact_content_hash,
            finalized.dispatch_id(),
        )
        .unwrap();
        assert_eq!(retained.receipt_id(), finalized.receipt_id());
        assert_eq!(retained_accounting_for_test(), (1, first_bytes.len()));
        consume_host_verified_compute_receipt(
            &first_binding.request_id,
            &first_binding.source_edit_id,
            &first_binding.artifact_content_hash,
        )
        .unwrap();
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn consume_and_discard_release_exact_accounting() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        configure_retention_limits_for_test(1, 8).unwrap();
        let bytes = vec![13u8; 8];
        let (consumed_binding, consumed_launch, _) = fixture("request-consume", &bytes);
        let provisional = record_fixture(&consumed_binding, &consumed_launch, &bytes).unwrap();
        finalize_fixture(&consumed_binding, &provisional).unwrap();

        consume_host_verified_compute_receipt(
            &consumed_binding.request_id,
            &consumed_binding.source_edit_id,
            &consumed_binding.artifact_content_hash,
        )
        .unwrap();
        assert_eq!(retained_accounting_for_test(), (0, 0));

        let (discarded_binding, discarded_launch, _) = fixture("request-discard", &bytes);
        record_fixture(&discarded_binding, &discarded_launch, &bytes).unwrap();
        assert_eq!(retained_accounting_for_test(), (1, bytes.len()));
        assert!(discard_host_verified_compute_receipt(
            &discarded_binding.request_id,
            &discarded_binding.source_edit_id,
            &discarded_binding.artifact_content_hash,
        )
        .unwrap());
        assert_eq!(retained_accounting_for_test(), (0, 0));

        let (reused_binding, reused_launch, _) = fixture("request-reused-capacity", &bytes);
        record_fixture(&reused_binding, &reused_launch, &bytes).unwrap();
        assert_eq!(retained_accounting_for_test(), (1, bytes.len()));
        with_host_output_oracle_request_binding(&reused_binding, || {
            assert_eq!(retained_accounting_for_test(), (0, 0));
        })
        .unwrap();
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn duplicate_rejection_does_not_change_accounting() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        configure_retention_limits_for_test(2, 32).unwrap();
        let bytes = vec![14u8; 8];
        let (binding, launch, _) = fixture("request-duplicate", &bytes);

        with_host_output_oracle_request_binding(&binding, || {
            record_active_fixture(&binding, &launch, &bytes).unwrap();
            let before_duplicate = retained_accounting_for_test();
            assert!(record_active_fixture(&binding, &launch, &bytes)
                .unwrap_err()
                .contains("more than one receipt"));
            assert_eq!(retained_accounting_for_test(), before_duplicate);
        })
        .unwrap();
        assert_eq!(retained_accounting_for_test(), (1, bytes.len()));
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn accounting_detects_overflow_and_inconsistent_counters() {
        assert!(checked_retention_after_insert(usize::MAX, 0, 1)
            .unwrap_err()
            .contains("receipt count overflow"));
        assert!(checked_retention_after_insert(0, usize::MAX, 1)
            .unwrap_err()
            .contains("byte accounting overflow"));

        let limits = ReceiptRetentionLimits::new(1, 1).unwrap();
        let inconsistent_count = VerifiedReceiptStore {
            receipts: VecDeque::new(),
            retained_receipt_count: 1,
            retained_readback_bytes: 0,
            limits,
        };
        assert!(inconsistent_count
            .validate_accounting()
            .unwrap_err()
            .contains("count accounting mismatch"));
        let inconsistent_bytes = VerifiedReceiptStore {
            receipts: VecDeque::new(),
            retained_receipt_count: 0,
            retained_readback_bytes: 1,
            limits,
        };
        assert!(inconsistent_bytes
            .validate_accounting()
            .unwrap_err()
            .contains("byte accounting mismatch"));

        assert!(ReceiptRetentionLimits::new(0, 1).is_err());
        assert!(ReceiptRetentionLimits::new(1, 0).is_err());
        assert!(ReceiptRetentionLimits::new(MAX_RETAINED_RECEIPT_COUNT + 1, 1).is_err());
        assert!(ReceiptRetentionLimits::new(1, MAX_RETAINED_READBACK_BYTES + 1).is_err());
    }

    #[test]
    fn receipt_binds_full_bytes_and_is_consumed_once() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        let bytes = (0..5000)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let (binding, launch, metadata) = fixture("request-full-bytes", &bytes);
        let provisional = record_fixture(&binding, &launch, &bytes).unwrap();
        assert!(consume_host_verified_compute_receipt(
            binding.request_id.as_str(),
            binding.source_edit_id.as_str(),
            binding.artifact_content_hash.as_str(),
        )
        .unwrap_err()
        .contains("not publication-finalized"));
        let receipt = finalize_fixture(&binding, &provisional).unwrap();
        assert_eq!(receipt.readback_bytes(), bytes);
        assert_eq!(
            receipt.recompute_full_readback_sha256(),
            receipt.observed_sha256()
        );
        assert_eq!(
            receipt.recompute_deterministic_slice_sha256(),
            receipt.deterministic_slice_sha256()
        );
        assert_eq!(receipt.deterministic_slice_length(), 4096);
        assert_ne!(
            receipt.observed_sha256(),
            receipt.deterministic_slice_sha256()
        );
        assert!(receipt
            .publication_id()
            .is_some_and(|value| value.starts_with("dispatcher-publication:sha256:")));
        assert_eq!(receipt.previous_generation(), Some(6));
        assert_eq!(receipt.dispatch_table_entry_id(), "kernel:0x1000");
        let expected_output_contract = metadata
            .compute_expected_output_contract_v2
            .as_ref()
            .expect("fixture expected-output contract");
        assert_eq!(
            receipt.compute_expected_output_contract_v2(),
            expected_output_contract
        );
        assert_eq!(
            receipt.compute_expected_output_contract_hash(),
            expected_output_contract.contract_hash()
        );
        assert_eq!(
            receipt.compute_expected_output_semantics_hash(),
            expected_output_contract.semantics().semantics_hash()
        );
        assert_eq!(
            receipt.proof_runtime_session_id(),
            "runtime-session:test-proof"
        );

        let consumed = consume_host_verified_compute_receipt(
            binding.request_id.as_str(),
            binding.source_edit_id.as_str(),
            binding.artifact_content_hash.as_str(),
        )
        .unwrap();
        assert_eq!(consumed.receipt_id(), receipt.receipt_id());
        assert!(consume_host_verified_compute_receipt(
            binding.request_id.as_str(),
            binding.source_edit_id.as_str(),
            binding.artifact_content_hash.as_str(),
        )
        .is_err());
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn receipt_rejects_expected_output_byte_selection_not_executed_by_readback() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        let bytes = vec![21u8; 64];
        let (_, launch, mut metadata) = fixture("request-byte-selection", &bytes);
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let artifact_content_hash = format!("sha256:{}", "b".repeat(64));
        let expected_sha256 = format!("sha256:{}", sha256_hex_bytes(&bytes));
        metadata.compute_expected_output_contract_v2 = Some(expected_output_contract_for_test(
            &source_edit_id,
            &artifact_content_hash,
            &expected_sha256,
            bytes.len() - 1,
            "workspace:receipt-fixture",
        ));
        metadata.output_oracle_proof_context = None;
        assert!(bind_reload_output_oracle_proof_context(
            &mut metadata,
            &format!("gpu-proof:{}", "e".repeat(64)),
            "2026-07-19T00:00:00Z",
            "runtime-session:test-proof",
        ));
        let binding = HostOutputOracleRequestBinding::from_reload_request(
            "request-byte-selection",
            &source_edit_id,
            &artifact_content_hash,
            &metadata,
        )
        .expect("byte selection is retained until concrete readback shape is known");

        let error = record_fixture(&binding, &launch, &bytes).unwrap_err();
        assert!(
            error.contains("does not match the caller-derived expected-output byte selection"),
            "unexpected refusal: {error}"
        );
        assert_eq!(retained_accounting_for_test(), (0, 0));
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn receipt_rejects_forged_or_stale_readback_context() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        let bytes = vec![9u8; 128];
        let (binding, launch, _) = fixture("request-refusal", &bytes);

        let mut stale_launch = launch.clone();
        stale_launch.runtime_session_id = "runtime-session:stale".to_string();
        assert!(record_fixture(&binding, &stale_launch, &bytes)
            .unwrap_err()
            .contains("runtime session mismatch"));

        let mut forged = bytes.clone();
        forged[17] ^= 1;
        assert!(record_fixture(&binding, &launch, &forged)
            .unwrap_err()
            .contains("full readback checksum mismatch"));

        let schema_error = with_host_output_oracle_request_binding(&binding, || {
            record_host_verified_compute_readback(
                &launch,
                "synthi.gpu_hmr.runtime_output_oracle_profile.v1",
                "profile:generic-compute",
                &binding.oracle_id,
                &binding.producer,
                &binding.output_target_id,
                "output",
                "u32",
                bytes.len(),
                4,
                "little",
                &binding.baseline_sha256,
                &binding.expected_sha256,
                &binding.probe_mode,
                &binding.probe_config_hash,
                "evidence:host-dtoh",
                &bytes,
            )
        })
        .unwrap()
        .unwrap_err();
        assert!(schema_error.contains("schema mismatch"));
        reset_host_output_oracle_receipts_for_test();
    }

    #[test]
    fn provisional_receipt_requires_the_exact_opaque_publication_commit() {
        let _guard = receipt_test_guard();
        reset_host_output_oracle_receipts_for_test();
        let bytes = vec![7u8; 256];
        let (binding, launch, _) = fixture("request-publication", &bytes);
        let provisional = record_fixture(&binding, &launch, &bytes).unwrap();
        let forged_commit = dispatcher_commit_receipt_for_test(
            format!("dispatcher-publication:sha256:{}", "5".repeat(64)),
            6,
            7,
            format!("dispatcher:sha256:{}", "6".repeat(64)),
            provisional
                .dispatch_timestamp_monotonic_ns()
                .saturating_sub(1),
            provisional
                .readback_timestamp_monotonic_ns()
                .saturating_add(1),
        );
        assert!(
            finalize_host_verified_compute_readback(&binding, &forged_commit,)
                .unwrap_err()
                .contains("publication receipt mismatch")
        );
        assert!(consume_host_verified_compute_receipt(
            binding.request_id.as_str(),
            binding.source_edit_id.as_str(),
            binding.artifact_content_hash.as_str(),
        )
        .unwrap_err()
        .contains("not publication-finalized"));

        let finalized = finalize_fixture(&binding, &provisional).unwrap();
        assert!(!finalized.receipt_id().is_empty());
        assert!(finalize_fixture(&binding, &provisional)
            .unwrap_err()
            .contains("already finalized"));
        reset_host_output_oracle_receipts_for_test();
    }
}
