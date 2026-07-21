use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::de::{self, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::{self, Write};

pub const RUNNER_PROTOCOL_ACK_SCHEMA_VERSION: &str = "synthi.runner.protocol_ack.v3";
pub const RUNNER_PROTOCOL_ACK_RESOURCE_POLICY_SCHEMA_VERSION: &str =
    "synthi.runner.protocol_ack.v4";
pub const RUNNER_RESOURCE_POLICY_V1_SCHEMA_VERSION: &str = "synthi.runner.resource_policy.v1";
pub const GPU_RELOAD_V4_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload.v4";
pub const GPU_RELOAD_V4_RESULT_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload_result.v4";
pub const GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION: &str =
    "synthi.runner.gpu_runtime_proof_material.v1";
pub const GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION: &str =
    "synthi.runner.gpu_artifact_load_result.v1";
pub const GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY: &str =
    "gpu_reload.independent_edit_identity.v1";
pub const GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY: &str = "gpu_reload.artifact_content_hash.v1";
pub const GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY: &str =
    "gpu_load.correlated_terminal.v1";
pub const GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY: &str =
    "gpu_reload.challenge_bound_envelope.v1";
pub const GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY: &str = "gpu_reload.bound_proof_material.v1";
pub const RUNNER_BOUNDED_INGRESS_V1_CAPABILITY: &str = "runner.bounded_ingress.v1";
pub const RUNNER_ATOMIC_BATCH_V1_CAPABILITY: &str = "runner.atomic_batch.v1";
pub const RUNNER_PROTOCOL_ACK_PREFIX: &str = "[synthi-runner-protocol-ack] ";
pub const RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION: &str = "synthi.runner.runtime_control_ack.v1";
pub const RUNNER_RUNTIME_CONTROL_ACK_PREFIX: &str = "[synthi-runner-runtime-control-ack] ";
pub const RUNNER_RUNTIME_CONTROL_SESSION_ENV: &str = "SYNTHI_RUNNER_RUNTIME_CONTROL_SESSION_ID";
pub const RUNNER_CAPABILITY_OBSERVATION_SCHEMA_VERSION: &str =
    "synthi.runner.capability_observation.v1";
pub const RUNNER_CAPABILITY_OBSERVATION_AUTHORITY: &str =
    "runner_observed_mechanism_capability_only_not_hmr_acceptance";
pub const RUNNER_CAPABILITY_OBSERVATION_PREFIX: &str = "[synthi-runner-capability-observation] ";
pub const RUNNER_CONTENT_BOUND_MODULE_LOAD_CAPABILITY: &str = "runner.content_bound_module_load.v1";
pub const RUNNER_MODULE_LOAD_RESULT_SCHEMA_VERSION: &str = "synthi.runner.module_load_result.v1";
pub const RUNNER_MODULE_LOAD_RESULT_AUTHORITY: &str =
    "runner_observed_content_bound_module_load_only_not_hmr_acceptance";
pub const RUNNER_MODULE_LOAD_RESULT_PREFIX: &str = "[synthi-runner-module-load-result] ";
pub const RUNNER_PROTOCOL_CURRENT_VERSION: u32 = 5;
pub const RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION: u32 = 1;
pub const RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES: usize = 1280;
pub const RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES: usize = 16;
pub const RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES: usize = 64;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES: u64 = 32 * 1024 * 1024;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS: u64 = 256;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES: u64 = 128 * 1024 * 1024;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS: u64 = 16;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES: u64 = 64 * 1024 * 1024;
pub const RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK: u64 = 64;

const RUNNER_PROTOCOL_ACK_MAX_SCHEMA_VERSION_BYTES: usize = 64;
const RUNNER_PROTOCOL_ACK_MAX_NONCE_BYTES: usize = 128;
const RUNNER_PROTOCOL_ACK_MAX_RUNTIME_SESSION_BYTES: usize = 128;
const RUNNER_PROTOCOL_ACK_CHALLENGE_BYTES: usize = 32;
const STRICT_GPU_RELOAD_CAPABILITIES: [&str; 5] = [
    GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
    GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY,
    GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
    GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
    GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
];

const _: () = {
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES > 0);
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS > 0);
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES > 0);
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS > 0);
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES > 0);
    assert!(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK > 0);
    assert!(
        RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES
            <= RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES
    );
    assert!(
        RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES
            <= RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES
    );
    assert!(
        RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS
            <= RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK
    );
    assert!(
        RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK
            <= RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS
    );
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerResourcePolicyV1 {
    pub schema_version: String,
    pub max_command_bytes: u64,
    pub max_queue_items: u64,
    pub max_queue_retained_bytes: u64,
    pub max_atomic_batch_items: u64,
    pub max_atomic_batch_bytes: u64,
    pub max_commands_per_tick: u64,
}

impl RunnerResourcePolicyV1 {
    pub fn at_consumer_maxima() -> Self {
        Self {
            schema_version: RUNNER_RESOURCE_POLICY_V1_SCHEMA_VERSION.to_string(),
            max_command_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES,
            max_queue_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS,
            max_queue_retained_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES,
            max_atomic_batch_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS,
            max_atomic_batch_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES,
            max_commands_per_tick: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != RUNNER_RESOURCE_POLICY_V1_SCHEMA_VERSION {
            return Err("runner resource policy schema is unsupported");
        }
        if [
            self.max_command_bytes,
            self.max_queue_items,
            self.max_queue_retained_bytes,
            self.max_atomic_batch_items,
            self.max_atomic_batch_bytes,
            self.max_commands_per_tick,
        ]
        .contains(&0)
        {
            return Err("runner resource policy limits must be nonzero");
        }
        if self.max_command_bytes > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES
            || self.max_queue_items > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS
            || self.max_queue_retained_bytes
                > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES
            || self.max_atomic_batch_items
                > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS
            || self.max_atomic_batch_bytes
                > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES
            || self.max_commands_per_tick > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK
        {
            return Err("runner resource policy exceeds consumer maxima");
        }
        if self.max_command_bytes > self.max_atomic_batch_bytes
            || self.max_atomic_batch_bytes > self.max_queue_retained_bytes
        {
            return Err("runner resource policy byte limits are inconsistent");
        }
        if self.max_atomic_batch_items > self.max_commands_per_tick
            || self.max_commands_per_tick > self.max_queue_items
        {
            return Err("runner resource policy item limits are inconsistent");
        }
        Ok(())
    }
}

struct BoundedRunnerCapability(String);

impl<'de> Deserialize<'de> for BoundedRunnerCapability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct CapabilityVisitor;

        impl<'de> Visitor<'de> for CapabilityVisitor {
            type Value = BoundedRunnerCapability;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a bounded runner capability string")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value.len() > RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES {
                    return Err(E::custom("runner capability exceeds the byte limit"));
                }
                Ok(BoundedRunnerCapability(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value.len() > RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES {
                    return Err(E::custom("runner capability exceeds the byte limit"));
                }
                Ok(BoundedRunnerCapability(value))
            }
        }

        deserializer.deserialize_str(CapabilityVisitor)
    }
}

fn deserialize_runner_capabilities<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct CapabilitiesVisitor;

    impl<'de> Visitor<'de> for CapabilitiesVisitor {
        type Value = Vec<String>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded runner capability list")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut capabilities = Vec::with_capacity(
                sequence
                    .size_hint()
                    .unwrap_or(0)
                    .min(RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES),
            );
            while capabilities.len() < RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES {
                let Some(capability) = sequence.next_element::<BoundedRunnerCapability>()? else {
                    return Ok(capabilities);
                };
                capabilities.push(capability.0);
            }
            if sequence.next_element::<IgnoredAny>()?.is_some() {
                return Err(de::Error::custom(
                    "runner capability count exceeds the limit",
                ));
            }
            Ok(capabilities)
        }
    }

    deserializer.deserialize_seq(CapabilitiesVisitor)
}

struct RunnerProtocolAckByteLimit {
    remaining: usize,
}

impl Write for RunnerProtocolAckByteLimit {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runner protocol ACK exceeds the encoded-byte limit",
            ));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn runner_protocol_ack_encoded_bytes_within_limit(ack: &impl Serialize) -> bool {
    serde_json::to_writer(
        RunnerProtocolAckByteLimit {
            remaining: RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES,
        },
        ack,
    )
    .is_ok()
}

