//! Narrow, least-privilege diagnostic process inspection.
//!
//! No command line, environment, raw path, PID, handle, or process object
//! crosses this boundary. This is intentionally not a generic process API.

use std::path::Path;
#[cfg(target_os = "linux")]
use std::time::Instant;
#[cfg(windows)]
use std::time::Instant;

#[cfg(any(windows, target_os = "linux"))]
use crate::full_access::sanitized_process_record;
use crate::full_access::{SanitizedProcessRecord, MAX_PROCESS_RECORDS};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessInspectionError {
    Unsupported,
    InvalidScope,
    Unavailable,
}

pub struct ProcessInspectionAdapter;

impl ProcessInspectionAdapter {
    pub fn list_workspace_processes(
        workspace_root: &Path,
        max_records: usize,
    ) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
        if !workspace_root.is_absolute() || max_records == 0 || max_records > MAX_PROCESS_RECORDS {
            return Err(ProcessInspectionError::InvalidScope);
        }
        list_workspace_processes_platform(workspace_root, max_records)
    }

    pub fn inspect_listener_identity(
        port: u16,
        expected_identity_hash: &str,
    ) -> Result<bool, ProcessInspectionError> {
        if port == 0
            || !expected_identity_hash.starts_with("sha256:")
            || expected_identity_hash.len() != 71
        {
            return Err(ProcessInspectionError::InvalidScope);
        }
        let listener = crate::port_adapter::detect_loopback_listener(port)
            .map_err(|_| ProcessInspectionError::Unavailable)?;
        Ok(listener.process_identity_hash == expected_identity_hash)
    }
}

#[cfg(windows)]
fn list_workspace_processes_platform(
    workspace_root: &Path,
    max_records: usize,
) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
    use std::ffi::OsString;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let root = workspace_root.to_string_lossy().to_ascii_lowercase();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(ProcessInspectionError::Unavailable);
    }
    let started = Instant::now();
    let mut result = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut current = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while current && result.len() < max_records {
        let pid = entry.th32ProcessID;
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !process.is_null() {
            let inspected = (|| {
                let mut path = vec![0u16; 32_768];
                let mut length = path.len() as u32;
                if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) }
                    == 0
                {
                    return None;
                }
                path.truncate(length as usize);
                let full_path = OsString::from_wide(&path).to_string_lossy().into_owned();
                if !full_path
                    .to_ascii_lowercase()
                    .starts_with(&(root.clone() + "\\"))
                {
                    return None;
                }
                let name = Path::new(&full_path).file_name()?.to_str()?.to_string();
                let (mut creation, mut exit, mut kernel, mut user) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                if unsafe {
                    GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)
                } == 0
                {
                    return None;
                }
                let created =
                    ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
                sanitized_process_record(
                    &format!("pid={pid};created={created};image={full_path}"),
                    &name,
                    "workspace_process",
                    0,
                    Vec::new(),
                    true,
                    "executable_inside_workspace",
                    started.elapsed().as_millis() as u64,
                )
                .ok()
            })();
            unsafe {
                CloseHandle(process);
            }
            if let Some(record) = inspected {
                result.push(record);
            }
        }
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        current = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
fn list_workspace_processes_platform(
    workspace_root: &Path,
    max_records: usize,
) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
    let root = workspace_root
        .canonicalize()
        .map_err(|_| ProcessInspectionError::InvalidScope)?;
    let proc_entries =
        std::fs::read_dir("/proc").map_err(|_| ProcessInspectionError::Unavailable)?;
    let observed = Instant::now();
    let uptime_seconds = linux_uptime_seconds().unwrap_or(0);
    let clock_ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if clock_ticks <= 0 {
        return Err(ProcessInspectionError::Unavailable);
    }

    let mut result = Vec::new();
    for entry in proc_entries.flatten() {
        if result.len() >= max_records {
            break;
        }
        let pid = match entry.file_name().to_string_lossy().parse::<u32>() {
            Ok(pid) if pid != 0 => pid,
            _ => continue,
        };
        let cwd = match std::fs::canonicalize(entry.path().join("cwd")) {
            Ok(cwd) => cwd,
            Err(_) => continue,
        };
        if !cwd.starts_with(&root) {
            continue;
        }
        let start_ticks = match linux_process_start_ticks(&entry.path()) {
            Some(value) => value,
            None => continue,
        };
        let age_seconds = uptime_seconds.saturating_sub(start_ticks / clock_ticks as u64);
        // Process names, command lines, executable paths, environments, and PIDs are not
        // reportable diagnostics. They are used only to bind this opaque identity hash.
        let identity = format!(
            "linux:pid={pid};start={start_ticks};workspace={}",
            root.display()
        );
        if let Ok(record) = sanitized_process_record(
            &identity,
            "workspace-process",
            "workspace_process",
            age_seconds,
            Vec::new(),
            true,
            "current_working_directory_inside_workspace",
            observed.elapsed().as_millis() as u64,
        ) {
            result.push(record);
        }
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
fn linux_process_start_ticks(proc_path: &Path) -> Option<u64> {
    let stat = std::fs::read_to_string(proc_path.join("stat")).ok()?;
    let closing = stat.rfind(')')?;
    // Fields following `comm` begin with field 3 (`state`); starttime is field 22.
    stat.get(closing + 2..)?
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn linux_uptime_seconds() -> Option<u64> {
    std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .split('.')
        .next()?
        .parse()
        .ok()
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn reports_only_sanitized_workspace_process_metadata() {
        let root =
            std::env::temp_dir().join(format!("vectant-process-adapter-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&root)
            .spawn()
            .unwrap();
        let pid = child.id().to_string();
        let records = ProcessInspectionAdapter::list_workspace_processes(&root, 8).unwrap();
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir(&root);

        assert!(records.iter().any(|record| record.workspace_related));
        let serialized = serde_json::to_string(&records).unwrap();
        assert!(!serialized.contains(&pid));
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));
        assert!(!serialized.contains("/bin/sleep"));
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn list_workspace_processes_platform(
    _workspace_root: &Path,
    _max_records: usize,
) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
    Err(ProcessInspectionError::Unsupported)
}
