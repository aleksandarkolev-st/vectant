use serde::Serialize;
use sha2::{Digest, Sha256};

pub const TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.transport_access_unit_observation.v1";
pub const TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION: &str =
    "synthi.gpu_hmr.length_prefixed_transport_record.v1";

const PAYLOAD_DOMAIN: &str = "synthi.gpu_hmr.transport_access_unit_payload.v1";
const BOUNDARY_WITNESS_DOMAIN: &str = "synthi.gpu_hmr.transport_access_unit_boundary_witness.v1";
const STREAM_IDENTITY_DOMAIN: &str = "synthi.gpu_hmr.transport_stream_identity.v1";
const NATIVE_IDENTITY_DOMAIN: &str = "synthi.gpu_hmr.native_transport_identity.v1";
const OBSERVATION_DOMAIN: &str = "synthi.gpu_hmr.transport_access_unit_observation_hash.v1";
const OBSERVATION_ID_PREFIX: &str = "transport-access-unit-observation:sha256:";
const SUPPORT_ONLY_AUTHORITY: &str =
    "transport_access_unit_observation_only_not_gpu_hmr_acceptance";

#[derive(Debug, Clone, Copy)]
pub struct TransportAccessUnitFragment<'a> {
    pub payload: &'a [u8],
    pub native_boundary_witness: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct TransportAccessUnitObservationInput<'a> {
    pub stream_instance_identity: &'a [u8],
    pub access_unit_ordinal: u64,
    pub native_transport_identity: &'a [u8],
    pub fragments: &'a [TransportAccessUnitFragment<'a>],
    pub observed_at_monotonic_ns: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportAccessUnitObservation {
    schema_version: String,
    canonicalization_version: String,
    stream_instance_identity_sha256: String,
    access_unit_ordinal: String,
    native_transport_identity_sha256: String,
    fragment_count: String,
    total_payload_byte_length: String,
    transport_payload_commitment_sha256: String,
    native_boundary_witness_commitment_sha256: String,
    observed_at_monotonic_ns: String,
    canonical_observation_sha256: String,
    observation_id: String,
    proof_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
}

impl TransportAccessUnitObservation {
    pub fn new(input: TransportAccessUnitObservationInput<'_>) -> Result<Self, String> {
        require_identity(input.stream_instance_identity, "stream_instance_identity")?;
        require_identity(input.native_transport_identity, "native_transport_identity")?;
        if input.fragments.is_empty() {
            return Err("transport_access_unit_observation_fragments_empty".to_string());
        }

        let fragment_count = u64::try_from(input.fragments.len())
            .map_err(|_| "transport_access_unit_observation_fragment_count_overflow".to_string())?;
        let total_payload_byte_length = checked_total_payload_byte_length(input.fragments)?;

        let transport_payload_commitment_sha256 =
            payload_commitment_sha256(input.fragments, fragment_count)?;
        let native_boundary_witness_commitment_sha256 =
            boundary_witness_commitment_sha256(input.fragments, fragment_count)?;
        let stream_instance_identity_sha256 =
            identity_commitment_sha256(STREAM_IDENTITY_DOMAIN, input.stream_instance_identity)?;
        let native_transport_identity_sha256 =
            identity_commitment_sha256(NATIVE_IDENTITY_DOMAIN, input.native_transport_identity)?;
        let canonical_observation_sha256 = observation_sha256(
            &stream_instance_identity_sha256,
            input.access_unit_ordinal,
            &native_transport_identity_sha256,
            fragment_count,
            total_payload_byte_length,
            &transport_payload_commitment_sha256,
            &native_boundary_witness_commitment_sha256,
            input.observed_at_monotonic_ns,
        )?;
        let observation_id = format!(
            "{OBSERVATION_ID_PREFIX}{}",
            canonical_observation_sha256
                .strip_prefix("sha256:")
                .expect("prefixed sha256")
        );

        Ok(Self {
            schema_version: TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA_VERSION.to_string(),
            canonicalization_version: TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION
                .to_string(),
            stream_instance_identity_sha256,
            access_unit_ordinal: input.access_unit_ordinal.to_string(),
            native_transport_identity_sha256,
            fragment_count: fragment_count.to_string(),
            total_payload_byte_length: total_payload_byte_length.to_string(),
            transport_payload_commitment_sha256,
            native_boundary_witness_commitment_sha256,
            observed_at_monotonic_ns: input.observed_at_monotonic_ns.to_string(),
            canonical_observation_sha256,
            observation_id,
            proof_authority: SUPPORT_ONLY_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
        })
    }