fn runner_protocol_ack_size_error() -> serde_json::Error {
    serde_json::Error::io(io::Error::new(
        io::ErrorKind::InvalidData,
        "runner protocol ACK exceeds an encoding limit",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerProtocolAck {
    pub schema_version: String,
    pub nonce: String,
    pub current_version: u32,
    pub min_supported_version: u32,
    pub runner_pid: u32,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    #[serde(deserialize_with = "deserialize_runner_capabilities")]
    pub capabilities: Vec<String>,
}

impl RunnerProtocolAck {
    pub fn current(
        nonce: impl Into<String>,
        runner_runtime_session_id: impl Into<String>,
        runner_challenge: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: RUNNER_PROTOCOL_ACK_SCHEMA_VERSION.to_string(),
            nonce: nonce.into(),
            current_version: RUNNER_PROTOCOL_CURRENT_VERSION,
            min_supported_version: RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
            runner_pid: std::process::id(),
            runner_runtime_session_id: runner_runtime_session_id.into(),
            runner_challenge: runner_challenge.into(),
            capabilities: vec![
                GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY.to_string(),
                GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY.to_string(),
                GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY.to_string(),
                GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY.to_string(),
                GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY.to_string(),
            ],
        }
    }

    pub fn line(&self) -> Result<String, serde_json::Error> {
        if !self.encoding_fields_within_limits()
            || !runner_protocol_ack_encoded_bytes_within_limit(self)
        {
            return Err(runner_protocol_ack_size_error());
        }
        serde_json::to_string(self).map(|json| format!("{RUNNER_PROTOCOL_ACK_PREFIX}{json}"))
    }

    pub fn supports_strict_gpu_reload(&self, nonce: &str, expected_pid: u32) -> bool {
        self.schema_version == RUNNER_PROTOCOL_ACK_SCHEMA_VERSION
            && !claims_runner_resource_policy_capabilities(&self.capabilities)
            && supports_strict_gpu_reload_common(
                &self.nonce,
                self.current_version,
                self.min_supported_version,
                self.runner_pid,
                &self.runner_runtime_session_id,
                &self.runner_challenge,
                &self.capabilities,
                nonce,
                expected_pid,
            )
            && runner_protocol_ack_encoded_bytes_within_limit(self)
    }

    fn encoding_fields_within_limits(&self) -> bool {
        self.schema_version.len() <= RUNNER_PROTOCOL_ACK_MAX_SCHEMA_VERSION_BYTES
            && self.nonce.len() <= RUNNER_PROTOCOL_ACK_MAX_NONCE_BYTES
            && self.runner_runtime_session_id.len() <= RUNNER_PROTOCOL_ACK_MAX_RUNTIME_SESSION_BYTES
            && self.runner_challenge.len() <= RUNNER_PROTOCOL_ACK_CHALLENGE_BYTES
            && self.capabilities.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES
            && self
                .capabilities
                .iter()
                .all(|capability| capability.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerProtocolAckV4 {
    pub schema_version: String,
    pub nonce: String,
    pub current_version: u32,
    pub min_supported_version: u32,
    pub runner_pid: u32,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    #[serde(deserialize_with = "deserialize_runner_capabilities")]
    pub capabilities: Vec<String>,
    pub resource_policy: RunnerResourcePolicyV1,
}

impl RunnerProtocolAckV4 {
    /// Only callers that enforce both advertised mechanisms should use this constructor.
    pub fn current_with_enforced_resource_policy(
        nonce: impl Into<String>,
        runner_runtime_session_id: impl Into<String>,
        runner_challenge: impl Into<String>,
        resource_policy: RunnerResourcePolicyV1,
    ) -> Result<Self, &'static str> {
        resource_policy.validate()?;
        Ok(Self {
            schema_version: RUNNER_PROTOCOL_ACK_RESOURCE_POLICY_SCHEMA_VERSION.to_string(),
            nonce: nonce.into(),
            current_version: RUNNER_PROTOCOL_CURRENT_VERSION,
            min_supported_version: RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
            runner_pid: std::process::id(),
            runner_runtime_session_id: runner_runtime_session_id.into(),
            runner_challenge: runner_challenge.into(),
            capabilities: vec![
                GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY.to_string(),
                GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY.to_string(),
                GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY.to_string(),
                GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY.to_string(),
                GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY.to_string(),
                RUNNER_BOUNDED_INGRESS_V1_CAPABILITY.to_string(),
                RUNNER_ATOMIC_BATCH_V1_CAPABILITY.to_string(),
            ],
            resource_policy,
        })
    }

    pub fn line(&self) -> Result<String, serde_json::Error> {
        if !self.encoding_fields_within_limits()
            || !runner_protocol_ack_encoded_bytes_within_limit(self)
        {
            return Err(runner_protocol_ack_size_error());
        }
        serde_json::to_string(self).map(|json| format!("{RUNNER_PROTOCOL_ACK_PREFIX}{json}"))
    }

    pub fn supports_strict_gpu_reload_with_resource_policy(
        &self,
        nonce: &str,
        expected_pid: u32,
    ) -> bool {
        self.schema_version == RUNNER_PROTOCOL_ACK_RESOURCE_POLICY_SCHEMA_VERSION
            && self.resource_policy.validate().is_ok()
            && self
                .capabilities
                .iter()
                .any(|capability| capability == RUNNER_BOUNDED_INGRESS_V1_CAPABILITY)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == RUNNER_ATOMIC_BATCH_V1_CAPABILITY)
            && supports_strict_gpu_reload_common(
                &self.nonce,
                self.current_version,
                self.min_supported_version,
                self.runner_pid,
                &self.runner_runtime_session_id,
                &self.runner_challenge,
                &self.capabilities,
                nonce,
                expected_pid,
            )
            && runner_protocol_ack_encoded_bytes_within_limit(self)
    }

    fn encoding_fields_within_limits(&self) -> bool {
        self.schema_version.len() <= RUNNER_PROTOCOL_ACK_MAX_SCHEMA_VERSION_BYTES
            && self.nonce.len() <= RUNNER_PROTOCOL_ACK_MAX_NONCE_BYTES
            && self.runner_runtime_session_id.len() <= RUNNER_PROTOCOL_ACK_MAX_RUNTIME_SESSION_BYTES
            && self.runner_challenge.len() <= RUNNER_PROTOCOL_ACK_CHALLENGE_BYTES
            && self.capabilities.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES
            && self
                .capabilities
                .iter()
                .all(|capability| capability.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES)
            && self.resource_policy.schema_version.len()
                <= RUNNER_PROTOCOL_ACK_MAX_SCHEMA_VERSION_BYTES
    }
}

pub fn parse_runner_protocol_ack(line: &str) -> Option<RunnerProtocolAck> {
    let json = line.strip_prefix(RUNNER_PROTOCOL_ACK_PREFIX)?;
    if json.len() > RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES {
        return None;
    }
    serde_json::from_str(json).ok()
}

pub fn parse_runner_protocol_ack_v4(line: &str) -> Option<RunnerProtocolAckV4> {
    let json = line.strip_prefix(RUNNER_PROTOCOL_ACK_PREFIX)?;
    if json.len() > RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES {
        return None;
    }
    serde_json::from_str(json).ok()
}

#[allow(clippy::too_many_arguments)]
fn supports_strict_gpu_reload_common(
    ack_nonce: &str,
    current_version: u32,
    min_supported_version: u32,
    runner_pid: u32,
    runner_runtime_session_id: &str,
    runner_challenge: &str,
    capabilities: &[String],
    expected_nonce: &str,
    expected_pid: u32,
) -> bool {
    canonical_runner_protocol_nonce(expected_nonce)
        && expected_pid != 0
        && ack_nonce == expected_nonce
        && current_version >= RUNNER_PROTOCOL_CURRENT_VERSION
        && min_supported_version > 0
        && min_supported_version <= current_version
        && min_supported_version <= RUNNER_PROTOCOL_CURRENT_VERSION
        && runner_pid == expected_pid
        && canonical_runner_protocol_nonce(ack_nonce)
        && canonical_runner_protocol_session_id(runner_runtime_session_id)
        && canonical_runner_challenge(runner_challenge)
        && valid_runner_capabilities(capabilities)
}

fn claims_runner_resource_policy_capabilities(capabilities: &[String]) -> bool {
    capabilities.iter().any(|capability| {
        capability == RUNNER_BOUNDED_INGRESS_V1_CAPABILITY
            || capability == RUNNER_ATOMIC_BATCH_V1_CAPABILITY
    })
}

fn canonical_runner_protocol_nonce(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= RUNNER_PROTOCOL_ACK_MAX_NONCE_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn canonical_runner_protocol_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= RUNNER_PROTOCOL_ACK_MAX_RUNTIME_SESSION_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn canonical_runner_capability(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn valid_runner_capabilities(capabilities: &[String]) -> bool {
    if capabilities.len() < STRICT_GPU_RELOAD_CAPABILITIES.len()
        || capabilities.len() > RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES
    {
        return false;
    }
    for (index, capability) in capabilities.iter().enumerate() {
        if !canonical_runner_capability(capability)
            || capabilities[..index]
                .iter()
                .any(|previous| previous == capability)
        {
            return false;
        }
    }
    STRICT_GPU_RELOAD_CAPABILITIES
        .iter()
        .all(|required| capabilities.iter().any(|capability| capability == required))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunnerRuntimeControlStatus {
    #[serde(rename = "runtime-paused")]
    Paused,
    #[serde(rename = "runtime-resumed")]
    Resumed,
}

impl RunnerRuntimeControlStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "runtime-paused",
            Self::Resumed => "runtime-resumed",
        }
    }

    fn expected_paused(self) -> bool {
        matches!(self, Self::Paused)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerRuntimeControlAck {
    pub schema_version: String,
    pub status: RunnerRuntimeControlStatus,
    pub runtime_control_token: String,
    pub runtime_paused: bool,
    pub gpu_reload_inflight_count: u64,
    pub runner_pid: u32,
    pub runner_control_session_id: String,
}

impl RunnerRuntimeControlAck {
    pub fn current(
        status: RunnerRuntimeControlStatus,
        runtime_control_token: impl Into<String>,
        runtime_paused: bool,
        gpu_reload_inflight_count: usize,
        runner_control_session_id: impl Into<String>,
    ) -> Result<Self, String> {
        let ack = Self {
            schema_version: RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION.to_string(),
            status,
            runtime_control_token: runtime_control_token.into(),
            runtime_paused,
            gpu_reload_inflight_count: u64::try_from(gpu_reload_inflight_count)
                .map_err(|_| "runner runtime-control inflight count exceeds u64".to_string())?,
            runner_pid: std::process::id(),
            runner_control_session_id: runner_control_session_id.into(),
        };
        ack.validate()?;
        Ok(ack)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION {
            return Err("runner runtime-control ACK schema mismatch".to_string());
        }
        if !canonical_runner_runtime_control_token(&self.runtime_control_token) {
            return Err("runner runtime-control ACK token is invalid".to_string());
        }
        if self.runtime_paused != self.status.expected_paused() {
            return Err("runner runtime-control ACK state contradicts status".to_string());
        }
        if self.runner_pid == 0 {
            return Err("runner runtime-control ACK process identity is invalid".to_string());
        }
        if !canonical_runner_runtime_control_session_id(&self.runner_control_session_id) {
            return Err("runner runtime-control ACK control session is invalid".to_string());
        }
        Ok(())
    }

    pub fn line(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map(|json| format!("{RUNNER_RUNTIME_CONTROL_ACK_PREFIX}{json}"))
            .map_err(|error| format!("serializing runner runtime-control ACK: {error}"))
    }

    pub fn matches_expected(
        &self,
        status: RunnerRuntimeControlStatus,
        token: &str,
        runner_pid: u32,
        runner_control_session_id: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.status == status
            && self.runtime_control_token == token
            && self.runner_pid == runner_pid
            && self.runner_control_session_id == runner_control_session_id
    }
}

pub fn parse_runner_runtime_control_ack(line: &str) -> Option<RunnerRuntimeControlAck> {
    let json = line.strip_prefix(RUNNER_RUNTIME_CONTROL_ACK_PREFIX)?;
    let ack: RunnerRuntimeControlAck = serde_json::from_str(json).ok()?;
    ack.validate().ok()?;
    Some(ack)
}

/// A nonce-correlated observation that a live runner implements a named
/// mechanism. Capability names are open vocabulary; this record is support
/// evidence only and cannot authorize HMR or GPU HMR acceptance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerCapabilityObservationV1 {
    pub schema_version: String,
    pub proof_authority: String,
    pub observation_id: String,
    pub request_id: String,
    pub capability: String,
    pub runner_pid: u32,
    pub runner_control_session_id: String,
    pub observed: bool,
    pub accepted_for_hmr: bool,
    pub accepted_for_gpu_hmr: bool,
    pub hmr_success: bool,
    pub gpu_hmr_success: bool,
}

impl RunnerCapabilityObservationV1 {
    pub fn current(
        request_id: impl Into<String>,
        capability: impl Into<String>,
        runner_control_session_id: impl Into<String>,
    ) -> Result<Self, String> {
        let mut observation = Self {
            schema_version: RUNNER_CAPABILITY_OBSERVATION_SCHEMA_VERSION.to_string(),
            proof_authority: RUNNER_CAPABILITY_OBSERVATION_AUTHORITY.to_string(),
            observation_id: String::new(),
            request_id: request_id.into(),
            capability: capability.into(),
            runner_pid: std::process::id(),
            runner_control_session_id: runner_control_session_id.into(),
            observed: true,
            accepted_for_hmr: false,
            accepted_for_gpu_hmr: false,
            hmr_success: false,
            gpu_hmr_success: false,
        };
        observation.observation_id = observation.expected_observation_id()?;
        observation.validate()?;
        Ok(observation)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNNER_CAPABILITY_OBSERVATION_SCHEMA_VERSION {
            return Err("runner capability observation schema mismatch".to_string());
        }
        if self.proof_authority != RUNNER_CAPABILITY_OBSERVATION_AUTHORITY {
            return Err("runner capability observation authority is invalid".to_string());
        }
        if !canonical_runner_capability_observation_request_id(&self.request_id) {
            return Err("runner capability observation request identity is invalid".to_string());
        }
        if !canonical_runner_capability_name(&self.capability) {
            return Err("runner capability observation name is invalid".to_string());
        }
        if self.runner_pid == 0 {
            return Err("runner capability observation process identity is invalid".to_string());
        }
        if !canonical_runner_runtime_control_session_id(&self.runner_control_session_id) {
            return Err("runner capability observation control session is invalid".to_string());
        }
        if !self.observed
            || self.accepted_for_hmr
            || self.accepted_for_gpu_hmr
            || self.hmr_success
            || self.gpu_hmr_success
        {
            return Err(
                "runner capability observation has contradictory authority fields".to_string(),
            );
        }
        if self.observation_id != self.expected_observation_id()? {
            return Err("runner capability observation identity mismatch".to_string());
        }
        Ok(())
    }

    pub fn line(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map(|json| format!("{RUNNER_CAPABILITY_OBSERVATION_PREFIX}{json}"))
            .map_err(|error| format!("serializing runner capability observation: {error}"))
    }

    pub fn matches_expected(
        &self,
        request_id: &str,
        capability: &str,
        runner_pid: u32,
        runner_control_session_id: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.capability == capability
            && self.runner_pid == runner_pid
            && self.runner_control_session_id == runner_control_session_id
    }

    pub fn observes_process_capability(
        &self,
        capability: &str,
        runner_pid: u32,
        runner_control_session_id: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.capability == capability
            && self.runner_pid == runner_pid
            && self.runner_control_session_id == runner_control_session_id
    }

    fn expected_observation_id(&self) -> Result<String, String> {
        let material = json!([
            self.schema_version,
            self.proof_authority,
            self.request_id,
            self.capability,
            self.runner_pid,
            self.runner_control_session_id,
            self.observed,
            self.accepted_for_hmr,
            self.accepted_for_gpu_hmr,
            self.hmr_success,
            self.gpu_hmr_success,
        ]);
        let bytes = serde_json::to_vec(&material).map_err(|error| {
            format!("serializing runner capability observation identity: {error}")
        })?;
        Ok(format!(
            "runner-capability-observation:sha256:{:x}",
            Sha256::digest(bytes)
        ))
    }
}

pub fn parse_runner_capability_observation(line: &str) -> Option<RunnerCapabilityObservationV1> {
    let json = line.strip_prefix(RUNNER_CAPABILITY_OBSERVATION_PREFIX)?;
    if json.len() > 16 * 1024 {
        return None;
    }
    let observation: RunnerCapabilityObservationV1 = serde_json::from_str(json).ok()?;
    observation.validate().ok()?;
    Some(observation)
}

pub fn canonical_runner_capability_observation_request_id(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-capability:request:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn canonical_runner_capability_name(value: &str) -> bool {
    canonical_runner_capability(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerModuleLoadStatus {
    Applied,
    Rejected,
}

/// Content-bound acknowledgement emitted by the target runner after a module
/// load command. This proves only that the runner process observed the loader
/// mechanics; it cannot authorize HMR or GPU HMR success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerModuleLoadResultV1 {
    pub schema_version: String,
    pub proof_authority: String,
    pub receipt_id: String,
    pub status: RunnerModuleLoadStatus,
    pub request_id: String,
    pub module_id: String,
    pub artifact_content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded_artifact_content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_staging_mechanism: Option<String>,
    pub runner_pid: u32,
    pub runner_control_session_id: String,
    pub mechanics_observed: bool,
    pub post_load_hash_verified: bool,
    pub accepted_for_hmr: bool,
    pub accepted_for_gpu_hmr: bool,
    pub hmr_success: bool,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RunnerModuleLoadResultV1 {
    pub fn applied(
        request_id: impl Into<String>,
        module_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        runner_control_session_id: impl Into<String>,
        loader_epoch: u64,
        artifact_staging_mechanism: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new(
            RunnerModuleLoadStatus::Applied,
            request_id,
            module_id,
            artifact_content_hash,
            runner_control_session_id,
            Some(loader_epoch),
            Some(artifact_staging_mechanism.into()),
            None,
        )
    }

    pub fn rejected(
        request_id: impl Into<String>,
        module_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        runner_control_session_id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        Self::new(
            RunnerModuleLoadStatus::Rejected,
            request_id,
            module_id,
            artifact_content_hash,
            runner_control_session_id,
            None,
            None,
            Some(reason.into()),
        )
    }

    fn new(
        status: RunnerModuleLoadStatus,
        request_id: impl Into<String>,
        module_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        runner_control_session_id: impl Into<String>,
        loader_epoch: Option<u64>,
        artifact_staging_mechanism: Option<String>,
        reason: Option<String>,
    ) -> Result<Self, String> {
        let artifact_content_hash = artifact_content_hash.into();
        let mut result = Self {
            schema_version: RUNNER_MODULE_LOAD_RESULT_SCHEMA_VERSION.to_string(),
            proof_authority: RUNNER_MODULE_LOAD_RESULT_AUTHORITY.to_string(),
            receipt_id: String::new(),
            status,
            request_id: request_id.into(),
            module_id: module_id.into(),
            loaded_artifact_content_hash: (status == RunnerModuleLoadStatus::Applied)
                .then(|| artifact_content_hash.clone()),
            artifact_content_hash,
            loader_epoch,
            artifact_staging_mechanism,
            runner_pid: std::process::id(),
            runner_control_session_id: runner_control_session_id.into(),
            mechanics_observed: status == RunnerModuleLoadStatus::Applied,
            post_load_hash_verified: status == RunnerModuleLoadStatus::Applied,
            accepted_for_hmr: false,
            accepted_for_gpu_hmr: false,
            hmr_success: false,
            gpu_hmr_success: false,
            reason,
        };
        result.receipt_id = result.expected_receipt_id()?;
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNNER_MODULE_LOAD_RESULT_SCHEMA_VERSION {
            return Err("runner module-load result schema mismatch".to_string());
        }
        if self.proof_authority != RUNNER_MODULE_LOAD_RESULT_AUTHORITY {
            return Err("runner module-load result authority is invalid".to_string());
        }
        if !canonical_runner_module_load_request_id(&self.request_id) {
            return Err("runner module-load request identity is invalid".to_string());
        }
        if self.module_id.trim().is_empty()
            || self.module_id.len() > 256
            || self.module_id.chars().any(char::is_control)
        {
            return Err("runner module-load module identity is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&self.artifact_content_hash) {
            return Err("runner module-load artifact hash is invalid".to_string());
        }
        if self
            .loaded_artifact_content_hash
            .as_deref()
            .is_some_and(|hash| {
                !canonical_sha256_content_hash(hash) || hash != self.artifact_content_hash
            })
        {
            return Err("runner module-load loaded artifact hash is invalid".to_string());
        }
        if self.runner_pid == 0 {
            return Err("runner module-load process identity is invalid".to_string());
        }
        if !canonical_runner_runtime_control_session_id(&self.runner_control_session_id) {
            return Err("runner module-load control session is invalid".to_string());
        }
        if self.accepted_for_hmr
            || self.accepted_for_gpu_hmr
            || self.hmr_success
            || self.gpu_hmr_success
        {
            return Err("runner module-load result cannot claim HMR authority".to_string());
        }
        match self.status {
            RunnerModuleLoadStatus::Applied => {
                if !self.mechanics_observed
                    || !self.post_load_hash_verified
                    || self.loaded_artifact_content_hash.as_deref()
                        != Some(self.artifact_content_hash.as_str())
                    || self.loader_epoch.is_none_or(|epoch| epoch == 0)
                    || self
                        .artifact_staging_mechanism
                        .as_deref()
                        .is_none_or(|mechanism| {
                            mechanism.is_empty()
                                || mechanism.len() > 128
                                || mechanism.chars().any(|character| {
                                    character.is_control() || character.is_whitespace()
                                })
                        })
                    || self.reason.is_some()
                {
                    return Err(
                        "applied runner module-load result has contradictory fields".to_string()
                    );
                }
            }
            RunnerModuleLoadStatus::Rejected => {
                if self.mechanics_observed
                    || self.post_load_hash_verified
                    || self.loaded_artifact_content_hash.is_some()
                    || self.loader_epoch.is_some()
                    || self.artifact_staging_mechanism.is_some()
                    || self.reason.as_deref().is_none_or(|reason| {
                        reason.trim().is_empty() || reason.chars().any(char::is_control)
                    })
                {
                    return Err(
                        "rejected runner module-load result has contradictory fields".to_string(),
                    );
                }
            }
        }
        if self.receipt_id != self.expected_receipt_id()? {
            return Err("runner module-load receipt identity mismatch".to_string());
        }
        Ok(())
    }

    pub fn line(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map(|json| format!("{RUNNER_MODULE_LOAD_RESULT_PREFIX}{json}"))
            .map_err(|error| format!("serializing runner module-load result: {error}"))
    }

    pub fn matches_expected(
        &self,
        request_id: &str,
        module_id: &str,
        artifact_content_hash: &str,
        runner_pid: u32,
        runner_control_session_id: &str,
        loader_epoch: u64,
        artifact_staging_mechanism: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.status == RunnerModuleLoadStatus::Applied
            && self.request_id == request_id
            && self.module_id == module_id
            && self.artifact_content_hash == artifact_content_hash
            && self.loaded_artifact_content_hash.as_deref() == Some(artifact_content_hash)
            && self.loader_epoch == Some(loader_epoch)
            && self.artifact_staging_mechanism.as_deref() == Some(artifact_staging_mechanism)
            && self.runner_pid == runner_pid
            && self.runner_control_session_id == runner_control_session_id
    }

    fn expected_receipt_id(&self) -> Result<String, String> {
        let material = json!([
            self.schema_version,
            self.proof_authority,
            self.status,
            self.request_id,
            self.module_id,
            self.artifact_content_hash,
            self.loaded_artifact_content_hash,
            self.loader_epoch,
            self.artifact_staging_mechanism,
            self.runner_pid,
            self.runner_control_session_id,
            self.mechanics_observed,
            self.post_load_hash_verified,
            self.accepted_for_hmr,
            self.accepted_for_gpu_hmr,
            self.hmr_success,
            self.gpu_hmr_success,
            self.reason,
        ]);
        let bytes = serde_json::to_vec(&material)
            .map_err(|error| format!("serializing runner module-load receipt identity: {error}"))?;
        Ok(format!(
            "runner-module-load-result:sha256:{:x}",
            Sha256::digest(bytes)
        ))
    }
}

pub fn parse_runner_module_load_result(line: &str) -> Option<RunnerModuleLoadResultV1> {
    let json = line.strip_prefix(RUNNER_MODULE_LOAD_RESULT_PREFIX)?;
    if json.len() > 16 * 1024 {
        return None;
    }
    let result: RunnerModuleLoadResultV1 = serde_json::from_str(json).ok()?;
    result.validate().ok()?;
    Some(result)
}

pub fn canonical_runner_module_load_request_id(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-module-load:request:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn encode_runner_module_load_token(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(value.as_bytes())
}

pub fn decode_runner_module_load_token(value: &str) -> Option<String> {
    if value.len() > 16 * 1024 {
        return None;
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|decoded| decoded.len() <= 8 * 1024 && !decoded.chars().any(char::is_control))
}

pub fn canonical_runner_runtime_control_token(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-control:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn canonical_runner_runtime_control_session_id(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-control-session:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV4Payload {
    pub schema_version: String,
    pub request_id: String,
    pub operation: String,
    pub mode: String,
    pub vendor: String,
    pub artifact_path: String,
    pub artifact_content_hash: String,
    pub kernels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capsule_token: Option<String>,
    pub source_edit_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proof_runtime_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compute_expected_output_semantics_hash: Option<String>,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    pub envelope_sha256: String,
}

impl GpuReloadV4Payload {
    pub fn new(
        request_id: String,
        operation: &str,
        mode: &str,
        vendor: &str,
        artifact_path: &str,
        artifact_content_hash: String,
        kernels: Vec<String>,
        abi_fingerprint: Option<String>,
        capsule_token: Option<String>,
        source_edit_id: String,
        proof_runtime_session_id: Option<String>,
        compute_expected_output_semantics_hash: Option<String>,
        runner_runtime_session_id: String,
        runner_challenge: String,
    ) -> Result<Self, String> {
        let mut payload = Self {
            schema_version: GPU_RELOAD_V4_SCHEMA_VERSION.to_string(),
            request_id,
            operation: operation.to_string(),
            mode: mode.to_string(),
            vendor: vendor.to_string(),
            artifact_path: artifact_path.to_string(),
            artifact_content_hash,
            kernels,
            abi_fingerprint,
            capsule_token,
            source_edit_id,
            proof_runtime_session_id,
            compute_expected_output_semantics_hash,
            runner_runtime_session_id,
            runner_challenge,
            envelope_sha256: String::new(),
        };
        payload.envelope_sha256 = payload.expected_envelope_sha256();
        payload.validate()?;
        Ok(payload)
    }

    fn expected_envelope_sha256(&self) -> String {
        let material = json!({
            "schemaVersion": self.schema_version,
            "requestId": self.request_id,
            "operation": self.operation,
            "mode": self.mode,
            "vendor": self.vendor,
            "artifactPath": self.artifact_path,
            "artifactContentHash": self.artifact_content_hash,
            "kernels": self.kernels,
            "abiFingerprint": self.abi_fingerprint,
            "capsuleToken": self.capsule_token,
            "sourceEditId": self.source_edit_id,
            "proofRuntimeSessionId": self.proof_runtime_session_id,
            "computeExpectedOutputSemanticsHash": self.compute_expected_output_semantics_hash,
            "runnerRuntimeSessionId": self.runner_runtime_session_id,
            "runnerChallenge": self.runner_challenge,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V4_SCHEMA_VERSION {
            return Err("GPU reload V4 schema mismatch".to_string());
        }
        if !matches!(self.operation.as_str(), "cold_load" | "hot_reload") {
            return Err("GPU reload V4 operation is invalid".to_string());
        }
        if !matches!(self.mode.as_str(), "full" | "partial") {
            return Err("GPU reload V4 mode is invalid".to_string());
        }
        if self.operation == "cold_load" && self.mode != "full" {
            return Err("GPU reload V4 cold load cannot publish a partial artifact".to_string());
        }
        if !matches!(self.vendor.as_str(), "cuda" | "rocm") {
            return Err("GPU reload V4 vendor is invalid".to_string());
        }
        if self.artifact_path.is_empty() || self.artifact_path.chars().any(char::is_control) {
            return Err("GPU reload V4 artifact path is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&self.artifact_content_hash) {
            return Err("GPU reload V4 artifact content hash is invalid".to_string());
        }
        if self
            .kernels
            .iter()
            .any(|kernel| kernel.is_empty() || kernel.chars().any(char::is_control))
        {
            return Err("GPU reload V4 kernel list is invalid".to_string());
        }
        for value in [
            self.abi_fingerprint.as_deref(),
            self.capsule_token.as_deref(),
            self.proof_runtime_session_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.chars().any(char::is_whitespace)
                || value.chars().any(char::is_control)
            {
                return Err("GPU reload V4 optional token is invalid".to_string());
            }
        }
        if !canonical_gpu_reload_request_id(&self.request_id) {
            return Err("GPU reload V4 request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&self.source_edit_id) {
            return Err("GPU reload V4 source edit identity is invalid".to_string());
        }
        if self.capsule_token.is_some() != self.proof_runtime_session_id.is_some() {
            return Err(
                "GPU reload V4 proof capsule/runtime session binding is incomplete".to_string(),
            );
        }
        if self
            .compute_expected_output_semantics_hash
            .as_deref()
            .is_some_and(|hash| !canonical_sha256_content_hash(hash))
        {
            return Err(
                "GPU reload V4 compute expected-output semantics hash is invalid".to_string(),
            );
        }
        if self.compute_expected_output_semantics_hash.is_some() && self.capsule_token.is_none() {
            return Err(
                "GPU reload V4 expected-output semantics require a proof capsule".to_string(),
            );
        }
        if self.operation == "hot_reload" && self.capsule_token.is_none() {
            return Err("GPU reload V4 hot reload requires a proof capsule".to_string());
        }
        if !valid_protocol_token(&self.runner_runtime_session_id) {
            return Err("GPU reload V4 runner runtime session is invalid".to_string());
        }
        if !canonical_runner_challenge(&self.runner_challenge) {
            return Err("GPU reload V4 runner challenge is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&self.envelope_sha256)
            || self.envelope_sha256 != self.expected_envelope_sha256()
        {
            return Err("GPU reload V4 envelope content binding is invalid".to_string());
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            .map_err(|error| format!("serializing GPU reload V4 payload: {error}"))
    }

    pub fn decode(encoded: &str) -> Result<Self, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|error| format!("decoding GPU reload V4 payload: {error}"))?;
        let payload: Self = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parsing GPU reload V4 payload: {error}"))?;
        payload.validate()?;
        Ok(payload)
    }
}

fn valid_protocol_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn canonical_runner_challenge(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn canonical_sha256_content_hash(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuReloadV2Expectation {
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
}

impl GpuReloadV2Expectation {
    pub fn new(
        request_id: String,
        source_edit_id: String,
        artifact_content_hash: String,
    ) -> Result<Self, String> {
        if !canonical_gpu_reload_request_id(&request_id) {
            return Err("GPU reload expectation request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&source_edit_id) {
            return Err("GPU reload expectation source edit identity is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&artifact_content_hash) {
            return Err("GPU reload expectation artifact content hash is invalid".to_string());
        }
        Ok(Self {
            request_id,
            source_edit_id,
            artifact_content_hash,
        })
    }
}

pub fn canonical_gpu_reload_request_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("gpu-reload:request:") else {
        return false;
    };
    digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn canonical_source_edit_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("source-edit:sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

const GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES: usize = 16 * 1024 * 1024;
const GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES: usize =
    (GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES * 4 + 2) / 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuRuntimeProofMaterialV1 {
    pub schema_version: String,
    pub proof_json_base64: String,
    pub proof_json_sha256: String,
    pub proof_byte_length: u64,
    pub command_envelope_sha256: String,
    pub runner_pid: u32,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    pub terminal_binding_sha256: String,
}

impl GpuRuntimeProofMaterialV1 {
    pub fn new(
        proof: &serde_json::Value,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: impl Into<String>,
        runner_pid: u32,
        runner_runtime_session_id: impl Into<String>,
        runner_challenge: impl Into<String>,
    ) -> Result<Self, String> {
        let proof_bytes = serde_json::to_vec(proof)
            .map_err(|error| format!("serializing protected GPU runtime proof: {error}"))?;
        if proof_bytes.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES {
            return Err("protected GPU runtime proof exceeds the protocol byte limit".to_string());
        }
        let mut material = Self {
            schema_version: GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION.to_string(),
            proof_json_base64: URL_SAFE_NO_PAD.encode(&proof_bytes),
            proof_json_sha256: format!("sha256:{:x}", Sha256::digest(&proof_bytes)),
            proof_byte_length: proof_bytes.len() as u64,
            command_envelope_sha256: command_envelope_sha256.into(),
            runner_pid,
            runner_runtime_session_id: runner_runtime_session_id.into(),
            runner_challenge: runner_challenge.into(),
            terminal_binding_sha256: String::new(),
        };
        material.terminal_binding_sha256 = material.expected_terminal_binding_sha256(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            &material.command_envelope_sha256,
        );
        material.validate_for(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            &material.command_envelope_sha256,
        )?;
        Ok(material)
    }

    fn expected_terminal_binding_sha256(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> String {
        let material = json!({
            "schemaVersion": self.schema_version,
            "requestId": request_id,
            "sourceEditId": source_edit_id,
            "artifactContentHash": artifact_content_hash,
            "fullRuntimeProofId": full_runtime_proof_id,
            "commandEnvelopeSha256": command_envelope_sha256,
            "proofJsonSha256": self.proof_json_sha256,
            "proofByteLength": self.proof_byte_length,
            "runnerPid": self.runner_pid,
            "runnerRuntimeSessionId": self.runner_runtime_session_id,
            "runnerChallenge": self.runner_challenge,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn validate_for(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> Result<(), String> {
        if self.schema_version != GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION {
            return Err("GPU runtime proof material schema mismatch".to_string());
        }
        if !canonical_gpu_reload_request_id(request_id)
            || !canonical_source_edit_id(source_edit_id)
            || !canonical_sha256_content_hash(artifact_content_hash)
            || !canonical_runtime_proof_id(full_runtime_proof_id)
            || !canonical_sha256_content_hash(command_envelope_sha256)
            || self.command_envelope_sha256 != command_envelope_sha256
        {
            return Err("GPU runtime proof material terminal identity is invalid".to_string());
        }
        if self.runner_pid == 0
            || !valid_protocol_token(&self.runner_runtime_session_id)
            || !canonical_runner_challenge(&self.runner_challenge)
        {
            return Err("GPU runtime proof material runner identity is invalid".to_string());
        }
        if self.proof_json_base64.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES {
            return Err(
                "protected GPU runtime proof exceeds the protocol encoded-byte limit".to_string(),
            );
        }
        let proof_bytes = URL_SAFE_NO_PAD
            .decode(self.proof_json_base64.as_bytes())
            .map_err(|error| format!("decoding protected GPU runtime proof: {error}"))?;
        if proof_bytes.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES
            || self.proof_byte_length != proof_bytes.len() as u64
            || self.proof_json_sha256 != format!("sha256:{:x}", Sha256::digest(&proof_bytes))
        {
            return Err("GPU runtime proof material byte identity mismatch".to_string());
        }
        let proof: serde_json::Value = serde_json::from_slice(&proof_bytes)
            .map_err(|error| format!("parsing protected GPU runtime proof: {error}"))?;
        if proof.get("proofId").and_then(serde_json::Value::as_str) != Some(full_runtime_proof_id) {
            return Err("GPU runtime proof material proof identity mismatch".to_string());
        }
        if !canonical_sha256_content_hash(&self.terminal_binding_sha256)
            || self.terminal_binding_sha256
                != self.expected_terminal_binding_sha256(
                    request_id,
                    source_edit_id,
                    artifact_content_hash,
                    full_runtime_proof_id,
                    command_envelope_sha256,
                )
        {
            return Err("GPU runtime proof material terminal binding mismatch".to_string());
        }
        Ok(())
    }

    pub fn decode_for(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> Result<serde_json::Value, String> {
        self.validate_for(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            command_envelope_sha256,
        )?;
        let proof_bytes = URL_SAFE_NO_PAD
            .decode(self.proof_json_base64.as_bytes())
            .map_err(|error| format!("decoding protected GPU runtime proof: {error}"))?;
        serde_json::from_slice(&proof_bytes)
            .map_err(|error| format!("parsing protected GPU runtime proof: {error}"))
    }

    pub fn matches_runner_context(
        &self,
        runner_pid: u32,
        runner_runtime_session_id: &str,
        runner_challenge: &str,
    ) -> bool {
        self.runner_pid == runner_pid
            && self.runner_runtime_session_id == runner_runtime_session_id
            && self.runner_challenge == runner_challenge
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV2Result {
    pub schema_version: String,
    pub status: String,
    pub module: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
    pub full_runtime_proof_accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_runtime_proof_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_proof_material: Option<GpuRuntimeProofMaterialV1>,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GpuReloadV2Result {
    pub fn applied(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        full_runtime_proof_id: impl Into<String>,
        runtime_proof_material: GpuRuntimeProofMaterialV1,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V4_RESULT_SCHEMA_VERSION.to_string(),
            status: "applied".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            full_runtime_proof_accepted: true,
            full_runtime_proof_id: Some(full_runtime_proof_id.into()),
            runtime_proof_material: Some(runtime_proof_material),
            gpu_hmr_success: true,
            reason: None,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn rejected(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V4_RESULT_SCHEMA_VERSION.to_string(),
            status: "rejected".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            full_runtime_proof_accepted: false,
            full_runtime_proof_id: None,
            runtime_proof_material: None,
            gpu_hmr_success: false,
            reason: Some(reason.into()),
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V4_RESULT_SCHEMA_VERSION {
            return Err("GPU reload V4 result schema mismatch".to_string());
        }
        if self.module != "device"
            || !canonical_gpu_reload_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
            || !canonical_sha256_content_hash(&self.artifact_content_hash)
        {
            return Err("GPU reload V4 terminal identity mismatch".to_string());
        }
        match self.status.as_str() {
            "applied"
                if self.full_runtime_proof_accepted
                    && self.gpu_hmr_success
                    && self.reason.is_none()
                    && self
                        .full_runtime_proof_id
                        .as_deref()
                        .is_some_and(canonical_runtime_proof_id) =>
            {
                let material = self
                    .runtime_proof_material
                    .as_ref()
                    .ok_or_else(|| "GPU reload V4 terminal omitted proof material".to_string())?;
                material.validate_for(
                    &self.request_id,
                    &self.source_edit_id,
                    &self.artifact_content_hash,
                    self.full_runtime_proof_id
                        .as_deref()
                        .expect("validated applied proof ID"),
                    &material.command_envelope_sha256,
                )
            }
            "rejected"
                if !self.full_runtime_proof_accepted
                    && !self.gpu_hmr_success
                    && self.full_runtime_proof_id.is_none()
                    && self.runtime_proof_material.is_none()
                    && self.reason.as_deref().is_some_and(nonempty_safe_text) =>
            {
                Ok(())
            }
            "applied" | "rejected" => {
                Err("GPU reload V4 terminal proof fields are inconsistent".to_string())
            }
            _ => Err("GPU reload V4 terminal status is invalid".to_string()),
        }
    }

    pub fn matches(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.source_edit_id == source_edit_id
            && self.artifact_content_hash == artifact_content_hash
    }

    pub fn matches_expectation(&self, expectation: &GpuReloadV2Expectation) -> bool {
        self.matches(
            &expectation.request_id,
            &expectation.source_edit_id,
            &expectation.artifact_content_hash,
        )
    }

    pub fn to_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|error| format!("serializing GPU reload V2 result: {error}"))
    }

    pub fn from_json(value: &str) -> Result<Self, String> {
        let result: Self = serde_json::from_str(value)
            .map_err(|error| format!("parsing GPU reload V2 result: {error}"))?;
        result.validate()?;
        Ok(result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuArtifactLoadV1Result {
    pub schema_version: String,
    pub status: String,
    pub module: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
    pub accepted_for_gpu_hmr: bool,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GpuArtifactLoadV1Result {
    pub fn loaded(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION.to_string(),
            status: "loaded".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            reason: None,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn rejected(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION.to_string(),
            status: "rejected".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            reason: Some(reason.into()),
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION {
            return Err("GPU artifact load V1 result schema mismatch".to_string());
        }
        if self.module != "device"
            || !canonical_gpu_reload_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
            || !canonical_sha256_content_hash(&self.artifact_content_hash)
            || self.accepted_for_gpu_hmr
            || self.gpu_hmr_success
        {
            return Err("GPU artifact load V1 result identity or authority mismatch".to_string());
        }
        match self.status.as_str() {
            "loaded" if self.reason.is_none() => Ok(()),
            "rejected" if self.reason.as_deref().is_some_and(nonempty_safe_text) => Ok(()),
            "loaded" | "rejected" => {
                Err("GPU artifact load V1 result fields are inconsistent".to_string())
            }
            _ => Err("GPU artifact load V1 result status is invalid".to_string()),
        }
    }

    pub fn matches(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.source_edit_id == source_edit_id
            && self.artifact_content_hash == artifact_content_hash
    }

    pub fn to_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|error| format!("serializing GPU artifact load V1 result: {error}"))
    }

    pub fn from_json(value: &str) -> Result<Self, String> {
        let result: Self = serde_json::from_str(value)
            .map_err(|error| format!("parsing GPU artifact load V1 result: {error}"))?;
        result.validate()?;
        Ok(result)
    }
}

fn canonical_runtime_proof_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("gpu-runtime-proof:sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn nonempty_safe_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

pub fn decode_runner_command_token(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_nibble(*bytes.get(index + 1)?)?;
            let low = hex_nibble(*bytes.get(index + 2)?)?;
            out.push((high << 4) | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_edit_id() -> String {
        format!("source-edit:sha256:{}", "a".repeat(64))
    }

    fn fixture_request_id(value: char) -> String {
        format!("gpu-reload:request:{}", value.to_string().repeat(32))
    }

    fn runner_runtime_session_id() -> String {
        "pid123-456".to_string()
    }

    fn runner_challenge() -> String {
        "1".repeat(32)
    }

    fn configured_resource_policy_ack() -> RunnerProtocolAckV4 {
        RunnerProtocolAckV4::current_with_enforced_resource_policy(
            "nonce-a",
            runner_runtime_session_id(),
            runner_challenge(),
            RunnerResourcePolicyV1::at_consumer_maxima(),
        )
        .unwrap()
    }

    fn assert_resource_policy_rejected(policy: RunnerResourcePolicyV1) {
        let mut ack = configured_resource_policy_ack();
        ack.resource_policy = policy;
        assert!(
            !ack.supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id(),)
        );
    }

    fn runtime_control_token() -> String {
        format!("runner-control:{}", "c".repeat(32))
    }

    fn runner_control_session_id() -> String {
        format!("runner-control-session:{}", "e".repeat(32))
    }

    fn proof_material(
        request_id: &str,
        source_edit_id: &str,
        artifact_hash: &str,
        proof_id: &str,
    ) -> GpuRuntimeProofMaterialV1 {
        GpuRuntimeProofMaterialV1::new(
            &json!({"proofId": proof_id, "evidence": "runtime-proof-bytes"}),
            request_id,
            source_edit_id,
            artifact_hash,
            proof_id,
            format!("sha256:{}", "e".repeat(64)),
            std::process::id(),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap()
    }

    #[test]
    fn gpu_reload_v4_round_trip_preserves_exact_typed_payload() {
        let payload = GpuReloadV4Payload::new(
            fixture_request_id('1'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/path with space/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            Some(format!("sha256:{}", "9".repeat(64))),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        assert!(!encoded.chars().any(char::is_whitespace));
        assert_eq!(GpuReloadV4Payload::decode(&encoded).unwrap(), payload);
    }

    #[test]
    fn gpu_reload_v4_rejects_noncanonical_or_conflicting_identity() {
        assert!(GpuReloadV4Payload::new(
            fixture_request_id('1'),
            "cold_load",
            "full",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            None,
            "source-edit:sha256:short".to_string(),
            None,
            None,
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .is_err());

        let mut payload = GpuReloadV4Payload::new(
            fixture_request_id('2'),
            "cold_load",
            "full",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            None,
            source_edit_id(),
            None,
            None,
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();
        payload.request_id = format!("gpu-reload:request:{}", "z".repeat(32));
        assert!(payload.encode().is_err());
    }

    #[test]
    fn gpu_reload_v4_rejects_incomplete_capsule_session_pairs() {
        let base = GpuReloadV4Payload::new(
            fixture_request_id('3'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            Some(format!("sha256:{}", "9".repeat(64))),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();

        let mut missing_session = base.clone();
        missing_session.proof_runtime_session_id = None;
        assert!(missing_session.encode().is_err());

        let mut missing_capsule = base;
        missing_capsule.capsule_token = None;
        assert!(missing_capsule.encode().is_err());
    }

    #[test]
    fn gpu_reload_v4_envelope_rejects_every_mutation_relevant_field_splice() {
        let payload = GpuReloadV4Payload::new(
            fixture_request_id('4'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            Some(format!("sha256:{}", "9".repeat(64))),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();

        let mut mutations = Vec::new();
        let mut value = payload.clone();
        value.schema_version = "synthi.runner.gpu_reload.invalid".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.request_id = fixture_request_id('5');
        mutations.push(value);
        let mut value = payload.clone();
        value.operation = "cold_load".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.mode = "full".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.vendor = "cuda".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.kernels = vec!["gpu::other".to_string()];
        mutations.push(value);
        let mut value = payload.clone();
        value.abi_fingerprint = Some("sha256:other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.capsule_token = Some("capsulev1_other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.proof_runtime_session_id = Some("runtime-session:other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.compute_expected_output_semantics_hash = Some(format!("sha256:{}", "8".repeat(64)));
        mutations.push(value);
        let mut value = payload.clone();
        value.artifact_path = "/tmp/other.hsaco".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.artifact_content_hash = format!("sha256:{}", "c".repeat(64));
        mutations.push(value);
        let mut value = payload.clone();
        value.source_edit_id = format!("source-edit:sha256:{}", "d".repeat(64));
        mutations.push(value);
        let mut value = payload.clone();
        value.runner_runtime_session_id = "pid999-999".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.runner_challenge = "2".repeat(32);
        mutations.push(value);
        let mut value = payload.clone();
        value.envelope_sha256 = format!("sha256:{}", "f".repeat(64));
        mutations.push(value);

        for mutation in mutations {
            assert!(mutation.encode().is_err());
        }
    }

    #[test]
    fn protocol_ack_is_bound_to_nonce_pid_version_and_capability() {
        let ack =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        let line = ack.line().unwrap();
        let parsed = parse_runner_protocol_ack(&line).unwrap();
        assert!(parsed.supports_strict_gpu_reload("nonce-a", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-b", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-a", std::process::id() + 1));

        for required in [
            GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
            GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY,
            GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
            GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
            GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
        ] {
            let mut missing_capability = parsed.clone();
            missing_capability
                .capabilities
                .retain(|capability| capability != required);
            assert!(!missing_capability.supports_strict_gpu_reload("nonce-a", std::process::id()));
        }
    }

    #[test]
    fn ordinary_current_protocol_ack_does_not_claim_resource_guarantees() {
        let ack =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());

        assert_eq!(RUNNER_PROTOCOL_CURRENT_VERSION, 5);
        assert_eq!(ack.schema_version, RUNNER_PROTOCOL_ACK_SCHEMA_VERSION);
        assert!(!ack
            .capabilities
            .iter()
            .any(|capability| capability == RUNNER_BOUNDED_INGRESS_V1_CAPABILITY));
        assert!(!ack
            .capabilities
            .iter()
            .any(|capability| capability == RUNNER_ATOMIC_BATCH_V1_CAPABILITY));
        assert!(ack.supports_strict_gpu_reload("nonce-a", std::process::id()));
        assert!(serde_json::to_value(&ack)
            .unwrap()
            .get("resourcePolicy")
            .is_none());
    }

    #[test]
    fn configured_resource_policy_ack_round_trips_with_explicit_support() {
        let ack = configured_resource_policy_ack();

        assert_eq!(
            ack.schema_version,
            RUNNER_PROTOCOL_ACK_RESOURCE_POLICY_SCHEMA_VERSION
        );
        assert_eq!(ack.current_version, RUNNER_PROTOCOL_CURRENT_VERSION);
        assert!(ack
            .capabilities
            .iter()
            .any(|capability| capability == RUNNER_BOUNDED_INGRESS_V1_CAPABILITY));
        assert!(ack
            .capabilities
            .iter()
            .any(|capability| capability == RUNNER_ATOMIC_BATCH_V1_CAPABILITY));
        assert!(ack.resource_policy.validate().is_ok());

        let line = ack.line().unwrap();
        assert!(line
            .strip_prefix(RUNNER_PROTOCOL_ACK_PREFIX)
            .is_some_and(|json| json.len() <= RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES));
        let parsed = parse_runner_protocol_ack_v4(&line).unwrap();
        assert_eq!(parsed, ack);
        assert!(
            parsed.supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id(),)
        );
        assert!(parse_runner_protocol_ack(&line).is_none());
    }

    #[test]
    fn configured_ack_rejects_missing_policy_or_capability() {
        let ack = configured_resource_policy_ack();

        let mut missing_policy_json = serde_json::to_value(&ack).unwrap();
        missing_policy_json
            .as_object_mut()
            .unwrap()
            .remove("resourcePolicy");
        let missing_policy_line = format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{}",
            serde_json::to_string(&missing_policy_json).unwrap()
        );
        assert!(parse_runner_protocol_ack_v4(&missing_policy_line).is_none());

        for required in [
            RUNNER_BOUNDED_INGRESS_V1_CAPABILITY,
            RUNNER_ATOMIC_BATCH_V1_CAPABILITY,
        ] {
            let mut missing_capability = ack.clone();
            missing_capability
                .capabilities
                .retain(|capability| capability != required);
            assert!(!missing_capability
                .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));
        }
    }

    #[test]
    fn protocol_ack_schemas_reject_cross_version_resource_claims() {
        let mut v3 =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        v3.capabilities
            .push(RUNNER_BOUNDED_INGRESS_V1_CAPABILITY.to_string());
        v3.capabilities
            .push(RUNNER_ATOMIC_BATCH_V1_CAPABILITY.to_string());
        assert!(!v3.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let plain_v3 =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        let mut v3_with_policy = serde_json::to_value(&plain_v3).unwrap();
        v3_with_policy["resourcePolicy"] =
            serde_json::to_value(RunnerResourcePolicyV1::at_consumer_maxima()).unwrap();
        let line = format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{}",
            serde_json::to_string(&v3_with_policy).unwrap()
        );
        assert!(parse_runner_protocol_ack(&line).is_none());
        let parsed_as_v4 = parse_runner_protocol_ack_v4(&line).unwrap();
        assert!(!parsed_as_v4
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));

        let mut unsupported_ack_schema = configured_resource_policy_ack();
        unsupported_ack_schema.schema_version = "synthi.runner.protocol_ack.v5".to_string();
        assert!(!unsupported_ack_schema
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));

        let mut unsupported_policy_schema = configured_resource_policy_ack();
        unsupported_policy_schema.resource_policy.schema_version =
            "synthi.runner.resource_policy.v2".to_string();
        assert!(!unsupported_policy_schema
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));
    }

    #[test]
    fn protocol_ack_rejects_duplicate_and_noncanonical_capabilities() {
        let v3 =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        let mut duplicate_v3 = v3.clone();
        duplicate_v3
            .capabilities
            .push(GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY.to_string());
        assert!(!duplicate_v3.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let mut noncanonical_v3 = v3;
        noncanonical_v3
            .capabilities
            .push("Runner.Invalid".to_string());
        assert!(!noncanonical_v3.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let v4 = configured_resource_policy_ack();
        let mut duplicate_v4 = v4.clone();
        duplicate_v4
            .capabilities
            .push(RUNNER_BOUNDED_INGRESS_V1_CAPABILITY.to_string());
        assert!(!duplicate_v4
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));

        let mut noncanonical_v4 = v4;
        noncanonical_v4
            .capabilities
            .push("runner/invalid".to_string());
        assert!(!noncanonical_v4
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));
    }

    #[test]
    fn protocol_ack_rejects_invalid_protocol_version_ordering() {
        let v3 =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        let v4 = configured_resource_policy_ack();

        let mut v3_cases = Vec::new();
        let mut below_current = v3.clone();
        below_current.current_version = RUNNER_PROTOCOL_CURRENT_VERSION - 1;
        v3_cases.push(below_current);
        let mut zero_minimum = v3.clone();
        zero_minimum.min_supported_version = 0;
        v3_cases.push(zero_minimum);
        let mut minimum_above_current = v3.clone();
        minimum_above_current.min_supported_version = minimum_above_current.current_version + 1;
        v3_cases.push(minimum_above_current);
        let mut minimum_above_consumer = v3;
        minimum_above_consumer.current_version = RUNNER_PROTOCOL_CURRENT_VERSION + 1;
        minimum_above_consumer.min_supported_version = RUNNER_PROTOCOL_CURRENT_VERSION + 1;
        v3_cases.push(minimum_above_consumer);
        for ack in v3_cases {
            assert!(!ack.supports_strict_gpu_reload("nonce-a", std::process::id()));
        }

        let mut v4_cases = Vec::new();
        let mut below_current = v4.clone();
        below_current.current_version = RUNNER_PROTOCOL_CURRENT_VERSION - 1;
        v4_cases.push(below_current);
        let mut zero_minimum = v4.clone();
        zero_minimum.min_supported_version = 0;
        v4_cases.push(zero_minimum);
        let mut minimum_above_current = v4.clone();
        minimum_above_current.min_supported_version = minimum_above_current.current_version + 1;
        v4_cases.push(minimum_above_current);
        let mut minimum_above_consumer = v4;
        minimum_above_consumer.current_version = RUNNER_PROTOCOL_CURRENT_VERSION + 1;
        minimum_above_consumer.min_supported_version = RUNNER_PROTOCOL_CURRENT_VERSION + 1;
        v4_cases.push(minimum_above_consumer);
        for ack in v4_cases {
            assert!(
                !ack.supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id())
            );
        }
    }

    #[test]
    fn resource_policy_rejects_zero_limits() {
        let base = RunnerResourcePolicyV1::at_consumer_maxima();
        let policies = [
            RunnerResourcePolicyV1 {
                max_command_bytes: 0,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_queue_items: 0,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_queue_retained_bytes: 0,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_atomic_batch_items: 0,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_atomic_batch_bytes: 0,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_commands_per_tick: 0,
                ..base
            },
        ];

        for policy in policies {
            assert_resource_policy_rejected(policy);
        }
    }

    #[test]
    fn resource_policy_rejects_consumer_maxima_plus_one() {
        let base = RunnerResourcePolicyV1::at_consumer_maxima();
        let policies = [
            RunnerResourcePolicyV1 {
                max_command_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES + 1,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_queue_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS + 1,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_queue_retained_bytes:
                    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES + 1,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_atomic_batch_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS
                    + 1,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_atomic_batch_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES
                    + 1,
                ..base.clone()
            },
            RunnerResourcePolicyV1 {
                max_commands_per_tick: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK + 1,
                ..base
            },
        ];

        for policy in policies {
            assert_resource_policy_rejected(policy);
        }
    }

    #[test]
    fn resource_policy_rejects_inconsistent_limit_ordering() {
        let base = RunnerResourcePolicyV1::at_consumer_maxima();

        let mut batch_exceeds_queue_bytes = base.clone();
        batch_exceeds_queue_bytes.max_command_bytes = 1024;
        batch_exceeds_queue_bytes.max_atomic_batch_bytes = 2048;
        batch_exceeds_queue_bytes.max_queue_retained_bytes = 1024;

        let mut command_exceeds_batch_bytes = base.clone();
        command_exceeds_batch_bytes.max_command_bytes = 2048;
        command_exceeds_batch_bytes.max_atomic_batch_bytes = 1024;
        command_exceeds_batch_bytes.max_queue_retained_bytes = 2048;

        let mut tick_exceeds_queue_items = base.clone();
        tick_exceeds_queue_items.max_atomic_batch_items = 8;
        tick_exceeds_queue_items.max_commands_per_tick = 9;
        tick_exceeds_queue_items.max_queue_items = 8;

        let mut batch_exceeds_tick_items = base;
        batch_exceeds_tick_items.max_atomic_batch_items = 9;
        batch_exceeds_tick_items.max_commands_per_tick = 8;
        batch_exceeds_tick_items.max_queue_items = 9;

        for policy in [
            batch_exceeds_queue_bytes,
            command_exceeds_batch_bytes,
            tick_exceeds_queue_items,
            batch_exceeds_tick_items,
        ] {
            assert_resource_policy_rejected(policy);
        }
    }

    #[test]
    fn protocol_ack_rejects_capability_flooding_and_overlong_values() {
        let mut flooded = configured_resource_policy_ack();
        let additional = RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES + 1 - flooded.capabilities.len();
        for index in 0..additional {
            flooded
                .capabilities
                .push(char::from(b'a' + index as u8).to_string());
        }
        assert_eq!(
            flooded.capabilities.len(),
            RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES + 1
        );
        assert!(
            !flooded.supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id())
        );
        assert!(flooded.line().is_err());
        let flooded_json = serde_json::to_string(&flooded).unwrap();
        assert!(flooded_json.len() <= RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES);
        assert!(parse_runner_protocol_ack_v4(&format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{flooded_json}"
        ))
        .is_none());

        let mut overlong = configured_resource_policy_ack();
        overlong
            .capabilities
            .push("x".repeat(RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES + 1));
        assert!(!overlong
            .supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));
        assert!(overlong.line().is_err());
        let overlong_json = serde_json::to_string(&overlong).unwrap();
        assert!(overlong_json.len() <= RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES);
        assert!(parse_runner_protocol_ack_v4(&format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{overlong_json}"
        ))
        .is_none());
    }

    #[test]
    fn protocol_ack_rejects_unknown_fields() {
        let ack = configured_resource_policy_ack();

        let mut unknown_ack_field = serde_json::to_value(&ack).unwrap();
        unknown_ack_field["extra"] = serde_json::Value::Bool(true);
        let line = format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{}",
            serde_json::to_string(&unknown_ack_field).unwrap()
        );
        assert!(parse_runner_protocol_ack_v4(&line).is_none());

        let mut unknown_policy_field = serde_json::to_value(&ack).unwrap();
        unknown_policy_field["resourcePolicy"]["extra"] = serde_json::Value::Bool(true);
        let line = format!(
            "{RUNNER_PROTOCOL_ACK_PREFIX}{}",
            serde_json::to_string(&unknown_policy_field).unwrap()
        );
        assert!(parse_runner_protocol_ack_v4(&line).is_none());
    }

    #[test]
    fn protocol_ack_rejects_encoded_bytes_over_limit() {
        let mut ack = configured_resource_policy_ack();
        while ack.capabilities.len() < RUNNER_PROTOCOL_ACK_MAX_CAPABILITIES {
            let suffix = ack.capabilities.len().to_string();
            ack.capabilities.push(format!(
                "{}{}",
                "x".repeat(RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES - suffix.len()),
                suffix
            ));
        }

        assert!(ack
            .capabilities
            .iter()
            .all(|capability| capability.len() <= RUNNER_PROTOCOL_ACK_MAX_CAPABILITY_BYTES));
        let json = serde_json::to_string(&ack).unwrap();
        assert!(json.len() > RUNNER_PROTOCOL_ACK_MAX_ENCODED_BYTES);
        assert!(!ack.supports_strict_gpu_reload_with_resource_policy("nonce-a", std::process::id()));
        assert!(ack.line().is_err());
        assert!(
            parse_runner_protocol_ack_v4(&format!("{RUNNER_PROTOCOL_ACK_PREFIX}{json}")).is_none()
        );
    }

    #[test]
    fn protocol_ack_rejects_malformed_identity_shapes() {
        let base =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());

        let mut empty_nonce = base.clone();
        empty_nonce.nonce.clear();
        assert!(!empty_nonce.supports_strict_gpu_reload("", std::process::id()));

        let mut long_nonce = base.clone();
        long_nonce.nonce = "n".repeat(RUNNER_PROTOCOL_ACK_MAX_NONCE_BYTES + 1);
        assert!(!long_nonce.supports_strict_gpu_reload(&long_nonce.nonce, std::process::id()));

        let mut invalid_session = base.clone();
        invalid_session.runner_runtime_session_id = "invalid/session".to_string();
        assert!(!invalid_session.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let mut long_session = base.clone();
        long_session.runner_runtime_session_id =
            "s".repeat(RUNNER_PROTOCOL_ACK_MAX_RUNTIME_SESSION_BYTES + 1);
        assert!(!long_session.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let mut invalid_challenge = base.clone();
        invalid_challenge.runner_challenge = "A".repeat(RUNNER_PROTOCOL_ACK_CHALLENGE_BYTES);
        assert!(!invalid_challenge.supports_strict_gpu_reload("nonce-a", std::process::id()));

        let mut zero_pid = base;
        zero_pid.runner_pid = 0;
        assert!(!zero_pid.supports_strict_gpu_reload("nonce-a", 0));
    }

    #[test]
    fn runtime_control_ack_is_typed_and_bound_to_token_process_session_and_state() {
        let token = runtime_control_token();
        let ack = RunnerRuntimeControlAck::current(
            RunnerRuntimeControlStatus::Paused,
            &token,
            true,
            2,
            runner_control_session_id(),
        )
        .unwrap();
        let line = ack.line().unwrap();
        let parsed = parse_runner_runtime_control_ack(&line).unwrap();

        assert!(parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Resumed,
            &token,
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &format!("runner-control:{}", "d".repeat(32)),
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id() + 1,
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id(),
            &format!("runner-control-session:{}", "f".repeat(32)),
        ));
    }

    #[test]
    fn runtime_control_ack_rejects_loose_or_malformed_protocol_shapes() {
        let token = runtime_control_token();
        let ack = RunnerRuntimeControlAck::current(
            RunnerRuntimeControlStatus::Paused,
            &token,
            true,
            0,
            runner_control_session_id(),
        )
        .unwrap();

        assert!(parse_runner_runtime_control_ack(&serde_json::to_string(&ack).unwrap()).is_none());
        assert!(parse_runner_runtime_control_ack(
            r#"[Runner] [HMR-STATUS] {"status":"runtime-paused","runtimeControlToken":"runner-control:cccccccccccccccccccccccccccccccc"}"#,
        )
        .is_none());

        let mut unknown_field = serde_json::to_value(&ack).unwrap();
        unknown_field["acceptedForGpuHmr"] = serde_json::Value::Bool(true);
        let unknown_line = format!(
            "{RUNNER_RUNTIME_CONTROL_ACK_PREFIX}{}",
            serde_json::to_string(&unknown_field).unwrap()
        );
        assert!(parse_runner_runtime_control_ack(&unknown_line).is_none());

        let mut invalid = ack.clone();
        invalid.runtime_control_token = "runner-control-1".to_string();
        assert!(invalid.line().is_err());
        let mut invalid = ack.clone();
        invalid.runtime_paused = false;
        assert!(invalid.line().is_err());
        let mut invalid = ack.clone();
        invalid.runner_pid = 0;
        assert!(invalid.line().is_err());
        let mut invalid = ack;
        invalid.runner_control_session_id = "contains whitespace".to_string();
        assert!(invalid.line().is_err());
    }

    #[test]
    fn capability_observation_is_open_vocabulary_and_process_bound() {
        let request_id = format!("runner-capability:request:{}", "a".repeat(32));
        let capability = "runner.unfamiliar_mechanism_42.v9";
        let control_session = runner_control_session_id();
        let observation =
            RunnerCapabilityObservationV1::current(&request_id, capability, &control_session)
                .unwrap();
        let line = observation.line().unwrap();
        let parsed = parse_runner_capability_observation(&line).unwrap();

        assert!(parsed.matches_expected(
            &request_id,
            capability,
            std::process::id(),
            &control_session,
        ));
        assert!(parsed.observes_process_capability(
            capability,
            std::process::id(),
            &control_session,
        ));
        assert!(!parsed.matches_expected(
            &format!("runner-capability:request:{}", "b".repeat(32)),
            capability,
            std::process::id(),
            &control_session,
        ));
        assert!(!parsed.observes_process_capability(
            capability,
            std::process::id().saturating_add(1),
            &control_session,
        ));
        assert!(!parsed.accepted_for_hmr);
        assert!(!parsed.accepted_for_gpu_hmr);
        assert!(!parsed.hmr_success);
        assert!(!parsed.gpu_hmr_success);
    }

    #[test]
    fn capability_observation_rejects_forged_authority_and_identity() {
        let request_id = format!("runner-capability:request:{}", "c".repeat(32));
        let observation = RunnerCapabilityObservationV1::current(
            request_id,
            RUNNER_CONTENT_BOUND_MODULE_LOAD_CAPABILITY,
            runner_control_session_id(),
        )
        .unwrap();

        let mut forged = observation.clone();
        forged.accepted_for_hmr = true;
        assert!(forged.validate().is_err());

        let mut replayed = observation.clone();
        replayed.runner_pid = replayed.runner_pid.saturating_add(1);
        assert!(replayed.validate().is_err());

        let mut renamed = observation.clone();
        renamed.capability = "runner.some_other_mechanism.v1".to_string();
        assert!(renamed.validate().is_err());

        let mut malformed = observation;
        malformed.request_id = "runner-capability:request:short".to_string();
        assert!(malformed.validate().is_err());
        assert!(!canonical_runner_capability_name(
            "project specific capability"
        ));
        assert!(canonical_runner_capability_name(
            "runner.arbitrary_mechanism.v1"
        ));
    }

    #[test]
    fn runtime_control_token_requires_exact_128_bit_lowercase_hex_shape() {
        assert!(canonical_runner_runtime_control_token(
            &runtime_control_token()
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control:ccccccccccccccccccccccccccccccc"
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control-cccccccccccccccccccccccccccccccc"
        ));
    }

    #[test]
    fn runtime_control_session_requires_exact_128_bit_lowercase_hex_shape() {
        assert!(canonical_runner_runtime_control_session_id(
            &runner_control_session_id()
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-control-session:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-control-session:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-runtime-session:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        ));
    }

    #[test]
    fn gpu_reload_v2_terminal_result_is_bound_to_request_source_and_runtime_proof() {
        let source_edit_id = source_edit_id();
        let request_id = fixture_request_id('3');
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "b".repeat(64));
        let material = proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id);
        let applied = GpuReloadV2Result::applied(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            &proof_id,
            material,
        )
        .unwrap();
        let encoded = applied.to_json().unwrap();
        let decoded = GpuReloadV2Result::from_json(&encoded).unwrap();
        assert_eq!(decoded, applied);
        assert!(decoded.matches(&request_id, &source_edit_id, &artifact_hash));
        assert!(!decoded.matches(&fixture_request_id('4'), &source_edit_id, &artifact_hash));
        assert!(!decoded.matches(
            &request_id,
            &source_edit_id,
            &format!("sha256:{}", "c".repeat(64))
        ));

        let mut forged = decoded;
        forged.full_runtime_proof_accepted = false;
        assert!(forged.to_json().is_err());
        assert!(GpuReloadV2Result::applied(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "proof:declared",
            proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id),
        )
        .is_err());

        let rejected = GpuReloadV2Result::rejected(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "strict proof missing",
        )
        .unwrap();
        assert!(!rejected.gpu_hmr_success);
        assert!(rejected.full_runtime_proof_id.is_none());
        assert!(rejected.runtime_proof_material.is_none());
    }

    #[test]
    fn gpu_runtime_proof_material_rejects_byte_context_and_runner_splices() {
        let source_edit_id = source_edit_id();
        let request_id = fixture_request_id('6');
        let artifact_hash = format!("sha256:{}", "c".repeat(64));
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "d".repeat(64));
        let material = proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id);
        assert_eq!(
            material
                .decode_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &material.command_envelope_sha256,
                )
                .unwrap()["proofId"],
            proof_id
        );

        let mut mutations = Vec::new();
        let mut value = material.clone();
        value.proof_json_base64.push('A');
        mutations.push(value);
        let mut value = material.clone();
        value.proof_byte_length += 1;
        mutations.push(value);
        let mut value = material.clone();
        value.proof_json_sha256 = format!("sha256:{}", "e".repeat(64));
        mutations.push(value);
        let mut value = material.clone();
        value.command_envelope_sha256 = format!("sha256:{}", "f".repeat(64));
        mutations.push(value);
        let mut value = material.clone();
        value.runner_pid = 0;
        mutations.push(value);
        let mut value = material.clone();
        value.runner_runtime_session_id = "runtime session with spaces".to_string();
        mutations.push(value);
        let mut value = material.clone();
        value.runner_challenge = "f".repeat(32);
        mutations.push(value);
        let mut value = material.clone();
        value.terminal_binding_sha256 = format!("sha256:{}", "0".repeat(64));
        mutations.push(value);

        for mutation in mutations {
            assert!(mutation
                .validate_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &material.command_envelope_sha256,
                )
                .is_err());
        }
        assert!(material
            .validate_for(
                &fixture_request_id('7'),
                &source_edit_id,
                &artifact_hash,
                &proof_id,
                &material.command_envelope_sha256,
            )
            .is_err());
        assert!(material
            .validate_for(
                &request_id,
                &source_edit_id,
                &format!("sha256:{}", "1".repeat(64)),
                &proof_id,
                &material.command_envelope_sha256,
            )
            .is_err());
        assert!(material
            .validate_for(
                &request_id,
                &source_edit_id,
                &artifact_hash,
                &proof_id,
                &format!("sha256:{}", "2".repeat(64)),
            )
            .is_err());

        let mut oversized = material;
        oversized.proof_json_base64 = "*".repeat(GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES + 1);
        assert_eq!(
            oversized
                .validate_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &oversized.command_envelope_sha256,
                )
                .unwrap_err(),
            "protected GPU runtime proof exceeds the protocol encoded-byte limit"
        );
    }

    #[test]
    fn cold_gpu_artifact_load_terminal_is_correlated_but_never_claims_hmr() {
        let request_id = fixture_request_id('5');
        let source_edit_id = source_edit_id();
        let artifact_hash = format!("sha256:{}", "d".repeat(64));
        let loaded =
            GpuArtifactLoadV1Result::loaded(&request_id, &source_edit_id, &artifact_hash).unwrap();
        let decoded = GpuArtifactLoadV1Result::from_json(&loaded.to_json().unwrap()).unwrap();
        assert!(decoded.matches(&request_id, &source_edit_id, &artifact_hash));
        assert!(!decoded.accepted_for_gpu_hmr);
        assert!(!decoded.gpu_hmr_success);

        let rejected = GpuArtifactLoadV1Result::rejected(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "artifact bytes mismatched",
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert!(!rejected.gpu_hmr_success);
    }

    #[test]
    fn module_load_result_is_content_process_and_control_session_bound() {
        let request_id = format!("runner-module-load:request:{}", "a".repeat(32));
        let artifact_hash = format!("sha256:{}", "b".repeat(64));
        let control_session = format!("runner-control-session:{}", "c".repeat(32));
        let result = RunnerModuleLoadResultV1::applied(
            &request_id,
            "open vocabulary module",
            &artifact_hash,
            &control_session,
            7,
            "linux_sealed_memfd_procfs_v1",
        )
        .unwrap();
        let line = result.line().unwrap();
        let parsed = parse_runner_module_load_result(&line).unwrap();

        assert!(parsed.matches_expected(
            &request_id,
            "open vocabulary module",
            &artifact_hash,
            std::process::id(),
            &control_session,
            7,
            "linux_sealed_memfd_procfs_v1",
        ));
        assert!(!parsed.matches_expected(
            &request_id,
            "open vocabulary module",
            &artifact_hash,
            std::process::id(),
            &control_session,
            7,
            "declared_but_unobserved_mechanism_v9",
        ));
        assert_eq!(
            parsed.loaded_artifact_content_hash.as_deref(),
            Some(artifact_hash.as_str())
        );
        assert_eq!(parsed.loader_epoch, Some(7));
        assert!(parsed.post_load_hash_verified);
        assert!(!parsed.accepted_for_hmr);
        assert!(!parsed.accepted_for_gpu_hmr);
        assert!(!parsed.hmr_success);
        assert!(!parsed.gpu_hmr_success);
        assert!(parsed.proof_authority.contains("not_hmr_acceptance"));
    }

    #[test]
    fn module_load_result_rejects_forged_authority_and_receipt_identity() {
        let request_id = format!("runner-module-load:request:{}", "d".repeat(32));
        let artifact_hash = format!("sha256:{}", "e".repeat(64));
        let control_session = format!("runner-control-session:{}", "f".repeat(32));
        let result = RunnerModuleLoadResultV1::applied(
            request_id,
            "module",
            artifact_hash,
            control_session,
            1,
            "linux_sealed_memfd_procfs_v1",
        )
        .unwrap();

        let mut forged = result.clone();
        forged.accepted_for_hmr = true;
        assert!(forged.validate().is_err());

        let mut replayed = result;
        replayed.runner_pid = replayed.runner_pid.saturating_add(1);
        assert!(replayed.validate().is_err());

        let mut forged_epoch = replayed.clone();
        forged_epoch.runner_pid = std::process::id();
        forged_epoch.loader_epoch = Some(2);
        assert!(forged_epoch.validate().is_err());
    }

    #[test]
    fn module_load_command_tokens_round_trip_whitespace_without_routing_labels() {
        let value = "nested path/with spaces/arbitrary.module";
        let encoded = encode_runner_module_load_token(value);
        assert!(!encoded.chars().any(char::is_whitespace));
        assert_eq!(
            decode_runner_module_load_token(&encoded).as_deref(),
            Some(value)
        );
    }
}
