use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::{collections::HashMap, fmt, sync::Mutex};

pub const CLOSED_EXECUTION_PROTOCOL_VERSION: u16 = 1;
pub const CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES: usize = 512;

const WIRE_MAGIC: [u8; 8] = *b"SYCEHMR1";
const HEADER_BYTES: usize = 16;
const DIGEST_BYTES: usize = 32;
const SECRET_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;
const CHALLENGE_PAYLOAD_BYTES: usize = DIGEST_BYTES * 3 + SIGNATURE_BYTES + 16;
const ACQUIRE_PAYLOAD_BYTES: usize = DIGEST_BYTES * 9 + 16;
const GRANT_PAYLOAD_BYTES: usize = DIGEST_BYTES * 8 + SIGNATURE_BYTES + 16;
const ATTACH_PAYLOAD_BYTES: usize = DIGEST_BYTES * 3 + 8;
const ATTACHED_PAYLOAD_BYTES: usize = DIGEST_BYTES * 5 + SIGNATURE_BYTES + 8;
const FINALIZE_PAYLOAD_BYTES: usize = DIGEST_BYTES * 3 + 16;
const FINALIZED_PAYLOAD_BYTES: usize = DIGEST_BYTES * 6 + SIGNATURE_BYTES + 56;
const REFUSED_PAYLOAD_BYTES: usize = DIGEST_BYTES * 3 + SIGNATURE_BYTES + 16;
const MAX_ACTIVE_TRANSCRIPTS: usize = 65_536;
#[cfg(target_os = "linux")]
const LINUX_SCM_PIDFD: libc::c_int = 0x04;

const CHALLENGE_BINDING_DOMAIN: &[u8] = b"synthi.closed_execution.challenge_binding.v1";
const CHALLENGE_SIGNATURE_DOMAIN: &[u8] = b"synthi.closed_execution.challenge_signature.v1";
const KERNEL_PEER_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.kernel_peer_identity.v1";
const KERNEL_RECORD_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.kernel_record_identity.v1";
const REQUEST_ID_DOMAIN: &[u8] = b"synthi.closed_execution.acquire_request.v1";
const LEASE_ID_DOMAIN: &[u8] = b"synthi.closed_execution.lease.v1";
const FINALIZATION_ID_DOMAIN: &[u8] = b"synthi.closed_execution.finalization.v1";
const LEASE_SECRET_COMMITMENT_DOMAIN: &[u8] = b"synthi.closed_execution.lease_secret_commitment.v1";
const ATTACH_REQUEST_AUTHENTICATION_DOMAIN: &[u8] =
    b"synthi.closed_execution.attach_request_authentication.v1";
const FINALIZE_REQUEST_AUTHENTICATION_DOMAIN: &[u8] =
    b"synthi.closed_execution.finalize_request_authentication.v1";
const SUPERVISOR_KEY_ID_DOMAIN: &[u8] = b"synthi.closed_execution.supervisor_key.v1";
const OFFER_SIGNATURE_DOMAIN: &[u8] = b"synthi.closed_execution.lease_offer_signature.v1";
const ATTACHED_SIGNATURE_DOMAIN: &[u8] = b"synthi.closed_execution.attached_signature.v1";
const FINALIZED_SIGNATURE_DOMAIN: &[u8] = b"synthi.closed_execution.finalized_signature.v1";
const REFUSED_SIGNATURE_DOMAIN: &[u8] = b"synthi.closed_execution.refused_signature.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
enum MessageKind {
    Acquire = 1,
    Granted = 2,
    Attach = 3,
    Attached = 4,
    Finalize = 5,
    Finalized = 6,
    Refused = 7,
    Challenge = 8,
}

impl MessageKind {
    fn from_wire(value: u16) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Acquire),
            2 => Ok(Self::Granted),
            3 => Ok(Self::Attach),
            4 => Ok(Self::Attached),
            5 => Ok(Self::Finalize),
            6 => Ok(Self::Finalized),
            7 => Ok(Self::Refused),
            8 => Ok(Self::Challenge),
            _ => Err(ProtocolError::UnknownMessageKind),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FinalizeReason {
    LeaderExited = 1,
    DeadlineReached = 2,
    ObserverAborted = 3,
}

impl FinalizeReason {
    fn from_wire(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::LeaderExited),
            2 => Ok(Self::DeadlineReached),
            3 => Ok(Self::ObserverAborted),
            _ => Err(ProtocolError::InvalidField),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum RefusalCode {
    InvalidRequest = 1,
    LeaseUnavailable = 2,
    LeaseAlreadyConsumed = 3,
    PeerIdentityUnavailable = 4,
    ProcessSetUnavailable = 5,
    ProcessAttachmentFailed = 6,
    ProcessAttachmentNotObserved = 7,
    MigrationProtectionMissing = 8,
    ProcessSetTerminationFailed = 9,
    ProcessSetNotQuiescent = 10,
    DeadlineReached = 11,
    InternalInvariantFailed = 12,
}

impl RefusalCode {
    fn from_wire(value: u32) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::InvalidRequest),
            2 => Ok(Self::LeaseUnavailable),
            3 => Ok(Self::LeaseAlreadyConsumed),
            4 => Ok(Self::PeerIdentityUnavailable),
            5 => Ok(Self::ProcessSetUnavailable),
            6 => Ok(Self::ProcessAttachmentFailed),
            7 => Ok(Self::ProcessAttachmentNotObserved),
            8 => Ok(Self::MigrationProtectionMissing),
            9 => Ok(Self::ProcessSetTerminationFailed),
            10 => Ok(Self::ProcessSetNotQuiescent),
            11 => Ok(Self::DeadlineReached),
            12 => Ok(Self::InternalInvariantFailed),
            _ => Err(ProtocolError::InvalidField),
        }
    }

    fn requires_lease(self) -> bool {
        !matches!(self, Self::InvalidRequest | Self::LeaseUnavailable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    RecordTooLarge,
    TruncatedRecord,
    InvalidMagic,
    UnsupportedVersion,
    UnknownMessageKind,
    InvalidPayloadLength,
    InvalidField,
    IntegrityMismatch,
    AuthenticationFailed,
    ReplayDetected,
    DeadlineReached,
    UnexpectedLeasePhase,
    CapacityExceeded,
    PeerIdentityUnavailable,
    TransportUnavailable,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::RecordTooLarge => "closed_execution_protocol_record_too_large",
            Self::TruncatedRecord => "closed_execution_protocol_record_truncated",
            Self::InvalidMagic => "closed_execution_protocol_magic_invalid",
            Self::UnsupportedVersion => "closed_execution_protocol_version_unsupported",
            Self::UnknownMessageKind => "closed_execution_protocol_message_kind_unknown",
            Self::InvalidPayloadLength => "closed_execution_protocol_payload_length_invalid",
            Self::InvalidField => "closed_execution_protocol_field_invalid",
            Self::IntegrityMismatch => "closed_execution_protocol_integrity_mismatch",
            Self::AuthenticationFailed => "closed_execution_protocol_authentication_failed",
            Self::ReplayDetected => "closed_execution_protocol_replay_detected",
            Self::DeadlineReached => "closed_execution_protocol_deadline_reached",
            Self::UnexpectedLeasePhase => "closed_execution_protocol_lease_phase_invalid",
            Self::CapacityExceeded => "closed_execution_protocol_capacity_exceeded",
            Self::PeerIdentityUnavailable => "closed_execution_protocol_peer_identity_unavailable",
            Self::TransportUnavailable => "closed_execution_protocol_transport_unavailable",
        };
        formatter.write_str(code)
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProtocolDigest([u8; DIGEST_BYTES]);

impl ProtocolDigest {
    const ZERO: Self = Self([0; DIGEST_BYTES]);

    pub fn from_bytes(bytes: [u8; DIGEST_BYTES]) -> Result<Self, ProtocolError> {
        if bytes == [0; DIGEST_BYTES] {
            return Err(ProtocolError::InvalidField);
        }
        Ok(Self(bytes))
    }

    pub fn hash_identity(value: &str) -> Result<Self, ProtocolError> {
        if value.is_empty() || value.len() > 4096 || value.as_bytes().contains(&0) {
            return Err(ProtocolError::InvalidField);
        }
        Ok(hash_fields(
            b"synthi.closed_execution.identity.v1",
            &[value.as_bytes()],
        ))
    }

    pub fn hash_bytes(domain: &[u8], bytes: &[u8]) -> Result<Self, ProtocolError> {
        if domain.is_empty() || domain.len() > 256 || domain.contains(&0) {
            return Err(ProtocolError::InvalidField);
        }
        Ok(hash_fields(domain, &[bytes]))
    }

    pub fn as_bytes(&self) -> &[u8; DIGEST_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ProtocolDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProtocolDigest")
            .field(&hex::encode(self.0))
            .finish()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ProtocolSignature([u8; SIGNATURE_BYTES]);

impl ProtocolSignature {
    fn from_bytes(bytes: [u8; SIGNATURE_BYTES]) -> Self {
        Self(bytes)
    }

    fn as_bytes(&self) -> &[u8; SIGNATURE_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ProtocolSignature {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProtocolSignature([REDACTED])")
    }
}

struct SupervisorSigner(Ed25519KeyPair);

impl SupervisorSigner {
    fn generate() -> Result<Self, ProtocolError> {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| ProtocolError::AuthenticationFailed)?;
        let key_pair = Ed25519KeyPair::from_pkcs8(document.as_ref())
            .map_err(|_| ProtocolError::AuthenticationFailed)?;
        Ok(Self(key_pair))
    }

    #[cfg(test)]
    fn from_seed(seed: [u8; SECRET_BYTES]) -> Result<Self, ProtocolError> {
        if seed == [0; SECRET_BYTES] {
            return Err(ProtocolError::InvalidField);
        }
        Ed25519KeyPair::from_seed_unchecked(&seed)
            .map(Self)
            .map_err(|_| ProtocolError::AuthenticationFailed)
    }

    fn verifier(&self) -> SupervisorVerifier {
        let mut public_key = [0u8; DIGEST_BYTES];
        public_key.copy_from_slice(self.0.public_key().as_ref());
        SupervisorVerifier { public_key }
    }

    fn sign(&self, domain: &[u8], fields: &[&[u8]]) -> ProtocolSignature {
        let payload = authentication_payload(domain, fields);
        ProtocolSignature::from_bytes(
            self.0
                .sign(&payload)
                .as_ref()
                .try_into()
                .expect("Ed25519 signature length"),
        )
    }
}

impl fmt::Debug for SupervisorSigner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SupervisorSigner([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorVerifier {
    public_key: [u8; DIGEST_BYTES],
}

impl SupervisorVerifier {
    pub fn from_public_key(public_key: [u8; DIGEST_BYTES]) -> Result<Self, ProtocolError> {
        if public_key == [0; DIGEST_BYTES] {
            return Err(ProtocolError::InvalidField);
        }
        Ok(Self { public_key })
    }

    pub fn public_key(&self) -> &[u8; DIGEST_BYTES] {
        &self.public_key
    }

    pub fn key_id(&self) -> ProtocolDigest {
        hash_fields(SUPERVISOR_KEY_ID_DOMAIN, &[&self.public_key])
    }

    fn verify(&self, domain: &[u8], fields: &[&[u8]], signature: ProtocolSignature) -> bool {
        let payload = authentication_payload(domain, fields);
        UnparsedPublicKey::new(&ED25519, &self.public_key)
            .verify(&payload, signature.as_bytes())
            .is_ok()
    }
}

/// Connection-time credentials captured by the kernel for an observed Unix
/// peer. These values are not a live credential query; the retained pidfd is
/// revalidated before each snapshot is returned.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelPeerCredentials {
    connection_uid: libc::uid_t,
    connection_gid: libc::gid_t,
}

#[cfg(target_os = "linux")]
impl KernelPeerCredentials {
    pub fn connection_uid(&self) -> libc::uid_t {
        self.connection_uid
    }

    pub fn connection_gid(&self) -> libc::gid_t {
        self.connection_gid
    }
}

/// A non-serializable peer identity obtained from the supervisor transport's
/// kernel credential observation. The protocol deliberately has no production
/// constructor from a digest or wire record; Linux construction consumes a
/// message-preserving socket and retains its pidfd for the full session.
pub struct KernelPeerProcessObservation {
    process_identity: ProtocolDigest,
    #[cfg(target_os = "linux")]
    peer_pid: libc::pid_t,
    #[cfg(target_os = "linux")]
    peer_uid: libc::uid_t,
    #[cfg(target_os = "linux")]
    peer_gid: libc::gid_t,
    #[cfg(target_os = "linux")]
    peer_pidfd: OwnedFd,
    #[cfg(target_os = "linux")]
    record_socket: Mutex<OwnedFd>,
    #[cfg(target_os = "linux")]
    send_socket: OwnedFd,
    #[cfg(all(test, target_os = "linux"))]
    _test_sender: Option<OwnedFd>,
}

impl KernelPeerProcessObservation {
    #[cfg(test)]
    fn for_test(process_identity: ProtocolDigest) -> Self {
        #[cfg(target_os = "linux")]
        {
            let (record_socket, test_sender) =
                unix_seqpacket_pair().expect("test kernel credential transport");
            let record_socket = configure_unix_record_socket(record_socket)
                .expect("configured test kernel credential transport");
            let send_socket = record_socket
                .try_clone()
                .expect("duplicated test kernel credential transport");
            let (peer_pid, peer_uid, peer_gid, peer_pidfd) =
                unix_peer_process(record_socket.as_raw_fd()).expect("test peer pidfd");
            return Self {
                process_identity,
                peer_pid,
                peer_uid,
                peer_gid,
                peer_pidfd,
                record_socket: Mutex::new(record_socket),
                send_socket,
                _test_sender: Some(test_sender),
            };
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self { process_identity }
        }
    }

    fn process_identity(&self) -> ProtocolDigest {
        self.process_identity
    }

    fn ensure_kernel_bound(&self) -> Result<(), ProtocolError> {
        #[cfg(target_os = "linux")]
        {
            ensure_pidfd_live(&self.peer_pidfd)?;
            if pidfd_process_id(&self.peer_pidfd)? != self.peer_pid {
                return Err(ProtocolError::PeerIdentityUnavailable);
            }
            return Ok(());
        }
        #[cfg(all(test, not(target_os = "linux")))]
        {
            Ok(())
        }
        #[cfg(all(not(test), not(target_os = "linux")))]
        {
            Err(ProtocolError::PeerIdentityUnavailable)
        }
    }

    #[cfg(target_os = "linux")]
    pub fn connection_credentials(&self) -> Result<KernelPeerCredentials, ProtocolError> {
        self.ensure_kernel_bound()?;
        Ok(KernelPeerCredentials {
            connection_uid: self.peer_uid,
            connection_gid: self.peer_gid,
        })
    }

    #[cfg(target_os = "linux")]
    pub fn send_record(
        &self,
        record: &EncodedProtocolRecord,
        deadline_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        self.ensure_kernel_bound()?;
        send_unix_record(
            self.send_socket.as_raw_fd(),
            self.peer_pidfd.as_raw_fd(),
            record.as_bytes(),
            deadline_monotonic_ns,
        )
    }

    #[cfg(target_os = "linux")]
    pub fn receive_record(&self) -> Result<KernelAuthenticatedProtocolRecord, ProtocolError> {
        self.ensure_kernel_bound()?;
        let socket = self
            .record_socket
            .lock()
            .map_err(|_| ProtocolError::PeerIdentityUnavailable)?;
        let (record_bytes, credentials, sender_pidfd) = receive_unix_record(socket.as_raw_fd())?;
        ensure_pidfd_live(&sender_pidfd)?;
        if credentials.pid != self.peer_pid
            || credentials.uid != self.peer_uid
            || credentials.gid != self.peer_gid
            || pidfd_process_id(&sender_pidfd)? != self.peer_pid
        {
            return Err(ProtocolError::AuthenticationFailed);
        }
        let record_identity = hash_fields(KERNEL_RECORD_IDENTITY_DOMAIN, &[&record_bytes]);
        let message = ClosedExecutionMessage::decode_untrusted(&record_bytes)?;
        Ok(KernelAuthenticatedProtocolRecord {
            peer_process_identity: self.process_identity,
            record_identity,
            message,
        })
    }
}

impl fmt::Debug for KernelPeerProcessObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelPeerProcessObservation")
            .field("process_identity", &self.process_identity)
            .field("kernel_bound", &{
                #[cfg(target_os = "linux")]
                {
                    true
                }
                #[cfg(not(target_os = "linux"))]
                {
                    false
                }
            })
            .finish_non_exhaustive()
    }
}

/// A one-use decoded record whose sender was authenticated by kernel-provided
/// per-message credentials and pidfd on the observation's owned socket.
pub struct KernelAuthenticatedProtocolRecord {
    peer_process_identity: ProtocolDigest,
    record_identity: ProtocolDigest,
    message: ClosedExecutionMessage,
}

impl KernelAuthenticatedProtocolRecord {
    #[cfg(test)]
    fn for_test(
        peer_process_identity: ProtocolDigest,
        message: ClosedExecutionMessage,
    ) -> Result<Self, ProtocolError> {
        let encoded = message.encode()?;
        Ok(Self {
            peer_process_identity,
            record_identity: hash_fields(KERNEL_RECORD_IDENTITY_DOMAIN, &[encoded.as_bytes()]),
            message,
        })
    }

    fn into_message(
        self,
        peer: &KernelPeerProcessObservation,
    ) -> Result<ClosedExecutionMessage, ProtocolError> {
        peer.ensure_kernel_bound()?;
        if self.peer_process_identity != peer.process_identity() {
            return Err(ProtocolError::AuthenticationFailed);
        }
        let encoded = self.message.encode()?;
        let expected_identity = hash_fields(KERNEL_RECORD_IDENTITY_DOMAIN, &[encoded.as_bytes()]);
        if expected_identity != self.record_identity {
            return Err(ProtocolError::IntegrityMismatch);
        }
        Ok(self.message)
    }
}

impl fmt::Debug for KernelAuthenticatedProtocolRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelAuthenticatedProtocolRecord")
            .field("peer_process_identity", &self.peer_process_identity)
            .field("record_identity", &self.record_identity)
            .field("message", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy)]
struct ChallengeRegistration {
    peer_process_identity: ProtocolDigest,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
}

#[derive(Debug, Default)]
struct ReplayRegistryState {
    issued_challenges: HashMap<ProtocolDigest, ChallengeRegistration>,
    issued_requests: HashMap<ProtocolDigest, u64>,
    consumed_leases: HashMap<ProtocolDigest, u64>,
}

/// Supervisor-owned replay state. One instance must span every connection
/// served by a supervisor process; untrusted records cannot construct it.
#[derive(Debug, Default)]
struct SupervisorReplayRegistry {
    state: Mutex<ReplayRegistryState>,
}

impl SupervisorReplayRegistry {
    fn new() -> Self {
        Self::default()
    }

    fn register_challenge(
        &self,
        challenge_binding: ProtocolDigest,
        registration: ChallengeRegistration,
        now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProtocolError::IntegrityMismatch)?;
        Self::prune_expired(&mut state, now_monotonic_ns);
        if state.issued_challenges.contains_key(&challenge_binding) {
            return Err(ProtocolError::ReplayDetected);
        }
        if state.issued_challenges.len() >= MAX_ACTIVE_TRANSCRIPTS {
            return Err(ProtocolError::CapacityExceeded);
        }
        state
            .issued_challenges
            .insert(challenge_binding, registration);
        Ok(())
    }

    fn consume_challenge_and_claim_request(
        &self,
        request: &AcquireLeaseRequest,
        observed_peer_process_identity: ProtocolDigest,
        now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProtocolError::IntegrityMismatch)?;
        let registration = state
            .issued_challenges
            .get(&request.challenge_binding)
            .copied();
        Self::prune_expired(&mut state, now_monotonic_ns);
        if state.issued_requests.contains_key(&request.request_id) {
            return Err(ProtocolError::ReplayDetected);
        }
        let registration = registration.ok_or(ProtocolError::AuthenticationFailed)?;
        if now_monotonic_ns < registration.issued_monotonic_ns {
            return Err(ProtocolError::InvalidField);
        }
        if now_monotonic_ns >= registration.expires_monotonic_ns {
            return Err(ProtocolError::DeadlineReached);
        }
        if request.peer_process_identity != registration.peer_process_identity
            || registration.peer_process_identity != observed_peer_process_identity
            || registration.expires_monotonic_ns != request.challenge_expires_monotonic_ns
        {
            return Err(ProtocolError::AuthenticationFailed);
        }
        if state.issued_requests.len() >= MAX_ACTIVE_TRANSCRIPTS {
            return Err(ProtocolError::CapacityExceeded);
        }
        state.issued_challenges.remove(&request.challenge_binding);
        state
            .issued_requests
            .insert(request.request_id, request.challenge_expires_monotonic_ns);
        Ok(())
    }

    fn claim_lease(
        &self,
        lease_id: ProtocolDigest,
        lease_expires_monotonic_ns: u64,
        now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProtocolError::IntegrityMismatch)?;
        Self::prune_expired(&mut state, now_monotonic_ns);
        if state.consumed_leases.contains_key(&lease_id) {
            return Err(ProtocolError::ReplayDetected);
        }
        if state.consumed_leases.len() >= MAX_ACTIVE_TRANSCRIPTS {
            return Err(ProtocolError::CapacityExceeded);
        }
        state
            .consumed_leases
            .insert(lease_id, lease_expires_monotonic_ns);
        Ok(())
    }

    fn prune_expired(state: &mut ReplayRegistryState, now_monotonic_ns: u64) {
        state
            .issued_challenges
            .retain(|_, value| value.expires_monotonic_ns > now_monotonic_ns);
        state
            .issued_requests
            .retain(|_, expires| *expires > now_monotonic_ns);
        state
            .consumed_leases
            .retain(|_, expires| *expires > now_monotonic_ns);
    }
}

