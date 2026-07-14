//! Bounded, shell-free command execution for Full Access diagnostics.

use std::path::Path;
use std::process::Stdio;
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
    SpawnFailed,
    Io,
}

pub async fn execute_command(
    workspace: &Path,
    policy: &FullAccessPolicy,
    request: CommandRequest,
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
    let stdout = child.stdout.take().ok_or(CommandError::Io)?;
    let stderr = child.stderr.take().ok_or(CommandError::Io)?;
    let stdout_task = tokio::spawn(read_capped(stdout, output_cap));
    let stderr_task = tokio::spawn(read_capped(stderr, output_cap));
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return Err(CommandError::Io),
        Err(_) => {
            let _ = child.kill().await;
            return Err(CommandError::TimedOut);
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

#[cfg(test)]
mod tests {
    use super::strip_terminal_controls;

    #[test]
    fn terminal_controls_do_not_reach_command_context() {
        assert_eq!(
            strip_terminal_controls("\u{1b}[31mred\u{1b}[0m\n\u{1b}]0;title\u{7}ok"),
            "red\nok"
        );
    }
}