    pub fn transport_payload_commitment_sha256(&self) -> &str {
        &self.transport_payload_commitment_sha256
    }

    pub fn native_boundary_witness_commitment_sha256(&self) -> &str {
        &self.native_boundary_witness_commitment_sha256
    }

    pub fn canonical_observation_sha256(&self) -> &str {
        &self.canonical_observation_sha256
    }

    pub fn observation_id(&self) -> &str {
        &self.observation_id
    }

    pub fn accepted_for_gpu_hmr(&self) -> bool {
        false
    }

    pub fn gpu_hmr_success(&self) -> bool {
        false
    }

    pub fn can_satisfy_runtime_proof(&self) -> bool {
        false
    }
}

fn require_identity(value: &[u8], field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("transport_access_unit_observation_{field}_invalid"));
    }
    Ok(())
}

fn checked_total_payload_byte_length(
    fragments: &[TransportAccessUnitFragment<'_>],
) -> Result<u64, String> {
    fragments.iter().try_fold(0_u64, |total, fragment| {
        if fragment.native_boundary_witness.is_empty() {
            return Err("transport_access_unit_observation_boundary_witness_empty".to_string());
        }
        let length = u64::try_from(fragment.payload.len()).map_err(|_| {
            "transport_access_unit_observation_fragment_length_overflow".to_string()
        })?;
        checked_add_payload_length(total, length)
    })
}

fn checked_add_payload_length(total: u64, length: u64) -> Result<u64, String> {
    total.checked_add(length).ok_or_else(|| {
        "transport_access_unit_observation_total_payload_length_overflow".to_string()
    })
}

fn payload_commitment_sha256(
    fragments: &[TransportAccessUnitFragment<'_>],
    fragment_count: u64,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, PAYLOAD_DOMAIN.as_bytes())?;
    update_length_prefixed(
        &mut hasher,
        TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION.as_bytes(),
    )?;
    update_u64(&mut hasher, fragment_count);
    for fragment in fragments {
        update_length_prefixed(&mut hasher, fragment.payload)?;
    }
    Ok(prefixed_sha256_digest(hasher.finalize()))
}

fn boundary_witness_commitment_sha256(
    fragments: &[TransportAccessUnitFragment<'_>],
    fragment_count: u64,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, BOUNDARY_WITNESS_DOMAIN.as_bytes())?;
    update_length_prefixed(
        &mut hasher,
        TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION.as_bytes(),
    )?;
    update_u64(&mut hasher, fragment_count);
    for fragment in fragments {
        update_length_prefixed(&mut hasher, fragment.native_boundary_witness)?;
    }
    Ok(prefixed_sha256_digest(hasher.finalize()))
}

fn identity_commitment_sha256(domain: &str, identity: &[u8]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, domain.as_bytes())?;
    update_length_prefixed(
        &mut hasher,
        TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION.as_bytes(),
    )?;
    update_length_prefixed(&mut hasher, identity)?;
    Ok(prefixed_sha256_digest(hasher.finalize()))
}

fn observation_sha256(
    stream_instance_identity_sha256: &str,
    access_unit_ordinal: u64,
    native_transport_identity_sha256: &str,
    fragment_count: u64,
    total_payload_byte_length: u64,
    transport_payload_commitment_sha256: &str,
    native_boundary_witness_commitment_sha256: &str,
    observed_at_monotonic_ns: u128,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, OBSERVATION_DOMAIN.as_bytes())?;
    update_length_prefixed(
        &mut hasher,
        TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA_VERSION.as_bytes(),
    )?;
    update_length_prefixed(
        &mut hasher,
        TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION.as_bytes(),
    )?;
    update_length_prefixed(&mut hasher, stream_instance_identity_sha256.as_bytes())?;
    update_u64(&mut hasher, access_unit_ordinal);
    update_length_prefixed(&mut hasher, native_transport_identity_sha256.as_bytes())?;
    update_u64(&mut hasher, fragment_count);
    update_u64(&mut hasher, total_payload_byte_length);
    update_length_prefixed(&mut hasher, transport_payload_commitment_sha256.as_bytes())?;
    update_length_prefixed(
        &mut hasher,
        native_boundary_witness_commitment_sha256.as_bytes(),
    )?;
    update_u128(&mut hasher, observed_at_monotonic_ns);
    Ok(prefixed_sha256_digest(hasher.finalize()))
}

