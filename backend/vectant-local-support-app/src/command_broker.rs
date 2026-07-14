//! Bounded, shell-free command execution for Full Access diagnostics.

use std::path::Path;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::full_access::FullAccessPolicy;
use crate::scanner::SecretScanner;

#[derive(Debug, Clone, Deserialize)]
pub struct CommandRequest {
    pub request_id: String,
    pub executable: String,
    pub arguments: Vec<String>,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandContext {
    pub request_id: String,
    pub executable: String,
    pub argument_hash: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_truncated: bool,
    pub stdout: String,
    pub stderr: String,
    pub redaction_count: usize,
    pub bytes_captured: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    InvalidRequest,
    ExecutableDenied,
    OutputLimit,
    TimedOut,
    Cancelled,
    ProcessContainment,
    SpawnFailed,
    Io,
}

pub async fn execute_command(
    workspace: &Path,
    policy: &FullAccessPolicy,
    request: CommandRequest,
) -> Result<CommandContext, CommandError> {
    execute_command_cancellable(workspace, policy, request, Arc::new(AtomicBool::new(false))).await
}

pub async fn execute_command_cancellable(
    workspace: &Path,
    policy: &FullAccessPolicy,
    request: CommandRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<CommandContext, CommandError> {
    validate_request(workspace, policy, &request)?;
    let output_cap = request
        .max_output_bytes
        .min(policy.max_command_output_bytes);
    let timeout = Duration::from_secs(
        request
            .timeout_seconds
            .min(policy.max_command_timeout_seconds),
    );
    let mut command = Command::new(&request.executable);
    command
        .current_dir(workspace)
        .args(&request.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|_| CommandError::SpawnFailed)?;
    let process_id = child.id().ok_or(CommandError::SpawnFailed)?;
    let _command_job = match CommandJob::assign(process_id) {
        Ok(job) => job,
        Err(()) => {
            // Do not rely on asynchronous drop cleanup when containment cannot
            // be established: terminate the direct child before returning.
            let _ = child.kill().await;
            return Err(CommandError::ProcessContainment);
        }
    };
    let stdout = child.stdout.take().ok_or(CommandError::Io)?;
    let stderr = child.stderr.take().ok_or(CommandError::Io)?;
    let stdout_task = tokio::spawn(read_capped(stdout, output_cap));
    let stderr_task = tokio::spawn(read_capped(stderr, output_cap));
    let deadline = tokio::time::Instant::now() + timeout;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill().await;
            return Err(CommandError::Cancelled);
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            let _ = child.kill().await;
            return Err(CommandError::TimedOut);
        }
        let wait = child.wait();
        tokio::pin!(wait);
        tokio::select! {
            result = &mut wait => match result {
                Ok(status) => break status,
                Err(_) => return Err(CommandError::Io),
            },
            _ = tokio::time::sleep_until((now + Duration::from_millis(50)).min(deadline)) => {}
        }
    };
    let (stdout, stdout_truncated) = stdout_task.await.map_err(|_| CommandError::Io)??;
    let (stderr, stderr_truncated) = stderr_task.await.map_err(|_| CommandError::Io)??;
    if stdout_truncated || stderr_truncated {
        return Err(CommandError::OutputLimit);
    }
    let scanner = SecretScanner::default();
    let combined = format!("{stdout}\n{stderr}");
    let report = scanner.try_scan(&combined).map_err(|_| CommandError::Io)?;
    let stdout_report = scanner.scan(&stdout);
    let stderr_report = scanner.scan(&stderr);
    let clean_stdout = strip_terminal_controls(&scanner.redact(&stdout, &stdout_report));
    let clean_stderr = strip_terminal_controls(&scanner.redact(&stderr, &stderr_report));
    Ok(CommandContext {
        request_id: request.request_id,
        executable: request.executable,
        argument_hash: hash_arguments(&request.arguments),
        exit_code: status.code(),
        timed_out: false,
        output_truncated: false,
        bytes_captured: stdout.len() + stderr.len(),
        stdout: clean_stdout,
        stderr: clean_stderr,
        redaction_count: report.findings.len(),
    })
}

pub fn validate_request(
    workspace: &Path,
    policy: &FullAccessPolicy,
    request: &CommandRequest,
) -> Result<(), CommandError> {
    if !workspace.is_absolute()
        || !safe_token(&request.request_id)
        || !safe_executable(&request.executable)
        || request.arguments.len() > 64
        || request.timeout_seconds == 0
        || request.timeout_seconds > policy.max_command_timeout_seconds
        || request.max_output_bytes == 0
        || request.max_output_bytes > policy.max_command_output_bytes
    {
        return Err(CommandError::InvalidRequest);
    }
    if !policy
        .allowed_command_executables
        .contains(&request.executable)
        || shell_executable(&request.executable)
    {
        return Err(CommandError::ExecutableDenied);
    }
    if request.arguments.iter().any(|argument| {
        argument.len() > 4096 || argument.contains('\0') || dangerous_argument(argument)
    }) {
        return Err(CommandError::InvalidRequest);
    }
    Ok(())
}

