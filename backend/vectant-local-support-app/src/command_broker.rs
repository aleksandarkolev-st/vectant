//! Bounded, shell-free command execution for Full Access diagnostics.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

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
    // A revocation may arrive while a request is still being authorized. Do
    // not even resolve an executable (or otherwise touch the workspace) once
    // cancellation is visible.
    if cancelled.load(Ordering::Acquire) {
        return Err(CommandError::Cancelled);
    }
    let executable_path = resolve_executable_outside_workspace(workspace, &request.executable)?;
    let output_cap = request
        .max_output_bytes
        .min(policy.max_command_output_bytes);
    let timeout = Duration::from_secs(
        request
            .timeout_seconds
            .min(policy.max_command_timeout_seconds),
    );
    let mut command = Command::new(executable_path);
    command
        .current_dir(workspace)
        .args(&request.arguments)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_sanitized_environment(&mut command);
    #[cfg(unix)]
    configure_unix_process_group(&mut command);
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
    // stdout and stderr share one per-command budget. Independent caps would
    // let a command retain twice the policy limit by splitting output across
    // both streams.
    let output_budget = Arc::new(OutputCaptureBudget::new(output_cap));
    let stdout_task = tokio::spawn(read_capped(stdout, output_budget.clone()));
    let stderr_task = tokio::spawn(read_capped(stderr, output_budget));
    let deadline = tokio::time::Instant::now() + timeout;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            _command_job.terminate();
            // Retain a direct-child fallback if the OS containment primitive
            // raced process exit or returned a transient failure.
            let _ = child.kill().await;
            return Err(CommandError::Cancelled);
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            _command_job.terminate();
            // Retain a direct-child fallback if the OS containment primitive
            // raced process exit or returned a transient failure.
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

#[cfg(unix)]
fn configure_unix_process_group(command: &mut Command) {
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
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

struct OutputCaptureBudget {
    remaining: AtomicUsize,
}

impl OutputCaptureBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: AtomicUsize::new(limit),
        }
    }

    fn reserve(&self, bytes: usize) -> bool {
        let mut remaining = self.remaining.load(Ordering::Acquire);
        loop {
            if bytes > remaining {
                return false;
            }
            match self.remaining.compare_exchange_weak(
                remaining,
                remaining - bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(observed) => remaining = observed,
            }
        }
    }
}

