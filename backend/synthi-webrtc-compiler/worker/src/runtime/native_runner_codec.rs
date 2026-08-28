use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const NATIVE_RUNNER_OUTPUT_RECORD_MAX_BYTES: usize = 24 * 1024 * 1024;
pub const NATIVE_RUNNER_GENERAL_CHANNEL_CAPACITY: usize = 4;
pub const NATIVE_RUNNER_PROTOCOL_CHANNEL_CAPACITY: usize = 2;
pub const NATIVE_RUNNER_GENERAL_CHANNEL_MAX_RETAINED_BYTES: usize =
    NATIVE_RUNNER_OUTPUT_RECORD_MAX_BYTES * NATIVE_RUNNER_GENERAL_CHANNEL_CAPACITY;
pub const NATIVE_RUNNER_PROTOCOL_CHANNEL_MAX_RETAINED_BYTES: usize =
    NATIVE_RUNNER_OUTPUT_RECORD_MAX_BYTES * NATIVE_RUNNER_PROTOCOL_CHANNEL_CAPACITY;
const NATIVE_RUNNER_OUTPUT_READ_CHUNK_BYTES: usize = 8 * 1024;
const NATIVE_RUNNER_EXECUTION_ACTIVE: u8 = 0;
const NATIVE_RUNNER_EXECUTION_FAULTED: u8 = 1;
const NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED: u8 = 2;

pub const RUNNER_STDOUT_MODE_ENV: &str = "SYNTHI_RUNNER_STDOUT_MODE";
pub const RUNNER_STDOUT_MODE_SCHEMA_V1: &str = "synthi.native_runner.stdout_mode.v1";
const RUNNER_STDOUT_MODE_CONTRACT_MAX_BYTES: usize = 512;
const TEXT_RECORDS_CAPABILITY: &str = "text_records";
const UTF8_LINES_TRANSPORT: &str = "utf8_lines";
const FRAME_STREAM_CAPABILITY: &str = "frame_stream";
const RAW_FRAME_BYTES_TRANSPORT: &str = "raw_frame_bytes";
pub const RUNNER_STDOUT_TEXT_MODE_V1: &str = r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v1","capability":"text_records","transport":"utf8_lines"}"#;
pub const RUNNER_STDOUT_RAW_FRAME_MODE_V1: &str = r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v1","capability":"frame_stream","transport":"raw_frame_bytes"}"#;

pub const NATIVE_RUNNER_RESOURCE_FAULT_SCHEMA_VERSION: &str =
    "synthi.native_runner.resource_fault.v1";
const NATIVE_RUNNER_RESOURCE_FAULT_TYPE: &str = "native-runner-resource-fault";
const NATIVE_RUNNER_OUTPUT_RECORD_RESOURCE: &str = "native-runner-output-record";

#[derive(Debug)]
pub struct NativeRunnerOutputLifecycle {
    process_faulted: AtomicBool,
    execution_terminal: AtomicU8,
}

impl NativeRunnerOutputLifecycle {
    pub fn new() -> Self {
        Self {
            process_faulted: AtomicBool::new(false),
            execution_terminal: AtomicU8::new(NATIVE_RUNNER_EXECUTION_ACTIVE),
        }
    }

    /// Starts a new serialized execution only while the process output remains healthy.
    pub fn begin_execution(&self) -> bool {
        if self.process_faulted.load(Ordering::Acquire) {
            return false;
        }

        loop {
            match self.execution_terminal.load(Ordering::Acquire) {
                NATIVE_RUNNER_EXECUTION_ACTIVE => break,
                NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED => {
                    if self
                        .execution_terminal
                        .compare_exchange(
                            NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED,
                            NATIVE_RUNNER_EXECUTION_ACTIVE,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        break;
                    }
                }
                NATIVE_RUNNER_EXECUTION_FAULTED => return false,
                _ => return false,
            }
        }

        !self.process_faulted.load(Ordering::Acquire)
    }