/// The only production owner of signing and replay state. It is process-local,
/// non-serializable, and must live for the full supervisor lifetime.
pub struct SupervisorAuthority {
    signer: SupervisorSigner,
    verifier: SupervisorVerifier,
    replay_registry: SupervisorReplayRegistry,
}

impl SupervisorAuthority {
    pub fn generate() -> Result<Self, ProtocolError> {
        Self::from_signer(SupervisorSigner::generate()?)
    }

    #[cfg(test)]
    fn from_seed(seed: [u8; SECRET_BYTES]) -> Result<Self, ProtocolError> {
        Self::from_signer(SupervisorSigner::from_seed(seed)?)
    }

    fn from_signer(signer: SupervisorSigner) -> Result<Self, ProtocolError> {
        let verifier = signer.verifier();
        Ok(Self {
            signer,
            verifier,
            replay_registry: SupervisorReplayRegistry::new(),
        })
    }

    pub fn verifier(&self) -> SupervisorVerifier {
        self.verifier.clone()
    }

    #[cfg(target_os = "linux")]
    pub fn observe_unix_peer(
        &self,
        record_socket: OwnedFd,
    ) -> Result<KernelPeerProcessObservation, ProtocolError> {
        let record_socket = configure_unix_record_socket(record_socket)?;
        let send_socket = record_socket
            .try_clone()
            .map_err(|_| ProtocolError::TransportUnavailable)?;
        let (pid, uid, gid, peer_pidfd) = unix_peer_process(record_socket.as_raw_fd())?;
        let mut observation_nonce = [0u8; DIGEST_BYTES];
        SystemRandom::new()
            .fill(&mut observation_nonce)
            .map_err(|_| ProtocolError::PeerIdentityUnavailable)?;
        let observation_nonce = ProtocolDigest::from_bytes(observation_nonce)
            .map_err(|_| ProtocolError::PeerIdentityUnavailable)?;
        let process_identity = hash_fields(
            KERNEL_PEER_IDENTITY_DOMAIN,
            &[
                self.verifier.key_id().as_bytes(),
                &pid.to_be_bytes(),
                &uid.to_be_bytes(),
                &gid.to_be_bytes(),
                observation_nonce.as_bytes(),
            ],
        );
        Ok(KernelPeerProcessObservation {
            process_identity,
            peer_pid: pid,
            peer_uid: uid,
            peer_gid: gid,
            peer_pidfd,
            record_socket: Mutex::new(record_socket),
            send_socket,
            #[cfg(test)]
            _test_sender: None,
        })
    }

    pub fn issue_challenge(
        &self,
        peer: &KernelPeerProcessObservation,
        issued_monotonic_ns: u64,
        expires_monotonic_ns: u64,
    ) -> Result<AcquisitionChallenge, ProtocolError> {
        peer.ensure_kernel_bound()?;
        let mut nonce = [0u8; DIGEST_BYTES];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| ProtocolError::AuthenticationFailed)?;
        let nonce = ProtocolDigest::from_bytes(nonce)?;
        self.issue_challenge_with_nonce(peer, nonce, issued_monotonic_ns, expires_monotonic_ns)
    }

    fn issue_challenge_with_nonce(
        &self,
        peer: &KernelPeerProcessObservation,
        nonce: ProtocolDigest,
        issued_monotonic_ns: u64,
        expires_monotonic_ns: u64,
    ) -> Result<AcquisitionChallenge, ProtocolError> {
        peer.ensure_kernel_bound()?;
        AcquisitionChallenge::issue(
            peer.process_identity(),
            nonce,
            issued_monotonic_ns,
            expires_monotonic_ns,
            &self.signer,
            &self.replay_registry,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn issue_offer(
        &self,
        record: KernelAuthenticatedProtocolRecord,
        peer: &KernelPeerProcessObservation,
        server_nonce: ProtocolDigest,
        lease_secret: &LeaseSecret,
        supervisor_instance: ProtocolDigest,
        process_set_identity: ProtocolDigest,
        granted_monotonic_ns: u64,
    ) -> Result<LeaseOffer, ProtocolError> {
        let ClosedExecutionMessage::Acquire(request) = record.into_message(peer)? else {
            return Err(ProtocolError::InvalidField);
        };
        LeaseOffer::issue(
            &request,
            peer.process_identity(),
            server_nonce,
            lease_secret,
            supervisor_instance,
            process_set_identity,
            granted_monotonic_ns,
            &self.signer,
            &self.replay_registry,
        )
    }

    pub fn begin_lease(
        &self,
        request: &AcquireLeaseRequest,
        grant: &LeaseGrant,
        verifier_now_monotonic_ns: u64,
    ) -> Result<LeaseReplayGuard, ProtocolError> {
        LeaseReplayGuard::new(request, grant, verifier_now_monotonic_ns, self)
    }

    pub fn attached(
        &self,
        record: KernelAuthenticatedProtocolRecord,
        peer: &KernelPeerProcessObservation,
        process_set_identity: ProtocolDigest,
        attached_monotonic_ns: u64,
    ) -> Result<LeaseAttached, ProtocolError> {
        let ClosedExecutionMessage::Attach(request) = record.into_message(peer)? else {
            return Err(ProtocolError::InvalidField);
        };
        LeaseAttached::new(
            request.request_id(),
            request.lease_id(),
            peer.process_identity(),
            process_set_identity,
            attached_monotonic_ns,
            &self.signer,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finalized(
        &self,
        record: KernelAuthenticatedProtocolRecord,
        process_set_identity: ProtocolDigest,
        peer: &KernelPeerProcessObservation,
        attached_before_exec: bool,
        migration_protection_observed: bool,
        process_set_kill_issued: bool,
        process_set_quiescent: bool,
        attached_monotonic_ns: u64,
        kill_issued_monotonic_ns: u64,
        quiescent_monotonic_ns: u64,
        finalized_monotonic_ns: u64,
    ) -> Result<LeaseFinalized, ProtocolError> {
        let ClosedExecutionMessage::Finalize(request) = record.into_message(peer)? else {
            return Err(ProtocolError::InvalidField);
        };
        LeaseFinalized::new(
            request.request_id(),
            request.lease_id(),
            process_set_identity,
            peer.process_identity(),
            request.reason(),
            attached_before_exec,
            migration_protection_observed,
            process_set_kill_issued,
            process_set_quiescent,
            attached_monotonic_ns,
            request.requested_monotonic_ns(),
            kill_issued_monotonic_ns,
            quiescent_monotonic_ns,
            finalized_monotonic_ns,
            &self.signer,
        )
    }

    pub fn refused(
        &self,
        request_id: ProtocolDigest,
        lease_id: Option<ProtocolDigest>,
        code: RefusalCode,
        observed_monotonic_ns: u64,
    ) -> Result<LeaseRefused, ProtocolError> {
        LeaseRefused::new(
            request_id,
            lease_id,
            code,
            observed_monotonic_ns,
            &self.signer,
        )
    }
}

impl fmt::Debug for SupervisorAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorAuthority")
            .field("supervisor_key_id", &self.verifier.key_id())
            .field("private_state", &"[REDACTED]")
            .finish()
    }
}

#[derive(PartialEq, Eq)]
pub struct LeaseSecret([u8; SECRET_BYTES]);

impl LeaseSecret {
    pub fn from_bytes(bytes: [u8; SECRET_BYTES]) -> Result<Self, ProtocolError> {
        if bytes == [0; SECRET_BYTES] {
            return Err(ProtocolError::InvalidField);
        }
        Ok(Self(bytes))
    }

    fn as_bytes(&self) -> &[u8; SECRET_BYTES] {
        &self.0
    }

    fn duplicate(&self) -> Self {
        Self(self.0)
    }
}

impl fmt::Debug for LeaseSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LeaseSecret([REDACTED])")
    }
}

impl Drop for LeaseSecret {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquisitionChallenge {
    challenge_binding: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
    signature: ProtocolSignature,
}

impl AcquisitionChallenge {
    fn issue(
        peer_process_identity: ProtocolDigest,
        nonce: ProtocolDigest,
        issued_monotonic_ns: u64,
        expires_monotonic_ns: u64,
        signer: &SupervisorSigner,
        replay_registry: &SupervisorReplayRegistry,
    ) -> Result<Self, ProtocolError> {
        if issued_monotonic_ns == 0 || expires_monotonic_ns <= issued_monotonic_ns {
            return Err(ProtocolError::InvalidField);
        }
        let supervisor_key_id = signer.verifier().key_id();
        let challenge_binding = derive_challenge_binding(
            peer_process_identity,
            supervisor_key_id,
            nonce,
            issued_monotonic_ns,
            expires_monotonic_ns,
        );
        replay_registry.register_challenge(
            challenge_binding,
            ChallengeRegistration {
                peer_process_identity,
                issued_monotonic_ns,
                expires_monotonic_ns,
            },
            issued_monotonic_ns,
        )?;
        let signature = challenge_signature(
            signer,
            challenge_binding,
            peer_process_identity,
            supervisor_key_id,
            issued_monotonic_ns,
            expires_monotonic_ns,
        );
        Ok(Self {
            challenge_binding,
            peer_process_identity,
            supervisor_key_id,
            issued_monotonic_ns,
            expires_monotonic_ns,
            signature,
        })
    }

    pub fn challenge_binding(&self) -> ProtocolDigest {
        self.challenge_binding
    }

    pub fn peer_process_identity(&self) -> ProtocolDigest {
        self.peer_process_identity
    }

    pub fn expires_monotonic_ns(&self) -> u64 {
        self.expires_monotonic_ns
    }

    fn integrity_valid(&self) -> bool {
        self.issued_monotonic_ns > 0 && self.expires_monotonic_ns > self.issued_monotonic_ns
    }