async fn read_capped(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    budget: Arc<OutputCaptureBudget>,
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
        if !budget.reserve(count) {
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

fn resolve_executable_outside_workspace(
    workspace: &Path,
    executable: &str,
) -> Result<PathBuf, CommandError> {
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|_| CommandError::InvalidRequest)?;
    #[cfg(not(windows))]
    let names = vec![executable.to_string()];
    #[cfg(windows)]
    let mut names = vec![executable.to_string()];
    #[cfg(windows)]
    if !executable.to_ascii_lowercase().ends_with(".exe") {
        names.push(format!("{executable}.exe"));
    }
    let path = std::env::var_os("PATH").ok_or(CommandError::ExecutableDenied)?;
    for directory in std::env::split_paths(&path) {
        for executable_name in &names {
            let candidate = directory.join(executable_name);
            let Ok(canonical) = candidate.canonicalize() else {
                continue;
            };
            if canonical.starts_with(&canonical_workspace) || !canonical.is_file() {
                continue;
            }
            let filename_matches = canonical
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(executable_name));
            if filename_matches {
                return Ok(canonical);
            }
        }
    }
    Err(CommandError::ExecutableDenied)
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

fn apply_sanitized_environment(command: &mut Command) {
    // Do not inherit API keys, cloud credentials, proxy settings, user home,
    // or tool-specific configuration. PATH is retained solely for the explicit
    // executable resolution model; it is never sent to the relay or audit log.
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        if let Some(windir) = std::env::var_os("WINDIR") {
            command.env("WINDIR", windir);
        }
    }
    command.env("LANG", "C");
    command.env("LC_ALL", "C");
    command.env("TERM", "dumb");
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

    fn terminate(&self) {}
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
struct CommandJob {
    process_group: i32,
}

#[cfg(unix)]
impl CommandJob {
    fn assign(process_id: u32) -> Result<Self, ()> {
        let process_group = i32::try_from(process_id).map_err(|_| ())?;
        Ok(Self { process_group })
    }

    fn terminate(&self) {
        // A negative PID targets the isolated process group created by
        // configure_unix_process_group, including descendants.
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct CommandJob;

#[cfg(not(any(unix, windows)))]
impl CommandJob {
    fn assign(_process_id: u32) -> Result<Self, ()> {
        Err(())
    }

    fn terminate(&self) {}
}

#[cfg(test)]
mod tests {
    use super::{
        apply_sanitized_environment, execute_command_cancellable, read_capped,
        strip_terminal_controls, CommandError, CommandRequest, OutputCaptureBudget,
    };
    use crate::full_access::FullAccessPolicy;
    use std::collections::BTreeSet;
    use std::sync::{atomic::AtomicBool, Arc};
    use tokio::io::AsyncWriteExt;

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

    #[tokio::test]
    async fn stdout_and_stderr_share_one_capture_budget() {
        let (mut stdout_writer, stdout_reader) = tokio::io::duplex(2048);
        let (mut stderr_writer, stderr_reader) = tokio::io::duplex(2048);
        stdout_writer.write_all(&vec![b'a'; 600]).await.unwrap();
        stderr_writer.write_all(&vec![b'b'; 600]).await.unwrap();
        drop(stdout_writer);
        drop(stderr_writer);

        let budget = Arc::new(OutputCaptureBudget::new(1024));
        let (stdout, stderr) = tokio::join!(
            read_capped(stdout_reader, budget.clone()),
            read_capped(stderr_reader, budget),
        );
        assert!(stdout.unwrap().1 || stderr.unwrap().1);
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

    #[test]
    fn command_environment_omits_secret_bearing_parent_variables() {
        let mut command = tokio::process::Command::new("rustc");
        apply_sanitized_environment(&mut command);
        let debug = format!("{command:?}");
        assert!(!debug.contains("AWS_SECRET_ACCESS_KEY"));
        assert!(!debug.contains("DATABASE_URL"));
    }

    #[cfg(windows)]
    #[test]
    fn resolves_allowlisted_tool_outside_the_selected_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let executable =
            super::resolve_executable_outside_workspace(directory.path(), "rustc").unwrap();
        assert!(!executable.starts_with(directory.path()));
        assert!(executable.is_file());
    }

    #[cfg(not(windows))]
    #[test]
    fn resolves_allowlisted_tool_outside_the_selected_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let executable =
            super::resolve_executable_outside_workspace(directory.path(), "env").unwrap();
        assert!(!executable.starts_with(directory.path()));
        assert!(executable.is_file());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_containment_kills_descendant_processes() {
        // This uses a shell only as controlled test scaffolding to create a
        // descendant. The production broker continues to hard-deny shells.
        let directory = tempfile::tempdir().unwrap();
        let child_pid_path = directory.path().join("child.pid");
        let script = format!(
            "sleep 30 & child=$!; printf '%s' \"$child\" > '{}'; wait",
            child_pid_path.display()
        );
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        super::configure_unix_process_group(&mut command);
        let mut parent = command.spawn().unwrap();
        let job = super::CommandJob::assign(parent.id().unwrap()).unwrap();
        let child_pid = loop {
            if let Ok(value) = std::fs::read_to_string(&child_pid_path) {
                break value.trim().parse::<i32>().unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };

        job.terminate();
        let _ = parent.wait().await;
        for _ in 0..50 {
            let exists = unsafe { libc::kill(child_pid, 0) } == 0;
            let zombie = std::fs::read_to_string(format!("/proc/{child_pid}/stat"))
                .ok()
                .is_some_and(|stat| {
                    stat.rsplit_once(") ")
                        .is_some_and(|(_, state)| state.starts_with('Z'))
                });
            if !exists || zombie {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("contained descendant process {child_pid} survived termination");
    }
}