fn update_length_prefixed(hasher: &mut Sha256, value: &[u8]) -> Result<(), String> {
    let length = u64::try_from(value.len())
        .map_err(|_| "transport_access_unit_observation_length_prefix_overflow".to_string())?;
    update_u64(hasher, length);
    hasher.update(value);
    Ok(())
}

fn update_u64(hasher: &mut Sha256, value: u64) {
    hasher.update(value.to_be_bytes());
}

fn update_u128(hasher: &mut Sha256, value: u128) {
    hasher.update(value.to_be_bytes());
}

fn prefixed_sha256_digest(digest: impl AsRef<[u8]>) -> String {
    format!("sha256:{}", hex::encode(digest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fragment<'a>(
        payload: &'a [u8],
        native_boundary_witness: &'a [u8],
    ) -> TransportAccessUnitFragment<'a> {
        TransportAccessUnitFragment {
            payload,
            native_boundary_witness,
        }
    }

    fn observation(
        fragments: &[TransportAccessUnitFragment<'_>],
    ) -> TransportAccessUnitObservation {
        TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
            stream_instance_identity: b"stream:\x00\x9e\x31",
            access_unit_ordinal: 7,
            native_transport_identity: b"native:\x00\x4a\xc2",
            fragments,
            observed_at_monotonic_ns: u128::MAX - 5,
        })
        .expect("valid observation")
    }

    #[test]
    fn ordered_fragments_change_the_commitment_and_observation() {
        let first = observation(&[fragment(b"alpha", b"seq:1"), fragment(b"beta", b"seq:2")]);
        let second = observation(&[fragment(b"beta", b"seq:2"), fragment(b"alpha", b"seq:1")]);

        assert_ne!(
            first.transport_payload_commitment_sha256(),
            second.transport_payload_commitment_sha256()
        );
        assert_ne!(
            first.canonical_observation_sha256(),
            second.canonical_observation_sha256()
        );
    }

    #[test]
    fn fragment_boundaries_are_unambiguous() {
        let first = observation(&[fragment(b"ab", b"part:1"), fragment(b"c", b"part:2")]);
        let second = observation(&[fragment(b"a", b"part:1"), fragment(b"bc", b"part:2")]);

        assert_ne!(
            first.transport_payload_commitment_sha256(),
            second.transport_payload_commitment_sha256()
        );
    }

    #[test]
    fn native_boundary_witnesses_bind_the_observed_transport_grouping() {
        let first = observation(&[
            fragment(b"same", b"sequence:17;marker:0"),
            fragment(b"payload", b"sequence:18;marker:1"),
        ]);
        let second = observation(&[
            fragment(b"same", b"sequence:27;marker:0"),
            fragment(b"payload", b"sequence:28;marker:1"),
        ]);

        assert_eq!(
            first.transport_payload_commitment_sha256(),
            second.transport_payload_commitment_sha256()
        );
        assert_ne!(
            first.native_boundary_witness_commitment_sha256(),
            second.native_boundary_witness_commitment_sha256()
        );
        assert_ne!(
            first.canonical_observation_sha256(),
            second.canonical_observation_sha256()
        );
    }

    #[test]
    fn serialization_and_hashes_are_deterministic() {
        let fragments = [fragment(b"one", b"part:0"), fragment(b"two", b"part:1")];
        let first = observation(&fragments);
        let second = observation(&fragments);

        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_string(&first).expect("serialize first"),
            serde_json::to_string(&second).expect("serialize second")
        );
        assert!(first.canonical_observation_sha256().starts_with("sha256:"));
        assert!(first.observation_id().starts_with(OBSERVATION_ID_PREFIX));
    }

    #[test]
    fn matches_cross_language_golden_vector() {
        let fragments = [
            fragment(b"", &[0x00]),
            fragment(&[0x00, 0x01, 0xff], &[0xff, 0x00]),
        ];
        let value = serde_json::to_value(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                stream_instance_identity: &[0x73, 0x00, 0xff],
                access_unit_ordinal: 0,
                native_transport_identity: &[0x6e, 0x00, 0x80],
                fragments: &fragments,
                observed_at_monotonic_ns: u128::MAX - 5,
            })
            .expect("golden observation"),
        )
        .expect("serialize golden observation");

        assert_eq!(
            value["streamInstanceIdentitySha256"],
            "sha256:550dcbeb81190154f4bfcafbe03ce1557e98032322647d10c2a3ec9cab464295"
        );
        assert_eq!(
            value["nativeTransportIdentitySha256"],
            "sha256:a2fcc2026c960ee9a8862011388da87aa36d4d7e29fb9072e942aa48445c10b5"
        );
        assert_eq!(
            value["transportPayloadCommitmentSha256"],
            "sha256:94c34a8c4d285460e490edb400648174202ed2927ee4ff16398db4f8363a0acc"
        );
        assert_eq!(
            value["nativeBoundaryWitnessCommitmentSha256"],
            "sha256:8f9a59a23f38c67c34d0fac65127bcb84aec742a4ea08c4a70898e9dc5e83f94"
        );
        assert_eq!(
            value["canonicalObservationSha256"],
            "sha256:bdfa6fa1e923e51dd81039548d3633870b77268e48b27094275e99752a0b6617"
        );
        assert_eq!(
            value["observationId"],
            "transport-access-unit-observation:sha256:bdfa6fa1e923e51dd81039548d3633870b77268e48b27094275e99752a0b6617"
        );
        assert_eq!(value["accessUnitOrdinal"], "0");
        assert_eq!(value["fragmentCount"], "2");
        assert_eq!(value["totalPayloadByteLength"], "3");
        assert_eq!(
            value["observedAtMonotonicNs"],
            "340282366920938463463374607431768211450"
        );
    }

    #[test]
    fn invalid_inputs_and_overflow_fail_closed() {
        let fragments = [fragment(b"payload", b"boundary")];
        let base = TransportAccessUnitObservationInput {
            stream_instance_identity: b"stream:\x00\x9e\x31",
            access_unit_ordinal: 0,
            native_transport_identity: b"native:\x00\x4a\xc2",
            fragments: &fragments,
            observed_at_monotonic_ns: 1,
        };
        assert!(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                fragments: &[],
                ..base
            })
            .is_err()
        );
        assert!(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                stream_instance_identity: b"",
                ..base
            })
            .is_err()
        );
        assert!(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                native_transport_identity: b"",
                ..base
            })
            .is_err()
        );
        let missing_witness = [fragment(b"payload", b"")];
        assert!(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                fragments: &missing_witness,
                ..base
            })
            .is_err()
        );
        assert_eq!(
            checked_add_payload_length(u64::MAX, 1).unwrap_err(),
            "transport_access_unit_observation_total_payload_length_overflow"
        );

        let empty_payload = [fragment(b"", b"boundary")];
        assert!(
            TransportAccessUnitObservation::new(TransportAccessUnitObservationInput {
                fragments: &empty_payload,
                ..base
            })
            .is_ok()
        );
    }

    #[test]
    fn serialized_shape_is_support_only_and_contains_only_canonical_fields() {
        let value = serde_json::to_value(observation(&[fragment(b"payload", b"boundary")]))
            .expect("serialize");
        let object = value.as_object().expect("object");
        let actual = object
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "schemaVersion",
            "canonicalizationVersion",
            "streamInstanceIdentitySha256",
            "accessUnitOrdinal",
            "nativeTransportIdentitySha256",
            "fragmentCount",
            "totalPayloadByteLength",
            "transportPayloadCommitmentSha256",
            "nativeBoundaryWitnessCommitmentSha256",
            "observedAtMonotonicNs",
            "canonicalObservationSha256",
            "observationId",
            "proofAuthority",
            "acceptedForGpuHmr",
            "gpuHmrSuccess",
            "canSatisfyRuntimeProof",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(actual, expected);
        assert_eq!(object.get("acceptedForGpuHmr"), Some(&Value::Bool(false)));
        assert_eq!(object.get("gpuHmrSuccess"), Some(&Value::Bool(false)));
        assert_eq!(
            object.get("canSatisfyRuntimeProof"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            object.get("proofAuthority"),
            Some(&Value::String(SUPPORT_ONLY_AUTHORITY.to_string()))
        );
        assert_eq!(
            object.get("accessUnitOrdinal"),
            Some(&Value::String("7".to_string()))
        );
        assert_eq!(
            object.get("observedAtMonotonicNs"),
            Some(&Value::String((u128::MAX - 5).to_string()))
        );
        let serialized = serde_json::to_string(&observation(&[fragment(
            b"opaque-fragment-content",
            b"opaque-boundary-content",
        )]))
        .expect("serialize observation");
        assert!(!serialized.contains("opaque-fragment-content"));
        assert!(!serialized.contains("opaque-boundary-content"));
        assert!(!serialized.contains("stream:"));
        assert!(!serialized.contains("native:"));
    }
}