async fn read_capped(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    cap: usize,
) -> Result<(String, bool), CommandError> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| CommandError::Io)?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) > cap {
            // Keep draining the pipe so a noisy child cannot deadlock while its
            // output is rejected. Retain nothing after the configured cap.
            while reader
                .read(&mut buffer)
                .await
                .map_err(|_| CommandError::Io)?
                != 0
            {}
            return Ok((String::new(), true));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok((
        String::from_utf8(bytes).map_err(|_| CommandError::Io)?,
        false,
    ))
}
fn safe_token(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
}
fn safe_executable(value: &str) -> bool {
    value.len() <= 80
        && !value.contains(['/', '\\', ':'])
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}
fn dangerous_argument(value: &str) -> bool {
    value.contains(['|', '&', ';', '>', '<', '`', '$', '\n', '\r'])
        || value == "--interactive"
        || value == "-i"
}

fn shell_executable(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "wscript.exe"
            | "cscript.exe"
    )
}

#[allow(clippy::while_let_on_iterator)] // OSC parsing needs look-ahead for the ST terminator.
fn strip_terminal_controls(value: &str) -> String {
    let mut clean = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    // CSI: consume through the final byte (0x40..0x7e).
                    while let Some(next) = chars.next() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    // OSC terminates with BEL or ST (ESC \\).
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        } else if !ch.is_control() || matches!(ch, '\n' | '\r' | '\t') {
            clean.push(ch);
        }
    }
    clean
}
fn hash_arguments(arguments: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"vectant-command-arguments-v1\0");
    for argument in arguments {
        digest.update(argument.as_bytes());
        digest.update(b"\0");
    }
    format!("sha256:{}", hex::encode(digest.finalize()))
}

#[cfg(windows)]
struct CommandJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The job handle has exclusive ownership and Windows permits closing it from a
// different thread; the guard is never shared concurrently.
#[cfg(windows)]
unsafe impl Send for CommandJob {}

#[cfg(windows)]
impl CommandJob {
    fn assign(process_id: u32) -> Result<Self, ()> {
        use std::mem::size_of;
        use std::ptr::null;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        // A private kill-on-close job guarantees descendant processes die with
        // the brokered command. We deliberately do not accept an existing job.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } != 0;
        if !configured {
            unsafe {
                CloseHandle(handle);
            }
            return Err(());
        }
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                process_id,
            )
        };
        if process.is_null() {
            unsafe {
                CloseHandle(handle);
            }
            return Err(());
        }
        let assigned = unsafe { AssignProcessToJobObject(handle, process) } != 0;
        unsafe {
            CloseHandle(process);
        }
        if !assigned {
            unsafe {
                CloseHandle(handle);
            }
            return Err(());
        }
        Ok(Self { handle })
    }
}

#[cfg(windows)]
impl Drop for CommandJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct CommandJob;

#[cfg(not(windows))]
impl CommandJob {
    fn assign(_process_id: u32) -> Result<Self, ()> {
        Ok(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execute_command_cancellable, strip_terminal_controls, CommandError, CommandRequest,
    };
    use crate::full_access::FullAccessPolicy;
    use std::collections::BTreeSet;
    use std::sync::{atomic::AtomicBool, Arc};

    #[test]
    fn terminal_controls_do_not_reach_command_context() {
        assert_eq!(
            strip_terminal_controls("\u{1b}[31mred\u{1b}[0m\n\u{1b}]0;title\u{7}ok"),
            "red\nok"
        );
    }

    #[tokio::test]
    async fn cancellation_stops_a_brokered_command_before_output_is_released() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = FullAccessPolicy {
            organization_enabled: true,
            ..Default::default()
        };
        policy.allowed_command_executables = BTreeSet::from(["rustc".to_string()]);
        let cancelled = Arc::new(AtomicBool::new(true));
        let result = execute_command_cancellable(
            directory.path(),
            &policy,
            CommandRequest {
                request_id: "req_cancel_123".to_string(),
                executable: "rustc".to_string(),
                arguments: vec!["--version".to_string()],
                timeout_seconds: 5,
                max_output_bytes: 1024,
            },
            cancelled,
        )
        .await;
        assert!(matches!(result, Err(CommandError::Cancelled)));
    }

    #[test]
    fn shells_stay_denied_even_if_an_incorrect_policy_allowlists_them() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = FullAccessPolicy {
            organization_enabled: true,
            ..Default::default()
        };
        policy.allowed_command_executables = BTreeSet::from(["cmd.exe".to_string()]);
        let result = super::validate_request(
            directory.path(),
            &policy,
            &CommandRequest {
                request_id: "req_shell_123".to_string(),
                executable: "cmd.exe".to_string(),
                arguments: vec!["/c".to_string(), "echo".to_string()],
                timeout_seconds: 5,
                max_output_bytes: 1024,
            },
        );
        assert_eq!(result, Err(CommandError::ExecutableDenied));
    }
}
