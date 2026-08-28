use crate::runtime::runner_protocol::{
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES,
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS,
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK,
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES,
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS,
    RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES,
};
use std::fmt;
use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerCommandAdmissionClass {
    General,
    Reserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerCommandAdmissionLimits {
    pub max_command_bytes: u64,
    pub max_queue_items: u64,
    pub max_queue_retained_bytes: u64,
    pub reserved_queue_items: u64,
    pub reserved_queue_retained_bytes: u64,
}

impl RunnerCommandAdmissionLimits {
    pub fn at_consumer_maxima() -> Self {
        Self {
            max_command_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES,
            max_queue_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS,
            max_queue_retained_bytes: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES,
            reserved_queue_items: RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS,
            reserved_queue_retained_bytes:
                RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES,
        }
    }

    pub fn validate(self) -> Result<Self, RunnerCommandAdmissionError> {
        if self.max_command_bytes == 0
            || self.max_queue_items == 0
            || self.max_queue_retained_bytes == 0
            || self.reserved_queue_items == 0
            || self.reserved_queue_retained_bytes == 0
        {
            return Err(RunnerCommandAdmissionError::InvalidLimits(
                "runner command admission limits must be nonzero",
            ));
        }
        if self.reserved_queue_items >= self.max_queue_items
            || self.reserved_queue_retained_bytes >= self.max_queue_retained_bytes
        {
            return Err(RunnerCommandAdmissionError::InvalidLimits(
                "runner command admission reserve must be smaller than the total limit",
            ));
        }
        if self.max_command_bytes > self.max_queue_retained_bytes {
            return Err(RunnerCommandAdmissionError::InvalidLimits(
                "runner command limit exceeds aggregate retained-byte limit",
            ));
        }
        if self.max_command_bytes > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES
            || self.max_queue_items > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_ITEMS
            || self.max_queue_retained_bytes
                > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES
            || self.reserved_queue_items > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_ITEMS
            || self.reserved_queue_retained_bytes
                > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_ATOMIC_BATCH_BYTES
        {
            return Err(RunnerCommandAdmissionError::InvalidLimits(
                "runner command admission limits exceed consumer maxima",
            ));
        }
        Ok(self)
    }

    pub fn channel_capacity(self) -> Result<usize, RunnerCommandAdmissionError> {
        usize::try_from(self.max_queue_items).map_err(|_| {
            RunnerCommandAdmissionError::InvalidLimits(
                "runner queue item limit does not fit this platform",
            )
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerCommandAdmissionUsage {
    pub retained_items: u64,
    pub retained_bytes: u64,
    pub general_retained_items: u64,
    pub general_retained_bytes: u64,
    pub reserved_retained_items: u64,
    pub reserved_retained_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerCommandAdmissionError {
    InvalidLimits(&'static str),
    CommandTooLarge { actual: u64, maximum: u64 },
    QueueItemLimit { maximum: u64 },
    QueueRetainedByteLimit { maximum: u64 },
    AccountingOverflow,
}

impl RunnerCommandAdmissionError {
    pub fn is_capacity_exhausted(&self) -> bool {
        matches!(
            self,
            Self::QueueItemLimit { .. } | Self::QueueRetainedByteLimit { .. }
        )
    }
}

impl fmt::Display for RunnerCommandAdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimits(message) => formatter.write_str(message),
            Self::CommandTooLarge { actual, maximum } => write!(
                formatter,
                "runner command is {actual} bytes, exceeding the {maximum}-byte limit"
            ),
            Self::QueueItemLimit { maximum } => {
                write!(
                    formatter,
                    "runner command queue reached its {maximum}-item limit"
                )
            }
            Self::QueueRetainedByteLimit { maximum } => write!(
                formatter,
                "runner command queue reached its {maximum}-byte retained-data limit"
            ),
            Self::AccountingOverflow => {
                formatter.write_str("runner command admission accounting overflowed")
            }
        }
    }
}

impl std::error::Error for RunnerCommandAdmissionError {}

#[derive(Debug, Default)]
struct RunnerCommandAdmissionCounters {
    retained_items: u64,
    retained_bytes: u64,
    general_retained_items: u64,
    general_retained_bytes: u64,
    reserved_retained_items: u64,
    reserved_retained_bytes: u64,
}

#[derive(Debug)]
struct RunnerCommandAdmissionInner {
    limits: RunnerCommandAdmissionLimits,
    counters: Mutex<RunnerCommandAdmissionCounters>,
}

#[derive(Debug, Clone)]
pub struct RunnerCommandAdmission {
    inner: Arc<RunnerCommandAdmissionInner>,
}

impl RunnerCommandAdmission {
    pub fn new(limits: RunnerCommandAdmissionLimits) -> Result<Self, RunnerCommandAdmissionError> {
        Ok(Self {
            inner: Arc::new(RunnerCommandAdmissionInner {
                limits: limits.validate()?,
                counters: Mutex::new(RunnerCommandAdmissionCounters::default()),
            }),
        })
    }

    pub fn at_consumer_maxima() -> Self {
        Self::new(RunnerCommandAdmissionLimits::at_consumer_maxima())
            .expect("runner command consumer maxima must be internally consistent")
    }

    pub fn channel_capacity(&self) -> usize {
        self.inner
            .limits
            .channel_capacity()
            .expect("validated runner queue limit must fit this platform")
    }

    pub fn max_command_bytes(&self) -> usize {
        usize::try_from(self.inner.limits.max_command_bytes)
            .expect("validated runner command limit must fit this platform")
    }

    pub fn try_admit(
        &self,
        retained_bytes: usize,
        class: RunnerCommandAdmissionClass,
    ) -> Result<RunnerCommandAdmissionLease, RunnerCommandAdmissionError> {
        let retained_bytes = u64::try_from(retained_bytes)
            .map_err(|_| RunnerCommandAdmissionError::AccountingOverflow)?;
        let limits = self.inner.limits;
        if retained_bytes > limits.max_command_bytes {
            return Err(RunnerCommandAdmissionError::CommandTooLarge {
                actual: retained_bytes,
                maximum: limits.max_command_bytes,
            });
        }

        let mut counters = self
            .inner
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next_items = counters
            .retained_items
            .checked_add(1)
            .ok_or(RunnerCommandAdmissionError::AccountingOverflow)?;
        let next_bytes = counters
            .retained_bytes
            .checked_add(retained_bytes)
            .ok_or(RunnerCommandAdmissionError::AccountingOverflow)?;
        let (class_items, class_bytes, item_limit, byte_limit) = match class {
            RunnerCommandAdmissionClass::General => (
                counters.general_retained_items,
                counters.general_retained_bytes,
                limits.max_queue_items - limits.reserved_queue_items,
                limits.max_queue_retained_bytes - limits.reserved_queue_retained_bytes,
            ),
            RunnerCommandAdmissionClass::Reserved => (
                counters.reserved_retained_items,
                counters.reserved_retained_bytes,
                limits.reserved_queue_items,
                limits.reserved_queue_retained_bytes,
            ),
        };
        let next_class_items = class_items
            .checked_add(1)
            .ok_or(RunnerCommandAdmissionError::AccountingOverflow)?;
        let next_class_bytes = class_bytes
            .checked_add(retained_bytes)
            .ok_or(RunnerCommandAdmissionError::AccountingOverflow)?;
        if next_items > limits.max_queue_items || next_class_items > item_limit {
            return Err(RunnerCommandAdmissionError::QueueItemLimit {
                maximum: item_limit,
            });
        }
        if next_bytes > limits.max_queue_retained_bytes || next_class_bytes > byte_limit {
            return Err(RunnerCommandAdmissionError::QueueRetainedByteLimit {
                maximum: byte_limit,
            });
        }

        counters.retained_items = next_items;
        counters.retained_bytes = next_bytes;
        match class {
            RunnerCommandAdmissionClass::General => {
                counters.general_retained_items = next_class_items;
                counters.general_retained_bytes = next_class_bytes;
            }
            RunnerCommandAdmissionClass::Reserved => {
                counters.reserved_retained_items = next_class_items;
                counters.reserved_retained_bytes = next_class_bytes;
            }
        }
        drop(counters);
        Ok(RunnerCommandAdmissionLease {
            inner: Arc::clone(&self.inner),
            retained_bytes,
            class,
        })
    }

    pub fn usage(&self) -> RunnerCommandAdmissionUsage {
        let counters = self
            .inner
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        RunnerCommandAdmissionUsage {
            retained_items: counters.retained_items,
            retained_bytes: counters.retained_bytes,
            general_retained_items: counters.general_retained_items,
            general_retained_bytes: counters.general_retained_bytes,
            reserved_retained_items: counters.reserved_retained_items,
            reserved_retained_bytes: counters.reserved_retained_bytes,
        }
    }
}

#[derive(Debug)]
pub struct RunnerCommandAdmissionLease {
    inner: Arc<RunnerCommandAdmissionInner>,
    retained_bytes: u64,
    class: RunnerCommandAdmissionClass,
}

impl Drop for RunnerCommandAdmissionLease {
    fn drop(&mut self) {
        let mut counters = self
            .inner
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert!(counters.retained_items > 0);
        debug_assert!(counters.retained_bytes >= self.retained_bytes);
        counters.retained_items = counters
            .retained_items
            .checked_sub(1)
            .expect("runner command item accounting underflow");
        counters.retained_bytes = counters
            .retained_bytes
            .checked_sub(self.retained_bytes)
            .expect("runner command byte accounting underflow");
        match self.class {
            RunnerCommandAdmissionClass::General => {
                counters.general_retained_items = counters
                    .general_retained_items
                    .checked_sub(1)
                    .expect("runner general-command item accounting underflow");
                counters.general_retained_bytes = counters
                    .general_retained_bytes
                    .checked_sub(self.retained_bytes)
                    .expect("runner general-command byte accounting underflow");
            }
            RunnerCommandAdmissionClass::Reserved => {
                counters.reserved_retained_items = counters
                    .reserved_retained_items
                    .checked_sub(1)
                    .expect("runner reserved-command item accounting underflow");
                counters.reserved_retained_bytes = counters
                    .reserved_retained_bytes
                    .checked_sub(self.retained_bytes)
                    .expect("runner reserved-command byte accounting underflow");
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerCommandWorkBudget {
    remaining_commands: u64,
}

impl RunnerCommandWorkBudget {
    pub fn new(max_commands: u64) -> Result<Self, RunnerCommandAdmissionError> {
        if max_commands == 0
            || max_commands > RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK
        {
            return Err(RunnerCommandAdmissionError::InvalidLimits(
                "runner command work budget is outside consumer maxima",
            ));
        }
        Ok(Self {
            remaining_commands: max_commands,
        })
    }

    pub fn at_consumer_maximum() -> Self {
        Self::new(RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMANDS_PER_TICK)
            .expect("runner command work maximum must be internally consistent")
    }

    pub fn consume_one(&mut self) -> bool {
        if self.remaining_commands == 0 {
            return false;
        }
        self.remaining_commands -= 1;
        true
    }

    pub fn remaining(&self) -> usize {
        usize::try_from(self.remaining_commands)
            .expect("validated runner command work budget must fit this platform")
    }

    pub fn exhausted(&self) -> bool {
        self.remaining_commands == 0
    }
}

fn drain_through_line_feed<R: BufRead>(reader: &mut R) -> io::Result<()> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(());
        }
        if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
            reader.consume(index + 1);
            return Ok(());
        }
        let consumed = available.len();
        reader.consume(consumed);
    }
}

/// Reads one command record without retaining more than the command limit plus
/// a possible CR delimiter. The returned bytes exclude LF and a preceding CR.
pub fn read_bounded_runner_command_line<R: BufRead>(
    reader: &mut R,
    max_command_bytes: usize,
) -> io::Result<Option<Vec<u8>>> {
    if max_command_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runner command line limit must be nonzero",
        ));
    }

    let mut line = Vec::with_capacity(max_command_bytes.min(8192));
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }

        if let Some(line_feed) = available.iter().position(|byte| *byte == b'\n') {
            let trailing_cr = if line_feed > 0 {
                available[line_feed - 1] == b'\r'
            } else {
                line.last() == Some(&b'\r')
            };
            let combined_bytes = line
                .len()
                .checked_add(line_feed)
                .ok_or_else(|| io::Error::other("runner command line length overflow"))?;
            let command_bytes = combined_bytes.saturating_sub(usize::from(trailing_cr));
            if command_bytes > max_command_bytes {
                reader.consume(line_feed + 1);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "runner command line exceeds the configured byte limit",
                ));
            }
            line.extend_from_slice(&available[..line_feed]);
            reader.consume(line_feed + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }

        if line.len() > max_command_bytes {
            let consumed = available.len();
            reader.consume(consumed);
            drain_through_line_feed(reader)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runner command line exceeds the configured byte limit",
            ));
        }
        let combined_bytes = line
            .len()
            .checked_add(available.len())
            .ok_or_else(|| io::Error::other("runner command line length overflow"))?;
        let delimiter_allowance = usize::from(available.last() == Some(&b'\r'));
        let maximum_retained_bytes = max_command_bytes
            .checked_add(delimiter_allowance)
            .ok_or_else(|| io::Error::other("runner command line limit overflow"))?;
        if combined_bytes > maximum_retained_bytes {
            let consumed = available.len();
            reader.consume(consumed);
            drain_through_line_feed(reader)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runner command line exceeds the configured byte limit",
            ));
        }
        line.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        read_bounded_runner_command_line, RunnerCommandAdmission, RunnerCommandAdmissionClass,
        RunnerCommandAdmissionError, RunnerCommandAdmissionLimits, RunnerCommandAdmissionUsage,
        RunnerCommandWorkBudget,
    };
    use std::io::{BufReader, Cursor};

    fn test_admission() -> RunnerCommandAdmission {
        RunnerCommandAdmission::new(RunnerCommandAdmissionLimits {
            max_command_bytes: 8,
            max_queue_items: 4,
            max_queue_retained_bytes: 16,
            reserved_queue_items: 1,
            reserved_queue_retained_bytes: 4,
        })
        .unwrap()
    }

    #[test]
    fn admission_tracks_and_releases_exact_usage() {
        let admission = test_admission();
        let first = admission
            .try_admit(5, RunnerCommandAdmissionClass::General)
            .unwrap();
        let second = admission
            .try_admit(7, RunnerCommandAdmissionClass::General)
            .unwrap();
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 2,
                retained_bytes: 12,
                general_retained_items: 2,
                general_retained_bytes: 12,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );
        drop(first);
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 1,
                retained_bytes: 7,
                general_retained_items: 1,
                general_retained_bytes: 7,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );
        drop(second);
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 0,
                retained_bytes: 0,
                general_retained_items: 0,
                general_retained_bytes: 0,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );
    }

    #[test]
    fn general_traffic_cannot_consume_reserved_capacity() {
        let admission = test_admission();
        let leases = (0..3)
            .map(|_| {
                admission
                    .try_admit(4, RunnerCommandAdmissionClass::General)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            admission.try_admit(1, RunnerCommandAdmissionClass::General),
            Err(RunnerCommandAdmissionError::QueueItemLimit { maximum: 3 })
                | Err(RunnerCommandAdmissionError::QueueRetainedByteLimit { maximum: 12 })
        ));
        let reserved = admission
            .try_admit(4, RunnerCommandAdmissionClass::Reserved)
            .unwrap();
        assert_eq!(admission.usage().retained_items, 4);
        drop(reserved);
        drop(leases);
        assert_eq!(admission.usage().retained_items, 0);
    }

    #[test]
    fn reserved_traffic_cannot_consume_general_capacity() {
        let admission = test_admission();
        let reserved = admission
            .try_admit(4, RunnerCommandAdmissionClass::Reserved)
            .unwrap();
        assert!(matches!(
            admission.try_admit(1, RunnerCommandAdmissionClass::Reserved),
            Err(RunnerCommandAdmissionError::QueueItemLimit { maximum: 1 })
                | Err(RunnerCommandAdmissionError::QueueRetainedByteLimit { maximum: 4 })
        ));
        let general = admission
            .try_admit(8, RunnerCommandAdmissionClass::General)
            .unwrap();
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 2,
                retained_bytes: 12,
                general_retained_items: 1,
                general_retained_bytes: 8,
                reserved_retained_items: 1,
                reserved_retained_bytes: 4,
            }
        );
        drop(reserved);
        drop(general);
        assert_eq!(admission.usage().retained_items, 0);
    }

    #[test]
    fn rejected_admission_does_not_corrupt_accounting() {
        let admission = test_admission();
        assert!(matches!(
            admission.try_admit(9, RunnerCommandAdmissionClass::Reserved),
            Err(RunnerCommandAdmissionError::CommandTooLarge { .. })
        ));
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 0,
                retained_bytes: 0,
                general_retained_items: 0,
                general_retained_bytes: 0,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );
        let lease = admission
            .try_admit(4, RunnerCommandAdmissionClass::Reserved)
            .unwrap();
        drop(lease);
        assert_eq!(admission.usage().retained_bytes, 0);
    }

    #[test]
    fn admission_rejects_limits_above_compile_time_consumer_maxima() {
        let error = RunnerCommandAdmission::new(RunnerCommandAdmissionLimits {
            max_command_bytes: super::RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_COMMAND_BYTES + 1,
            max_queue_items: 4,
            max_queue_retained_bytes:
                super::RUNNER_RESOURCE_POLICY_V1_CONSUMER_MAX_QUEUE_RETAINED_BYTES,
            reserved_queue_items: 1,
            reserved_queue_retained_bytes: 4,
        })
        .unwrap_err();
        assert_eq!(
            error,
            RunnerCommandAdmissionError::InvalidLimits(
                "runner command admission limits exceed consumer maxima"
            )
        );
    }

    #[test]
    fn work_budget_stops_exactly_at_the_configured_limit() {
        let mut budget = RunnerCommandWorkBudget::new(3).unwrap();
        assert_eq!(budget.remaining(), 3);
        assert!(budget.consume_one());
        assert!(budget.consume_one());
        assert!(budget.consume_one());
        assert!(budget.exhausted());
        assert!(!budget.consume_one());
        assert_eq!(budget.remaining(), 0);
    }

    #[test]
    fn bounded_line_reader_handles_lf_crlf_and_unterminated_eof() {
        let mut reader = BufReader::with_capacity(3, Cursor::new(b"alpha\r\nbeta\ngamma"));
        assert_eq!(
            read_bounded_runner_command_line(&mut reader, 8)
                .unwrap()
                .unwrap(),
            b"alpha"
        );
        assert_eq!(
            read_bounded_runner_command_line(&mut reader, 8)
                .unwrap()
                .unwrap(),
            b"beta"
        );
        assert_eq!(
            read_bounded_runner_command_line(&mut reader, 8)
                .unwrap()
                .unwrap(),
            b"gamma"
        );
        assert!(read_bounded_runner_command_line(&mut reader, 8)
            .unwrap()
            .is_none());
    }

    #[test]
    fn bounded_line_reader_drains_oversize_record_before_next_line() {
        let mut reader = BufReader::with_capacity(2, Cursor::new(b"toolong-record\nok\n"));
        let error = read_bounded_runner_command_line(&mut reader, 4).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(
            read_bounded_runner_command_line(&mut reader, 4)
                .unwrap()
                .unwrap(),
            b"ok"
        );
    }

    #[test]
    fn bounded_line_reader_allows_crlf_delimiter_overhead_at_exact_limit() {
        let mut reader = BufReader::with_capacity(4, Cursor::new(b"1234\r\n"));
        assert_eq!(
            read_bounded_runner_command_line(&mut reader, 4)
                .unwrap()
                .unwrap(),
            b"1234"
        );
    }
}