    fn verify(&self, verifier: &SupervisorVerifier, verifier_now_monotonic_ns: u64) -> bool {
        self.integrity_valid()
            && self.issued_monotonic_ns <= verifier_now_monotonic_ns
            && verifier_now_monotonic_ns < self.expires_monotonic_ns
            && self.supervisor_key_id == verifier.key_id()
            && verify_challenge_signature(verifier, self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquireLeaseRequest {
    request_id: ProtocolDigest,
    request_nonce: ProtocolDigest,
    challenge_binding: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    invocation: ProtocolDigest,
    executable_snapshot: ProtocolDigest,
    execution_closure: ProtocolDigest,
    execution_policy: ProtocolDigest,
    capability_probe: ProtocolDigest,
    kernel_deadline_monotonic_ns: u64,
    challenge_expires_monotonic_ns: u64,
}

impl AcquireLeaseRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        request_nonce: ProtocolDigest,
        challenge: &AcquisitionChallenge,
        supervisor_verifier: &SupervisorVerifier,
        invocation: ProtocolDigest,
        executable_snapshot: ProtocolDigest,
        execution_closure: ProtocolDigest,
        execution_policy: ProtocolDigest,
        capability_probe: ProtocolDigest,
        kernel_deadline_monotonic_ns: u64,
        verifier_now_monotonic_ns: u64,
    ) -> Result<Self, ProtocolError> {
        if !challenge.verify(supervisor_verifier, verifier_now_monotonic_ns) {
            return Err(ProtocolError::AuthenticationFailed);
        }
        let challenge_binding = challenge.challenge_binding;
        let peer_process_identity = challenge.peer_process_identity;
        let challenge_expires_monotonic_ns = challenge.expires_monotonic_ns;
        if kernel_deadline_monotonic_ns == 0
            || challenge_expires_monotonic_ns == 0
            || kernel_deadline_monotonic_ns > challenge_expires_monotonic_ns
        {
            return Err(ProtocolError::InvalidField);
        }
        let request_id = derive_request_id(
            request_nonce,
            challenge_binding,
            peer_process_identity,
            invocation,
            executable_snapshot,
            execution_closure,
            execution_policy,
            capability_probe,
            kernel_deadline_monotonic_ns,
            challenge_expires_monotonic_ns,
        );
        Ok(Self {
            request_id,
            request_nonce,
            challenge_binding,
            peer_process_identity,
            invocation,
            executable_snapshot,
            execution_closure,
            execution_policy,
            capability_probe,
            kernel_deadline_monotonic_ns,
            challenge_expires_monotonic_ns,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn from_wire(
        request_id: ProtocolDigest,
        request_nonce: ProtocolDigest,
        challenge_binding: ProtocolDigest,
        peer_process_identity: ProtocolDigest,
        invocation: ProtocolDigest,
        executable_snapshot: ProtocolDigest,
        execution_closure: ProtocolDigest,
        execution_policy: ProtocolDigest,
        capability_probe: ProtocolDigest,
        kernel_deadline_monotonic_ns: u64,
        challenge_expires_monotonic_ns: u64,
    ) -> Self {
        Self {
            request_id,
            request_nonce,
            challenge_binding,
            peer_process_identity,
            invocation,
            executable_snapshot,
            execution_closure,
            execution_policy,
            capability_probe,
            kernel_deadline_monotonic_ns,
            challenge_expires_monotonic_ns,
        }
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn kernel_deadline_monotonic_ns(&self) -> u64 {
        self.kernel_deadline_monotonic_ns
    }

    pub fn challenge_expires_monotonic_ns(&self) -> u64 {
        self.challenge_expires_monotonic_ns
    }

    fn integrity_valid(&self) -> bool {
        self.kernel_deadline_monotonic_ns > 0
            && self.kernel_deadline_monotonic_ns <= self.challenge_expires_monotonic_ns
            && self.request_id
                == derive_request_id(
                    self.request_nonce,
                    self.challenge_binding,
                    self.peer_process_identity,
                    self.invocation,
                    self.executable_snapshot,
                    self.execution_closure,
                    self.execution_policy,
                    self.capability_probe,
                    self.kernel_deadline_monotonic_ns,
                    self.challenge_expires_monotonic_ns,
                )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseOffer {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    lease_secret_commitment: ProtocolDigest,
    server_nonce: ProtocolDigest,
    supervisor_instance: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    granted_monotonic_ns: u64,
    lease_expires_monotonic_ns: u64,
    signature: ProtocolSignature,
}

impl LeaseOffer {
    #[allow(clippy::too_many_arguments)]
    fn issue(
        request: &AcquireLeaseRequest,
        observed_peer_process_identity: ProtocolDigest,
        server_nonce: ProtocolDigest,
        lease_secret: &LeaseSecret,
        supervisor_instance: ProtocolDigest,
        process_set_identity: ProtocolDigest,
        granted_monotonic_ns: u64,
        signer: &SupervisorSigner,
        replay_registry: &SupervisorReplayRegistry,
    ) -> Result<Self, ProtocolError> {
        if !request.integrity_valid()
            || granted_monotonic_ns == 0
            || granted_monotonic_ns >= request.kernel_deadline_monotonic_ns
        {
            return Err(ProtocolError::InvalidField);
        }
        replay_registry.consume_challenge_and_claim_request(
            request,
            observed_peer_process_identity,
            granted_monotonic_ns,
        )?;
        let lease_secret_commitment = secret_commitment(lease_secret);
        let supervisor_key_id = signer.verifier().key_id();
        let lease_id = derive_lease_id(
            request.request_id,
            observed_peer_process_identity,
            server_nonce,
            lease_secret_commitment,
            supervisor_instance,
            process_set_identity,
            granted_monotonic_ns,
            request.kernel_deadline_monotonic_ns,
        );
        let signature = offer_signature(
            signer,
            request.request_id,
            lease_id,
            observed_peer_process_identity,
            lease_secret_commitment,
            server_nonce,
            supervisor_instance,
            process_set_identity,
            supervisor_key_id,
            granted_monotonic_ns,
            request.kernel_deadline_monotonic_ns,
        );
        Ok(Self {
            request_id: request.request_id,
            lease_id,
            peer_process_identity: observed_peer_process_identity,
            lease_secret_commitment,
            server_nonce,
            supervisor_instance,
            process_set_identity,
            supervisor_key_id,
            granted_monotonic_ns,
            lease_expires_monotonic_ns: request.kernel_deadline_monotonic_ns,
            signature,
        })
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.lease_id
    }

    pub fn process_set_identity(&self) -> ProtocolDigest {
        self.process_set_identity
    }

    pub fn lease_expires_monotonic_ns(&self) -> u64 {
        self.lease_expires_monotonic_ns
    }

    fn integrity_valid(&self) -> bool {
        self.granted_monotonic_ns > 0
            && self.granted_monotonic_ns < self.lease_expires_monotonic_ns
            && self.lease_id
                == derive_lease_id(
                    self.request_id,
                    self.peer_process_identity,
                    self.server_nonce,
                    self.lease_secret_commitment,
                    self.supervisor_instance,
                    self.process_set_identity,
                    self.granted_monotonic_ns,
                    self.lease_expires_monotonic_ns,
                )
    }

    fn verify(&self, verifier: &SupervisorVerifier) -> bool {
        self.integrity_valid()
            && self.supervisor_key_id == verifier.key_id()
            && verify_offer_signature(verifier, self)
    }

    fn verify_for_request(
        &self,
        request: &AcquireLeaseRequest,
        verifier: &SupervisorVerifier,
    ) -> bool {
        request.integrity_valid()
            && self.request_id == request.request_id
            && self.peer_process_identity == request.peer_process_identity
            && self.lease_expires_monotonic_ns == request.kernel_deadline_monotonic_ns
            && self.granted_monotonic_ns < request.kernel_deadline_monotonic_ns
            && self.verify(verifier)
    }
}

/// A locally bound offer. The secret must arrive through an authenticated,
/// out-of-band sealed descriptor; it never appears in protocol record bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct LeaseGrant {
    offer: LeaseOffer,
    lease_secret: LeaseSecret,
    supervisor_verifier: SupervisorVerifier,
}

impl LeaseGrant {
    pub fn bind(
        request: &AcquireLeaseRequest,
        offer: LeaseOffer,
        lease_secret: LeaseSecret,
        supervisor_verifier: SupervisorVerifier,
    ) -> Result<Self, ProtocolError> {
        if !offer.integrity_valid() {
            return Err(ProtocolError::IntegrityMismatch);
        }
        if !offer.verify_for_request(request, &supervisor_verifier) {
            return Err(ProtocolError::AuthenticationFailed);
        }
        if offer.lease_secret_commitment != secret_commitment(&lease_secret) {
            return Err(ProtocolError::AuthenticationFailed);
        }
        Ok(Self {
            offer,
            lease_secret,
            supervisor_verifier,
        })
    }

    pub fn offer(&self) -> &LeaseOffer {
        &self.offer
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.offer.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.offer.lease_id
    }

    pub fn supervisor_verifier(&self) -> &SupervisorVerifier {
        &self.supervisor_verifier
    }

    pub fn process_set_identity(&self) -> ProtocolDigest {
        self.offer.process_set_identity
    }

    pub fn peer_process_identity(&self) -> ProtocolDigest {
        self.offer.peer_process_identity
    }

    pub fn lease_expires_monotonic_ns(&self) -> u64 {
        self.offer.lease_expires_monotonic_ns
    }

    fn integrity_valid(&self) -> bool {
        self.offer.integrity_valid()
            && self.offer.verify(&self.supervisor_verifier)
            && self.offer.lease_secret_commitment == secret_commitment(&self.lease_secret)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachLeaseRequest {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    kernel_deadline_monotonic_ns: u64,
    authentication_tag: ProtocolDigest,
}

impl AttachLeaseRequest {
    pub fn from_grant(grant: &LeaseGrant) -> Result<Self, ProtocolError> {
        if !grant.integrity_valid() {
            return Err(ProtocolError::InvalidField);
        }
        Ok(Self {
            request_id: grant.offer.request_id,
            lease_id: grant.offer.lease_id,
            kernel_deadline_monotonic_ns: grant.offer.lease_expires_monotonic_ns,
            authentication_tag: attach_request_authentication_tag(
                &grant.lease_secret,
                grant.offer.request_id,
                grant.offer.lease_id,
                grant.offer.lease_expires_monotonic_ns,
            ),
        })
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.lease_id
    }

    pub fn kernel_deadline_monotonic_ns(&self) -> u64 {
        self.kernel_deadline_monotonic_ns
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseAttached {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    attached_monotonic_ns: u64,
    signature: ProtocolSignature,
}

impl LeaseAttached {
    fn new(
        request_id: ProtocolDigest,
        lease_id: ProtocolDigest,
        peer_process_identity: ProtocolDigest,
        process_set_identity: ProtocolDigest,
        attached_monotonic_ns: u64,
        signer: &SupervisorSigner,
    ) -> Result<Self, ProtocolError> {
        if attached_monotonic_ns == 0 {
            return Err(ProtocolError::InvalidField);
        }
        let supervisor_key_id = signer.verifier().key_id();
        let signature = attached_signature(
            signer,
            request_id,
            lease_id,
            peer_process_identity,
            process_set_identity,
            supervisor_key_id,
            attached_monotonic_ns,
        );
        Ok(Self {
            request_id,
            lease_id,
            peer_process_identity,
            process_set_identity,
            supervisor_key_id,
            attached_monotonic_ns,
            signature,
        })
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.lease_id
    }

    pub fn peer_process_identity(&self) -> ProtocolDigest {
        self.peer_process_identity
    }

    pub fn process_set_identity(&self) -> ProtocolDigest {
        self.process_set_identity
    }

    fn verify(&self, grant: &LeaseGrant) -> bool {
        grant.integrity_valid()
            && self.request_id == grant.request_id()
            && self.lease_id == grant.lease_id()
            && self.peer_process_identity == grant.peer_process_identity()
            && self.process_set_identity == grant.process_set_identity()
            && self.attached_monotonic_ns >= grant.offer.granted_monotonic_ns
            && self.attached_monotonic_ns < grant.lease_expires_monotonic_ns()
            && self.supervisor_key_id == grant.supervisor_verifier.key_id()
            && verify_attached_signature(&grant.supervisor_verifier, self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeLeaseRequest {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    reason: FinalizeReason,
    requested_monotonic_ns: u64,
    authentication_tag: ProtocolDigest,
}

impl FinalizeLeaseRequest {
    pub fn from_grant(
        grant: &LeaseGrant,
        reason: FinalizeReason,
        requested_monotonic_ns: u64,
    ) -> Result<Self, ProtocolError> {
        if !grant.integrity_valid() || requested_monotonic_ns == 0 {
            return Err(ProtocolError::InvalidField);
        }
        match reason {
            FinalizeReason::DeadlineReached
                if requested_monotonic_ns < grant.lease_expires_monotonic_ns() =>
            {
                return Err(ProtocolError::InvalidField);
            }
            FinalizeReason::LeaderExited | FinalizeReason::ObserverAborted
                if requested_monotonic_ns >= grant.lease_expires_monotonic_ns() =>
            {
                return Err(ProtocolError::DeadlineReached);
            }
            _ => {}
        }
        Ok(Self {
            request_id: grant.offer.request_id,
            lease_id: grant.offer.lease_id,
            reason,
            requested_monotonic_ns,
            authentication_tag: finalize_request_authentication_tag(
                &grant.lease_secret,
                grant.offer.request_id,
                grant.offer.lease_id,
                reason,
                requested_monotonic_ns,
            ),
        })
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.lease_id
    }

    pub fn reason(&self) -> FinalizeReason {
        self.reason
    }

    pub fn requested_monotonic_ns(&self) -> u64 {
        self.requested_monotonic_ns
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseFinalized {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    finalization_id: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    signature: ProtocolSignature,
    reason: FinalizeReason,
    attached_before_exec: bool,
    migration_protection_observed: bool,
    process_set_kill_issued: bool,
    process_set_quiescent: bool,
    attached_monotonic_ns: u64,
    finalize_requested_monotonic_ns: u64,
    kill_issued_monotonic_ns: u64,
    quiescent_monotonic_ns: u64,
    finalized_monotonic_ns: u64,
}

impl LeaseFinalized {
    #[allow(clippy::too_many_arguments)]
    fn new(
        request_id: ProtocolDigest,
        lease_id: ProtocolDigest,
        process_set_identity: ProtocolDigest,
        peer_process_identity: ProtocolDigest,
        reason: FinalizeReason,
        attached_before_exec: bool,
        migration_protection_observed: bool,
        process_set_kill_issued: bool,
        process_set_quiescent: bool,
        attached_monotonic_ns: u64,
        finalize_requested_monotonic_ns: u64,
        kill_issued_monotonic_ns: u64,
        quiescent_monotonic_ns: u64,
        finalized_monotonic_ns: u64,
        signer: &SupervisorSigner,
    ) -> Result<Self, ProtocolError> {
        if !attached_before_exec
            || !migration_protection_observed
            || !process_set_kill_issued
            || !process_set_quiescent
            || attached_monotonic_ns == 0
            || finalize_requested_monotonic_ns < attached_monotonic_ns
            || kill_issued_monotonic_ns < finalize_requested_monotonic_ns
            || quiescent_monotonic_ns < kill_issued_monotonic_ns
            || finalized_monotonic_ns < quiescent_monotonic_ns
        {
            return Err(ProtocolError::InvalidField);
        }
        let supervisor_key_id = signer.verifier().key_id();
        let finalization_id = derive_finalization_id(
            request_id,
            lease_id,
            process_set_identity,
            peer_process_identity,
            reason,
            attached_monotonic_ns,
            finalize_requested_monotonic_ns,
            kill_issued_monotonic_ns,
            quiescent_monotonic_ns,
            finalized_monotonic_ns,
        );
        let signature = finalized_signature(
            signer,
            request_id,
            lease_id,
            process_set_identity,
            peer_process_identity,
            finalization_id,
            supervisor_key_id,
            reason,
            attached_before_exec,
            migration_protection_observed,
            process_set_kill_issued,
            process_set_quiescent,
            attached_monotonic_ns,
            finalize_requested_monotonic_ns,
            kill_issued_monotonic_ns,
            quiescent_monotonic_ns,
            finalized_monotonic_ns,
        );
        Ok(Self {
            request_id,
            lease_id,
            process_set_identity,
            peer_process_identity,
            finalization_id,
            supervisor_key_id,
            signature,
            reason,
            attached_before_exec,
            migration_protection_observed,
            process_set_kill_issued,
            process_set_quiescent,
            attached_monotonic_ns,
            finalize_requested_monotonic_ns,
            kill_issued_monotonic_ns,
            quiescent_monotonic_ns,
            finalized_monotonic_ns,
        })
    }

    pub fn finalization_id(&self) -> ProtocolDigest {
        self.finalization_id
    }

    pub fn request_id(&self) -> ProtocolDigest {
        self.request_id
    }

    pub fn lease_id(&self) -> ProtocolDigest {
        self.lease_id
    }

    fn verify(&self, grant: &LeaseGrant) -> bool {
        self.integrity_valid()
            && grant.integrity_valid()
            && self.request_id == grant.request_id()
            && self.lease_id == grant.lease_id()
            && self.peer_process_identity == grant.peer_process_identity()
            && self.process_set_identity == grant.process_set_identity()
            && self.supervisor_key_id == grant.supervisor_verifier.key_id()
            && self.attached_monotonic_ns >= grant.offer.granted_monotonic_ns
            && self.finalized_monotonic_ns >= self.attached_monotonic_ns
            && match self.reason {
                FinalizeReason::DeadlineReached => {
                    self.finalize_requested_monotonic_ns >= grant.lease_expires_monotonic_ns()
                        && self.kill_issued_monotonic_ns >= grant.lease_expires_monotonic_ns()
                }
                FinalizeReason::LeaderExited | FinalizeReason::ObserverAborted => {
                    self.finalize_requested_monotonic_ns < grant.lease_expires_monotonic_ns()
                        && self.kill_issued_monotonic_ns < grant.lease_expires_monotonic_ns()
                }
            }
            && verify_finalized_signature(&grant.supervisor_verifier, self)
    }

    fn integrity_valid(&self) -> bool {
        self.attached_before_exec
            && self.migration_protection_observed
            && self.process_set_kill_issued
            && self.process_set_quiescent
            && self.attached_monotonic_ns > 0
            && self.finalize_requested_monotonic_ns >= self.attached_monotonic_ns
            && self.kill_issued_monotonic_ns >= self.finalize_requested_monotonic_ns
            && self.quiescent_monotonic_ns >= self.kill_issued_monotonic_ns
            && self.finalized_monotonic_ns >= self.quiescent_monotonic_ns
            && self.finalization_id
                == derive_finalization_id(
                    self.request_id,
                    self.lease_id,
                    self.process_set_identity,
                    self.peer_process_identity,
                    self.reason,
                    self.attached_monotonic_ns,
                    self.finalize_requested_monotonic_ns,
                    self.kill_issued_monotonic_ns,
                    self.quiescent_monotonic_ns,
                    self.finalized_monotonic_ns,
                )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRefused {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    code: RefusalCode,
    observed_monotonic_ns: u64,
    signature: ProtocolSignature,
}

impl LeaseRefused {
    fn new(
        request_id: ProtocolDigest,
        lease_id: Option<ProtocolDigest>,
        code: RefusalCode,
        observed_monotonic_ns: u64,
        signer: &SupervisorSigner,
    ) -> Result<Self, ProtocolError> {
        if observed_monotonic_ns == 0 || code.requires_lease() != lease_id.is_some() {
            return Err(ProtocolError::InvalidField);
        }
        let lease_id = lease_id.unwrap_or(ProtocolDigest::ZERO);
        let supervisor_key_id = signer.verifier().key_id();
        let signature = refused_signature(
            signer,
            request_id,
            lease_id,
            supervisor_key_id,
            code,
            observed_monotonic_ns,
        );
        Ok(Self {
            request_id,
            lease_id,
            supervisor_key_id,
            code,
            observed_monotonic_ns,
            signature,
        })
    }

    pub fn verify_for_request(
        &self,
        request: &AcquireLeaseRequest,
        expected_lease_id: Option<ProtocolDigest>,
        verifier: &SupervisorVerifier,
        verifier_now_monotonic_ns: u64,
    ) -> bool {
        self.integrity_valid()
            && request.integrity_valid()
            && self.request_id == request.request_id
            && self.lease_id == expected_lease_id.unwrap_or(ProtocolDigest::ZERO)
            && self.observed_monotonic_ns <= verifier_now_monotonic_ns
            && self.observed_monotonic_ns <= request.challenge_expires_monotonic_ns
            && self.supervisor_key_id == verifier.key_id()
            && verify_refused_signature(verifier, self)
    }

    fn integrity_valid(&self) -> bool {
        self.observed_monotonic_ns > 0
            && self.code.requires_lease() == (self.lease_id != ProtocolDigest::ZERO)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Granted,
    AttachValidated,
    Attached,
    FinalizeRequested,
    Finalized,
}

/// One verifier-owned lease guard. It is intentionally neither serializable
/// nor reconstructible from a receipt. Structural decoding never advances it.
pub struct LeaseReplayGuard {
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    lease_secret: LeaseSecret,
    supervisor_verifier: SupervisorVerifier,
    process_set_identity: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    granted_monotonic_ns: u64,
    lease_expires_monotonic_ns: u64,
    attach_validated_monotonic_ns: Option<u64>,
    attached_peer_process_identity: Option<ProtocolDigest>,
    attached_monotonic_ns: Option<u64>,
    finalize_reason: Option<FinalizeReason>,
    finalize_requested_monotonic_ns: Option<u64>,
    finalize_validated_monotonic_ns: Option<u64>,
    phase: LeasePhase,
}

impl fmt::Debug for LeaseReplayGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LeaseReplayGuard")
            .field("request_id", &self.request_id)
            .field("lease_id", &self.lease_id)
            .field(
                "lease_expires_monotonic_ns",
                &self.lease_expires_monotonic_ns,
            )
            .field("phase", &self.phase)
            .finish()
    }
}

impl LeaseReplayGuard {
    fn new(
        request: &AcquireLeaseRequest,
        grant: &LeaseGrant,
        verifier_now_monotonic_ns: u64,
        authority: &SupervisorAuthority,
    ) -> Result<Self, ProtocolError> {
        if !request.integrity_valid()
            || !grant.integrity_valid()
            || request.request_id != grant.request_id()
            || request.peer_process_identity != grant.peer_process_identity()
        {
            return Err(ProtocolError::IntegrityMismatch);
        }
        if grant.supervisor_verifier != authority.verifier {
            return Err(ProtocolError::AuthenticationFailed);
        }
        if verifier_now_monotonic_ns < grant.offer.granted_monotonic_ns
            || verifier_now_monotonic_ns >= grant.lease_expires_monotonic_ns()
        {
            return Err(ProtocolError::DeadlineReached);
        }
        authority.replay_registry.claim_lease(
            grant.lease_id(),
            grant.lease_expires_monotonic_ns(),
            verifier_now_monotonic_ns,
        )?;
        Ok(Self {
            request_id: grant.request_id(),
            lease_id: grant.lease_id(),
            lease_secret: grant.lease_secret.duplicate(),
            supervisor_verifier: grant.supervisor_verifier.clone(),
            process_set_identity: grant.process_set_identity(),
            peer_process_identity: grant.peer_process_identity(),
            granted_monotonic_ns: grant.offer.granted_monotonic_ns,
            lease_expires_monotonic_ns: grant.lease_expires_monotonic_ns(),
            attach_validated_monotonic_ns: None,
            attached_peer_process_identity: None,
            attached_monotonic_ns: None,
            finalize_reason: None,
            finalize_requested_monotonic_ns: None,
            finalize_validated_monotonic_ns: None,
            phase: LeasePhase::Granted,
        })
    }

    pub fn validate_attach(
        &mut self,
        request: &AttachLeaseRequest,
        verifier_now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        if self.phase != LeasePhase::Granted {
            return Err(ProtocolError::UnexpectedLeasePhase);
        }
        if verifier_now_monotonic_ns >= self.lease_expires_monotonic_ns
            || request.kernel_deadline_monotonic_ns != self.lease_expires_monotonic_ns
        {
            return Err(ProtocolError::DeadlineReached);
        }
        if request.request_id != self.request_id || request.lease_id != self.lease_id {
            return Err(ProtocolError::IntegrityMismatch);
        }
        if !verify_authentication_tag(
            &self.lease_secret,
            ATTACH_REQUEST_AUTHENTICATION_DOMAIN,
            &[
                request.request_id.as_bytes(),
                request.lease_id.as_bytes(),
                &request.kernel_deadline_monotonic_ns.to_be_bytes(),
            ],
            request.authentication_tag,
        ) {
            return Err(ProtocolError::AuthenticationFailed);
        }
        self.attach_validated_monotonic_ns = Some(verifier_now_monotonic_ns);
        self.phase = LeasePhase::AttachValidated;
        Ok(())
    }

    pub fn validate_attached_response(
        &mut self,
        response: &LeaseAttached,
        verifier_now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        if self.phase != LeasePhase::AttachValidated {
            return Err(ProtocolError::UnexpectedLeasePhase);
        }
        if verifier_now_monotonic_ns >= self.lease_expires_monotonic_ns {
            return Err(ProtocolError::DeadlineReached);
        }
        let attach_validated_monotonic_ns = self
            .attach_validated_monotonic_ns
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        if response.attached_monotonic_ns < self.granted_monotonic_ns
            || response.attached_monotonic_ns < attach_validated_monotonic_ns
            || response.attached_monotonic_ns > verifier_now_monotonic_ns
        {
            return Err(ProtocolError::InvalidField);
        }
        if response.request_id != self.request_id
            || response.lease_id != self.lease_id
            || response.process_set_identity != self.process_set_identity
            || response.peer_process_identity != self.peer_process_identity
            || response.supervisor_key_id != self.supervisor_verifier.key_id()
            || !verify_attached_signature(&self.supervisor_verifier, response)
        {
            return Err(ProtocolError::AuthenticationFailed);
        }
        self.attached_peer_process_identity = Some(response.peer_process_identity);
        self.attached_monotonic_ns = Some(response.attached_monotonic_ns);
        self.phase = LeasePhase::Attached;
        Ok(())
    }

    pub fn validate_finalize(
        &mut self,
        request: &FinalizeLeaseRequest,
        verifier_now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        if self.phase != LeasePhase::Attached {
            return Err(ProtocolError::UnexpectedLeasePhase);
        }
        if request.request_id != self.request_id || request.lease_id != self.lease_id {
            return Err(ProtocolError::IntegrityMismatch);
        }
        if request.requested_monotonic_ns > verifier_now_monotonic_ns {
            return Err(ProtocolError::InvalidField);
        }
        let attached_monotonic_ns = self
            .attached_monotonic_ns
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        if request.requested_monotonic_ns < attached_monotonic_ns {
            return Err(ProtocolError::InvalidField);
        }
        match request.reason {
            FinalizeReason::DeadlineReached => {
                if request.requested_monotonic_ns < self.lease_expires_monotonic_ns
                    || verifier_now_monotonic_ns < self.lease_expires_monotonic_ns
                {
                    return Err(ProtocolError::InvalidField);
                }
            }
            FinalizeReason::LeaderExited | FinalizeReason::ObserverAborted => {
                if request.requested_monotonic_ns >= self.lease_expires_monotonic_ns
                    || verifier_now_monotonic_ns >= self.lease_expires_monotonic_ns
                {
                    return Err(ProtocolError::DeadlineReached);
                }
            }
        }
        if !verify_authentication_tag(
            &self.lease_secret,
            FINALIZE_REQUEST_AUTHENTICATION_DOMAIN,
            &[
                request.request_id.as_bytes(),
                request.lease_id.as_bytes(),
                &[request.reason as u8],
                &request.requested_monotonic_ns.to_be_bytes(),
            ],
            request.authentication_tag,
        ) {
            return Err(ProtocolError::AuthenticationFailed);
        }
        self.finalize_reason = Some(request.reason);
        self.finalize_requested_monotonic_ns = Some(request.requested_monotonic_ns);
        self.finalize_validated_monotonic_ns = Some(verifier_now_monotonic_ns);
        self.phase = LeasePhase::FinalizeRequested;
        Ok(())
    }

    pub fn validate_finalized_response(
        &mut self,
        response: &LeaseFinalized,
        verifier_now_monotonic_ns: u64,
    ) -> Result<(), ProtocolError> {
        if self.phase != LeasePhase::FinalizeRequested {
            return Err(ProtocolError::UnexpectedLeasePhase);
        }
        if response.finalized_monotonic_ns > verifier_now_monotonic_ns {
            return Err(ProtocolError::InvalidField);
        }
        let attached_peer_process_identity = self
            .attached_peer_process_identity
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        let attached_monotonic_ns = self
            .attached_monotonic_ns
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        let finalize_reason = self
            .finalize_reason
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        let finalize_requested_monotonic_ns = self
            .finalize_requested_monotonic_ns
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        let finalize_validated_monotonic_ns = self
            .finalize_validated_monotonic_ns
            .ok_or(ProtocolError::UnexpectedLeasePhase)?;
        if response.kill_issued_monotonic_ns < finalize_validated_monotonic_ns
            || response.kill_issued_monotonic_ns < finalize_requested_monotonic_ns
        {
            return Err(ProtocolError::InvalidField);
        }
        if response.request_id != self.request_id
            || response.lease_id != self.lease_id
            || response.process_set_identity != self.process_set_identity
            || response.peer_process_identity != self.peer_process_identity
            || response.peer_process_identity != attached_peer_process_identity
            || response.attached_monotonic_ns != attached_monotonic_ns
            || response.reason != finalize_reason
            || response.finalize_requested_monotonic_ns != finalize_requested_monotonic_ns
            || match response.reason {
                FinalizeReason::DeadlineReached => {
                    response.kill_issued_monotonic_ns < self.lease_expires_monotonic_ns
                }
                FinalizeReason::LeaderExited | FinalizeReason::ObserverAborted => {
                    response.kill_issued_monotonic_ns >= self.lease_expires_monotonic_ns
                }
            }
            || response.supervisor_key_id != self.supervisor_verifier.key_id()
            || !response.integrity_valid()
            || !verify_finalized_signature(&self.supervisor_verifier, response)
        {
            return Err(ProtocolError::AuthenticationFailed);
        }
        self.phase = LeasePhase::Finalized;
        Ok(())
    }
}

/// An encoded record that scrubs its backing allocation on drop. Decoding is
/// structural only; lease acceptance requires a live `LeaseReplayGuard` and,
/// for supervisor responses, signature verification against a pinned key.
pub struct EncodedProtocolRecord(Vec<u8>);

impl EncodedProtocolRecord {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for EncodedProtocolRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncodedProtocolRecord")
            .field("byte_length", &self.0.len())
            .field("bytes", &"[REDACTED]")
            .finish()
    }
}

impl AsRef<[u8]> for EncodedProtocolRecord {
    fn as_ref(&self) -> &[u8] {
        self.as_bytes()
    }
}

impl Drop for EncodedProtocolRecord {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClosedExecutionMessage {
    Challenge(AcquisitionChallenge),
    Acquire(AcquireLeaseRequest),
    Granted(LeaseOffer),
    Attach(AttachLeaseRequest),
    Attached(LeaseAttached),
    Finalize(FinalizeLeaseRequest),
    Finalized(LeaseFinalized),
    Refused(LeaseRefused),
}

impl ClosedExecutionMessage {
    pub fn encode(&self) -> Result<EncodedProtocolRecord, ProtocolError> {
        let (kind, payload) = match self {
            Self::Challenge(value) => {
                if !value.integrity_valid() {
                    return Err(ProtocolError::IntegrityMismatch);
                }
                (MessageKind::Challenge, encode_challenge(value))
            }
            Self::Acquire(value) => (MessageKind::Acquire, encode_acquire(value)),
            Self::Granted(value) => {
                if !value.integrity_valid() {
                    return Err(ProtocolError::IntegrityMismatch);
                }
                (MessageKind::Granted, encode_grant(value))
            }
            Self::Attach(value) => (MessageKind::Attach, encode_attach(value)),
            Self::Attached(value) => (MessageKind::Attached, encode_attached(value)),
            Self::Finalize(value) => (MessageKind::Finalize, encode_finalize(value)),
            Self::Finalized(value) => {
                if !value.integrity_valid() {
                    return Err(ProtocolError::IntegrityMismatch);
                }
                (MessageKind::Finalized, encode_finalized(value))
            }
            Self::Refused(value) => {
                if !value.integrity_valid() {
                    return Err(ProtocolError::IntegrityMismatch);
                }
                (MessageKind::Refused, encode_refused(value))
            }
        };
        if matches!(self, Self::Acquire(value) if !value.integrity_valid()) {
            return Err(ProtocolError::IntegrityMismatch);
        }
        encode_record(kind, &payload).map(EncodedProtocolRecord)
    }

    pub fn decode_untrusted(record: &[u8]) -> Result<Self, ProtocolError> {
        if record.len() > CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES {
            return Err(ProtocolError::RecordTooLarge);
        }
        if record.len() < HEADER_BYTES {
            return Err(ProtocolError::TruncatedRecord);
        }
        if record[..WIRE_MAGIC.len()] != WIRE_MAGIC {
            return Err(ProtocolError::InvalidMagic);
        }
        let version = u16::from_be_bytes([record[8], record[9]]);
        if version != CLOSED_EXECUTION_PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let kind = MessageKind::from_wire(u16::from_be_bytes([record[10], record[11]]))?;
        let payload_len =
            u32::from_be_bytes([record[12], record[13], record[14], record[15]]) as usize;
        if payload_len != record.len() - HEADER_BYTES {
            return Err(ProtocolError::InvalidPayloadLength);
        }
        let payload = &record[HEADER_BYTES..];
        match kind {
            MessageKind::Challenge => decode_challenge(payload).map(Self::Challenge),
            MessageKind::Acquire => decode_acquire(payload).map(Self::Acquire),
            MessageKind::Granted => decode_grant(payload).map(Self::Granted),
            MessageKind::Attach => decode_attach(payload).map(Self::Attach),
            MessageKind::Attached => decode_attached(payload).map(Self::Attached),
            MessageKind::Finalize => decode_finalize(payload).map(Self::Finalize),
            MessageKind::Finalized => decode_finalized(payload).map(Self::Finalized),
            MessageKind::Refused => decode_refused(payload).map(Self::Refused),
        }
    }
}

fn encode_challenge(value: &AcquisitionChallenge) -> Vec<u8> {
    let mut payload = Vec::with_capacity(CHALLENGE_PAYLOAD_BYTES);
    push_digest(&mut payload, value.challenge_binding);
    push_digest(&mut payload, value.peer_process_identity);
    push_digest(&mut payload, value.supervisor_key_id);
    push_signature(&mut payload, value.signature);
    payload.extend_from_slice(&value.issued_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.expires_monotonic_ns.to_be_bytes());
    payload
}

fn decode_challenge(payload: &[u8]) -> Result<AcquisitionChallenge, ProtocolError> {
    let mut reader = Reader::new(payload, CHALLENGE_PAYLOAD_BYTES)?;
    let value = AcquisitionChallenge {
        challenge_binding: reader.digest(false)?,
        peer_process_identity: reader.digest(false)?,
        supervisor_key_id: reader.digest(false)?,
        signature: reader.signature()?,
        issued_monotonic_ns: reader.nonzero_u64()?,
        expires_monotonic_ns: reader.nonzero_u64()?,
    };
    reader.finish()?;
    if !value.integrity_valid() {
        return Err(ProtocolError::IntegrityMismatch);
    }
    Ok(value)
}

fn encode_record(kind: MessageKind, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let total = HEADER_BYTES
        .checked_add(payload.len())
        .ok_or(ProtocolError::RecordTooLarge)?;
    if total > CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES {
        return Err(ProtocolError::RecordTooLarge);
    }
    let payload_len = u32::try_from(payload.len()).map_err(|_| ProtocolError::RecordTooLarge)?;
    let mut record = Vec::with_capacity(total);
    record.extend_from_slice(&WIRE_MAGIC);
    record.extend_from_slice(&CLOSED_EXECUTION_PROTOCOL_VERSION.to_be_bytes());
    record.extend_from_slice(&(kind as u16).to_be_bytes());
    record.extend_from_slice(&payload_len.to_be_bytes());
    record.extend_from_slice(payload);
    Ok(record)
}

fn encode_acquire(value: &AcquireLeaseRequest) -> Vec<u8> {
    let mut payload = Vec::with_capacity(ACQUIRE_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.request_nonce);
    push_digest(&mut payload, value.challenge_binding);
    push_digest(&mut payload, value.peer_process_identity);
    push_digest(&mut payload, value.invocation);
    push_digest(&mut payload, value.executable_snapshot);
    push_digest(&mut payload, value.execution_closure);
    push_digest(&mut payload, value.execution_policy);
    push_digest(&mut payload, value.capability_probe);
    payload.extend_from_slice(&value.kernel_deadline_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.challenge_expires_monotonic_ns.to_be_bytes());
    payload
}

fn decode_acquire(payload: &[u8]) -> Result<AcquireLeaseRequest, ProtocolError> {
    let mut reader = Reader::new(payload, ACQUIRE_PAYLOAD_BYTES)?;
    let request_id = reader.digest(false)?;
    let value = AcquireLeaseRequest::from_wire(
        request_id,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.digest(false)?,
        reader.u64()?,
        reader.u64()?,
    );
    reader.finish()?;
    if !value.integrity_valid() {
        return Err(ProtocolError::IntegrityMismatch);
    }
    Ok(value)
}

fn encode_grant(value: &LeaseOffer) -> Vec<u8> {
    let mut payload = Vec::with_capacity(GRANT_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.peer_process_identity);
    push_digest(&mut payload, value.lease_secret_commitment);
    push_digest(&mut payload, value.server_nonce);
    push_digest(&mut payload, value.supervisor_instance);
    push_digest(&mut payload, value.process_set_identity);
    push_digest(&mut payload, value.supervisor_key_id);
    push_signature(&mut payload, value.signature);
    payload.extend_from_slice(&value.granted_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.lease_expires_monotonic_ns.to_be_bytes());
    payload
}

fn decode_grant(payload: &[u8]) -> Result<LeaseOffer, ProtocolError> {
    let mut reader = Reader::new(payload, GRANT_PAYLOAD_BYTES)?;
    let value = LeaseOffer {
        request_id: reader.digest(false)?,
        lease_id: reader.digest(false)?,
        peer_process_identity: reader.digest(false)?,
        lease_secret_commitment: reader.digest(false)?,
        server_nonce: reader.digest(false)?,
        supervisor_instance: reader.digest(false)?,
        process_set_identity: reader.digest(false)?,
        supervisor_key_id: reader.digest(false)?,
        signature: reader.signature()?,
        granted_monotonic_ns: reader.nonzero_u64()?,
        lease_expires_monotonic_ns: reader.nonzero_u64()?,
    };
    reader.finish()?;
    if !value.integrity_valid() {
        return Err(ProtocolError::IntegrityMismatch);
    }
    Ok(value)
}

fn encode_attach(value: &AttachLeaseRequest) -> Vec<u8> {
    let mut payload = Vec::with_capacity(ATTACH_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.authentication_tag);
    payload.extend_from_slice(&value.kernel_deadline_monotonic_ns.to_be_bytes());
    payload
}

fn decode_attach(payload: &[u8]) -> Result<AttachLeaseRequest, ProtocolError> {
    let mut reader = Reader::new(payload, ATTACH_PAYLOAD_BYTES)?;
    let value = AttachLeaseRequest {
        request_id: reader.digest(false)?,
        lease_id: reader.digest(false)?,
        authentication_tag: reader.digest(false)?,
        kernel_deadline_monotonic_ns: reader.nonzero_u64()?,
    };
    reader.finish()?;
    Ok(value)
}

fn encode_attached(value: &LeaseAttached) -> Vec<u8> {
    let mut payload = Vec::with_capacity(ATTACHED_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.peer_process_identity);
    push_digest(&mut payload, value.process_set_identity);
    push_digest(&mut payload, value.supervisor_key_id);
    push_signature(&mut payload, value.signature);
    payload.extend_from_slice(&value.attached_monotonic_ns.to_be_bytes());
    payload
}

fn decode_attached(payload: &[u8]) -> Result<LeaseAttached, ProtocolError> {
    let mut reader = Reader::new(payload, ATTACHED_PAYLOAD_BYTES)?;
    let value = LeaseAttached {
        request_id: reader.digest(false)?,
        lease_id: reader.digest(false)?,
        peer_process_identity: reader.digest(false)?,
        process_set_identity: reader.digest(false)?,
        supervisor_key_id: reader.digest(false)?,
        signature: reader.signature()?,
        attached_monotonic_ns: reader.nonzero_u64()?,
    };
    reader.finish()?;
    Ok(value)
}

fn encode_finalize(value: &FinalizeLeaseRequest) -> Vec<u8> {
    let mut payload = Vec::with_capacity(FINALIZE_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.authentication_tag);
    payload.push(value.reason as u8);
    payload.extend_from_slice(&[0; 7]);
    payload.extend_from_slice(&value.requested_monotonic_ns.to_be_bytes());
    payload
}

fn decode_finalize(payload: &[u8]) -> Result<FinalizeLeaseRequest, ProtocolError> {
    let mut reader = Reader::new(payload, FINALIZE_PAYLOAD_BYTES)?;
    let request_id = reader.digest(false)?;
    let lease_id = reader.digest(false)?;
    let authentication_tag = reader.digest(false)?;
    let reason = FinalizeReason::from_wire(reader.u8()?)?;
    reader.zeros(7)?;
    let requested_monotonic_ns = reader.nonzero_u64()?;
    reader.finish()?;
    Ok(FinalizeLeaseRequest {
        request_id,
        lease_id,
        reason,
        requested_monotonic_ns,
        authentication_tag,
    })
}

fn encode_finalized(value: &LeaseFinalized) -> Vec<u8> {
    let mut payload = Vec::with_capacity(FINALIZED_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.process_set_identity);
    push_digest(&mut payload, value.peer_process_identity);
    push_digest(&mut payload, value.finalization_id);
    push_digest(&mut payload, value.supervisor_key_id);
    push_signature(&mut payload, value.signature);
    payload.push(value.reason as u8);
    payload.extend_from_slice(&[0; 7]);
    payload.extend_from_slice(&[
        value.attached_before_exec as u8,
        value.migration_protection_observed as u8,
        value.process_set_kill_issued as u8,
        value.process_set_quiescent as u8,
        0,
        0,
        0,
        0,
    ]);
    payload.extend_from_slice(&value.attached_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.finalize_requested_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.kill_issued_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.quiescent_monotonic_ns.to_be_bytes());
    payload.extend_from_slice(&value.finalized_monotonic_ns.to_be_bytes());
    payload
}

fn decode_finalized(payload: &[u8]) -> Result<LeaseFinalized, ProtocolError> {
    let mut reader = Reader::new(payload, FINALIZED_PAYLOAD_BYTES)?;
    let value = LeaseFinalized {
        request_id: reader.digest(false)?,
        lease_id: reader.digest(false)?,
        process_set_identity: reader.digest(false)?,
        peer_process_identity: reader.digest(false)?,
        finalization_id: reader.digest(false)?,
        supervisor_key_id: reader.digest(false)?,
        signature: reader.signature()?,
        reason: {
            let reason = FinalizeReason::from_wire(reader.u8()?)?;
            reader.zeros(7)?;
            reason
        },
        attached_before_exec: reader.boolean()?,
        migration_protection_observed: reader.boolean()?,
        process_set_kill_issued: reader.boolean()?,
        process_set_quiescent: reader.boolean()?,
        attached_monotonic_ns: {
            reader.zeros(4)?;
            reader.nonzero_u64()?
        },
        finalize_requested_monotonic_ns: reader.nonzero_u64()?,
        kill_issued_monotonic_ns: reader.nonzero_u64()?,
        quiescent_monotonic_ns: reader.nonzero_u64()?,
        finalized_monotonic_ns: reader.nonzero_u64()?,
    };
    reader.finish()?;
    if !value.integrity_valid() {
        return Err(ProtocolError::IntegrityMismatch);
    }
    Ok(value)
}

fn encode_refused(value: &LeaseRefused) -> Vec<u8> {
    let mut payload = Vec::with_capacity(REFUSED_PAYLOAD_BYTES);
    push_digest(&mut payload, value.request_id);
    push_digest(&mut payload, value.lease_id);
    push_digest(&mut payload, value.supervisor_key_id);
    push_signature(&mut payload, value.signature);
    payload.extend_from_slice(&(value.code as u32).to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&value.observed_monotonic_ns.to_be_bytes());
    payload
}

fn decode_refused(payload: &[u8]) -> Result<LeaseRefused, ProtocolError> {
    let mut reader = Reader::new(payload, REFUSED_PAYLOAD_BYTES)?;
    let request_id = reader.digest(false)?;
    let lease_id = reader.digest(true)?;
    let supervisor_key_id = reader.digest(false)?;
    let signature = reader.signature()?;
    let code = RefusalCode::from_wire(reader.u32()?)?;
    if reader.u32()? != 0 {
        return Err(ProtocolError::InvalidField);
    }
    let observed_monotonic_ns = reader.nonzero_u64()?;
    reader.finish()?;
    let value = LeaseRefused {
        request_id,
        lease_id,
        supervisor_key_id,
        code,
        observed_monotonic_ns,
        signature,
    };
    if !value.integrity_valid() {
        return Err(ProtocolError::IntegrityMismatch);
    }
    Ok(value)
}

fn push_digest(buffer: &mut Vec<u8>, digest: ProtocolDigest) {
    buffer.extend_from_slice(digest.as_bytes());
}

fn push_signature(buffer: &mut Vec<u8>, signature: ProtocolSignature) {
    buffer.extend_from_slice(signature.as_bytes());
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], expected: usize) -> Result<Self, ProtocolError> {
        if bytes.len() != expected {
            return Err(ProtocolError::InvalidPayloadLength);
        }
        Ok(Self { bytes, offset: 0 })
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(ProtocolError::TruncatedRecord)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(ProtocolError::TruncatedRecord)?;
        self.offset = end;
        Ok(value)
    }

    fn digest(&mut self, allow_zero: bool) -> Result<ProtocolDigest, ProtocolError> {
        let bytes: [u8; DIGEST_BYTES] = self
            .take(DIGEST_BYTES)?
            .try_into()
            .map_err(|_| ProtocolError::TruncatedRecord)?;
        if allow_zero && bytes == [0; DIGEST_BYTES] {
            return Ok(ProtocolDigest::ZERO);
        }
        ProtocolDigest::from_bytes(bytes)
    }

    fn signature(&mut self) -> Result<ProtocolSignature, ProtocolError> {
        let bytes: [u8; SIGNATURE_BYTES] = self
            .take(SIGNATURE_BYTES)?
            .try_into()
            .map_err(|_| ProtocolError::TruncatedRecord)?;
        Ok(ProtocolSignature::from_bytes(bytes))
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, ProtocolError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| ProtocolError::TruncatedRecord)?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, ProtocolError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| ProtocolError::TruncatedRecord)?;
        Ok(u64::from_be_bytes(bytes))
    }

    fn nonzero_u64(&mut self) -> Result<u64, ProtocolError> {
        let value = self.u64()?;
        if value == 0 {
            return Err(ProtocolError::InvalidField);
        }
        Ok(value)
    }

    fn boolean(&mut self) -> Result<bool, ProtocolError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(ProtocolError::InvalidField),
        }
    }

    fn zeros(&mut self, length: usize) -> Result<(), ProtocolError> {
        if self.take(length)?.iter().any(|byte| *byte != 0) {
            return Err(ProtocolError::InvalidField);
        }
        Ok(())
    }

    fn finish(self) -> Result<(), ProtocolError> {
        if self.offset != self.bytes.len() {
            return Err(ProtocolError::InvalidPayloadLength);
        }
        Ok(())
    }
}

fn derive_challenge_binding(
    peer_process_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    nonce: ProtocolDigest,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
) -> ProtocolDigest {
    hash_fields(
        CHALLENGE_BINDING_DOMAIN,
        &[
            peer_process_identity.as_bytes(),
            supervisor_key_id.as_bytes(),
            nonce.as_bytes(),
            &issued_monotonic_ns.to_be_bytes(),
            &expires_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_request_id(
    request_nonce: ProtocolDigest,
    challenge_binding: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    invocation: ProtocolDigest,
    executable_snapshot: ProtocolDigest,
    execution_closure: ProtocolDigest,
    execution_policy: ProtocolDigest,
    capability_probe: ProtocolDigest,
    kernel_deadline_monotonic_ns: u64,
    challenge_expires_monotonic_ns: u64,
) -> ProtocolDigest {
    hash_fields(
        REQUEST_ID_DOMAIN,
        &[
            request_nonce.as_bytes(),
            challenge_binding.as_bytes(),
            peer_process_identity.as_bytes(),
            invocation.as_bytes(),
            executable_snapshot.as_bytes(),
            execution_closure.as_bytes(),
            execution_policy.as_bytes(),
            capability_probe.as_bytes(),
            &kernel_deadline_monotonic_ns.to_be_bytes(),
            &challenge_expires_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn derive_lease_id(
    request_id: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    server_nonce: ProtocolDigest,
    lease_secret_commitment: ProtocolDigest,
    supervisor_instance: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    granted_monotonic_ns: u64,
    lease_expires_monotonic_ns: u64,
) -> ProtocolDigest {
    hash_fields(
        LEASE_ID_DOMAIN,
        &[
            request_id.as_bytes(),
            peer_process_identity.as_bytes(),
            server_nonce.as_bytes(),
            lease_secret_commitment.as_bytes(),
            supervisor_instance.as_bytes(),
            process_set_identity.as_bytes(),
            &granted_monotonic_ns.to_be_bytes(),
            &lease_expires_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn secret_commitment(secret: &LeaseSecret) -> ProtocolDigest {
    hash_fields(LEASE_SECRET_COMMITMENT_DOMAIN, &[secret.as_bytes()])
}

fn attach_request_authentication_tag(
    secret: &LeaseSecret,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    kernel_deadline_monotonic_ns: u64,
) -> ProtocolDigest {
    authentication_tag(
        secret,
        ATTACH_REQUEST_AUTHENTICATION_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            &kernel_deadline_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn finalize_request_authentication_tag(
    secret: &LeaseSecret,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    reason: FinalizeReason,
    requested_monotonic_ns: u64,
) -> ProtocolDigest {
    authentication_tag(
        secret,
        FINALIZE_REQUEST_AUTHENTICATION_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            &[reason as u8],
            &requested_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn challenge_signature(
    signer: &SupervisorSigner,
    challenge_binding: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
) -> ProtocolSignature {
    signer.sign(
        CHALLENGE_SIGNATURE_DOMAIN,
        &[
            challenge_binding.as_bytes(),
            peer_process_identity.as_bytes(),
            supervisor_key_id.as_bytes(),
            &issued_monotonic_ns.to_be_bytes(),
            &expires_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn offer_signature(
    signer: &SupervisorSigner,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    lease_secret_commitment: ProtocolDigest,
    server_nonce: ProtocolDigest,
    supervisor_instance: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    granted_monotonic_ns: u64,
    lease_expires_monotonic_ns: u64,
) -> ProtocolSignature {
    signer.sign(
        OFFER_SIGNATURE_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            peer_process_identity.as_bytes(),
            lease_secret_commitment.as_bytes(),
            server_nonce.as_bytes(),
            supervisor_instance.as_bytes(),
            process_set_identity.as_bytes(),
            supervisor_key_id.as_bytes(),
            &granted_monotonic_ns.to_be_bytes(),
            &lease_expires_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn attached_signature(
    signer: &SupervisorSigner,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    attached_monotonic_ns: u64,
) -> ProtocolSignature {
    signer.sign(
        ATTACHED_SIGNATURE_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            peer_process_identity.as_bytes(),
            process_set_identity.as_bytes(),
            supervisor_key_id.as_bytes(),
            &attached_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn finalized_signature(
    signer: &SupervisorSigner,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    finalization_id: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    reason: FinalizeReason,
    attached_before_exec: bool,
    migration_protection_observed: bool,
    process_set_kill_issued: bool,
    process_set_quiescent: bool,
    attached_monotonic_ns: u64,
    finalize_requested_monotonic_ns: u64,
    kill_issued_monotonic_ns: u64,
    quiescent_monotonic_ns: u64,
    finalized_monotonic_ns: u64,
) -> ProtocolSignature {
    let flags = [
        attached_before_exec as u8,
        migration_protection_observed as u8,
        process_set_kill_issued as u8,
        process_set_quiescent as u8,
    ];
    signer.sign(
        FINALIZED_SIGNATURE_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            process_set_identity.as_bytes(),
            peer_process_identity.as_bytes(),
            finalization_id.as_bytes(),
            supervisor_key_id.as_bytes(),
            &[reason as u8],
            &flags,
            &attached_monotonic_ns.to_be_bytes(),
            &finalize_requested_monotonic_ns.to_be_bytes(),
            &kill_issued_monotonic_ns.to_be_bytes(),
            &quiescent_monotonic_ns.to_be_bytes(),
            &finalized_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn refused_signature(
    signer: &SupervisorSigner,
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    supervisor_key_id: ProtocolDigest,
    code: RefusalCode,
    observed_monotonic_ns: u64,
) -> ProtocolSignature {
    signer.sign(
        REFUSED_SIGNATURE_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            supervisor_key_id.as_bytes(),
            &(code as u32).to_be_bytes(),
            &observed_monotonic_ns.to_be_bytes(),
        ],
    )
}

fn authentication_tag(secret: &LeaseSecret, domain: &[u8], fields: &[&[u8]]) -> ProtocolDigest {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let payload = authentication_payload(domain, fields);
    ProtocolDigest(
        hmac::sign(&key, &payload)
            .as_ref()
            .try_into()
            .expect("HMAC-SHA256 length"),
    )
}

fn verify_authentication_tag(
    secret: &LeaseSecret,
    domain: &[u8],
    fields: &[&[u8]],
    observed: ProtocolDigest,
) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let payload = authentication_payload(domain, fields);
    hmac::verify(&key, &payload, observed.as_bytes()).is_ok()
}

fn authentication_payload(domain: &[u8], fields: &[&[u8]]) -> Vec<u8> {
    let fields_bytes = fields.iter().fold(0usize, |total, field| {
        total.saturating_add(8).saturating_add(field.len())
    });
    let mut payload = Vec::with_capacity(8 + domain.len() + fields_bytes);
    payload.extend_from_slice(&(domain.len() as u64).to_be_bytes());
    payload.extend_from_slice(domain);
    for field in fields {
        payload.extend_from_slice(&(field.len() as u64).to_be_bytes());
        payload.extend_from_slice(field);
    }
    payload
}

fn verify_challenge_signature(verifier: &SupervisorVerifier, value: &AcquisitionChallenge) -> bool {
    verifier.verify(
        CHALLENGE_SIGNATURE_DOMAIN,
        &[
            value.challenge_binding.as_bytes(),
            value.peer_process_identity.as_bytes(),
            value.supervisor_key_id.as_bytes(),
            &value.issued_monotonic_ns.to_be_bytes(),
            &value.expires_monotonic_ns.to_be_bytes(),
        ],
        value.signature,
    )
}

fn verify_offer_signature(verifier: &SupervisorVerifier, value: &LeaseOffer) -> bool {
    verifier.verify(
        OFFER_SIGNATURE_DOMAIN,
        &[
            value.request_id.as_bytes(),
            value.lease_id.as_bytes(),
            value.peer_process_identity.as_bytes(),
            value.lease_secret_commitment.as_bytes(),
            value.server_nonce.as_bytes(),
            value.supervisor_instance.as_bytes(),
            value.process_set_identity.as_bytes(),
            value.supervisor_key_id.as_bytes(),
            &value.granted_monotonic_ns.to_be_bytes(),
            &value.lease_expires_monotonic_ns.to_be_bytes(),
        ],
        value.signature,
    )
}

fn verify_attached_signature(verifier: &SupervisorVerifier, value: &LeaseAttached) -> bool {
    verifier.verify(
        ATTACHED_SIGNATURE_DOMAIN,
        &[
            value.request_id.as_bytes(),
            value.lease_id.as_bytes(),
            value.peer_process_identity.as_bytes(),
            value.process_set_identity.as_bytes(),
            value.supervisor_key_id.as_bytes(),
            &value.attached_monotonic_ns.to_be_bytes(),
        ],
        value.signature,
    )
}

fn verify_finalized_signature(verifier: &SupervisorVerifier, value: &LeaseFinalized) -> bool {
    let flags = [
        value.attached_before_exec as u8,
        value.migration_protection_observed as u8,
        value.process_set_kill_issued as u8,
        value.process_set_quiescent as u8,
    ];
    verifier.verify(
        FINALIZED_SIGNATURE_DOMAIN,
        &[
            value.request_id.as_bytes(),
            value.lease_id.as_bytes(),
            value.process_set_identity.as_bytes(),
            value.peer_process_identity.as_bytes(),
            value.finalization_id.as_bytes(),
            value.supervisor_key_id.as_bytes(),
            &[value.reason as u8],
            &flags,
            &value.attached_monotonic_ns.to_be_bytes(),
            &value.finalize_requested_monotonic_ns.to_be_bytes(),
            &value.kill_issued_monotonic_ns.to_be_bytes(),
            &value.quiescent_monotonic_ns.to_be_bytes(),
            &value.finalized_monotonic_ns.to_be_bytes(),
        ],
        value.signature,
    )
}

fn verify_refused_signature(verifier: &SupervisorVerifier, value: &LeaseRefused) -> bool {
    verifier.verify(
        REFUSED_SIGNATURE_DOMAIN,
        &[
            value.request_id.as_bytes(),
            value.lease_id.as_bytes(),
            value.supervisor_key_id.as_bytes(),
            &(value.code as u32).to_be_bytes(),
            &value.observed_monotonic_ns.to_be_bytes(),
        ],
        value.signature,
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_finalization_id(
    request_id: ProtocolDigest,
    lease_id: ProtocolDigest,
    process_set_identity: ProtocolDigest,
    peer_process_identity: ProtocolDigest,
    reason: FinalizeReason,
    attached_monotonic_ns: u64,
    finalize_requested_monotonic_ns: u64,
    kill_issued_monotonic_ns: u64,
    quiescent_monotonic_ns: u64,
    finalized_monotonic_ns: u64,
) -> ProtocolDigest {
    hash_fields(
        FINALIZATION_ID_DOMAIN,
        &[
            request_id.as_bytes(),
            lease_id.as_bytes(),
            process_set_identity.as_bytes(),
            peer_process_identity.as_bytes(),
            &[reason as u8],
            &attached_monotonic_ns.to_be_bytes(),
            &finalize_requested_monotonic_ns.to_be_bytes(),
            &kill_issued_monotonic_ns.to_be_bytes(),
            &quiescent_monotonic_ns.to_be_bytes(),
            &finalized_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[cfg(target_os = "linux")]
fn unix_peer_process(
    socket: RawFd,
) -> Result<(libc::pid_t, libc::uid_t, libc::gid_t, OwnedFd), ProtocolError> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut credentials_length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the output buffer and length match `SO_PEERCRED`'s `ucred` ABI.
    let credentials_result = unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut credentials_length,
        )
    };
    if credentials_result != 0 || credentials_length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    // SAFETY: a successful exact-length `getsockopt` initialized the structure.
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }

    let mut raw_pidfd: libc::c_int = -1;
    let mut pidfd_length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: the output buffer and length match `SO_PEERPIDFD`'s integer FD ABI.
    let pidfd_result = unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            (&mut raw_pidfd as *mut libc::c_int).cast(),
            &mut pidfd_length,
        )
    };
    if pidfd_result != 0 || raw_pidfd < 0 {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    // SAFETY: `SO_PEERPIDFD` returned a new owned descriptor on success.
    let peer_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd) };
    if pidfd_length as usize != std::mem::size_of::<libc::c_int>() {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    set_fd_cloexec(peer_pidfd.as_raw_fd())?;
    ensure_pidfd_live(&peer_pidfd)?;
    if pidfd_process_id(&peer_pidfd)? != credentials.pid {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    Ok((
        credentials.pid,
        credentials.uid,
        credentials.gid,
        peer_pidfd,
    ))
}

#[cfg(target_os = "linux")]
fn configure_unix_record_socket(socket: OwnedFd) -> Result<OwnedFd, ProtocolError> {
    if get_socket_option_int(socket.as_raw_fd(), libc::SO_DOMAIN)? != libc::AF_UNIX
        || get_socket_option_int(socket.as_raw_fd(), libc::SO_TYPE)? != libc::SOCK_SEQPACKET
    {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    set_fd_cloexec(socket.as_raw_fd())?;
    set_socket_option_int(socket.as_raw_fd(), libc::SO_PASSCRED, 1)?;
    set_socket_option_int(socket.as_raw_fd(), libc::SO_PASSPIDFD, 1)?;
    Ok(socket)
}

#[cfg(target_os = "linux")]
fn get_socket_option_int(socket: RawFd, option: libc::c_int) -> Result<libc::c_int, ProtocolError> {
    let mut value = 0;
    let mut value_length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: the output buffer and length match this integer socket option.
    let result = unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            option,
            (&mut value as *mut libc::c_int).cast(),
            &mut value_length,
        )
    };
    if result != 0 || value_length as usize != std::mem::size_of::<libc::c_int>() {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
fn set_socket_option_int(
    socket: RawFd,
    option: libc::c_int,
    value: libc::c_int,
) -> Result<(), ProtocolError> {
    // SAFETY: the input buffer and length match this integer socket option.
    let result = unsafe {
        libc::setsockopt(
            socket,
            libc::SOL_SOCKET,
            option,
            (&value as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result != 0 {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_fd_cloexec(fd: RawFd) -> Result<(), ProtocolError> {
    // SAFETY: both calls inspect or update flags on an open owned descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnixSendAttempt {
    Complete,
    Interrupted,
    WaitWritable,
    Failed,
}

#[cfg(target_os = "linux")]
fn classify_unix_send_attempt(
    sent: libc::ssize_t,
    expected: usize,
    errno: libc::c_int,
) -> UnixSendAttempt {
    if sent == expected as libc::ssize_t {
        return UnixSendAttempt::Complete;
    }
    if sent >= 0 {
        return UnixSendAttempt::Failed;
    }
    if errno == libc::EINTR {
        return UnixSendAttempt::Interrupted;
    }
    if errno == libc::EAGAIN || errno == libc::EWOULDBLOCK {
        return UnixSendAttempt::WaitWritable;
    }
    UnixSendAttempt::Failed
}

#[cfg(target_os = "linux")]
fn send_unix_record(
    socket: RawFd,
    peer_pidfd: RawFd,
    record: &[u8],
    deadline_monotonic_ns: u64,
) -> Result<(), ProtocolError> {
    if record.is_empty() || record.len() > CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES {
        return Err(ProtocolError::TransportUnavailable);
    }
    if deadline_monotonic_ns == 0 {
        return Err(ProtocolError::InvalidField);
    }
    loop {
        if protocol_monotonic_now_ns()? >= deadline_monotonic_ns {
            return Err(ProtocolError::DeadlineReached);
        }
        // SAFETY: the immutable record remains live for this single packet send.
        let sent = unsafe {
            libc::send(
                socket,
                record.as_ptr().cast(),
                record.len(),
                libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
            )
        };
        let errno = if sent < 0 {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
        } else {
            0
        };
        match classify_unix_send_attempt(sent, record.len(), errno) {
            UnixSendAttempt::Complete => {
                // Scheduling can move the actual send past the caller's absolute
                // deadline after the pre-send check. The packet may already be
                // visible to the peer, but it must not be reported as timely.
                if protocol_monotonic_now_ns()? >= deadline_monotonic_ns {
                    return Err(ProtocolError::DeadlineReached);
                }
                return Ok(());
            }
            UnixSendAttempt::Interrupted => continue,
            UnixSendAttempt::WaitWritable => {
                wait_for_unix_send_capacity(socket, peer_pidfd, deadline_monotonic_ns)?;
            }
            UnixSendAttempt::Failed => return Err(ProtocolError::TransportUnavailable),
        }
    }
}

#[cfg(target_os = "linux")]
fn wait_for_unix_send_capacity(
    socket: RawFd,
    peer_pidfd: RawFd,
    deadline_monotonic_ns: u64,
) -> Result<(), ProtocolError> {
    loop {
        let now = protocol_monotonic_now_ns()?;
        if now >= deadline_monotonic_ns {
            return Err(ProtocolError::DeadlineReached);
        }
        let remaining = deadline_monotonic_ns - now;
        let timeout = libc::timespec {
            tv_sec: (remaining / 1_000_000_000) as libc::time_t,
            tv_nsec: (remaining % 1_000_000_000) as libc::c_long,
        };
        let mut descriptors = [
            libc::pollfd {
                fd: socket,
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: peer_pidfd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: both descriptors and the relative timeout remain live for ppoll.
        let result = unsafe {
            libc::ppoll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                &timeout,
                std::ptr::null(),
            )
        };
        if result < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ProtocolError::TransportUnavailable);
        }
        if result == 0 {
            return Err(ProtocolError::DeadlineReached);
        }
        if descriptors[1].revents != 0
            || descriptors[0].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
        {
            return Err(ProtocolError::TransportUnavailable);
        }
        if descriptors[0].revents & libc::POLLOUT != 0 {
            return Ok(());
        }
        return Err(ProtocolError::TransportUnavailable);
    }
}

#[cfg(target_os = "linux")]
fn protocol_monotonic_now_ns() -> Result<u64, ProtocolError> {
    let mut timestamp = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut timestamp) } != 0 {
        return Err(ProtocolError::TransportUnavailable);
    }
    let seconds =
        u64::try_from(timestamp.tv_sec).map_err(|_| ProtocolError::TransportUnavailable)?;
    let nanoseconds =
        u64::try_from(timestamp.tv_nsec).map_err(|_| ProtocolError::TransportUnavailable)?;
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|value| value.checked_add(nanoseconds))
        .ok_or(ProtocolError::TransportUnavailable)
}

#[cfg(target_os = "linux")]
fn receive_unix_record(socket: RawFd) -> Result<(Vec<u8>, libc::ucred, OwnedFd), ProtocolError> {
    loop {
        let mut record = [0u8; CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES];
        let mut control = [0usize; 32];
        let mut io = libc::iovec {
            iov_base: record.as_mut_ptr().cast(),
            iov_len: record.len(),
        };
        // SAFETY: all pointer fields are set below to live buffers for this call.
        let mut message = unsafe { std::mem::zeroed::<libc::msghdr>() };
        message.msg_iov = &mut io;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control);
        // `MSG_TRUNC` reports an oversized packet's real length; CLOEXEC applies
        // before any received descriptor becomes visible to this process.
        let received = unsafe {
            libc::recvmsg(
                socket,
                &mut message,
                libc::MSG_TRUNC | libc::MSG_CMSG_CLOEXEC,
            )
        };
        if received < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ProtocolError::PeerIdentityUnavailable);
        }

        let mut credentials = None;
        let mut sender_pidfd = None;
        let mut unexpected_control = false;
        // SAFETY: `message` and its kernel-written control length describe the
        // aligned control buffer above for the duration of this loop.
        let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        while !header.is_null() {
            // SAFETY: CMSG iteration returned a header inside `message`.
            let control_header = unsafe { &*header };
            // SAFETY: a zero payload length is valid for computing the header size.
            let minimum_length = unsafe { libc::CMSG_LEN(0) as usize };
            if control_header.cmsg_len < minimum_length {
                unexpected_control = true;
                break;
            }
            let data_length = control_header.cmsg_len - minimum_length;
            // SAFETY: the kernel validated this ancillary record before return.
            let data = unsafe { libc::CMSG_DATA(header) };
            match (control_header.cmsg_level, control_header.cmsg_type) {
                (libc::SOL_SOCKET, libc::SCM_CREDENTIALS)
                    if data_length == std::mem::size_of::<libc::ucred>() =>
                {
                    if credentials.is_some() {
                        unexpected_control = true;
                    } else {
                        // SAFETY: the length check above covers one `ucred`.
                        credentials =
                            Some(unsafe { std::ptr::read_unaligned(data.cast::<libc::ucred>()) });
                    }
                }
                (libc::SOL_SOCKET, LINUX_SCM_PIDFD)
                    if data_length == std::mem::size_of::<libc::c_int>() =>
                {
                    // SAFETY: the length check above covers one descriptor.
                    let raw_pidfd = unsafe { std::ptr::read_unaligned(data.cast::<libc::c_int>()) };
                    if raw_pidfd < 0 {
                        unexpected_control = true;
                    } else {
                        // SAFETY: SCM_PIDFD installed a new descriptor for this recvmsg.
                        let owned_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd) };
                        if set_fd_cloexec(owned_pidfd.as_raw_fd()).is_err() {
                            unexpected_control = true;
                        } else if sender_pidfd.replace(owned_pidfd).is_some() {
                            unexpected_control = true;
                        }
                    }
                }
                (libc::SOL_SOCKET, libc::SCM_RIGHTS) => {
                    close_received_descriptors(data, data_length);
                    unexpected_control = true;
                }
                _ => unexpected_control = true,
            }
            // SAFETY: libc bounds the next header by the kernel-written length.
            header = unsafe { libc::CMSG_NXTHDR(&message, header) };
        }

        if received == 0
            || received as usize > record.len()
            || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
            || unexpected_control
        {
            return Err(ProtocolError::PeerIdentityUnavailable);
        }
        let credentials = credentials.ok_or(ProtocolError::PeerIdentityUnavailable)?;
        let sender_pidfd = sender_pidfd.ok_or(ProtocolError::PeerIdentityUnavailable)?;
        return Ok((
            record[..received as usize].to_vec(),
            credentials,
            sender_pidfd,
        ));
    }
}

#[cfg(target_os = "linux")]
fn close_received_descriptors(data: *mut libc::c_uchar, data_length: usize) {
    for offset in (0..data_length).step_by(std::mem::size_of::<libc::c_int>()) {
        if offset + std::mem::size_of::<libc::c_int>() > data_length {
            break;
        }
        // SAFETY: the caller passes a kernel-written SCM_RIGHTS data region.
        let descriptor =
            unsafe { std::ptr::read_unaligned(data.add(offset).cast::<libc::c_int>()) };
        if descriptor >= 0 {
            // SAFETY: SCM_RIGHTS installed this descriptor into our table.
            unsafe { libc::close(descriptor) };
        }
    }
}

#[cfg(target_os = "linux")]
fn pidfd_process_id(pidfd: &OwnedFd) -> Result<libc::pid_t, ProtocolError> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", pidfd.as_raw_fd()))
        .map_err(|_| ProtocolError::PeerIdentityUnavailable)?;
    fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("Pid:").map(str::trim))
        .ok_or(ProtocolError::PeerIdentityUnavailable)?
        .parse::<libc::pid_t>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or(ProtocolError::PeerIdentityUnavailable)
}

#[cfg(all(test, target_os = "linux"))]
fn unix_seqpacket_pair() -> Result<(OwnedFd, OwnedFd), ProtocolError> {
    unix_socket_pair(libc::SOCK_SEQPACKET)
}

#[cfg(all(test, target_os = "linux"))]
fn unix_socket_pair(socket_type: libc::c_int) -> Result<(OwnedFd, OwnedFd), ProtocolError> {
    let mut sockets = [-1; 2];
    // SAFETY: `sockets` has room for both descriptors returned by socketpair.
    let result = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            socket_type | libc::SOCK_CLOEXEC,
            0,
            sockets.as_mut_ptr(),
        )
    };
    if result != 0 || sockets[0] < 0 || sockets[1] < 0 {
        return Err(ProtocolError::PeerIdentityUnavailable);
    }
    // SAFETY: socketpair returned two independent owned descriptors.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(sockets[0]),
            OwnedFd::from_raw_fd(sockets[1]),
        )
    })
}

#[cfg(target_os = "linux")]
fn ensure_pidfd_live(peer_pidfd: &OwnedFd) -> Result<(), ProtocolError> {
    let mut descriptor = libc::pollfd {
        fd: peer_pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        // SAFETY: `descriptor` points to one initialized `pollfd` for this call.
        let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
        if result == 0 {
            return Ok(());
        }
        if result > 0 {
            return Err(ProtocolError::PeerIdentityUnavailable);
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(ProtocolError::PeerIdentityUnavailable);
        }
    }
}

fn hash_fields(domain: &[u8], fields: &[&[u8]]) -> ProtocolDigest {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    ProtocolDigest(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(label: &str) -> ProtocolDigest {
        ProtocolDigest::hash_identity(label).unwrap()
    }

    fn peer(label: &str) -> KernelPeerProcessObservation {
        KernelPeerProcessObservation::for_test(digest(label))
    }

    fn authenticated_record(
        peer_label: &str,
        message: ClosedExecutionMessage,
    ) -> KernelAuthenticatedProtocolRecord {
        KernelAuthenticatedProtocolRecord::for_test(digest(peer_label), message).unwrap()
    }

    fn authenticated_acquire(
        peer_label: &str,
        request: &AcquireLeaseRequest,
    ) -> KernelAuthenticatedProtocolRecord {
        authenticated_record(peer_label, ClosedExecutionMessage::Acquire(request.clone()))
    }

    fn authenticated_attach(
        peer_label: &str,
        request: &AttachLeaseRequest,
    ) -> KernelAuthenticatedProtocolRecord {
        authenticated_record(peer_label, ClosedExecutionMessage::Attach(request.clone()))
    }

    fn authenticated_finalize(
        peer_label: &str,
        request: &FinalizeLeaseRequest,
    ) -> KernelAuthenticatedProtocolRecord {
        authenticated_record(
            peer_label,
            ClosedExecutionMessage::Finalize(request.clone()),
        )
    }

    fn authenticated_attach_for_grant(
        peer_label: &str,
        grant: &LeaseGrant,
    ) -> KernelAuthenticatedProtocolRecord {
        authenticated_attach(peer_label, &AttachLeaseRequest::from_grant(grant).unwrap())
    }

    fn authenticated_finalize_for_grant(
        peer_label: &str,
        grant: &LeaseGrant,
        reason: FinalizeReason,
        requested_monotonic_ns: u64,
    ) -> KernelAuthenticatedProtocolRecord {
        authenticated_finalize(
            peer_label,
            &FinalizeLeaseRequest::from_grant(grant, reason, requested_monotonic_ns).unwrap(),
        )
    }

    #[cfg(target_os = "linux")]
    fn send_protocol_record(socket: &OwnedFd, message: &ClosedExecutionMessage) {
        let encoded = message.encode().unwrap();
        // SAFETY: the encoded buffer remains live for this single send call.
        let sent = unsafe {
            libc::send(
                socket.as_raw_fd(),
                encoded.as_bytes().as_ptr().cast(),
                encoded.len(),
                libc::MSG_NOSIGNAL,
            )
        };
        assert_eq!(sent, encoded.len() as libc::ssize_t);
    }

    #[cfg(target_os = "linux")]
    fn receive_protocol_packet(socket: &OwnedFd) -> Vec<u8> {
        let mut buffer = [0u8; CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES];
        // SAFETY: the mutable packet buffer remains live for this receive call.
        let received = unsafe {
            libc::recv(
                socket.as_raw_fd(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
            )
        };
        assert!(received > 0);
        buffer[..received as usize].to_vec()
    }

    #[cfg(target_os = "linux")]
    fn future_transport_deadline() -> u64 {
        protocol_monotonic_now_ns().unwrap() + 1_000_000_000
    }

    #[cfg(target_os = "linux")]
    fn saturate_seqpacket_sender(socket: RawFd, record: &[u8]) {
        let send_buffer_bytes: libc::c_int = 4_096;
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    socket,
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    (&send_buffer_bytes as *const libc::c_int).cast(),
                    std::mem::size_of_val(&send_buffer_bytes) as libc::socklen_t,
                )
            },
            0
        );

        for _ in 0..10_000 {
            let sent = unsafe {
                libc::send(
                    socket,
                    record.as_ptr().cast(),
                    record.len(),
                    libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
                )
            };
            if sent < 0 {
                assert_eq!(
                    std::io::Error::last_os_error().kind(),
                    std::io::ErrorKind::WouldBlock
                );
                return;
            }
            assert_eq!(sent, record.len() as libc::ssize_t);
        }
        panic!("seqpacket sender did not reach bounded backpressure");
    }

    #[cfg(target_os = "linux")]
    fn cloexec_pipe() -> (OwnedFd, OwnedFd) {
        let mut descriptors = [-1; 2];
        // SAFETY: `descriptors` has room for both pipe descriptors.
        let result = unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) };
        assert_eq!(result, 0);
        // SAFETY: pipe2 returned two independent owned descriptors.
        unsafe {
            (
                OwnedFd::from_raw_fd(descriptors[0]),
                OwnedFd::from_raw_fd(descriptors[1]),
            )
        }
    }

    fn challenge_for(authority: &SupervisorAuthority, nonce_label: &str) -> AcquisitionChallenge {
        challenge_for_with_expiry(authority, nonce_label, 1_000)
    }

    fn challenge_for_with_expiry(
        authority: &SupervisorAuthority,
        nonce_label: &str,
        expires_monotonic_ns: u64,
    ) -> AcquisitionChallenge {
        authority
            .issue_challenge_with_nonce(
                &peer("peer-process"),
                digest(nonce_label),
                10,
                expires_monotonic_ns,
            )
            .unwrap()
    }

    fn request_from_challenge(
        challenge: &AcquisitionChallenge,
        authority: &SupervisorAuthority,
        request_nonce: ProtocolDigest,
    ) -> AcquireLeaseRequest {
        AcquireLeaseRequest::new(
            request_nonce,
            challenge,
            &authority.verifier(),
            digest("invocation"),
            digest("executable"),
            digest("closure"),
            digest("policy"),
            digest("capabilities"),
            900,
            20,
        )
        .unwrap()
    }

    fn request_for(authority: &SupervisorAuthority) -> AcquireLeaseRequest {
        let challenge = challenge_for(authority, "challenge-nonce");
        request_from_challenge(&challenge, authority, digest("nonce"))
    }

    fn request() -> AcquireLeaseRequest {
        request_for(&authority())
    }

    fn other_request() -> AcquireLeaseRequest {
        let authority = authority();
        let challenge = challenge_for(&authority, "other-request-challenge");
        request_from_challenge(&challenge, &authority, digest("other-nonce"))
    }

    fn signer() -> SupervisorSigner {
        SupervisorSigner::from_seed([11; SECRET_BYTES]).unwrap()
    }

    fn authority() -> SupervisorAuthority {
        SupervisorAuthority::from_seed([11; SECRET_BYTES]).unwrap()
    }

    fn authoritative_lease_material() -> (SupervisorAuthority, LeaseOffer, LeaseGrant) {
        let authority = authority();
        let request = request_for(&authority);
        let offer_secret = LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap();
        let offer = authority
            .issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("peer-process"),
                digest("server-nonce"),
                &offer_secret,
                digest("supervisor"),
                digest("process-set"),
                100,
            )
            .unwrap();
        let grant = LeaseGrant::bind(
            &request,
            offer.clone(),
            LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap(),
            authority.verifier(),
        )
        .unwrap();
        (authority, offer, grant)
    }

    fn lease_material() -> (LeaseOffer, LeaseGrant) {
        let (_, offer, grant) = authoritative_lease_material();
        (offer, grant)
    }

    fn grant() -> LeaseGrant {
        lease_material().1
    }

    fn finalized() -> LeaseFinalized {
        let grant = grant();
        LeaseFinalized::new(
            grant.request_id(),
            grant.lease_id(),
            digest("process-set"),
            digest("peer-process"),
            FinalizeReason::LeaderExited,
            true,
            true,
            true,
            true,
            200,
            250,
            300,
            400,
            500,
            &signer(),
        )
        .unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unix_peer_observation_is_pidfd_bound_and_session_unique() {
        let authority = authority();
        let (first_socket, _first_sender) = unix_seqpacket_pair().unwrap();
        let (second_socket, _second_sender) = unix_seqpacket_pair().unwrap();
        let first = authority.observe_unix_peer(first_socket).unwrap();
        let second = authority.observe_unix_peer(second_socket).unwrap();

        first.ensure_kernel_bound().unwrap();
        second.ensure_kernel_bound().unwrap();
        assert_ne!(first.process_identity(), second.process_identity());
        assert!(format!("{first:?}").contains("kernel_bound: true"));
        // SAFETY: this reads descriptor flags from the observation's live pidfd.
        let pidfd_flags = unsafe { libc::fcntl(first.peer_pidfd.as_raw_fd(), libc::F_GETFD) };
        assert!(pidfd_flags & libc::FD_CLOEXEC != 0);

        let challenge = authority.issue_challenge(&first, 10, 1_000).unwrap();
        assert_eq!(challenge.peer_process_identity(), first.process_identity());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn byte_stream_transport_is_rejected_before_peer_observation() {
        let authority = authority();
        let (stream_socket, _sender) = unix_socket_pair(libc::SOCK_STREAM).unwrap();
        assert_eq!(
            authority.observe_unix_peer(stream_socket).unwrap_err(),
            ProtocolError::PeerIdentityUnavailable
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn connection_credentials_are_kernel_observed_and_liveness_bound() {
        let authority = authority();
        let (record_socket, _sender) = unix_seqpacket_pair().unwrap();
        let mut peer = authority.observe_unix_peer(record_socket).unwrap();
        let credentials = peer.connection_credentials().unwrap();
        assert_eq!(credentials.connection_uid(), unsafe { libc::geteuid() });
        assert_eq!(credentials.connection_gid(), unsafe { libc::getegid() });

        // Replace only the test observation's pidfd with a direct child that
        // has exited, proving the accessor rechecks liveness before disclosure.
        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0);
        if child_pid == 0 {
            unsafe { libc::_exit(0) };
        }
        let raw_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, child_pid, 0) };
        assert!(raw_pidfd >= 0);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(child_pid, &mut status, 0) },
            child_pid
        );
        peer.peer_pid = child_pid;
        peer.peer_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd as RawFd) };
        assert_eq!(
            peer.connection_credentials().unwrap_err(),
            ProtocolError::PeerIdentityUnavailable
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn concurrent_record_egress_preserves_seqpacket_boundaries() {
        let authority = authority();
        let (record_socket, receiver) = unix_seqpacket_pair().unwrap();
        let peer = authority.observe_unix_peer(record_socket).unwrap();
        let first = authority
            .issue_challenge_with_nonce(&peer, digest("egress-first"), 10, 1_000)
            .unwrap();
        let second = authority
            .issue_challenge_with_nonce(&peer, digest("egress-second"), 10, 1_000)
            .unwrap();
        let first = ClosedExecutionMessage::Challenge(first).encode().unwrap();
        let second = ClosedExecutionMessage::Challenge(second).encode().unwrap();
        let deadline = future_transport_deadline();

        std::thread::scope(|scope| {
            scope.spawn(|| peer.send_record(&first, deadline).unwrap());
            scope.spawn(|| peer.send_record(&second, deadline).unwrap());
        });
        let received = [
            receive_protocol_packet(&receiver),
            receive_protocol_packet(&receiver),
        ];
        assert!(received.contains(&first.as_bytes().to_vec()));
        assert!(received.contains(&second.as_bytes().to_vec()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn record_egress_fails_closed_when_transport_is_gone() {
        let authority = authority();
        let (record_socket, receiver) = unix_seqpacket_pair().unwrap();
        let peer = authority.observe_unix_peer(record_socket).unwrap();
        let challenge = authority.issue_challenge(&peer, 10, 1_000).unwrap();
        let encoded = ClosedExecutionMessage::Challenge(challenge)
            .encode()
            .unwrap();
        drop(receiver);

        assert_eq!(
            peer.send_record(&encoded, future_transport_deadline())
                .unwrap_err(),
            ProtocolError::TransportUnavailable
        );
        assert_eq!(
            send_unix_record(-1, -1, encoded.as_bytes(), future_transport_deadline()).unwrap_err(),
            ProtocolError::TransportUnavailable
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn nonreading_peer_cannot_block_egress_past_deadline() {
        let authority = authority();
        let (record_socket, _receiver) = unix_seqpacket_pair().unwrap();
        let peer = authority.observe_unix_peer(record_socket).unwrap();
        let challenge = authority.issue_challenge(&peer, 10, 1_000).unwrap();
        let encoded = ClosedExecutionMessage::Challenge(challenge)
            .encode()
            .unwrap();
        saturate_seqpacket_sender(peer.send_socket.as_raw_fd(), encoded.as_bytes());

        let started = protocol_monotonic_now_ns().unwrap();
        let deadline = started + 20_000_000;
        assert_eq!(
            peer.send_record(&encoded, deadline).unwrap_err(),
            ProtocolError::DeadlineReached
        );
        assert!(protocol_monotonic_now_ns().unwrap() - started < 1_000_000_000);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn peer_exit_interrupts_saturated_egress_wait() {
        let authority = authority();
        let (record_socket, _receiver) = unix_seqpacket_pair().unwrap();
        let mut peer = authority.observe_unix_peer(record_socket).unwrap();
        let challenge = authority.issue_challenge(&peer, 10, 1_000).unwrap();
        let encoded = ClosedExecutionMessage::Challenge(challenge)
            .encode()
            .unwrap();
        saturate_seqpacket_sender(peer.send_socket.as_raw_fd(), encoded.as_bytes());

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0);
        if child_pid == 0 {
            unsafe {
                libc::usleep(100_000);
                libc::_exit(0);
            }
        }
        let raw_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, child_pid, 0) };
        assert!(raw_pidfd >= 0);
        peer.peer_pid = child_pid;
        peer.peer_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd as RawFd) };

        let started = protocol_monotonic_now_ns().unwrap();
        let result = peer.send_record(&encoded, started + 2_000_000_000);
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(child_pid, &mut status, 0) },
            child_pid
        );
        assert_eq!(result.unwrap_err(), ProtocolError::TransportUnavailable);
        assert!(protocol_monotonic_now_ns().unwrap() - started < 1_000_000_000);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn send_attempt_classification_is_fail_closed() {
        let expected = 32;
        assert_eq!(
            classify_unix_send_attempt(expected as libc::ssize_t, expected, 0),
            UnixSendAttempt::Complete
        );
        assert_eq!(
            classify_unix_send_attempt(-1, expected, libc::EINTR),
            UnixSendAttempt::Interrupted
        );
        assert_eq!(
            classify_unix_send_attempt(-1, expected, libc::EAGAIN),
            UnixSendAttempt::WaitWritable
        );
        assert_eq!(
            classify_unix_send_attempt((expected - 1) as libc::ssize_t, expected, 0),
            UnixSendAttempt::Failed
        );
        assert_eq!(
            classify_unix_send_attempt(-1, expected, libc::EPIPE),
            UnixSendAttempt::Failed
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unix_record_sender_is_bound_to_the_observed_process() {
        let authority = authority();
        let (record_socket, sender) = unix_seqpacket_pair().unwrap();
        let peer = authority.observe_unix_peer(record_socket).unwrap();
        let challenge = authority.issue_challenge(&peer, 10, 1_000).unwrap();
        let request = request_from_challenge(&challenge, &authority, digest("record-nonce"));
        send_protocol_record(&sender, &ClosedExecutionMessage::Acquire(request.clone()));

        let record = peer.receive_record().unwrap();
        let secret = LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap();
        let offer = authority
            .issue_offer(
                record,
                &peer,
                digest("record-server-nonce"),
                &secret,
                digest("record-supervisor"),
                digest("record-process-set"),
                100,
            )
            .unwrap();

        assert_eq!(offer.peer_process_identity, peer.process_identity());
        assert!(offer.verify(&authority.verifier()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inherited_seqpacket_endpoint_cannot_substitute_the_record_sender() {
        let authority = authority();
        let (record_socket, sender) = unix_seqpacket_pair().unwrap();
        let peer = authority.observe_unix_peer(record_socket).unwrap();
        let challenge = authority.issue_challenge(&peer, 10, 1_000).unwrap();
        let request = request_from_challenge(&challenge, &authority, digest("forked-nonce"));
        let encoded = ClosedExecutionMessage::Acquire(request).encode().unwrap();
        let (release_reader, release_writer) = cloexec_pipe();

        // The child performs only async-signal-safe syscalls before `_exit`.
        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0);
        if child_pid == 0 {
            // SAFETY: all descriptors and the encoded buffer were live at fork.
            let sent = unsafe {
                libc::send(
                    sender.as_raw_fd(),
                    encoded.as_bytes().as_ptr().cast(),
                    encoded.len(),
                    libc::MSG_NOSIGNAL,
                )
            };
            if sent != encoded.len() as libc::ssize_t {
                unsafe { libc::_exit(2) };
            }
            let mut release = 0u8;
            let read = unsafe {
                libc::read(
                    release_reader.as_raw_fd(),
                    (&mut release as *mut u8).cast(),
                    1,
                )
            };
            unsafe { libc::_exit(if read == 1 { 0 } else { 3 }) };
        }

        drop(release_reader);
        let received = peer.receive_record();
        let release = [1u8];
        // SAFETY: the writer and byte buffer remain live for this call.
        let written = unsafe {
            libc::write(
                release_writer.as_raw_fd(),
                release.as_ptr().cast(),
                release.len(),
            )
        };
        assert_eq!(written, 1);
        let mut child_status = 0;
        // SAFETY: `child_pid` is the direct child created above.
        assert_eq!(
            unsafe { libc::waitpid(child_pid, &mut child_status, 0) },
            child_pid
        );
        assert!(libc::WIFEXITED(child_status));
        assert_eq!(libc::WEXITSTATUS(child_status), 0);
        assert_eq!(received.unwrap_err(), ProtocolError::AuthenticationFailed);
    }

    #[test]
    fn every_protocol_message_round_trips() {
        let (offer, grant) = lease_material();
        let challenge_authority = authority();
        let challenge = challenge_for(&challenge_authority, "round-trip-challenge");
        let messages = vec![
            ClosedExecutionMessage::Challenge(challenge),
            ClosedExecutionMessage::Acquire(request()),
            ClosedExecutionMessage::Granted(offer),
            ClosedExecutionMessage::Attach(AttachLeaseRequest::from_grant(&grant).unwrap()),
            ClosedExecutionMessage::Attached(
                LeaseAttached::new(
                    grant.request_id(),
                    grant.lease_id(),
                    digest("peer-process"),
                    digest("process-set"),
                    200,
                    &signer(),
                )
                .unwrap(),
            ),
            ClosedExecutionMessage::Finalize(
                FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250)
                    .unwrap(),
            ),
            ClosedExecutionMessage::Finalized(finalized()),
            ClosedExecutionMessage::Refused(
                LeaseRefused::new(
                    grant.request_id(),
                    Some(grant.lease_id()),
                    RefusalCode::ProcessSetNotQuiescent,
                    300,
                    &signer(),
                )
                .unwrap(),
            ),
        ];

        for message in messages {
            let encoded = message.encode().unwrap();
            assert!(encoded.len() <= CLOSED_EXECUTION_PROTOCOL_MAX_RECORD_BYTES);
            assert_eq!(
                ClosedExecutionMessage::decode_untrusted(encoded.as_bytes()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn request_identity_binds_every_execution_input() {
        let authority = authority();
        let challenge = challenge_for(&authority, "challenge-nonce");
        let other_challenge = challenge_for(&authority, "other-challenge-nonce");
        let later_challenge = challenge_for_with_expiry(&authority, "later-challenge-nonce", 1_001);
        let verifier = authority.verifier();
        let make = |request_nonce,
                    challenge: &AcquisitionChallenge,
                    invocation,
                    executable_snapshot,
                    execution_closure,
                    execution_policy,
                    capability_probe,
                    kernel_deadline_monotonic_ns| {
            AcquireLeaseRequest::new(
                request_nonce,
                challenge,
                &verifier,
                invocation,
                executable_snapshot,
                execution_closure,
                execution_policy,
                capability_probe,
                kernel_deadline_monotonic_ns,
                20,
            )
            .unwrap()
        };
        let baseline = make(
            digest("nonce"),
            &challenge,
            digest("invocation"),
            digest("executable"),
            digest("closure"),
            digest("policy"),
            digest("capabilities"),
            900,
        )
        .request_id();
        let replacements = [
            make(
                digest("other-nonce"),
                &challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &other_challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("other-invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("invocation"),
                digest("other-executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("invocation"),
                digest("executable"),
                digest("other-closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("other-policy"),
                digest("capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("other-capabilities"),
                900,
            ),
            make(
                digest("nonce"),
                &challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                899,
            ),
            make(
                digest("nonce"),
                &later_challenge,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
            ),
        ];
        assert!(replacements
            .iter()
            .all(|candidate| candidate.request_id() != baseline));
    }

    #[test]
    fn decode_rejects_header_and_integrity_forgery() {
        let encoded = ClosedExecutionMessage::Acquire(request()).encode().unwrap();

        let mut bad_magic = encoded.as_bytes().to_vec();
        bad_magic[0] ^= 1;
        assert_eq!(
            ClosedExecutionMessage::decode_untrusted(&bad_magic),
            Err(ProtocolError::InvalidMagic)
        );

        let mut bad_version = encoded.as_bytes().to_vec();
        bad_version[9] = 2;
        assert_eq!(
            ClosedExecutionMessage::decode_untrusted(&bad_version),
            Err(ProtocolError::UnsupportedVersion)
        );

        let mut bad_length = encoded.as_bytes().to_vec();
        bad_length[15] ^= 1;
        assert_eq!(
            ClosedExecutionMessage::decode_untrusted(&bad_length),
            Err(ProtocolError::InvalidPayloadLength)
        );

        let mut forged_request_id = encoded.as_bytes().to_vec();
        forged_request_id[HEADER_BYTES] ^= 1;
        assert_eq!(
            ClosedExecutionMessage::decode_untrusted(&forged_request_id),
            Err(ProtocolError::IntegrityMismatch)
        );
    }

    #[test]
    fn finalization_rejects_noncanonical_or_incomplete_kernel_observation() {
        let encoded = ClosedExecutionMessage::Finalized(finalized())
            .encode()
            .unwrap();
        let flag_offset = HEADER_BYTES + DIGEST_BYTES * 6 + SIGNATURE_BYTES + 8;
        for index in 0..4 {
            let mut forged = encoded.as_bytes().to_vec();
            forged[flag_offset + index] = 0;
            assert_eq!(
                ClosedExecutionMessage::decode_untrusted(&forged),
                Err(ProtocolError::IntegrityMismatch)
            );
        }

        let mut noncanonical = encoded.as_bytes().to_vec();
        noncanonical[flag_offset] = 2;
        assert_eq!(
            ClosedExecutionMessage::decode_untrusted(&noncanonical),
            Err(ProtocolError::InvalidField)
        );
    }

    #[test]
    fn supervisor_signatures_reject_requester_and_wrong_signer_forgery() {
        let grant = grant();
        let signer = signer();
        let attached = LeaseAttached::new(
            grant.request_id(),
            grant.lease_id(),
            digest("peer-process"),
            grant.process_set_identity(),
            200,
            &signer,
        )
        .unwrap();
        assert!(attached.verify(&grant));

        let mut forged_attached = attached;
        forged_attached.signature = ProtocolSignature::from_bytes([3; SIGNATURE_BYTES]);
        let encoded = ClosedExecutionMessage::Attached(forged_attached)
            .encode()
            .unwrap();
        let decoded = ClosedExecutionMessage::decode_untrusted(encoded.as_bytes()).unwrap();
        let ClosedExecutionMessage::Attached(decoded) = decoded else {
            panic!("expected attached response");
        };
        assert!(!decoded.verify(&grant));

        let wrong_signer = SupervisorSigner::from_seed([12; SECRET_BYTES]).unwrap();
        let wrong_signer_attached = LeaseAttached::new(
            grant.request_id(),
            grant.lease_id(),
            digest("peer-process"),
            grant.process_set_identity(),
            200,
            &wrong_signer,
        )
        .unwrap();
        assert!(!wrong_signer_attached.verify(&grant));

        let finalized = finalized();
        assert!(finalized.verify(&grant));
        let mut forged_finalized = finalized;
        forged_finalized.signature = ProtocolSignature::from_bytes([4; SIGNATURE_BYTES]);
        assert!(!forged_finalized.verify(&grant));
    }

    #[test]
    fn acquisition_requires_issued_peer_bound_challenge() {
        let authority = authority();
        let verifier = authority.verifier();
        let challenge = challenge_for(&authority, "peer-bound-challenge");
        assert!(challenge.verify(&verifier, 20));

        let mut forged_challenge = challenge.clone();
        forged_challenge.signature = ProtocolSignature::from_bytes([5; SIGNATURE_BYTES]);
        assert_eq!(
            AcquireLeaseRequest::new(
                digest("nonce"),
                &forged_challenge,
                &verifier,
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
                20,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );

        let request = request_from_challenge(&challenge, &authority, digest("nonce"));
        let secret = LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap();
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("peer-process"),
                digest("pre-challenge-server-nonce"),
                &secret,
                digest("supervisor"),
                digest("pre-challenge-process-set"),
                9,
            ),
            Err(ProtocolError::InvalidField)
        );
        let mut substituted_request_peer = request.clone();
        substituted_request_peer.peer_process_identity = digest("substituted-peer-process");
        substituted_request_peer.request_id = derive_request_id(
            substituted_request_peer.request_nonce,
            substituted_request_peer.challenge_binding,
            substituted_request_peer.peer_process_identity,
            substituted_request_peer.invocation,
            substituted_request_peer.executable_snapshot,
            substituted_request_peer.execution_closure,
            substituted_request_peer.execution_policy,
            substituted_request_peer.capability_probe,
            substituted_request_peer.kernel_deadline_monotonic_ns,
            substituted_request_peer.challenge_expires_monotonic_ns,
        );
        assert!(substituted_request_peer.integrity_valid());
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &substituted_request_peer),
                &peer("peer-process"),
                digest("substituted-request-server-nonce"),
                &secret,
                digest("supervisor"),
                digest("substituted-request-process-set"),
                100,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("substituted-peer-process"),
                digest("server-nonce"),
                &secret,
                digest("supervisor"),
                digest("process-set"),
                100,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );
        authority
            .issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("peer-process"),
                digest("server-nonce"),
                &secret,
                digest("supervisor"),
                digest("process-set"),
                100,
            )
            .unwrap();

        let reused_challenge_request =
            request_from_challenge(&challenge, &authority, digest("second-nonce"));
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &reused_challenge_request),
                &peer("peer-process"),
                digest("second-server-nonce"),
                &secret,
                digest("supervisor"),
                digest("second-process-set"),
                101,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );

        let unissued_binding = digest("unissued-challenge");
        let unissued_request = AcquireLeaseRequest::from_wire(
            derive_request_id(
                digest("unissued-nonce"),
                unissued_binding,
                digest("peer-process"),
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
                900,
                1_000,
            ),
            digest("unissued-nonce"),
            unissued_binding,
            digest("peer-process"),
            digest("invocation"),
            digest("executable"),
            digest("closure"),
            digest("policy"),
            digest("capabilities"),
            900,
            1_000,
        );
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &unissued_request),
                &peer("peer-process"),
                digest("third-server-nonce"),
                &secret,
                digest("supervisor"),
                digest("third-process-set"),
                102,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );
    }

    #[test]
    fn signed_offer_rejects_rewrite_and_acquisition_replay() {
        let authority = authority();
        let challenge = challenge_for(&authority, "offer-challenge");
        let request = request_from_challenge(&challenge, &authority, digest("nonce"));
        let verifier = authority.verifier();
        let secret = LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap();
        let offer = authority
            .issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("peer-process"),
                digest("server-nonce"),
                &secret,
                digest("supervisor"),
                digest("process-set"),
                100,
            )
            .unwrap();
        assert!(offer.verify(&verifier));
        assert_eq!(
            authority.issue_offer(
                authenticated_acquire("peer-process", &request),
                &peer("peer-process"),
                digest("second-server-nonce"),
                &secret,
                digest("supervisor"),
                digest("other-process-set"),
                101,
            ),
            Err(ProtocolError::ReplayDetected)
        );

        let other_request = request_from_challenge(&challenge, &authority, digest("other-nonce"));
        assert_eq!(
            LeaseGrant::bind(
                &other_request,
                offer.clone(),
                LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap(),
                verifier.clone(),
            ),
            Err(ProtocolError::AuthenticationFailed)
        );

        let mut peer_rewritten = offer.clone();
        peer_rewritten.peer_process_identity = digest("rewritten-peer-process");
        peer_rewritten.lease_id = derive_lease_id(
            peer_rewritten.request_id,
            peer_rewritten.peer_process_identity,
            peer_rewritten.server_nonce,
            peer_rewritten.lease_secret_commitment,
            peer_rewritten.supervisor_instance,
            peer_rewritten.process_set_identity,
            peer_rewritten.granted_monotonic_ns,
            peer_rewritten.lease_expires_monotonic_ns,
        );
        assert!(peer_rewritten.integrity_valid());
        assert!(!peer_rewritten.verify(&verifier));
        assert_eq!(
            LeaseGrant::bind(
                &request,
                peer_rewritten,
                LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap(),
                verifier.clone(),
            ),
            Err(ProtocolError::AuthenticationFailed)
        );

        let mut rewritten = offer;
        rewritten.process_set_identity = digest("rewritten-process-set");
        rewritten.lease_id = derive_lease_id(
            rewritten.request_id,
            rewritten.peer_process_identity,
            rewritten.server_nonce,
            rewritten.lease_secret_commitment,
            rewritten.supervisor_instance,
            rewritten.process_set_identity,
            rewritten.granted_monotonic_ns,
            rewritten.lease_expires_monotonic_ns,
        );
        assert!(rewritten.integrity_valid());
        assert!(!rewritten.verify(&verifier));
        assert_eq!(
            LeaseGrant::bind(
                &request,
                rewritten,
                LeaseSecret::from_bytes([7; SECRET_BYTES]).unwrap(),
                verifier,
            ),
            Err(ProtocolError::AuthenticationFailed)
        );
    }

    #[test]
    fn guard_binds_finalization_to_the_accepted_transcript() {
        let request = request();
        let (authority, _, grant) = authoritative_lease_material();
        let mut guard = authority.begin_lease(&request, &grant, 100).unwrap();
        guard
            .validate_attach(&AttachLeaseRequest::from_grant(&grant).unwrap(), 150)
            .unwrap();
        let pre_grant_attachment = authority
            .attached(
                authenticated_attach_for_grant("peer-process", &grant),
                &peer("peer-process"),
                grant.process_set_identity(),
                99,
            )
            .unwrap();
        assert_eq!(
            guard.validate_attached_response(&pre_grant_attachment, 150),
            Err(ProtocolError::InvalidField)
        );
        guard
            .validate_attached_response(
                &authority
                    .attached(
                        authenticated_attach_for_grant("peer-process", &grant),
                        &peer("peer-process"),
                        grant.process_set_identity(),
                        200,
                    )
                    .unwrap(),
                200,
            )
            .unwrap();
        guard
            .validate_finalize(
                &FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250)
                    .unwrap(),
                250,
            )
            .unwrap();

        let late_kill = authority
            .finalized(
                authenticated_finalize_for_grant(
                    "peer-process",
                    &grant,
                    FinalizeReason::LeaderExited,
                    250,
                ),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                200,
                900,
                901,
                902,
            )
            .unwrap();
        assert!(!late_kill.verify(&grant));
        assert_eq!(
            guard.validate_finalized_response(&late_kill, 902),
            Err(ProtocolError::AuthenticationFailed)
        );

        let wrong_peer = authority
            .finalized(
                authenticated_finalize_for_grant(
                    "other-peer-process",
                    &grant,
                    FinalizeReason::LeaderExited,
                    250,
                ),
                grant.process_set_identity(),
                &peer("other-peer-process"),
                true,
                true,
                true,
                true,
                200,
                300,
                400,
                500,
            )
            .unwrap();
        assert!(!wrong_peer.verify(&grant));
        assert_eq!(
            guard.validate_finalized_response(&wrong_peer, 500),
            Err(ProtocolError::AuthenticationFailed)
        );

        let wrong_request_time = authority
            .finalized(
                authenticated_finalize_for_grant(
                    "peer-process",
                    &grant,
                    FinalizeReason::LeaderExited,
                    251,
                ),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                200,
                300,
                400,
                500,
            )
            .unwrap();
        assert_eq!(
            guard.validate_finalized_response(&wrong_request_time, 500),
            Err(ProtocolError::AuthenticationFailed)
        );
        let finalized = authority
            .finalized(
                authenticated_finalize_for_grant(
                    "peer-process",
                    &grant,
                    FinalizeReason::LeaderExited,
                    250,
                ),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                200,
                300,
                400,
                500,
            )
            .unwrap();
        guard.validate_finalized_response(&finalized, 500).unwrap();
    }

    #[test]
    fn guard_rejects_responses_preplayed_before_validated_transitions() {
        let request = request();
        let (authority, _, grant) = authoritative_lease_material();
        let mut guard = authority.begin_lease(&request, &grant, 100).unwrap();
        let attach = AttachLeaseRequest::from_grant(&grant).unwrap();
        guard.validate_attach(&attach, 150).unwrap();

        let preplayed_attached = authority
            .attached(
                authenticated_attach_for_grant("peer-process", &grant),
                &peer("peer-process"),
                grant.process_set_identity(),
                149,
            )
            .unwrap();
        assert_eq!(
            guard.validate_attached_response(&preplayed_attached, 200),
            Err(ProtocolError::InvalidField)
        );

        let attached = authority
            .attached(
                authenticated_attach_for_grant("peer-process", &grant),
                &peer("peer-process"),
                grant.process_set_identity(),
                151,
            )
            .unwrap();
        guard.validate_attached_response(&attached, 200).unwrap();

        let finalize =
            FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250).unwrap();
        guard.validate_finalize(&finalize, 300).unwrap();
        let preplayed_finalized = authority
            .finalized(
                authenticated_finalize("peer-process", &finalize),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                151,
                299,
                400,
                500,
            )
            .unwrap();
        assert_eq!(
            guard.validate_finalized_response(&preplayed_finalized, 500),
            Err(ProtocolError::InvalidField)
        );

        let finalized = authority
            .finalized(
                authenticated_finalize("peer-process", &finalize),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                151,
                300,
                400,
                500,
            )
            .unwrap();
        guard.validate_finalized_response(&finalized, 500).unwrap();
    }

    #[test]
    fn refusal_requires_a_trusted_supervisor_signature() {
        let request = request();
        let grant = grant();
        let authority = authority();
        let refusal = authority
            .refused(
                grant.request_id(),
                Some(grant.lease_id()),
                RefusalCode::ProcessSetNotQuiescent,
                300,
            )
            .unwrap();
        assert!(refusal.verify_for_request(
            &request,
            Some(grant.lease_id()),
            grant.supervisor_verifier(),
            300,
        ));

        let wrong_authority = SupervisorAuthority::from_seed([12; SECRET_BYTES]).unwrap();
        let injected = wrong_authority
            .refused(
                grant.request_id(),
                Some(grant.lease_id()),
                RefusalCode::ProcessSetNotQuiescent,
                300,
            )
            .unwrap();
        assert!(!injected.verify_for_request(
            &request,
            Some(grant.lease_id()),
            grant.supervisor_verifier(),
            300,
        ));

        assert!(!refusal.verify_for_request(
            &request,
            Some(digest("other-lease")),
            grant.supervisor_verifier(),
            300,
        ));
        let other_request = other_request();
        assert!(!refusal.verify_for_request(
            &other_request,
            Some(grant.lease_id()),
            grant.supervisor_verifier(),
            300,
        ));
        assert!(!refusal.verify_for_request(
            &request,
            Some(grant.lease_id()),
            grant.supervisor_verifier(),
            299,
        ));
    }

    #[test]
    fn exact_expiry_requires_deadline_finalization() {
        let grant = grant();
        assert_eq!(
            FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 900),
            Err(ProtocolError::DeadlineReached)
        );
        assert!(
            FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::DeadlineReached, 900,).is_ok()
        );
    }

    #[test]
    fn lease_guard_enforces_authentication_deadline_and_single_use() {
        let request = request();
        let (authority, _, grant) = authoritative_lease_material();
        let wrong_authority = SupervisorAuthority::from_seed([12; SECRET_BYTES]).unwrap();
        assert_eq!(
            wrong_authority
                .begin_lease(&request, &grant, 100)
                .unwrap_err(),
            ProtocolError::AuthenticationFailed
        );
        let mut guard = authority.begin_lease(&request, &grant, 100).unwrap();
        assert_eq!(
            authority.begin_lease(&request, &grant, 100).unwrap_err(),
            ProtocolError::ReplayDetected
        );

        let mut forged_attach = AttachLeaseRequest::from_grant(&grant).unwrap();
        forged_attach.authentication_tag = digest("forged-attach-tag");
        assert_eq!(
            guard.validate_attach(&forged_attach, 149),
            Err(ProtocolError::AuthenticationFailed)
        );
        let attach = AttachLeaseRequest::from_grant(&grant).unwrap();
        let repeated_attach = AttachLeaseRequest::from_grant(&grant).unwrap();
        guard.validate_attach(&attach, 150).unwrap();
        assert_eq!(
            guard.validate_attach(&repeated_attach, 151),
            Err(ProtocolError::UnexpectedLeasePhase)
        );

        let attached = authority
            .attached(
                authenticated_attach_for_grant("peer-process", &grant),
                &peer("peer-process"),
                grant.process_set_identity(),
                200,
            )
            .unwrap();
        let repeated_attached = attached.clone();
        guard.validate_attached_response(&attached, 200).unwrap();
        assert_eq!(
            guard.validate_attached_response(&repeated_attached, 201),
            Err(ProtocolError::UnexpectedLeasePhase)
        );

        let finalize =
            FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250).unwrap();
        let repeated_finalize =
            FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250).unwrap();
        guard.validate_finalize(&finalize, 250).unwrap();
        assert_eq!(
            guard.validate_finalize(&repeated_finalize, 251),
            Err(ProtocolError::UnexpectedLeasePhase)
        );

        let finalized = authority
            .finalized(
                authenticated_finalize("peer-process", &finalize),
                grant.process_set_identity(),
                &peer("peer-process"),
                true,
                true,
                true,
                true,
                200,
                300,
                400,
                500,
            )
            .unwrap();
        let repeated_finalized = finalized.clone();
        guard.validate_finalized_response(&finalized, 500).unwrap();
        assert_eq!(
            guard.validate_finalized_response(&repeated_finalized, 501),
            Err(ProtocolError::UnexpectedLeasePhase)
        );

        assert_eq!(
            authority.begin_lease(&request, &grant, 900).unwrap_err(),
            ProtocolError::DeadlineReached
        );
    }

    #[test]
    fn replay_registry_prunes_expired_transcripts() {
        let request = request();
        let (authority, _, grant) = authoritative_lease_material();
        let _guard = authority.begin_lease(&request, &grant, 100).unwrap();
        {
            let state = authority.replay_registry.state.lock().unwrap();
            assert_eq!(state.issued_requests.len(), 1);
            assert_eq!(state.consumed_leases.len(), 1);
        }

        let current = authority
            .issue_challenge_with_nonce(
                &peer("peer-process"),
                digest("post-expiry-challenge"),
                1_001,
                2_000,
            )
            .unwrap();
        let state = authority.replay_registry.state.lock().unwrap();
        assert!(state.issued_requests.is_empty());
        assert!(state.consumed_leases.is_empty());
        assert_eq!(state.issued_challenges.len(), 1);
        assert!(state
            .issued_challenges
            .contains_key(&current.challenge_binding()));
    }

    #[test]
    fn secret_material_is_out_of_band_and_encoded_buffers_are_redacted() {
        let (offer, grant) = lease_material();
        let messages = [
            ClosedExecutionMessage::Granted(offer),
            ClosedExecutionMessage::Attach(AttachLeaseRequest::from_grant(&grant).unwrap()),
            ClosedExecutionMessage::Finalize(
                FinalizeLeaseRequest::from_grant(&grant, FinalizeReason::LeaderExited, 250)
                    .unwrap(),
            ),
        ];
        for message in messages {
            let encoded = message.encode().unwrap();
            assert!(!encoded
                .as_bytes()
                .windows(SECRET_BYTES)
                .any(|window| window == [7; SECRET_BYTES]));
            assert!(format!("{encoded:?}").contains("[REDACTED]"));
        }
    }

    #[test]
    fn refusal_codes_require_canonical_lease_presence() {
        let grant = grant();
        assert_eq!(
            LeaseRefused::new(
                grant.request_id(),
                None,
                RefusalCode::ProcessSetNotQuiescent,
                300,
                &signer(),
            ),
            Err(ProtocolError::InvalidField)
        );
        assert_eq!(
            LeaseRefused::new(
                grant.request_id(),
                Some(grant.lease_id()),
                RefusalCode::LeaseUnavailable,
                300,
                &signer(),
            ),
            Err(ProtocolError::InvalidField)
        );
    }

    #[test]
    fn lease_secrets_are_redacted_and_zero_is_rejected() {
        assert_eq!(
            format!("{:?}", LeaseSecret::from_bytes([9; SECRET_BYTES]).unwrap()),
            "LeaseSecret([REDACTED])"
        );
        assert_eq!(
            LeaseSecret::from_bytes([0; SECRET_BYTES]),
            Err(ProtocolError::InvalidField)
        );
    }

    #[test]
    fn request_deadlines_fail_closed() {
        let authority = authority();
        let challenge = challenge_for(&authority, "deadline-challenge");
        let verifier = authority.verifier();
        let args = || {
            (
                digest("nonce"),
                digest("invocation"),
                digest("executable"),
                digest("closure"),
                digest("policy"),
                digest("capabilities"),
            )
        };
        let (a, b, c, d, e, f) = args();
        assert_eq!(
            AcquireLeaseRequest::new(a, &challenge, &verifier, b, c, d, e, f, 0, 20),
            Err(ProtocolError::InvalidField)
        );
        let (a, b, c, d, e, f) = args();
        assert_eq!(
            AcquireLeaseRequest::new(a, &challenge, &verifier, b, c, d, e, f, 1_001, 20),
            Err(ProtocolError::InvalidField)
        );
    }
}