    /// Records process-level output failure and atomically contests the active execution.
    /// Returns true only for the first process-level fault notification.
    pub fn record_fault(&self) -> bool {
        let _ = self.execution_terminal.compare_exchange(
            NATIVE_RUNNER_EXECUTION_ACTIVE,
            NATIVE_RUNNER_EXECUTION_FAULTED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        !self.process_faulted.swap(true, Ordering::AcqRel)
    }

    pub fn process_faulted(&self) -> bool {
        self.process_faulted.load(Ordering::Acquire)
    }

    /// Atomically publishes the execution terminal. A preceding fault makes this fail.
    pub fn try_commit_execution_success(&self) -> bool {
        if self.process_faulted.load(Ordering::Acquire) {
            return false;
        }
        self.execution_terminal
            .compare_exchange(
                NATIVE_RUNNER_EXECUTION_ACTIVE,
                NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}

impl Default for NativeRunnerOutputLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStdoutMode {
    LegacyRawFrameBytes,
    TextRecordsV1,
    RawFrameBytesV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerStdoutModeContractV1<'a> {
    schema_version: &'a str,
    capability: &'a str,
    transport: &'a str,
}

impl RunnerStdoutMode {
    pub fn parse(configured: Option<&str>) -> Result<Self, RunnerStdoutModeParseError> {
        let Some(configured) = configured else {
            return Ok(Self::LegacyRawFrameBytes);
        };
        let configured = configured.trim();
        if configured.is_empty() {
            return Err(RunnerStdoutModeParseError::EmptyContract);
        }
        if configured.len() > RUNNER_STDOUT_MODE_CONTRACT_MAX_BYTES {
            return Err(RunnerStdoutModeParseError::ContractTooLarge);
        }
        let contract: RunnerStdoutModeContractV1<'_> = serde_json::from_str(configured)
            .map_err(|_| RunnerStdoutModeParseError::MalformedContract)?;
        if contract.schema_version != RUNNER_STDOUT_MODE_SCHEMA_V1 {
            return Err(RunnerStdoutModeParseError::UnsupportedSchema);
        }

        match (contract.capability, contract.transport) {
            (TEXT_RECORDS_CAPABILITY, UTF8_LINES_TRANSPORT) => Ok(Self::TextRecordsV1),
            (FRAME_STREAM_CAPABILITY, RAW_FRAME_BYTES_TRANSPORT) => Ok(Self::RawFrameBytesV1),
            _ => Err(RunnerStdoutModeParseError::UnsupportedCapabilityTransport),
        }
    }

    pub fn writes_raw_frame_bytes(self) -> bool {
        matches!(self, Self::LegacyRawFrameBytes | Self::RawFrameBytesV1)
    }

    pub fn validate_transport_available(
        self,
        raw_frame_transport_available: bool,
    ) -> Result<Self, RunnerStdoutModeParseError> {
        if self == Self::RawFrameBytesV1 && !raw_frame_transport_available {
            return Err(RunnerStdoutModeParseError::UnavailableCapabilityTransport);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStdoutModeParseError {
    EmptyContract,
    ContractTooLarge,
    MalformedContract,
    UnsupportedSchema,
    UnsupportedCapabilityTransport,
    UnavailableCapabilityTransport,
}

impl fmt::Display for RunnerStdoutModeParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyContract => "stdout mode contract is empty",
            Self::ContractTooLarge => "stdout mode contract exceeds its byte limit",
            Self::MalformedContract => "stdout mode contract is malformed",
            Self::UnsupportedSchema => "stdout mode contract schema is unsupported",
            Self::UnsupportedCapabilityTransport => {
                "stdout mode capability and transport are unsupported"
            }
            Self::UnavailableCapabilityTransport => {
                "stdout mode capability and transport are unavailable in this execution mode"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RunnerStdoutModeParseError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRunnerOutputStream {
    Stdout,
    Stderr,
}

impl NativeRunnerOutputStream {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeRunnerResourceFaultKind {
    RecordTooLarge,
    InvalidUtf8,
    OutputReadFailed,
}

impl NativeRunnerResourceFaultKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RecordTooLarge => "record_too_large",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::OutputReadFailed => "output_read_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunnerResourceFault {
    #[serde(rename = "type")]
    diagnostic_type: &'static str,
    schema_version: &'static str,
    resource: &'static str,
    stream: NativeRunnerOutputStream,
    fault: NativeRunnerResourceFaultKind,
    record_limit_bytes: usize,
}

impl NativeRunnerResourceFault {
    pub const fn new(
        stream: NativeRunnerOutputStream,
        fault: NativeRunnerResourceFaultKind,
        record_limit_bytes: usize,
    ) -> Self {
        Self {
            diagnostic_type: NATIVE_RUNNER_RESOURCE_FAULT_TYPE,
            schema_version: NATIVE_RUNNER_RESOURCE_FAULT_SCHEMA_VERSION,
            resource: NATIVE_RUNNER_OUTPUT_RECORD_RESOURCE,
            stream,
            fault,
            record_limit_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeRunnerOutputEvent {
    Record(String),
    ResourceFault(NativeRunnerResourceFaultKind),
}

#[derive(Debug)]
struct BoundedUtf8RecordDecoder {
    record_limit_bytes: usize,
    record: Vec<u8>,
    pending_cr: bool,
    discarding_oversized_record: bool,
}

impl BoundedUtf8RecordDecoder {
    fn new(record_limit_bytes: usize) -> Self {
        assert!(record_limit_bytes > 0, "record limit must be non-zero");
        Self {
            record_limit_bytes,
            record: Vec::new(),
            pending_cr: false,
            discarding_oversized_record: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<NativeRunnerOutputEvent> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.discarding_oversized_record {
                if byte == b'\n' {
                    self.discarding_oversized_record = false;
                }
                continue;
            }

            if byte == b'\n' {
                self.pending_cr = false;
                events.push(self.finish_record());
                continue;
            }

            if self.pending_cr {
                self.pending_cr = false;
                if !self.push_record_byte(b'\r', &mut events) {
                    continue;
                }
            }
            if byte == b'\r' {
                self.pending_cr = true;
            } else {
                self.push_record_byte(byte, &mut events);
            }
        }
        events
    }

    fn push_record_byte(&mut self, byte: u8, events: &mut Vec<NativeRunnerOutputEvent>) -> bool {
        if self.record.len() < self.record_limit_bytes {
            self.record.push(byte);
            true
        } else {
            self.record = Vec::new();
            self.pending_cr = false;
            self.discarding_oversized_record = true;
            events.push(NativeRunnerOutputEvent::ResourceFault(
                NativeRunnerResourceFaultKind::RecordTooLarge,
            ));
            false
        }
    }

    fn finish(&mut self) -> Vec<NativeRunnerOutputEvent> {
        if self.discarding_oversized_record {
            self.discarding_oversized_record = false;
            self.record = Vec::new();
            self.pending_cr = false;
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.pending_cr {
            self.pending_cr = false;
            if !self.push_record_byte(b'\r', &mut events) {
                return events;
            }
        }
        if !self.record.is_empty() {
            events.push(self.finish_record());
        }
        events
    }

    fn finish_record(&mut self) -> NativeRunnerOutputEvent {
        let record = std::mem::take(&mut self.record);
        debug_assert!(record.len() <= self.record_limit_bytes);
        match String::from_utf8(record) {
            Ok(record) => NativeRunnerOutputEvent::Record(record),
            Err(_) => {
                NativeRunnerOutputEvent::ResourceFault(NativeRunnerResourceFaultKind::InvalidUtf8)
            }
        }
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        self.record.len()
    }
}

pub struct BoundedUtf8RecordReader<R> {
    reader: R,
    decoder: BoundedUtf8RecordDecoder,
    pending: VecDeque<NativeRunnerOutputEvent>,
    read_buffer: Vec<u8>,
    reached_eof: bool,
}

impl<R> BoundedUtf8RecordReader<R> {
    pub fn new(reader: R, record_limit_bytes: usize) -> Self {
        Self {
            reader,
            decoder: BoundedUtf8RecordDecoder::new(record_limit_bytes),
            pending: VecDeque::new(),
            read_buffer: vec![0; NATIVE_RUNNER_OUTPUT_READ_CHUNK_BYTES],
            reached_eof: false,
        }
    }
}

impl<R: AsyncRead + Unpin> BoundedUtf8RecordReader<R> {
    pub async fn next_event(&mut self) -> io::Result<Option<NativeRunnerOutputEvent>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.reached_eof {
                return Ok(None);
            }

            let bytes_read = self.reader.read(&mut self.read_buffer).await?;
            if bytes_read == 0 {
                self.reached_eof = true;
                self.pending.extend(self.decoder.finish());
            } else {
                self.pending
                    .extend(self.decoder.push(&self.read_buffer[..bytes_read]));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedUtf8RecordDecoder, NativeRunnerOutputEvent, NativeRunnerResourceFaultKind,
        RunnerStdoutMode, RUNNER_STDOUT_RAW_FRAME_MODE_V1, RUNNER_STDOUT_TEXT_MODE_V1,
    };

    #[test]
    fn exact_limit_records_are_accepted_with_newline_or_crlf() {
        let mut newline = BoundedUtf8RecordDecoder::new(4);
        assert_eq!(
            newline.push(b"abcd\n"),
            vec![NativeRunnerOutputEvent::Record("abcd".to_string())]
        );

        let mut crlf = BoundedUtf8RecordDecoder::new(4);
        assert!(crlf.push(b"abcd\r").is_empty());
        assert_eq!(
            crlf.push(b"\n"),
            vec![NativeRunnerOutputEvent::Record("abcd".to_string())]
        );
    }

    #[test]
    fn limit_plus_one_is_rejected_once_and_decoder_recovers_after_newline() {
        let mut decoder = BoundedUtf8RecordDecoder::new(4);
        assert_eq!(
            decoder.push(b"abcde\nnext\n"),
            vec![
                NativeRunnerOutputEvent::ResourceFault(
                    NativeRunnerResourceFaultKind::RecordTooLarge
                ),
                NativeRunnerOutputEvent::Record("next".to_string()),
            ]
        );
    }

    #[test]
    fn missing_newline_never_increases_retained_bytes_after_overflow() {
        let mut decoder = BoundedUtf8RecordDecoder::new(4);
        let mut events = Vec::new();
        for _ in 0..128 {
            events.extend(decoder.push(b"abcdefgh"));
            assert!(decoder.retained_bytes() <= 4);
        }
        assert_eq!(
            events,
            vec![NativeRunnerOutputEvent::ResourceFault(
                NativeRunnerResourceFaultKind::RecordTooLarge
            )]
        );
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn invalid_utf8_is_a_resource_fault_without_a_decoded_record() {
        let mut decoder = BoundedUtf8RecordDecoder::new(8);
        assert_eq!(
            decoder.push(b"bad\xff\n"),
            vec![NativeRunnerOutputEvent::ResourceFault(
                NativeRunnerResourceFaultKind::InvalidUtf8
            )]
        );
    }

    #[test]
    fn crlf_is_trimmed_and_unterminated_eof_record_is_preserved() {
        let mut decoder = BoundedUtf8RecordDecoder::new(16);
        assert_eq!(
            decoder.push(b"first\r\nsecond"),
            vec![NativeRunnerOutputEvent::Record("first".to_string())]
        );
        assert_eq!(
            decoder.finish(),
            vec![NativeRunnerOutputEvent::Record("second".to_string())]
        );

        let mut trailing_cr = BoundedUtf8RecordDecoder::new(16);
        assert!(trailing_cr.push(b"third\r").is_empty());
        assert_eq!(
            trailing_cr.finish(),
            vec![NativeRunnerOutputEvent::Record("third\r".to_string())]
        );

        let mut overflowing_trailing_cr = BoundedUtf8RecordDecoder::new(4);
        assert!(overflowing_trailing_cr.push(b"four\r").is_empty());
        assert_eq!(
            overflowing_trailing_cr.finish(),
            vec![NativeRunnerOutputEvent::ResourceFault(
                NativeRunnerResourceFaultKind::RecordTooLarge
            )]
        );
    }

    #[test]
    fn stdout_mode_parser_requires_supported_version_capability_and_transport() {
        assert_eq!(
            RunnerStdoutMode::parse(None).unwrap(),
            RunnerStdoutMode::LegacyRawFrameBytes
        );
        assert_eq!(
            RunnerStdoutMode::parse(Some(RUNNER_STDOUT_TEXT_MODE_V1)).unwrap(),
            RunnerStdoutMode::TextRecordsV1
        );
        assert_eq!(
            RunnerStdoutMode::parse(Some(RUNNER_STDOUT_RAW_FRAME_MODE_V1)).unwrap(),
            RunnerStdoutMode::RawFrameBytesV1
        );
        assert!(RunnerStdoutMode::parse(Some(
            r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v2","capability":"text_records","transport":"utf8_lines"}"#
        ))
        .is_err());
        assert!(RunnerStdoutMode::parse(Some(
            r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v1","capability":"text_records","transport":"raw_frame_bytes"}"#
        ))
        .is_err());
        assert!(RunnerStdoutMode::parse(Some(
            r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v1","capability":"text_records"}"#
        ))
        .is_err());
        assert!(RunnerStdoutMode::parse(Some(
            r#"{"schemaVersion":"synthi.native_runner.stdout_mode.v1","capability":"text_records","transport":"utf8_lines","project":"ignored"}"#
        ))
        .is_err());
        assert!(RunnerStdoutMode::parse(Some(&"x".repeat(513))).is_err());
    }

    #[test]
    fn explicit_raw_frame_contract_requires_an_available_transport() {
        assert!(RunnerStdoutMode::RawFrameBytesV1
            .validate_transport_available(false)
            .is_err());
        assert_eq!(
            RunnerStdoutMode::RawFrameBytesV1
                .validate_transport_available(true)
                .unwrap(),
            RunnerStdoutMode::RawFrameBytesV1
        );
        assert_eq!(
            RunnerStdoutMode::TextRecordsV1
                .validate_transport_available(false)
                .unwrap(),
            RunnerStdoutMode::TextRecordsV1
        );
        assert_eq!(
            RunnerStdoutMode::LegacyRawFrameBytes
                .validate_transport_available(false)
                .unwrap(),
            RunnerStdoutMode::LegacyRawFrameBytes
        );
    }

    #[test]
    fn execution_terminal_allows_exactly_one_fault_or_success_winner() {
        let fault_first = super::NativeRunnerOutputLifecycle::new();
        assert!(fault_first.record_fault());
        assert!(!fault_first.try_commit_execution_success());
        assert_eq!(
            fault_first
                .execution_terminal
                .load(std::sync::atomic::Ordering::Acquire),
            super::NATIVE_RUNNER_EXECUTION_FAULTED
        );

        let success_first = super::NativeRunnerOutputLifecycle::new();
        assert!(success_first.try_commit_execution_success());
        assert!(success_first.record_fault());
        assert_eq!(
            success_first
                .execution_terminal
                .load(std::sync::atomic::Ordering::Acquire),
            super::NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED
        );
        assert!(success_first.process_faulted());
        assert!(!success_first.begin_execution());
    }

    #[test]
    fn concurrent_fault_and_success_have_one_linearized_terminal() {
        for _ in 0..128 {
            let lifecycle = std::sync::Arc::new(super::NativeRunnerOutputLifecycle::new());
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));

            let success_lifecycle = lifecycle.clone();
            let success_barrier = barrier.clone();
            let success = std::thread::spawn(move || {
                success_barrier.wait();
                success_lifecycle.try_commit_execution_success()
            });

            let fault_lifecycle = lifecycle.clone();
            let fault_barrier = barrier.clone();
            let fault = std::thread::spawn(move || {
                fault_barrier.wait();
                fault_lifecycle.record_fault();
            });

            barrier.wait();
            let success_committed = success.join().unwrap();
            fault.join().unwrap();
            let terminal = lifecycle
                .execution_terminal
                .load(std::sync::atomic::Ordering::Acquire);
            assert!(matches!(
                terminal,
                super::NATIVE_RUNNER_EXECUTION_FAULTED
                    | super::NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED
            ));
            assert_eq!(
                success_committed,
                terminal == super::NATIVE_RUNNER_EXECUTION_SUCCESS_COMMITTED
            );
            assert!(lifecycle.process_faulted());
        }
    }

    #[test]
    fn protocol_channel_has_a_bounded_aggregate_retention_policy() {
        assert!(super::NATIVE_RUNNER_GENERAL_CHANNEL_CAPACITY > 0);
        assert!(super::NATIVE_RUNNER_PROTOCOL_CHANNEL_CAPACITY > 0);
        assert!(super::NATIVE_RUNNER_GENERAL_CHANNEL_MAX_RETAINED_BYTES <= 128 * 1024 * 1024);
        assert!(super::NATIVE_RUNNER_PROTOCOL_CHANNEL_MAX_RETAINED_BYTES <= 64 * 1024 * 1024);
    }
}
